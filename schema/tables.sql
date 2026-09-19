-- cannabis-pos-v0 stock ledger draft (SQLite-friendly types)
-- Local only — schema not final until aaa01 + Ai CPU WEB review

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL CHECK (role IN ('owner','manager','cashier','auditor')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE products (
  id            TEXT PRIMARY KEY,
  sku           TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL, -- flower|edible|concentrate|other
  unit          TEXT NOT NULL, -- g|mg|each
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at    TEXT NOT NULL
);

CREATE TABLE lots (
  id            TEXT PRIMARY KEY,
  product_id    TEXT NOT NULL REFERENCES products(id),
  lot_code      TEXT NOT NULL,
  received_on   TEXT,          -- date grown/received label
  expires_on    TEXT,
  thc_pct       REAL,
  cbd_pct       REAL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at    TEXT NOT NULL,
  UNIQUE (product_id, lot_code)
);

-- Append-only ledger
CREATE TABLE stock_events (
  id              TEXT PRIMARY KEY,
  lot_id          TEXT NOT NULL REFERENCES lots(id),
  event_type      TEXT NOT NULL CHECK (event_type IN (
                    'receive','sell','waste','transfer_in','transfer_out','adjust'
                  )),
  qty_delta       REAL NOT NULL,          -- signed
  unit            TEXT NOT NULL,
  occurred_at     TEXT NOT NULL,          -- business time (ISO-8601)
  actor_user_id   TEXT NOT NULL REFERENCES users(id),
  reason          TEXT,                   -- required for adjust/waste
  ref_type        TEXT,                   -- future: sale|po|transfer
  ref_id          TEXT,
  allow_negative  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,          -- system insert time
  CHECK (event_type != 'adjust' OR (reason IS NOT NULL AND length(reason) > 0)),
  CHECK (event_type != 'waste' OR (reason IS NOT NULL AND length(reason) > 0))
);

CREATE INDEX idx_stock_events_lot_time ON stock_events (lot_id, occurred_at);
CREATE INDEX idx_stock_events_time ON stock_events (occurred_at);
