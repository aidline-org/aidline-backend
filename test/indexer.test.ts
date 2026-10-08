import type { rpc } from '@stellar/stellar-sdk';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../src/db/pool.js';
import { Indexer, type EventSource } from '../src/indexer/indexer.js';
import type { ChainCampaign } from '../src/stellar/contract.js';
import { account, chainCampaign, CONTRACT_ID, events, resetDb, setupApp } from './helpers.js';

const { app, db } = (await setupApp()) as { app: FastifyInstance; db: Db };

class FakeChain implements EventSource {
  pages: rpc.Api.EventResponse[][] = [];
  campaigns = new Map<bigint, ChainCampaign>();
  requests: rpc.Api.GetEventsRequest[] = [];

  /** When set, the next getEvents call throws this error then clears itself. */
  nextError: Error | null = null;

  async getEvents(req: rpc.Api.GetEventsRequest) {
    this.requests.push(req);
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }
    const events = this.pages.shift() ?? [];
    return { events, cursor: `cursor-${this.requests.length}`, latestLedger: 500 } as never;
  }
  async getHealth() {
    return { oldestLedger: 50, latestLedger: 500 };
  }
  async getCampaign(id: bigint) {
    const c = this.campaigns.get(id);
    if (!c) throw new Error(`no campaign ${id}`);
    return c;
  }
}

function indexerFor(chain: FakeChain) {
  return new Indexer({
    db,
    source: chain,
    contract: chain,
    contractId: CONTRACT_ID,
    startLedger: 10,
    pollMs: 1000,
    log: app.log,
  });
}

