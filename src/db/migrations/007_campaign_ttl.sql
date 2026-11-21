-- #22: anchor ledger for the last TTL extension by the keeper. NULL means the
-- campaign has never been bumped, so its creation ledger is used instead.
ALTER TABLE campaigns ADD COLUMN ttl_extended_ledger INTEGER;
CREATE INDEX campaigns_ttl_idx ON campaigns (status, ttl_extended_ledger);
