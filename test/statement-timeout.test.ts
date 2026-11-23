import { afterAll, describe, expect, it } from 'vitest';

import { createPool } from '../src/db/pool.js';
import { TEST_DB_PORT } from './global-setup.js';

const dbUrl = `postgres://aidline:aidline@localhost:${TEST_DB_PORT}/aidline_test`;

describe('statement timeout', () => {
  const db = createPool(dbUrl, { statementTimeoutMs: 50 });

  afterAll(async () => {
    await db.end();
  });

  it('cancels long running queries', async () => {
    await expect(db.query('SELECT pg_sleep(1)')).rejects.toMatchObject({ code: '57014' });
  });
});
