"""Additive shared-role device authentication; migrations seed no credentials."""

TABLES_V5 = frozenset({"device_auth_roles", "remembered_devices", "device_auth_limits",
                       "device_pin_sessions", "device_auth_events"})
TRIGGERS_V5 = frozenset({"device_auth_events_no_update", "device_auth_events_no_delete"})
INDEXES_V5 = frozenset({"device_pin_sessions_device", "remembered_devices_store"})

SCHEMA_V5 = """
CREATE TABLE IF NOT EXISTS device_auth_roles (
  store_id TEXT NOT NULL REFERENCES stores(id),
  role TEXT NOT NULL CHECK(role IN ('owner','manager','staff')),
  actor_user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  pin_hash TEXT NOT NULL,
  pin_version INTEGER NOT NULL CHECK(typeof(pin_version)='integer' AND pin_version>0),
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>=0),
  PRIMARY KEY(store_id,role)
);
CREATE TABLE IF NOT EXISTS remembered_devices (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  credential_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 100),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
  expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at>created_at),
  revoked_at INTEGER CHECK(revoked_at IS NULL OR (typeof(revoked_at)='integer' AND revoked_at>=0))
);
CREATE INDEX IF NOT EXISTS remembered_devices_store ON remembered_devices(store_id);
CREATE TABLE IF NOT EXISTS device_auth_limits (
  store_id TEXT NOT NULL REFERENCES stores(id),
  kind TEXT NOT NULL CHECK(kind IN ('store_role','device_role','device','owner_password')),
  subject_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','manager','staff','')),
  fail_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(fail_count)='integer' AND fail_count>=0),
  locked_until INTEGER NOT NULL DEFAULT 0 CHECK(typeof(locked_until)='integer' AND locked_until>=0),
  recovery_required INTEGER NOT NULL DEFAULT 0 CHECK(recovery_required IN (0,1)),
  PRIMARY KEY(store_id,kind,subject_id,role)
);
CREATE TABLE IF NOT EXISTS device_pin_sessions (
  token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES remembered_devices(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  role TEXT NOT NULL CHECK(role IN ('owner','manager','staff')),
  pin_version INTEGER NOT NULL CHECK(typeof(pin_version)='integer' AND pin_version>0),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0)
);
CREATE INDEX IF NOT EXISTS device_pin_sessions_device ON device_pin_sessions(device_id);
CREATE TABLE IF NOT EXISTS device_auth_events (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  device_id TEXT REFERENCES remembered_devices(id),
  actor_user_id TEXT REFERENCES users(id),
  role TEXT CHECK(role IS NULL OR role IN ('owner','manager','staff')),
  event TEXT NOT NULL CHECK(event IN ('ENROLL','UNLOCK','PIN_FAILURE','LOCKED','LOCK','REVOKE','PINS_CHANGED','OWNER_FAILURE')),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0)
);
CREATE TRIGGER IF NOT EXISTS device_auth_events_no_update BEFORE UPDATE ON device_auth_events
BEGIN SELECT RAISE(ABORT, 'Immutable device authentication audit'); END;
CREATE TRIGGER IF NOT EXISTS device_auth_events_no_delete BEFORE DELETE ON device_auth_events
BEGIN SELECT RAISE(ABORT, 'Immutable device authentication audit'); END;
"""
