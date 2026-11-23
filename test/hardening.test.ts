import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Keypair } from '@stellar/stellar-sdk';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/pool.js';
import { MAGIC, multipartBody, setupApp } from './helpers.js';

const { app, db, config } = (await setupApp()) as {
  app: FastifyInstance;
  db: Db;
  config: ReturnType<typeof loadConfig>;
};

const proofSigner = Keypair.random();

beforeAll(async () => {
  await db.query(
    `INSERT INTO campaigns
       (id, creator, beneficiary, verifier, kind, metadata_uri, goal, deadline,
        milestones, status, created_ledger, created_at)
     VALUES ('0', $1, $1, $2, 'emergency', 'ipfs://x', '1000', now(), '{}', 'active', 1, now())
     ON CONFLICT (id) DO NOTHING`,
    [account(), proofSigner.publicKey()],
  );
});

afterAll(async () => {
  await app.close();
  await db.end();
});

describe('security headers', () => {
  it('sends hardening headers on API responses', async () => {
    const res = await app.inject({ url: '/stats' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('lets other origins load files, so the frontend can show proof images', async () => {
    const res = await app.inject({ url: '/stats' });
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  it('still attaches a request id', async () => {
    const res = await app.inject({ url: '/stats' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});

describe('request ids in error responses', () => {
  it('echoes the X-Request-Id header in a 400 body', async () => {
    const res = await app.inject({ url: '/releases?limit=500' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_error' });
    expect(res.json().requestId).toBe(res.headers['x-request-id']);
  });

  it('echoes the X-Request-Id header in a 404 body', async () => {
    const res = await app.inject({ url: '/campaigns/999999' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
    expect(res.json().requestId).toBe(res.headers['x-request-id']);
  });

  it('echoes the X-Request-Id header in the 404 for an unknown route', async () => {
    const res = await app.inject({ url: '/this/route/does/not/exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found', message: 'Route not found' });
    expect(res.json().requestId).toBe(res.headers['x-request-id']);
  });

  it('echoes the X-Request-Id header in a 500 body', async () => {
    const spy = vi.spyOn(db, 'query').mockRejectedValueOnce(new Error('database is down'));
    try {
      const res = await app.inject({ url: '/releases' });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({
        error: 'internal_error',
        message: 'Something went wrong',
        requestId: res.headers['x-request-id'],
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('gives every request its own id, never one supplied by the client', async () => {
    const first = await app.inject({
      url: '/releases?limit=500',
      headers: { 'request-id': 'mine' },
    });
    const second = await app.inject({ url: '/releases?limit=500' });
    expect(first.headers['x-request-id']).not.toBe('mine');
    expect(first.json().requestId).not.toBe(second.json().requestId);
  });
});

describe('proof upload file names', () => {
  const fields = [
    { name: 'campaignId', value: '0' },
    { name: 'milestoneIndex', value: '0' },
    { name: 'note', value: 'Water tanks delivered to 3 camps' },
  ];

  it('stores the file with an extension taken from its type, not its name', async () => {
    const { payload, headers } = multipartBody([
      ...fields,
      {
        name: 'files',
        filename: 'evil.html',
        contentType: 'image/png',
        content: Buffer.concat([MAGIC['image/png'], Buffer.from('<script>alert(1)</script>')]),
      },
    ]);
    const upload = await app.inject({ method: 'POST', url: '/proofs', payload, headers });
    expect(upload.statusCode).toBe(201);

    const url: string = upload.json().files[0].url;
    expect(url).toMatch(/\/0\.png$/);
    expect(url).not.toMatch(/html/);

    const served = await app.inject({ url: new URL(url).pathname });
    expect(served.statusCode).toBe(200);
    expect(String(served.headers['content-type'])).toMatch(/^image\/png/);
    expect(served.headers['x-content-type-options']).toBe('nosniff');
  });

  it.each([
    ['image/jpeg', 'photo.JPEG', '.jpg'],
    ['image/webp', 'photo.webp', '.webp'],
    ['application/pdf', 'receipt.pdf', '.pdf'],
  ])('uses %s for %s and stores it as %s', async (type, filename, extension) => {
    const { payload, headers } = multipartBody([
      ...fields,
      {
        name: 'files',
        filename,
        contentType: type,
        content: Buffer.concat([MAGIC[type as keyof typeof MAGIC], Buffer.from('DATA')]),
      },
    ]);
    const upload = await app.inject({ method: 'POST', url: '/proofs', payload, headers });
    expect(upload.statusCode).toBe(201);
    expect(upload.json().files[0].url.endsWith(`/0${extension}`)).toBe(true);
  });
});

describe('proof upload limits and cleanup', () => {
  const fields = [
    { name: 'campaignId', value: '0' },
    { name: 'milestoneIndex', value: '0' },
    { name: 'note', value: 'Water tanks delivered to 3 camps' },
  ];
  const png = () => ({
    name: 'files',
    filename: 'tank.png',
    contentType: 'image/png',
    content: Buffer.concat([MAGIC['image/png'], Buffer.from('DATA')]),
  });

  /** Every file under a directory. A rejected upload must leave this list unchanged. */
  async function storedFiles(dir: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...(await storedFiles(path)));
      else found.push(path);
    }
    return found.sort();
  }

  it('rejects a sixth file and keeps none of the files before it', async () => {
    const before = await storedFiles(config.UPLOAD_DIR);
    const { payload, headers } = multipartBody([
      ...fields,
      ...Array.from({ length: 6 }, () => png()),
    ]);
    const res = await app.inject({ method: 'POST', url: '/proofs', payload, headers });
    expect(res.statusCode).toBe(413);
    expect(await storedFiles(config.UPLOAD_DIR)).toEqual(before);
  });

  it('rejects an unsupported type after a valid file and removes the valid file', async () => {
    const before = await storedFiles(config.UPLOAD_DIR);
    const { payload, headers } = multipartBody([
      ...fields,
      png(),
      {
        name: 'files',
        filename: 'notes.txt',
        contentType: 'text/plain',
        content: Buffer.from('hello'),
      },
    ]);
    const res = await app.inject({ method: 'POST', url: '/proofs', payload, headers });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_file' });
    expect(await storedFiles(config.UPLOAD_DIR)).toEqual(before);
  });

  it('rejects invalid fields after a valid file and removes the file', async () => {
    const before = await storedFiles(config.UPLOAD_DIR);
    const { payload, headers } = multipartBody([
      png(),
      { name: 'campaignId', value: '0' },
      { name: 'milestoneIndex', value: '0' },
      { name: 'note', value: 'too short' },
    ]);
    const res = await app.inject({ method: 'POST', url: '/proofs', payload, headers });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_error' });
    expect(await storedFiles(config.UPLOAD_DIR)).toEqual(before);
  });

  it('rejects a file whose bytes do not match its declared type and stores nothing', async () => {
    const before = await storedFiles(config.UPLOAD_DIR);
    const { payload, headers } = multipartBody([
      ...fields,
      {
        name: 'files',
        filename: 'fake.png',
        contentType: 'image/png',
        content: Buffer.from('not an image at all'),
      },
    ]);
    const res = await app.inject({ method: 'POST', url: '/proofs', payload, headers });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_file' });
    expect(await storedFiles(config.UPLOAD_DIR)).toEqual(before);
  });
});

describe('GET /metrics', () => {
  it('serves Prometheus text format', async () => {
    const res = await app.inject({ url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toMatch(/^text\/plain/);
    expect(res.body).toContain('process_cpu_user_seconds_total');
  });

  it('counts requests by route pattern, not by raw URL', async () => {
    await app.inject({ url: '/campaigns/123456' });
    await app.inject({ url: '/campaigns/654321' });
    const { body } = await app.inject({ url: '/metrics' });

    expect(body).toMatch(
      /aidline_http_requests_total\{method="GET",route="\/campaigns\/:id",status="\d+"\} 2/,
    );
    expect(body).not.toContain('123456');
    expect(body).toContain('aidline_http_request_duration_seconds_bucket');
  });

  it('groups requests that match no route under "unmatched"', async () => {
    await app.inject({ url: '/this/route/does/not/exist' });
    const { body } = await app.inject({ url: '/metrics' });
    expect(body).toContain('route="unmatched",status="404"');
    expect(body).not.toContain('does/not/exist');
  });

  it('does not count its own scrapes', async () => {
    await app.inject({ url: '/metrics' });
    const { body } = await app.inject({ url: '/metrics' });
    expect(body).not.toContain('route="/metrics"');
  });

  it('reports indexer progress and lag from the database', async () => {
    await db.query(
      `INSERT INTO indexer_state (id, last_ledger, latest_ledger) VALUES (1, 1000, 1012)
       ON CONFLICT (id) DO UPDATE SET last_ledger = 1000, latest_ledger = 1012`,
    );
    const { body } = await app.inject({ url: '/metrics' });
    expect(body).toMatch(/^aidline_indexed_ledger 1000$/m);
    expect(body).toMatch(/^aidline_latest_ledger 1012$/m);
    expect(body).toMatch(/^aidline_indexer_lag_ledgers 12$/m);
  });

  it('is not registered when METRICS_ENABLED is false', async () => {
    const off = await buildApp({ ...config, METRICS_ENABLED: false }, db, { logger: false });
    const res = await off.inject({ url: '/metrics' });
    expect(res.statusCode).toBe(404);
    await off.close();
  });
});
