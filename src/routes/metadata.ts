import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { CATEGORIES } from '../lib/categories.js';
import { JSON_BODY_LIMIT, notFound, writeRateLimits } from '../lib/http.js';
import { errorResponse } from '../lib/openapi.js';

const body = z.strictObject({
  title: z.string().trim().min(5).max(120),
  summary: z.string().trim().min(10).max(280),
  description: z.string().trim().min(20).max(10_000),
  location: z.string().trim().min(2).max(120),
  organizer: z.string().trim().min(2).max(120).optional(),
  category: z.enum(CATEGORIES).optional(),
  imageUrl: z.url().optional(),
});

/**
 * Campaign metadata is written here first. The returned URI is then passed
 * to `create_campaign`, which ties the on chain campaign to this record.
 * Records are immutable so the URI on chain always means the same thing.
 */
export async function metadataRoutes(app: FastifyInstance) {
  /** The fixed category list, so the frontend can build its picker from one source. */
  app.get('/categories', async () => ({ items: CATEGORIES }));

  app.post(
    '/metadata',
    { bodyLimit: JSON_BODY_LIMIT, config: { rateLimit: writeRateLimits.metadata } },
    async (req, reply) => {
      const m = body.parse(req.body);
      const id = randomUUID();
      await app.db.query(
        `INSERT INTO campaign_metadata
         (id, title, summary, description, location, organizer, category, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          m.title,
          m.summary,
          m.description,
          m.location,
          m.organizer ?? null,
          m.category ?? null,
          m.imageUrl ?? null,
        ],
      );
      return reply.code(201).send({ id, uri: `${app.config.PUBLIC_BASE_URL}/metadata/${id}` });
    },
  );

  app.get('/metadata/:id', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { rows } = await app.db.query(
      `SELECT id, title, summary, description, location, organizer, category,
              image_url AS "imageUrl",
              created_at AS "createdAt"
       FROM campaign_metadata WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return notFound(reply, 'metadata');
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    return row;
  });
}
