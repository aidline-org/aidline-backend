import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { createThumbnail } from '../lib/images.js';
import { notFound } from '../lib/http.js';
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

const fields = z.object({
  campaignId: z.coerce.bigint().nonnegative(),
  milestoneIndex: z.coerce.number().int().min(0),
  note: z.string().trim().min(10).max(2000),
});

/**
 * Reads just enough bytes to identify the file type. Iterating with
 * `destroyOnReturn: false` keeps the remaining stream readable after the
 * header, so the file can still be written in full.
 */
async function readHeader(stream: Readable, size: number) {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    chunks.push(buf);
    bytesRead += buf.length;
    if (bytesRead >= size) break;
  }
  const collected = Buffer.concat(chunks);
  // The whole collected buffer must be written back: the header is part of the file.
  return { header: collected.subarray(0, size), collected };
}

/** Replays the bytes already read for the header, then the rest of the stream. */
async function* withPrefix(prefix: Buffer, stream: Readable): AsyncIterable<Buffer> {
  if (prefix.length) yield prefix;
  for await (const chunk of stream) {
    yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
  }
}

/**
 * Verifiers upload evidence here before approving a milestone. The returned
 * URI is passed to `approve_milestone` and emitted on chain. Files go through
 * the configured storage driver; the original is always kept alongside an
 * optional smaller thumbnail for mobile clients.
 */
export async function proofRoutes(app: FastifyInstance) {
  app.post('/proofs', { config: { rateLimit: writeRateLimits.proofs } }, async (req, reply) => {
    const id = randomUUID();
    const raw: Record<string, string> = {};
    const files: { name: string; url: string; thumbnailUrl: string; type: string }[] = [];
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
        const { header, collected } = await readHeader(part.file, HEADER_BYTES);
        if (detectMimeType(header) !== part.mimetype) {
          part.file.resume();
          return reply.code(400).send({
            error: 'invalid_file',
            message: 'File contents do not match the declared type',
          });
        }

        await mkdir(dir, { recursive: true });
        const name = `${files.length}${extension}`;
        const path = join(dir, name);
        written.push(path);
        await pipeline(Readable.from(withPrefix(collected, part.file)), createWriteStream(path));
        files.push({
          name: part.filename,
          type: part.mimetype,
          url: `${app.config.PUBLIC_BASE_URL}/uploads/proofs/${id}/${name}`,
        });
      }

      const f = fields.parse(raw);
      if (f.campaignId.toString() !== campaignId) {
        return reply
          .code(403)
          .send({ error: 'forbidden', message: 'Signed campaign id does not match the upload' });
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
