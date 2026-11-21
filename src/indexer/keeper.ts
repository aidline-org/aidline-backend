import type { Db } from '../db/pool.js';
import type { ContractTtlExtender } from '../stellar/contract.js';

/**
 * #22: keeps long running campaigns from falling out of contract storage.
 *
 * Soroban entries have a ledger based TTL. We know when a campaign was first
 * seen (`created_ledger`) and when the keeper last extended it
 * (`ttl_extended_ledger`), so a campaign is "near expiry" when that ledger is
 * older than `campaignTtlLedgers - thresholdLedgers`. After a successful
 * transaction we record the new anchor ledger, which makes repeated runs
 * idempotent until the next window opens.
 *
 * `CAMPAIGN_TTL_LEDGERS` must be kept in sync with the contract's configured
 * TTL. The keeper never guesses balances or touches funds: it only invokes
 * `extend_campaign_ttl` with a funded key from the environment.
 */
export interface KeeperOptions {
  intervalMs: number;
  campaignTtlLedgers: number;
  thresholdLedgers: number;
}

export interface KeeperLog {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg: string): void;
}

export async function bumpExpiringCampaignTtls(
  db: Db,
  extender: ContractTtlExtender,
  log: KeeperLog,
  opts: KeeperOptions,
): Promise<number> {
  const state = await db.query<{ latest_ledger: string | null }>(
    'SELECT latest_ledger FROM indexer_state WHERE id = 1',
  );
  const latest = state.rows[0]?.latest_ledger;
  if (latest == null) {
    log.warn('keeper: no indexed ledger yet, skipping TTL check');
    return 0;
  }

  const currentLedger = Number(latest);
  const cutoff = currentLedger - (opts.campaignTtlLedgers - opts.thresholdLedgers);
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM campaigns
      WHERE status = 'active'
        AND COALESCE(ttl_extended_ledger, created_ledger) <= $1
      ORDER BY id`,
    [cutoff],
  );

  let bumped = 0;
  for (const row of rows) {
    const id = BigInt(row.id);
    try {
      await extender.extendCampaignTtl(id);
      await db.query('UPDATE campaigns SET ttl_extended_ledger = $1 WHERE id = $2', [
        currentLedger,
        row.id,
      ]);
      bumped += 1;
      log.info({ campaignId: row.id, ledger: currentLedger }, 'keeper: extended campaign TTL');
    } catch (err) {
      // One bad campaign must not stop the rest of the batch.
      log.error({ err, campaignId: row.id }, 'keeper: failed to extend campaign TTL');
    }
  }
  return bumped;
}

/** Runs the keeper immediately, then on a timer. Returns the timer to clear on shutdown. */
export function startTtlKeeperScheduler(
  db: Db,
  extender: ContractTtlExtender,
  log: KeeperLog,
  opts: KeeperOptions,
): NodeJS.Timeout {
  const run = async () => {
    try {
      await bumpExpiringCampaignTtls(db, extender, log, opts);
    } catch (err) {
      log.error({ err }, 'keeper: TTL sweep failed');
    }
  };
  void run();
  return setInterval(() => void run(), opts.intervalMs);
}