describe('Indexer', () => {
  beforeEach(() => resetDb(db));
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it('mirrors a campaign lifecycle into the database', async () => {
    const chain = new FakeChain();
    const donor = account();
    const campaign = chainCampaign({ raised: 1000n, released: 300n, milestonesReleased: 1 });
    chain.campaigns.set(0n, campaign);
    chain.pages.push([
      events.created(0n, campaign.creator),
      events.donated(0n, donor, 600n),
      events.donated(0n, account(), 400n),
      events.released(0n, 0, 300n, 'ipfs://proof'),
    ]);

    await indexerFor(chain).syncOnce();

    const c = await db.query('SELECT raised, released, milestones_released FROM campaigns');
    expect(c.rows[0]).toEqual({ raised: '1000', released: '300', milestones_released: 1 });
    const d = await db.query('SELECT count(*)::int AS n FROM donations');
    expect(d.rows[0].n).toBe(2);
    const r = await db.query('SELECT index, amount FROM milestone_releases');
    expect(r.rows).toEqual([{ index: 0, amount: '300' }]);
  });

  it('starts from the configured ledger, then follows the cursor', async () => {
    const chain = new FakeChain();
    const indexer = indexerFor(chain);
    await indexer.syncOnce();
    await indexer.syncOnce();

    expect(chain.requests[0]).toMatchObject({ startLedger: 50 });
    expect(chain.requests[1]).toMatchObject({ cursor: 'cursor-1' });
  });

  it('is idempotent when the same events are replayed', async () => {
    const chain = new FakeChain();
    const campaign = chainCampaign();
    chain.campaigns.set(0n, campaign);
    const page = [events.created(0n, campaign.creator), events.donated(0n, account(), 50n)];
    chain.pages.push(page, page);

    const indexer = indexerFor(chain);
    await indexer.syncOnce();
    await indexer.syncOnce();

    const d = await db.query('SELECT count(*)::int AS n FROM donations');
    expect(d.rows[0].n).toBe(1);
  });

  it('tracks verifiers being added and removed', async () => {
    const chain = new FakeChain();
    const v = account();
    chain.pages.push([events.verifier(v, true)], [events.verifier(v, false)]);
    const indexer = indexerFor(chain);

    await indexer.syncOnce();
    expect((await db.query('SELECT active FROM verifiers')).rows[0].active).toBe(true);
    await indexer.syncOnce();
    expect((await db.query('SELECT active FROM verifiers')).rows[0].active).toBe(false);
  });

  it('rolls back the whole page if the chain read fails', async () => {
    const chain = new FakeChain();
    chain.pages.push([events.donated(9n, account(), 5n)]);

    await expect(indexerFor(chain).syncOnce()).rejects.toThrow('no campaign 9');
    const s = await db.query('SELECT cursor FROM indexer_state');
    expect(s.rowCount).toBe(0);
  });

  // ── Issue #23: cursor-retention recovery ─────────────────────────────────

  describe('cursor-retention recovery', () => {
    it('recovers when the RPC reports cursor is no longer available', async () => {
      const chain = new FakeChain();
      const campaign = chainCampaign({ raised: 800n, released: 200n, milestonesReleased: 1 });
      chain.campaigns.set(0n, campaign);

      // Seed the indexer state with a cursor that will "expire"
      await db.query(
        `INSERT INTO indexer_state (id, cursor, last_ledger) VALUES (1, 'old-cursor-100', 100)`,
      );
      // Also seed a campaign row so recovery can see it
      await db.query(
        `INSERT INTO campaigns (id, creator, beneficiary, verifier, kind, metadata_uri, goal,
           deadline, milestones, milestones_released, raised, released, status,
           created_ledger, created_at)
         VALUES ('0', $1, $2, $3, 'emergency', 'ipfs://x', '1000',
           to_timestamp(9999999999), '{}', 1, '500', '100', 'active', 100, now())`,
        [campaign.creator, campaign.beneficiary, campaign.verifier],
      );

      // Simulate a cursor-retention RPC error
      chain.nextError = new Error('cursor is no longer available at ledger 100');

      const logSpy = vi.spyOn(app.log, 'warn');
      const indexer = indexerFor(chain);
      // syncOnce should NOT throw — it catches and recovers
      const count = await indexer.syncOnce();
      expect(count).toBe(0);

      // Cursor must be cleared so the next poll starts fresh
      const state = await db.query<{ cursor: string | null; last_ledger: number }>(
        'SELECT cursor, last_ledger FROM indexer_state WHERE id = 1',
      );
      expect(state.rows[0]!.cursor).toBeNull();
      // last_ledger should be the oldest available ledger from getHealth (50)
      expect(state.rows[0]!.last_ledger).toBe(50);

      // Campaign totals must be updated from the contract
      const row = await db.query<{ raised: string; released: string }>(
        'SELECT raised, released FROM campaigns WHERE id = $1',
        ['0'],
      );
      expect(row.rows[0]!.raised).toBe('800');
      expect(row.rows[0]!.released).toBe('200');

      // Gap must be logged
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({ expiredCursor: 'old-cursor-100' }),
        expect.stringContaining('gap recovery'),
      );

      logSpy.mockRestore();
    });

    it('triggers recovery for all known cursor-retention error phrases', async () => {
      const retentionPhrases = [
        'cursor is not found',
        'cursor expired',
        'start ledger is too old',
        'outside the ledger range',
      ];

      for (const phrase of retentionPhrases) {
        await resetDb(db);
        const chain = new FakeChain();
        // Seed a cursor
        await db.query(
          `INSERT INTO indexer_state (id, cursor, last_ledger) VALUES (1, 'old-cursor', 50)`,
        );
        chain.nextError = new Error(phrase);
        const indexer = indexerFor(chain);
        // Should not throw — recovery is triggered
        await expect(indexer.syncOnce()).resolves.toBe(0);
        // Cursor cleared
        const s = await db.query('SELECT cursor FROM indexer_state WHERE id = 1');
        expect(s.rows[0]!.cursor).toBeNull();
      }
    });

    it('does NOT trigger recovery for unrelated RPC errors', async () => {
      const chain = new FakeChain();
      await db.query(`INSERT INTO indexer_state (id, cursor, last_ledger) VALUES (1, 'cur', 100)`);
      chain.nextError = new Error('unauthorized: bad api key');
      const indexer = indexerFor(chain);
      // Should re-throw the unrelated error
      await expect(indexer.syncOnce()).rejects.toThrow('unauthorized');
      // Cursor must not have been modified
      const s = await db.query('SELECT cursor FROM indexer_state WHERE id = 1');
      expect(s.rows[0]!.cursor).toBe('cur');
    });

    it('does NOT trigger recovery when there is no stored cursor yet', async () => {
      // If there is no cursor at all (fresh db) and the RPC errors, it should
      // propagate regardless of the error message.
      const chain = new FakeChain();
      chain.nextError = new Error('cursor is not found');
      const indexer = indexerFor(chain);
      await expect(indexer.syncOnce()).rejects.toThrow('cursor is not found');
    });

    it('resumes normal indexing from the oldest ledger after recovery', async () => {
      const chain = new FakeChain();
      // Seed a cursor that will expire
      await db.query(
        `INSERT INTO indexer_state (id, cursor, last_ledger) VALUES (1, 'expired-cur', 10)`,
      );
      chain.nextError = new Error('start ledger is too old');

      const indexer = indexerFor(chain);
      await indexer.syncOnce(); // triggers recovery, clears cursor

      // Second syncOnce — no error this time, empty page
      chain.pages.push([]);
      await indexer.syncOnce();

      // The second request must use startLedger (since cursor is NULL after recovery)
      // getHealth returns oldestLedger=50; startLedger config is 10, clamped to 50
      const lastReq = chain.requests[chain.requests.length - 1];
      expect(lastReq).toMatchObject({ startLedger: 50 });
    });

    it('does not duplicate existing campaign records during recovery', async () => {
      const chain = new FakeChain();
      const campaign = chainCampaign({ raised: 500n });
      chain.campaigns.set(0n, campaign);

      // Pre-seed campaign and a donation
      await db.query(
        `INSERT INTO campaigns (id, creator, beneficiary, verifier, kind, metadata_uri, goal,
           deadline, milestones, milestones_released, raised, released, status,
           created_ledger, created_at)
         VALUES ('0', $1, $2, $3, 'emergency', 'ipfs://x', '1000',
           to_timestamp(9999999999), '{}', 0, '500', '0', 'active', 100, now())`,
        [campaign.creator, campaign.beneficiary, campaign.verifier],
      );
      await db.query(
        `INSERT INTO indexer_state (id, cursor, last_ledger) VALUES (1, 'stale-cursor', 100)`,
      );

      chain.nextError = new Error('event ledger range not available');
      const indexer = indexerFor(chain);
      await indexer.syncOnce(); // recovery

      // Run recovery again to check idempotency
      await db.query(
        `UPDATE indexer_state SET cursor = 'stale-cursor2', last_ledger = 99 WHERE id = 1`,
      );
      chain.nextError = new Error('cursor is not found');
      await indexer.syncOnce(); // recovery again

      // Only one campaign row must exist
      const camps = await db.query('SELECT count(*)::int AS n FROM campaigns');
      expect(camps.rows[0].n).toBe(1);
    });

    it('does not corrupt the cursor if recovery itself fails', async () => {
      const chain = new FakeChain();
      // No campaign in chain.campaigns → getCampaign will throw for known campaigns
      // but we need a campaign row to make recovery attempt to fetch it
      await db.query(
        `INSERT INTO campaigns (id, creator, beneficiary, verifier, kind, metadata_uri, goal,
           deadline, milestones, milestones_released, raised, released, status,
           created_ledger, created_at)
         VALUES ('99', 'GABC', 'GABC', 'GABC', 'emergency', 'ipfs://x', '1000',
           to_timestamp(9999999999), '{}', 0, '0', '0', 'active', 100, now())`,
      );
      await db.query(
        `INSERT INTO indexer_state (id, cursor, last_ledger) VALUES (1, 'stale', 100)`,
      );

      // Make getHealth itself throw to simulate a total recovery failure
      const failChain: EventSource = {
        getEvents: async () => {
          throw new Error('cursor is not found');
        },
        getHealth: async () => {
          throw new Error('rpc completely down');
        },
      };

      const indexer = new Indexer({
        db,
        source: failChain,
        contract: chain,
        contractId: CONTRACT_ID,
        startLedger: 10,
        pollMs: 1000,
        log: app.log,
      });

      await expect(indexer.syncOnce()).rejects.toThrow('rpc completely down');

      // Cursor must not have been cleared
      const s = await db.query('SELECT cursor FROM indexer_state WHERE id = 1');
      expect(s.rows[0]!.cursor).toBe('stale');
    });
  });
});
