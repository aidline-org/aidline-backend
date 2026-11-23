import { pathToFileURL } from 'node:url';

import { Keypair, rpc } from '@stellar/stellar-sdk';

import { buildApp } from './app.js';
import { contractIds, loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool, type Db } from './db/pool.js';
import { Indexer } from './indexer/indexer.js';
import { startTtlKeeperScheduler } from './indexer/keeper.js';
import { startDailySnapshotScheduler } from './indexer/stats.js';
import { startGdacsScheduler } from './jobs/gdacs.js';
import { AidlineContract } from './stellar/contract.js';
import { startWebhookDispatcher } from './webhooks/dispatcher.js';

const config = loadConfig();

export interface ConnectWithRetryOptions {
  maxAttempts?: number;
  baseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  createPool?: (url: string) => Db;
}

export async function connectWithRetry(
  url: string,
  { maxAttempts = 10, baseMs = 1000, sleep, createPool: create = createPool }: ConnectWithRetryOptions = {},
): Promise<Db> {
  const wait = sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let attempt = 0;
  while (true) {
    attempt += 1;
    const pool = create(url);
    try {
      await pool.query('SELECT 1');
      return pool;
    } catch (err) {
      await pool.end().catch(() => {});
      if (attempt >= maxAttempts) throw err;
      const delay = Math.min(baseMs * 2 ** (attempt - 1), 30_000);
      console.warn(`[boot] DB not ready (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms…`);
      await wait(delay);
    }
  }
}

async function main() {
  const db = await connectWithRetry(config.DATABASE_URL, {
    createPool: (url) => createPool(url, { statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS }),
  });
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

  indexer = new Indexer({
    db,
    source: server,
    contract: new AidlineContract(server, config.AIDLINE_CONTRACT_ID, config.networkPassphrase),
    contractId: config.AIDLINE_CONTRACT_ID,
    contractIds: contractIds(config),
    startLedger: config.INDEXER_START_LEDGER,
    pollMs: config.INDEXER_POLL_MS,
    log: app.log.child({ module: 'indexer' }),
    cache: app.cache,
    onCommit: (events) => app.streams.publish(events),
  });
  indexer.start();
} else {
  app.log.warn('indexer disabled: set AIDLINE_CONTRACT_ID to index contract events');
}

  const gdacsTimer = config.GDACS_ENABLED
    ? startGdacsScheduler(db, config.GDACS_FEED_URL, config.GDACS_POLL_MS, app.log.child({ module: 'gdacs' }))
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
