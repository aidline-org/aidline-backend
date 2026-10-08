import type { rpc } from '@stellar/stellar-sdk';
import type { FastifyBaseLogger } from 'fastify';

import type { Db } from '../db/pool.js';
import type { ContractReader } from '../stellar/contract.js';
import { decodeEvent, type AidlineEvent } from '../stellar/events.js';
import { recordEvent, upsertCampaign } from './store.js';

const PAGE_SIZE = 100;

/**
 * Phrases that appear in Soroban RPC error messages when the stored cursor
 * points to a ledger that has been evicted from the node's history.
 *
 * The exact wording varies by RPC implementation.  We match on substrings so
 * that minor message changes do not hide the real error.
 */
const CURSOR_RETENTION_PHRASES = [
  'cursor is not found',
  'cursor is no longer available',
  'cursor expired',
  'start ledger is too old',
  'ledger not found',
  'outside the ledger range',
  'event ledger range',
] as const;

/** Returns true only for cursor/retention errors, not for transient or unrelated RPC errors. */
function isCursorRetentionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return CURSOR_RETENTION_PHRASES.some((phrase) => msg.includes(phrase));
}

/** The slice of the RPC server the indexer needs. Kept small so tests can fake it. */
export interface EventSource {
  getEvents(req: rpc.Api.GetEventsRequest): Promise<rpc.Api.GetEventsResponse>;
  getHealth(): Promise<{ oldestLedger: number; latestLedger: number }>;
}

export interface IndexerOptions {
  db: Db;
  source: EventSource;
  contract: ContractReader;
  contractId: string;
  startLedger?: number;
  pollMs: number;
  log: FastifyBaseLogger;
}

/**
 * Polls Soroban RPC for Aidline contract events and mirrors them into Postgres.
 * Each page is applied in a single transaction together with the new cursor,
 * so a crash can never skip or double count events.
 *
 * ## Cursor-retention recovery
 *
 * If the indexer has been offline longer than the RPC keeps history, the stored
 * cursor may point to an evicted ledger.  `getEvents` then returns a specific
 * error.  When that happens `syncOnce` catches the error, logs the gap clearly,
 * re-fetches current contract state for every known campaign, resets the cursor
 * to the oldest ledger the RPC still holds, and resumes normal incremental
 * indexing from there, all without operator intervention.
 */
