import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/pool.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { Indexer } from '../src/indexer/indexer.js';
import type { ChainCampaign } from '../src/stellar/contract.js';
import { TEST_DB_PORT } from './global-setup.js';
import { account, chainCampaign, CONTRACT_ID, events, resetDb } from './helpers.js';

interface Started {
  app: FastifyInstance;
  db: Db;
  base: string;
}

/** A real HTTP server, because SSE responses never end and inject() would wait forever. */
async function startApp(overrides: Record<string, string> = {}): Promise<Started> {
  const config = loadConfig({
    DATABASE_URL: `postgres://aidline:aidline@localhost:${TEST_DB_PORT}/aidline_test`,
    PUBLIC_BASE_URL: 'http://api.test',
    AIDLINE_CONTRACT_ID: CONTRACT_ID,
    STREAM_HEARTBEAT_MS: '1000',
    ...overrides,
  });
  const db = createPool(config.DATABASE_URL, config.DATABASE_POOL_MAX);
  await migrate(db, () => {});
  const app = await buildApp(config, db, { logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return { app, db, base: `http://127.0.0.1:${port}` };
}

/** Reads a Server-Sent Events response incrementally. */
class Sse {
  buf = '';
  private readonly decoder = new TextDecoder();

  private constructor(
    readonly status: number,
    readonly headers: Headers,
    private readonly reader: ReadableStreamDefaultReader<Uint8Array> | null,
  ) {}

  static async open(url: string, headers: Record<string, string> = {}): Promise<Sse> {
    const res = await fetch(url, { headers });
    if (!res.ok) return new Sse(res.status, res.headers, null);
    return new Sse(res.status, res.headers, res.body!.getReader());
  }

  /** Resolves once `needle` appears in the stream. Fails after `timeoutMs`. */
  async waitFor(needle: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.buf.includes(needle)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !this.reader) {
        throw new Error(`timed out waiting for ${needle}; received:\n${this.buf}`);
      }
      const chunk = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('read timeout')), remaining),
        ),
      ]);
      if (chunk.done) throw new Error(`stream ended before ${needle}; received:\n${this.buf}`);
      this.buf += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  /** Resolves with true when the server ends the stream. */
  async ended(timeoutMs = 5000): Promise<boolean> {
    const chunk = await Promise.race([
      this.reader!.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('stream still open')), timeoutMs),
      ),
    ]);
    return chunk.done;
  }

  async cancel(): Promise<void> {
    await this.reader?.cancel().catch(() => undefined);
  }
}

/** Indexes one campaign's events and publishes what was committed, as the server does. */
async function index(
  s: Started,
  campaign: ChainCampaign,
  raw: ReturnType<typeof events.donated>[],
) {
  const pages = [raw];
  const indexer = new Indexer({
    db: s.db,
    contractId: CONTRACT_ID,
    pollMs: 1000,
    log: s.app.log,
    source: {
      getEvents: async () =>
        ({ events: pages.shift() ?? [], cursor: 'c', latestLedger: 1 }) as never,
      getHealth: async () => ({ oldestLedger: 1, latestLedger: 1 }),
    },
    contract: { getCampaign: async () => campaign },
    onCommit: (evs) => s.app.streams.publish(evs),
  });
  await indexer.syncOnce();
}

