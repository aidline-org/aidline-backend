import { Keypair } from '@stellar/stellar-sdk';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Db } from '../src/db/pool.js';
import { notFound, pagination, stellarAddress } from '../src/lib/http.js';
import { setupApp } from './helpers.js';

describe('stellarAddress', () => {
  it('accepts a real account address', () => {
    expect(stellarAddress.safeParse(Keypair.random().publicKey()).success).toBe(true);
  });

  it('rejects a contract address, which starts with C', () => {
    const contract = 'C' + Keypair.random().publicKey().slice(1);
    expect(stellarAddress.safeParse(contract).success).toBe(false);
  });

  it('rejects the wrong length', () => {
    const address = Keypair.random().publicKey();
    expect(stellarAddress.safeParse(address.slice(0, 55)).success).toBe(false);
    expect(stellarAddress.safeParse(address + 'A').success).toBe(false);
  });

  it('rejects lowercase and characters outside base32', () => {
    const address = Keypair.random().publicKey();
    expect(stellarAddress.safeParse(address.toLowerCase()).success).toBe(false);
    expect(stellarAddress.safeParse('G' + '1'.repeat(55)).success).toBe(false);
  });

  it('rejects empty input', () => {
    expect(stellarAddress.safeParse('').success).toBe(false);
  });
});

describe('pagination', () => {
  it('defaults to the first 20 items', () => {
    expect(pagination.parse({})).toEqual({ limit: 20, offset: 0 });
  });

  it('coerces query strings to numbers', () => {
    expect(pagination.parse({ limit: '50', offset: '10' })).toEqual({ limit: 50, offset: 10 });
  });

  it('accepts the limit boundaries 1 and 100', () => {
    expect(pagination.parse({ limit: '1' }).limit).toBe(1);
    expect(pagination.parse({ limit: '100' }).limit).toBe(100);
  });

  it('rejects a limit of 0 or above 100', () => {
    expect(pagination.safeParse({ limit: '0' }).success).toBe(false);
    expect(pagination.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('rejects a negative offset and non integers', () => {
    expect(pagination.safeParse({ offset: '-1' }).success).toBe(false);
    expect(pagination.safeParse({ limit: '2.5' }).success).toBe(false);
    expect(pagination.safeParse({ limit: 'many' }).success).toBe(false);
  });
});

describe('notFound', () => {
  it('replies 404 with the standard error shape', () => {
    const send = vi.fn((body: unknown) => body);
    const code = vi.fn(() => ({ send }));

    const result = notFound({ code } as never, 'campaign');

    expect(code).toHaveBeenCalledWith(404);
    expect(send).toHaveBeenCalledWith({ error: 'not_found', message: 'campaign not found' });
    expect(result).toEqual({ error: 'not_found', message: 'campaign not found' });
  });
});

describe('error handler', () => {
  let app: FastifyInstance;
  let db: Db;
  const nested = z.object({ user: z.object({ profile: z.object({ name: z.string().min(2) }) }) });

  beforeAll(async () => {
    ({ app, db } = (await setupApp()) as { app: FastifyInstance; db: Db });

    app.post('/test/nested', async (req) => nested.parse(req.body));
    app.get('/test/client-error', async () => {
      throw Object.assign(new Error('Campaign has already closed'), { statusCode: 409 });
    });
    app.get('/test/crash', async () => {
      throw new Error('database password is hunter2');
    });
  });

  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it('turns a nested zod error into a 400 with a dotted path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/nested',
      payload: { user: { profile: { name: 'A' } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_error', message: 'Request is invalid' });
    expect(res.json().issues).toEqual([expect.objectContaining({ path: 'user.profile.name' })]);
  });

  it('passes a 4xx status and its message through', async () => {
    const res = await app.inject({ url: '/test/client-error' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'request_error',
      message: 'Campaign has already closed',
    });
  });

  it('replies with a generic 500 and does not leak the thrown message', async () => {
    const res = await app.inject({ url: '/test/crash' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error', message: 'Something went wrong' });
    expect(res.body).not.toContain('hunter2');
  });
});

describe('error responses are JSON', () => {
  let app: FastifyInstance;
  let db: Db;

  beforeAll(async () => {
    ({ app, db } = (await setupApp()) as { app: FastifyInstance; db: Db });

    app.post('/test/echo', async (req) => z.object({ name: z.string() }).parse(req.body));
    // A route with its own limit of one request a minute, so the 429 is easy to reach.
    app.get(
      '/test/once',
      { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } },
      async () => ({ ok: true }),
    );
  });

  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it.each([
    {
      name: '400 from a schema error',
      send: () => app.inject({ method: 'POST', url: '/test/echo', payload: {} }),
      status: 400,
      error: 'validation_error',
    },
    {
      name: '400 from a body that is not JSON',
      send: () =>
        app.inject({
          method: 'POST',
          url: '/test/echo',
          payload: '{',
          headers: { 'content-type': 'application/json' },
        }),
      status: 400,
      error: 'request_error',
    },
    {
      name: '404 for an unknown route',
      send: () => app.inject({ url: '/no-such-route' }),
      status: 404,
      error: 'not_found',
    },
    {
      name: '404 for a missing file under /uploads/',
      send: () => app.inject({ url: '/uploads/proofs/missing/0.png' }),
      status: 404,
      error: 'not_found',
    },
    {
      name: '413 for a body over the 1 MB limit',
      send: () =>
        app.inject({
          method: 'POST',
          url: '/test/echo',
          payload: JSON.stringify({ name: 'x'.repeat(1_100_000) }),
          headers: { 'content-type': 'application/json' },
        }),
      status: 413,
      error: 'request_error',
    },
  ])('replies with JSON for $name', async ({ send, status, error }) => {
    const res = await send();
    expect(res.statusCode).toBe(status);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.json()).toMatchObject({ error, message: expect.any(String) });
  });

  it('replies 429 with the same JSON shape once a route limit is used up', async () => {
    expect((await app.inject({ url: '/test/once' })).statusCode).toBe(200);

    const res = await app.inject({ url: '/test/once' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.json()).toMatchObject({ error: 'rate_limited', message: expect.any(String) });
  });
});
