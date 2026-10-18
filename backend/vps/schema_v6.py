"""Append-only completed-sale voids; original sales and ledger SQL stay intact."""

TABLES_V6 = frozenset({"sale_voids", "sale_void_lines"})
TRIGGERS_V6 = frozenset(name + suffix for name in TABLES_V6 for suffix in ("_no_update", "_no_delete"))
INDEXES_V6 = frozenset({"sale_voids_store_created", "sale_void_lines_void"})

SCHEMA_V6 = """
CREATE TABLE IF NOT EXISTS sale_voids (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  sale_id TEXT NOT NULL UNIQUE REFERENCES sales(id),
  client_void_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  actor_email TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK(actor_role IN ('owner','manager')),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 300),
  created_at TEXT NOT NULL,
  UNIQUE(store_id,client_void_id)
);
CREATE INDEX IF NOT EXISTS sale_voids_store_created ON sale_voids(store_id,created_at,id);
CREATE TABLE IF NOT EXISTS sale_void_lines (
  sale_line_id TEXT PRIMARY KEY REFERENCES sale_lines(id),
  void_id TEXT NOT NULL REFERENCES sale_voids(id),
  lot_id TEXT NOT NULL REFERENCES lots(id),
  quantity_mg INTEGER NOT NULL CHECK(typeof(quantity_mg)='integer' AND quantity_mg>0),
  quantity_before_mg INTEGER NOT NULL CHECK(typeof(quantity_before_mg)='integer' AND quantity_before_mg BETWEEN 0 AND 100000000),
  quantity_after_mg INTEGER NOT NULL CHECK(typeof(quantity_after_mg)='integer' AND quantity_after_mg=quantity_before_mg+quantity_mg AND quantity_after_mg<=100000000),
  stock_revision_before INTEGER NOT NULL CHECK(typeof(stock_revision_before)='integer' AND stock_revision_before BETWEEN 0 AND 8999999999999999999),
  stock_revision_after INTEGER NOT NULL CHECK(typeof(stock_revision_after)='integer' AND stock_revision_after=stock_revision_before+1),
  inventory_delta_satang INTEGER CHECK(inventory_delta_satang IS NULL OR (typeof(inventory_delta_satang)='integer' AND inventory_delta_satang>=0)),
  ledger_event_id TEXT NOT NULL UNIQUE REFERENCES ledger_events(id),
  UNIQUE(void_id,lot_id)
);
CREATE INDEX IF NOT EXISTS sale_void_lines_void ON sale_void_lines(void_id);
""" + "\n".join(
    "CREATE TRIGGER IF NOT EXISTS " + table + "_no_" + action.lower() +
    " BEFORE " + action + " ON " + table +
    " BEGIN SELECT RAISE(ABORT, 'Immutable completed-sale void'); END;"
    for table in sorted(TABLES_V6) for action in ("UPDATE", "DELETE")
)
