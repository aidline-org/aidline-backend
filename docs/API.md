# API reference

Base URL in development: `http://localhost:4000`

Token amounts are returned as **strings** in the token's smallest unit (stroops for XLM, 7 decimals), because they can exceed what a JavaScript number holds safely. Timestamps are ISO 8601.

Errors share one shape:

```json
{
  "error": "validation_error",
  "message": "Request is invalid",
  "issues": [{ "path": "title", "message": "..." }]
}
```

If a request fails, see [Troubleshooting](#troubleshooting) for a code-by-code explanation of the cause and how to fix the request.

## Platform

### `GET /openapi.json`

Returns the OpenAPI 3.0 specification document describing every route in the API. Useful for generating client SDKs or importing into tools like Insomnia or Postman.

### `GET /docs`

Renders an interactive Swagger UI reference for the API. Navigate here in a browser to explore and try out every endpoint without any extra tooling.

### `GET /health`

Legacy combined status, kept for compatibility with existing monitors.

```json
{ "ok": true, "indexedLedger": 4993748, "latestLedger": 4993760, "lagLedgers": 12 }
```

`latestLedger` is the most recent ledger seen from the network on the last sync. `lagLedgers` is the difference between `latestLedger` and `indexedLedger`. Both are `null` before the first sync completes.

### `GET /live`

Liveness probe: `200 { "ok": true }` while the process is running. It does not touch the database, so a database outage does not restart a healthy process.

### `GET /ready`

Readiness probe for load balancers and orchestrators.

```json
{ "ready": true, "checks": { "database": "ok", "indexer": "ok" } }
```

Returns `503` when the database cannot be reached (`checks.database` is `unavailable`) or when the indexer is enabled but has not written in the last 60 seconds (`checks.indexer` is `not_synced`, `stale` or `unavailable`). When the indexer is disabled (`INDEXER_ENABLED=false` or no `AIDLINE_CONTRACT_ID`), only the database is checked.

### `GET /metrics`

Prometheus text format, for scraping by Prometheus, Grafana Agent or any compatible tool. Set `METRICS_ENABLED=false` to turn it off. It is not part of the OpenAPI spec.

| Metric                                  | Type      | Labels                      | Meaning                                                                                           |
| --------------------------------------- | --------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `aidline_http_requests_total`           | counter   | `method`, `route`, `status` | Requests handled. `route` is the pattern, such as `/campaigns/:id`; unknown paths are `unmatched` |
| `aidline_http_request_duration_seconds` | histogram | `method`, `route`           | Request duration                                                                                  |
| `aidline_indexed_ledger`                | gauge     |                             | Last ledger the indexer processed                                                                 |
| `aidline_latest_ledger`                 | gauge     |                             | Latest ledger seen from the network                                                               |
| `aidline_indexer_lag_ledgers`           | gauge     |                             | Ledgers between the network tip and the indexer. `0` means caught up                              |

Default Node.js process metrics (`process_*`, `nodejs_*`) are included. Scrapes of `/metrics` itself are not counted. The indexer gauges are absent until the first sync completes.

`/metrics` is unauthenticated and exposes operational data. In production, restrict it at your proxy or network layer.

### `GET /config`

Network details the frontend needs: `network`, `networkPassphrase`, `rpcUrl`, `contractId`, `tokenId`.

### `GET /stats`

```json
{
  "campaigns": 4,
  "activeCampaigns": 3,
  "totalDonated": "52000000000",
  "totalReleased": "18000000000",
  "totalRefunded": "0",
  "donors": 11,
  "verifiers": 2,
  "milestonesVerified": 5
}
```

Money held in escrow is `totalDonated - totalReleased - totalRefunded`.

Responses are cached in memory for 10 seconds and carry `Cache-Control: public, max-age=10`. The `X-Cache` header is `MISS` on a fresh response and `HIT` when served from the cache. Indexer writes invalidate the cache immediately.

### `GET /stats/history`

Returns a time series of daily platform statistics snapshots for charting.

```json
{
  "items": [
    {
      "snapshotDate": "2026-10-08",
      "campaigns": 4,
      "activeCampaigns": 3,
      "totalDonated": "52000000000",
      "totalReleased": "18000000000",
      "totalRefunded": "0",
      "donors": 11,
      "verifiers": 2,
      "milestonesVerified": 5
    }
  ]
}
```

Snapshots are taken once per UTC day. `snapshotDate` is the UTC date of the snapshot (YYYY-MM-DD). Results are ordered chronologically, oldest first. Metrics have the exact same definitions as the `/stats` endpoint.

## Campaigns

### `GET /campaigns`

Query: `q` (full text search), `kind` (`emergency` | `climate`), `status` (`active` | `completed` | `cancelled` | `expired`), `creator`, `verifier`, `limit` (max 100), `offset`.

When `q` is provided, campaigns are full-text searched across their title, summary, location, and organizer. Results are ranked deterministically by relevance (matches in title rank higher than matches in summary, etc), followed by newest first. When `q` is absent, results are just newest first.

Returns `{ items, total }`. Each item:

```json
{
  "id": "0",
  "kind": "emergency",
  "status": "active",
  "creator": "G...",
  "beneficiary": "G...",
  "verifier": "G...",
  "goal": "2500000000",
  "raised": "1200000000",
  "released": "1000000000",
  "milestones": ["1000000000", "1500000000"],
  "milestonesReleased": 1,
  "deadline": "2026-10-10T01:52:32.000Z",
  "metadataUri": "http://.../metadata/<id>",
  "createdAt": "...",
  "donorCount": 1,
  "metadata": {
    "title": "...",
    "summary": "...",
    "location": "...",
    "category": "flood",
    "imageUrl": null
  }
}
```

`expired` is computed: an active campaign whose deadline has passed. Donors can claim refunds from it.

### `GET /campaigns/:id`

The same fields, plus `metadata.description` and a milestone timeline:

```json
"milestones": [
  {
    "index": 0, "amount": "1000000000", "released": true,
    "releasedAt": "...", "txHash": "4c5d...",
    "proofUri": "http://.../proofs/<id>",
    "proof": { "id": "...", "note": "Delivered 40 water tanks", "files": [{ "name": "...", "type": "image/png", "url": "..." }] }
  },
  { "index": 1, "amount": "1500000000", "released": false, "releasedAt": null, "txHash": null, "proofUri": null, "proof": null }
]
```

### `GET /campaigns/:id/donations`

Paginated `{ items: [{ donor, amount, txHash, createdAt }] }`, newest first.

### `GET /campaigns/:id/refunds`

Returns paginated refunds for a campaign, newest first.

Query: `limit` (max 100, default 20), `offset`.

```json
{
  "items": [
    {
      "donor": "G...",
      "amount": "500000000",
      "txHash": "abc123...",
      "createdAt": "2026-10-01T12:00:00.000Z"
    }
  ]
}
```

| Status | body `error`       | Condition                          |
| ------ | ------------------ | ---------------------------------- |
| 404    | `not_found`        | Campaign id does not exist         |
| 400    | `validation_error` | Campaign id is not a valid integer |

### `GET /campaigns/:id/export.csv`

Returns a CSV file containing the complete financial activity for a campaign: donations, milestone releases, and refunds.

**Response headers**

| Header                | Value                                      |
| --------------------- | ------------------------------------------ |
| `Content-Type`        | `text/csv; charset=utf-8`                  |
| `Content-Disposition` | `attachment; filename="campaign-<id>.csv"` |

**CSV columns** (always in this order)

| Column           | Description                                                                             |
| ---------------- | --------------------------------------------------------------------------------------- |
| `type`           | `donation`, `release`, or `refund`                                                      |
| `createdAt`      | ISO 8601 timestamp from the on-chain ledger close time                                  |
| `campaignId`     | Numeric campaign identifier                                                             |
| `actor`          | Stellar address of the donor (donations and refunds); empty for releases                |
| `amount`         | Exact integer string in the token's smallest unit (stroops, 7 decimals). Never rounded. |
| `milestoneIndex` | Zero-based milestone index (releases only); empty for donations and refunds             |
| `txHash`         | Transaction hash on the Stellar network                                                 |
| `eventId`        | Soroban RPC event identifier (primary key of the history tables)                        |

**Ordering**: chronological by `createdAt` ascending, with `eventId` as the deterministic tie-breaker.

**Amounts**: stored as `NUMERIC(39,0)` and returned as exact integer strings. They never pass through a JavaScript number, so large i128 token values are preserved without rounding or scientific notation.

**Authentication**: none, follows the same open access model as all other read endpoints.

**Errors**

| Status | body `error`       | Condition                          |
| ------ | ------------------ | ---------------------------------- |
| 404    | `not_found`        | Campaign id does not exist         |
| 400    | `validation_error` | Campaign id is not a valid integer |

## Releases

### `GET /releases`

Recent milestone payouts across all campaigns, newest first. Each item has `campaignId`, `campaignTitle`, `location`, `kind`, `index`, `amount`, `releasedAt`, `txHash`, `verifier`, `verifierName`, `proofUri` and `proof`. Paginated with `limit` and `offset`.

Cached in memory for 10 seconds per `limit`/`offset` pair, with the same `Cache-Control` and `X-Cache` headers as `/stats`. Indexer writes invalidate the cache immediately.

## Metadata

### `POST /metadata`

Create the story for a campaign before calling `create_campaign` on chain.

| Field         | Rules                    |
| ------------- | ------------------------ |
| `title`       | 5 to 120 chars           |
| `summary`     | 10 to 280 chars          |
| `description` | 20 to 10,000 chars       |
| `location`    | 2 to 120 chars           |
| `category`    | optional, up to 60 chars |
| `imageUrl`    | optional URL             |

Returns `201 { "id": "<uuid>", "uri": "http://.../metadata/<uuid>" }`. Pass `uri` as `metadata_uri` to the contract. Metadata is immutable.

### Wallet signed writes

`POST /metadata` and `POST /proofs` require a SEP-53 style signature from a Stellar address. Sign a message with `Keypair.signMessage` (the SDK hashes `"Stellar Signed Message:\n" + message` with SHA-256 before signing) and send these headers:

| Header                | Value                                                            |
| --------------------- | ---------------------------------------------------------------- |
| `x-stellar-address`   | Signing `G...` address                                           |
| `x-stellar-signature` | Base64 encoded 64-byte signature                                 |
| `x-stellar-timestamp` | Unix milliseconds. Requests older than five minutes are rejected |
| `x-stellar-nonce`     | Random unique value (at least 8 chars), one use per signature    |
| `x-stellar-campaign`  | Campaign id, required for `/proofs` and bound into the message   |

The signed message is exactly:

```
Aidline signed request
purpose: metadata:create
address: <address>
timestamp: <timestamp>
nonce: <nonce>
```

For proofs use `purpose: proof:upload` and an extra final line `campaign: <campaignId>`. `signRequest` in `src/lib/auth.ts` shows the canonical construction; the same function is used in the tests. A captured signature cannot be replayed (nonce) or reused on another route (purpose) or campaign (bound id). The frontend must add message signing to both upload flows.

### `GET /metadata/:id`

## Proofs

### `POST /proofs`

`multipart/form-data` with fields `campaignId`, `milestoneIndex`, `note` (10 to 2000 chars) and up to 5 `files` (JPEG, PNG, WebP or PDF, 5 MB each). Requires the wallet signature headers above, with `x-stellar-campaign` matching `campaignId`; the signer must be the campaign's verifier.

The bytes of each file are checked against its declared type: a file whose contents are not a real JPEG, PNG, WebP or PDF is rejected with `400 { "error": "invalid_file" }`. The stored extension always comes from the detected type, never the uploaded filename.

Returns `201 { "id", "uri", "files" }`. Pass `uri` as `proof_uri` to `approve_milestone`.

| Status | body `error`   | Condition                                           |
| ------ | -------------- | --------------------------------------------------- |
| 401    | `unauthorized` | Missing, expired, invalid or replayed signature     |
| 403    | `forbidden`    | Signer is not the verifier, or campaign id mismatch |
| 404    | `not_found`    | Campaign does not exist                             |

### `GET /proofs/:id`

## Verifiers

### `GET /verifiers`

Verifiers that are active on chain, with their profile when one exists.

### `GET /verifiers/:address`

Profile and on chain status for one address.

### `GET /verifiers/:address/campaigns`

Campaigns where this address is the verifier, newest first. Each item has `id`, `kind`, `status`, `creator`, `goal`, `raised`, `released`, `deadline`, `createdAt`, `milestoneCount`, `milestonesReleased`, `title`, `location` and `organizer`. `milestoneCount` is the total number of milestones and `milestonesReleased` is how many have been paid out, so a verifier's track record is visible without fetching each campaign detail. Amounts are strings. An unknown address returns an empty `items` array.

### `POST /verifiers/applications`

`{ address, orgName, website?, country, description }`. Stores a profile. The admin still has to call `add_verifier` on chain before the address shows up as active.

### `GET /verifiers/applications`

Admin review queue: applications that are not yet active on chain. Requires the wallet signature headers with `purpose: admin:verifier-applications`, signed by the address in `ADMIN_WALLET_ADDRESS`. Paginated with `limit` and `offset`. Returns `{ items, total }`. Without a configured admin address the endpoint returns `403`.

## Donors

### `GET /donors/:address`

```json
{
  "address": "G...",
  "totalDonated": "1200000000",
  "campaignsSupported": 1,
  "donations": [
    {
      "campaignId": "0",
      "campaignTitle": "...",
      "amount": "...",
      "txHash": "...",
      "createdAt": "..."
    }
  ],
  "refunds": []
}
```

## Webhooks

Campaign organisers can subscribe a URL to milestone release notifications. Delivery is enqueued in the indexer's transaction, so one on-chain release produces one delivery per subscriber, even if the event is replayed. A separate worker sends JSON POSTs and retries failures with capped exponential backoff; failures are logged and the last error is kept on the delivery record.

### `POST /campaigns/:id/webhooks`

Body `{ "url": "https://example.org/hook" }`. Returns `201 { id, campaignId, url, createdAt }`. `409 already_subscribed` when the same URL is already registered. Private hosts and embedded credentials are rejected unless `WEBHOOK_ALLOW_PRIVATE_URLS=true`.

### `GET /campaigns/:id/webhooks`

Returns `{ items: [{ id, campaignId, url, createdAt }] }`.

### `DELETE /webhooks/:id`

Unsubscribes and removes pending deliveries. Returns `204`.

### `GET /webhooks/:id/deliveries`

Returns `{ items: [...] }` with `status`, `attempts`, `nextAttemptAt`, `lastError`, `payload` and `createdAt`, for debugging a receiver.

The POST body for a delivery:

```json
{
  "event": "milestone_released",
  "eventId": "0000100-...",
  "campaignId": "0",
  "milestoneIndex": 0,
  "amount": "3000000000",
  "txHash": "abc123...",
  "releasedAt": "2026-11-20T09:00:00.000Z",
  "proof": { "uri": "http://.../proofs/<id>", "note": "...", "files": [] }
}
```

## Files

`GET /uploads/proofs/<proof id>/<file>` serves uploaded proof files.

## Troubleshooting

Every error response has an `error` code and a human-readable `message`. `validation_error` also includes an `issues` array that pinpoints the offending fields. The codes you are most likely to hit as an integrator are below.

| Status | `error` code       | What causes it                                                                                                                                                                                                                                                                                                  | How to fix the request                                                                                                                                                                                                                                                                          |
| ------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `validation_error` | Request validation rejected a path parameter, query string or body. Common causes: a campaign id that is not an integer, `limit` above 100 or below 1, a negative `offset`, an invalid enum value (for example `kind=other`), a malformed Stellar address, or a missing or out-of-range field in a `POST` body. | Read `issues`: each entry has a `path` (the field, dot-separated for nested fields) and a `message` explaining the rule. Correct those fields and resend. For pagination keep `limit` between 1 and 100 and `offset` at 0 or greater. For addresses use a `G...` account id, not a contract id. |
| 404    | `not_found`        | Either the URL path does not match any route (the body message is `Route not found`), or the resource id does not exist (for example a campaign, metadata or proof id that was never created or has not been indexed yet).                                                                                      | Check the path and method against this reference. If the id is meant to exist, confirm it is correct and that the indexer has seen it (`GET /health` reports the indexed ledger). A brand-new campaign may take a ledger or two to appear.                                                      |
| 413    | `request_error`    | An upload to `POST /proofs` exceeded the multipart limits: a file larger than 5 MB or more than 5 files in one request. The `message` names the limit that was hit.                                                                                                                                             | Split the proof into at most 5 files, each 5 MB or smaller, and use JPEG, PNG, WebP or PDF. Compress images before uploading. Do not send the same files twice.                                                                                                                                 |
| 429    | `request_error`    | Rate limit exceeded: the API allows 300 requests per minute per client. The `message` reports when the limit resets, and a `Retry-After` header may be present.                                                                                                                                                 | Slow down and retry after the indicated interval. Cache `/config`, `/stats` and campaign lists instead of polling them rapidly, and back off with jitter rather than retrying immediately.                                                                                                      |

Two other codes can appear but are not request mistakes you can fix by editing the payload:

- `request_error` with any other 4xx status is a generic client error (the `message` explains it), for example a malformed request body that is not valid JSON.
- `internal_error` with status 500 means the server failed. The response message is deliberately generic; the cause is in the server logs. Retry with backoff and include the `X-Request-Id` response header when reporting it.

All responses carry an `X-Request-Id` header. Include it with any bug report so a specific request can be traced in the logs.
