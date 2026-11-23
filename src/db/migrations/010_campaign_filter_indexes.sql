CREATE INDEX campaigns_verifier_idx ON campaigns (verifier);
CREATE INDEX campaigns_status_deadline_idx ON campaigns (status, deadline);
