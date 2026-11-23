import type { FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';

import type { Db } from '../src/db/pool.js';
import { account, setupApp } from './helpers.js';

const { app, db } = (await setupApp()) as { app: FastifyInstance; db: Db };

type Sent = Awaited<ReturnType<typeof app.inject>>;

afterAll(async () => {
  await app.close();
  await db.end();
});

/** Sends one request too many and checks the shared 429 error envelope. */
async function expectRateLimit(send: () => Promise<Sent>, limit: number) {
  for (let i = 0; i < limit; i++) {
    expect((await send()).statusCode).toBe(201);
  }

  const blocked = await send();
  expect(blocked.statusCode).toBe(429);
  expect(blocked.json()).toEqual({
    error: 'rate_limited',
    message: expect.any(String),
  });
  expect(blocked.headers['retry-after']).toBeDefined();
  expect(blocked.headers['x-request-id']).toBeTruthy();
}

const metadata = {
  title: 'Clean water after flooding in Les Cayes',
  summary:
    'Water storage and purification for families displaced by flooding on the southern coast.',
  description: 'The September floods displaced thousands of families. This campaign funds water.',
  location: 'Les Cayes, Haiti',
};

const application = {
  address: account(),
  orgName: 'Red Relief Network',
  country: 'Nigeria',
  description: 'Field verification partner for flood response in Kogi state.',
};

function proofRequest() {
  const boundary = '----aidline';
  const payload = [
    `--${boundary}\r\nContent-Disposition: form-data; name="campaignId"\r\n\r\n0`,
    `--${boundary}\r\nContent-Disposition: form-data; name="milestoneIndex"\r\n\r\n0`,
    `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nWater tanks delivered to 3 camps`,
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="tanks.png"\r\nContent-Type: image/png\r\n\r\nPNGDATA`,
    `--${boundary}--\r\n`,
  ].join('\r\n');
  return () =>
    app.inject({
      method: 'POST',
      url: '/proofs',
      payload,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
}

describe('per-route write rate limits', () => {
  it('limits POST /metadata', async () => {
    await expectRateLimit(
      () => app.inject({ method: 'POST', url: '/metadata', payload: metadata }),
      50,
    );
  });

  it('limits POST /proofs', async () => {
    await expectRateLimit(proofRequest(), 10);
  });

  it('limits POST /verifiers/applications', async () => {
    await expectRateLimit(
      () => app.inject({ method: 'POST', url: '/verifiers/applications', payload: application }),
      10,
    );
  });

  it('does not apply the write limit to reads', async () => {
    // Reads still use the generous global limit even after a write route is exhausted.
    const read = await app.inject({ url: '/campaigns' });
    expect(read.statusCode).toBe(200);
    expect(read.headers['x-ratelimit-limit']).toBe('300');
  });
});
