"""Additive schema-four objects; no app imports or image decoding at migration time."""
TABLES_V4 = frozenset({"stocktake_evidence", "stocktake_line_evidence", "sale_payments", "sale_rejections"})
TRIGGERS_V4 = frozenset(name + suffix for name in TABLES_V4 for suffix in ("_no_update", "_no_delete"))
INDEXES_V4 = frozenset({"evidence_store_created"})
SCHEMA_V4 = """
CREATE TABLE IF NOT EXISTS stocktake_evidence (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  actor_email TEXT NOT NULL,
  client_upload_id TEXT NOT NULL,
  client_stocktake_id TEXT NOT NULL,
  lot_id TEXT NOT NULL REFERENCES lots(id),
  source_sha256 TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL CHECK(mime='image/jpeg'),
  width INTEGER NOT NULL CHECK(typeof(width)='integer' AND width BETWEEN 1 AND 1600),
  height INTEGER NOT NULL CHECK(typeof(height)='integer' AND height BETWEEN 1 AND 1600),
  byte_size INTEGER NOT NULL CHECK(typeof(byte_size)='integer' AND byte_size BETWEEN 1 AND 1048576),
  image_blob BLOB NOT NULL CHECK(typeof(image_blob)='blob' AND length(image_blob)=byte_size),
  created_at TEXT NOT NULL,
  UNIQUE(store_id,client_upload_id)
);
CREATE INDEX IF NOT EXISTS evidence_store_created ON stocktake_evidence(store_id,created_at,id);
CREATE TABLE IF NOT EXISTS stocktake_line_evidence (
  stocktake_line_id TEXT PRIMARY KEY REFERENCES stocktake_lines(id),
  evidence_id TEXT NOT NULL UNIQUE REFERENCES stocktake_evidence(id)
);
CREATE TABLE IF NOT EXISTS sale_payments (
  sale_id TEXT NOT NULL REFERENCES sales(id),
  payment_method TEXT NOT NULL CHECK(payment_method IN ('cash','transfer')),
  amount_satang INTEGER NOT NULL CHECK(typeof(amount_satang)='integer' AND amount_satang BETWEEN 0 AND 5000000000000),
  PRIMARY KEY(sale_id,payment_method)
);
CREATE TABLE IF NOT EXISTS sale_rejections (
  store_id TEXT NOT NULL REFERENCES stores(id),
  client_sale_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(store_id,client_sale_id)
);
""" + "\n".join(
    "CREATE TRIGGER IF NOT EXISTS " + table + "_no_" + action.lower() +
    " BEFORE " + action + " ON " + table +
    " BEGIN SELECT RAISE(ABORT, 'Immutable schema-four audit'); END;"
    for table in sorted(TABLES_V4) for action in ("UPDATE", "DELETE")
)
