import type { Db } from '../db/pool.js';

export interface PlatformStats {
  campaigns: number;
  activeCampaigns: number;
  totalDonated: string;
  totalReleased: string;
  totalRefunded: string;
  donors: number;
  verifiers: number;
  milestonesVerified: number;
}

/**
 * Represents the shape of one daily snapshot row, as returned by
 * `snapshotStats` and by `GET /stats/history`.
 *
 * Financial amounts are strings, `NUMERIC(39,0)` values from Postgres are
 * returned as strings by the type parsers in `db/pool.ts` so they never pass
 * through a JS number.
 */
export interface DailySnapshot extends PlatformStats {
  snapshotDate: string; // ISO date string, e.g. "2026-10-08"
}

const STATS_QUERY = `SELECT
  (SELECT count(*)::int FROM campaigns) AS campaigns,
  (SELECT count(*)::int FROM campaigns WHERE status = 'active' AND deadline >= now())
    AS "activeCampaigns",
  (SELECT COALESCE(sum(raised), 0) FROM campaigns) AS "totalDonated",
  (SELECT COALESCE(sum(released), 0) FROM campaigns) AS "totalReleased",
  (SELECT COALESCE(sum(amount), 0) FROM refunds) AS "totalRefunded",
  (SELECT count(DISTINCT donor)::int FROM donations) AS donors,
  (SELECT count(*)::int FROM verifiers WHERE active) AS verifiers,
  (SELECT count(*)::int FROM milestone_releases) AS "milestonesVerified"`;

export async function getPlatformStats(db: Db): Promise<PlatformStats> {
  const { rows } = await db.query<PlatformStats>(STATS_QUERY);
  return rows[0] as PlatformStats;
}

/**
 * Captures the current platform statistics and stores them as a snapshot for
 * today's UTC date.
 *
 * The calculation is shared with `GET /stats` through `getPlatformStats` so the
 * two endpoints can never diverge.  The INSERT uses an upsert so today's row
 * always reflects the latest run while past days remain unchanged.
 *
 * @param db   The Postgres pool.
 * @param date The UTC date to snapshot. Defaults to today (UTC). Exposed as a
 *             parameter so tests can inject a specific date without patching
 *             the clock.
 * @returns    `true` if a row was inserted or updated.
 */
export async function snapshotStats(db: Db, date?: string): Promise<boolean> {
  // Default to today's UTC date in ISO format (YYYY-MM-DD).
  const snapshotDate = date ?? new Date().toISOString().slice(0, 10);
  const stats = await getPlatformStats(db);

  const result = await db.query(
    `INSERT INTO daily_stats_snapshots
       (snapshot_date, campaigns, active_campaigns, total_donated,
        total_released, total_refunded, donors, verifiers, milestones_verified)
     VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (snapshot_date) DO UPDATE SET
       campaigns = EXCLUDED.campaigns,
       active_campaigns = EXCLUDED.active_campaigns,
       total_donated = EXCLUDED.total_donated,
       total_released = EXCLUDED.total_released,
       total_refunded = EXCLUDED.total_refunded,
       donors = EXCLUDED.donors,
       verifiers = EXCLUDED.verifiers,
       milestones_verified = EXCLUDED.milestones_verified`,
    [
      snapshotDate,
      stats.campaigns,
      stats.activeCampaigns,
      stats.totalDonated,
      stats.totalReleased,
      stats.totalRefunded,
      stats.donors,
      stats.verifiers,
      stats.milestonesVerified,
    ],
  );

  return (result.rowCount ?? 0) > 0;
}

/**
 * Returns all daily snapshots ordered chronologically (oldest first).
 *
 * Reading stored snapshots is intentionally cheap, no aggregation is done at
 * query time.
 */
export async function getStatsHistory(db: Db): Promise<DailySnapshot[]> {
  const { rows } = await db.query<{
    snapshot_date: string;
    campaigns: number;
    active_campaigns: number;
    total_donated: string;
    total_released: string;
    total_refunded: string;
    donors: number;
    verifiers: number;
    milestones_verified: number;
  }>(`SELECT snapshot_date, campaigns, active_campaigns,
             total_donated, total_released, total_refunded,
             donors, verifiers, milestones_verified
      FROM daily_stats_snapshots
      ORDER BY snapshot_date ASC`);

  return rows.map((r) => ({
    snapshotDate: r.snapshot_date,
    campaigns: r.campaigns,
    activeCampaigns: r.active_campaigns,
    totalDonated: r.total_donated,
    totalReleased: r.total_released,
    totalRefunded: r.total_refunded,
    donors: r.donors,
    verifiers: r.verifiers,
    milestonesVerified: r.milestones_verified,
  }));
}

/**
 * Starts a lightweight snapshot scheduler using `setInterval`.
 *
 * The application has no existing job framework, so we use the smallest
 * architecture-consistent mechanism: a plain Node.js timer. It runs hourly so
 * today's row stays current; upserts keep past days unchanged.
 *
 * The timer reference is returned so the caller can clear it on shutdown.
 *
 * @param db  Postgres pool.
 * @param log Logger (Fastify-compatible, exposes .info / .warn / .error).
 */
export function startDailySnapshotScheduler(
  db: Db,
  log: {
    info(msg: string): void;
    warn(msg: string, ...args: unknown[]): void;
    error(obj: unknown, msg: string): void;
  },
): NodeJS.Timeout {
  const take = async () => {
    try {
      await snapshotStats(db);
      log.info('daily stats snapshot updated');
    } catch (err) {
      log.error({ err }, 'daily stats snapshot failed');
    }
  };

  // Take a snapshot immediately (catch-up for the current day).
  void take();

  // Keep today's snapshot current; past days are never changed by the upsert.
  const ONE_HOUR = 60 * 60 * 1000;
  return setInterval(() => void take(), ONE_HOUR);
}
