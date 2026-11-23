import type { FastifyInstance } from 'fastify';

import { getPlatformStats, getStatsHistory } from '../indexer/stats.js';
import { setCacheHeaders } from '../lib/cache.js';
import { amount, nullableDateTime, nullableInteger } from '../lib/openapi.js';

const flag = { type: 'boolean' } as const;
const count = { type: 'integer' } as const;

const statsFields = {
  campaigns: count,
  activeCampaigns: count,
  totalDonated: amount,
  totalReleased: amount,
  totalRefunded: amount,
  donors: count,
  verifiers: count,
  milestonesVerified: count,
} as const;

/** Consider the indexer stale if it has not written anything in this long. */
const INDEXER_STALE_MS = 60_000;
const STATS_CACHE_KEY = 'stats';

export async function metaRoutes(app: FastifyInstance) {
  app.get(
    '/admin',
    {
      schema: {
        tags: ['platform'],
        summary: 'Current indexed admin set and change history',
        response: {
          200: {
            type: 'object',
            properties: {
              admins: { type: 'array', items: { type: 'string' } },
              changes: { type: 'array' },
            },
          },
        },
      },
    },
    async () => {
      const { rows } = await app.db.query<{
        admin: string;
        action: 'added' | 'removed';
        contract_id: string;
        ledger: number;
        tx_hash: string;
        created_at: string | Date;
      }>(
        `SELECT admin, action, contract_id, ledger, tx_hash, created_at
         FROM admin_changes ORDER BY created_at ASC, ledger ASC, event_id ASC`,
      );
      const admins = new Set<string>();
      for (const row of rows) {
        if (row.action === 'added') admins.add(row.admin);
        else admins.delete(row.admin);
      }
      return { admins: [...admins].sort(), changes: rows };
    },
  );
  // Kept for backwards compatibility with existing monitors.
  // #3: report indexer lag (difference between the chain's latest ledger and the indexed ledger)
  app.get(
    '/health',
    {
      schema: {
        tags: ['platform'],
        summary: 'Indexer lag and last sync time',
        response: {
          200: {
            type: 'object',
            properties: {
              ok: flag,
              indexedLedger: nullableInteger,
              latestLedger: nullableInteger,
              lagLedgers: nullableInteger,
              lastSyncedAt: nullableDateTime,
              secondsSinceSync: nullableInteger,
              stale: flag,
            },
          },
        },
      },
    },
    async () => {
      const { rows } = await app.db.query<{
        last_ledger: number | null;
        latest_ledger: number | null;
        updated_at: string | Date | null;
      }>('SELECT last_ledger, latest_ledger, updated_at FROM indexer_state WHERE id = 1');
      const row = rows[0];
      const indexedLedger = row?.last_ledger ?? null;
      const latestLedger = row?.latest_ledger ?? null;
      const lagLedgers =
        indexedLedger !== null && latestLedger !== null ? latestLedger - indexedLedger : null;
      const lastSyncedAt = row?.updated_at ? new Date(row.updated_at).toISOString() : null;
      const secondsSinceSync = lastSyncedAt
        ? Math.max(0, Math.floor((Date.now() - new Date(lastSyncedAt).getTime()) / 1000))
        : null;
      const stale = secondsSinceSync === null || secondsSinceSync * 1000 > INDEXER_STALE_MS;
      return {
        ok: true,
        indexedLedger,
        latestLedger,
        lagLedgers,
        lastSyncedAt,
        secondsSinceSync,
        stale,
      };
    },
  );

  /** Liveness: the process is running. Deliberately does not touch the database. */
  app.get(
    '/live',
    {
      schema: {
        tags: ['platform'],
        summary: 'Liveness probe',
        response: { 200: { type: 'object', properties: { ok: flag } } },
      },
    },
    async () => ({ ok: true }),
  );

  /** Readiness: the database is reachable and, when enabled, the indexer is up to date. */
  const readyBody = {
    type: 'object',
    properties: {
      ready: flag,
      checks: {
        type: 'object',
        properties: { database: { type: 'string' }, indexer: { type: 'string' } },
      },
    },
  } as const;
  app.get(
    '/ready',
    {
      schema: {
        tags: ['platform'],
        summary: 'Readiness probe, including indexer freshness when enabled',
        response: { 200: readyBody, 503: { ...readyBody, description: 'Not ready' } },
      },
    },
    async (_req, reply) => {
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
    },
  );

  /** Everything a frontend needs to talk to the right contract. */
  app.get(
    '/config',
    {
      schema: {
        tags: ['platform'],
        summary: 'Network and contract ids for building transactions',
        response: {
          200: {
            type: 'object',
            properties: {
              network: { type: 'string', enum: ['testnet', 'mainnet', 'futurenet'] },
              networkPassphrase: { type: 'string' },
              rpcUrl: { type: 'string' },
              contractId: { type: 'string' },
              tokenId: { type: 'string' },
            },
          },
        },
      },
    },
    async () => ({
      network: app.config.AIDLINE_NETWORK,
      networkPassphrase: app.config.networkPassphrase,
      rpcUrl: app.config.AIDLINE_RPC_URL,
      contractId: app.config.AIDLINE_CONTRACT_ID,
      tokenId: app.config.AIDLINE_TOKEN_ID,
    }),
  );

  app.get(
    '/stats',
    {
      schema: {
        tags: ['platform'],
        summary: 'Aggregate totals across all campaigns',
        response: {
          200: { type: 'object', properties: statsFields },
        },
      },
    },
    async (_req, reply) => {
      const cached = app.cache.get<unknown>(STATS_CACHE_KEY);
      setCacheHeaders(reply, cached !== undefined);
      if (cached !== undefined) return cached;

      const stats = await getPlatformStats(app.db);
      app.cache.set(STATS_CACHE_KEY, stats);
      return stats;
    },
  );

  app.get(
    '/stats/history',
    {
      schema: {
        tags: ['platform'],
        summary: 'Daily stats snapshots, oldest first',
        response: {
          200: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    snapshotDate: { type: 'string', format: 'date' },
                    ...statsFields,
                  },
                },
              },
            },
          },
        },
      },
    },
    async () => {
      const history = await getStatsHistory(app.db);
      return { items: history };
    },
  );
}
