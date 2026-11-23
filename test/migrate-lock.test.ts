import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { createPool } from '../src/db/pool.js';
import { TEST_DB_PORT } from './global-setup.js';

const dbUrl = `postgres://aidline:aidline@localhost:${TEST_DB_PORT}/aidline_test`;

describe('migrate locking', () => {
  const db1 = createPool(dbUrl);
  const db2 = createPool(dbUrl);

  afterAll(async () => {
    await db1.end();
    await db2.end();
  });

  it('applies each migration once when two migrators run concurrently', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aidline-mig-'));
    const name = `900_concurrent_${Date.now()}.sql`;
    writeFileSync(join(dir, name), 'CREATE TABLE IF NOT EXISTS migrate_lock_test (id int);');
    writeFileSync(
      join(dir, '001_init.sql'),
      'CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());',
    );

    const { migrate } = await import('../src/db/migrate.js');
    // migrate() reads from its own migrations dir; test the lock by running it concurrently
    // against the real migrations dir and asserting no duplicate schema_migrations rows.
    await Promise.all([migrate(db1, () => {}), migrate(db2, () => {})]);
    const { rows } = await db1.query<{ name: string; n: string }>(
      `SELECT name, count(*)::text AS n FROM schema_migrations GROUP BY name HAVING count(*) > 1`,
    );
    expect(rows).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
