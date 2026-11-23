import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig } from '../config.js';
import { createPool, type Db } from './pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const LOCK_KEY_1 = 0x6169646c; // 'aidl'
const LOCK_KEY_2 = 0x696e6531; // 'ine1'

export async function migrate(db: Db, log: (msg: string) => void = console.log): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', [LOCK_KEY_1, LOCK_KEY_2]);
    await client.query('SET statement_timeout = 0');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (applied.rowCount) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL statement_timeout = 0');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`applied migration ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    try {
      await client.query('RESET statement_timeout');
    } catch {}
    try {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_KEY_1, LOCK_KEY_2]);
    } finally {
      client.release();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const db = createPool(config.DATABASE_URL);
  migrate(db)
    .then(() => db.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
