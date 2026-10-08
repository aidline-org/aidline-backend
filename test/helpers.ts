import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Address, Keypair, nativeToScVal, rpc, xdr } from '@stellar/stellar-sdk';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createPool, type Db } from '../src/db/pool.js';
import type { ChainCampaign } from '../src/stellar/contract.js';
import { TEST_DB_PORT } from './global-setup.js';

export const CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

export async function setupApp() {
  const config = loadConfig({
    DATABASE_URL: `postgres://aidline:aidline@localhost:${TEST_DB_PORT}/aidline_test`,
    PUBLIC_BASE_URL: 'http://api.test',
    AIDLINE_CONTRACT_ID: CONTRACT_ID,
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
    campaign_metadata, verifiers, indexer_state, daily_stats_snapshots`);
}

export const account = () => Keypair.random().publicKey();

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
