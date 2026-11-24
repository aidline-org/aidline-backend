# Database schema

This file describes every table and column the migrations create, in the state they leave the database after the last one. For each table it also names the code that writes it and the code that reads it. The SQL in `src/db/migrations/` is the source of truth. When a migration changes a table, update this file in the same pull request.

## How migrations run

`migrate` in `src/db/migrate.ts` applies each `.sql` file in `src/db/migrations/` once. Files run in file name order, each in its own transaction, and the name is recorded in `schema_migrations`.

Several numbers repeat: there are three `007` files, two `008` files and two `010` files. They still run in name order, so the `007` files run alphabetically: alerts and webhooks, then campaign TTL, then indexer state.

Merged migrations are never edited, so a later file sometimes undoes an earlier one. Migration 003 creates a `daily_stats` table and a `search_vec` column. Migration 006 drops both, because the code reads `daily_stats_snapshots` and `campaign_metadata.search_vector` instead.

Amounts are `NUMERIC(39, 0)` in every table. They are returned as strings, never as JavaScript numbers. See [ADR 0003](adr/0003-amounts-are-numeric-strings.md).

## Chain mirror

### `campaigns`

Written by `src/indexer/store.ts` (`upsertCampaign` copies the contract state, and the `campaign_created` and `campaign_cancelled` events add their fields) and by `src/indexer/keeper.ts` (`ttl_extended_ledger`).

Read by `src/routes/campaigns.ts`, `src/routes/donors.ts`, `src/routes/verifiers.ts`, `src/routes/releases.ts`, `src/routes/events.ts`, `src/routes/webhooks.ts`, `src/indexer/stats.ts`, `src/indexer/keeper.ts` and `src/indexer/indexer.ts`.

- `id` BIGINT, primary key. The on-chain campaign id.
- `creator`, `beneficiary`, `verifier` TEXT, NOT NULL. Stellar account addresses copied from the contract. A verifier reassignment updates `verifier`.
- `kind` TEXT, NOT NULL. Either `emergency` or `climate`.
- `metadata_uri` TEXT, NOT NULL. The URI stored on chain.
- `metadata_id` UUID, nullable, references `campaign_metadata(id)`. Set only when `metadata_uri` points at a metadata record this server created. The first link is kept.
- `goal` NUMERIC(39, 0), NOT NULL. The funding goal.
- `deadline` TIMESTAMPTZ, NOT NULL. Set from the contract's deadline.
- `milestones` NUMERIC(39, 0) array, NOT NULL. The amount of each milestone, in order.
- `milestones_released` INTEGER, NOT NULL, default 0. Copied from the contract.
- `raised` NUMERIC(39, 0), NOT NULL, default 0. Copied from the contract, never summed from donations.
- `released` NUMERIC(39, 0), NOT NULL, default 0. Copied from the contract, never summed from releases.
- `status` TEXT, NOT NULL. One of `active`, `completed` or `cancelled`. The indexer skips a campaign whose status is anything else.
- `created_ledger` INTEGER, NOT NULL. The ledger of the `campaign_created` event.
- `created_at` TIMESTAMPTZ, NOT NULL. The ledger close time of the same event.
- `updated_at` TIMESTAMPTZ, NOT NULL, default `now()`. Changed on every upsert.
- `ttl_extended_ledger` INTEGER, nullable. The ledger at which the keeper last extended the campaign's storage. Null means it has never been extended, so `created_ledger` is used.
- `created_event_id` TEXT, nullable. The event id of the `campaign_created` event. The event stream uses it to replay creations for a client that sends `Last-Event-ID`.
- `cancelled_ledger` INTEGER, nullable. Set by the `campaign_cancelled` event.
- `cancelled_tx_hash` TEXT, nullable. Set by the same event.
- `cancelled_at` TIMESTAMPTZ, nullable. Set by the same event.

### `campaign_metadata`

