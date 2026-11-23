import type { FastifyInstance } from 'fastify';

import { setCacheHeaders } from '../lib/cache.js';
import { pagination } from '../lib/http.js';
import { amount, nullableString, paginationQuery } from '../lib/openapi.js';

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


const proofFile = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    type: { type: 'string' },
    url: { type: 'string', format: 'uri' },
    thumbnailUrl: { type: 'string', format: 'uri' },
  },
} as const;

const release = {
  type: 'object',
  properties: {
    campaignId: { type: 'string' },
    index: { type: 'integer' },
    amount,
    txHash: { type: 'string' },
    releasedAt: { type: 'string', format: 'date-time' },
    proofUri: nullableString,
    kind: { type: 'string', enum: ['emergency', 'climate'] },
    verifier: nullableString,
    verifierName: nullableString,
    campaignTitle: nullableString,
    location: nullableString,
    organizer: nullableString,
    proof: {
      type: ['object', 'null'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        note: { type: 'string' },
        files: { type: 'array', items: proofFile },
      },
    },
  },
} as const;

/** Recent milestone payouts across all campaigns, newest first, with their evidence. */
export async function releaseRoutes(app: FastifyInstance) {
  app.get(
    '/releases',
    {
      schema: {
        tags: ['releases'],
        summary: 'Recent milestone payouts, newest first',
        querystring: paginationQuery,
        response: {
          200: { type: 'object', properties: { items: { type: 'array', items: release } } },
        },
      },
    },
    async (req, reply) => {
      const q = pagination.parse(req.query);
      // Different pages must never share a cached response.
      const key = `releases:${q.limit}:${q.offset}`;
      const cached = app.cache.get<unknown>(key);
      setCacheHeaders(reply, cached !== undefined);
      if (cached !== undefined) return cached;

      const { rows } = await app.db.query(
        `SELECT r.campaign_id AS "campaignId", r.index, r.amount, r.tx_hash AS "txHash",
              r.created_at AS "releasedAt", r.proof_uri AS "proofUri",
              c.kind, c.verifier, v.org_name AS "verifierName",
              m.title AS "campaignTitle", m.location, m.organizer,
              CASE WHEN p.id IS NULL THEN NULL ELSE json_build_object(
                'id', p.id, 'note', p.note, 'files', p.files) END AS proof
       FROM milestone_releases r
       JOIN campaigns c ON c.id = r.campaign_id
       LEFT JOIN campaign_metadata m ON m.id = c.metadata_id
       LEFT JOIN verifiers v ON v.address = c.verifier
       LEFT JOIN proofs p ON p.id = r.proof_id
       ORDER BY r.created_at DESC
       LIMIT $1 OFFSET $2`,
        [q.limit, q.offset],
      );
      const base = app.config.PUBLIC_BASE_URL;
      const result = { items: rows.map((r) => ({ ...r, proof: r.proof ? normalizeProofFiles(r.proof, base) : null })) };
      app.cache.set(key, result);
      return result;
    },
  );
}
