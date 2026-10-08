-- #23: track the chain's latest ledger so the health endpoint can report lag
ALTER TABLE indexer_state ADD COLUMN IF NOT EXISTS latest_ledger INTEGER;

-- #25: daily stats snapshot table for chart history
CREATE TABLE IF NOT EXISTS daily_stats (
  date           DATE        PRIMARY KEY,
  campaigns      INTEGER     NOT NULL DEFAULT 0,
  donations      INTEGER     NOT NULL DEFAULT 0,
  "totalDonated" NUMERIC(39,0) NOT NULL DEFAULT 0,
  "totalReleased" NUMERIC(39,0) NOT NULL DEFAULT 0
);

-- #26: full-text search vector on campaign_metadata (title + location)
ALTER TABLE campaign_metadata
  ADD COLUMN IF NOT EXISTS search_vec TSVECTOR
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(location, ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS campaign_metadata_search_vec_idx
  ON campaign_metadata USING gin(search_vec);
