-- Migration 004: full_text_search
--
-- Adds PostgreSQL full-text search across campaigns.
-- The search needs to cover title, summary, location, and organizer.
-- All these fields exist on the `campaign_metadata` table, which is immutable
-- once inserted. Therefore we add a generated tsvector column directly to the
-- metadata table and index it with GIN for fast lookups.
--
-- Coalesce is used to safely handle NULLs in optional fields like organizer
-- without failing the concatenation.

ALTER TABLE campaign_metadata
ADD COLUMN search_vector tsvector
GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
  setweight(to_tsvector('english', coalesce(location, '')), 'C') ||
  setweight(to_tsvector('english', coalesce(organizer, '')), 'D')
) STORED;

CREATE INDEX campaign_metadata_search_idx ON campaign_metadata USING GIN (search_vector);