Written by `src/routes/metadata.ts` (`POST /metadata`). Rows are never updated. Rows that no campaign points to are deleted by `src/indexer/metadata-orphans.ts` (`npm run metadata:orphans`) once they are older than the chosen age.

Read by `src/routes/metadata.ts` (`GET /metadata/:id`), `src/routes/campaigns.ts`, `src/routes/donors.ts`, `src/routes/releases.ts` and `src/routes/verifiers.ts`, which join it to campaigns. `src/indexer/store.ts` checks that a row exists before it links a campaign to it.

- `id` UUID, primary key. The record id, used in the metadata URI.
- `title` TEXT, NOT NULL.
- `summary` TEXT, NOT NULL.
- `description` TEXT, NOT NULL.
- `location` TEXT, NOT NULL.
- `category` TEXT, nullable. One of the values in `src/lib/categories.ts`.
- `image_url` TEXT, nullable.
- `created_at` TIMESTAMPTZ, NOT NULL, default `now()`.
- `organizer` TEXT, nullable. Added by migration 002. The name of the organisation raising the money.
- `search_vector` TSVECTOR, generated and stored. Built from `title` (weight A), `summary` (B), `location` (C) and `organizer` (D), and indexed with GIN. Read by the `search` filter of `GET /campaigns`.

### `milestone_releases`

Written by `src/indexer/store.ts` for each `milestone_released` event. In the same transaction, `src/webhooks/deliveries.ts` queues a webhook delivery for each subscription on the campaign.

Read by `src/routes/campaigns.ts` (the campaign detail, the CSV export and `GET /campaigns/:id/releases`), `src/routes/releases.ts`, `src/routes/events.ts`, `src/indexer/stats.ts` and `src/indexer/stats-backfill.ts`.

- `event_id` TEXT, primary key. The id of the chain event. A replayed event is ignored.
- `campaign_id` BIGINT, NOT NULL, references `campaigns(id)`.
- `index` INTEGER, NOT NULL. The milestone number. Unique together with `campaign_id`.
- `amount` NUMERIC(39, 0), NOT NULL.
- `proof_uri` TEXT, NOT NULL. The proof URI from the event, stored as it arrived.
- `proof_id` UUID, nullable, references `proofs(id)`. Set only when `proof_uri` points at a proof this server created.
- `ledger` INTEGER, NOT NULL.
- `tx_hash` TEXT, NOT NULL.
- `created_at` TIMESTAMPTZ, NOT NULL. The ledger close time.

### `proofs`

Written by `src/routes/proofs.ts` (`POST /proofs`), after the files are saved through the storage driver. The row is written last, and the files are removed again if the request fails.

Read by `src/routes/proofs.ts` (`GET /proofs/:id`), `src/indexer/store.ts` (to check a proof exists before linking it), `src/routes/campaigns.ts` and `src/routes/releases.ts` (joined to releases), and `src/webhooks/deliveries.ts` (for the proof part of a webhook payload).

- `id` UUID, primary key.
- `campaign_id` BIGINT, NOT NULL. Not a foreign key, so a proof can be uploaded before the campaign is indexed.
- `milestone_index` INTEGER, NOT NULL.
- `note` TEXT, NOT NULL.
- `files` JSONB, NOT NULL, default `[]`. One object per file, with `name`, `type`, `size` and `url`.
- `created_at` TIMESTAMPTZ, NOT NULL, default `now()`.

### `donations`

Written by `src/indexer/store.ts` for each `donated` event.

Read by `src/routes/campaigns.ts` (the donations list, the CSV export and the campaign detail), `src/routes/donors.ts`, `src/routes/events.ts` and `src/indexer/stats.ts` (for the donor count).

- `event_id` TEXT, primary key. The chain event id. A replayed event is ignored.
- `campaign_id` BIGINT, NOT NULL, references `campaigns(id)`.
- `donor` TEXT, NOT NULL. The donor's account address.
- `amount` NUMERIC(39, 0), NOT NULL.
- `ledger` INTEGER, NOT NULL.
- `tx_hash` TEXT, NOT NULL.
- `created_at` TIMESTAMPTZ, NOT NULL. The ledger close time.

