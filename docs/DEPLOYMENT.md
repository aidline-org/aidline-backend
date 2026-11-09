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

## Health and monitoring

| Endpoint  | Use                                                                               |
| --------- | --------------------------------------------------------------------------------- |
| `/health` | Liveness check for the host. Also reports how far the indexer is behind the chain |
| `/stats`  | Platform totals. A quick way to confirm the indexer is writing                    |

Watch the process logs for indexer errors. A failed page is retried on the next tick, so brief RPC outages heal themselves.

## Proof file storage

Proof uploads are written to `UPLOAD_DIR` on local disk. Most free hosts wipe local disk on every deploy, so uploaded proofs can disappear. Until proofs move to object storage (tracked as an open issue), either attach a persistent disk or pin the proof files elsewhere and use that URI on chain.

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
