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

## Platform

### `GET /openapi.json`

Returns the OpenAPI 3.0 specification document describing every route in the API. Useful for generating client SDKs or importing into tools like Insomnia or Postman.

### `GET /docs`

Renders an interactive Swagger UI reference for the API. Navigate here in a browser to explore and try out every endpoint without any extra tooling.

### `GET /health`

```json
{ "ok": true, "indexedLedger": 4993748, "latestLedger": 4993760, "lagLedgers": 12 }
```

`latestLedger` is the most recent ledger seen from the network on the last sync. `lagLedgers` is the difference between `latestLedger` and `indexedLedger`. Both are `null` before the first sync completes.

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

**Authentication**: none — follows the same open access model as all other read endpoints.

**Errors**

| Status | body `error`       | Condition                          |
| ------ | ------------------ | ---------------------------------- |
| 404    | `not_found`        | Campaign id does not exist         |
| 400    | `validation_error` | Campaign id is not a valid integer |

## Releases

### `GET /releases`

Recent milestone payouts across all campaigns, newest first. Each item has `campaignId`, `campaignTitle`, `location`, `kind`, `index`, `amount`, `releasedAt`, `txHash`, `verifier`, `verifierName`, `proofUri` and `proof`. Paginated with `limit` and `offset`.

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

### `GET /metadata/:id`

## Proofs

### `POST /proofs`

`multipart/form-data` with fields `campaignId`, `milestoneIndex`, `note` (10 to 2000 chars) and up to 5 `files` (JPEG, PNG, WebP or PDF, 5 MB each).

Returns `201 { "id", "uri", "files" }`. Pass `uri` as `proof_uri` to `approve_milestone`.

### `GET /proofs/:id`

## Verifiers

### `GET /verifiers`

Verifiers that are active on chain, with their profile when one exists.

### `GET /verifiers/:address`

Profile and on chain status for one address.

### `POST /verifiers/applications`

`{ address, orgName, website?, country, description }`. Stores a profile. The admin still has to call `add_verifier` on chain before the address shows up as active.

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

## Files

`GET /uploads/proofs/<proof id>/<file>` serves uploaded proof files.
