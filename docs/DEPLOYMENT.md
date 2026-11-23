# Deployment

This guide covers running the Aidline backend outside your laptop. The backend is one Node.js process that serves the REST API and runs the Soroban event indexer. It needs a Postgres database and nothing else.

## What you need

- A Postgres 14 or newer database
- A deployed [Aidline contract](https://github.com/aidline-org/aidline-contracts) and its token contract id
- A host that can run Node.js 20 or newer, or any container host

## Option 1: Render (what the demo uses)

[`render.yaml`](../render.yaml) describes the API service. The database lives outside Render: Render's free Postgres expires after 30 days, and when it did the API could not start. The demo uses a free [Neon](https://neon.tech) database instead; any Postgres 14 or newer works.

1. Create the database and copy its connection string. For Neon, use the string from **Connect**, keep `?sslmode=require` at the end and drop `&channel_binding=require` if present.
2. In Render, create a new **Blueprint** from this repo.
3. Fill in the variables marked `sync: false`:
   - `DATABASE_URL`: the connection string from step 1
   - `PUBLIC_BASE_URL`: the URL Render gives the service, for example `https://aidline-api.onrender.com`
   - `CORS_ORIGINS`: the frontend URL, for example `https://aidline-frontend.vercel.app`
   - `AIDLINE_CONTRACT_ID`: the contract to index
   - `INDEXER_START_LEDGER`: the ledger the contract was deployed at. Leave it empty if that ledger is older than the RPC's retention window (about a week on testnet); the indexer then starts from recent ledgers
4. Deploy. Render runs `npm ci && npm run build`, then `npm start`.
5. Check `https://<your-service>/health` and `https://<your-service>/stats`.

Migrations run automatically on startup, so there is no separate migration step.

The free Render web service sleeps after about 15 minutes without traffic, and the first request after that takes about a minute. A scheduled ping to `/health` every 10 minutes (for example from cron-job.org) keeps it awake.

### Starting over with an empty database

Campaign titles, stories and proof notes are stored in Postgres, and testnet RPC only keeps about a week of contract events, so a new database cannot rebuild older campaigns. To give the demo content again, run the seeding script once with the contract admin key:

```sh
SEED_ADMIN_SECRET=$(stellar keys show <admin key name>) \
SEED_API_URL=https://<your-service> \
npm run seed:demo
```

It creates clearly labelled demo campaigns on testnet and writes the generated demo account keys to `.seed-accounts.json`, which is gitignored. Run it once; a second run creates a second set of campaigns.

## Option 2: Docker

```sh
docker build -t aidline-backend .
docker run -p 4000:4000 \
  -e DATABASE_URL=postgres://user:pass@host:5432/aidline \
  -e PUBLIC_BASE_URL=https://api.example.org \
  -e CORS_ORIGINS=https://app.example.org \
  -e AIDLINE_CONTRACT_ID=C... \
  -e AIDLINE_TOKEN_ID=C... \
  aidline-backend
```

The same image works on Fly.io, Railway, ECS, Cloud Run and similar hosts. Use [`docker-compose.yml`](../docker-compose.yml) for a local API plus Postgres.

## Choosing `INDEXER_START_LEDGER`

On a fresh database the indexer starts at `INDEXER_START_LEDGER`. Set it to the ledger of the contract deployment so it does not miss early events. Soroban RPC only keeps a limited window of history, so the indexer clamps the value to the oldest ledger the RPC still has. If you leave it empty the indexer starts about 1000 ledgers back from the latest.

## Stats history backfill

Daily stats snapshots are captured once per UTC day. If the database is recreated or snapshotting starts late, rebuild missing days from event history:

```sh
npm run stats:backfill
```

The command inserts only missing `daily_stats_snapshots` rows from the first event day through yesterday (UTC). It does not modify existing rows. Totals for donations, releases, refunds, donors, campaigns and milestones are rebuilt from event/history tables. `active_campaigns` is approximated for past days from campaign creation/deadline and current non-cancelled status because status history is not stored as a daily timeline. `verifiers` uses the current active verifier count because verifier history is not event-sourced by day.

## Health and monitoring

| Endpoint  | Use                                                                               |
| --------- | --------------------------------------------------------------------------------- |
| `/health` | Liveness check for the host. Also reports how far the indexer is behind the chain |
| `/stats`  | Platform totals. A quick way to confirm the indexer is writing                    |

Watch the process logs for indexer errors. A failed page is retried on the next tick, so brief RPC outages heal themselves.

## Rebuilding a database

If the Postgres database is lost or `indexer_state` must be reset, run `npm run reindex` with the same `.env` used by the service. The command reads `campaign_count` and every `get_campaign` value from the contract, upserts current campaign state safely, clears the cursor, and exits. The normal indexer then resumes from the oldest ledger retained by the RPC. History events older than the RPC retention window cannot be reconstructed; current campaign totals remain authoritative because they come from contract state.

For step-by-step diagnosis of lag, a stalled indexer, gap recovery, RPC outages, a lost database or a contract redeploy, see the [indexer runbook](RUNBOOK.md).

## Proof file storage

Proof uploads are written to `UPLOAD_DIR` on the instance's local disk (`uploads/proofs/<proof id>/<file>` by default), and Postgres stores only the URIs that point at them. On the free Render plan that disk is **ephemeral**: every deploy starts from a fresh container, so files uploaded before the deploy are gone while the `proofs` row and the on-chain URI are still there. Requests for those file URLs then return 404. Losing the files does not lose the database records, and it does not affect the audit trail on chain, but the evidence itself is no longer viewable.

This limitation is specific to hosts with a disposable filesystem. On a host with a persistent volume the files survive redeploys.

### Checking whether proof files still exist

The database is the source of truth for which files _should_ exist: each proof's `files` JSONB column holds the public URLs that were returned when it was uploaded. List them with `psql`:

```sh
psql "$DATABASE_URL" -c "SELECT id, created_at, files FROM proofs ORDER BY created_at DESC;"
```

Each element of `files` looks like `{ "name": "receipt.pdf", "type": "application/pdf", "url": "https://api.example.org/uploads/proofs/<id>/0.pdf" }`. Request those URLs to see which files survived a redeploy:

```sh
curl -sS -o /dev/null -w '%{http_code} %{url_effective}\n' '<one of the files[].url values>'
```

A `200` means the file is present; a `404` means the local disk was wiped. You can get to the same data through the API: `GET /campaigns/:id` includes each milestone's `proofUri`, and `GET /proofs/:id` returns the current `files` array. A spot check of one or two proofs after each deploy is usually enough to notice the problem before users do.

### Options

Until proof files move to object storage (tracked as open issue #5), choose one of these:

1. **Attach a persistent disk** to the service and point `UPLOAD_DIR` at a directory on it. On Render, add a persistent disk in the service settings, mount it (for example at `/data`) and set `UPLOAD_DIR=/data/uploads`. A persistent disk survives redeploys, but it is not a backup, so snapshot it as well. This is the quickest fix and needs no code changes.
2. **Use object storage** (S3, Cloudflare R2 or similar) so the URI emitted on chain points at durable, off-instance storage. This is issue #5 and requires a code change; follow it if proofs need to be durable without managing a disk.
3. **Pin the evidence elsewhere** (for example on IPFS) and pass that URI to `approve_milestone` instead of the URI returned by `POST /proofs`. The upload endpoint still writes to local disk, so this only helps for proofs you publish yourself, but it does leave a durable URI on chain.

## Going to mainnet

Do not point this backend at mainnet until the contract has had an external audit. When it has:

1. Set `AIDLINE_NETWORK=mainnet` and a mainnet `AIDLINE_RPC_URL`.
2. Set `AIDLINE_CONTRACT_ID` and `AIDLINE_TOKEN_ID` to the mainnet deployment.
3. Use a fresh database. Do not reuse a testnet database.
4. Put the API behind HTTPS and set `CORS_ORIGINS` to the production frontend only.

## Troubleshooting

| Symptom                                    | Likely cause                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `/campaigns` is empty                      | `AIDLINE_CONTRACT_ID` is empty, so the indexer is off, or the start ledger is after the first event |
| Browser shows a CORS error                 | The frontend origin is missing from `CORS_ORIGINS`                                                  |
| Proof links return 404 after redeploy      | Local disk was wiped. See "Proof file storage"                                                      |
| Server exits at startup                    | An environment variable failed validation. The error names the variable                             |
| Requests hang and logs show `DB not ready` | The database is unreachable, suspended or deleted. The server waits for it before listening         |
