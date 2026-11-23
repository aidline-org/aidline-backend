import { rpc, scValToNative } from '@stellar/stellar-sdk';

interface EventBase {
  eventId: string;
  ledger: number;
  txHash: string;
  closedAt: Date;
  contractId: string;
}

export type AidlineEvent = EventBase &
  (
    | { type: 'campaign_created'; campaignId: bigint }
    | { type: 'donated'; campaignId: bigint; donor: string; amount: bigint }
    | {
        type: 'milestone_released';
        campaignId: bigint;
        index: number;
        amount: bigint;
        proofUri: string;
      }
    | { type: 'campaign_cancelled'; campaignId: bigint }
    | { type: 'refunded'; campaignId: bigint; donor: string; amount: bigint }
    | { type: 'verifier_updated'; verifier: string; active: boolean }
    | { type: 'admin_added'; admin: string }
    | { type: 'admin_removed'; admin: string }
    | {
        type: 'pledge_created';
        campaignId: bigint;
        donor: string;
        pledgeId: bigint;
        amount: bigint;
      }
    | { type: 'pledge_pulled'; campaignId: bigint; donor: string; pledgeId: bigint; amount: bigint }
    | {
        type: 'pledge_skipped';
        campaignId: bigint;
        donor: string;
        pledgeId: bigint;
        reason: number;
      }
    | { type: 'pledge_settlement'; campaignId: bigint; milestoneIndex: number; amount: bigint }
    | { type: 'verifier_bond_posted'; verifier: string; amount: bigint }
    | { type: 'verifier_deregistered'; verifier: string; deregisteredAt: bigint }
    | { type: 'bond_withdrawn'; verifier: string; amount: bigint }
    | { type: 'bond_slashed'; verifier: string; campaignId: bigint; amount: bigint }
    | {
        type: 'emergency_advance_released';
        campaignId: bigint;
        verifier: string;
        milestoneIndex: number;
        amount: bigint;
      }
  );

/**
 * Turns a raw RPC event into a typed Aidline event. Returns null for events
 * this indexer does not know about, so new contract events never crash it.
 */
export function decodeEvent(ev: rpc.Api.EventResponse): AidlineEvent | null {
  const topics = ev.topic.map((t) => scValToNative(t));
  const data = (scValToNative(ev.value) ?? {}) as Record<string, unknown>;
  const base: EventBase = {
    eventId: ev.id,
    ledger: ev.ledger,
    txHash: ev.txHash,
    closedAt: new Date(ev.ledgerClosedAt),
    contractId: String(ev.contractId ?? ''),
  };

  switch (topics[0]) {
    case 'created':
    case 'campaign_created':
      return { ...base, type: 'campaign_created', campaignId: BigInt(topics[1]) };
    case 'donated':
      return {
        ...base,
        type: 'donated',
        campaignId: BigInt(topics[1]),
        donor: String(topics[2]),
        amount: BigInt(
          typeof data === 'object' && !Array.isArray(data) && 'amount' in data
            ? (data.amount as bigint)
            : scValToNative(ev.value),
        ),
      };
    case 'released':
    case 'milestone_released':
      return {
        ...base,
        type: 'milestone_released',
        campaignId: BigInt(topics[1]),
        index: topics[0] === 'released' ? Number(topics[2]) : Number(data.index),
        amount: BigInt(
          topics[0] === 'released' ? (data as unknown as unknown[])[0] : (data.amount as bigint),
        ),
        proofUri: String(
          topics[0] === 'released' ? (data as unknown as unknown[])[1] : data.proof_uri,
        ),
      };
    case 'canceled':
    case 'campaign_cancelled':
      return { ...base, type: 'campaign_cancelled', campaignId: BigInt(topics[1]) };
    case 'admin_added':
    case 'admin_add':
      return { ...base, type: 'admin_added', admin: String(topics[1] ?? data.admin) };
    case 'admin_removed':
    case 'admin_remove':
      return { ...base, type: 'admin_removed', admin: String(topics[1] ?? data.admin) };
    case 'refunded':
      return {
        ...base,
        type: 'refunded',
        campaignId: BigInt(topics[1]),
        donor: String(topics[2]),
        amount: BigInt(data.amount as bigint),
      };
    case 'verifier':
    case 'verifier_updated':
      return {
        ...base,
        type: 'verifier_updated',
        verifier: String(topics[1]),
        active: Boolean(topics[0] === 'verifier' ? scValToNative(ev.value) : data.active),
      };
    case 'pledge_created':
      return {
        ...base,
        type: 'pledge_created',
        campaignId: BigInt(topics[1]),
        donor: String(topics[2]),
        pledgeId: BigInt(data.pledge_id as bigint),
        amount: BigInt(data.pledged_amount as bigint),
      };
    case 'pledge_pulled':
      return {
        ...base,
        type: 'pledge_pulled',
        campaignId: BigInt(topics[1]),
        donor: String(topics[2]),
        pledgeId: BigInt(data.pledge_id as bigint),
        amount: BigInt(data.pulled_amount as bigint),
      };
    case 'pledge_skipped':
      return {
        ...base,
        type: 'pledge_skipped',
        campaignId: BigInt(topics[1]),
        donor: String(topics[2]),
        pledgeId: BigInt(data.pledge_id as bigint),
        reason: Number(data.reason),
      };
    case 'pledge_settlement':
      return {
        ...base,
        type: 'pledge_settlement',
        campaignId: BigInt(topics[1]),
        milestoneIndex: Number(data.milestone_index),
        amount: BigInt(data.total_pledged_pulled as bigint),
      };
    case 'verifier_bond_posted':
      return {
        ...base,
        type: 'verifier_bond_posted',
        verifier: String(topics[1]),
        amount: BigInt(data.amount as bigint),
      };
    case 'verifier_deregistered':
      return {
        ...base,
        type: 'verifier_deregistered',
        verifier: String(topics[1]),
        deregisteredAt: BigInt(data.deregistered_at as bigint),
      };
    case 'bond_withdrawn':
      return {
        ...base,
        type: 'bond_withdrawn',
        verifier: String(topics[1]),
        amount: BigInt(data.amount as bigint),
      };
    case 'bond_slashed':
      return {
        ...base,
        type: 'bond_slashed',
        verifier: String(topics[1]),
        campaignId: BigInt(topics[2]),
        amount: BigInt(data.slashed_amount as bigint),
      };
    case 'emergency_advance_released':
      return {
        ...base,
        type: 'emergency_advance_released',
        campaignId: BigInt(topics[1]),
        verifier: String(topics[2]),
        milestoneIndex: Number(data.milestone_index),
        amount: BigInt(data.amount as bigint),
      };
    default:
      return null;
  }
}
