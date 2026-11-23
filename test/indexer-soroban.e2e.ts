/**
 * Local Soroban indexer smoke test. It is intentionally opt-in because it
 * needs a running RPC, Postgres, deployed contract, and funded test account.
 */
import { rpc } from '@stellar/stellar-sdk';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
if (process.env.AIDLINE_E2E !== '1') {
  console.log('AIDLINE_E2E is not 1; skipping local Soroban indexer E2E test');
  process.exit(0);
}
if (!config.AIDLINE_CONTRACT_ID) throw new Error('AIDLINE_CONTRACT_ID is required');

const server = new rpc.Server(config.AIDLINE_RPC_URL, {
  allowHttp: config.AIDLINE_RPC_URL.startsWith('http://'),
});
const health = await server.getLatestLedger();
if (!health.sequence) throw new Error('local Soroban RPC returned no latest ledger');
console.log(
  `local Soroban RPC is ready at ledger ${health.sequence}; run the API/indexer stack to complete the event assertions`,
);
