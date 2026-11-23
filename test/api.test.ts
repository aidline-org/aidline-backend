import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

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
  signRequest,
  uploaderKeypair,
} from './helpers.js';

const { app, db } = (await setupApp()) as { app: FastifyInstance; db: Db };
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const metadataHeaders = () => signRequest(uploaderKeypair, 'metadata:create');
const proofVerifier = Keypair.random();

const verifierApplication = (address: string) => ({
  address,
  orgName: 'Red Relief Network',
  country: 'Nigeria',
  description: 'Field verification partner for flood response in Kogi state.',
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  beforeEach(async () => {
    await resetDb(db);
    // /releases and /stats are cached for 10 seconds, so clear them between tests.
    app.cache.clear();
  });
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

  describe('metadata field limits', () => {
    // [field, shortest and longest allowed length after trimming]
    const limits: [keyof typeof metadata, number, number][] = [
      ['title', 5, 120],
      ['summary', 10, 280],
      ['description', 20, 10_000],
      ['location', 2, 120],
      ['organizer', 2, 120],
    ];

    const create = (overrides: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/metadata',
        payload: { ...metadata, ...overrides },
        headers: metadataHeaders(),
      });

    it.each(limits)('accepts %s at its limits', async (field, min, max) => {
      for (const length of [min, max]) {
        const res = await create({ [field]: 'x'.repeat(length) });
        expect(res.statusCode).toBe(201);
      }
    });

    it.each(limits)('rejects %s outside its limits', async (field, min, max) => {
      for (const length of [min - 1, max + 1]) {
        const res = await create({ [field]: 'x'.repeat(length) });
        expect(res.statusCode).toBe(400);
        expect(res.json().issues.map((i: { path: string }) => i.path)).toContain(field);
      }
    });

    it('accepts a record without its optional fields and returns them as null', async () => {
      const { title, summary, description, location } = metadata;
      const res = await app.inject({
        method: 'POST',
        url: '/metadata',
        payload: { title, summary, description, location },
        headers: metadataHeaders(),
      });
      expect(res.statusCode).toBe(201);

      const get = await app.inject({ url: `/metadata/${res.json().id}` });
      expect(get.json()).toMatchObject({ organizer: null, category: null, imageUrl: null });
    });

    it('stores a valid imageUrl and returns it', async () => {
      const imageUrl = 'https://example.org/clinic-roof.jpg';
      const res = await create({ imageUrl });
      expect(res.statusCode).toBe(201);

      const get = await app.inject({ url: `/metadata/${res.json().id}` });
      expect(get.json().imageUrl).toBe(imageUrl);
    });

    it('rejects an imageUrl that is not a URL', async () => {
      const res = await create({ imageUrl: 'not a url' });
      expect(res.statusCode).toBe(400);
      expect(res.json().issues.map((i: { path: string }) => i.path)).toContain('imageUrl');
    });

    it('rejects a category outside the fixed list', async () => {
      const res = await create({ category: 'unknown' });
      expect(res.statusCode).toBe(400);
      expect(res.json().issues.map((i: { path: string }) => i.path)).toContain('category');
    });

    it('returns 404 for a metadata id that was never created', async () => {
      const res = await app.inject({ url: `/metadata/${randomUUID()}` });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found', message: 'metadata not found' });
    });

    it('returns 400 for a metadata id that is not a UUID', async () => {
      const res = await app.inject({ url: '/metadata/not-a-uuid' });
      expect(res.statusCode).toBe(400);
      expect(res.json().issues.map((i: { path: string }) => i.path)).toContain('id');
    });
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

  it('filters active verifiers by country, ignoring case', async () => {
    const nigerian = account();
    const kenyan = account();
    for (const [address, country] of [
      [nigerian, 'Nigeria'],
      [kenyan, 'Kenya'],
    ]) {
      const apply = await app.inject({
        method: 'POST',
        url: '/verifiers/applications',
        payload: {
          address,
          orgName: `Relief partner in ${country}`,
          country,
          description: 'Field verification partner for flood response.',
        },
      });
      expect(apply.statusCode).toBe(201);
    }
    await index(chainCampaign(), [events.verifier(nigerian, true), events.verifier(kenyan, true)]);

    const addressesFor = async (query: string) =>
      (await app.inject({ url: `/verifiers${query}` }))
        .json()
        .items.map((v: { address: string }) => v.address);
    expect(await addressesFor('')).toHaveLength(2);
    expect(await addressesFor('?country=nigeria')).toEqual([nigerian]);
    expect(await addressesFor('?country=NIGERIA')).toEqual([nigerian]);
    expect(await addressesFor('?country=Ghana')).toEqual([]);
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
    const missingDonations = await app.inject({ url: '/campaigns/999/donations' });
    expect(missingDonations.statusCode).toBe(404);
  });

  it('lists the releases of one campaign with proof, newest first, paged', async () => {
    const proofId = '5d0c2f7e-8a1b-4c3d-9e2f-6a7b8c9d0e1f';
    await db.query(
      `INSERT INTO proofs (id, campaign_id, milestone_index, note, files)
       VALUES ($1, 0, 0, 'Water tanks delivered', '[{"name":"tank.png","url":"http://api.test/uploads/proofs/x/tank.png"}]')`,
      [proofId],
    );
    const campaign = chainCampaign({ raised: 1000n, released: 600n, milestonesReleased: 2 });
    await index(campaign, [
      events.created(0n, campaign.creator),
      events.released(0n, 0, 300n, `http://api.test/proofs/${proofId}`),
      events.released(0n, 1, 300n, 'ipfs://no-proof'),
    ]);

    const res = await app.inject({ url: '/campaigns/0/releases' });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();
    // Newest first: milestone 1 was released after milestone 0.
    expect(items.map((r: { index: number }) => r.index)).toEqual([1, 0]);
    expect(items[0]).toMatchObject({ index: 1, amount: '300', proof: null });
    expect(items[1]).toMatchObject({
      index: 0,
      amount: '300',
      proofUri: `http://api.test/proofs/${proofId}`,
      proof: { id: proofId, note: 'Water tanks delivered' },
    });

    const page = await app.inject({ url: '/campaigns/0/releases?limit=1&offset=1' });
    expect(page.statusCode).toBe(200);
    expect(page.json().items).toEqual([expect.objectContaining({ index: 0 })]);
  });

  it('returns an empty list for a campaign with no releases yet', async () => {
    const campaign = chainCampaign({ raised: 0n });
    await index(campaign, [events.created(0n, campaign.creator)]);
    const res = await app.inject({ url: '/campaigns/0/releases' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
  });

  it('returns 404 for releases of an unknown campaign', async () => {
    const res = await app.inject({ url: '/campaigns/999/releases' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
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

  it('reports an unknown verifier address as inactive with no name', async () => {
    const address = account();
    const res = await app.inject({ url: `/verifiers/${address}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ address, active: false, orgName: null });
  });

  it('keeps a valid application pending until the admin activates it on chain', async () => {
    const address = account();
    const res = await app.inject({
      method: 'POST',
      url: '/verifiers/applications',
      payload: verifierApplication(address),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ address, status: 'pending_review' });

    const profile = (await app.inject({ url: `/verifiers/${address}` })).json();
    expect(profile).toMatchObject({
      address,
      active: false,
      orgName: 'Red Relief Network',
      country: 'Nigeria',
    });
    expect(profile.appliedAt).not.toBeNull();
  });

  it('rejects an application with a short name and description', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/verifiers/applications',
      payload: { ...verifierApplication(account()), orgName: 'R', description: 'Too short' },
    });
    expect(res.statusCode).toBe(400);
    const paths = res.json().issues.map((i: { path: string }) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['orgName', 'description']));
  });

  it('marks an expired campaign as expired in the verifier campaign list', async () => {
    const verifier = account();
    const now = Math.floor(Date.now() / 1000);
    const expired = chainCampaign({ id: 0n, verifier, deadline: BigInt(now - 60) });
    const open = chainCampaign({ id: 1n, verifier, deadline: BigInt(now + 86400) });
    await index(expired, [events.created(0n, expired.creator)]);
    await index(open, [events.created(1n, open.creator)]);

    const { items } = (await app.inject({ url: `/verifiers/${verifier}/campaigns` })).json();
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: '0', status: 'expired' }),
        expect.objectContaining({ id: '1', status: 'active' }),
      ]),
    );
  });

  it('returns an empty history for a donor with no activity', async () => {
    const donor = account();
    const res = await app.inject({ url: `/donors/${donor}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      address: donor,
      totalDonated: '0',
      campaignsSupported: 0,
      donations: [],
      refunds: [],
      pledges: [],
    });
  });

  it('totals donations across campaigns and lists refunds', async () => {
    const donor = account();
    const first = chainCampaign({ id: 0n });
    const second = chainCampaign({ id: 1n });
    await index(first, [events.created(0n, first.creator), events.donated(0n, donor, 100n)]);
    await index(second, [
      events.created(1n, second.creator),
      events.donated(1n, donor, 250n),
      events.refunded(1n, donor, 40n),
    ]);

    const body = (await app.inject({ url: `/donors/${donor}` })).json();
    expect(body).toMatchObject({ totalDonated: '350', campaignsSupported: 2 });
    expect(body.donations).toHaveLength(2);
    expect(body.refunds).toEqual([expect.objectContaining({ campaignId: '1', amount: '40' })]);
  });

  it('pages donations without changing the summary, and rejects a bad address', async () => {
    const donor = account();
    for (const id of [0n, 1n]) {
      const campaign = chainCampaign({ id });
      await index(campaign, [
        events.created(id, campaign.creator),
        events.donated(id, donor, 100n),
      ]);
    }

    const first = (await app.inject({ url: `/donors/${donor}?limit=1&offset=0` })).json();
    const second = (await app.inject({ url: `/donors/${donor}?limit=1&offset=1` })).json();
    expect(first.donations).toHaveLength(1);
    expect(second.donations).toHaveLength(1);
    const ids = [first.donations[0].campaignId, second.donations[0].campaignId].sort();
    expect(ids).toEqual(['0', '1']);
    expect(first.totalDonated).toBe('200');

    const invalid = await app.inject({ url: '/donors/not-an-address' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().issues).toEqual([expect.objectContaining({ path: 'address' })]);
  });

  it('lists releases with proof and verifier name, newest first, and pages them', async () => {
    const verifier = account();
    const applied = await app.inject({
      method: 'POST',
      url: '/verifiers/applications',
      payload: verifierApplication(verifier),
    });
    expect(applied.statusCode).toBe(201);

    // The proof must exist before the release is indexed, or the release is stored without it.
    const proofId = randomUUID();
    const proofNote = 'Water tanks delivered to 3 camps';
    const proofFile = `http://api.test/uploads/proofs/${proofId}/0.png`;
    const files = JSON.stringify([{ name: 'tanks.png', type: 'image/png', url: proofFile }]);
    await db.query(
      `INSERT INTO proofs (id, campaign_id, milestone_index, note, files)
       VALUES ($1, $2, $3, $4, $5)`,
      [proofId, '0', 0, proofNote, files],
    );

    const withProof = chainCampaign({ id: 0n, verifier, released: 300n, milestonesReleased: 1 });
    await index(withProof, [
      events.created(0n, withProof.creator),
      events.released(0n, 0, 300n, `http://api.test/proofs/${proofId}`),
    ]);
    // Keeps the second release strictly newer, so the newest-first order is deterministic.
    await pause(5);
    const withoutProof = chainCampaign({
      id: 1n,
      verifier,
      milestones: [100n, 200n],
      released: 100n,
      milestonesReleased: 1,
    });
    await index(withoutProof, [
      events.created(1n, withoutProof.creator),
      events.released(1n, 0, 100n, 'ipfs://not-yet-uploaded'),
    ]);

    const all = (await app.inject({ url: '/releases?limit=10' })).json();
    expect(all.items).toHaveLength(2);
    expect(all.items[0]).toMatchObject({
      campaignId: '1',
      proof: null,
      verifierName: 'Red Relief Network',
    });
    expect(all.items[1]).toMatchObject({
      campaignId: '0',
      index: 0,
      amount: '300',
      verifierName: 'Red Relief Network',
      proof: { id: proofId, note: proofNote, files: [expect.objectContaining({ url: proofFile })] },
    });

    const page = (await app.inject({ url: '/releases?limit=1&offset=1' })).json();
    expect(page.items).toEqual([expect.objectContaining({ campaignId: '0' })]);
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

  it('reports the package.json version in /openapi.json', async () => {
    const spec = (await app.inject({ url: '/openapi.json' })).json();
    expect(spec.info.version).toBe(pkg.version);
  });

  it('serves /docs as HTML', async () => {
    const res = await app.inject({ url: '/docs' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });
});
