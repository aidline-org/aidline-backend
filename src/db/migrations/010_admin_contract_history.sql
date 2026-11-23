-- Preserve history across redeploys and expose administrative transitions.
CREATE TABLE IF NOT EXISTS indexed_events (
  event_id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  ledger INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS indexed_events_contract_ledger_idx ON indexed_events (contract_id, ledger);

CREATE TABLE IF NOT EXISTS admin_changes (
  event_id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  admin TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('added', 'removed')),
  ledger INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_changes_admin_idx ON admin_changes (admin, created_at DESC);

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS cancelled_ledger INTEGER;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS cancelled_tx_hash TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
