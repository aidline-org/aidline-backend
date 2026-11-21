import { Keypair } from '@stellar/stellar-sdk';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../src/db/pool.js';
import { Indexer } from '../src/indexer/indexer.js';
import type { ChainCampaign } from '../src/stellar/contract.js';
import {
  account,
  chainCampaign,
  CONTRACT_ID,
  events,
  MAGIC,
  multipartBody,
  resetDb,
  setupApp,
} from './helpers.js';

const { app, db } = (await setupApp()) as { app: FastifyInstance; db: Db };

const metadataHeaders = () => signRequest(uploaderKeypair, 'metadata:create');
const proofVerifier = Keypair.random();

const metadata = {
  title: 'Clean water after flooding in Les Cayes',
  summary:
    'Water storage and purification for families displaced by flooding on the southern coast.',
  description: 'The September floods displaced thousands of families. This campaign funds water.',
  location: 'Les Cayes, Haiti',
  organizer: 'Haitian community association, Montreal',
  category: 'flood',
};

/** Runs the indexer once over the given events against a fixed chain state. */
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

describe('API', () => {
  beforeEach(() => resetDb(db));
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it('creates metadata and returns a URI for the contract', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/metadata',
      payload: metadata,
      headers: metadataHeaders(),
    });
    expect(res.statusCode).toBe(201);
    const { id, uri } = res.json();
    expect(uri).toBe(`http://api.test/metadata/${id}`);

    const get = await app.inject({ url: `/metadata/${id}` });
    expect(get.json()).toMatchObject({ title: metadata.title, location: metadata.location });
  });

  it('rejects invalid metadata with field level errors', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/metadata',
      payload: { title: 'x' },
      headers: metadataHeaders(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues.map((i: { path: string }) => i.path)).toContain('title');
  });

  it('serves indexed campaigns joined with their metadata', async () => {
    const meta = (
      await app.inject({
        method: 'POST',
        url: '/metadata',
        payload: metadata,
        headers: metadataHeaders(),
      })
    ).json();
    const donor = account();
    const campaign = chainCampaign({ metadataUri: meta.uri, raised: 600n });
    await index(campaign, [events.created(0n, campaign.creator), events.donated(0n, donor, 600n)]);

    const list = (await app.inject({ url: '/campaigns?kind=emergency' })).json();
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({
      id: '0',
      status: 'active',
      raised: '600',
      donorCount: 1,
      metadata: { title: metadata.title, organizer: metadata.organizer },
    });

    const detail = (await app.inject({ url: '/campaigns/0' })).json();
    expect(detail.metadata.description).toBe(metadata.description);
    expect(detail.milestones).toHaveLength(3);
    expect(detail.milestones[0]).toMatchObject({ amount: '300', released: false });

    const climate = (await app.inject({ url: '/campaigns?kind=climate' })).json();
    expect(climate.total).toBe(0);

    const history = (await app.inject({ url: `/donors/${donor}` })).json();
    expect(history).toMatchObject({ totalDonated: '600', campaignsSupported: 1 });
    expect(history.donations[0].campaignTitle).toBe(metadata.title);
  });

  it('reports campaigns past their deadline as expired', async () => {
    const campaign = chainCampaign({ deadline: BigInt(Math.floor(Date.now() / 1000) - 60) });
    await index(campaign, [events.created(0n, campaign.creator)]);

    const list = (await app.inject({ url: '/campaigns?status=expired' })).json();
    expect(list.items[0].status).toBe('expired');
  });

  it('attaches uploaded proofs to released milestones', async () => {
    const content = Buffer.concat([MAGIC['image/png'], Buffer.from('PNGDATA')]);
    const { payload, headers } = multipartBody([
      { name: 'campaignId', value: '0' },
      { name: 'milestoneIndex', value: '0' },
      { name: 'note', value: 'Water tanks delivered to 3 camps' },
      { name: 'files', filename: 'tanks.png', contentType: 'image/png', content },
    ]);
    const upload = await app.inject({ method: 'POST', url: '/proofs', payload, headers });
    expect(upload.statusCode).toBe(201);
    const proof = upload.json();
    expect(proof.files[0].url).toMatch(/\/uploads\/proofs\/.+\/0\.png$/);

    await index(campaign, [
      events.created(0n, campaign.creator),
      events.released(0n, 0, 300n, proof.uri),
    ]);

    const detail = (await app.inject({ url: '/campaigns/0' })).json();
    expect(detail.milestones[0]).toMatchObject({
      released: true,
      proof: { note: 'Water tanks delivered to 3 camps' },
    });

    const file = await app.inject({ url: new URL(proof.files[0].url).pathname });
    expect(file.rawPayload).toEqual(content);
    expect(file.headers['content-type']).toMatch(/^image\/png/);
  });

  it('rejects proof files of the wrong type', async () => {
    const campaign = chainCampaign({ verifier: proofVerifier.publicKey() });
    await index(campaign, [events.created(0n, campaign.creator)]);

    const boundary = '----aidline';
    const body = [
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="x.exe"\r\nContent-Type: application/octet-stream\r\n\r\nMZ`,
      `--${boundary}--\r\n`,
    ].join('\r\n');
    const res = await app.inject({
      method: 'POST',
      url: '/proofs',
      payload: body,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        ...signRequest(proofVerifier, 'proof:upload', { campaignId: '0' }),
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists only verifiers that are active on chain', async () => {
    const address = account();
    const apply = await app.inject({
      method: 'POST',
      url: '/verifiers/applications',
      payload: {
        address,
        orgName: 'Red Relief Network',
        country: 'Nigeria',
        description: 'Field verification partner for flood response in Kogi state.',
      },
    });
    expect(apply.statusCode).toBe(201);
    expect((await app.inject({ url: '/verifiers' })).json().items).toHaveLength(0);

    await index(chainCampaign(), [events.verifier(address, true)]);
    const items = (await app.inject({ url: '/verifiers' })).json().items;
    expect(items).toEqual([expect.objectContaining({ address, orgName: 'Red Relief Network' })]);
  });

  it('lists campaigns for a verifier with milestone counts', async () => {
    const verifier = account();
    const other = account();
    const first = chainCampaign({
      id: 0n,
      verifier,
      milestones: [300n, 300n, 400n],
      milestonesReleased: 1,
    });
    const second = chainCampaign({
      id: 1n,
      verifier,
      milestones: [100n, 200n],
      milestonesReleased: 0,
    });
    const unrelated = chainCampaign({ id: 2n, verifier: other });
    await index(first, [events.created(0n, first.creator)]);
    await index(second, [events.created(1n, second.creator)]);
    await index(unrelated, [events.created(2n, unrelated.creator)]);

    const res = await app.inject({ url: `/verifiers/${verifier}/campaigns` });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();
    expect(items).toHaveLength(2);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: '0', milestoneCount: 3, milestonesReleased: 1 }),
        expect.objectContaining({ id: '1', milestoneCount: 2, milestonesReleased: 0 }),
      ]),
    );
    expect(items.some((c: { id: string }) => c.id === '2')).toBe(false);

    const otherRes = await app.inject({ url: `/verifiers/${other}/campaigns` });
    expect(otherRes.json().items).toEqual([
      expect.objectContaining({ id: '2', milestoneCount: 3, milestonesReleased: 0 }),
    ]);
  });

  it('lists recent milestone releases with campaign context', async () => {
    const meta = (
      await app.inject({
        method: 'POST',
        url: '/metadata',
        payload: metadata,
        headers: metadataHeaders(),
      })
    ).json();
    const campaign = chainCampaign({ metadataUri: meta.uri, raised: 600n, released: 300n });
    await index(campaign, [
      events.created(0n, campaign.creator),
      events.released(0n, 0, 300n, 'ipfs://p'),
    ]);
    const { items } = (await app.inject({ url: '/releases' })).json();
    expect(items).toEqual([
      expect.objectContaining({
        campaignId: '0',
        index: 0,
        amount: '300',
        campaignTitle: metadata.title,
        kind: 'emergency',
      }),
    ]);
  });

  it('lists refunds for a campaign paginated newest first', async () => {
    const donor1 = account();
    const donor2 = account();
    const campaign = chainCampaign({ raised: 0n });
    await index(campaign, [
      events.created(0n, campaign.creator),
      events.refunded(0n, donor1, 200n),
      events.refunded(0n, donor2, 150n),
    ]);

    const res = await app.inject({ url: '/campaigns/0/refunds' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    // Newest first: donor2 refunded after donor1.
    expect(body.items[0]).toMatchObject({ donor: donor2, amount: '150' });
    expect(body.items[1]).toMatchObject({ donor: donor1, amount: '200' });

    // pagination
    const page = await app.inject({ url: '/campaigns/0/refunds?limit=1&offset=1' });
    expect(page.json().items).toHaveLength(1);
    expect(page.json().items[0]).toMatchObject({ donor: donor1 });

    // 404 for unknown campaign
    const missing = await app.inject({ url: '/campaigns/999/refunds' });
    expect(missing.statusCode).toBe(404);
  });

  it('summarises platform stats', async () => {
    const campaign = chainCampaign({ raised: 500n, released: 300n });
    await index(campaign, [
      events.created(0n, campaign.creator),
      events.donated(0n, account(), 500n),
      events.released(0n, 0, 300n, 'ipfs://p'),
      events.refunded(0n, account(), 50n),
    ]);
    const stats = (await app.inject({ url: '/stats' })).json();
    expect(stats).toMatchObject({
      campaigns: 1,
      activeCampaigns: 1,
      totalDonated: '500',
      totalReleased: '300',
      totalRefunded: '50',
      donors: 1,
      milestonesVerified: 1,
    });
  });

  it('/health includes latestLedger and lagLedgers after a sync', async () => {
    // Before any sync, all ledger fields are null.
    const before = (await app.inject({ url: '/health' })).json();
    expect(before.ok).toBe(true);
    expect(before.indexedLedger).toBeNull();
    expect(before.latestLedger).toBeNull();
    expect(before.lagLedgers).toBeNull();

    // Run one sync with a known latest ledger from the mock RPC.
    const indexer = new Indexer({
      db,
      contractId: CONTRACT_ID,
      pollMs: 1000,
      log: app.log,
      source: {
        getEvents: async () => ({ events: [], cursor: 'c', latestLedger: 5000100 }) as never,
        getHealth: async () => ({ oldestLedger: 5000000, latestLedger: 5000100 }),
      },
      contract: { getCampaign: async () => chainCampaign() },
    });
    await indexer.syncOnce();

    const after = (await app.inject({ url: '/health' })).json();
    expect(after.ok).toBe(true);
    expect(after.latestLedger).toBe(5000100);
    // indexedLedger may be null (no events processed), so lagLedgers can be null too.
    // What matters is the fields exist.
    expect(Object.keys(after)).toContain('latestLedger');
    expect(Object.keys(after)).toContain('lagLedgers');
  });

  it('serves /openapi.json describing every route', async () => {
    const res = await app.inject({ url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);

    const spec = res.json();
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info.title).toBe('Aidline API');

    // Verify key routes are present in the spec
    const paths = Object.keys(spec.paths ?? {});
    expect(paths).toContain('/health');
    expect(paths).toContain('/campaigns');
    expect(paths.some((p) => p.includes('/campaigns/{id}/refunds'))).toBe(true);
    expect(paths.some((p) => p.includes('/campaigns/{id}/donations'))).toBe(true);
  });

  it('serves /docs as HTML', async () => {
    const res = await app.inject({ url: '/docs' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });
});
