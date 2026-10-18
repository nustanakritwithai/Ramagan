"""Remember a restricted device credential; unlock a shared role for five minutes.

No password, PIN, raw bearer, or raw device credential is stored in SQLite.
Shared role actors identify a role in existing audit records, not a person.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import hmac
import os
from pathlib import Path
import re
import secrets
import time
from typing import Literal
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, StrictStr

CONTRACT_VERSION = 1
ENROLLMENT_CONTRACT_VERSION = 2
AUTO_ROLE_CONTRACT_VERSION = 1
SESSION_SECONDS = 300
DEVICE_SECONDS = 90 * 24 * 3600
LOCK_SECONDS = 15 * 60
ROLES = ("owner", "manager", "staff")
Role = Literal["owner", "manager", "staff"]
Pin = StrictStr


class PrivateRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def sanitized(request):
            try:
                return await handler(request)
            except RequestValidationError:
                # Default Pydantic responses echo invalid input, including secrets.
                raise HTTPException(422, "Invalid device authentication request") from None
        return sanitized


class PrivateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Pins(PrivateInput):
    owner: Pin = Field(pattern=r"^[0-9]{4}$")
    manager: Pin = Field(pattern=r"^[0-9]{4}$")
    staff: Pin = Field(pattern=r"^[0-9]{4}$")


class Enrollment(PrivateInput):
    owner_password: StrictStr = Field(min_length=1, max_length=128)
    label: StrictStr = Field(min_length=1, max_length=100)
    pins: Pins | None = None


class DeviceInput(PrivateInput):
    device_credential: StrictStr = Field(min_length=32, max_length=256)


class Unlock(DeviceInput):
    # Omitting the role opts into a single server-side match. Existing clients
    # may continue to name a role; no client needs to try three requests.
    role: Role | None = None
    pin: Pin = Field(pattern=r"^[0-9]{4}$")


class Revoke(PrivateInput):
    owner_password: StrictStr = Field(min_length=1, max_length=128)
    device_id: uuid.UUID


class ChangePins(PrivateInput):
    owner_password: StrictStr = Field(min_length=1, max_length=128)
    pins: Pins


def resolve_pepper(value=None):
    if value is None:
        value = os.environ.get("RAMAGAN_PIN_PEPPER", "")
        if not value:
            filename = os.environ.get("RAMAGAN_PIN_PEPPER_FILE", "")
            try:
                path = Path(filename)
                if not filename or not path.is_absolute() or not path.is_file():
                    return None
                # Configured by the operator only: never accept a key path in a
                # request. ACL/encryption and a private location remain required.
                with path.open("rb") as stream:
                    value = stream.read(4097)
            except (OSError, ValueError):
                return None
    if isinstance(value, str):
        value = value.encode("utf-8")
    return value if isinstance(value, bytes) and 32 <= len(value) <= 4096 else None


def capabilities(enabled=False, *, required=None):
    return {"shared_role_pin": bool(enabled), "shared_role_pin_contract_version": CONTRACT_VERSION,
            "pos_pin_required": bool(enabled) if required is None else bool(required), "pin_preserving_enrollment": True,
            "device_enrollment_contract_version": ENROLLMENT_CONTRACT_VERSION,
            "auto_role_pin": bool(enabled), "auto_role_pin_contract_version": AUTO_ROLE_CONTRACT_VERSION}


def _digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class DeviceAuth:
    def __init__(self, path, connect, verify_password, pepper=None):
        self.path, self.connect, self.verify_password = path, connect, verify_password
        self._pepper = resolve_pepper(pepper)
        # Availability and policy are different. Losing an explicitly configured
        # key must never turn a PIN-protected shop into a password-only POS.
        self._policy_intent = bool(pepper) or bool(
            os.environ.get("RAMAGAN_PIN_PEPPER", "") or os.environ.get("RAMAGAN_PIN_PEPPER_FILE", ""))

    @property
    def enabled(self):
        return self._pepper is not None

    def require_enabled(self):
        if not self.enabled:
            raise HTTPException(503, "Shared-role PIN authentication is not configured")

    def pos_pin_required(self, db=None, store=None):
        if self.enabled or self._policy_intent:
            return True
        if db is None:
            with self.connect(self.path) as reader:
                return self.pos_pin_required(reader, store)
        sql = "SELECT 1 FROM device_auth_roles" + (" WHERE store_id=?" if store is not None else "") + " LIMIT 1"
        return db.execute(sql, (store,) if store is not None else ()).fetchone() is not None

    @contextmanager
    def transaction(self):
        with self.connect(self.path) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                yield db
                db.commit()
            except BaseException:
                db.rollback()
                raise

    def _pin_hash(self, pin, store, role, salt=None):
        salt = salt or secrets.token_bytes(16)
        message = ("ramagan-role-pin-v1\0" + store + "\0" + role + "\0" + pin).encode()
        prehash = hmac.digest(self._pepper, message, "sha256")
        value = hashlib.scrypt(prehash, salt=salt, n=2**14, r=8, p=1, dklen=32)
        return "pin-scrypt-v1$" + salt.hex() + "$" + value.hex()

    def _pin_matches(self, pin, store, role, stored):
        try:
            algorithm, salt, value = stored.split("$")
            if algorithm != "pin-scrypt-v1" or len(value) != 64:
                return False
            return hmac.compare_digest(self._pin_hash(pin, store, role, bytes.fromhex(salt)), stored)
        except (ValueError, TypeError):
            return False

    def _event(self, db, store, event, *, device=None, actor=None, role=None):
        db.execute("INSERT INTO device_auth_events VALUES(?,?,?,?,?,?,?)",
                   (str(uuid.uuid4()), store, device, actor, role, event, int(time.time())))

    def _limit(self, db, store, kind, subject, role):
        return db.execute("SELECT * FROM device_auth_limits WHERE store_id=? AND kind=? AND subject_id=? AND role=?",
                          (store, kind, subject, role)).fetchone()

    def _blocked(self, db, store, scopes, now):
        for kind, subject, role in scopes:
            row = self._limit(db, store, kind, subject, role)
            if row and (row["recovery_required"] or row["locked_until"] > now):
                return True
        return False

    def _fail(self, db, store, scopes, now):
        transition = False
        for kind, subject, role in scopes:
            row = self._limit(db, store, kind, subject, role)
            count = (row["fail_count"] if row else 0) + 1
            locked = now + LOCK_SECONDS if count >= 5 else 0
            recover = int(count >= 10 and kind != "owner_password")
            transition = transition or count in (5, 10)
            db.execute("""INSERT INTO device_auth_limits VALUES(?,?,?,?,?,?,?)
                ON CONFLICT(store_id,kind,subject_id,role) DO UPDATE SET
                fail_count=excluded.fail_count,locked_until=excluded.locked_until,
                recovery_required=excluded.recovery_required""",
                       (store, kind, subject, role, count, locked, recover))
        return transition

    def _clear(self, db, store, scopes):
        for kind, subject, role in scopes:
            db.execute("DELETE FROM device_auth_limits WHERE store_id=? AND kind=? AND subject_id=? AND role=?",
                       (store, kind, subject, role))

    def _deny(self, db, status, message):
        # Rejections must persist counters/audit, including across process restart.
        db.commit()
        raise HTTPException(status, message)

    def _owner_identity(self, db, actor):
        user = db.execute("SELECT * FROM users WHERE id=? AND is_active=1", (actor["id"],)).fetchone()
        mapped = db.execute("SELECT 1 FROM device_auth_roles WHERE actor_user_id=?", (actor["id"],)).fetchone()
        if (not user or mapped or user["role"] != "owner" or user["store_id"] != actor["store_id"]):
            raise HTTPException(403, "A password-authenticated store owner is required")
        return user

    def _owner(self, db, actor, password, now):
        user = self._owner_identity(db, actor)
        scopes = [("owner_password", user["id"], "owner")]
        if self._blocked(db, user["store_id"], scopes, now):
            raise HTTPException(429, "Owner authentication temporarily locked")
        if not self.verify_password(password, user["password_hash"]):
            self._fail(db, user["store_id"], scopes, now)
            self._event(db, user["store_id"], "OWNER_FAILURE", actor=user["id"], role="owner")
            self._deny(db, 401, "Owner password is required")
        self._clear(db, user["store_id"], scopes)
        return user

    def _device(self, db, credential, now):
        row = db.execute("""SELECT d.*,s.name AS store_name FROM remembered_devices d
            JOIN stores s ON s.id=d.store_id WHERE d.credential_hash=?""", (_digest(credential),)).fetchone()
        if not row or row["revoked_at"] is not None or row["expires_at"] <= now:
            raise HTTPException(401, "Invalid device credential")
        return row

    def _role(self, db, store, role):
        return db.execute("""SELECT r.*,u.email,u.is_active,u.role AS actual_role,u.store_id AS actual_store,
            u.password_hash AS actor_password_hash
            FROM device_auth_roles r JOIN users u ON u.id=r.actor_user_id
            WHERE r.store_id=? AND r.role=?""", (store, role)).fetchone()

    def _roles_valid(self, db, store):
        return all((row := self._role(db, store, role)) is not None and row["is_active"]
                   and row["actual_role"] == role and row["actual_store"] == store
                   and type(row["actor_password_hash"]) is str and type(row["pin_hash"]) is str
                   and row["actor_password_hash"].startswith("unusable-pin-role-v1$")
                   and re.fullmatch(r"pin-scrypt-v1\$[0-9a-f]{32}\$[0-9a-f]{64}", row["pin_hash"])
                   for role in ROLES)

    def _configured(self, db, store):
        count = db.execute("SELECT count(*) FROM device_auth_roles WHERE store_id=?", (store,)).fetchone()[0]
        if count == 0:
            return False
        if count != 3 or not self._roles_valid(db, store):
            raise HTTPException(409, "Role authentication requires owner recovery")
        return True

    def require_pos_pin(self, db, actor, authorization):
        """Call after fresh authentication, inside the business write transaction."""
        if not self.pos_pin_required(db, actor["store_id"]):
            return
        self.require_enabled()
        if not self._configured(db, actor["store_id"]):
            raise HTTPException(409, "Set up role PINs and connect this device before using POS")
        token_hash = _digest(authorization[7:].strip()) if authorization and authorization.startswith("Bearer ") else ""
        binding = db.execute("SELECT 1 FROM device_pin_sessions WHERE token_hash=?", (token_hash,)).fetchone()
        if not binding or not self.valid_session(db, token_hash, actor, int(time.time())):
            raise HTTPException(403, "A PIN-unlocked session is required for POS operations")

    @staticmethod
    def _distinct(pins):
        if len(set(pins.model_dump().values())) != 3:
            raise HTTPException(422, "The three role PINs must be different")

    def _device_reply(self, device):
        return {"device_id": device["id"], "store": {"id": device["store_id"], "name": device["store_name"]},
                "roles": list(ROLES), "expires_at": device["expires_at"],
                "auto_role_pin": True, "auto_role_pin_contract_version": AUTO_ROLE_CONTRACT_VERSION}

    def valid_session(self, db, token_hash, actor, now):
        binding = db.execute("SELECT * FROM device_pin_sessions WHERE token_hash=?", (token_hash,)).fetchone()
        mapped = db.execute("SELECT 1 FROM device_auth_roles WHERE actor_user_id=?", (actor["id"],)).fetchone()
        if not binding:
            return not mapped  # A role actor can never fall back to a password session.
        if not self.enabled or binding["created_at"] > now or now >= binding["created_at"] + SESSION_SECONDS:
            return False
        row = db.execute("""SELECT r.actor_user_id FROM device_pin_sessions p
            JOIN remembered_devices d ON d.id=p.device_id AND d.store_id=p.store_id
            JOIN device_auth_roles r ON r.store_id=p.store_id AND r.role=p.role AND r.pin_version=p.pin_version
            WHERE p.token_hash=? AND d.revoked_at IS NULL AND d.expires_at>?
              AND r.actor_user_id=? AND p.store_id=? AND p.role=?""",
                         (token_hash, now, actor["id"], actor["store_id"], actor["role"])).fetchone()
        return row is not None

    def register(self, app, current, *, recheck_actor):
        router = APIRouter(prefix="/v1/auth/device", route_class=PrivateRoute,
                           dependencies=[Depends(self.require_enabled)])

        @router.get("/configuration")
        def configuration(actor: dict = Depends(current), authorization: str | None = Header(default=None)):
            with self.connect(self.path) as db:
                db.execute("BEGIN")
                try:
                    actor = recheck_actor(db, authorization, actor)
                    owner = self._owner_identity(db, actor)
                    configured = self._configured(db, owner["store_id"])
                    return {"configured": configured, "roles": list(ROLES) if configured else [],
                            "device_enrollment_contract_version": ENROLLMENT_CONTRACT_VERSION}
                finally:
                    db.rollback()

        @router.post("/enroll")
        def enroll(payload: Enrollment, actor: dict = Depends(current), authorization: str | None = Header(default=None)):
            now = int(time.time())
            if payload.pins is not None:
                self._distinct(payload.pins)
            if not payload.label.strip():
                raise HTTPException(422, "Device label is required")
            with self.transaction() as db:
                actor = recheck_actor(db, authorization, actor)
                owner = self._owner(db, actor, payload.owner_password, now)
                store = owner["store_id"]
                if self._configured(db, store):
                    if payload.pins is not None and not all(self._pin_matches(getattr(payload.pins, role), store, role,
                                                self._role(db, store, role)["pin_hash"]) for role in ROLES):
                        raise HTTPException(409, "Role PINs already exist; change them in PIN settings")
                else:
                    if payload.pins is None:
                        raise HTTPException(422, "The first device requires three distinct role PINs")
                    for role in ROLES:
                        uid = str(uuid.uuid4())
                        email = "role-" + uid + "@pin-role.ramagan.invalid"
                        db.execute("INSERT INTO users(id,store_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)",
                                   (uid, store, email, "unusable-pin-role-v1$" + secrets.token_hex(32), role,
                                    time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(now))))
                        db.execute("INSERT INTO device_auth_roles VALUES(?,?,?,?,?,?)",
                                   (store, role, uid, self._pin_hash(getattr(payload.pins, role), store, role), 1, now))
                credential = "rd1_" + secrets.token_urlsafe(48)
                device_id = str(uuid.uuid4())
                db.execute("INSERT INTO remembered_devices VALUES(?,?,?,?,?,?,?,NULL)",
                           (device_id, store, _digest(credential), payload.label.strip(), owner["id"], now, now + DEVICE_SECONDS))
                self._event(db, store, "ENROLL", device=device_id, actor=owner["id"], role="owner")
                device = self._device(db, credential, now)
                reply = {**self._device_reply(device), "device_credential": credential}
            return reply

        @router.post("/status")
        def status(payload: DeviceInput):
            now = int(time.time())
            with self.transaction() as db:
                device = self._device(db, payload.device_credential, now)
                if not self._roles_valid(db, device["store_id"]):
                    raise HTTPException(401, "Role authentication unavailable")
                lockouts = {}
                for role in ROLES:
                    rows = [self._limit(db, device["store_id"], *scope) for scope in (
                        ("store_role", device["store_id"], role), ("device_role", device["id"], role),
                        ("device", device["id"], ""), ("store_role", device["store_id"], ""))]
                    lockouts[role] = {"locked_until": max((r["locked_until"] for r in rows if r), default=0),
                                      "recovery_required": any(bool(r["recovery_required"]) for r in rows if r)}
                reply = {**self._device_reply(device), "locked": True, "role_lockouts": lockouts}
            return reply

        @router.post("/unlock")
        def unlock(payload: Unlock):
            now = int(time.time())
            with self.transaction() as db:
                device = self._device(db, payload.device_credential, now)
                store, role = device["store_id"], payload.role
                # The legacy explicit-role contract must fail closed on the
                # same damaged configuration as automatic role detection.
                if not self._configured(db, store):
                    raise HTTPException(409, "Role authentication requires owner recovery")
                # The aggregate budgets apply to BOTH request modes. Alternating
                # auto-match and explicit-role requests, devices or roles cannot
                # obtain an extra guessing budget. Success never clears them.
                # An empty role is the existing schema's store-wide scope;
                # named role rows retain their original lockout semantics.
                aggregate = [("device", device["id"], ""), ("store_role", store, "")]
                if self._blocked(db, store, aggregate, now):
                    # A stolen device credential must not grow the immutable
                    # audit forever by hammering an already-blocked role.
                    raise HTTPException(429, "PIN temporarily locked or owner recovery required")
                if role is None:
                    # Always verify all three independently salted hashes. Do
                    # not stop on the first match or reveal candidate roles.
                    matches = [record for candidate in ROLES
                               if self._pin_matches(payload.pin, store, candidate,
                                                    (record := self._role(db, store, candidate))["pin_hash"])]
                    if len(matches) > 1:
                        raise HTTPException(409, "Role authentication requires owner recovery")
                    record = matches[0] if matches else None
                    role = record["role"] if record else None
                else:
                    record = self._role(db, store, role)
                role_scopes = [("store_role", store, role), ("device_role", device["id"], role)] if role else []
                if self._blocked(db, store, role_scopes, now):
                    raise HTTPException(429, "PIN temporarily locked or owner recovery required")
                scopes = role_scopes + aggregate
                if (not record or not record["is_active"] or record["actual_role"] != role
                        or record["actual_store"] != store
                        or (payload.role is not None and not self._pin_matches(payload.pin, store, role, record["pin_hash"]))):
                    transition = self._fail(db, store, scopes, now)
                    self._event(db, store, "LOCKED" if transition else "PIN_FAILURE", device=device["id"], role=role)
                    self._deny(db, 401, "Invalid role or PIN")
                # Success for one role must not reset another role's guessing budget.
                self._clear(db, store, role_scopes)
                db.execute("UPDATE sessions SET revoked=1 WHERE token_hash IN (SELECT token_hash FROM device_pin_sessions WHERE device_id=?)",
                           (device["id"],))
                token = secrets.token_urlsafe(48)
                digest, expires = _digest(token), now + SESSION_SECONDS
                db.execute("INSERT INTO sessions VALUES(?,?,?,0)", (digest, record["actor_user_id"], expires))
                db.execute("INSERT INTO device_pin_sessions VALUES(?,?,?,?,?,?)",
                           (digest, device["id"], store, role, record["pin_version"], now))
                self._event(db, store, "UNLOCK", device=device["id"], actor=record["actor_user_id"], role=role)
                reply = {"token": token, "expires_at": expires, "user": {"id": record["actor_user_id"], "email": record["email"]},
                         "device_id": device["id"], "role": role, "auth_method": "shared_role_pin"}
            return reply

        @router.post("/lock")
        def lock(actor: dict = Depends(current), authorization: str | None = Header(default=None)):
            digest = _digest(authorization[7:].strip())
            with self.transaction() as db:
                binding = db.execute("SELECT * FROM device_pin_sessions WHERE token_hash=?", (digest,)).fetchone()
                if not binding:
                    raise HTTPException(403, "A PIN-unlocked session is required")
                db.execute("UPDATE sessions SET revoked=1 WHERE token_hash=?", (digest,))
                self._event(db, actor["store_id"], "LOCK", device=binding["device_id"], actor=actor["id"], role=actor["role"])
            return {"ok": True}

        @router.post("/revoke")
        def revoke(payload: Revoke, actor: dict = Depends(current), authorization: str | None = Header(default=None)):
            now = int(time.time())
            with self.transaction() as db:
                actor = recheck_actor(db, authorization, actor)
                owner = self._owner(db, actor, payload.owner_password, now)
                device = db.execute("SELECT * FROM remembered_devices WHERE id=? AND store_id=?",
                                    (str(payload.device_id), owner["store_id"])).fetchone()
                if not device:
                    raise HTTPException(404, "Device not found")
                db.execute("UPDATE remembered_devices SET revoked_at=coalesce(revoked_at,?) WHERE id=?", (now, device["id"]))
                db.execute("UPDATE sessions SET revoked=1 WHERE token_hash IN (SELECT token_hash FROM device_pin_sessions WHERE device_id=?)", (device["id"],))
                self._event(db, owner["store_id"], "REVOKE", device=device["id"], actor=owner["id"], role="owner")
            return {"ok": True}

        @router.post("/pins")
        def pins(payload: ChangePins, actor: dict = Depends(current), authorization: str | None = Header(default=None)):
            now = int(time.time())
            self._distinct(payload.pins)
            with self.transaction() as db:
                actor = recheck_actor(db, authorization, actor)
                owner = self._owner(db, actor, payload.owner_password, now)
                store = owner["store_id"]
                if not self._roles_valid(db, store):
                    raise HTTPException(409, "Role authentication is not enrolled")
                for role in ROLES:
                    db.execute("UPDATE device_auth_roles SET pin_hash=?,pin_version=pin_version+1,updated_at=? WHERE store_id=? AND role=?",
                               (self._pin_hash(getattr(payload.pins, role), store, role), now, store, role))
                db.execute("UPDATE sessions SET revoked=1 WHERE token_hash IN (SELECT token_hash FROM device_pin_sessions WHERE store_id=?)", (store,))
                db.execute("DELETE FROM device_auth_limits WHERE store_id=?", (store,))
                self._event(db, store, "PINS_CHANGED", actor=owner["id"], role="owner")
            return {"ok": True}

        app.include_router(router)
