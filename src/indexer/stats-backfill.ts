import { pathToFileURL } from 'node:url';

import { loadConfig } from '../config.js';
import { createPool, type Db } from '../db/pool.js';
import { migrate } from '../db/migrate.js';

export interface BackfillStatsOptions {
  now?: Date;
}

/**
 * Rebuild daily_stats_snapshots from historical event tables.
 *
 * Rebuilt exactly from history: campaigns, total_donated, total_released,
 * total_refunded, donors, milestones_verified. Verifiers are counted from the
 * current verifiers table because verifier history is not event-sourced by day.
 * active_campaigns is approximated for past days as campaigns whose created_at
 * is on/before the day, deadline is on/after the day, and current status is not
 * cancelled (current status is the best available proxy without status history).
 *
 * Existing rows are never changed.
 */
export async function backfillStatsHistory(db: Db, options: BackfillStatsOptions = {}): Promise<number> {
  const now = options.now ?? new Date();
  const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const end = endDate.toISOString().slice(0, 10);

  const { rows } = await db.query<{ inserted: string }>(
    `WITH bounds AS (
       SELECT LEAST(
         (SELECT min(created_at)::date FROM donations),
         (SELECT min(created_at)::date FROM milestone_releases),
         (SELECT min(created_at)::date FROM refunds),
         (SELECT min(created_at)::date FROM campaigns)
       ) AS start_date
     ), days AS (
       SELECT generate_series(start_date, $1::date, interval '1 day')::date AS day
       FROM bounds
       WHERE start_date IS NOT NULL AND start_date <= $1::date
     ), ins AS (
       INSERT INTO daily_stats_snapshots
         (snapshot_date, campaigns, active_campaigns, total_donated, total_released, total_refunded, donors, verifiers, milestones_verified)
       SELECT
         d.day,
         (SELECT count(*)::int FROM campaigns c WHERE c.created_at::date <= d.day),
         (SELECT count(*)::int FROM campaigns c
           WHERE c.created_at::date <= d.day
             AND c.deadline::date >= d.day
             AND c.status <> 'cancelled'),
         COALESCE((SELECT sum(amount) FROM donations x WHERE x.created_at::date <= d.day), 0),
         COALESCE((SELECT sum(amount) FROM milestone_releases x WHERE x.created_at::date <= d.day), 0),
         COALESCE((SELECT sum(amount) FROM refunds x WHERE x.created_at::date <= d.day), 0),
         (SELECT count(DISTINCT donor)::int FROM donations x WHERE x.created_at::date <= d.day),
         (SELECT count(*)::int FROM verifiers WHERE active),
         (SELECT count(*)::int FROM milestone_releases x WHERE x.created_at::date <= d.day)
       FROM days d
       WHERE NOT EXISTS (SELECT 1 FROM daily_stats_snapshots s WHERE s.snapshot_date = d.day)
       RETURNING 1
     )
     SELECT count(*)::text AS inserted FROM ins`,
    [end],
  );

  return Number(rows[0]?.inserted ?? '0');
}

async function main() {
  const config = loadConfig();
  const db = createPool(config.DATABASE_URL);
  await migrate(db);
  try {
    const inserted = await backfillStatsHistory(db);
    console.log(`Inserted ${inserted} daily stats snapshot(s).`);
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
