import { Keypair, rpc } from '@stellar/stellar-sdk';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { Indexer } from './indexer/indexer.js';
import { startTtlKeeperScheduler } from './indexer/keeper.js';
import { startDailySnapshotScheduler } from './indexer/stats.js';
import { startGdacsScheduler } from './jobs/gdacs.js';
import { AidlineContract } from './stellar/contract.js';
import { startWebhookDispatcher } from './webhooks/dispatcher.js';

const config = loadConfig();

// #15: retry the database connection at boot with exponential back-off
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
      console.warn(
        `[boot] DB not ready (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms…`,
      );
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
let keeperTimer: NodeJS.Timeout | null = null;
if (config.INDEXER_ENABLED && config.AIDLINE_CONTRACT_ID) {
  const server = new rpc.Server(config.AIDLINE_RPC_URL, {
    allowHttp: config.AIDLINE_RPC_URL.startsWith('http://'),
  });

  // #22: the keeper uses a separate funded key and a signed transaction.
  // It is only started when the indexer is on, because it relies on the
  // indexed ledger to decide which campaigns are close to expiry.
  if (config.AIDLINE_KEEPER_SECRET) {
    try {
      const keeper = Keypair.fromSecret(config.AIDLINE_KEEPER_SECRET);
      const extender = new AidlineContract(
        server,
        config.AIDLINE_CONTRACT_ID,
        config.networkPassphrase,
        keeper,
      );
      keeperTimer = startTtlKeeperScheduler(db, extender, app.log.child({ module: 'keeper' }), {
        intervalMs: config.KEEPER_INTERVAL_MS,
        campaignTtlLedgers: config.CAMPAIGN_TTL_LEDGERS,
        thresholdLedgers: config.KEEPER_TTL_THRESHOLD_LEDGERS,
      });
    } catch (err) {
      app.log.error({ err }, 'keeper disabled: AIDLINE_KEEPER_SECRET is not a valid secret key');
    }
  } else {
    app.log.warn('keeper disabled: set AIDLINE_KEEPER_SECRET to extend campaign TTLs');
  }

  indexer = new Indexer({
    db,
    source: server,
    contract: new AidlineContract(server, config.AIDLINE_CONTRACT_ID, config.networkPassphrase),
    contractId: config.AIDLINE_CONTRACT_ID,
    startLedger: config.INDEXER_START_LEDGER,
    pollMs: config.INDEXER_POLL_MS,
    log: app.log.child({ module: 'indexer' }),
    cache: app.cache,
  });
  indexer.start();
} else {
  app.log.warn('indexer disabled: set AIDLINE_CONTRACT_ID to index contract events');
}

const statsTimer = startDailySnapshotScheduler(db, app.log.child({ module: 'stats' }));

// Independent jobs: each one catches its own failures so neither the API nor
// the chain indexer is affected when a feed or a webhook receiver misbehaves.
const gdacsTimer = config.GDACS_ENABLED
  ? startGdacsScheduler(
      db,
      config.GDACS_FEED_URL,
      config.GDACS_POLL_MS,
      app.log.child({ module: 'gdacs' }),
    )
  : null;
const webhookTimer = startWebhookDispatcher(
  db,
  app.log.child({ module: 'webhooks' }),
  config.WEBHOOK_MAX_ATTEMPTS,
  config.WEBHOOK_POLL_MS,
);

const shutdown = async () => {
  indexer?.stop();
  if (keeperTimer) clearInterval(keeperTimer);
  clearInterval(statsTimer);
  if (gdacsTimer) clearInterval(gdacsTimer);
  clearInterval(webhookTimer);
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
