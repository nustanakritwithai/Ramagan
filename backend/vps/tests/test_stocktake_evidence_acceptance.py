"""Independent contract acceptance: disposable SQLite and synthetic images only.

No running service, shop database, credentials, public endpoint or real photo is used.
Snapshots hash BLOBs instead of printing or retaining their contents in assertions.
"""
import atexit
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import socket
import sqlite3
import struct
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid
import zlib

_bootstrap = tempfile.TemporaryDirectory(prefix="evidence-acceptance-import-")
atexit.register(_bootstrap.cleanup)
os.environ["RAMAGAN_DB_PATH"] = str(Path(_bootstrap.name) / "import.sqlite3")

from fastapi.testclient import TestClient
from PIL import Image
import httpx
import uvicorn
from app import connect, create_app, create_store, create_user
from migrations import CURRENT_SCHEMA_VERSION, migrate_copy, restore_copy
import stocktake_evidence as evidence_module


# Frozen deployed fb096830 schema3 SQL; CI does not need Git history.
FROZEN_SCHEMA3 = """
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sales_enabled INTEGER NOT NULL DEFAULT 0 CHECK(sales_enabled IN (0,1)),
  requires_authorization INTEGER NOT NULL DEFAULT 1 CHECK(requires_authorization IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','manager','staff')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  price_satang_per_gram INTEGER NOT NULL CHECK(price_satang_per_gram BETWEEN 0 AND 100000000),
  default_cost_satang_per_gram INTEGER CHECK(default_cost_satang_per_gram IS NULL OR (typeof(default_cost_satang_per_gram)='integer' AND default_cost_satang_per_gram BETWEEN 0 AND 100000000)),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(store_id, sku)
);
CREATE TABLE IF NOT EXISTS lots (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  lot_code TEXT NOT NULL,
  supplier_name TEXT NOT NULL,
  supplier_document_ref TEXT NOT NULL,
  cost_satang_per_gram INTEGER CHECK(cost_satang_per_gram IS NULL OR (typeof(cost_satang_per_gram)='integer' AND cost_satang_per_gram BETWEEN 0 AND 100000000)),
  expires_on TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  received_at TEXT NOT NULL,
  UNIQUE(store_id, lot_code)
);
CREATE TABLE IF NOT EXISTS lot_balances (
  lot_id TEXT PRIMARY KEY REFERENCES lots(id),
  quantity_mg INTEGER NOT NULL CHECK(quantity_mg >= 0),
  stock_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(stock_revision)='integer' AND stock_revision BETWEEN 0 AND 9000000000000000000),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  client_sale_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  cashier_user_id TEXT NOT NULL REFERENCES users(id),
  payment_method TEXT NOT NULL CHECK(payment_method IN ('cash','transfer')),
  authorization_ref TEXT,
  subtotal_satang INTEGER NOT NULL CHECK(subtotal_satang >= 0),
  discount_satang INTEGER NOT NULL DEFAULT 0 CHECK(discount_satang >= 0),
  total_satang INTEGER NOT NULL CHECK(total_satang >= 0),
  created_at TEXT NOT NULL,
  CHECK(subtotal_satang = discount_satang + total_satang),
  UNIQUE(store_id, client_sale_id)
);
CREATE TABLE IF NOT EXISTS sale_lines (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id),
  lot_id TEXT NOT NULL REFERENCES lots(id),
  quantity_mg INTEGER NOT NULL CHECK(quantity_mg > 0),
  unit_price_satang_per_gram INTEGER NOT NULL CHECK(unit_price_satang_per_gram >= 0),
  line_subtotal_satang INTEGER NOT NULL DEFAULT 0 CHECK(line_subtotal_satang >= 0),
  line_discount_satang INTEGER NOT NULL DEFAULT 0 CHECK(line_discount_satang >= 0),
  line_total_satang INTEGER NOT NULL CHECK(line_total_satang >= 0),
  unit_cost_satang_per_gram INTEGER CHECK(unit_cost_satang_per_gram IS NULL OR (typeof(unit_cost_satang_per_gram)='integer' AND unit_cost_satang_per_gram BETWEEN 0 AND 100000000)),
  line_cost_satang INTEGER CHECK((line_cost_satang IS NULL AND unit_cost_satang_per_gram IS NULL) OR (typeof(line_cost_satang)='integer' AND line_cost_satang>=0 AND unit_cost_satang_per_gram IS NOT NULL)),
  CHECK(line_subtotal_satang = line_discount_satang + line_total_satang),
  UNIQUE(sale_id, lot_id)
);
CREATE TABLE IF NOT EXISTS ledger_events (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  lot_id TEXT NOT NULL REFERENCES lots(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL CHECK(event_type IN ('RECEIVE','SALE','ADJUST','DESTROY','TRANSFER_IN','TRANSFER_OUT')),
  quantity_delta_mg INTEGER NOT NULL CHECK(quantity_delta_mg <> 0),
  reason TEXT NOT NULL,
  sale_id TEXT REFERENCES sales(id),
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger_events
BEGIN SELECT RAISE(ABORT, 'Immutable ledger events'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger_events
BEGIN SELECT RAISE(ABORT, 'Immutable ledger events'); END;
CREATE TRIGGER IF NOT EXISTS sales_no_update BEFORE UPDATE ON sales
BEGIN SELECT RAISE(ABORT, 'Immutable sales'); END;
CREATE TRIGGER IF NOT EXISTS sales_no_delete BEFORE DELETE ON sales
BEGIN SELECT RAISE(ABORT, 'Immutable sales'); END;
CREATE TRIGGER IF NOT EXISTS lines_no_update BEFORE UPDATE ON sale_lines
BEGIN SELECT RAISE(ABORT, 'Immutable sale lines'); END;
CREATE TRIGGER IF NOT EXISTS lines_no_delete BEFORE DELETE ON sale_lines
BEGIN SELECT RAISE(ABORT, 'Immutable sale lines'); END;
CREATE INDEX IF NOT EXISTS sales_store_created ON sales(store_id,created_at);
CREATE INDEX IF NOT EXISTS ledger_store_lot_created ON ledger_events(store_id,lot_id,created_at);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS receive_requests (
  store_id TEXT NOT NULL REFERENCES stores(id),
  client_receive_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(store_id,client_receive_id)
);
CREATE TABLE IF NOT EXISTS stocktakes (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  client_stocktake_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  shift_label TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  actor_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(store_id,client_stocktake_id)
);
CREATE TABLE IF NOT EXISTS stocktake_rejections (
  store_id TEXT NOT NULL REFERENCES stores(id),
  client_stocktake_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(store_id,client_stocktake_id)
);
CREATE TABLE IF NOT EXISTS receive_rejections (
  store_id TEXT NOT NULL REFERENCES stores(id),
  client_receive_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(store_id,client_receive_id)
);
CREATE TABLE IF NOT EXISTS stocktake_lines (
  id TEXT PRIMARY KEY,
  stocktake_id TEXT NOT NULL REFERENCES stocktakes(id),
  lot_id TEXT NOT NULL REFERENCES lots(id),
  lot_code TEXT NOT NULL,
  system_quantity_mg INTEGER NOT NULL CHECK(typeof(system_quantity_mg)='integer' AND system_quantity_mg>=0),
  counted_quantity_mg INTEGER NOT NULL CHECK(typeof(counted_quantity_mg)='integer' AND counted_quantity_mg BETWEEN 0 AND 100000000),
  variance_mg INTEGER NOT NULL CHECK(typeof(variance_mg)='integer' AND variance_mg=counted_quantity_mg-system_quantity_mg),
  stock_revision_before INTEGER NOT NULL CHECK(typeof(stock_revision_before)='integer' AND stock_revision_before>=0),
  stock_revision_after INTEGER NOT NULL CHECK(typeof(stock_revision_after)='integer' AND stock_revision_after=stock_revision_before+1),
  inventory_delta_satang INTEGER CHECK(inventory_delta_satang IS NULL OR typeof(inventory_delta_satang)='integer'),
  ledger_event_id TEXT REFERENCES ledger_events(id),
  CHECK((variance_mg=0 AND ledger_event_id IS NULL) OR (variance_mg<>0 AND ledger_event_id IS NOT NULL)),
  UNIQUE(stocktake_id,lot_id)
);
CREATE INDEX IF NOT EXISTS stocktakes_store_created ON stocktakes(store_id,created_at,id);
CREATE TRIGGER IF NOT EXISTS receive_requests_no_update BEFORE UPDATE ON receive_requests
BEGIN SELECT RAISE(ABORT, 'Immutable intake requests'); END;
CREATE TRIGGER IF NOT EXISTS receive_requests_no_delete BEFORE DELETE ON receive_requests
BEGIN SELECT RAISE(ABORT, 'Immutable intake requests'); END;
CREATE TRIGGER IF NOT EXISTS stocktakes_no_update BEFORE UPDATE ON stocktakes
BEGIN SELECT RAISE(ABORT, 'Immutable stocktakes'); END;
CREATE TRIGGER IF NOT EXISTS stocktakes_no_delete BEFORE DELETE ON stocktakes
BEGIN SELECT RAISE(ABORT, 'Immutable stocktakes'); END;
CREATE TRIGGER IF NOT EXISTS stocktake_lines_no_update BEFORE UPDATE ON stocktake_lines
BEGIN SELECT RAISE(ABORT, 'Immutable stocktake lines'); END;
CREATE TRIGGER IF NOT EXISTS stocktake_lines_no_delete BEFORE DELETE ON stocktake_lines
BEGIN SELECT RAISE(ABORT, 'Immutable stocktake lines'); END;
CREATE TRIGGER IF NOT EXISTS stocktake_rejections_no_update BEFORE UPDATE ON stocktake_rejections
BEGIN SELECT RAISE(ABORT, 'Immutable stocktake rejections'); END;
CREATE TRIGGER IF NOT EXISTS stocktake_rejections_no_delete BEFORE DELETE ON stocktake_rejections
BEGIN SELECT RAISE(ABORT, 'Immutable stocktake rejections'); END;
CREATE TRIGGER IF NOT EXISTS receive_rejections_no_update BEFORE UPDATE ON receive_rejections
BEGIN SELECT RAISE(ABORT, 'Immutable intake rejections'); END;
CREATE TRIGGER IF NOT EXISTS receive_rejections_no_delete BEFORE DELETE ON receive_rejections
BEGIN SELECT RAISE(ABORT, 'Immutable intake rejections'); END;
CREATE TRIGGER IF NOT EXISTS lots_cost_no_update BEFORE UPDATE OF cost_satang_per_gram ON lots
WHEN NEW.cost_satang_per_gram IS NOT OLD.cost_satang_per_gram
BEGIN SELECT RAISE(ABORT, 'Immutable intake cost'); END;
"""


