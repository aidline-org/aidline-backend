# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `GET /campaigns/:id/refunds`, newest first (#1, @RaymondAbiola)
- Full text search with `?q=` across title, summary, location and organiser (#2, #26, @RaymondAbiola, @adetomiwa21)
- Indexer lag reported in `/health` (#3, @RaymondAbiola)
- OpenAPI spec at `/openapi.json` and interactive docs at `/docs` (#4, @RaymondAbiola)
- Sorting campaigns by newest, ending soon or most funded (#9, @oladayo2222)
- Consistent JSON 404s and an `X-Request-Id` header (#10, #11, @oladayo2222)
- `GET /verifiers/:address/campaigns` (#12, @oladayo2222)
- Docker Compose for Postgres, URI helper tests and database retry at boot (#13, #14, #15, @oladayo2222)
- Automatic recovery when the RPC cursor falls out of retention (#23, @adetomiwa21, @oladayo2222)
- CSV export for auditors at `/campaigns/:id/export.csv` (#24, @adetomiwa21)
- Daily stats snapshots at `/stats/history` (#25, @adetomiwa21)

### Fixed

- Two parallel implementations of indexer recovery, stats history and search were merged into one each; a migration renumbered and duplicate tables dropped
- Stats history dates no longer shift by a day outside UTC
- A blank search is treated as no search, and refunds are ordered deterministically

## [0.1.0] - 2026-10-04

First public testnet release.

### Added

- Soroban event indexer with transactional cursor and replay safety
- Campaign, donation, release, refund and verifier tables in Postgres
- REST API: campaigns, campaign detail with milestone timeline, releases feed, donors, verifiers, stats, config
- Campaign metadata with organiser, and milestone proof uploads
- Verifier applications
- Demo seed script for testnet
- Embedded Postgres for local development, Dockerfile and Render blueprint
- Tests against a real throwaway Postgres, CI, API and architecture docs
