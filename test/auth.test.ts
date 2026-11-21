import { Keypair } from '@stellar/stellar-sdk';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../src/db/pool.js';
import { signRequest } from '../src/lib/auth.js';
import { account, resetDb, setupApp } from './helpers.js';

const { app, db } = (await setupApp()) as { app: FastifyInstance; db: Db };
const signer = Keypair.random();
const verifier = Keypair.random();
const stranger = Keypair.random();

const metadata = {
  title: 'Clean water after flooding in Les Cayes',
  summary:
    'Water storage and purification for families displaced by flooding on the southern coast.',
  description: 'The September floods displaced thousands of families. This campaign funds water.',
  location: 'Les Cayes, Haiti',
};

function proofRequest(headers: Record<string, string>) {
  const boundary = '----aidline';
  const payload = [
    `--${boundary}\r\nContent-Disposition: form-data; name="campaignId"\r\n\r\n0`,
    `--${boundary}\r\nContent-Disposition: form-data; name="milestoneIndex"\r\n\r\n0`,
    `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nWater tanks delivered to 3 camps`,
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="tanks.png"\r\nContent-Type: image/png\r\n\r\nPNGDATA`,
    `--${boundary}--\r\n`,
  ].join('\r\n');
  return app.inject({
    method: 'POST',
    url: '/proofs',
    payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, ...headers },
  });
}

describe('wallet signature authentication', () => {
  beforeEach(async () => {
    await resetDb(db);
    for (const id of ['0', '1']) {
      await db.query(
        `INSERT INTO campaigns
           (id, creator, beneficiary, verifier, kind, metadata_uri, goal, deadline,
            milestones, status, created_ledger, created_at)
         VALUES ($1, $2, $2, $3, 'emergency', 'ipfs://x', '1000', now(), '{}', 'active', 1, now())`,
        [id, account(), verifier.publicKey()],
      );
    }
  });

  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it('rejects unsigned metadata and proof uploads', async () => {
    expect(
      (await app.inject({ method: 'POST', url: '/metadata', payload: metadata })).statusCode,
    ).toBe(401);
    expect((await proofRequest({})).statusCode).toBe(401);
  });

  it('rejects a signature that does not match the claimed address', async () => {
    const headers = signRequest(signer, 'metadata:create');
    headers['x-stellar-address'] = stranger.publicKey();
    const res = await app.inject({
      method: 'POST',
      url: '/metadata',
      payload: metadata,
      headers,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toMatch(/does not match/);
  });

  it('rejects a malformed signature', async () => {
    const headers = signRequest(signer, 'metadata:create');
    headers['x-stellar-signature'] = Buffer.alloc(64).toString('base64');
    const res = await app.inject({
      method: 'POST',
      url: '/metadata',
      payload: metadata,
      headers,
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a valid signature and rejects a replay of it', async () => {
    const headers = signRequest(signer, 'metadata:create');
    const first = await app.inject({
      method: 'POST',
      url: '/metadata',
      payload: metadata,
      headers,
    });
    expect(first.statusCode).toBe(201);

    const replay = await app.inject({
      method: 'POST',
      url: '/metadata',
      payload: metadata,
      headers,
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().message).toMatch(/already been used/);
  });

  it('rejects expired signatures', async () => {
    const headers = signRequest(signer, 'metadata:create', { timestamp: Date.now() - 10 * 60_000 });
    const res = await app.inject({
      method: 'POST',
      url: '/metadata',
      payload: metadata,
      headers,
    });
    expect(res.statusCode).toBe(401);
  });

  it('lets only the campaign verifier upload proofs', async () => {
    const asVerifier = await proofRequest(
      signRequest(verifier, 'proof:upload', { campaignId: '0' }),
    );
    expect(asVerifier.statusCode).toBe(201);

    const asStranger = await proofRequest(
      signRequest(stranger, 'proof:upload', { campaignId: '0' }),
    );
    expect(asStranger.statusCode).toBe(403);
  });

  it('rejects a proof signature bound to a different campaign than the body', async () => {
    const headers = signRequest(verifier, 'proof:upload', { campaignId: '1' });
    const res = await proofRequest(headers);
    expect(res.statusCode).toBe(403);
  });
});
