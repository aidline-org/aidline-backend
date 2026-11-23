import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { notFound, writeRateLimits } from '../lib/http.js';
import { detectMimeType, HEADER_BYTES } from '../lib/magic.js';

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};
const MAX_FILES = 5;

const fieldsSchema = z.object({
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
          name: part.filename,
          type: part.mimetype,
          size: body.length,
          url: `${app.config.PUBLIC_BASE_URL}/uploads/${key}`,
        });
      }

      const f = fields.parse(raw);
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
    const { rows } = await app.db.query<{
      id: string;
      campaignId: string;
      milestoneIndex: number;
      note: string;
      files: Record<string, unknown>[] | string;
      createdAt: Date;
    }>(
      `SELECT id, campaign_id AS "campaignId", milestone_index AS "milestoneIndex", note, files,
              created_at AS "createdAt"
       FROM proofs WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return notFound(reply, 'proof');
    const rawFiles = typeof row.files === 'string' ? JSON.parse(row.files) : row.files;
    const base = app.config.PUBLIC_BASE_URL;
    return {
      ...row,
      files: (Array.isArray(rawFiles) ? rawFiles : []).map((file) =>
        normalizeFile(file as Record<string, unknown>, base),
      ),
    };
  });
}
