import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../src/db/pool.js';
import { getStatsHistory, snapshotStats } from '../src/indexer/stats.js';
import { Indexer } from '../src/indexer/indexer.js';
import type { ChainCampaign } from '../src/stellar/contract.js';
import { account, chainCampaign, CONTRACT_ID, events, resetDb, setupApp } from './helpers.js';

const { app, db } = (await setupApp()) as { app: FastifyInstance; db: Db };

/** Runs the indexer once over the given raw events against a fixed chain state. */
async function index(campaign: ChainCampaign, raw: ReturnType<typeof events.donated>[]) {
  const pages = [raw];
  const indexer = new Indexer({
    db,
    contractId: CONTRACT_ID,
    pollMs: 1000,
    log: app.log,
    source: {
      getEvents: async () =>
        ({ events: pages.shift() ?? [], cursor: 'c', latestLedger: 1 }) as never,
      getHealth: async () => ({ oldestLedger: 1, latestLedger: 1 }),
    },
    contract: { getCampaign: async () => campaign },
  });
  await indexer.syncOnce();
}

describe('Daily stats history', () => {
  beforeEach(() => resetDb(db));
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it('creates a daily snapshot with correct platform values', async () => {
    // Populate some data
    const campaign = chainCampaign({ raised: 500n, released: 300n, milestonesReleased: 1 });
    await index(campaign, [
      events.created(0n, campaign.creator),
      events.donated(0n, account(), 500n),
      events.released(0n, 0, 300n, 'ipfs://proof'),
    ]);
    await index(chainCampaign(), [events.verifier(account(), true)]);

    // Take snapshot for a specific date
    const date = '2026-10-08';
    const inserted = await snapshotStats(db, date);
    expect(inserted).toBe(true);

    const history = await getStatsHistory(db);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      snapshotDate: expect.stringContaining(date),
      campaigns: 1,
      activeCampaigns: 1,
      totalDonated: '500',
      totalReleased: '300',
      totalRefunded: '0',
      donors: 1,
      verifiers: 1,
      milestonesVerified: 1,
    });
  });

  it('is idempotent: taking a snapshot twice on the same day does not duplicate', async () => {
    const date = '2026-10-09';
    
    // First run
    const res1 = await snapshotStats(db, date);
    expect(res1).toBe(true);
    
    // Second run
    const res2 = await snapshotStats(db, date);
    expect(res2).toBe(false); // Indicates it was a no-op

    // Should only have 1 row
    const history = await getStatsHistory(db);
    expect(history).toHaveLength(1);
  });

  it('GET /stats/history returns time series in chronological order', async () => {
    // Insert out of order
    await snapshotStats(db, '2026-10-10');
    await snapshotStats(db, '2026-10-01');
    await snapshotStats(db, '2026-10-05');

    const res = await app.inject({ url: '/stats/history' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    
    expect(body.items).toHaveLength(3);
    
    const dates = body.items.map((item: any) => new Date(item.snapshotDate).getTime());
    
    // Verify sorting (oldest to newest)
    expect(dates[0]).toBeLessThan(dates[1]);
    expect(dates[1]).toBeLessThan(dates[2]);
  });
  
  it('GET /stats/history handles empty history correctly', async () => {
    const res = await app.inject({ url: '/stats/history' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toEqual([]);
  });
  
  it('uses exact amount representation for financial stats', async () => {
    const bigAmount = 123456789012345678901234n;
    const campaign = chainCampaign({ raised: bigAmount });
    await index(campaign, [
      events.created(0n, campaign.creator),
      events.donated(0n, account(), bigAmount),
    ]);

    await snapshotStats(db, '2026-10-15');
    
    const history = await getStatsHistory(db);
    expect(history[0].totalDonated).toBe(bigAmount.toString());
  });
});
