# Deployment

This guide covers running the Aidline backend outside your laptop. The backend is one Node.js process that serves the REST API and runs the Soroban event indexer. It needs a Postgres database and nothing else.

## What you need

- A Postgres 14 or newer database
- A deployed [Aidline contract](https://github.com/aidline-org/aidline-contracts) and its token contract id
- A host that can run Node.js 20 or newer, or any container host

## Option 1: Render (what the demo uses)

[`render.yaml`](../render.yaml) describes the API and a Postgres database.

1. In Render, create a new **Blueprint** from this repo.
2. Fill in the variables marked `sync: false`:
   - `PUBLIC_BASE_URL`: the URL Render gives the service, for example `https://aidline-api.onrender.com`
   - `CORS_ORIGINS`: the frontend URL, for example `https://aidline-frontend.vercel.app`
   - `AIDLINE_CONTRACT_ID`: the contract to index
   - `INDEXER_START_LEDGER`: the ledger the contract was deployed at
3. Deploy. Render runs `npm ci && npm run build`, then `npm start`.
4. Check `https://<your-service>/health` and `https://<your-service>/stats`.

Migrations run automatically on startup, so there is no separate migration step.

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

| Symptom                               | Likely cause                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `/campaigns` is empty                 | `AIDLINE_CONTRACT_ID` is empty, so the indexer is off, or the start ledger is after the first event |
| Browser shows a CORS error            | The frontend origin is missing from `CORS_ORIGINS`                                                  |
| Proof links return 404 after redeploy | Local disk was wiped. See "Proof file storage"                                                      |
| Server exits at startup               | An environment variable failed validation. The error names the variable                             |