describe('GET /events', () => {
  let s: Started;
  const open: Sse[] = [];
  const track = (sse: Sse) => (open.push(sse), sse);

  beforeEach(async () => {
    s = await startApp();
    await resetDb(s.db);
  });
  afterEach(async () => {
    await Promise.all(open.splice(0).map((sse) => sse.cancel()));
    await s.app.close();
    await s.db.end();
  });

  it('streams a donation as the indexer commits it', async () => {
    const campaign = chainCampaign({ raised: 500n });
    const donor = account();
    const sse = track(await Sse.open(`${s.base}/events`));
    expect(sse.status).toBe(200);
    expect(sse.headers.get('content-type')).toMatch(/text\/event-stream/);

    const donated = events.donated(0n, donor, 500n);
    await index(s, campaign, [events.created(0n, campaign.creator), donated]);

    await sse.waitFor(`id: ${donated.id}`);
    expect(sse.buf).toContain('event: donation');
    expect(sse.buf).toContain(`"actor":"${donor}"`);
    expect(sse.buf).toContain('"amount":"500"');
    expect(sse.buf).toContain('event: campaign_created');
  });

  it('streams releases and refunds', async () => {
    const campaign = chainCampaign({ raised: 300n, released: 300n, milestonesReleased: 1 });
    const donor = account();
    const sse = track(await Sse.open(`${s.base}/events`));
    const refunded = events.refunded(0n, donor, 50n);
    const released = events.released(0n, 0, 300n, 'ipfs://proof');
    await index(s, campaign, [events.created(0n, campaign.creator), refunded, released]);

    await sse.waitFor(`id: ${released.id}`);
    expect(sse.buf).toContain('event: refund');
    expect(sse.buf).toContain('event: release');
    expect(sse.buf).toContain('"milestoneIndex":0');
  });

  it('filters by campaignId', async () => {
    const sse = track(await Sse.open(`${s.base}/events?campaignId=1`));
    const c0 = chainCampaign({ id: 0n, raised: 100n });
    const c1 = chainCampaign({ id: 1n, raised: 200n });
    await index(s, c0, [events.created(0n, c0.creator), events.donated(0n, account(), 100n)]);
    const onOne = events.donated(1n, account(), 200n);
    await index(s, c1, [events.created(1n, c1.creator), onOne]);

    await sse.waitFor(`id: ${onOne.id}`);
    expect(sse.buf).toContain('"campaignId":"1"');
    expect(sse.buf).not.toContain('"campaignId":"0"');
  });

  it('replays events after Last-Event-ID, then continues live', async () => {
    const campaign = chainCampaign({ raised: 600n });
    const donor = account();
    const first = events.donated(0n, donor, 100n);
    const second = events.donated(0n, donor, 200n);
    const third = events.donated(0n, donor, 300n);
    // Committed before the client connects.
    await index(s, campaign, [events.created(0n, campaign.creator), first, second, third]);

    const sse = track(await Sse.open(`${s.base}/events`, { 'Last-Event-ID': first.id }));
    await sse.waitFor(`id: ${third.id}`);
    expect(sse.buf).toContain(`id: ${second.id}`);
    expect(sse.buf).not.toContain(`id: ${first.id}`);

    const live = events.donated(0n, donor, 400n);
    await index(s, campaign, [live]);
    await sse.waitFor(`id: ${live.id}`);
  });

  it('replays campaign creations after Last-Event-ID', async () => {
    // Campaign 1 is indexed first, so its events come before campaign 0's creation.
    const c1 = chainCampaign({ id: 1n });
    const created1 = events.created(1n, c1.creator);
    const c1Donation = events.donated(1n, account(), 10n);
    await index(s, c1, [created1, c1Donation]);

    const c0 = chainCampaign({ id: 0n });
    const created0 = events.created(0n, c0.creator);
    await index(s, c0, [created0]);

    const sse = track(await Sse.open(`${s.base}/events`, { 'Last-Event-ID': c1Donation.id }));
    await sse.waitFor(`id: ${created0.id}`);
    expect(sse.buf).toContain('event: campaign_created');
    expect(sse.buf).toContain('"campaignId":"0"');
    expect(sse.buf).not.toContain('"campaignId":"1"');
  });

  it('sends heartbeats on idle connections', async () => {
    const sse = track(await Sse.open(`${s.base}/events`));
    await sse.waitFor(': heartbeat', 4000);
  });

  it('ends open streams on shutdown', async () => {
    const sse = track(await Sse.open(`${s.base}/events`));
    await sse.waitFor('retry: 5000');
    await s.app.close();
    expect(await sse.ended()).toBe(true);
    open.length = 0;
  });
});

describe('GET /events connection limit', () => {
  it('answers 503 once the stream limit is reached', async () => {
    const s = await startApp({ STREAM_MAX_CLIENTS: '1' });
    const held = await Sse.open(`${s.base}/events`);
    try {
      await held.waitFor('retry: 5000');
      const rejected = await fetch(`${s.base}/events`);
      expect(rejected.status).toBe(503);
      expect(rejected.headers.get('retry-after')).toBe('5');
      expect((await rejected.json()).error).toBe('too_many_streams');
    } finally {
      await held.cancel();
      await s.app.close();
      await s.db.end();
    }
  });
});
