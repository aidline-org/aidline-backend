-- Migration 003: daily_stats_snapshots
--
-- Stores one row per UTC calendar day representing platform-wide totals at
-- the time the snapshot was taken.  This is consumed by GET /stats/history.
--
-- Timezone convention: days are expressed as UTC dates (DATE type). The
-- snapshot job should run once per UTC day, typically at midnight UTC.  Using
-- UTC avoids ambiguity from daylight-saving transitions and is consistent with
-- the ISO 8601 timestamps already used everywhere else in the schema.
--
-- Financial amounts are NUMERIC(39,0) — the same type as campaigns.raised /
-- donations.amount — so they can hold full i128 Soroban token values without
-- loss of precision.  Floating-point types are intentionally not used.
--
-- Idempotency: the UNIQUE constraint on `snapshot_date` makes it impossible to
-- insert two rows for the same day.  The snapshot job uses INSERT … ON CONFLICT
-- DO NOTHING so a second run for an already-snapshotted day is a no-op.

CREATE TABLE daily_stats_snapshots (
  snapshot_date       DATE        NOT NULL,
  campaigns           INTEGER     NOT NULL,
  active_campaigns    INTEGER     NOT NULL,
  total_donated       NUMERIC(39, 0) NOT NULL,
  total_released      NUMERIC(39, 0) NOT NULL,
  total_refunded      NUMERIC(39, 0) NOT NULL,
  donors              INTEGER     NOT NULL,
  verifiers           INTEGER     NOT NULL,
  milestones_verified INTEGER     NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT daily_stats_snapshots_pkey PRIMARY KEY (snapshot_date)
);

-- The primary key already creates a unique index on snapshot_date.
-- An additional index is not needed for the /stats/history query which reads
-- all rows ordered by snapshot_date — the PK index handles that efficiently.
