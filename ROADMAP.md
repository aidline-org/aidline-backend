# Roadmap

Where the Aidline backend is heading. Items link to open issues where one exists. GitHub is the source of truth for status: see [open issues](https://github.com/aidline-org/aidline-backend/issues) and [ISSUES.md](ISSUES.md).

## Now: harden the MVP

- Move proof uploads from local disk to S3 compatible storage
- Validate uploaded files by content, not just declared type
- Stricter rate limits on uploads
- Metrics for the indexer, API latency and error rates

## Next: trust and notifications

- Wallet signature authentication for uploads, so only the right party can attach proofs
- Webhooks and email notifications when a milestone is released
- Image uploads for campaign covers
- Pin proofs and metadata to IPFS as an alternative to API hosted URIs

## Later: scale and reach

- Disaster alert ingestion (GDACS, ReliefWeb) to suggest emergency campaigns
- Multi contract and multi token indexing
- Read replicas and caching for campaign listings
- Public data export for researchers and auditors

## Before mainnet

- External security audit of the contract
- Load test of the indexer against a high event volume
- Backup and restore drill for the database
- Runbook for indexer recovery

## How to influence this

Open an issue describing the problem you want solved, or comment on an existing one. Contributions that move any item above forward are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
