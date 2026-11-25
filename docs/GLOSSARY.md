# Glossary

Plain-language meanings of the terms used in the code, the database and these docs. Each entry links to where the term is used, so you can read the code that gives it meaning.

## Amount

A token amount. Amounts are stored as `NUMERIC(39, 0)` and returned as strings, so they never lose precision in JavaScript. Used in: [ADR 0003](adr/0003-amounts-are-numeric-strings.md), [Architecture](ARCHITECTURE.md#amounts).

## Campaign

A fundraising campaign on chain. It has a beneficiary, a goal, a deadline, a list of milestones and a kind, either `emergency` or `climate`. Its totals and status are copied from the contract, not added up from donations. Used in: [campaigns route](../src/routes/campaigns.ts), [schema](SCHEMA.md).

## Contract event

A message the Aidline contract publishes when its state changes, such as a donation or a milestone release. The indexer decodes each one and writes it to the database. Used in: [EVENTS.md](EVENTS.md), [decodeEvent](../src/stellar/events.ts#L60).

## Cursor

A position token that the RPC returns with each page of events. The indexer stores the latest one in `indexer_state.cursor` and sends it with the next request, so no event is read twice or skipped. Used in: [indexer](../src/indexer/indexer.ts#L120), [schema](SCHEMA.md).

## Emergency advance

An early payment for one milestone of an emergency campaign. It is recorded with the verifier named in the event. Used in: [store](../src/indexer/store.ts#L313), [campaigns route](../src/routes/campaigns.ts).

## Gap recovery

What the indexer does when its cursor has fallen out of the [retention window](#retention-window). It re-reads every known campaign from the contract, moves the cursor to the oldest ledger the RPC still holds, and carries on. No operator action is needed. Used in: [indexer](../src/indexer/indexer.ts#L254), [runbook](RUNBOOK.md#3-gap-recovery-cursor-outside-rpc-retention).

## GDACS alert

A disaster alert from the GDACS feed. Each feed item is stored once, and the newest ones are listed by `GET /alerts`. Used in: [gdacs job](../src/jobs/gdacs.ts#L110), [alerts route](../src/routes/alerts.ts).

## Keeper

A background job that extends the storage lifetime of active campaigns on chain, so their data does not expire. It runs only when `AIDLINE_KEEPER_SECRET` is set. Used in: [keeper](../src/indexer/keeper.ts#L50), [server](../src/server.ts).

## Ledger

One block of the Stellar network. A new ledger closes about every five seconds. Each event records the ledger it happened in, and the indexer compares its position with the chain's latest ledger to report lag. Used in: [indexer](../src/indexer/indexer.ts), [architecture](ARCHITECTURE.md).

## Metadata URI

The link stored on chain that points to a campaign's description. For a record created by this server it has the form `<PUBLIC_BASE_URL>/metadata/<id>`. Other URIs, such as IPFS links, are stored as they are. Used in: [uris](../src/lib/uris.ts#L6), [store](../src/indexer/store.ts#L13), [architecture](ARCHITECTURE.md#linking-off-chain-data).

## Milestone

One stage of a campaign's funding. The campaign's `milestones` list gives the amount for each stage, in order. Used in: [schema](SCHEMA.md), [store](../src/indexer/store.ts).

## Milestone release

The payout for one milestone, recorded from a `milestone_released` event. It can link to the proof that was uploaded for it. Used in: [store](../src/indexer/store.ts), [releases route](../src/routes/releases.ts).

## Page

Up to 100 events fetched in one `getEvents` call. The page and its new cursor are written in one transaction, so a page is either fully applied or not applied at all. Used in: [indexer](../src/indexer/indexer.ts#L9), [architecture](ARCHITECTURE.md).

## Pledge

A donor's promise to give an amount, which the contract pulls in parts later. A pledge can be skipped, and it is settled at a milestone. Used in: [store](../src/indexer/store.ts#L190), [campaigns route](../src/routes/campaigns.ts#L236).

## Proof

Evidence a verifier uploads for a milestone: a note and up to five JPEG, PNG, WebP or PDF files. Used in: [proofs route](../src/routes/proofs.ts#L40).

## Proof URI

The link on a milestone release that points to the proof for that milestone. For a proof created by this server it has the form `<PUBLIC_BASE_URL>/proofs/<id>`. Used in: [uris](../src/lib/uris.ts#L10), [store](../src/indexer/store.ts#L135).

## Refresh queue

The list of campaigns whose state could not be read from the contract. Their events wait in `pending_campaign_events` and are replayed in order once a read succeeds. Used in: [indexer](../src/indexer/indexer.ts), [schema](SCHEMA.md).

## Refund

Money returned to a donor from a campaign, recorded from a `refunded` event. Used in: [store](../src/indexer/store.ts), [donors route](../src/routes/donors.ts).

## Retention window

How far back the RPC node keeps events. Events older than the window can no longer be fetched. Used in: [indexer](../src/indexer/indexer.ts#L20), [runbook](RUNBOOK.md), [deployment](DEPLOYMENT.md).

## Slashing

A penalty that takes part of a verifier's bond. The verifier is then marked as ever slashed. Used in: [store](../src/indexer/store.ts#L295).

## Snapshot

One row of platform totals for one UTC day, kept in `daily_stats_snapshots` and returned by `GET /stats/history`. Used in: [stats](../src/indexer/stats.ts#L56), [schema](SCHEMA.md).

## Sponsor pool

Money a sponsor deposits to match donations to a campaign. Each match uses a ratio in basis points (10000 is 100 percent) and stops at a cap. Money that is not used can be returned to the sponsor. Used in: [store](../src/indexer/store.ts#L86), [sponsor-pool route](../src/routes/campaigns.ts#L101).

## Stroop

The smallest unit of a token. For XLM it is one ten-millionth of an XLM (seven decimal places). Token amounts in the API are integer strings in this unit. Used in: [API reference](API.md), [campaigns route](../src/routes/campaigns.ts#L256).

## TTL

Time to live. Contract storage expires after a set number of ledgers unless it is extended, and the keeper does the extending. Campaigns record the last ledger at which they were extended in `ttl_extended_ledger`. Used in: [keeper](../src/indexer/keeper.ts#L50), [migration 007_campaign_ttl](../src/db/migrations/007_campaign_ttl.sql).

## Verifier

An approved organisation that uploads proof for a campaign's milestones. Only an on-chain `verifier_updated` event can make a verifier active, so a profile application alone never does. Used in: [verifiers route](../src/routes/verifiers.ts), [EVENTS.md](EVENTS.md).

## Verifier bond

Money a verifier posts with the contract. It can be withdrawn, and part of it can be slashed. Used in: [store](../src/indexer/store.ts#L265), [schema](SCHEMA.md).

## Webhook delivery

One attempt to send a milestone release to a subscribed URL. A failed attempt is retried after a delay that doubles each time, until the delivery is marked delivered or failed. Used in: [deliveries](../src/webhooks/deliveries.ts#L13), [dispatcher](../src/webhooks/dispatcher.ts).
