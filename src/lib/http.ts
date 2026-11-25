import type { FastifyReply } from 'fastify';
import { z } from 'zod';

export const stellarAddress = z
  .string()
  .regex(/^G[A-Z2-7]{55}$/, 'must be a Stellar account address');

export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Tighter limits for the write routes. The global limit is generous because reads are cheap,
 * but these endpoints insert rows and, for proofs, accept multipart file uploads. They are
 * passed as per-route `config.rateLimit` so they replace (rather than add to) the global limit.
 */
export const writeRateLimits = {
  metadata: { max: 50, timeWindow: '1 minute' },
  proofs: { max: 10, timeWindow: '1 minute' },
  verifierApplications: { max: 10, timeWindow: '1 minute' },
};

/**
 * Body limit for JSON write routes. The largest valid body is metadata with a 10,000 character
 * description (up to ~40 KB as UTF-8); Fastify's 1 MB default only helps someone loading the server.
 */
export const JSON_BODY_LIMIT = 64 * 1024;

export function notFound(reply: FastifyReply, what: string) {
  return reply.code(404).send({ error: 'not_found', message: `${what} not found` });
}
