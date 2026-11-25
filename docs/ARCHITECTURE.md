# Architecture

```
            Soroban RPC                         Postgres
  ┌──────────────────────────┐        ┌──────────────────────────┐
  │ getEvents (cursor)       │──────▶ │ campaigns, donations,    │
  │ simulate get_campaign    │        │ milestone_releases,      │
  └──────────────────────────┘        │ refunds, verifiers,      │
              ▲                       │ campaign_metadata,       │
              │ Indexer               │ proofs, indexer_state    │
              │                       └────────────┬─────────────┘
                                                   │
  Frontend ──── REST API (Fastify) ────────────────┘
```

## Source layout

```
src/
  server.ts            starts the API and the indexer
  app.ts               Fastify app, plugins and error handling
  config.ts            environment parsing with zod
  db/                  pool, migrator and SQL migrations
  stellar/contract.ts  read only contract calls through simulation
  stellar/events.ts    decodes raw RPC events into typed events
  indexer/indexer.ts   polling loop and transactional page processing
  indexer/store.ts     how each event is written to Postgres
  routes/              one file per resource
test/                  vitest suites against a throwaway Postgres
```

## Data model

Every table and column, the migrations that create them, and the code that writes and reads each table are described in [SCHEMA.md](SCHEMA.md).

## How the indexer stays correct

1. **Cursor based paging.** On a fresh database the indexer starts at `INDEXER_START_LEDGER` (clamped to the oldest ledger the RPC still keeps), then follows the cursor returned by `getEvents`.
2. **One transaction per page.** All rows for a page and the new cursor are committed together. If anything fails, nothing is written and the same page is retried on the next tick. No event is ever skipped.
3. **Idempotent writes.** History tables use the RPC event id as the primary key with `ON CONFLICT DO NOTHING`, so replaying a page is harmless.
4. **Chain state is copied, not computed.** For every campaign touched in a page, the indexer reads `get_campaign` from the contract and stores its totals. A missed or reordered event can never make `raised` or `released` drift from the contract.
5. **Unknown events are ignored.** New contract events do not crash older indexers.

## Linking off chain data

Metadata and proof URIs created by this API look like `<PUBLIC_BASE_URL>/metadata/<uuid>` and `<PUBLIC_BASE_URL>/proofs/<uuid>`. When the indexer sees such a URI on chain it links the row by id. URIs pointing elsewhere (for example IPFS) are stored as is.

## Amounts

Token amounts are `i128` on chain. They are stored as `NUMERIC(39,0)` and returned as strings. Type parsers in `db/pool.ts` make sure they never pass through a JavaScript number, including inside arrays.

## Design decisions

- **Polling, not streaming.** Soroban RPC has no push subscription. A 5 second poll matches ledger close time.
- **Local file storage for proofs.** Simple for the MVP. Moving to S3 compatible storage or IPFS is a planned improvement.
- **Verifier status from chain only.** Applications store profiles, but only the on chain `verifier_updated` event can make a verifier active.
- **No auth on writes yet.** Metadata and proofs are immutable and only matter once referenced on chain, which requires a signed transaction. Wallet signature auth is a planned improvement.

## Roadmap

- Wallet signature authentication for uploads
- S3 or IPFS storage for proofs and images
- Image upload for campaign covers
- Webhooks and email notifications for donors when milestones are released
- Disaster alert ingestion (GDACS, ReliefWeb) to suggest emergency campaigns
- OpenAPI spec generated from route schemas