### `refunds`

Written by `src/indexer/store.ts` for each `refunded` event.

Read by `src/routes/campaigns.ts` (the refunds list and CSV export), `src/routes/donors.ts`, `src/routes/events.ts` and `src/indexer/stats.ts` (the total refunded).

- `event_id` TEXT, primary key.
- `campaign_id` BIGINT, NOT NULL, references `campaigns(id)`.
- `donor` TEXT, NOT NULL.
- `amount` NUMERIC(39, 0), NOT NULL.
- `ledger` INTEGER, NOT NULL.
- `tx_hash` TEXT, NOT NULL.
- `created_at` TIMESTAMPTZ, NOT NULL.

### `emergency_advances`

Written by `src/indexer/store.ts` for each `emergency_advance_released` event.

Read by `src/routes/campaigns.ts`. The list is returned as `emergencyAdvances` in `GET /campaigns/:id`.

- `event_id` TEXT, primary key.
- `campaign_id` BIGINT, NOT NULL, references `campaigns(id)`.
- `verifier` TEXT, NOT NULL.
- `milestone_index` INTEGER, NOT NULL.
- `amount` NUMERIC(39, 0), NOT NULL.
- `ledger` INTEGER, NOT NULL.
- `tx_hash` TEXT, NOT NULL.
- `created_at` TIMESTAMPTZ, NOT NULL.

## Verifiers

### `verifiers`

Written by `src/indexer/store.ts` (`verifier_updated`, `verifier_bond_posted`, `verifier_deregistered`, `bond_withdrawn` and `bond_slashed`) and by `src/routes/verifiers.ts` (`POST /verifiers/applications`), which fills in the profile fields.

Read by `src/routes/verifiers.ts`, `src/routes/releases.ts` (joined to releases), `src/indexer/stats.ts` (the count of active verifiers) and `src/indexer/stats-backfill.ts`.

- `address` TEXT, primary key. The verifier's account address.
- `active` BOOLEAN, NOT NULL, default `false`. Set only by the chain's `verifier_updated` event. A profile alone never makes a verifier active.
- `org_name` TEXT, nullable. From the application.
- `website` TEXT, nullable. From the application.
- `country` TEXT, nullable. From the application.
- `description` TEXT, nullable. From the application.
- `applied_at` TIMESTAMPTZ, nullable. Set when the application is made.
- `updated_at` TIMESTAMPTZ, NOT NULL, default `now()`.
- `bond_amount` NUMERIC(39, 0), NOT NULL, default 0. Goes up with `verifier_bond_posted` and down with `bond_withdrawn` and `bond_slashed`. It never goes below zero.
- `ever_slashed` BOOLEAN, NOT NULL, default `false`. Set to true by `bond_slashed`.
- `deregistered_at` TIMESTAMPTZ, nullable. Set by `verifier_deregistered`.

### `verifier_bond_events`

Written by `src/indexer/store.ts` for the bond events: `posted`, `deregistered`, `withdrawn` and `slashed` in `event_type`.

No route reads this table yet.

- `event_id` TEXT, primary key.
- `event_type` TEXT, NOT NULL. One of `posted`, `deregistered`, `withdrawn` or `slashed`.
- `verifier` TEXT, NOT NULL.
- `campaign_id` BIGINT, nullable. Set only for `slashed`.
- `amount` NUMERIC(39, 0), nullable. Zero for `deregistered`.
- `ledger` INTEGER, NOT NULL.
- `tx_hash` TEXT, NOT NULL.
- `created_at` TIMESTAMPTZ, NOT NULL.

## Pledges and sponsor pool

### `pledges`

Written by `src/indexer/store.ts`. `pledge_created` inserts or updates the row. `pledge_pulled`, `pledge_skipped` and `pledge_settlement` update the status. A settlement marks every active pledge on the campaign as settled.