def uid():
    return str(uuid.uuid4())


def synthetic_image(fmt="PNG", *, size=(64, 32), color=(30, 140, 80), exif=None):
    output = BytesIO()
    with Image.new("RGB", size, color) as image:
        options = {"exif": exif} if exif is not None else {}
        image.save(output, format=fmt, **options)
    return output.getvalue()


def bounded_png(width, height):
    """Valid compressed oversized fixture, without allocating a full pixel image."""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    encoder = zlib.compressobj()
    compressed = bytearray()
    row = b"\0" + b"\0\x80\0" * width
    for _ in range(height):
        compressed.extend(encoder.compress(row))
    compressed.extend(encoder.flush())
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", bytes(compressed)) + chunk(b"IEND", b""))


def snapshot(path):
    """Independent logical comparison, including audit tables, triggers and BLOB digests."""
    with closing(sqlite3.connect(path)) as db:
        schema = tuple(db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"))
        tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        result = {"version": db.execute("PRAGMA user_version").fetchone()[0], "schema": schema, "tables": {}}
        for table in tables:
            safe = '"' + table.replace('"', '""') + '"'
            rows = []
            for row in db.execute("SELECT * FROM " + safe):
                rows.append(tuple(("BLOB", len(value), hashlib.sha256(value).hexdigest())
                                  if isinstance(value, bytes) else value for value in row))
            result["tables"][table] = {"columns": tuple(db.execute("PRAGMA table_info(" + safe + ")")),
                "foreign_keys": tuple(db.execute("PRAGMA foreign_key_list(" + safe + ")")),
                "indexes": tuple(db.execute("PRAGMA index_list(" + safe + ")")), "rows": sorted(rows, key=repr)}
        result["foreign_key_check"] = tuple(db.execute("PRAGMA foreign_key_check"))
        return result


class StocktakeEvidenceAcceptanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base_tmp = tempfile.TemporaryDirectory(prefix="evidence-acceptance-baseline-")
        cls.base_path = str(Path(cls.base_tmp.name) / "baseline.sqlite3")
        api = create_app(cls.base_path, origins=["https://localhost"])
        cls.store = create_store(cls.base_path, "DISPOSABLE PHOTO ACCEPTANCE ONLY")
        cls.other_store = create_store(cls.base_path, "DISPOSABLE OTHER TENANT")
        cls.users, cls.headers = {}, {}
        with TestClient(api) as client:
            for actor, role, store in (("owner", "owner", cls.store), ("manager", "manager", cls.store),
                    ("staff", "staff", cls.store), ("other", "owner", cls.other_store)):
                password = "Disposable photo fixture passphrase " + actor
                email = actor + "@photo-acceptance.invalid"
                cls.users[actor] = create_user(cls.base_path, store, email, password, role)
                response = client.post("/v1/auth/login", json={"email": email, "password": password})
                if response.status_code != 200:
                    raise AssertionError("Disposable fixture login failed")
                cls.headers[actor] = {"Authorization": "Bearer " + response.json()["token"]}

    @classmethod
    def tearDownClass(cls):
        cls.base_tmp.cleanup()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="evidence-acceptance-copy-")
        self.addCleanup(self.tmp.cleanup)
        self.path = str(Path(self.tmp.name) / "fixture.sqlite3")
        with closing(sqlite3.connect(self.base_path)) as source, closing(sqlite3.connect(self.path)) as destination:
            source.backup(destination)
        self.api = create_app(self.path, origins=["https://localhost"])
        self.client = TestClient(self.api, raise_server_exceptions=False)
        self.addCleanup(self.client.close)

    def assert_unchanged(self, before):
        self.assertTrue(before == snapshot(self.path), "Fixture schema, rows, timestamps or BLOB digests changed")

    def lot(self, *, actor="owner", price=10000, cost=4000, quantity=5000):
        product = self.client.post("/v1/products", headers=self.headers[actor], json={
            "sku": uid(), "name": "SYNTHETIC PHOTO ITEM", "category": "Synthetic",
            "price_satang_per_gram": price, "default_cost_satang_per_gram": cost})
        self.assertEqual(product.status_code, 200, product.text)
        receive = self.client.post("/v1/lots/receive", headers=self.headers[actor], json={
            "client_receive_id": uid(), "product_id": product.json()["product_id"], "lot_code": uid(),
            "supplier_name": "Synthetic supplier", "quantity_mg": quantity, "reason": "Disposable fixture only"})
        self.assertEqual(receive.status_code, 200, receive.text)
        result = self.client.get("/v1/inventory", headers=self.headers[actor])
        self.assertEqual(result.status_code, 200, result.text)
        return next(row for row in result.json()["lots"] if row["id"] == receive.json()["lot_id"])

    def upload(self, lot, count_id, *, actor="owner", upload_id=None, raw=None, mime="image/png", client=None):
        return (client or self.client).post("/v1/stocktake-evidence/" + (upload_id or uid()),
            params={"lot_id": lot["id"], "client_stocktake_id": count_id},
            headers={**self.headers[actor], "Content-Type": mime},
            content=synthetic_image() if raw is None else raw)

    def count_payload(self, lots, *, actor="owner", counts=None, photos=True):
        count_id = uid()
        payload = {"client_stocktake_id": count_id, "shift_label": "Synthetic shift",
                   "reason": "Disposable physical count", "items": []}
        for index, lot in enumerate(lots):
            line = {"lot_id": lot["id"], "expected_revision": lot["stock_revision"],
                    "counted_quantity_mg": lot["quantity_mg"] if counts is None else counts[index]}
            if photos:
                response = self.upload(lot, count_id, actor=actor)
                self.assertEqual(response.status_code, 200, response.text)
                line["evidence_id"] = response.json()["evidence_id"]
            payload["items"].append(line)
        return payload

    def count(self, payload, actor="owner"):
        return self.client.post("/v1/stocktakes", headers=self.headers[actor], json=payload)

    def sale_payload(self, lots, *, discount=100, method="split"):
        payload = {"client_sale_id": uid(), "items": [{"lot_id": lot["id"], "quantity_mg": 1000} for lot in lots],
                   "payment_method": method, "discount_satang": discount}
        if method == "split":
            payload["payments"] = [{"payment_method": "cash", "amount_satang": 10000},
                                   {"payment_method": "transfer", "amount_satang": 19900}]
        return payload

    def enable_fixture(self):
        with connect(self.path) as db:
            db.execute("UPDATE stores SET sales_enabled=1,requires_authorization=0 WHERE id=?", (self.store,))

    def test_capabilities_and_manager_staff_tenant_private_access(self):
        capabilities = self.client.get("/v1/me", headers=self.headers["owner"]).json()["capabilities"]
        for flag, version in (("stocktakes", "stocktake_contract_version"), ("stocktake_evidence", "evidence_contract_version"),
                              ("split_payments", "payment_contract_version"), ("sale_reconciliation", "sale_reconciliation_contract_version")):
            self.assertIs(capabilities[flag], True)
            self.assertEqual(capabilities[version], 2 if flag == "stocktakes" else 1)
        self.assertEqual(capabilities["cost_contract_version"], 1)
        self.assertEqual(capabilities["discount_contract_version"], 1)
        self.assertFalse(capabilities.get("promotions", False))
        self.assertFalse(capabilities.get("shift_reconciliation", False))
        lot, count_id = self.lot(), uid()
        response = self.upload(lot, count_id, actor="manager")
        self.assertEqual(response.status_code, 200, response.text)
        photo = response.json()
        before = snapshot(self.path)
        for actor, status in (("staff", 403), ("other", 404)):
            self.assertEqual(self.client.get("/v1/stocktake-evidence/" + photo["evidence_id"], headers=self.headers[actor]).status_code, status)
        self.assertEqual(self.client.get("/v1/stocktake-evidence/" + photo["evidence_id"]).status_code, 401)
        self.assertEqual(self.upload(lot, count_id, actor="staff").status_code, 403)
        self.assertEqual(self.upload(lot, count_id, actor="other").status_code, 422)
        self.assertEqual(self.count(self.count_payload([lot], photos=False), actor="staff").status_code, 403)
        self.assert_unchanged(before)

    def test_normalization_private_download_digest_metadata_and_upload_replay(self):
        lot, count_id, upload_id = self.lot(), uid(), uid()
        exif = Image.Exif()
        exif[274], exif[270] = 6, "Synthetic private EXIF must disappear"
        raw = synthetic_image("JPEG", size=(120, 60), exif=exif)
        first = self.upload(lot, count_id, upload_id=upload_id, raw=raw, mime="image/jpeg")
        self.assertEqual(first.status_code, 200, first.text)
        photo = first.json()
        self.assertEqual(set(photo), {"evidence_id", "client_upload_id", "client_stocktake_id", "lot_id", "sha256", "mime", "width", "height", "byte_size", "created_at", "duplicate"})
        self.assertEqual((photo["width"], photo["height"], photo["mime"], photo["duplicate"]), (60, 120, "image/jpeg", False))
        downloaded = self.client.get("/v1/stocktake-evidence/" + photo["evidence_id"], headers=self.headers["manager"])
        self.assertEqual(downloaded.status_code, 200)
        self.assertEqual(downloaded.headers["content-type"], "image/jpeg")
        self.assertEqual(downloaded.headers["cache-control"], "no-store")
        self.assertEqual(downloaded.headers["x-content-type-options"], "nosniff")
        self.assertEqual(hashlib.sha256(downloaded.content).hexdigest(), photo["sha256"])
        self.assertEqual(len(downloaded.content), photo["byte_size"])
        with Image.open(BytesIO(downloaded.content)) as image:
            self.assertEqual(len(image.getexif()), 0)
            self.assertNotIn("icc_profile", image.info)
            self.assertNotIn("comment", image.info)
        before = snapshot(self.path)
        self.assertEqual(self.upload(lot, count_id, upload_id=upload_id, raw=raw, mime="image/jpeg").json(), {**photo, "duplicate": True})
        self.assertEqual(self.client.get("/v1/stocktake-evidence/by-client/" + upload_id, headers=self.headers["owner"]).json(), {**photo, "duplicate": True})
        for changed in ({"raw": synthetic_image("JPEG"), "mime": "image/jpeg"}, {"actor": "manager", "raw": raw, "mime": "image/jpeg"}):
            self.assertEqual(self.upload(lot, count_id, upload_id=upload_id, **changed).status_code, 409)
        self.assertEqual(self.upload(lot, uid(), upload_id=upload_id, raw=raw, mime="image/jpeg").status_code, 409)
        self.assert_unchanged(before)

    def test_png_webp_and_large_photo_are_normalized_to_bounded_jpeg(self):
        lot = self.lot()
        for fmt, mime, size in (("PNG", "image/png", (64, 32)), ("WEBP", "image/webp", (32, 64)), ("JPEG", "image/jpeg", (1700, 20))):
            with self.subTest(format=fmt):
                result = self.upload(lot, uid(), raw=synthetic_image(fmt, size=size), mime=mime)
                self.assertEqual(result.status_code, 200, result.text)
                photo = result.json()
                self.assertLessEqual(max(photo["width"], photo["height"]), 1600)
                self.assertLessEqual(photo["byte_size"], 1024 * 1024)
                self.assertEqual(photo["mime"], "image/jpeg")

    def test_invalid_forged_truncated_animated_oversized_and_streamed_images_have_no_rows(self):
        lot, count_id = self.lot(), uid()
        animated = BytesIO()
        with Image.new("RGB", (4, 4), "green") as one, Image.new("RGB", (4, 4), "blue") as two:
            one.save(animated, format="PNG", save_all=True, append_images=[two], duration=100, loop=0)
        cases = [(b"<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml", 415),
                 (synthetic_image(), "image/jpeg", 422), (b"not an image", "image/png", 422),
                 (synthetic_image()[:30], "image/png", 422), (animated.getvalue(), "image/png", 422),
                 (bounded_png(8193, 1), "image/png", 422), (bounded_png(4000, 3001), "image/png", 422),
                 (b"x" * (5 * 1024 * 1024 + 1), "image/png", 413)]
        before = snapshot(self.path)
        for raw, mime, status in cases:
            with self.subTest(size=len(raw), mime=mime):
                self.assertEqual(self.upload(lot, count_id, raw=raw, mime=mime).status_code, status)
                self.assert_unchanged(before)
        def oversized_stream():
            for _ in range(6):
                yield b"x" * (1024 * 1024)
        streamed = self.client.post("/v1/stocktake-evidence/" + uid(), params={"lot_id": lot["id"], "client_stocktake_id": count_id},
            headers={**self.headers["owner"], "Content-Type": "image/png"}, content=oversized_stream())
        self.assertEqual(streamed.status_code, 413)
        self.assert_unchanged(before)

    def test_busy_decoder_and_transactional_per_store_quota_without_large_allocation(self):
        lot, count_id, upload_id = self.lot(), uid(), uid()
        raw = synthetic_image()
        first = self.upload(lot, count_id, upload_id=upload_id, raw=raw)
        self.assertEqual(first.status_code, 200, first.text)
        other_lot = self.lot(actor="other")
        before = snapshot(self.path)
        evidence_module._decode_lock.acquire()
        try:
            self.assertEqual(self.upload(lot, uid()).status_code, 429)
        finally:
            evidence_module._decode_lock.release()
        self.assert_unchanged(before)
        with patch.object(evidence_module, "STORE_QUOTA_BYTES", first.json()["byte_size"]):
            duplicate = self.upload(lot, count_id, upload_id=upload_id, raw=raw)
            self.assertEqual(duplicate.status_code, 200)
            self.assertTrue(duplicate.json()["duplicate"])
            full = self.upload(lot, uid())
            self.assertEqual(full.status_code, 409)
            self.assertEqual(full.json()["detail"], "EVIDENCE_STORAGE_FULL")
            self.assert_unchanged(before)
            # Another tenant has its own quota, even though the first is full.
            self.assertEqual(self.upload(other_lot, uid(), actor="other").status_code, 200)

    def test_photos_required_for_zero_variance_zero_count_and_each_selected_lot(self):
        lots = [self.lot(), self.lot()]
        for extra in ({}, {"reason": " "}, {"shift_label": " "}):
            before = snapshot(self.path)
            invalid = {**self.count_payload(lots, photos=False), **extra}
            self.assertEqual(self.count(invalid).status_code, 422)
            self.assert_unchanged(before)
        payload = self.count_payload(lots, counts=[lots[0]["quantity_mg"], 0])
        missing = json.loads(json.dumps(payload))
        del missing["items"][1]["evidence_id"]
        before = snapshot(self.path)
        self.assertEqual(self.count(missing).status_code, 422)
        self.assert_unchanged(before)
        result = self.count(payload)
        self.assertEqual(result.status_code, 200, result.text)
        by_lot = {item["lot_id"]: item for item in result.json()["items"]}
        self.assertEqual(by_lot[lots[0]["id"]]["variance_mg"], 0)
        self.assertEqual(by_lot[lots[1]["id"]]["counted_quantity_mg"], 0)
        for item in result.json()["items"]:
            self.assertIsNotNone(item["evidence"])
            self.assertNotIn("duplicate", item["evidence"])
        before = snapshot(self.path)
        replay = self.count(payload)
        self.assertEqual(replay.json(), {**result.json(), "duplicate": True})
        lookup = self.client.get("/v1/stocktakes/by-client/" + payload["client_stocktake_id"], headers=self.headers["manager"])
        self.assertEqual(lookup.json(), replay.json())
        self.assert_unchanged(before)

    def test_evidence_count_lot_actor_binding_and_duplicate_payload_conflict(self):
        lots = [self.lot(), self.lot()]
        payload = self.count_payload(lots)
        before = snapshot(self.path)
        invalids = [({**payload, "client_stocktake_id": uid()}, "owner"), (payload, "manager"),
                    ({**payload, "items": [{**payload["items"][0], "evidence_id": uid()}, payload["items"][1]]}, "owner"),
                    ({**payload, "items": [{**payload["items"][0], "evidence_id": payload["items"][1]["evidence_id"]}, payload["items"][1]]}, "owner")]
        for invalid, actor in invalids:
            self.assertEqual(self.count(invalid, actor).status_code, 422)
            self.assert_unchanged(before)
        second_photo = self.upload(lots[0], payload["client_stocktake_id"])
        self.assertEqual(second_photo.status_code, 200)
        result = self.count(payload)
        self.assertEqual(result.status_code, 200, result.text)
        changed = json.loads(json.dumps(payload))
        changed["items"][0]["evidence_id"] = second_photo.json()["evidence_id"]
        before = snapshot(self.path)
        self.assertEqual(self.count(changed).status_code, 409)
        self.assert_unchanged(before)

    def test_stale_count_reconciliation_blocks_late_original_post_and_preserves_photos(self):
        lot = self.lot()
        payload = self.count_payload([lot], counts=[4000])
        with connect(self.path) as db:
            db.execute("UPDATE lot_balances SET stock_revision=stock_revision+1 WHERE lot_id=?", (lot["id"],))
        before = snapshot(self.path)
        self.assertEqual(self.count(payload).status_code, 409)
        self.assert_unchanged(before)
        cancelled = self.client.post("/v1/stocktakes/reconcile", headers=self.headers["owner"], json=payload)
        self.assertEqual(cancelled.status_code, 200, cancelled.text)
        self.assertEqual(cancelled.json()["status"], "rejected")
        self.assertFalse(cancelled.json()["committed"])
        before = snapshot(self.path)
        self.assertEqual(self.count(payload).status_code, 409)
        self.assertEqual(self.client.post("/v1/stocktakes/reconcile", headers=self.headers["owner"], json=payload).json(), cancelled.json())
        self.assert_unchanged(before)
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM stocktake_line_evidence").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM stocktake_evidence").fetchone()[0], 1)

    def test_failure_after_balance_ledger_line_and_photo_link_rolls_back_everything(self):
        for target, timing, condition in (("lot_balances", "UPDATE", ""), ("ledger_events", "INSERT", " WHEN NEW.event_type='ADJUST'"),
                ("stocktake_lines", "INSERT", ""), ("stocktake_line_evidence", "INSERT", "")):
            with self.subTest(stage=target):
                lots = [self.lot(), self.lot()]
                payload = self.count_payload(lots, counts=[4000, 4500])
                with connect(self.path) as db:
                    db.execute("CREATE TRIGGER acceptance_fault AFTER " + timing + " ON " + target + condition +
                               " BEGIN SELECT RAISE(ABORT,'synthetic injected failure'); END")
                before = snapshot(self.path)
                failed = self.count(payload)
                self.assertGreaterEqual(failed.status_code, 400)
                self.assert_unchanged(before)
                with connect(self.path) as db:
                    db.execute("DROP TRIGGER acceptance_fault")
                # The exact photos and count UUID remain reusable after rollback.
                succeeded = self.count(payload)
                self.assertEqual(succeeded.status_code, 200, succeeded.text)
                self.assertFalse(succeeded.json()["duplicate"])

    def test_evidence_insert_failure_is_atomic_and_rows_and_links_are_immutable(self):
        lot, count_id = self.lot(), uid()
        with connect(self.path) as db:
            db.execute("CREATE TRIGGER acceptance_upload_fault AFTER INSERT ON stocktake_evidence BEGIN SELECT RAISE(ABORT,'synthetic upload failure'); END")
        before = snapshot(self.path)
        self.assertGreaterEqual(self.upload(lot, count_id).status_code, 400)
        self.assert_unchanged(before)
        with connect(self.path) as db:
            db.execute("DROP TRIGGER acceptance_upload_fault")
        payload = self.count_payload([lot])
        self.assertEqual(self.count(payload).status_code, 200)
        before = snapshot(self.path)
        with connect(self.path) as db:
            for table in ("stocktake_evidence", "stocktake_line_evidence"):
                for operation in ("DELETE FROM " + table, "UPDATE " + table + " SET " + ("sha256=sha256" if table == "stocktake_evidence" else "evidence_id=evidence_id")):
                    with self.assertRaises(sqlite3.IntegrityError):
                        db.execute(operation)
        self.assert_unchanged(before)

    def test_backup_restore_includes_private_photo_bytes_links_and_all_rows(self):
        lot = self.lot()
        payload = self.count_payload([lot], counts=[4500])
        self.assertEqual(self.count(payload).status_code, 200)
        before = snapshot(self.path)
        target = str(Path(self.tmp.name) / "new-restored-copy.sqlite3")
        restored = restore_copy(self.path, target, confirmed_offline_copy=True)
        self.assertEqual(restored["status"], "PASS")
        self.assertTrue(snapshot(target) == before, "Restored BLOB hashes, audit links or schema differ")
        with TestClient(create_app(target)) as client:
            photo = client.get("/v1/stocktake-evidence/" + payload["items"][0]["evidence_id"], headers=self.headers["owner"])
            self.assertEqual(photo.status_code, 200)
            with connect(self.path) as db:
                digest = db.execute("SELECT sha256 FROM stocktake_evidence").fetchone()[0]
            self.assertEqual(hashlib.sha256(photo.content).hexdigest(), digest)
        self.assertEqual(migrate_copy(target, confirmed_offline_copy=True)["status"], "NOOP")
        with self.assertRaises(ValueError):
            restore_copy(self.path, target, confirmed_offline_copy=True)
        self.assert_unchanged(before)

    def test_restore_refuses_semantically_corrupted_photo_backup_and_keeps_source_evidence(self):
        lot = self.lot()
        uploaded = self.upload(lot, uid())
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        with connect(self.path) as db:
            original_trigger = db.execute("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='stocktake_evidence_no_update'").fetchone()[0]
            image = db.execute("SELECT image_blob FROM stocktake_evidence WHERE id=?", (uploaded.json()["evidence_id"],)).fetchone()[0]
            # Simulate storage damage in a disposable source only. Keep byte length,
            # constraints, foreign keys and original immutable trigger all intact.
            db.execute("DROP TRIGGER stocktake_evidence_no_update")
            damaged = bytes([image[0] ^ 1]) + image[1:]
            db.execute("UPDATE stocktake_evidence SET image_blob=? WHERE id=?", (damaged, uploaded.json()["evidence_id"]))
            db.execute(original_trigger)
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        before = snapshot(self.path)
        output = str(Path(self.tmp.name) / "must-not-claim-valid-photo-restore.sqlite3")
        with self.assertRaises(RuntimeError):
            restore_copy(self.path, output, confirmed_offline_copy=True)
        self.assertFalse(Path(output).exists(), "Failed NEW restore output must be removed")
        self.assert_unchanged(before)

    def test_split_is_one_bill_one_stock_cut_and_canonical_idempotent_allocations(self):
        lots = [self.lot(price=10000, cost=4000), self.lot(price=20000, cost=8000)]
        self.enable_fixture()
        payload = self.sale_payload(lots)
        first = self.client.post("/v1/sales", headers=self.headers["staff"], json=payload)
        self.assertEqual(first.status_code, 200, first.text)
        sale = first.json()
        self.assertEqual((sale["subtotal_satang"], sale["discount_satang"], sale["total_satang"]), (30000, 100, 29900))
        self.assertEqual(sale["payment_method"], "split")
        self.assertEqual(sale["payments"], payload["payments"])
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM sales").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT count(*) FROM sale_lines").fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT count(*) FROM sale_payments").fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT count(*) FROM ledger_events WHERE event_type='SALE'").fetchone()[0], 2)
            self.assertEqual([row[0] for row in db.execute("SELECT quantity_mg FROM lot_balances ORDER BY lot_id")], [4000, 4000])
            # A recorded replay must ignore later price, stock, product and shop changes.
            db.execute("UPDATE products SET price_satang_per_gram=999999,active=0 WHERE store_id=?", (self.store,))
            db.execute("UPDATE stores SET sales_enabled=0 WHERE id=?", (self.store,))
        before = snapshot(self.path)
        replay = self.client.post("/v1/sales", headers=self.headers["staff"], json={**payload, "payments": list(reversed(payload["payments"]))})
        self.assertEqual(replay.json(), {**sale, "duplicate": True})
        changed = {**payload, "payments": [{"payment_method": "cash", "amount_satang": 9999}, {"payment_method": "transfer", "amount_satang": 19901}]}
        self.assertEqual(self.client.post("/v1/sales", headers=self.headers["staff"], json=changed).status_code, 409)
        lookup = self.client.get("/v1/sales/by-client/" + payload["client_sale_id"], headers=self.headers["owner"])
        self.assertEqual(lookup.json()["id"], sale["sale_id"])
        self.assertEqual(lookup.json()["payments"], payload["payments"])
        completed = self.client.post("/v1/sales/reconcile", headers=self.headers["staff"], json=payload)
        self.assertEqual(completed.json(), {"status": "completed", "result": {**sale, "duplicate": True}})
        self.assert_unchanged(before)

    def test_split_report_gross_discount_net_cost_profit_and_channels_reconcile_sql(self):
        lots = [self.lot(price=10000, cost=4000), self.lot(price=20000, cost=8000)]
        self.enable_fixture()
        sale = self.client.post("/v1/sales", headers=self.headers["staff"], json=self.sale_payload(lots))
        self.assertEqual(sale.status_code, 200, sale.text)
        for actor in ("owner", "manager"):
            report = self.client.get("/v1/admin/sales-report", headers=self.headers[actor])
            self.assertEqual(report.status_code, 200, report.text)
            summary = report.json()["summary"]
            self.assertEqual((summary["sale_count"], summary["subtotal_satang"], summary["discount_satang"], summary["total_satang"]), (1, 30000, 100, 29900))
            self.assertEqual(summary["cash_satang"], 10000)
            self.assertEqual(summary["transfer_satang"], 19900)
            self.assertEqual(summary["cost_satang"], 12000)
            self.assertEqual(summary["gross_profit_satang"], 17900)
            for section in ("daily", "top_products", "top_categories"):
                rows = report.json()[section]
                self.assertEqual(sum(row["subtotal_satang"] for row in rows), 30000)
                self.assertEqual(sum(row["discount_satang"] for row in rows), 100)
                self.assertEqual(sum(row["total_satang"] for row in rows), 29900)
        self.assertEqual(self.client.get("/v1/admin/sales-report", headers=self.headers["staff"]).status_code, 403)

    def test_strict_split_types_bounds_methods_and_sum_reject_without_business_mutation(self):
        lots = [self.lot(price=10000), self.lot(price=20000)]
        self.enable_fixture()
        valid = self.sale_payload(lots)
        invalids = []
        for value in (True, False, 1.0, "10000", None, 0, -1, 5_000_000_000_001):
            invalids.append({**valid, "payments": [{"payment_method": "cash", "amount_satang": value}, valid["payments"][1]]})
        invalids.extend([{**valid, "payments": None}, {**valid, "payments": []}, {**valid, "payments": valid["payments"][:1]},
            {**valid, "payments": [valid["payments"][0], valid["payments"][0]]},
            {**valid, "payments": [{"payment_method": "card", "amount_satang": 10000}, valid["payments"][1]]},
            {**valid, "payments": [{"payment_method": "cash", "amount_satang": 10001}, valid["payments"][1]]},
            {**valid, "payment_method": "cash"}, {**valid, "payment_method": "transfer"}])
        before = snapshot(self.path)
        for payload in invalids:
            with self.subTest(method=payload["payment_method"], allocations=payload.get("payments")):
                result = self.client.post("/v1/sales", headers=self.headers["staff"], json=payload)
                self.assertEqual(result.status_code, 422)
                self.assert_unchanged(before)

    def test_sale_cancel_tombstone_is_authoritative_and_blocks_late_or_changed_split_post(self):
        lots = [self.lot(price=10000), self.lot(price=20000)]
        self.enable_fixture()
        payload = self.sale_payload(lots)
        # A 404 lookup alone leaves the UUID available; it is not a cancellation proof.
        self.assertEqual(self.client.get("/v1/sales/by-client/" + payload["client_sale_id"], headers=self.headers["staff"]).status_code, 404)
        before = snapshot(self.path)
        cancelled = self.client.post("/v1/sales/reconcile", headers=self.headers["staff"], json=payload)
        self.assertEqual(cancelled.status_code, 200, cancelled.text)
        self.assertEqual((cancelled.json()["status"], cancelled.json()["code"], cancelled.json()["committed"]), ("rejected", "SALE_CANCELLED", False))
        after = snapshot(self.path)
        self.assertEqual(len(after["tables"]["sale_rejections"]["rows"]), len(before["tables"]["sale_rejections"]["rows"]) + 1)
        self.assertEqual(self.client.post("/v1/sales", headers=self.headers["staff"], json=payload).status_code, 409)
        self.assertEqual(self.client.post("/v1/sales/reconcile", headers=self.headers["staff"], json=payload).json(), cancelled.json())
        changed = {**payload, "payments": [{"payment_method": "cash", "amount_satang": 10001}, {"payment_method": "transfer", "amount_satang": 19899}]}
        self.assertEqual(self.client.post("/v1/sales/reconcile", headers=self.headers["staff"], json=changed).status_code, 409)
        self.assertEqual(self.client.post("/v1/sales", headers=self.headers["owner"], json=payload).status_code, 403)
        self.assert_unchanged(after)
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM sales").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM sale_payments").fetchone()[0], 0)

    def test_zero_net_pure_tender_has_one_zero_allocation_and_split_is_rejected(self):
        lot = self.lot(price=10000)
        self.enable_fixture()
        for method in ("cash", "transfer"):
            payload = self.sale_payload([lot], discount=10000, method=method)
            sale = self.client.post("/v1/sales", headers=self.headers["staff"], json=payload)
            self.assertEqual(sale.status_code, 200, sale.text)
            self.assertEqual(sale.json()["payments"], [{"payment_method": method, "amount_satang": 0}])
        split = self.sale_payload([lot], discount=10000)
        split["payments"] = [{"payment_method": "cash", "amount_satang": 0}, {"payment_method": "transfer", "amount_satang": 0}]
        before = snapshot(self.path)
        self.assertEqual(self.client.post("/v1/sales", headers=self.headers["staff"], json=split).status_code, 422)
        self.assert_unchanged(before)

    def test_real_loopback_http_photo_count_and_split_sale_on_disposable_server(self):
        lot = self.lot(price=10000)
        self.enable_fixture()
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(self.api, host="127.0.0.1", port=port, log_level="critical", access_log=False, lifespan="off"))
        worker = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
        worker.start()
        try:
            deadline = time.monotonic() + 10
            while not server.started and worker.is_alive() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(server.started, "Disposable loopback server did not start")
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=10) as client:
                count_id = uid()
                uploaded = self.upload(lot, count_id, client=client)
                self.assertEqual(uploaded.status_code, 200, uploaded.text)
                counted = client.post("/v1/stocktakes", headers=self.headers["owner"], json={
                    "client_stocktake_id": count_id, "shift_label": "Wire fixture", "reason": "Synthetic scale photo",
                    "items": [{"lot_id": lot["id"], "expected_revision": lot["stock_revision"], "counted_quantity_mg": 4500,
                               "evidence_id": uploaded.json()["evidence_id"]}]})
                self.assertEqual(counted.status_code, 200, counted.text)
                split = self.sale_payload([lot], discount=100)
                split["payments"] = [{"payment_method": "cash", "amount_satang": 3000}, {"payment_method": "transfer", "amount_satang": 6900}]
                sale = client.post("/v1/sales", headers=self.headers["staff"], json=split)
                self.assertEqual(sale.status_code, 200, sale.text)
                self.assertEqual(sale.json()["total_satang"], 9900)
                photo = client.get("/v1/stocktake-evidence/" + uploaded.json()["evidence_id"], headers=self.headers["manager"])
                self.assertEqual(hashlib.sha256(photo.content).hexdigest(), uploaded.json()["sha256"])
        finally:
            server.should_exit = True
            worker.join(10)
            sock.close()
            self.assertFalse(worker.is_alive(), "Disposable loopback server did not stop")

    def frozen_v3_fixture(self):
        """Actual deployed schema SQL, historical hashes, custom SQL and FK graph."""
        lot = self.lot(quantity=5000)
        target = str(Path(self.tmp.name) / (uid() + "-offline-v3.sqlite3"))
        sale_id, sale_client, count_id, count_client = uid(), uid(), uid(), uid()
        sale_payload = {"client_sale_id": sale_client, "items": [{"lot_id": lot["id"], "quantity_mg": 1000}],
                        "payment_method": "cash", "discount_satang": 0}
        # Deliberately the original pre-discount fingerprint, not a new helper.
        sale_hash = hashlib.sha256(json.dumps({"items": sale_payload["items"], "payment_method": "cash", "authorization_ref": ""},
                                             sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        count_payload = {"client_stocktake_id": count_client, "shift_label": "Historical shift", "reason": "Historical count without camera",
                         "items": [{"lot_id": lot["id"], "expected_revision": 1, "counted_quantity_mg": 4000}]}
        count_hash = hashlib.sha256(json.dumps({key: count_payload[key] for key in ("shift_label", "reason", "items")},
                                    sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        with closing(sqlite3.connect(target)) as db, closing(sqlite3.connect(self.path)) as source:
            db.executescript(FROZEN_SCHEMA3)
            db.execute("PRAGMA foreign_keys=OFF")
            db.execute("BEGIN")
            for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall():
                quoted = '"' + table + '"'
                columns = [row[1] for row in db.execute("PRAGMA table_info(" + quoted + ")")]
                fields = ",".join('"' + col + '"' for col in columns)
                rows = source.execute("SELECT " + fields + " FROM " + quoted).fetchall()
                db.executemany("INSERT INTO " + quoted + "(" + fields + ") VALUES(" + ",".join("?" for _ in columns) + ")", rows)
            stamp = "2026-10-01T10:00:00+00:00"
            db.execute("UPDATE stores SET sales_enabled=1,requires_authorization=0 WHERE id=?", (self.store,))
            db.execute("INSERT INTO sales(id,store_id,client_sale_id,request_hash,cashier_user_id,payment_method,authorization_ref,subtotal_satang,discount_satang,total_satang,created_at) VALUES(?,?,?,?,?,'cash',NULL,10000,0,10000,?)",
                       (sale_id, self.store, sale_client, sale_hash, self.users["staff"], stamp))
            db.execute("INSERT INTO sale_lines(id,sale_id,lot_id,quantity_mg,unit_price_satang_per_gram,line_subtotal_satang,line_discount_satang,line_total_satang,unit_cost_satang_per_gram,line_cost_satang) VALUES(?,?,?,1000,10000,10000,0,10000,4000,4000)", (uid(), sale_id, lot["id"]))
            db.execute("INSERT INTO ledger_events(id,store_id,lot_id,actor_user_id,event_type,quantity_delta_mg,reason,sale_id,created_at) VALUES(?,?,?,?,'SALE',-1000,'Historical fixture sale',?,?)",
                       (uid(), self.store, lot["id"], self.users["staff"], sale_id, stamp))
            db.execute("UPDATE lot_balances SET quantity_mg=4000,stock_revision=2,updated_at=? WHERE lot_id=?", (stamp, lot["id"]))
            email = db.execute("SELECT email FROM users WHERE id=?", (self.users["owner"],)).fetchone()[0]
            db.execute("INSERT INTO stocktakes(id,store_id,client_stocktake_id,request_hash,shift_label,reason,actor_user_id,actor_email,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                       (count_id, self.store, count_client, count_hash, count_payload["shift_label"], count_payload["reason"], self.users["owner"], email, stamp))
            db.execute("INSERT INTO stocktake_lines(id,stocktake_id,lot_id,lot_code,system_quantity_mg,counted_quantity_mg,variance_mg,stock_revision_before,stock_revision_after,inventory_delta_satang,ledger_event_id) VALUES(?,?,?,?,4000,4000,0,1,2,0,NULL)",
                       (uid(), count_id, lot["id"], lot["lot_code"]))
            # Out-of-alphabetical creation order exposes unstable PRAGMA index seq.
            db.execute("CREATE INDEX operator_z_created ON sales(created_at DESC,id)")
            db.execute("CREATE INDEX operator_a_cash ON sales(total_satang) WHERE payment_method='cash'")
            db.execute("CREATE VIEW operator_sales_view AS SELECT id,store_id,total_satang FROM sales WHERE total_satang>=0")
            db.execute("CREATE TRIGGER operator_sales_audit AFTER INSERT ON sales BEGIN SELECT NEW.id; END")
            db.execute("CREATE TABLE operator_notes(id TEXT PRIMARY KEY,sale_id TEXT REFERENCES sales(id),note TEXT,photo_digest_fixture BLOB)")
            db.execute("INSERT INTO operator_notes VALUES(?,?,?,?)", (uid(), sale_id, "Synthetic operator note", b"private synthetic blob"))
            db.execute("PRAGMA user_version=3")
            db.commit()
            db.execute("PRAGMA foreign_keys=ON")
            self.assertEqual(list(db.execute("PRAGMA foreign_key_check")), [])
        return target, sale_payload, count_payload

    def test_frozen_schema3_rebuild_preserves_history_custom_sql_and_legacy_replays(self):
        path, sale_payload, count_payload = self.frozen_v3_fixture()
        before = snapshot(path)
        migrated = migrate_copy(path, confirmed_offline_copy=True)
        self.assertEqual(migrated["status"], "PASS")
        after = snapshot(path)
        self.assertEqual(after["version"], CURRENT_SCHEMA_VERSION)
        self.assertEqual(after["foreign_key_check"], ())
        for table, old in before["tables"].items():
            new = after["tables"][table]
            self.assertEqual(new["columns"], old["columns"], table)
            self.assertTrue(new["rows"] == old["rows"], "Historical rows or BLOB digests changed: " + table)
            self.assertEqual(new["foreign_keys"], old["foreign_keys"], table)
            self.assertEqual(sorted(row[1:] for row in new["indexes"]), sorted(row[1:] for row in old["indexes"]), table)
        old_objects = {(row[0], row[1]): row for row in before["schema"]}
        new_objects = {(row[0], row[1]): row for row in after["schema"]}
        for key, original in old_objects.items():
            if key != ("table", "sales"):
                self.assertEqual(new_objects[key], original, key)
        old_sales_sql = old_objects[("table", "sales")][3]
        new_sales_sql = new_objects[("table", "sales")][3]
        expected_sql = old_sales_sql.replace("('cash','transfer')", "('cash','transfer','split')")
        # SQLite adds identifier quotes on RENAME; compare the sole allowed rewrite.
        self.assertEqual(new_sales_sql.replace('"sales"', "sales"), expected_sql)
        with TestClient(create_app(path), raise_server_exceptions=False) as client:
            count = client.post("/v1/stocktakes", headers=self.headers["owner"], json=count_payload)
            self.assertEqual(count.status_code, 200, count.text)
            self.assertTrue(count.json()["duplicate"])
            self.assertIsNone(count.json()["items"][0]["evidence"])
            # A different UUID cannot replay the old count: its revision is stale.
            stale_new = client.post("/v1/stocktakes", headers=self.headers["owner"],
                                    json={**count_payload, "client_stocktake_id": uid()})
            self.assertEqual(stale_new.status_code, 409, stale_new.text)
            # Isolate the photo requirement with the CURRENT revision. Reusing
            # the historical revision would be rejected earlier for staleness.
            fresh = {**count_payload, "client_stocktake_id": uid(),
                     "items": [{**count_payload["items"][0], "expected_revision": 2}]}
            photo_free = client.post("/v1/stocktakes", headers=self.headers["owner"], json=fresh)
            self.assertEqual(photo_free.status_code, 422, photo_free.text)
            sale = client.post("/v1/sales", headers=self.headers["staff"], json=sale_payload)
            self.assertEqual(sale.status_code, 200, sale.text)
            self.assertTrue(sale.json()["duplicate"])
            self.assertEqual(sale.json()["payments"], [{"payment_method": "cash", "amount_satang": 10000}])
            lookup = client.get("/v1/sales/by-client/" + sale_payload["client_sale_id"], headers=self.headers["owner"])
            self.assertEqual(lookup.json()["id"], sale.json()["sale_id"])
            self.assertEqual(lookup.json()["payments"], sale.json()["payments"])
        self.assertTrue(after == snapshot(path), "Legacy retries altered migrated history or stock")
        self.assertEqual(migrate_copy(path, confirmed_offline_copy=True)["status"], "NOOP")

    def test_schema3_each_rebuild_failure_is_atomic_and_backup_restores_original(self):
        for stage in ("after_sales_copy", "after_sales_rebuild", "after_evidence_ddl", "after_version"):
            with self.subTest(failure_stage=stage):
                path, _, _ = self.frozen_v3_fixture()
                before = snapshot(path)
                backup = str(Path(self.tmp.name) / (uid() + "-backup.sqlite3"))
                self.assertEqual(restore_copy(path, backup, confirmed_offline_copy=True)["status"], "PASS")
                reached = []
                def fail(name):
                    reached.append(name)
                    if name == stage:
                        raise RuntimeError("Synthetic migration failure at " + name)
                with self.assertRaisesRegex(RuntimeError, "Synthetic migration failure"):
                    migrate_copy(path, confirmed_offline_copy=True, failure_hook=fail)
                self.assertIn(stage, reached)
                self.assertTrue(before == snapshot(path), "Failed migration changed original schema/history: " + stage)
                restored = str(Path(self.tmp.name) / (uid() + "-restored-schema3.sqlite3"))
                self.assertEqual(restore_copy(backup, restored, confirmed_offline_copy=True)["status"], "PASS")
                self.assertTrue(before == snapshot(restored), "Backup restore did not reproduce schema3 history")

    def test_two_devices_racing_same_revision_adjust_once_and_do_not_consume_loser_photo(self):
        lot = self.lot()
        payloads = [self.count_payload([lot], counts=[4000], actor=actor) for actor in ("owner", "manager")]
        def submit(pair):
            actor, payload = pair
            with TestClient(self.api, raise_server_exceptions=False) as client:
                response = client.post("/v1/stocktakes", headers=self.headers[actor], json=payload)
                return payload, response.status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(submit, zip(("owner", "manager"), payloads)))
        self.assertEqual(sorted(status for _, status in results), [200, 409])
        loser = next(payload for payload, status in results if status == 409)
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT quantity_mg,stock_revision FROM lot_balances WHERE lot_id=?", (lot["id"],)).fetchone()[:], (4000, 1))
            self.assertEqual(db.execute("SELECT count(*) FROM stocktakes").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT count(*) FROM stocktake_line_evidence").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT count(*) FROM ledger_events WHERE event_type='ADJUST'").fetchone()[0], 1)
            self.assertIsNone(db.execute("SELECT stocktake_line_id FROM stocktake_line_evidence WHERE evidence_id=?", (loser["items"][0]["evidence_id"],)).fetchone())


if __name__ == "__main__":
    unittest.main()
