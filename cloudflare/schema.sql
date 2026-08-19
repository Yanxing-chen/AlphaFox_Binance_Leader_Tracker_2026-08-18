CREATE TABLE IF NOT EXISTS orders (
  portfolio_id TEXT NOT NULL,
  order_key TEXT NOT NULL,
  symbol TEXT NOT NULL,
  base_asset TEXT,
  quote_asset TEXT,
  side TEXT,
  type TEXT,
  position_side TEXT,
  executed_qty REAL,
  avg_price REAL,
  total_pnl REAL,
  order_update_time INTEGER,
  order_time INTEGER,
  raw_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (portfolio_id, order_key)
);

CREATE INDEX IF NOT EXISTS idx_orders_portfolio_time
ON orders (portfolio_id, order_update_time);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  portfolio_id TEXT NOT NULL,
  polled_at TEXT NOT NULL,
  margin_balance REAL,
  aum_amount REAL,
  current_copy_count INTEGER,
  max_copy_count INTEGER,
  orders_stored INTEGER,
  orders_added INTEGER,
  data_hash TEXT,
  snapshot_json TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_snapshots_portfolio_id
ON snapshots (portfolio_id, id DESC);

CREATE TABLE IF NOT EXISTS poll_runs (
  portfolio_id TEXT PRIMARY KEY,
  last_poll_at TEXT,
  last_snapshot_at TEXT,
  last_error TEXT,
  updated_at TEXT,
  meta_json TEXT
);