Read by `src/routes/campaigns.ts` (`GET /campaigns/:id/pledges`) and `src/routes/donors.ts` (the pledges in a donor's profile).

- `pledge_id` BIGINT, primary key. The on-chain pledge id.
- `campaign_id` BIGINT, NOT NULL, references `campaigns(id)`.
- `donor` TEXT, NOT NULL.
- `pledged_amount` NUMERIC(39, 0), NOT NULL.
- `pulled_amount` NUMERIC(39, 0), NOT NULL, default 0. Goes up with each pull.
- `status` TEXT, NOT NULL, default `active`. One of `active`, `pulled`, `skipped` or `settled`.
- `skipped_reason` INTEGER, nullable. The reason code from `pledge_skipped`.
- `settled_at` TIMESTAMPTZ, nullable. Set when the pledge is settled.
- `updated_at` TIMESTAMPTZ, NOT NULL, default `now()`.

### `pledge_events`

Written by `src/indexer/store.ts` with one row per pledge event. `event_type` is `created`, `pulled`, `skipped` or `settled`.

No route reads this table yet.

- `event_id` TEXT, primary key.
- `event_type` TEXT, NOT NULL.
- `pledge_id` BIGINT, nullable. Null for `settled`, which covers a whole campaign.
- `campaign_id` BIGINT, NOT NULL, references `campaigns(id)`.
- `donor` TEXT, NOT NULL. Empty for `settled`.
- `amount` NUMERIC(39, 0), nullable. Null for `skipped`.
- `reason` INTEGER, nullable. Set for `skipped`.
- `milestone_index` INTEGER, nullable. Set for `settled`.
- `ledger` INTEGER, NOT NULL.
- `tx_hash` TEXT, NOT NULL.
- `created_at` TIMESTAMPTZ, NOT NULL.

### `sponsor_pool_deposits`

Written by `src/indexer/store.ts` for each `sponsor_pool_deposited` event.

Read by `src/routes/campaigns.ts` (`GET /campaigns/:id/sponsor-pool`).

- `event_id` TEXT, primary key.
- `ledger` INTEGER, NOT NULL.
- `tx_hash` TEXT, NOT NULL.
- `created_at` TIMESTAMPTZ, NOT NULL.
- `campaign_id` BIGINT, NOT NULL, references `campaigns(id)`.
- `sponsor` TEXT, NOT NULL.
- `amount` NUMERIC(39, 0), NOT NULL.
- `ratio_bps` INTEGER, NOT NULL. The matching ratio in basis points.
- `cap` NUMERIC(39, 0), NOT NULL. The most the sponsor will match.

### `sponsor_pool_matches`

Written by `src/indexer/store.ts` for each `sponsor_pool_matched` event.

Read by `src/routes/campaigns.ts` (`GET /campaigns/:id/sponsor-pool`).

- `event_id` TEXT, primary key.
- `ledger` INTEGER, NOT NULL.
- `tx_hash` TEXT, NOT NULL.
- `created_at` TIMESTAMPTZ, NOT NULL.
- `campaign_id` BIGINT, NOT NULL, references `campaigns(id)`.
- `sponsor` TEXT, NOT NULL.
- `donor` TEXT, NOT NULL. The donor whose donation was matched.
- `donation_amount` NUMERIC(39, 0), NOT NULL.
- `matched_amount` NUMERIC(39, 0), NOT NULL.

### `sponsor_pool_returns`

Written by `src/indexer/store.ts` for each `sponsor_pool_returned` event.

Read by `src/routes/campaigns.ts` (`GET /campaigns/:id/sponsor-pool`).

- `event_id` TEXT, primary key.
- `ledger` INTEGER, NOT NULL.
- `tx_hash` TEXT, NOT NULL.
- `created_at` TIMESTAMPTZ, NOT NULL.
- `campaign_id` BIGINT, NOT NULL, references `campaigns(id)`.
- `sponsor` TEXT, NOT NULL.
- `amount` NUMERIC(39, 0), NOT NULL.

## Indexer bookkeeping

### `indexer_state`

A single row, `id = 1`. Written by `src/indexer/indexer.ts` each time a page commits, by `reindex` and when gap recovery resets the cursor.

Read by `src/indexer/indexer.ts` (the cursor), `src/indexer/keeper.ts` (`latest_ledger`), `src/metrics.ts`, and the `/health` and `/ready` routes in `src/routes/meta.ts`.

- `id` INTEGER, primary key, default 1. A check constraint allows only the value 1.
- `cursor` TEXT, nullable. The paging cursor from the RPC. Null means the next poll starts from the configured ledger.
- `last_ledger` INTEGER, nullable. The ledger the indexer has reached. After gap recovery it is the oldest ledger the RPC still holds.
- `latest_ledger` INTEGER, nullable. The chain's latest ledger when the page was read. The lag is the difference.
- `updated_at` TIMESTAMPTZ, nullable. The last time a page committed. Null until the indexer first writes.

### `indexed_events`

Written by `src/indexer/store.ts` (`recordEvent`) for every event that is recorded, before the event-specific table is written. Events parked in `pending_campaign_events` are recorded later, when they are replayed.

No route reads this table yet.

- `event_id` TEXT, primary key. The RPC event id.
- `contract_id` TEXT, NOT NULL.
- `event_type` TEXT, NOT NULL. The decoded event type, such as `donated`.
- `ledger` INTEGER, NOT NULL.
- `tx_hash` TEXT, NOT NULL.
- `payload` JSONB, NOT NULL. The whole decoded event, with amounts as strings.
- `created_at` TIMESTAMPTZ, NOT NULL.

### `admin_changes`

Written by `src/indexer/store.ts` for `admin_added` and `admin_removed` events.

Read by the `GET /admin` route in `src/routes/meta.ts`.

- `event_id` TEXT, primary key.
- `contract_id` TEXT, NOT NULL.
- `admin` TEXT, NOT NULL. The account that was added or removed.
- `action` TEXT, NOT NULL. Either `added` or `removed`.
- `ledger` INTEGER, NOT NULL.
- `tx_hash` TEXT, NOT NULL.
- `created_at` TIMESTAMPTZ, NOT NULL.

### `campaign_refresh_queue`

Written by `src/indexer/indexer.ts` when a campaign's state cannot be read from the contract. Its `last_attempt_at` is updated on each retry, and the row is deleted once a read succeeds.

Read by `src/indexer/indexer.ts` (`retryPendingCampaigns`). Retries run at most every 60 seconds, for up to 20 campaigns at a time.

- `campaign_id` BIGINT, primary key.
- `last_error_at` TIMESTAMPTZ, NOT NULL, default `now()`.
- `last_attempt_at` TIMESTAMPTZ, nullable.
- `warned` BOOLEAN, NOT NULL, default `false`. Whether the warning for this campaign has been logged.

### `pending_campaign_events`

Written by `src/indexer/indexer.ts` for each event on a campaign that could not be read. The events wait here, so the cursor can still move on.

Read and deleted by `src/indexer/indexer.ts`. When the campaign reads successfully, its events are replayed in order and the rows are removed.

- `event_id` TEXT, primary key.
- `campaign_id` BIGINT, NOT NULL, references `campaign_refresh_queue(campaign_id)`.
- `payload` JSONB, NOT NULL. The decoded event, with bigints as strings.
- `created_at` TIMESTAMPTZ, NOT NULL, default `now()`.

### `schema_migrations`

Written and read by `src/db/migrate.ts`. One row per migration file that has run.

- `name` TEXT, primary key. The file name, such as `010_campaign_filter_indexes.sql`.
- `applied_at` TIMESTAMPTZ, NOT NULL, default `now()`.

## Statistics and alerts

### `daily_stats_snapshots`

Written by `src/indexer/stats.ts` (`snapshotStats`). The scheduler refreshes today's row about once an hour. Its upsert also replaces any earlier row for the same date. `src/indexer/stats-backfill.ts` fills in days that have no row.

Read by `src/indexer/stats.ts` for `GET /stats/history`, oldest first.

- `snapshot_date` DATE, primary key. One row per UTC day.
- `campaigns` INTEGER, NOT NULL. The number of campaigns.
- `active_campaigns` INTEGER, NOT NULL. Active campaigns whose deadline has not passed.
- `total_donated` NUMERIC(39, 0), NOT NULL. The sum of `raised` across campaigns.
- `total_released` NUMERIC(39, 0), NOT NULL. The sum of `released` across campaigns.
- `total_refunded` NUMERIC(39, 0), NOT NULL. The sum of refund amounts.
- `donors` INTEGER, NOT NULL. Distinct donor addresses.
- `verifiers` INTEGER, NOT NULL. Active verifiers.
- `milestones_verified` INTEGER, NOT NULL. Milestone releases.
- `created_at` TIMESTAMPTZ, NOT NULL, default `now()`.

### `gdacs_alerts`

Written by `src/jobs/gdacs.ts` (`pollGdacs`), which inserts only alerts it has not seen before.

Read by `src/routes/alerts.ts` (`GET /alerts`), newest first.

- `id` TEXT, primary key. The `guid` of the feed item, so an alert is stored once.
- `event_type` TEXT, NOT NULL.
- `severity` TEXT, NOT NULL. Either `orange` or `red`.
- `title` TEXT, NOT NULL.
- `location` TEXT, nullable.
- `country` TEXT, nullable.
- `url` TEXT, nullable.
- `description` TEXT, nullable.
- `published_at` TIMESTAMPTZ, nullable. Used for ordering.
- `raw` JSONB, NOT NULL, default `{}`.
- `fetched_at` TIMESTAMPTZ, NOT NULL, default `now()`.

## Webhooks

### `webhook_subscriptions`

Written by `src/routes/webhooks.ts`. `POST` inserts a row, and `DELETE` removes it, which also removes its deliveries.

Read by `src/routes/webhooks.ts` (the list for a campaign), `src/webhooks/deliveries.ts` (to queue a delivery for each subscriber) and `src/webhooks/dispatcher.ts` (to find the URL to call).

- `id` UUID, primary key.
- `campaign_id` BIGINT, NOT NULL, references `campaigns(id)`, deleted with the campaign.
- `url` TEXT, NOT NULL. The URL to call.
- `created_at` TIMESTAMPTZ, NOT NULL, default `now()`.

A campaign and a URL pair is unique.

### `webhook_deliveries`

Written by `src/webhooks/deliveries.ts` (`enqueueReleaseWebhook`), which runs inside the indexer's transaction for a `milestone_released` event. The dispatcher then updates `attempts`, `status`, `next_attempt_at` and `last_error`.

Read by `src/webhooks/dispatcher.ts` (for pending deliveries that are due) and `src/routes/webhooks.ts` (`GET /webhooks/:id/deliveries`).

- `id` UUID, primary key.
- `subscription_id` UUID, NOT NULL, references `webhook_subscriptions(id)`, deleted with it.
- `event_id` TEXT, NOT NULL. The chain event that caused the delivery.
- `campaign_id` BIGINT, NOT NULL.
- `payload` JSONB, NOT NULL. The body that is sent.
- `attempts` INTEGER, NOT NULL, default 0.
- `status` TEXT, NOT NULL, default `pending`. One of `pending`, `delivered` or `failed`.
- `next_attempt_at` TIMESTAMPTZ, NOT NULL, default `now()`.
- `last_error` TEXT, nullable.
- `created_at` TIMESTAMPTZ, NOT NULL, default `now()`.

Each subscription gets at most one delivery per chain event.
