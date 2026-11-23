import { pathToFileURL } from 'node:url';

import { loadConfig } from '../config.js';
import { createPool, type Db } from '../db/pool.js';

export interface OrphanMetadata {
  id: string;
  title: string;
  createdAt: Date;
}

export interface OrphanOptions {
  olderThanDays?: number;
  now?: Date;
}

export async function listOrphanMetadata(db: Db, options: OrphanOptions = {}): Promise<OrphanMetadata[]> {
  const olderThanDays = options.olderThanDays ?? 7;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000);
  const { rows } = await db.query<OrphanMetadata>(
    `SELECT m.id, m.title, m.created_at AS "createdAt"
     FROM campaign_metadata m
     WHERE m.created_at < $1
       AND NOT EXISTS (SELECT 1 FROM campaigns c WHERE c.metadata_id = m.id)
     ORDER BY m.created_at ASC, m.id ASC`,
    [cutoff],
  );
  return rows;
}

export async function deleteOrphanMetadata(db: Db, options: OrphanOptions = {}): Promise<number> {
  const olderThanDays = options.olderThanDays ?? 7;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000);
  const { rowCount } = await db.query(
    `DELETE FROM campaign_metadata m
     WHERE m.created_at < $1
       AND NOT EXISTS (SELECT 1 FROM campaigns c WHERE c.metadata_id = m.id)`,
    [cutoff],
  );
  return rowCount ?? 0;
}

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function main() {
  const del = process.argv.includes('--delete');
  const olderThanDays = Number(argValue('--older-than-days') ?? '7');
  if (!Number.isInteger(olderThanDays) || olderThanDays < 0) {
    throw new Error('--older-than-days must be a non-negative integer');
  }

  const config = loadConfig();
  const db = createPool(config.DATABASE_URL);
  try {
    const orphans = await listOrphanMetadata(db, { olderThanDays });
    if (orphans.length === 0) {
      console.log('No unused metadata records found.');
      return;
    }
    for (const row of orphans) {
      console.log(`${row.id}\t${row.createdAt.toISOString()}\t${row.title}`);
    }
    if (del) {
      const deleted = await deleteOrphanMetadata(db, { olderThanDays });
      console.log(`Deleted ${deleted} unused metadata record(s).`);
    } else {
      console.log(`Found ${orphans.length} unused metadata record(s). Re-run with --delete to remove them.`);
    }
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
