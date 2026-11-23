import { readdirSync, readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate } from '../src/db/migrate.js';
import { createPool, type Db } from '../src/db/pool.js';
import { TEST_DB_PORT } from './global-setup.js';

// A database of its own, so the suites that share aidline_test are not affected.
const FRESH_DB = 'aidline_migrations_check';
const serverUrl = `postgres://aidline:aidline@localhost:${TEST_DB_PORT}`;

type Schema = Record<string, Record<string, string>>;
type ColumnRow = { table_name: string; column_name: string; data_type: string };

const expected = JSON.parse(
  readFileSync(new URL('./fixtures/expected-schema.json', import.meta.url), 'utf8'),
) as Schema;
const migrationFiles = readdirSync(new URL('../src/db/migrations', import.meta.url))
  .filter((file) => file.endsWith('.sql'))
  .sort();

let admin: Db;
let db: Db;

/** Every table and column in the public schema, keyed by table, with each column's data type. */
async function readSchema(pool: Db): Promise<Schema> {
  const { rows } = await pool.query<ColumnRow>(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position`,
  );
  const schema: Schema = {};
  for (const row of rows) {
    const table = (schema[row.table_name] ??= {});
    table[row.column_name] = row.data_type;
  }
  return schema;
}

beforeAll(async () => {
  admin = createPool(`${serverUrl}/postgres`);
  await admin.query(`DROP DATABASE IF EXISTS ${FRESH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${FRESH_DB}`);
  db = createPool(`${serverUrl}/${FRESH_DB}`);
});

afterAll(async () => {
  await db.end();
  await admin.query(`DROP DATABASE IF EXISTS ${FRESH_DB} WITH (FORCE)`);
  await admin.end();
});

describe('migrations on an empty database', () => {
  it('create exactly the expected tables and columns', async () => {
    await migrate(db, () => {});
    expect(await readSchema(db)).toEqual(expected);
  });

  it('record every migration file as applied, once', async () => {
    const { rows } = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
    expect(rows.map((row) => row.name).sort()).toEqual(migrationFiles);
  });

  it('do nothing when run a second time', async () => {
    const before = await readSchema(db);
    const logged: string[] = [];
    await migrate(db, (msg) => logged.push(msg));
    expect(logged).toEqual([]);
    expect(await readSchema(db)).toEqual(before);
  });
});
