CREATE TABLE IF NOT EXISTS orders (
  id        TEXT PRIMARY KEY,   -- RS-XXXX
  charge_id TEXT,               -- chg_... (Tap فقط)
  method    TEXT,               -- tap / transfer
  status    TEXT,               -- INITIATED / CAPTURED / FAILED / AWAITING_TRANSFER / PAID
  total     REAL,
  customer  TEXT,               -- JSON
  lines     TEXT,               -- JSON
  updated   INTEGER
);
