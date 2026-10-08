import { rpc } from '@stellar/stellar-sdk';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { Indexer } from './indexer/indexer.js';
import { startDailySnapshotScheduler } from './indexer/stats.js';
import { AidlineContract } from './stellar/contract.js';

const config = loadConfig();

// #15 – retry the database connection at boot with exponential back-off
async function connectWithRetry(url: string, maxAttempts = 10, baseMs = 1000) {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      const pool = createPool(url);
      // Probe the connection
      await pool.query('SELECT 1');
      return pool;
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      const delay = Math.min(baseMs * 2 ** (attempt - 1), 30_000);
      console.warn(`[boot] DB not ready (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms…`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

const db = await connectWithRetry(config.DATABASE_URL);
await migrate(db);

const app = await buildApp(config, db, {
  logger: process.stdout.isTTY ? { transport: { target: 'pino-pretty' } } : true,
});

let indexer: Indexer | null = null;
if (config.INDEXER_ENABLED && config.AIDLINE_CONTRACT_ID) {
  const server = new rpc.Server(config.AIDLINE_RPC_URL, {
    allowHttp: config.AIDLINE_RPC_URL.startsWith('http://'),
  });
  indexer = new Indexer({
    db,
    source: server,
    contract: new AidlineContract(server, config.AIDLINE_CONTRACT_ID, config.networkPassphrase),
    contractId: config.AIDLINE_CONTRACT_ID,
    startLedger: config.INDEXER_START_LEDGER,
    pollMs: config.INDEXER_POLL_MS,
    log: app.log.child({ module: 'indexer' }),
  });
  indexer.start();
} else {
  app.log.warn('indexer disabled: set AIDLINE_CONTRACT_ID to index contract events');
}

const statsTimer = startDailySnapshotScheduler(db, app.log.child({ module: 'stats' }));

const shutdown = async () => {
  indexer?.stop();
  clearInterval(statsTimer);
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