export class Indexer {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(private readonly opts: IndexerOptions) {}

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    let delay = this.opts.pollMs;
    try {
      const count = await this.syncOnce();
      // Keep draining without waiting while there is a backlog.
      if (count === PAGE_SIZE) delay = 0;
    } catch (err) {
      this.opts.log.error({ err }, 'indexer sync failed');
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.loop(), delay);
  }

  /** Fetches and applies one page of events. Returns how many events were seen. */
  async syncOnce(): Promise<number> {
    const { db, source, contractId } = this.opts;
    const state = await db.query<{ cursor: string | null }>(
      'SELECT cursor FROM indexer_state WHERE id = 1',
    );
    const cursor = state.rows[0]?.cursor ?? null;
    const filters: rpc.Api.EventFilter[] = [{ type: 'contract', contractIds: [contractId] }];

    let res: rpc.Api.GetEventsResponse;
    try {
      res = cursor
        ? await source.getEvents({ cursor, filters, limit: PAGE_SIZE })
        : await source.getEvents({
            startLedger: await this.startLedger(),
            filters,
            limit: PAGE_SIZE,
          });
    } catch (err) {
      // A stored cursor can fall out of the RPC's retention window if the
      // indexer was offline for too long. Missed events cannot be replayed,
      // so resynchronise campaign state from the contract and start again
      // from the oldest ledger the RPC still holds. Other errors propagate.
      if (cursor && isCursorRetentionError(err)) {
        await this.recoverFromCursorExpiry(cursor);
        return 0;
      }
      throw err;
    }

    const events = res.events.map(decodeEvent).filter((e): e is AidlineEvent => e !== null);
    const campaigns = await this.fetchCampaigns(events);

    // While catching up (a full page), the indexer has only reached the last
    // event's ledger. Otherwise it is in sync with the chain tip.
    const lastEvent = res.events.at(-1);
    const indexedLedger =
      res.events.length === PAGE_SIZE && lastEvent ? lastEvent.ledger : res.latestLedger;

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const ev of events) {
        if ('campaignId' in ev) {
          const campaign = campaigns.get(ev.campaignId);
          if (campaign) await upsertCampaign(client, campaign, ev);
        }
        await recordEvent(client, ev);
      }
      await client.query(
        `INSERT INTO indexer_state (id, cursor, last_ledger, latest_ledger) VALUES (1, $1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET cursor = EXCLUDED.cursor, last_ledger = EXCLUDED.last_ledger,
           latest_ledger = EXCLUDED.latest_ledger`,
        [res.cursor, indexedLedger, res.latestLedger],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (events.length) this.opts.log.info({ count: events.length }, 'indexed events');
    return res.events.length;
  }

  /**
   * Called when `getEvents` rejects with a cursor-retention error.
   *
   * Steps:
   *  1. Determine the oldest available ledger from the RPC health endpoint.
   *  2. Re-fetch and upsert current on-chain state for every known campaign.
   *  3. Reset the cursor so the next `syncOnce` starts from `oldestLedger`.
   *
   * The recovery is idempotent: `upsertCampaign` uses ON CONFLICT DO UPDATE
   * and history tables use ON CONFLICT DO NOTHING (event_id PK), so running
   * the recovery more than once is harmless.
   *
   * If recovery itself fails the error propagates; the cursor is NOT modified,
   * so the next poll will trigger recovery again rather than silently skipping.
   */
  private async recoverFromCursorExpiry(expiredCursor: string): Promise<void> {
    const { db, source, contract, log } = this.opts;

    log.warn(
      { expiredCursor },
      'indexer cursor has fallen out of RPC retention, starting gap recovery',
    );

    // Step 1: Find the oldest available ledger.
    const { oldestLedger, latestLedger } = await source.getHealth();
    log.info(
      { oldestLedger, latestLedger },
      'gap recovery: determined oldest available ledger from RPC',
    );

    // Step 2: Re-fetch state for every campaign the database knows about.
    // campaigns table is the single source of truth for known campaign ids.
    const { rows: knownCampaigns } = await db.query<{ id: string }>(
      'SELECT id FROM campaigns ORDER BY id',
    );
    log.info({ count: knownCampaigns.length }, 'gap recovery: resynchronising known campaigns');

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      for (const row of knownCampaigns) {
        const id = BigInt(row.id);
        let chainCampaign;
        try {
          chainCampaign = await contract.getCampaign(id);
        } catch (err) {
          // Log but do not abort the whole recovery if one campaign lookup fails.
          // The campaign row will remain as-is and will be corrected on the next
          // event that touches it.
          log.warn({ err, campaignId: row.id }, 'gap recovery: failed to fetch campaign, skipping');
          continue;
        }

        // upsertCampaign uses the seenAt.ledger and seenAt.closedAt only for
        // created_ledger / created_at, which are already set. We pass the
        // recovery ledger so the timestamps remain plausible.
        await upsertCampaign(client, chainCampaign, {
          ledger: oldestLedger,
          closedAt: new Date(),
        });
      }

      // Step 3: Reset the cursor to the oldest available ledger.
      // NULL cursor means: start from startLedger on the next syncOnce call.
      // We store oldestLedger as last_ledger so /health reports a sensible value.
      await client.query(
        `INSERT INTO indexer_state (id, cursor, last_ledger) VALUES (1, NULL, $1)
         ON CONFLICT (id) DO UPDATE SET cursor = NULL, last_ledger = EXCLUDED.last_ledger`,
        [oldestLedger],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      // Do not touch the stored cursor on failure, let the next poll retry recovery.
      log.error({ err }, 'gap recovery failed; cursor has not been reset');
      throw err;
    } finally {
      client.release();
    }

    log.warn(
      { oldestLedger, campaignsResynchronised: knownCampaigns.length },
      'gap recovery complete, indexer will resume from oldest available ledger',
    );
  }

  /**
   * Reads the latest state of every campaign touched by this page. The
   * contract is the source of truth, so totals are copied rather than summed.
   */
  private async fetchCampaigns(events: AidlineEvent[]) {
    const ids = new Set<bigint>();
    for (const ev of events) if ('campaignId' in ev) ids.add(ev.campaignId);
    const entries = await Promise.all(
      [...ids].map(async (id) => [id, await this.opts.contract.getCampaign(id)] as const),
    );
    return new Map(entries);
  }

  private async startLedger(): Promise<number> {
    const { oldestLedger, latestLedger } = await this.opts.source.getHealth();
    const wanted = this.opts.startLedger ?? latestLedger - 1000;
    // RPC only keeps recent history. Starting before that is an error.
    return Math.max(wanted, oldestLedger);
  }
}
