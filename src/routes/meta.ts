import type { FastifyInstance } from 'fastify';

import { getStatsHistory } from '../indexer/stats.js';
import { setCacheHeaders } from '../lib/cache.js';

/** Consider the indexer stale if it has not written anything in this long. */
const INDEXER_STALE_MS = 60_000;
const STATS_CACHE_KEY = 'stats';

export async function metaRoutes(app: FastifyInstance) {
  // Kept for backwards compatibility with existing monitors.
  // #3: report indexer lag (difference between the chain's latest ledger and the indexed ledger)
  app.get('/health', async () => {
    const { rows } = await app.db.query<{
      last_ledger: number | null;
      latest_ledger: number | null;
    }>('SELECT last_ledger, latest_ledger FROM indexer_state WHERE id = 1');
    const row = rows[0];
    const indexedLedger = row?.last_ledger ?? null;
    const latestLedger = row?.latest_ledger ?? null;
    const lagLedgers =
      indexedLedger !== null && latestLedger !== null ? latestLedger - indexedLedger : null;
    return { ok: true, indexedLedger, latestLedger, lagLedgers };
  });

  /** Liveness: the process is running. Deliberately does not touch the database. */
  app.get('/live', async () => ({ ok: true }));

  /** Readiness: the database is reachable and, when enabled, the indexer is up to date. */
  app.get('/ready', async (_req, reply) => {
    const checks: { database: string; indexer: string } = { database: 'ok', indexer: 'ok' };

    try {
      await app.db.query('SELECT 1');
    } catch {
      checks.database = 'unavailable';
    }

    const indexerEnabled = app.config.INDEXER_ENABLED && Boolean(app.config.AIDLINE_CONTRACT_ID);
    if (checks.database === 'ok' && indexerEnabled) {
      try {
        const { rows } = await app.db.query<{ updated_at: string | Date | null }>(
          'SELECT updated_at FROM indexer_state WHERE id = 1',
        );
        const updatedAt = rows[0]?.updated_at;
        if (!updatedAt) {
          checks.indexer = 'not_synced';
        } else {
          const lastSync = new Date(updatedAt).getTime();
          checks.indexer = Date.now() - lastSync <= INDEXER_STALE_MS ? 'ok' : 'stale';
        }
      } catch {
        checks.indexer = 'unavailable';
      }
    }

    const ready = checks.database === 'ok' && checks.indexer === 'ok';
    if (!ready) reply.code(503);
    return { ready, checks };
  });

  /** Everything a frontend needs to talk to the right contract. */
  app.get('/config', async () => ({
    network: app.config.AIDLINE_NETWORK,
    networkPassphrase: app.config.networkPassphrase,
    rpcUrl: app.config.AIDLINE_RPC_URL,
    contractId: app.config.AIDLINE_CONTRACT_ID,
    tokenId: app.config.AIDLINE_TOKEN_ID,
  }));

  app.get('/stats', async (_req, reply) => {
    const cached = app.cache.get<unknown>(STATS_CACHE_KEY);
    setCacheHeaders(reply, cached !== undefined);
    if (cached !== undefined) return cached;

    const { rows } = await app.db.query(
      `SELECT
         (SELECT count(*)::int FROM campaigns) AS campaigns,
         (SELECT count(*)::int FROM campaigns WHERE status = 'active' AND deadline >= now())
           AS "activeCampaigns",
         (SELECT COALESCE(sum(raised), 0) FROM campaigns) AS "totalDonated",
         (SELECT COALESCE(sum(released), 0) FROM campaigns) AS "totalReleased",
         (SELECT COALESCE(sum(amount), 0) FROM refunds) AS "totalRefunded",
         (SELECT count(DISTINCT donor)::int FROM donations) AS donors,
         (SELECT count(*)::int FROM verifiers WHERE active) AS verifiers,
         (SELECT count(*)::int FROM milestone_releases) AS "milestonesVerified"`,
    );
    const stats = rows[0];
    app.cache.set(STATS_CACHE_KEY, stats);
    return stats;
  });

  app.get('/stats/history', async () => {
    const history = await getStatsHistory(app.db);
    return { items: history };
  });
}
