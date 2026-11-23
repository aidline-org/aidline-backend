import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { csvDocument, csvRow } from '../lib/csv.js';
import { notFound, pagination } from '../lib/http.js';
import { documentRoute } from '../lib/openapi.js';

function toRelativePath(value: string): string | null {
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) return value.replace(/^\/+/, '');
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/uploads\/(.+)$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function normalizeProofFiles<T>(proof: T, base: string): T {
  if (!proof || typeof proof !== 'object') return proof;
  const p = proof as Record<string, unknown>;
  const files = p.files;
  if (!Array.isArray(files)) return proof;
  return {
    ...p,
    files: files.map((file) => {
      if (!file || typeof file !== 'object') return file;
      const f = file as Record<string, unknown>;
      const url = typeof f.url === 'string' ? f.url : '';
      const thumb = typeof f.thumbnailUrl === 'string' ? f.thumbnailUrl : '';
      const key = toRelativePath(url);
      const thumbKey = toRelativePath(thumb);
      return {
        ...f,
        ...(key ? { url: `${base}/uploads/${key}` } : {}),
        ...(thumbKey ? { thumbnailUrl: `${base}/uploads/${thumbKey}` } : {}),
      };
    }),
  } as T;
}


const campaignIdParam = z.object({ id: z.coerce.bigint() });

const SORT_MAP = {
  newest: 'c.created_at DESC',
  ending_soon: 'c.deadline ASC',
  most_funded: 'c.raised DESC',
} as const;

const listQuery = pagination.extend({
  kind: z.enum(['emergency', 'climate']).optional(),
  status: z.enum(['active', 'completed', 'cancelled', 'expired']).optional(),
  creator: z.string().optional(),
  verifier: z.string().optional(),
  // #2: full-text search across title, summary, location and organizer
  // A blank search is treated as no search.
  q: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || undefined),
  // #9: sort order
  sort: z.enum(['newest', 'ending_soon', 'most_funded']).default('newest'),
});

// "expired" is not stored: it is an active campaign whose deadline has passed.
const STATUS_SQL = `CASE WHEN c.status = 'active' AND c.deadline < now() THEN 'expired' ELSE c.status END`;

const CAMPAIGN_COLUMNS = `
  c.id, c.kind, ${STATUS_SQL} AS status, c.creator, c.beneficiary, c.verifier,
  c.goal, c.raised, c.released, c.milestones, c.milestones_released AS "milestonesReleased",
  c.deadline, c.metadata_uri AS "metadataUri", c.created_at AS "createdAt",
  COALESCE(dc.donor_count, 0) AS "donorCount",
  CASE WHEN m.id IS NULL THEN NULL ELSE json_build_object(
    'title', m.title, 'summary', m.summary, 'location', m.location, 'organizer', m.organizer,
    'category', m.category, 'imageUrl', m.image_url
  ) END AS metadata`;

const DONOR_COUNTS_JOIN = `
  LEFT JOIN (
    SELECT campaign_id, count(DISTINCT donor)::int AS donor_count
    FROM donations
    GROUP BY campaign_id
  ) dc ON dc.campaign_id = c.id`;

const CSV_HEADERS = [
  'type',
  'createdAt',
  'campaignId',
  'actor',
  'amount',
  'milestoneIndex',
  'txHash',
  'eventId',
  'proofUri',
].join(',');

