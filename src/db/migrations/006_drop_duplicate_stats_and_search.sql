-- Migration 006: remove duplicates left by two parallel implementations.
--
-- Migration 003 created a `daily_stats` table and a `search_vec` column, but
-- the code reads `daily_stats_snapshots` (005) and `search_vector` (004).
-- 003 has already run on deployed databases, so it is left untouched and the
-- unused objects are dropped here instead.

DROP TABLE IF EXISTS daily_stats;

DROP INDEX IF EXISTS campaign_metadata_search_vec_idx;
ALTER TABLE campaign_metadata DROP COLUMN IF EXISTS search_vec;
