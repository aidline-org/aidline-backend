import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../src/db/pool.js';
import { backfillStatsHistory } from '../src/indexer/stats-backfill.js';
import { getStatsHistory } from '../src/indexer/stats.js';
import { resetDb, setupApp } from './helpers.js';

const { db } = (await setupApp()) as { db: Db };

beforeEach(() => resetDb(db));
afterAll(async () => {
  await db.end();
});

describe('stats backfill', () => {
  it('computes missing daily rows from history without touching existing rows', async () => {
    await db.query(
      `INSERT INTO campaigns (id, creator, beneficiary, verifier, kind, metadata_uri, goal, deadline, milestones, status, created_ledger, created_at)
       VALUES
       (1, 'GA', 'GB', 'GV', 'emergency', 'u1', 100, '2026-10-10T00:00:00Z', '{100}', 'active', 1, '2026-10-01T10:00:00Z'),
       (2, 'GA', 'GB', 'GV', 'climate', 'u2', 100, '2026-10-02T00:00:00Z', '{100}', 'active', 1, '2026-10-02T10:00:00Z')`,
    );
    await db.query(
      `INSERT INTO donations (event_id, campaign_id, donor, amount, ledger, tx_hash, created_at)
       VALUES
       ('d1', 1, 'D1', 100, 1, 't1', '2026-10-01T12:00:00Z'),
       ('d2', 1, 'D2', 50, 1, 't2', '2026-10-02T12:00:00Z')`,
    );
    await db.query(
      `INSERT INTO milestone_releases (event_id, campaign_id, index, amount, proof_uri, ledger, tx_hash, created_at)
       VALUES ('r1', 1, 0, 70, 'p', 1, 't3', '2026-10-02T13:00:00Z')`,
    );
    await db.query(
      `INSERT INTO refunds (event_id, campaign_id, donor, amount, ledger, tx_hash, created_at)
       VALUES ('rf1', 1, 'D1', 10, 1, 't4', '2026-10-03T13:00:00Z')`,
    );

    await db.query(
      `INSERT INTO daily_stats_snapshots
       (snapshot_date, campaigns, active_campaigns, total_donated, total_released, total_refunded, donors, verifiers, milestones_verified)
       VALUES ('2026-10-02', 99, 99, 999, 999, 999, 99, 99, 99)`,
    );

    const inserted = await backfillStatsHistory(db, { now: new Date('2026-10-04T00:00:00Z') });
    expect(inserted).toBe(2);

    const history = await getStatsHistory(db);
    expect(history.map((r) => r.snapshotDate.slice(0, 10))).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ]);
    expect(history[0]).toMatchObject({
      campaigns: 1,
      activeCampaigns: 1,
      totalDonated: '100',
      totalReleased: '0',
      totalRefunded: '0',
      donors: 1,
      milestonesVerified: 0,
    });
    expect(history[1]).toMatchObject({
      campaigns: 99,
      totalDonated: '999',
      donors: 99,
    });
    expect(history[2]).toMatchObject({
      campaigns: 2,
      activeCampaigns: 1,
      totalDonated: '150',
      totalReleased: '70',
      totalRefunded: '10',
      donors: 2,
      milestonesVerified: 1,
    });
  });
});
