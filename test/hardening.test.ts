import type { FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/pool.js';
import { setupApp } from './helpers.js';

const { app, db, config } = (await setupApp()) as {
  app: FastifyInstance;
  db: Db;
  config: ReturnType<typeof loadConfig>;
};

afterAll(async () => {
  await app.close();
  await db.end();
});

function multipart(parts: string[]) {
  const boundary = '----aidline';
  return {
    payload: [...parts.map((p) => `--${boundary}\r\n${p}`), `--${boundary}--\r\n`].join('\r\n'),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

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

describe('proof upload file names', () => {
  it('stores the file with an extension taken from its type, not its name', async () => {
    const { payload, headers } = multipart([
      'Content-Disposition: form-data; name="campaignId"\r\n\r\n0',
      'Content-Disposition: form-data; name="milestoneIndex"\r\n\r\n0',
      'Content-Disposition: form-data; name="note"\r\n\r\nWater tanks delivered to 3 camps',
      'Content-Disposition: form-data; name="files"; filename="evil.html"\r\nContent-Type: image/png\r\n\r\n<script>alert(1)</script>',
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
    const { payload, headers } = multipart([
      'Content-Disposition: form-data; name="campaignId"\r\n\r\n0',
      'Content-Disposition: form-data; name="milestoneIndex"\r\n\r\n0',
      'Content-Disposition: form-data; name="note"\r\n\r\nWater tanks delivered to 3 camps',
      `Content-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\nDATA`,
    ]);
    const upload = await app.inject({ method: 'POST', url: '/proofs', payload, headers });
    expect(upload.statusCode).toBe(201);
    expect(upload.json().files[0].url.endsWith(`/0${extension}`)).toBe(true);
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