export async function campaignRoutes(app: FastifyInstance) {
  app.get('/campaigns/:id/sponsor-pool', documentRoute({ tag: 'campaigns', params: campaignIdParam }), async (req, reply) => {
    const { id } = campaignIdParam.parse(req.params);
    const campaignId = id.toString();
    const exists = await app.db.query('SELECT 1 FROM campaigns WHERE id = $1', [campaignId]);
    if (!exists.rowCount) return notFound(reply, 'campaign');

    const [deposits, matches, returns] = await Promise.all([
      app.db.query<{ sponsor: string; amount: string; ratio_bps: number; cap: string }>(
        'SELECT sponsor, amount, ratio_bps, cap FROM sponsor_pool_deposits WHERE campaign_id = $1 ORDER BY created_at, event_id', [campaignId]),
      app.db.query<{ event_id: string; sponsor: string; donor: string; donation_amount: string; matched_amount: string; tx_hash: string; created_at: Date }>(
        'SELECT event_id, sponsor, donor, donation_amount, matched_amount, tx_hash, created_at FROM sponsor_pool_matches WHERE campaign_id = $1 ORDER BY created_at, event_id', [campaignId]),
      app.db.query<{ sponsor: string; amount: string }>(
        'SELECT sponsor, amount FROM sponsor_pool_returns WHERE campaign_id = $1', [campaignId]),
    ]);
    const sum = (values: string[]) => values.reduce((total, value) => total + BigInt(value), 0n).toString();
    const deposited = sum(deposits.rows.map((r) => r.amount));
    const matched = sum(matches.rows.map((r) => r.matched_amount));
    const returned = sum(returns.rows.map((r) => r.amount));
    return {
      campaignId,
      sponsor: deposits.rows.at(-1)?.sponsor ?? null,
      sponsors: [...new Set(deposits.rows.map((r) => r.sponsor))],
      deposited, matched, returned,
      remaining: (BigInt(deposited) - BigInt(matched) - BigInt(returned)).toString(),
      deposits: deposits.rows.map((r) => ({ sponsor: r.sponsor, amount: r.amount, ratioBps: r.ratio_bps, cap: r.cap })),
      matches: matches.rows.map((r) => ({ eventId: r.event_id, sponsor: r.sponsor, donor: r.donor, donationAmount: r.donation_amount, matchedAmount: r.matched_amount, txHash: r.tx_hash, createdAt: r.created_at })),
    };
  });

  app.get('/campaigns', documentRoute({ tag: 'campaigns', querystring: listQuery }), async (req) => {
    const q = listQuery.parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.kind) add('c.kind = ?', q.kind);
    if (q.status) add(`${STATUS_SQL} = ?`, q.status);
    if (q.creator) add('c.creator = ?', q.creator);
    if (q.verifier) add('c.verifier = ?', q.verifier);

    // #2: full-text search across title, summary, location and organizer via the
    // stored tsvector column. When q.q is blank we skip the clause entirely so
    // existing filters work unchanged.
    let searchParamIndex: number | null = null;
    if (q.q) {
      params.push(q.q);
      searchParamIndex = params.length;
      where.push(`m.search_vector @@ websearch_to_tsquery('english', $${searchParamIndex})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // When a full-text search term is present, rank by relevance first; otherwise
    // use the requested sort order.
    const orderBy = searchParamIndex
      ? `ts_rank(m.search_vector, websearch_to_tsquery('english', $${searchParamIndex})) DESC, c.created_at DESC`
      : SORT_MAP[q.sort];

    params.push(q.limit, q.offset);
    const { rows } = await app.db.query(
      `SELECT ${CAMPAIGN_COLUMNS}, count(*) OVER()::int AS total
       FROM campaigns c
       LEFT JOIN campaign_metadata m ON m.id = c.metadata_id
       ${DONOR_COUNTS_JOIN}
       ${whereSql}
       ORDER BY ${orderBy}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const total = rows[0]?.total ?? 0;
    return { items: rows.map(({ total: _t, ...r }) => r), total };
  });

  app.get('/campaigns/:id', documentRoute({ tag: 'campaigns', params: campaignIdParam }), async (req, reply) => {
    const { id } = campaignIdParam.parse(req.params);
    const { rows } = await app.db.query(
      `SELECT ${CAMPAIGN_COLUMNS}, m.description AS "metadataDescription"
       FROM campaigns c
       LEFT JOIN campaign_metadata m ON m.id = c.metadata_id
       ${DONOR_COUNTS_JOIN}
       WHERE c.id = $1`,
      [id.toString()],
    );
    const row = rows[0];
    if (!row) return notFound(reply, 'campaign');

    const releases = await app.db.query(
      `SELECT r.index, r.amount, r.proof_uri AS "proofUri", r.tx_hash AS "txHash",
              r.created_at AS "releasedAt",
              CASE WHEN p.id IS NULL THEN NULL ELSE json_build_object(
                'id', p.id, 'note', p.note, 'files', p.files) END AS proof
       FROM milestone_releases r LEFT JOIN proofs p ON p.id = r.proof_id
       WHERE r.campaign_id = $1`,
      [id.toString()],
    );
    const base = app.config.PUBLIC_BASE_URL;
    const byIndex = new Map(releases.rows.map((r) => [r.index, r]));
    const milestones = (row.milestones as string[]).map((amount, index) => {
      const release = byIndex.get(index);
      return {
        index,
        amount,
        released: Boolean(release),
        releasedAt: release?.releasedAt ?? null,
        txHash: release?.txHash ?? null,
        proofUri: release?.proofUri ?? null,
        proof: release?.proof ? normalizeProofFiles(release.proof, base) : null,
      };
    });

    const { metadataDescription, ...campaign } = row;
    if (campaign.metadata) campaign.metadata.description = metadataDescription;
    const advances = await app.db.query(
      `SELECT verifier, milestone_index AS "milestoneIndex", amount, tx_hash AS "txHash", created_at AS "createdAt" FROM emergency_advances WHERE campaign_id=$1 ORDER BY created_at DESC`,
      [id.toString()],
    );
    return { ...campaign, milestones, emergencyAdvances: advances.rows };
  });

  app.get('/campaigns/:id/donations', documentRoute({ tag: 'campaigns', params: campaignIdParam, querystring: pagination }), async (req, reply) => {
    const { id } = campaignIdParam.parse(req.params);
    const exists = await app.db.query('SELECT 1 FROM campaigns WHERE id = $1', [id.toString()]);
    if (!exists.rows[0]) return notFound(reply, 'campaign');
    const q = pagination.parse(req.query);
    const { rows } = await app.db.query(
      `SELECT donor, amount, tx_hash AS "txHash", created_at AS "createdAt"
       FROM donations WHERE campaign_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [id.toString(), q.limit, q.offset],
    );
    return { items: rows };
  });

  app.get('/campaigns/:id/pledges', documentRoute({ tag: 'campaigns', params: campaignIdParam, querystring: pagination }), async (req) => {
    const { id } = campaignIdParam.parse(req.params);
    const q = pagination.parse(req.query);
    const { rows } = await app.db.query(
      `SELECT pledge_id AS "pledgeId", donor, pledged_amount AS "pledgedAmount", pulled_amount AS "pulledAmount", status, skipped_reason AS "skippedReason", updated_at AS "updatedAt" FROM pledges WHERE campaign_id=$1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3`,
      [id.toString(), q.limit, q.offset],
    );
    return { items: rows };
  });

  /**
   * GET /campaigns/:id/export.csv
   *
   * Returns a CSV file containing all donations, milestone releases, and refunds
   * for the specified campaign, suitable for auditor review.
   *
   * Columns: type, createdAt, campaignId, actor, amount, milestoneIndex, txHash, eventId, proofUri
   * proofUri is set for releases only and is empty for donations and refunds.
   *
   * Amounts are returned as-is from NUMERIC(39,0) columns, i.e., exact integer
   * strings in the token's smallest unit (stroops) with no floating-point conversion.
   *
   * Ordering: chronological (created_at ASC), with event_id as a tie-breaker.
   */
  app.get('/campaigns/:id/export.csv', documentRoute({ tag: 'campaigns', params: campaignIdParam }), async (req, reply) => {
    const { id } = campaignIdParam.parse(req.params);

    // Verify the campaign exists.
    const exists = await app.db.query('SELECT 1 FROM campaigns WHERE id = $1', [id.toString()]);
    if (!exists.rows[0]) return notFound(reply, 'campaign');

    // Fetch all three record types in a single chronological query.
    // UNION ALL preserves every row; type column distinguishes them.
    // Amounts are NUMERIC(39,0) returned as strings by pool.ts type parsers.
    const { rows } = await app.db.query<{
      type: string;
      created_at: Date;
      campaign_id: string;
      actor: string | null;
      amount: string;
      milestone_index: number | null;
      tx_hash: string;
      event_id: string;
      proof_uri: string | null;
    }>(
      `SELECT 'donation'            AS type,
              created_at,
              campaign_id::text,
              donor                  AS actor,
              amount::text,
              NULL::integer          AS milestone_index,
              tx_hash,
              event_id,
              NULL::text             AS proof_uri
       FROM donations WHERE campaign_id = $1

       UNION ALL

       SELECT 'release'             AS type,
              created_at,
              campaign_id::text,
              NULL                   AS actor,
              amount::text,
              index                  AS milestone_index,
              tx_hash,
              event_id,
              proof_uri
       FROM milestone_releases WHERE campaign_id = $1

       UNION ALL

       SELECT 'refund'              AS type,
              created_at,
              campaign_id::text,
              donor                  AS actor,
              amount::text,
              NULL::integer          AS milestone_index,
              tx_hash,
              event_id,
              NULL::text             AS proof_uri
       FROM refunds WHERE campaign_id = $1

       ORDER BY created_at ASC, event_id ASC`,
      [id.toString()],
    );

    const lines: string[] = [];
    for (const row of rows) {
      lines.push(
        csvRow([
          row.type,
          row.created_at.toISOString(),
          row.campaign_id,
          row.actor,
          row.amount,
          row.milestone_index !== null ? String(row.milestone_index) : null,
          row.tx_hash,
          row.event_id,
          row.proof_uri,
        ]),
      );
    }

    const csv = csvDocument(CSV_HEADERS, lines);

    return reply
      .code(200)
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="campaign-${id.toString()}.csv"`)
      .send(csv);
  });

  // #1: list refunds for a campaign, newest first
  app.get('/campaigns/:id/refunds', documentRoute({ tag: 'campaigns', params: campaignIdParam, querystring: pagination }), async (req, reply) => {
    const { id } = campaignIdParam.parse(req.params);
    const q = pagination.parse(req.query);

    // Verify campaign exists first
    const { rows: check } = await app.db.query('SELECT 1 FROM campaigns WHERE id = $1', [
      id.toString(),
    ]);
    if (!check.length) return notFound(reply, 'campaign');

    const { rows } = await app.db.query(
      `SELECT donor, amount, tx_hash AS "txHash", created_at AS "createdAt"
       FROM refunds WHERE campaign_id = $1
       ORDER BY created_at DESC, event_id DESC LIMIT $2 OFFSET $3`,
      [id.toString(), q.limit, q.offset],
    );
    return { items: rows };
  });

  // #141: payout history for one campaign on its own, without the rest of the milestones.
  // Newest first. event_id breaks ties so paging stays stable when releases share a timestamp.
  app.get('/campaigns/:id/releases', async (req, reply) => {
    const { id } = z.object({ id: z.coerce.bigint() }).parse(req.params);
    const q = pagination.parse(req.query);

    const exists = await app.db.query('SELECT 1 FROM campaigns WHERE id = $1', [id.toString()]);
    if (!exists.rows[0]) return notFound(reply, 'campaign');

    const { rows } = await app.db.query(
      `SELECT r.index, r.amount, r.proof_uri AS "proofUri", r.tx_hash AS "txHash",
              r.created_at AS "releasedAt",
              CASE WHEN p.id IS NULL THEN NULL ELSE json_build_object(
                'id', p.id, 'note', p.note, 'files', p.files) END AS proof
       FROM milestone_releases r
       LEFT JOIN proofs p ON p.id = r.proof_id
       WHERE r.campaign_id = $1
       ORDER BY r.created_at DESC, r.event_id DESC
       LIMIT $2 OFFSET $3`,
      [id.toString(), q.limit, q.offset],
    );
    const base = app.config.PUBLIC_BASE_URL;
    return { items: rows.map((r) => ({ ...r, proof: r.proof ? normalizeProofFiles(r.proof, base) : null })) };
  });
}
