import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { Keypair } from '@stellar/stellar-sdk';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/pool.js';
import { account, MAGIC, multipartBody, setupApp } from './helpers.js';

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
     VALUES ('0', $1, $1, $2, 'emergency', 'ipfs://x', '1000', now(), '{500,500}', 'active', 1, now())
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

  it('reuses a valid incoming x-request-id and generates an id otherwise', async () => {
    const first = await app.inject({
      url: '/releases?limit=500',
      headers: { 'x-request-id': 'proxy-request-123' },
    });
    const second = await app.inject({
      url: '/releases?limit=500',
      headers: { 'x-request-id': 'invalid!id' },
    });
    expect(first.headers['x-request-id']).toBe('proxy-request-123');
    expect(first.json().requestId).toBe('proxy-request-123');
    expect(second.headers['x-request-id']).not.toBe('invalid!id');
    expect(second.json().requestId).toBe(second.headers['x-request-id']);
  });
});

describe('request logging', () => {
  it('redacts sensitive headers and logs request metadata without the body', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const loggedApp = await buildApp(config, db, { logger: { stream } });
    loggedApp.get('/test/logging', (req) => {
      req.log.info({ headers: req.headers }, 'captured request headers');
      return { note: 'response body is not logged' };
    });

    try {
      const secret = 'header-secret-value';
      const res = await loggedApp.inject({
        url: '/test/logging',
        headers: { authorization: `Bearer ${secret}`, 'x-request-id': 'log-request-1' },
      });
      expect(res.statusCode).toBe(200);
      expect(lines.join('')).toContain('[Redacted]');
      expect(lines.join('')).not.toContain(secret);
      expect(lines.join('')).not.toContain('response body is not logged');

      const completion = lines
        .map((line) => JSON.parse(line))
        .find((line) => line.msg === 'request completed');
      expect(completion).toMatchObject({
        reqId: 'log-request-1',
        method: 'GET',
        route: '/test/logging',
        status: 200,
      });
      expect(completion.duration).toBeTypeOf('number');
      expect(completion).not.toHaveProperty('body');
    } finally {
      await loggedApp.close();
    }
  });
});

describe('database outages', () => {
  it('returns 503 with Retry-After when the pool refuses connections', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5433'), {
      code: 'ECONNREFUSED',
    });
    const spy = vi.spyOn(db, 'query').mockRejectedValueOnce(refused);
    try {
      const res = await app.inject({ url: '/releases' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: 'unavailable' });
      expect(res.headers['retry-after']).toBe('10');
    } finally {
      spy.mockRestore();
    }
  });

  it('still returns 500 for other database errors', async () => {
    const failed = Object.assign(new Error('relation "campaigns" does not exist'), {
      code: '42P01',
    });
    const spy = vi.spyOn(db, 'query').mockRejectedValueOnce(failed);
    try {
      const res = await app.inject({ url: '/releases' });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ error: 'internal_error' });
    } finally {
      spy.mockRestore();
    }
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

  it.each([
    ['a campaign that does not exist', '99999', '0', /does not exist/],
    ['a milestone index past the last milestone', '0', '2', /no milestone 2/],
  ])(
    'rejects %s and removes the uploaded file',
    async (_case, campaignId, milestoneIndex, message) => {
      const before = await storedFiles(config.UPLOAD_DIR);
      const { payload, headers } = multipartBody([
        png(),
        { name: 'campaignId', value: campaignId },
        { name: 'milestoneIndex', value: milestoneIndex },
        { name: 'note', value: 'Water tanks delivered to 3 camps' },
      ]);
      const res = await app.inject({
        method: 'POST',
        url: '/proofs',
        payload,
        headers,
        remoteAddress: '10.0.0.3',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: 'invalid_target',
        message: expect.stringMatching(message),
      });
      expect(await storedFiles(config.UPLOAD_DIR)).toEqual(before);
    },
  );

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

describe('proof display names', () => {
  async function storedName(filename: string, type = 'image/png'): Promise<string> {
    const { payload, headers } = multipartBody([
      { name: 'campaignId', value: '0' },
      { name: 'milestoneIndex', value: '0' },
      { name: 'note', value: 'Water tanks delivered to 3 camps' },
      {
        name: 'files',
        filename,
        contentType: type,
        content: Buffer.concat([MAGIC['image/png'], Buffer.from('DATA')]),
      },
    ]);
    const upload = await app.inject({
      method: 'POST',
      url: '/proofs',
      payload,
      headers,
      remoteAddress: '10.0.0.2',
    });
    expect(upload.statusCode).toBe(201);
    return upload.json().files[0].name;
  }

  it('trims a very long name to 100 characters', async () => {
    expect(await storedName(`${'a'.repeat(5000)}.png`)).toBe('a'.repeat(100));
  });

  it('removes control characters and path separators', async () => {
    // Busboy already drops everything up to the last path separator, so only the tail arrives.
    expect(await storedName('../x\\na\u0007me\u001b\u007f.png')).toBe('name.png');
  });

  it('falls back to a numbered name when nothing is left', async () => {
    expect(await storedName('\u0001\u0002 ')).toBe('file-1.png');
  });
});

describe('strict JSON write bodies', () => {
  const metadata = {
    title: 'Flood relief for Kogi',
    summary: 'Clean water and shelter for displaced families.',
    description: 'Water tanks, tarpaulins and food for families displaced by the flood.',
    location: 'Lokoja, Nigeria',
  };
  const applicationBody = {
    address: account(),
    orgName: 'Red Relief Network',
    country: 'Nigeria',
    description: 'Field verification partner for flood response in Kogi state.',
  };

  it.each([
    ['/metadata', { ...metadata, imageURL: 'https://example.org/x.png' }, 'imageURL'],
    ['/verifiers/applications', { ...applicationBody, webSite: 'https://example.org' }, 'webSite'],
  ])('rejects a misspelt field on %s and names it', async (url, payload, field) => {
    const res = await app.inject({ method: 'POST', url, payload });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_error' });
    expect(JSON.stringify(res.json().issues)).toContain(field);
  });

  it.each(['/metadata', '/verifiers/applications'])(
    'rejects an oversized body on %s with 413',
    async (url) => {
      const res = await app.inject({
        method: 'POST',
        url,
        payload: { ...metadata, description: 'x'.repeat(100_000) },
      });
      expect(res.statusCode).toBe(413);
      expect(res.json()).toMatchObject({ error: 'request_error', message: expect.any(String) });
    },
  );
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

  it('requires a bearer token when METRICS_TOKEN is set', async () => {
    const secured = await buildApp({ ...config, METRICS_TOKEN: 'metrics-secret' }, db, {
      logger: false,
    });
    try {
      const denied = await secured.inject({ url: '/metrics' });
      expect(denied.statusCode).toBe(401);
      expect(denied.json()).toEqual({
        error: 'unauthorized',
        message: 'Metrics authorization required',
      });

      const allowed = await secured.inject({
        url: '/metrics',
        headers: { authorization: 'Bearer metrics-secret' },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.body).toContain('process_cpu_user_seconds_total');
    } finally {
      await secured.close();
    }
  });
});
