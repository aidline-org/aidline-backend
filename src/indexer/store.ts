import type { PoolClient } from 'pg';

import { metadataIdFromUri, proofIdFromUri } from '../lib/uris.js';
import type { ChainCampaign } from '../stellar/contract.js';
import type { AidlineEvent } from '../stellar/events.js';
import { enqueueReleaseWebhook } from '../webhooks/deliveries.js';

export async function upsertCampaign(
  client: PoolClient,
  c: ChainCampaign,
  seenAt: { ledger: number; closedAt: Date },
): Promise<void> {
  const metadataId = metadataIdFromUri(c.metadataUri);
  // Only link metadata we actually have, so a foreign URI never breaks the FK.
  const { rowCount } = metadataId
    ? await client.query('SELECT 1 FROM campaign_metadata WHERE id = $1', [metadataId])
    : { rowCount: 0 };

  await client.query(
    `INSERT INTO campaigns (id, creator, beneficiary, verifier, kind, metadata_uri, metadata_id,
       goal, deadline, milestones, milestones_released, raised, released, status,
       created_ledger, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9), $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (id) DO UPDATE SET
       verifier = EXCLUDED.verifier,
       metadata_id = COALESCE(campaigns.metadata_id, EXCLUDED.metadata_id),
       milestones_released = EXCLUDED.milestones_released,
       raised = EXCLUDED.raised,
       released = EXCLUDED.released,
       status = EXCLUDED.status,
       updated_at = now()`,
    [
      c.id.toString(),
      c.creator,
      c.beneficiary,
      c.verifier,
      c.kind,
      c.metadataUri,
      rowCount ? metadataId : null,
      c.goal.toString(),
      c.deadline.toString(),
      c.milestones.map((m) => m.toString()),
      c.milestonesReleased,
      c.raised.toString(),
      c.released.toString(),
      c.status,
      seenAt.ledger,
      seenAt.closedAt,
    ],
  );
}

