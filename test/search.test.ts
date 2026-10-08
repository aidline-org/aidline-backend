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

describe('Full-text search (?q=)', () => {
  beforeEach(() => resetDb(db));
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  async function createCampaign(id: bigint, metaOverride: any) {
    const meta = (
      await app.inject({
        method: 'POST',
        url: '/metadata',
        payload: {
          title: 'Default title',
          summary: 'Default summary',
          description: 'Default description longer than 20 chars',
          location: 'Default location',
          ...metaOverride,
        },
      })
    ).json();

    const campaign = chainCampaign({ id, metadataUri: meta.uri });
    await index(campaign, [events.created(id, campaign.creator)]);
  }

  it('searches by title', async () => {
    await createCampaign(0n, { title: 'Hurricane relief effort' });
    await createCampaign(1n, { title: 'Drought support fund' });

    const res = await app.inject({ url: '/campaigns?q=hurricane' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe('0');
  });

  it('searches by summary', async () => {
    await createCampaign(0n, { summary: 'Supplying blankets and tents' });
    await createCampaign(1n, { summary: 'Providing clean water and food' });

    const res = await app.inject({ url: '/campaigns?q=blankets' });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe('0');
  });

  it('searches by location', async () => {
    await createCampaign(0n, { location: 'Miami, Florida' });
    await createCampaign(1n, { location: 'Houston, Texas' });

    const res = await app.inject({ url: '/campaigns?q=florida' });
    expect(res.json().total).toBe(1);
    expect(res.json().items[0].id).toBe('0');
  });

  it('searches by organizer', async () => {
    await createCampaign(0n, { organizer: 'Red Cross' });
    await createCampaign(1n, { organizer: 'World Central Kitchen' });

    const res = await app.inject({ url: '/campaigns?q=kitchen' });
    expect(res.json().total).toBe(1);
    expect(res.json().items[0].id).toBe('1');
  });

  it('handles multi-word search correctly', async () => {
    await createCampaign(0n, { title: 'Flood relief in Pakistan' });
    await createCampaign(1n, { title: 'Earthquake relief in Turkey' });

    const res = await app.inject({ url: '/campaigns?q=flood pakistan' });
    expect(res.json().total).toBe(1);
    expect(res.json().items[0].id).toBe('0');
  });

  it('ranks relevant campaigns higher (relevance ordering)', async () => {
    // Campaign 0 has "water" in title (weight A)
    await createCampaign(0n, { title: 'Clean water for everyone', summary: 'General fund' });
    // Campaign 1 has "water" only in summary (weight B)
    await createCampaign(1n, { title: 'General fund', summary: 'Clean water for everyone' });

    const res = await app.inject({ url: '/campaigns?q=water' });
    const body = res.json();
    expect(body.total).toBe(2);
    // Campaign 0 should be ranked higher than Campaign 1
    expect(body.items[0].id).toBe('0');
    expect(body.items[1].id).toBe('1');
  });

  it('returns empty list for no matches', async () => {
    await createCampaign(0n, { title: 'Food drive' });
    const res = await app.inject({ url: '/campaigns?q=medical' });
    expect(res.json().total).toBe(0);
  });

  it('ignores empty query and returns all', async () => {
    await createCampaign(0n, { title: 'One' });
    await createCampaign(1n, { title: 'Two' });
    const res = await app.inject({ url: '/campaigns?q=   ' });
    expect(res.json().total).toBe(2);
  });

  it('composes search with existing filters', async () => {
    await createCampaign(0n, { title: 'Hurricane matching filter' });
    // This requires kind to match
    await db.query(`UPDATE campaigns SET kind = 'climate' WHERE id = '0'`);

    await createCampaign(1n, { title: 'Hurricane not matching filter' });
    await db.query(`UPDATE campaigns SET kind = 'emergency' WHERE id = '1'`);

    const res = await app.inject({ url: '/campaigns?q=hurricane&kind=climate' });
    expect(res.json().total).toBe(1);
    expect(res.json().items[0].id).toBe('0');
  });

  it('supports pagination alongside search', async () => {
    await createCampaign(0n, { title: 'Match one' });
    await createCampaign(1n, { title: 'Match two' });
    await createCampaign(2n, { title: 'Match three' });

    const res = await app.inject({ url: '/campaigns?q=match&limit=2&offset=1' });
    const body = res.json();
    expect(body.total).toBe(3); // Total matching
    expect(body.items).toHaveLength(2); // Only 2 returned
  });

  it('is safe against malformed user input (parameterized)', async () => {
    await createCampaign(0n, { title: 'Valid campaign' });
    // Postgres websearch_to_tsquery is safe by design, and we use parameterized queries.
    // We just verify it doesn't crash on weird punctuation.
    const res = await app.inject({ url: '/campaigns?q=\' OR 1=1 -- \\\\ " !! ()' });
    expect(res.statusCode).toBe(200);
  });
});
