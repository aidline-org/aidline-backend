import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../src/db/pool.js';
import {
  getStatsHistory,
  snapshotStats,
  startDailySnapshotScheduler,
} from '../src/indexer/stats.js';
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

  it('keeps today current by upserting while leaving past days unchanged', async () => {
    const pastDate = '2026-10-08';
    const today = '2026-10-09';

    await snapshotStats(db, pastDate);
    await snapshotStats(db, today);

    await db.query(`UPDATE campaigns SET raised = raised + 100 WHERE id = 0`);
    const inserted = await snapshotStats(db, today);
    expect(inserted).toBe(true);

    const history = await getStatsHistory(db);
    expect(history).toHaveLength(2);
    const byDate = new Map(history.map((row) => [row.snapshotDate.slice(0, 10), row]));
    expect(byDate.get(pastDate)?.totalDonated).toBe('500');
    expect(byDate.get(today)?.totalDonated).toBe('600');
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

    const dates = body.items.map((item: { snapshotDate: string }) =>
      new Date(item.snapshotDate).getTime(),
    );

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
    expect(history[0]!.totalDonated).toBe(bigAmount.toString());
  });

  it('GET /stats and a fresh snapshot return the same figures', async () => {
    const campaign = chainCampaign({ raised: 700n, released: 200n, milestonesReleased: 1 });
    await index(campaign, [
      events.created(0n, campaign.creator),
      events.donated(0n, account(), 700n),
      events.released(0n, 0, 200n, 'ipfs://proof'),
    ]);

    app.cache.clear();
    const statsRes = await app.inject({ url: '/stats' });
    expect(statsRes.statusCode).toBe(200);
    const stats = statsRes.json() as Record<string, unknown>;

    await snapshotStats(db, '2026-10-16');
    const history = await getStatsHistory(db);
    const snapshot = history.find((row) => row.snapshotDate.startsWith('2026-10-16'));
    expect(snapshot).toBeDefined();
    expect({
      campaigns: snapshot!.campaigns,
      activeCampaigns: snapshot!.activeCampaigns,
      totalDonated: snapshot!.totalDonated,
      totalReleased: snapshot!.totalReleased,
      totalRefunded: snapshot!.totalRefunded,
      donors: snapshot!.donors,
      verifiers: snapshot!.verifiers,
      milestonesVerified: snapshot!.milestonesVerified,
    }).toEqual(stats);
  });
});

describe('startDailySnapshotScheduler', () => {
  afterEach(() => vi.useRealTimers());

  function fakeDb(fail = false) {
    let calls = 0;
    const query = vi.fn(async () => {
      calls += 1;
      if (fail) throw new Error('database is down');
      return { rows: [], rowCount: 1 };
    });
    return { db: { query } as unknown as Db, query, calls: () => calls };
  }

  function fakeLog() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }

  it('takes a snapshot immediately when started', async () => {
    vi.useFakeTimers();
    const { db, calls } = fakeDb();
    const log = fakeLog();
    const timer = startDailySnapshotScheduler(db, log);

    await vi.advanceTimersByTimeAsync(0);

    expect(calls()).toBe(1);
    expect(log.info).toHaveBeenCalledWith('daily stats snapshot updated');
    clearInterval(timer);
  });

  it('takes the next snapshot after the hourly interval', async () => {
    vi.useFakeTimers();
    const { db, calls } = fakeDb();
    const timer = startDailySnapshotScheduler(db, fakeLog());

    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(calls()).toBe(2);
    clearInterval(timer);
  });

  it('logs a failed snapshot without stopping later runs', async () => {
    vi.useFakeTimers();
    const { db, calls } = fakeDb(true);
    const log = fakeLog();
    const timer = startDailySnapshotScheduler(db, log);

    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'daily stats snapshot failed',
    );

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(calls()).toBe(2);
    expect(log.error).toHaveBeenCalledTimes(2);
    clearInterval(timer);
  });
});
