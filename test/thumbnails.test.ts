import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import type { FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';

import type { Db } from '../src/db/pool.js';
import { createThumbnail, imageKind, pngThumbnail } from '../src/lib/images.js';
import { seedCampaign, setupApp } from './helpers.js';

const photo = readFileSync(new URL('./fixtures/photo.png', import.meta.url));
const { app, db } = (await setupApp()) as { app: FastifyInstance; db: Db };
await seedCampaign(db);

function upload(file: Buffer, type = 'image/png', filename = 'photo.png') {
  const boundary = '----aidline';
  const head = Buffer.from(
    [
      `--${boundary}\r\nContent-Disposition: form-data; name="campaignId"\r\n\r\n0`,
      `--${boundary}\r\nContent-Disposition: form-data; name="milestoneIndex"\r\n\r\n0`,
      `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nWater tanks delivered to 3 camps`,
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
    ].join('\r\n'),
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    method: 'POST' as const,
    url: '/proofs',
    payload: Buffer.concat([head, file, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe('proof thumbnails', () => {
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it('detects supported image bytes by magic number', () => {
    expect(imageKind(photo)).toBe('png');
    expect(imageKind(Buffer.from('PNGDATA'))).toBeNull();
  });

  it('decodes and shrinks a real PNG without a new dependency', () => {
    const thumb = pngThumbnail(photo, 64);
    expect(thumb).not.toBeNull();
    // IHDR width/height live at offsets 16 and 20 in every PNG.
    expect(thumb?.readUInt32BE(16)).toBe(64);
    expect(thumb?.readUInt32BE(20)).toBe(32);
    expect(thumb!.length).toBeLessThan(photo.length);
  });

  it('returns both the original and thumbnail URLs on upload', async () => {
    const res = await app.inject(upload(photo));
    expect(res.statusCode).toBe(201);
    const file = res.json().files[0];
    expect(file.url).toMatch(/\/uploads\/proofs\/[\w-]+\/0\.png$/);
    expect(file.thumbnailUrl).toMatch(/\/uploads\/proofs\/[\w-]+\/0\.thumb\.png$/);
    expect(file.thumbnailUrl).not.toBe(file.url);

    const original = await app.inject({ url: new URL(file.url).pathname });
    expect(original.statusCode).toBe(200);
    expect(Buffer.from(original.rawPayload)).toEqual(photo);

    const thumb = await app.inject({ url: new URL(file.thumbnailUrl).pathname });
    expect(thumb.statusCode).toBe(200);
    expect(String(thumb.headers['content-type'])).toBe('image/png');
    const bytes = Buffer.from(thumb.rawPayload);
    expect(bytes.readUInt32BE(16)).toBe(256);
    expect(bytes.readUInt32BE(20)).toBe(128);
  });

  // JPEG needs a real codec. The host tool is optional, so only exercise this
  // path where one is installed; PNG thumbnails above never need it.
  it.skipIf(spawnSync('ffmpeg', ['-version']).status !== 0)(
    'resizes JPEGs when an optional host image tool is available',
    async () => {
      const jpeg = execFileSync('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x180',
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        'pipe:1',
      ]);
      const thumb = await createThumbnail(jpeg);
      expect(thumb).not.toBeNull();
      expect(thumb?.readUInt32BE(16)).toBe(256);
      expect(thumb?.readUInt32BE(20)).toBe(144);
    },
  );

  it('falls back to the original URL when the bytes are not a real image', async () => {
    const res = await app.inject(upload(Buffer.from('PNGDATA')));
    expect(res.statusCode).toBe(201);
    expect(res.json().files[0].thumbnailUrl).toBe(res.json().files[0].url);
    expect(await createThumbnail(Buffer.from('not an image'))).toBeNull();
  });

  it('does not produce a thumbnail for a PDF upload', async () => {
    const res = await app.inject(upload(Buffer.from('%PDF-1.7 test'), 'application/pdf', 'r.pdf'));
    expect(res.statusCode).toBe(201);
    expect(res.json().files[0].url).toMatch(/\/0\.pdf$/);
    expect(res.json().files[0].thumbnailUrl).toBe(res.json().files[0].url);
  });
});
