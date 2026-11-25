import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { notFound, writeRateLimits } from '../lib/http.js';
import { detectMimeType, HEADER_BYTES } from '../lib/magic.js';

/**
 * Allowed upload types and the file extension each is stored with. The extension comes from this
 * table, never from the uploaded filename: the static file server picks the response content type
 * from the extension, so a file named `x.html` sent as `image/png` would otherwise be served as
 * HTML from this origin.
 */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};
const MAX_FILES = 5;
const MAX_NAME_LENGTH = 100;

/**
 * The original file name is shown to every visitor of the campaign page, so keep it short and drop
 * control characters and path separators. An empty result falls back to `file-<n><ext>`.
 */
function displayName(raw: string, position: number, extension: string): string {
  const cleaned = Array.from(raw.replace(/[\p{Cc}\\/]/gu, '').trim())
    .slice(0, MAX_NAME_LENGTH)
    .join('')
    .trim();
  return cleaned || `file-${position + 1}${extension}`;
}

const fields = z.object({
  campaignId: z.coerce.bigint().nonnegative(),
  milestoneIndex: z.coerce.number().int().min(0),
  note: z.string().trim().min(10).max(2000),
});

/** Collects a whole upload. The multipart plugin already caps each file at 5 MB. */
async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

/**
 * Verifiers upload evidence here before approving a milestone. The returned
 * URI is passed to `approve_milestone` and emitted on chain. Files go through
 * the configured storage driver under `proofs/<proof id>/<n><ext>`, the same
 * key the public `/uploads/*` route serves.
 */
export async function proofRoutes(app: FastifyInstance) {
  app.post('/proofs', { config: { rateLimit: writeRateLimits.proofs } }, async (req, reply) => {
    const id = randomUUID();
    const raw: Record<string, string> = {};
    const files: { name: string; url: string; size: number; type: string }[] = [];
    // Keys written by this request. Whatever is still listed when it fails is removed.
    const written: string[] = [];

    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          raw[part.fieldname] = String(part.value);
          continue;
        }
        const extension = EXTENSIONS[part.mimetype];
        if (!extension || files.length >= MAX_FILES) {
          part.file.resume();
          return reply.code(400).send({
            error: 'invalid_file',
            message: `Up to ${MAX_FILES} JPEG, PNG, WebP or PDF files are allowed`,
          });
        }

        // The declared mimetype is untrusted. Check the real bytes before storing.
        const body = await readAll(part.file);
        if (detectMimeType(body.subarray(0, HEADER_BYTES)) !== part.mimetype) {
          return reply.code(400).send({
            error: 'invalid_file',
            message: 'File contents do not match the declared type',
          });
        }

        const name = `${files.length}${extension}`;
        const key = `proofs/${id}/${name}`;
        await app.storage.put(key, body, part.mimetype);
        written.push(key);
        files.push({
          name: displayName(part.filename, files.length, extension),
          type: part.mimetype,
          size: body.length,
          url: `${app.config.PUBLIC_BASE_URL}/uploads/${key}`,
        });
      }

      const f = fields.parse(raw);
      const { rows } = await app.db.query<{ milestones: number }>(
        'SELECT cardinality(milestones) AS milestones FROM campaigns WHERE id = $1',
        [f.campaignId.toString()],
      );
      if (!rows[0] || f.milestoneIndex >= rows[0].milestones) {
        return reply.code(400).send({
          error: 'invalid_target',
          message: rows[0]
            ? `Campaign ${f.campaignId} has no milestone ${f.milestoneIndex}`
            : `Campaign ${f.campaignId} does not exist`,
        });
      }
      await app.db.query(
        `INSERT INTO proofs (id, campaign_id, milestone_index, note, files)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, f.campaignId.toString(), f.milestoneIndex, f.note, JSON.stringify(files)],
      );
      written.length = 0;
      return reply.code(201).send({ id, uri: `${app.config.PUBLIC_BASE_URL}/proofs/${id}`, files });
    } finally {
      // Anything still listed here belongs to a rejected upload.
      await Promise.all(written.map((key) => app.storage.delete(key)));
    }
  });

  app.get('/proofs/:id', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { rows } = await app.db.query(
      `SELECT id, campaign_id AS "campaignId", milestone_index AS "milestoneIndex", note, files,
              created_at AS "createdAt"
       FROM proofs WHERE id = $1`,
      [id],
    );
    return rows[0] ?? notFound(reply, 'proof');
  });
}
