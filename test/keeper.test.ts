import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../src/db/pool.js';
import {
  bumpExpiringCampaignTtls,
  startTtlKeeperScheduler,
  type KeeperOptions,
} from '../src/indexer/keeper.js';
import type { ContractTtlExtender } from '../src/stellar/contract.js';
import { account, resetDb, setupApp } from './helpers.js';

const { app, db } = (await setupApp()) as { app: FastifyInstance; db: Db };

const opts: KeeperOptions = {
  intervalMs: 60_000,
  campaignTtlLedgers: 1_000,
  thresholdLedgers: 100,
};

function log() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function extender(failFor?: bigint) {
  const extend = vi.fn(async (id: bigint) => {
    if (failFor !== undefined && id === failFor) throw new Error('rpc unavailable');
  });
  return { extendCampaignTtl: extend } satisfies ContractTtlExtender;
}

async function seedCampaign(id: string, status: string, created: number, extended: number | null) {
  await db.query(
    `INSERT INTO campaigns
       (id, creator, beneficiary, verifier, kind, metadata_uri, goal, deadline, milestones,
        status, created_ledger, created_at, ttl_extended_ledger)
     VALUES ($1, $2, $2, $2, 'emergency', 'ipfs://x', '1000', now(), '{}', $3, $4, now(), $5)`,
    [id, account(), status, created, extended],
  );
}

describe('campaign TTL keeper', () => {
  beforeEach(async () => {
    await resetDb(db);
    await db.query(
      `INSERT INTO indexer_state (id, last_ledger, latest_ledger) VALUES (1, 100000, 100000)`,
    );
  });

  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it('bumps only active campaigns near expiry and records the new anchor', async () => {
    await seedCampaign('1', 'active', 99_000, null);
    await seedCampaign('2', 'active', 99_900, null);
    await seedCampaign('3', 'completed', 98_000, null);
    await seedCampaign('4', 'active', 98_000, 99_950);
    const ext = extender();
    const l = log();

    const count = await bumpExpiringCampaignTtls(db, ext, l, opts);

    expect(ext.extendCampaignTtl).toHaveBeenCalledTimes(1);
    expect(ext.extendCampaignTtl).toHaveBeenCalledWith(1n);
    expect(count).toBe(1);
    expect(l.info).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: '1', ledger: 100_000 }),
      'keeper: extended campaign TTL',
    );
    const { rows } = await db.query<{ ttl_extended_ledger: number }>(
      'SELECT ttl_extended_ledger FROM campaigns WHERE id = $1',
      ['1'],
    );
    expect(rows[0]?.ttl_extended_ledger).toBe(100_000);
  });

  it('skips the sweep until the indexer has seen a ledger', async () => {
    await db.query('DELETE FROM indexer_state');
    const ext = extender();
    const l = log();
    expect(await bumpExpiringCampaignTtls(db, ext, l, opts)).toBe(0);
    expect(ext.extendCampaignTtl).not.toHaveBeenCalled();
    expect(l.warn).toHaveBeenCalled();
  });

  it('logs a failed bump and continues with the rest of the batch', async () => {
    await seedCampaign('1', 'active', 99_000, null);
    await seedCampaign('2', 'active', 98_000, null);
    const ext = extender(1n);
    const l = log();

    const count = await bumpExpiringCampaignTtls(db, ext, l, opts);

    expect(ext.extendCampaignTtl).toHaveBeenCalledTimes(2);
    expect(count).toBe(1);
    expect(l.error).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: '1' }),
      'keeper: failed to extend campaign TTL',
    );
  });

  it('runs immediately and again on the configured interval', async () => {
    // Only the interval is faked: the sweep does real database I/O, so timers
    // used by the driver and the network must keep working normally.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await seedCampaign('1', 'active', 99_000, null);
      const ext = extender();
      const timer = startTtlKeeperScheduler(db, ext, log(), opts);

      await vi.waitFor(() => expect(ext.extendCampaignTtl).toHaveBeenCalledTimes(1));
      // A successful bump records the anchor, so make the campaign eligible
      // again to prove the next scheduled tick actually sweeps.
      await db.query('UPDATE campaigns SET ttl_extended_ledger = NULL WHERE id = $1', ['1']);
      await vi.advanceTimersByTimeAsync(opts.intervalMs);
      await vi.waitFor(() => expect(ext.extendCampaignTtl).toHaveBeenCalledTimes(2));
      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });
});
