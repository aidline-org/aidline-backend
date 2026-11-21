import { randomUUID } from 'node:crypto';

import { Keypair } from '@stellar/stellar-sdk';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { stellarAddress } from './http.js';

/**
 * Wallet signature authentication (SEP-53 style).
 *
 * A client proves control of a Stellar address by signing a short, human
 * readable message with `Keypair.signMessage` (which hashes
 * `"Stellar Signed Message:\n" + message` with SHA-256 before signing). The
 * signature and the inputs are sent as headers. Nothing here invents a new
 * cryptographic scheme: verification is delegated to `Keypair.verifyMessage`
 * from the Stellar SDK.
 *
 * Two details make a captured signature useless to an attacker:
 *
 *  - `timestamp` is bounded to a small clock-skew window, and
 *  - `nonce` is one-time, tracked in memory until the window closes.
 *
 * The `purpose` is part of the signed text, so an admin signature cannot be
 * replayed as an upload signature (or vice versa). Routes that act on a
 * campaign also bind its id into the message and require the matching header.
 */

const signedHeaders = z.object({
  'x-stellar-address': stellarAddress,
  'x-stellar-signature': z
    .string()
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be a base64 encoded signature')
    .length(88, 'must be a 64-byte ed25519 signature'),
  'x-stellar-timestamp': z.coerce.number().int().positive(),
  'x-stellar-nonce': z.string().min(8).max(128),
  'x-stellar-campaign': z.string().regex(/^\d+$/).optional(),
});

export interface SignedIdentity {
  address: string;
  campaignId?: string;
}

export interface SignRequestOptions {
  /** Bound into the signed text so the signature only works for this campaign. */
  campaignId?: string;
  /** Injectable for deterministic tests. */
  timestamp?: number;
  nonce?: string;
}

/** The exact human readable text a client signs, shared by signer and verifier. */
export function buildSignedMessage(input: {
  purpose: string;
  address: string;
  timestamp: number;
  nonce: string;
  extra?: Record<string, string>;
}): string {
  const lines = [
    'Aidline signed request',
    `purpose: ${input.purpose}`,
    `address: ${input.address}`,
    `timestamp: ${input.timestamp}`,
    `nonce: ${input.nonce}`,
  ];
  for (const key of Object.keys(input.extra ?? {}).sort()) {
    lines.push(`${key}: ${input.extra?.[key]}`);
  }
  return lines.join('\n');
}

/** Convenience helper used by tests and documented for frontend clients. */
export function signRequest(
  keypair: Keypair,
  purpose: string,
  options: SignRequestOptions = {},
): Record<string, string> {
  const timestamp = options.timestamp ?? Date.now();
  const nonce = options.nonce ?? randomUUID();
  const message = buildSignedMessage({
    purpose,
    address: keypair.publicKey(),
    timestamp,
    nonce,
    extra: options.campaignId ? { campaign: options.campaignId } : undefined,
  });
  return {
    'x-stellar-address': keypair.publicKey(),
    'x-stellar-signature': Buffer.from(keypair.signMessage(message)).toString('base64'),
    'x-stellar-timestamp': String(timestamp),
    'x-stellar-nonce': nonce,
    ...(options.campaignId ? { 'x-stellar-campaign': options.campaignId } : {}),
  };
}

const MAX_AGE_MS = 5 * 60 * 1000;
const usedNonces = new Map<string, number>();

function isFresh(now: number, timestamp: number): boolean {
  return Math.abs(now - timestamp) <= MAX_AGE_MS;
}

function consumeOnce(key: string, now: number): boolean {
  for (const [stored, expiresAt] of usedNonces) {
    if (expiresAt <= now) usedNonces.delete(stored);
  }
  if (usedNonces.has(key)) return false;
  usedNonces.set(key, now + MAX_AGE_MS);
  return true;
}

function reject(reply: FastifyReply, status: number, message: string): undefined {
  reply.code(status).send({ error: status === 403 ? 'forbidden' : 'unauthorized', message });
  return undefined;
}

/**
 * Verifies the signed headers on a request. Returns the signer's address (and
 * campaign id, when required) on success, or `undefined` after sending an
 * error response.
 */
export function verifySignedRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  purpose: string,
  options: { expectedAddress?: string; requireCampaign?: boolean } = {},
): SignedIdentity | undefined {
  const parsed = signedHeaders.safeParse(req.headers);
  if (!parsed.success) {
    return reject(reply, 401, 'A valid wallet signature is required');
  }
  const h = parsed.data;
  const now = Date.now();
  if (!isFresh(now, h['x-stellar-timestamp'])) {
    return reject(reply, 401, 'Signature has expired');
  }
  if (options.requireCampaign && !h['x-stellar-campaign']) {
    return reject(reply, 401, 'A campaign id is required');
  }
  if (options.expectedAddress && h['x-stellar-address'] !== options.expectedAddress) {
    return reject(reply, 403, 'This wallet is not allowed to perform this action');
  }

  const extra = h['x-stellar-campaign'] ? { campaign: h['x-stellar-campaign'] } : undefined;
  const message = buildSignedMessage({
    purpose,
    address: h['x-stellar-address'],
    timestamp: h['x-stellar-timestamp'],
    nonce: h['x-stellar-nonce'],
    extra,
  });

  let valid: boolean;
  try {
    valid = Keypair.fromPublicKey(h['x-stellar-address']).verifyMessage(
      message,
      Buffer.from(h['x-stellar-signature'], 'base64'),
    );
  } catch {
    valid = false;
  }
  if (!valid) return reject(reply, 401, 'Signature does not match the claimed address');

  // Only consume the nonce after the signature is known to be good, so a
  // random caller cannot burn somebody else's nonce.
  if (!consumeOnce(`${purpose}:${h['x-stellar-address']}:${h['x-stellar-nonce']}`, now)) {
    return reject(reply, 401, 'Signature has already been used');
  }

  return { address: h['x-stellar-address'], campaignId: h['x-stellar-campaign'] };
}
