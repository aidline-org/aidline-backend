import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { verifySignedRequest } from '../lib/auth.js';
import { JSON_BODY_LIMIT, pagination, stellarAddress, writeRateLimits } from '../lib/http.js';
import { amount, errorResponse, nullableDateTime, nullableString } from '../lib/openapi.js';

const application = z.strictObject({
  address: stellarAddress,
  orgName: z.string().trim().min(2).max(120),
  website: z.url().optional(),
  country: z.string().trim().min(2).max(60),
  description: z.string().trim().min(20).max(2000),
});

const verifierSummary = {
  type: 'object',
  properties: {
    address: { type: 'string' },
    orgName: nullableString,
    website: nullableString,
    country: nullableString,
    description: nullableString,
    bondAmount: amount,
    everSlashed: { type: 'boolean' },
    deregisteredAt: nullableDateTime,
  },
} as const;

/**
 * Verifier profiles live here, but whether a verifier is active is decided
 * on chain by the admin. The indexer keeps `active` in sync.
 */
export async function verifierRoutes(app: FastifyInstance) {
  app.get(
    '/verifiers',
    {
      schema: {
        tags: ['verifiers'],
        summary: 'List active verifiers',
        querystring: {
          type: 'object',
          properties: {
            country: {
              type: 'string',
              description: 'Only verifiers in this country. Matching ignores case.',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              items: { type: 'array', items: verifierSummary },
            },
          },
        },
      },
    },
    async (req) => {
      const { country } = z
        .object({
          country: z
            .string()
            .trim()
            .optional()
            .transform((v) => v || undefined),
        })
        .parse(req.query);
      const { rows } = await app.db.query(
        `SELECT address, org_name AS "orgName", website, country, description, bond_amount AS "bondAmount", ever_slashed AS "everSlashed", deregistered_at AS "deregisteredAt"
         FROM verifiers
         WHERE active AND ($1::text IS NULL OR lower(country) = lower($1))
         ORDER BY org_name NULLS LAST, address`,
        [country ?? null],
      );
      return { items: rows };
    },
  );

  /**
   * #21: the admin review queue. Applications stay here until the admin calls
   * `add_verifier` on chain, at which point the indexer flips `active` and the
   * row leaves this list. Access is limited to the configured admin wallet.
   */
  app.get('/verifiers/applications', async (req, reply) => {
    if (!app.config.ADMIN_WALLET_ADDRESS) {
      return reply
        .code(403)
        .send({ error: 'forbidden', message: 'Admin wallet is not configured' });
    }
    const identity = verifySignedRequest(req, reply, 'admin:verifier-applications', {
      expectedAddress: app.config.ADMIN_WALLET_ADDRESS,
    });
    if (!identity) return reply;

    const { limit, offset } = pagination.parse(req.query);
    const where = 'active = false AND applied_at IS NOT NULL';
    const [{ rows }, { rows: totals }] = await Promise.all([
      app.db.query(
        `SELECT address, org_name AS "orgName", website, country, description,
                applied_at AS "appliedAt"
         FROM verifiers WHERE ${where}
         ORDER BY applied_at ASC, address
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      app.db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM verifiers WHERE ${where}`,
      ),
    ]);
    return { items: rows, total: totals[0]?.count ?? 0 };
  });

  app.get('/verifiers/:address', async (req) => {
    const { address } = z.object({ address: stellarAddress }).parse(req.params);
    const { rows } = await app.db.query(
      `SELECT address, active, org_name AS "orgName", website, country, description,
              applied_at AS "appliedAt", bond_amount AS "bondAmount", ever_slashed AS "everSlashed", deregistered_at AS "deregisteredAt"
       FROM verifiers WHERE address = $1`,
      [address],
    );
    return rows[0] ?? { address, active: false, orgName: null };
  });

  app.post(
    '/verifiers/applications',
    {
      bodyLimit: JSON_BODY_LIMIT,
      config: { rateLimit: writeRateLimits.verifierApplications },
      schema: {
        tags: ['verifiers'],
        summary: 'Apply to become a verifier',
        description:
          'Stores or updates an application for admin review. The verifier only becomes active when the admin adds it on chain. Resubmitting the same address replaces the stored profile.',
        body: {
          type: 'object',
          required: ['address', 'orgName', 'country', 'description'],
          properties: {
            address: {
              type: 'string',
              pattern: '^G[A-Z2-7]{55}$',
              description: 'Stellar account address',
            },
            orgName: { type: 'string', minLength: 2, maxLength: 120 },
            website: { type: 'string', format: 'uri' },
            country: { type: 'string', minLength: 2, maxLength: 60 },
            description: { type: 'string', minLength: 20, maxLength: 2000 },
          },
          example: {
            address: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI',
            orgName: 'Red Relief Network',
            website: 'https://redrelief.example.org',
            country: 'Nigeria',
            description: 'Field verification partner for flood response in Kogi state.',
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              address: { type: 'string' },
              status: { type: 'string', enum: ['pending_review'] },
            },
          },
          400: errorResponse('The application is invalid'),
          429: errorResponse('Too many applications from this client'),
        },
      },
    },
    async (req, reply) => {
      const a = application.parse(req.body);
      await app.db.query(
        `INSERT INTO verifiers (address, org_name, website, country, description, applied_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (address) DO UPDATE SET
           org_name = EXCLUDED.org_name, website = EXCLUDED.website, country = EXCLUDED.country,
           description = EXCLUDED.description, applied_at = now(), updated_at = now()`,
        [a.address, a.orgName, a.website ?? null, a.country, a.description],
      );
      return reply.code(201).send({ address: a.address, status: 'pending_review' });
    },
  );

  // #12: list campaigns a verifier oversees, with milestone counts so their track record
  // is visible without a second request to each campaign.
  app.get('/verifiers/:address/campaigns', async (req) => {
    const { address } = z.object({ address: stellarAddress }).parse(req.params);
    const { rows } = await app.db.query(
      `SELECT c.id, c.kind,
              CASE WHEN c.status = 'active' AND c.deadline < now() THEN 'expired' ELSE c.status END AS status,
              c.creator, c.goal, c.raised, c.released, c.deadline, c.created_at AS "createdAt",
              coalesce(array_length(c.milestones, 1), 0) AS "milestoneCount",
              c.milestones_released AS "milestonesReleased",
              m.title, m.location, m.organizer
       FROM campaigns c
       LEFT JOIN campaign_metadata m ON m.id = c.metadata_id
       WHERE c.verifier = $1
       ORDER BY c.created_at DESC`,
      [address],
    );
    return { items: rows };
  });
}
