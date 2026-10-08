import type { Db } from '../db/pool.js';

/**
 * Represents the shape of one daily snapshot row, as returned by
 * `snapshotStats` and by `GET /stats/history`.
 *
 * Financial amounts are strings, `NUMERIC(39,0)` values from Postgres are
 * returned as strings by the type parsers in `db/pool.ts` so they never pass
 * through a JS number.
 */
export interface DailySnapshot {
  snapshotDate: string; // ISO date string, e.g. "2026-10-08"
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
 * Captures the current platform statistics and stores them as a snapshot for
 * today's UTC date.
 *
 * The calculation is identical to `GET /stats` so the two endpoints can never
 * diverge.  The INSERT uses ON CONFLICT DO NOTHING so calling this function
 * more than once per day is a safe no-op (idempotent).
 *
 * @param db   The Postgres pool.
 * @param date The UTC date to snapshot. Defaults to today (UTC). Exposed as a
 *             parameter so tests can inject a specific date without patching
 *             the clock.
 * @returns    `true` if a new row was inserted, `false` if the snapshot for
 *             this date already existed (idempotent run).
 */
export async function snapshotStats(db: Db, date?: string): Promise<boolean> {
  // Default to today's UTC date in ISO format (YYYY-MM-DD).
  const snapshotDate = date ?? new Date().toISOString().slice(0, 10);

  const result = await db.query(
    `INSERT INTO daily_stats_snapshots
       (snapshot_date, campaigns, active_campaigns, total_donated,
        total_released, total_refunded, donors, verifiers, milestones_verified)
     SELECT
       $1::date,
       (SELECT count(*)::int              FROM campaigns)            AS campaigns,
       (SELECT count(*)::int              FROM campaigns
          WHERE status = 'active' AND deadline >= now())             AS active_campaigns,
       (SELECT COALESCE(sum(amount), 0)   FROM donations)            AS total_donated,
       (SELECT COALESCE(sum(released), 0) FROM campaigns)            AS total_released,
       (SELECT COALESCE(sum(amount), 0)   FROM refunds)              AS total_refunded,
       (SELECT count(DISTINCT donor)::int FROM donations)            AS donors,
       (SELECT count(*)::int              FROM verifiers WHERE active) AS verifiers,
       (SELECT count(*)::int              FROM milestone_releases)   AS milestones_verified
     ON CONFLICT (snapshot_date) DO NOTHING`,
    [snapshotDate],
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
 * Starts a lightweight daily snapshot scheduler using `setInterval`.
 *
 * The application has no existing job framework, so we use the smallest
 * architecture-consistent mechanism: a plain Node.js timer that fires every
 * 24 hours.  On startup it also immediately attempts a snapshot for today so
 * the history is never missing the current day.
 *
 * The timer reference is returned so the caller can clear it on shutdown.
 *
 * The scheduler does not install any new dependency.
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
      const inserted = await snapshotStats(db);
      if (inserted) {
        log.info('daily stats snapshot taken');
      } else {
        log.info('daily stats snapshot already exists for today, skipped');
      }
    } catch (err) {
      log.error({ err }, 'daily stats snapshot failed');
    }
  };

  // Take a snapshot immediately (catch-up for the current day).
  void take();

  // Schedule subsequent snapshots every 24 hours.
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  return setInterval(() => void take(), TWENTY_FOUR_HOURS);
}
