<p align="center">
  <img src="https://raw.githubusercontent.com/aidline-org/aidline-frontend/main/public/brand/aidline-wordmark.png" alt="Aidline" width="420">
</p>

# Aidline Backend

**Live demo:** [aidline-frontend.vercel.app](https://aidline-frontend.vercel.app) · **API:** [aidline-api.onrender.com](https://aidline-api.onrender.com/stats) · Stellar testnet

API and Soroban event indexer for **Aidline**, where diaspora communities fund disaster relief and climate work back home, with proof it landed. Built on Stellar.

The [Aidline contract](https://github.com/aidline-org/aidline-contracts) holds donations in escrow and releases them milestone by milestone after a verifier confirms the work. This service makes that on chain activity easy to use:

- **Indexer:** follows contract events on Soroban RPC and mirrors campaigns, donations, milestone releases, refunds and verifiers into Postgres.
- **Metadata:** stores campaign stories (title, description, location, image) and returns a URI that gets written on chain.
- **Proofs:** verifiers upload photos, receipts and reports before approving a milestone. The proof URI is emitted on chain, so every payout links to its evidence.
- **API:** campaign listings, campaign detail with a milestone timeline, donor history, verifier directory and platform stats for the [frontend](https://github.com/aidline-org/aidline-frontend).

The contract is always the source of truth. The backend never moves funds and only stores what the chain cannot hold cheaply.

## Quick start

Requires Node.js 20 or newer. No Docker or system Postgres needed.

```sh
git clone https://github.com/aidline-org/aidline-backend
cd aidline-backend
npm install
cp .env.example .env        # points at the shared testnet deployment by default

npm run dev:db              # terminal 1: starts a local Postgres on port 5433
npm run dev                 # terminal 2: runs migrations, the API and the indexer
```

Open http://localhost:4000/stats. Within a few seconds the indexer catches up with the testnet contract and campaigns appear at http://localhost:4000/campaigns.

## Configuration

All settings come from environment variables. See [`.env.example`](.env.example) for the full list.

| Variable               | Default                 | Purpose                                                |
| ---------------------- | ----------------------- | ------------------------------------------------------ |
| `DATABASE_URL`         | local dev Postgres      | Postgres connection string                             |
| `PUBLIC_BASE_URL`      | `http://localhost:4000` | Used to build metadata and proof URIs stored on chain  |
| `CORS_ORIGINS`         | `http://localhost:3000` | Comma separated frontend origins                       |
| `AIDLINE_NETWORK`      | `testnet`               | `testnet`, `mainnet` or `futurenet`                    |
| `AIDLINE_RPC_URL`      | SDF testnet RPC         | Soroban RPC endpoint                                   |
| `AIDLINE_CONTRACT_ID`  |                         | Contract to index. Indexer is off when empty           |
| `AIDLINE_TOKEN_ID`     |                         | Token the contract raises in, shared with the frontend |
| `INDEXER_START_LEDGER` | latest minus 1000       | Where to start on a fresh database                     |
| `INDEXER_POLL_MS`      | `5000`                  | Poll interval                                          |
| `UPLOAD_DIR`           | `uploads`               | Where proof files are stored                           |

Variables are prefixed with `AIDLINE_` on purpose: the Stellar CLI reads `STELLAR_*` variables from `.env`, and sharing names would make CLI commands run from this folder fail.

## Testnet deployment

|          |                                                                                                                             |
| -------- | --------------------------------------------------------------------------------------------------------------------------- |
| Contract | `CALNXTTPKPTCCWSTN3NHQNZHPXM2IXQZQMFBCCK7LI3N5FRB6DB5NLHK`                                                                  |
| Token    | Native XLM (`CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`)                                                     |
| Explorer | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CALNXTTPKPTCCWSTN3NHQNZHPXM2IXQZQMFBCCK7LI3N5FRB6DB5NLHK) |

## Demo data

`npm run seed:demo` fills a fresh deployment with six clearly labelled demo campaigns raised by diaspora communities for work back home (emergency and climate, open, completed and cancelled), three fictional verifiers and a few donors. It needs the contract admin key:

```sh
SEED_ADMIN_SECRET=S... npm run seed:demo
```

Generated account keys are saved to `.seed-accounts.json`, which is gitignored. Import a verifier or donor key into Freighter to try those roles in the app.

## Scripts

| Command                       | What it does                           |
| ----------------------------- | -------------------------------------- |
| `npm run dev`                 | API and indexer with reload on change  |
| `npm run dev:db`              | Local Postgres in `.pgdata/`           |
| `npm run migrate`             | Apply database migrations              |
| `npm test`                    | Run tests against a throwaway Postgres |
| `npm run lint`                | ESLint                                 |
| `npm run typecheck`           | TypeScript without emitting            |
| `npm run build` / `npm start` | Production build and run               |

## Deploying

[`render.yaml`](render.yaml) describes the API and a Postgres database for [Render](https://render.com). Create a new Blueprint from this repo and fill in `PUBLIC_BASE_URL` (the service URL), `CORS_ORIGINS` (the frontend URL), `AIDLINE_CONTRACT_ID` and `INDEXER_START_LEDGER`. The `Dockerfile` works on any container host.

Proof uploads are stored on local disk, which is not persistent on most free hosts. Moving them to object storage is tracked as an open issue.

## Documentation

- [API reference](docs/API.md)
- [Architecture](docs/ARCHITECTURE.md): how the indexer stays consistent, data model, design decisions
- [Contributing](CONTRIBUTING.md)

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md).

Browse open work by complexity in [ISSUES.md](ISSUES.md), including good first issues for newcomers.

## Related repos

| Repo                                                                  |                         |
| --------------------------------------------------------------------- | ----------------------- |
| [aidline-contracts](https://github.com/aidline-org/aidline-contracts) | Soroban escrow contract |
| [aidline-backend](https://github.com/aidline-org/aidline-backend)     | This repo               |
| [aidline-frontend](https://github.com/aidline-org/aidline-frontend)   | Web app                 |

## License

[MIT](LICENSE)
