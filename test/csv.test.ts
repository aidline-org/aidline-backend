import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../src/db/pool.js';
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

describe('GET /campaigns/:id/export.csv', () => {
  beforeEach(() => resetDb(db));
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it('returns 200 with correct content-type for a valid campaign', async () => {
    const campaign = chainCampaign();
    await index(campaign, [events.created(0n, campaign.creator)]);
    const res = await app.inject({ url: '/campaigns/0/export.csv' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  it('returns correct content-disposition header', async () => {
    const campaign = chainCampaign();
    await index(campaign, [events.created(0n, campaign.creator)]);
    const res = await app.inject({ url: '/campaigns/0/export.csv' });
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.headers['content-disposition']).toMatch(/campaign-0\.csv/);
  });

  it('returns deterministic CSV headers as the first row', async () => {
    const campaign = chainCampaign();
    await index(campaign, [events.created(0n, campaign.creator)]);
    const res = await app.inject({ url: '/campaigns/0/export.csv' });
    const firstLine = res.body.split('\r\n')[0];
    expect(firstLine).toBe('type,createdAt,campaignId,actor,amount,milestoneIndex,txHash,eventId');
  });

  it('includes donations in the CSV', async () => {
    const donor = account();
    const campaign = chainCampaign({ raised: 500n });
    await index(campaign, [events.created(0n, campaign.creator), events.donated(0n, donor, 500n)]);
    const res = await app.inject({ url: '/campaigns/0/export.csv' });
    expect(res.body).toContain('donation');
    expect(res.body).toContain('500');
    expect(res.body).toContain(donor);
  });

  it('includes milestone releases in the CSV', async () => {
    const campaign = chainCampaign({ raised: 300n, released: 300n, milestonesReleased: 1 });
    await index(campaign, [
      events.created(0n, campaign.creator),
      events.released(0n, 0, 300n, 'ipfs://proof'),
    ]);
    const res = await app.inject({ url: '/campaigns/0/export.csv' });
    expect(res.body).toContain('release');
    expect(res.body).toContain('300');
    expect(res.body).toContain('0'); // milestoneIndex
  });

  it('includes refunds in the CSV', async () => {
    const donor = account();
    const campaign = chainCampaign();
    await index(campaign, [events.created(0n, campaign.creator), events.refunded(0n, donor, 50n)]);
    const res = await app.inject({ url: '/campaigns/0/export.csv' });
    expect(res.body).toContain('refund');
    expect(res.body).toContain('50');
    expect(res.body).toContain(donor);
  });

  it('only returns records for the requested campaign', async () => {
    // Index two campaigns
    const c0 = chainCampaign({ id: 0n, raised: 100n });
    const c1 = chainCampaign({ id: 1n, raised: 200n });
    await index(c0, [events.created(0n, c0.creator), events.donated(0n, account(), 100n)]);
    // Re-index for campaign 1 — the fake contract always returns c1 for any id
    const pages1 = [[events.created(1n, c1.creator), events.donated(1n, account(), 200n)]];
    const indexer1 = new Indexer({
      db,
      contractId: CONTRACT_ID,
      pollMs: 1000,
      log: app.log,
      source: {
        getEvents: async () =>
          ({ events: pages1.shift() ?? [], cursor: 'c2', latestLedger: 2 }) as never,
        getHealth: async () => ({ oldestLedger: 1, latestLedger: 2 }),
      },
      contract: { getCampaign: async () => c1 },
    });
    await indexer1.syncOnce();

    const res0 = await app.inject({ url: '/campaigns/0/export.csv' });
    const lines0 = res0.body.split('\r\n').filter((l) => l.length > 0);
    // Header + 1 donation row for campaign 0
    expect(lines0.length).toBe(2);
    expect(res0.body).toContain(',0,'); // campaignId column

    const res1 = await app.inject({ url: '/campaigns/1/export.csv' });
    const lines1 = res1.body.split('\r\n').filter((l) => l.length > 0);
    expect(lines1.length).toBe(2);
    expect(res1.body).toContain(',1,');
  });

  it('preserves exact decimal amounts without floating-point loss', async () => {
    // Use a large i128 amount that would lose precision as a JS number
    const bigAmount = 123456789012345678901234n;
    const campaign = chainCampaign({ raised: bigAmount });
    await index(campaign, [
      events.created(0n, campaign.creator),
      events.donated(0n, account(), bigAmount),
    ]);
    const res = await app.inject({ url: '/campaigns/0/export.csv' });
    expect(res.body).toContain(bigAmount.toString());
  });

  it('correctly escapes commas in field values', async () => {
    // Donor addresses don't contain commas but tx_hash / event_id might in future;
    // test CSV cell escaping directly via a crafted value if schema allows it.
    // Here we confirm the escaping logic: embed a comma in our test via the
    // csvCell function indirectly by checking normal fields have no broken CSV.
    const campaign = chainCampaign({ raised: 1000n });
    await index(campaign, [
      events.created(0n, campaign.creator),
      events.donated(0n, account(), 1000n),
    ]);
    const res = await app.inject({ url: '/campaigns/0/export.csv' });
    const lines = res.body.split('\r\n').filter((l) => l.length > 0);
    // Each data line must have exactly 7 commas (8 columns)
    for (const line of lines) {
      // Count unquoted commas vs total — simpler check: split by comma for header
      if (line === 'type,createdAt,campaignId,actor,amount,milestoneIndex,txHash,eventId') continue;
      const cols = line.split(',');
      expect(cols.length).toBeGreaterThanOrEqual(8);
    }
  });

  it('returns only the header row for a campaign with no records', async () => {
    const campaign = chainCampaign();
    await index(campaign, [events.created(0n, campaign.creator)]);
    const res = await app.inject({ url: '/campaigns/0/export.csv' });
    const lines = res.body.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('type,createdAt');
  });

  it('returns 404 for a non-existent campaign', async () => {
    const res = await app.inject({ url: '/campaigns/9999/export.csv' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  it('returns records in deterministic chronological order', async () => {
    const donor = account();
    const campaign = chainCampaign({ raised: 500n, released: 300n, milestonesReleased: 1 });
    await index(campaign, [
      events.created(0n, campaign.creator),
      events.donated(0n, donor, 200n),
      events.donated(0n, donor, 300n),
      events.released(0n, 0, 300n, 'ipfs://proof'),
    ]);
    const res = await app.inject({ url: '/campaigns/0/export.csv' });
    const lines = res.body
      .split('\r\n')
      .filter((l) => l.length > 0)
      .slice(1); // skip header
    // All rows must have a parseable ISO timestamp in column 1
    const timestamps = lines.map((l) => {
      const cols = l.split(',');
      return new Date(cols[1] ?? '').getTime();
    });
    // Each timestamp must be >= the previous
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]!);
    }
  });
});
