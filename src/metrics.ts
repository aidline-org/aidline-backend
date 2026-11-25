import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Registers `GET /metrics` in Prometheus text format.
 *
 * Called directly on the root app, not through `app.register`, so the request hook below covers
 * every route instead of staying inside a plugin scope.
 *
 * Route labels use the route pattern (`/campaigns/:id`), never the raw URL, so label cardinality
 * stays bounded. Requests that match no route are grouped under `unmatched`.
 */
export function registerMetrics(app: FastifyInstance) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const requests = new Counter({
    name: 'aidline_http_requests_total',
    help: 'HTTP requests by method, route and status code',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });

  const duration = new Histogram({
    name: 'aidline_http_request_duration_seconds',
    help: 'HTTP request duration in seconds by method and route',
    labelNames: ['method', 'route'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  // The indexer gauges read the same row as /health, at scrape time, so they are never stale.
  const ledgerGauge = (name: string, help: string, column: string) =>
    new Gauge({
      name,
      help,
      registers: [registry],
      async collect() {
        try {
          const { rows } = await app.db.query<Record<string, number | null>>(
            `SELECT ${column} AS value FROM indexer_state WHERE id = 1`,
          );
          const value = rows[0]?.value;
          if (value !== null && value !== undefined) this.set(Number(value));
        } catch (err) {
          app.log.warn({ err }, 'could not read indexer_state for metrics');
        }
      },
    });

  ledgerGauge('aidline_indexed_ledger', 'Last ledger the indexer has processed', 'last_ledger');
  ledgerGauge('aidline_latest_ledger', 'Latest ledger seen from the network', 'latest_ledger');
  ledgerGauge(
    'aidline_indexer_lag_ledgers',
    'Ledgers between the network tip and the indexer (0 means caught up)',
    'latest_ledger - last_ledger',
  );

  // Indexed-event totals are read from the durable event table so restarts do
  // not reset the counters. The unknown bucket makes newly deployed contract
  // events visible without requiring a metrics code change first.
  new Gauge({
    name: 'aidline_indexed_events_total',
    help: 'Indexed events by decoded event type',
    labelNames: ['event_type'],
    registers: [registry],
    async collect() {
      try {
        const { rows } = await app.db.query<{ event_type: string; count: number }>(
          'SELECT event_type, count(*)::int AS count FROM indexed_events GROUP BY event_type',
        );
        for (const row of rows) this.set({ event_type: row.event_type }, row.count);
      } catch (err) {
        app.log.warn({ err }, 'could not read indexed event totals for metrics');
      }
    },
  });

  new Gauge({
    name: 'aidline_indexer_seconds_since_sync',
    help: 'Seconds elapsed since the last successful indexer sync (-1 when never synced)',
    registers: [registry],
    async collect() {
      try {
        const { rows } = await app.db.query<{ updated_at: Date | string | null }>(
          'SELECT updated_at FROM indexer_state WHERE id = 1',
        );
        const last = rows[0]?.updated_at;
        this.set(last ? Math.max(0, (Date.now() - new Date(last).getTime()) / 1000) : -1);
      } catch (err) {
        app.log.warn({ err }, 'could not read indexer sync age for metrics');
      }
    },
  });

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    if (route === '/metrics') return;
    requests.inc({ method: req.method, route, status: String(reply.statusCode) });
    duration.observe({ method: req.method, route }, reply.elapsedTime / 1000);
  });

  app.get('/metrics', { schema: { hide: true } }, async (req, reply) => {
    const expectedToken = app.config.METRICS_TOKEN;
    if (expectedToken) {
      const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '');
      const supplied = match?.[1];
      const expectedBytes = Buffer.from(expectedToken);
      const suppliedBytes = Buffer.from(supplied ?? '');
      if (
        !supplied ||
        suppliedBytes.length !== expectedBytes.length ||
        !timingSafeEqual(suppliedBytes, expectedBytes)
      ) {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'Metrics authorization required',
        });
      }
    }
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });
}