export async function recordEvent(client: PoolClient, ev: AidlineEvent): Promise<void> {
  const common = [ev.eventId, ev.ledger, ev.txHash, ev.closedAt] as const;

  await client.query(
    `INSERT INTO indexed_events (event_id, contract_id, event_type, ledger, tx_hash, payload, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
    [
      ev.eventId,
      ev.contractId,
      ev.type,
      ev.ledger,
      ev.txHash,
      JSON.stringify(ev, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      ev.closedAt,
    ],
  );

  switch (ev.type) {
    case 'sponsor_pool_deposited':
      await client.query(
        `INSERT INTO sponsor_pool_deposits
         (event_id, ledger, tx_hash, created_at, campaign_id, sponsor, amount, ratio_bps, cap)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [
          ...common,
          ev.campaignId.toString(),
          ev.sponsor,
          ev.amount.toString(),
          ev.ratioBps,
          ev.cap.toString(),
        ],
      );
      return;
    case 'sponsor_pool_matched':
      await client.query(
        `INSERT INTO sponsor_pool_matches
         (event_id, ledger, tx_hash, created_at, campaign_id, sponsor, donor, donation_amount, matched_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [
          ...common,
          ev.campaignId.toString(),
          ev.sponsor,
          ev.donor,
          ev.donationAmount.toString(),
          ev.matchedAmount.toString(),
        ],
      );
      return;
    case 'sponsor_pool_returned':
      await client.query(
        `INSERT INTO sponsor_pool_returns
         (event_id, ledger, tx_hash, created_at, campaign_id, sponsor, amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [...common, ev.campaignId.toString(), ev.sponsor, ev.amount.toString()],
      );
      return;
    case 'campaign_created':
      // The campaign row is written by upsertCampaign. Pin its creation time
      // to this event in case it was first seen through a later event.
      await client.query(
        'UPDATE campaigns SET created_ledger = $2, created_at = $3, created_event_id = $4 WHERE id = $1',
        [ev.campaignId.toString(), ev.ledger, ev.closedAt, ev.eventId],
      );
      return;

    case 'donated':
      await client.query(
        `INSERT INTO donations (event_id, ledger, tx_hash, created_at, campaign_id, donor, amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
        [...common, ev.campaignId.toString(), ev.donor, ev.amount.toString()],
      );
      return;

    case 'refunded':
      await client.query(
        `INSERT INTO refunds (event_id, ledger, tx_hash, created_at, campaign_id, donor, amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
        [...common, ev.campaignId.toString(), ev.donor, ev.amount.toString()],
      );
      return;

    case 'milestone_released': {
      const proofId = proofIdFromUri(ev.proofUri);
      const { rowCount } = proofId
        ? await client.query('SELECT 1 FROM proofs WHERE id = $1', [proofId])
        : { rowCount: 0 };
      await client.query(
        `INSERT INTO milestone_releases
           (event_id, ledger, tx_hash, created_at, campaign_id, index, amount, proof_uri, proof_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
        [
          ...common,
          ev.campaignId.toString(),
          ev.index,
          ev.amount.toString(),
          ev.proofUri,
          rowCount ? proofId : null,
        ],
      );
      // Webhook jobs are enqueued in the same transaction. A delivery failure
      // never blocks indexing, and a replayed event cannot enqueue twice.
      await enqueueReleaseWebhook(client, ev);
      return;
    }

    case 'campaign_cancelled':
      await client.query(
        `UPDATE campaigns SET status='cancelled', cancelled_ledger=$2, cancelled_tx_hash=$3,
         cancelled_at=$4, updated_at=now() WHERE id=$1`,
        [ev.campaignId.toString(), ev.ledger, ev.txHash, ev.closedAt],
      );
      return;

    case 'admin_added':
    case 'admin_removed':
      await client.query(
        `INSERT INTO admin_changes (event_id, contract_id, admin, action, ledger, tx_hash, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [
          ev.eventId,
          ev.contractId,
          ev.admin,
          ev.type === 'admin_added' ? 'added' : 'removed',
          ev.ledger,
          ev.txHash,
          ev.closedAt,
        ],
      );
      return;

    case 'verifier_updated':
      await client.query(
        `INSERT INTO verifiers (address, active) VALUES ($1, $2)
         ON CONFLICT (address) DO UPDATE SET active = EXCLUDED.active, updated_at = now()`,
        [ev.verifier, ev.active],
      );
      return;
    case 'pledge_created':
      await client.query(
        `INSERT INTO pledge_events (event_id,event_type,pledge_id,campaign_id,donor,amount,ledger,tx_hash,created_at) VALUES ($1,'created',$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [
          ev.eventId,
          ev.pledgeId.toString(),
          ev.campaignId.toString(),
          ev.donor,
          ev.amount.toString(),
          ev.ledger,
          ev.txHash,
          ev.closedAt,
        ],
      );
      await client.query(
        `INSERT INTO pledges (pledge_id,campaign_id,donor,pledged_amount) VALUES ($1,$2,$3,$4) ON CONFLICT (pledge_id) DO UPDATE SET campaign_id=EXCLUDED.campaign_id, donor=EXCLUDED.donor, pledged_amount=EXCLUDED.pledged_amount, updated_at=now()`,
        [ev.pledgeId.toString(), ev.campaignId.toString(), ev.donor, ev.amount.toString()],
      );
      return;
    case 'pledge_pulled':
      await client.query(
        `INSERT INTO pledge_events (event_id,event_type,pledge_id,campaign_id,donor,amount,ledger,tx_hash,created_at) VALUES ($1,'pulled',$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [
          ev.eventId,
          ev.pledgeId.toString(),
          ev.campaignId.toString(),
          ev.donor,
          ev.amount.toString(),
          ev.ledger,
          ev.txHash,
          ev.closedAt,
        ],
      );
      await client.query(
        `UPDATE pledges SET pulled_amount=pulled_amount+$2,status='pulled',updated_at=now() WHERE pledge_id=$1`,
        [ev.pledgeId.toString(), ev.amount.toString()],
      );
      return;
    case 'pledge_skipped':
      await client.query(
        `INSERT INTO pledge_events (event_id,event_type,pledge_id,campaign_id,donor,reason,ledger,tx_hash,created_at) VALUES ($1,'skipped',$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [
          ev.eventId,
          ev.pledgeId.toString(),
          ev.campaignId.toString(),
          ev.donor,
          ev.reason,
          ev.ledger,
          ev.txHash,
          ev.closedAt,
        ],
      );
      await client.query(
        `UPDATE pledges SET status='skipped',skipped_reason=$2,updated_at=now() WHERE pledge_id=$1`,
        [ev.pledgeId.toString(), ev.reason],
      );
      return;
    case 'pledge_settlement':
      await client.query(
        `INSERT INTO pledge_events (event_id,event_type,campaign_id,donor,amount,milestone_index,ledger,tx_hash,created_at) VALUES ($1,'settled',$2,'',$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [
          ev.eventId,
          ev.campaignId.toString(),
          ev.amount.toString(),
          ev.milestoneIndex,
          ev.ledger,
          ev.txHash,
          ev.closedAt,
        ],
      );
      await client.query(
        `UPDATE pledges SET status='settled',settled_at=$2,updated_at=now() WHERE campaign_id=$1 AND status='active'`,
        [ev.campaignId.toString(), ev.closedAt],
      );
      return;
    case 'verifier_bond_posted':
      await client.query(
        `INSERT INTO verifier_bond_events (event_id,event_type,verifier,amount,ledger,tx_hash,created_at) VALUES ($1,'posted',$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [ev.eventId, ev.verifier, ev.amount.toString(), ev.ledger, ev.txHash, ev.closedAt],
      );
      await client.query(
        `INSERT INTO verifiers (address,bond_amount,active) VALUES ($1,$2,true) ON CONFLICT (address) DO UPDATE SET bond_amount=verifiers.bond_amount+$2,updated_at=now()`,
        [ev.verifier, ev.amount.toString()],
      );
      return;
    case 'verifier_deregistered':
      await client.query(
        `INSERT INTO verifier_bond_events (event_id,event_type,verifier,amount,ledger,tx_hash,created_at) VALUES ($1,'deregistered',$2,0,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [ev.eventId, ev.verifier, ev.ledger, ev.txHash, ev.closedAt],
      );
      await client.query(
        `UPDATE verifiers SET deregistered_at=to_timestamp($2),updated_at=now() WHERE address=$1`,
        [ev.verifier, ev.deregisteredAt.toString()],
      );
      return;
    case 'bond_withdrawn':
      await client.query(
        `INSERT INTO verifier_bond_events (event_id,event_type,verifier,amount,ledger,tx_hash,created_at) VALUES ($1,'withdrawn',$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [ev.eventId, ev.verifier, ev.amount.toString(), ev.ledger, ev.txHash, ev.closedAt],
      );
      await client.query(
        `UPDATE verifiers SET bond_amount=GREATEST(0,bond_amount-$2),updated_at=now() WHERE address=$1`,
        [ev.verifier, ev.amount.toString()],
      );
      return;
    case 'bond_slashed':
      await client.query(
        `INSERT INTO verifier_bond_events (event_id,event_type,verifier,campaign_id,amount,ledger,tx_hash,created_at) VALUES ($1,'slashed',$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [
          ev.eventId,
          ev.verifier,
          ev.campaignId.toString(),
          ev.amount.toString(),
          ev.ledger,
          ev.txHash,
          ev.closedAt,
        ],
      );
      await client.query(
        `UPDATE verifiers SET bond_amount=GREATEST(0,bond_amount-$2),ever_slashed=true,updated_at=now() WHERE address=$1`,
        [ev.verifier, ev.amount.toString()],
      );
      return;
    case 'emergency_advance_released':
      await client.query(
        `INSERT INTO emergency_advances (event_id,campaign_id,verifier,milestone_index,amount,ledger,tx_hash,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [
          ev.eventId,
          ev.campaignId.toString(),
          ev.verifier,
          ev.milestoneIndex,
          ev.amount.toString(),
          ev.ledger,
          ev.txHash,
          ev.closedAt,
        ],
      );
      return;
  }
}
