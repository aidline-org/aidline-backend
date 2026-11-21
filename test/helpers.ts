import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Address, Keypair, nativeToScVal, rpc, xdr } from '@stellar/stellar-sdk';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createPool, type Db } from '../src/db/pool.js';
import { signRequest } from '../src/lib/auth.js';
import type { ChainCampaign } from '../src/stellar/contract.js';
import { TEST_DB_PORT } from './global-setup.js';

export const CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

/** Ephemeral testnet keypairs: generated at runtime, never committed. */
export const adminKeypair = Keypair.random();
export const uploaderKeypair = Keypair.random();

export { signRequest };

export async function setupApp() {
  const config = loadConfig({
    DATABASE_URL: `postgres://aidline:aidline@localhost:${TEST_DB_PORT}/aidline_test`,
    PUBLIC_BASE_URL: 'http://api.test',
    AIDLINE_CONTRACT_ID: CONTRACT_ID,
    ADMIN_WALLET_ADDRESS: adminKeypair.publicKey(),
    UPLOAD_DIR: mkdtempSync(join(tmpdir(), 'aidline-uploads-')),
  });
  const db = createPool(config.DATABASE_URL);
  await migrate(db, () => {});
  await resetDb(db);
  const app = await buildApp(config, db, { logger: false });
  return { app, db, config };
}

export async function resetDb(db: Db) {
  await db.query(`TRUNCATE donations, refunds, milestone_releases, proofs, campaigns,
    campaign_metadata, verifiers, indexer_state, daily_stats_snapshots,
    webhook_deliveries, webhook_subscriptions, gdacs_alerts`);
}

export const account = () => Keypair.random().publicKey();

/** Minimal real magic bytes, enough for the upload validator to accept a file. */
export const MAGIC = {
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/webp': Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP'),
  ]),
  'application/pdf': Buffer.from('%PDF-1.7\n'),
} as const;

type MultipartPart =
  | { name: string; value: string }
  | { name: string; filename: string; contentType: string; content: Buffer };

/** Builds a multipart body as a Buffer so binary file bytes survive unchanged. */
export function multipartBody(parts: MultipartPart[], boundary = '----aidline') {
  const chunks = parts.flatMap((part) => {
    if (!('content' in part)) {
      return [
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n`),
        Buffer.from(part.value),
        Buffer.from('\r\n'),
      ];
    }
    return [
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; ` +
          `filename="${part.filename}"\r\nContent-Type: ${part.contentType}\r\n\r\n`,
      ),
      part.content,
      Buffer.from('\r\n'),
    ];
  });
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

export function chainCampaign(overrides: Partial<ChainCampaign> = {}): ChainCampaign {
  return {
    id: 0n,
    creator: account(),
    beneficiary: account(),
    verifier: account(),
    kind: 'emergency',
    metadataUri: 'ipfs://example',
    goal: 1000n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400),
    milestones: [300n, 300n, 400n],
    milestonesReleased: 0,
    raised: 0n,
    released: 0n,
    status: 'active',
    ...overrides,
  };
}

// Builders for raw RPC events, shaped exactly like soroban-rpc returns them.

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
const addr = (a: string) => Address.fromString(a).toScVal();
const dataMap = (entries: [string, xdr.ScVal][]) =>
  xdr.ScVal.scvMap(entries.map(([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: v })));

let seq = 0;
function rawEvent(topic: xdr.ScVal[], value: xdr.ScVal, ledger = 100): rpc.Api.EventResponse {
  seq += 1;
  return {
    id: `0000000${ledger}-${String(seq).padStart(10, '0')}`,
    type: 'contract',
    ledger,
    ledgerClosedAt: new Date().toISOString(),
    transactionIndex: 1,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: `tx${seq}`.padEnd(64, '0'),
    contractId: undefined,
    topic,
    value,
  } as unknown as rpc.Api.EventResponse;
}

export const events = {
  created: (id: bigint, creator: string) =>
    rawEvent(
      [sym('campaign_created'), u64(id)],
      dataMap([
        ['creator', addr(creator)],
        ['deadline', u64(1n)],
        ['goal', nativeToScVal(1000n, { type: 'i128' })],
        ['kind', xdr.ScVal.scvVec([sym('Emergency')])],
      ]),
    ),
  donated: (id: bigint, donor: string, amount: bigint) =>
    rawEvent(
      [sym('donated'), u64(id), addr(donor)],
      dataMap([['amount', nativeToScVal(amount, { type: 'i128' })]]),
    ),
  released: (id: bigint, index: number, amount: bigint, proofUri: string) =>
    rawEvent(
      [sym('milestone_released'), u64(id)],
      dataMap([
        ['amount', nativeToScVal(amount, { type: 'i128' })],
        ['index', nativeToScVal(index, { type: 'u32' })],
        ['proof_uri', nativeToScVal(proofUri, { type: 'string' })],
      ]),
    ),
  refunded: (id: bigint, donor: string, amount: bigint) =>
    rawEvent(
      [sym('refunded'), u64(id), addr(donor)],
      dataMap([['amount', nativeToScVal(amount, { type: 'i128' })]]),
    ),
  verifier: (verifier: string, active: boolean) =>
    rawEvent(
      [sym('verifier_updated'), addr(verifier)],
      dataMap([['active', xdr.ScVal.scvBool(active)]]),
    ),
};
