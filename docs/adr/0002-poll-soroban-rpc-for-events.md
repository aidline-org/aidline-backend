# 0002: Poll Soroban RPC instead of streaming

Status: Accepted

## Context

The indexer needs to learn about new contract events. Soroban RPC offers `getEvents` with a cursor. It has no push or subscription API.

## Decision

Poll `getEvents` on a fixed interval (`INDEXER_POLL_MS`, default 5 seconds, minimum 1 second), following the cursor from the last processed page.

Each page is processed in one database transaction together with the new cursor. History rows use the RPC event id as the primary key with `ON CONFLICT DO NOTHING`.

## Consequences

- A failed page writes nothing and is retried on the next tick, so no event is skipped.
- Replaying a page is harmless because writes are idempotent.
- Updates appear within about one ledger close time, which is fast enough for a donation UI.
- On a fresh database the start ledger is clamped to the oldest ledger the RPC keeps. History older than the RPC window cannot be recovered by this indexer.
- Unknown event types are ignored, so a newer contract does not crash an older indexer.
