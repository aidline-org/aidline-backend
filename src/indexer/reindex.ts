import { rpc } from '@stellar/stellar-sdk';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { Indexer } from './indexer.js';
import { AidlineContract } from '../stellar/contract.js';

const config = loadConfig();
if (!config.AIDLINE_CONTRACT_ID) throw new Error('AIDLINE_CONTRACT_ID is required for reindexing');
const db = createPool(config.DATABASE_URL, config.DATABASE_POOL_MAX);
await migrate(db);
const server = new rpc.Server(config.AIDLINE_RPC_URL, {
  allowHttp: config.AIDLINE_RPC_URL.startsWith('http://'),
});
const indexer = new Indexer({
  db,
  source: server,
  contract: new AidlineContract(server, config.AIDLINE_CONTRACT_ID, config.networkPassphrase),
  contractId: config.AIDLINE_CONTRACT_ID,
  startLedger: config.INDEXER_START_LEDGER,
  pollMs: config.INDEXER_POLL_MS,
  log: console as never,
});
const count = await indexer.reindex();
console.log(`reindexed ${count} campaigns; event history resumes on the next indexer sync`);
await db.end();
