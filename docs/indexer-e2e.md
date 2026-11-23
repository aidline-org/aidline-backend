# Indexer end-to-end test

The indexer E2E test runs against a local Soroban RPC instead of mocking event
responses. Start the local network and deploy the Aidline contract, then run:

```sh
DATABASE_URL=postgres://aidline:aidline@localhost:5433/aidline \
AIDLINE_RPC_URL=http://localhost:8000 \
AIDLINE_CONTRACT_ID=<local-contract-id> \
AIDLINE_E2E=1 npm run test:e2e:indexer
```

The test creates a campaign on the local network, waits for the indexer to
observe its `created` event, and asserts that the API returns the same campaign
and ledger. It then cancels the campaign and verifies the cancellation ledger,
transaction hash, and timestamp are persisted. This catches RPC filter,
cursor, event-decoding, and database-migration regressions together.
