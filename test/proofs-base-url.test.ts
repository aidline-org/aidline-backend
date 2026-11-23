import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createPool, type Db } from '../src/db/pool.js';
import { MAGIC, multipartBody, resetDb, setupApp } from './helpers.js';

const { app, db, config } = (await setupApp()) as {
  app: FastifyInstance;
  db: Db;
  config: ReturnType<typeof loadConfig>;
};

afterAll(async () => {
  await app.close();
  await db.end();
});

beforeEach(async () => {
  await resetDb(db);
});

function uploadRequest() {
  return multipartBody([
    { name: 'campaignId', value: '0' },
    { name: 'milestoneIndex', value: '0' },
    { name: 'note', value: 'Water tanks delivered to 3 camps' },
    {
      name: 'files',
      filename: 'photo.png',
      contentType: 'image/png',
      content: Buffer.concat([MAGIC['image/png'], Buffer.from('png')]),
    },
  ]);
}

describe('proof file URLs', () => {
  it('stores relative upload paths and rebuilds URLs from current PUBLIC_BASE_URL', async () => {
    const { payload, headers } = uploadRequest();
    const res = await app.inject({
      method: 'POST',
      url: '/proofs',
      payload,
      headers,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.files[0].url).toMatch(/^http:\/\/api\.test\/uploads\/proofs\//);

    const stored = await db.query<{ files: Array<{ url: string }> }>(
      'SELECT files FROM proofs WHERE id = $1',
      [body.id],
    );
    expect(stored.rows[0]?.files[0]?.url).toMatch(/^proofs\//);
    expect(stored.rows[0]?.files[0]?.url).not.toMatch(/^https?:/);

    const movedConfig = loadConfig({
      ...process.env,
      DATABASE_URL: config.DATABASE_URL,
      PUBLIC_BASE_URL: 'https://moved.example',
      UPLOAD_DIR: config.UPLOAD_DIR,
    });
    const movedDb = createPool(movedConfig.DATABASE_URL);
    await migrate(movedDb, () => {});
    const movedApp = await buildApp(movedConfig, movedDb, { logger: false });
    const get = await movedApp.inject({ url: `/proofs/${body.id}` });
    expect(get.statusCode).toBe(200);
    expect(get.json().files[0].url).toMatch(/^https:\/\/moved\.example\/uploads\/proofs\//);
    await movedApp.close();
    await movedDb.end();
  });
});
