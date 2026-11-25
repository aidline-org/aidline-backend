import type { rpc } from '@stellar/stellar-sdk';
import type { FastifyBaseLogger } from 'fastify';

import type { Db } from '../db/pool.js';
import type { ContractReader } from '../stellar/contract.js';
import { decodeEvent, type AidlineEvent } from '../stellar/events.js';
import { recordEvent, upsertCampaign } from './store.js';

const PAGE_SIZE = 100;
const CAMPAIGN_READ_CONCURRENCY = 5;
const MAX_FAILURE_BACKOFF_MS = 120_000;

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
  /** All deployed contract ids whose history should be indexed. */
  contractIds?: string[];
  startLedger?: number;
  pollMs: number;
  log: FastifyBaseLogger;
  /** Cleared after every successful write so cached reads never go stale. */
  cache?: { clear(): void };
  /** Called with the events of each committed write, for live streaming. */
  onCommit?: (events: AidlineEvent[]) => void;
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
  private inFlight: Promise<void> | null = null;
  private stopped = true;
  private consecutiveFailures = 0;
  private readonly warnedCampaigns = new Set<string>();

  constructor(private readonly opts: IndexerOptions) {}

  start(): void {
    this.stopped = false;
    this.consecutiveFailures = 0;
    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    let delay = this.opts.pollMs;
    try {
      const sync = this.syncOnce();
      this.inFlight = sync.then(
        () => undefined,
        () => undefined,
      );
      const count = await sync;
      // Keep draining without waiting while there is a backlog.
      if (count === PAGE_SIZE) delay = 0;
    } catch (err) {
      this.opts.log.error({ err }, 'indexer sync failed');
    } finally {
      this.inFlight = null;
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.loop(), delay);
  }

  /** Fetches and applies one page of events. Returns how many events were seen. */
  async syncOnce(): Promise<number> {
    const { db, source } = this.opts;
    const state = await db.query<{ cursor: string | null }>(
      'SELECT cursor FROM indexer_state WHERE id = 1',
    );
    const cursor = state.rows[0]?.cursor ?? null;
    const contractIds = this.opts.contractIds?.length
      ? this.opts.contractIds
      : [this.opts.contractId];
    const filters: rpc.Api.EventFilter[] = [{ type: 'contract', contractIds }];

    let res: rpc.Api.GetEventsResponse;
    try {
      if (!cursor) {
        const start = await this.startLedger();
        this.opts.log.info(
          { startLedger: start.ledger, source: start.source },
          'indexer starting from ledger on fresh database',
        );
        res = await source.getEvents({ startLedger: start.ledger, filters, limit: PAGE_SIZE });
      } else {
        res = await source.getEvents({ cursor, filters, limit: PAGE_SIZE });
      }
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

    // Decode each event independently. A malformed or newly introduced
    // event must be observable without aborting the rest of the page.
    const decoded = res.events.map((raw) => {
      try {
        return { raw, event: decodeEvent(raw) };
      } catch (err) {
        this.opts.log.warn(
          { err, eventId: raw.id, ledger: raw.ledger },
          'failed to decode event; recording it as unknown',
        );
        return { raw, event: null };
      }
    });
    const events = decoded
      .map(({ event }) => event)
      .filter((e): e is AidlineEvent => e !== null);
    const unknown = decoded.filter(({ event }) => event === null).map(({ raw }) => raw);
    const campaigns = await this.fetchCampaigns(events);

    // While catching up (a full page), the indexer has only reached the last
    // event's ledger. Otherwise it is in sync with the chain tip.
    const lastEvent = res.events.at(-1);
    const indexedLedger =
      res.events.length === PAGE_SIZE && lastEvent ? lastEvent.ledger : res.latestLedger;

    const client = await db.connect();
    const recorded: AidlineEvent[] = [];
    try {
      await client.query('BEGIN');
      for (const raw of unknown) {
        this.opts.log.warn(
          { eventId: raw.id, ledger: raw.ledger, contractId: raw.contractId },
          'indexed event has an unknown type',
        );
        await client.query(
          `INSERT INTO indexed_events (event_id, contract_id, event_type, ledger, tx_hash, payload, created_at)
           VALUES ($1,$2,'unknown',$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [
            raw.id,
            String(raw.contractId ?? ''),
            raw.ledger,
            raw.txHash,
            JSON.stringify(raw),
            new Date(raw.ledgerClosedAt),
          ],
        );
      }
      for (const ev of events) {
        if ('campaignId' in ev) {
          const campaign = campaigns.get(ev.campaignId);
          if (campaign) {
            await upsertCampaign(client, campaign, ev);
          } else {
            await client.query(
              'INSERT INTO campaign_refresh_queue (campaign_id) VALUES ($1) ON CONFLICT DO NOTHING',
              [ev.campaignId.toString()],
            );
            await client.query(
              'INSERT INTO pending_campaign_events (event_id, campaign_id, payload) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
              [
                ev.eventId,
                ev.campaignId.toString(),
                JSON.stringify(ev, (_key, value: unknown) =>
                  typeof value === 'bigint' ? value.toString() : value,
                ),
              ],
            );
            continue;
          }
        }
        await recordEvent(client, ev);
        recorded.push(ev);
      }
      await client.query(
        `INSERT INTO indexer_state (id, cursor, last_ledger, latest_ledger, updated_at)
         VALUES (1, $1, $2, $3, now())
         ON CONFLICT (id) DO UPDATE SET cursor = EXCLUDED.cursor, last_ledger = EXCLUDED.last_ledger,
           latest_ledger = EXCLUDED.latest_ledger, updated_at = now()`,
        [res.cursor, indexedLedger, res.latestLedger],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    this.publish(recorded);
    await this.retryPendingCampaigns();

    // A committed write makes cached aggregates stale, so drop them immediately.
    this.opts.cache?.clear();
    if (events.length) this.opts.log.info({ count: events.length }, 'indexed events');
    return res.events.length;
  }

  /** Rebuilds current campaign state after a database loss, then resumes from RPC history. */
  async reindex(): Promise<number> {
    if (!this.opts.contract.getCampaignCount)
      throw new Error('contract reader does not support campaign_count');
    const count = await this.opts.contract.getCampaignCount();
    const client = await this.opts.db.connect();
    try {
      await client.query('BEGIN');
      for (let id = 1n; id <= count; id++) {
        const campaign = await this.opts.contract.getCampaign(id);
        await upsertCampaign(client, campaign, { ledger: 0, closedAt: new Date() });
      }
      await client.query(
        `INSERT INTO indexer_state (id,cursor,last_ledger,updated_at) VALUES (1,NULL,NULL,now()) ON CONFLICT (id) DO UPDATE SET cursor=NULL, updated_at=now()`,
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    this.opts.cache?.clear();
    return Number(count);
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
        `INSERT INTO indexer_state (id, cursor, last_ledger, updated_at) VALUES (1, NULL, $1, now())
         ON CONFLICT (id) DO UPDATE SET cursor = NULL, last_ledger = EXCLUDED.last_ledger,
           updated_at = now()`,
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

    this.opts.cache?.clear();
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
    const entries = (
      await Promise.all(
        [...ids].map(async (id) => {
          const campaign = await this.opts.contract.getCampaign(id);
          if (!['active', 'completed', 'cancelled'].includes(campaign.status)) {
            this.opts.log.warn(
              { campaignId: id.toString(), status: campaign.status },
              'skipping campaign with unknown contract status',
            );
            return null;
          }
          return [id, campaign] as const;
        }),
      )
    ).filter(
      (entry): entry is readonly [bigint, Awaited<ReturnType<ContractReader['getCampaign']>>] =>
        entry !== null,
    );
    return new Map(entries);
  }

  /**
   * Retries campaigns whose contract state could not be read earlier. Their
   * events were parked in pending_campaign_events and are applied once the
   * campaign reads successfully.
   */
  private async retryPendingCampaigns(): Promise<void> {
    const { rows } = await this.opts.db.query<{ campaign_id: string; warned: boolean }>(
      `SELECT campaign_id, warned FROM campaign_refresh_queue
       WHERE last_attempt_at IS NULL OR last_attempt_at < now() - interval '60 seconds'
       ORDER BY campaign_id LIMIT 20`,
    );
    const ids = rows.map((row) => BigInt(row.campaign_id));
    const found = await this.readCampaigns(ids);
    for (const row of rows) {
      const id = BigInt(row.campaign_id);
      const campaign = found.get(id);
      if (!campaign) {
        await this.opts.db.query(
          'UPDATE campaign_refresh_queue SET last_attempt_at = now() WHERE campaign_id = $1',
          [row.campaign_id],
        );
        continue;
      }
      const client = await this.opts.db.connect();
      try {
        await client.query('BEGIN');
        await upsertCampaign(client, campaign, { ledger: 0, closedAt: new Date() });
        const pending = await client.query<{ payload: AidlineEvent }>(
          'SELECT payload FROM pending_campaign_events WHERE campaign_id = $1 ORDER BY created_at, event_id',
          [row.campaign_id],
        );
        const replayed: AidlineEvent[] = [];
        for (const { payload } of pending.rows) {
          const ev = {
            ...payload,
            campaignId: id,
            closedAt: new Date(payload.closedAt),
          } as AidlineEvent;
          if ('amount' in ev) ev.amount = BigInt(ev.amount);
          if ('campaignId' in ev && ev.type === 'milestone_released') ev.amount = BigInt(ev.amount);
          await recordEvent(client, ev);
          replayed.push(ev);
        }
        await client.query('DELETE FROM pending_campaign_events WHERE campaign_id = $1', [
          row.campaign_id,
        ]);
        await client.query('DELETE FROM campaign_refresh_queue WHERE campaign_id = $1', [
          row.campaign_id,
        ]);
        await client.query('COMMIT');
        this.warnedCampaigns.delete(row.campaign_id);
        this.publish(replayed);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
  }

  private async readCampaigns(ids: bigint[]) {
    const results = new Map<bigint, Awaited<ReturnType<ContractReader['getCampaign']>>>();
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(CAMPAIGN_READ_CONCURRENCY, ids.length) }, async () => {
        while (next < ids.length) {
          const id = ids[next++]!;
          try {
            results.set(id, await this.opts.contract.getCampaign(id));
          } catch (err) {
            if (!this.warnedCampaigns.has(id.toString())) {
              this.opts.log.warn(
                { err, campaignId: id.toString() },
                'campaign read failed; queued for refresh',
              );
              this.warnedCampaigns.add(id.toString());
            }
          }
        }
      }),
    );
    return results;
  }

  /** Hands committed events to the live stream. A failure here never stops indexing. */
  private publish(events: AidlineEvent[]): void {
    if (!events.length) return;
    try {
      this.opts.onCommit?.(events);
    } catch (err) {
      this.opts.log.error({ err }, 'failed to publish committed events');
    }
  }

  private async startLedger(): Promise<{
    ledger: number;
    source: 'configured' | 'default' | 'rpc_oldest';
  }> {
    const { oldestLedger, latestLedger } = await this.opts.source.getHealth();
    const wanted = this.opts.startLedger ?? latestLedger - 1000;
    // RPC only keeps recent history. Starting before that is an error.
    return {
      ledger: Math.max(wanted, oldestLedger),
      source:
        wanted < oldestLedger
          ? 'rpc_oldest'
          : this.opts.startLedger !== undefined
            ? 'configured'
            : 'default',
    };
  }
}
