import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../src/db/pool.js';
import { deleteOrphanMetadata, listOrphanMetadata } from '../src/indexer/metadata-orphans.js';
import { resetDb, setupApp } from './helpers.js';

const { db } = (await setupApp()) as { db: Db };

beforeEach(() => resetDb(db));
afterAll(async () => {
  await db.end();
});

describe('metadata orphans', () => {
  it('lists old unreferenced metadata and only deletes with delete mode', async () => {
    await db.query(
      `INSERT INTO campaign_metadata (id, title, summary, description, location, created_at)
       VALUES
       ('00000000-0000-0000-0000-000000000001', 'Old orphan', 's', 'd', 'L', now() - interval '10 days'),
       ('00000000-0000-0000-0000-000000000002', 'Recent orphan', 's', 'd', 'L', now() - interval '1 day'),
       ('00000000-0000-0000-0000-000000000003', 'Referenced', 's', 'd', 'L', now() - interval '10 days')`,
    );
    await db.query(
      `INSERT INTO campaigns (id, creator, beneficiary, verifier, kind, metadata_uri, metadata_id, goal, deadline, milestones, status, created_ledger, created_at)
       VALUES (1, 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', 'emergency', 'u', '00000000-0000-0000-0000-000000000003', 1, now(), '{1}', 'active', 1, now())`,
    );

    const listed = await listOrphanMetadata(db, { olderThanDays: 7 });
    expect(listed.map((r) => r.id)).toEqual(['00000000-0000-0000-0000-000000000001']);

    const { rows: before } = await db.query('SELECT id FROM campaign_metadata ORDER BY id');
    expect(before).toHaveLength(3);

    const deleted = await deleteOrphanMetadata(db, { olderThanDays: 7 });
    expect(deleted).toBe(1);

    const { rows: after } = await db.query('SELECT id FROM campaign_metadata ORDER BY id');
    expect(after.map((r) => r.id)).toEqual([
      '00000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000003',
    ]);
  });
});
