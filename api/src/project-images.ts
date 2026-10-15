// Projektbilder: großes Bild + Vorschaubild (beides im Browser verkleinert), gespeichert unter data/images.
import { createReadStream } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { IMAGE_DIR, getProjectImageType, setProjectImage } from './db.ts';
import { audit } from './users.ts';

const MAX_BYTES = 5 * 1024 * 1024;
const EXT: Record<string, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };

/** Bildtyp anhand der ersten Bytes – nicht dem vertrauen, was der Browser angibt */
export function detectImageType(buf: Buffer): keyof typeof EXT | undefined {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return undefined;
}

const fileFor = (id: number, type: string, thumb: boolean) => join(IMAGE_DIR, `${id}${thumb ? '-thumb' : ''}.${EXT[type]}`);

export async function removeProjectImages(id: number) {
  for (const ext of Object.values(EXT)) {
    await rm(join(IMAGE_DIR, `${id}.${ext}`), { force: true });
    await rm(join(IMAGE_DIR, `${id}-thumb.${ext}`), { force: true });
  }
}

export async function registerProjectImages(app: FastifyInstance) {
  // Multipart mit "image" (groß) und optional "thumb" (klein)
  app.put<{ Params: { id: string } }>('/api/projects/:id/image', async (req, reply) => {
    const id = Number(req.params.id);
    if (getProjectImageType(id) === undefined) return reply.code(404).send({ error: 'Projekt nicht gefunden.' });

    const files: Record<string, Buffer> = {};
    for await (const part of req.parts()) {
      if (part.type === 'file' && (part.fieldname === 'image' || part.fieldname === 'thumb')) {
        files[part.fieldname] = await part.toBuffer();
      }
    }
    const image = files.image;
    if (!image) return reply.code(400).send({ error: 'Kein Bild erhalten.' });
    if (image.length > MAX_BYTES) return reply.code(413).send({ error: 'Bild ist zu groß (max. 5 MB).' });
    const type = detectImageType(image);
    if (!type) return reply.code(400).send({ error: 'Nur WebP, JPEG oder PNG.' });
    const thumb = files.thumb && detectImageType(files.thumb) === type ? files.thumb : image;

    await removeProjectImages(id);
    await writeFile(fileFor(id, type, false), image);
    await writeFile(fileFor(id, type, true), thumb);
    setProjectImage(id, type);
    audit(req.user!.id, 'projektbild gesetzt', String(id));
    return { ok: true };
  });

  app.get<{ Params: { id: string }; Querystring: { size?: string } }>('/api/projects/:id/image', async (req, reply) => {
    const id = Number(req.params.id);
    const type = getProjectImageType(id);
    if (!type) return reply.code(404).send({ error: 'Kein Bild.' });
    // Die URL enthält eine Version (?v=…) → darf lange zwischengespeichert werden
    return reply
      .header('Content-Type', type)
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(createReadStream(fileFor(id, type, req.query.size === 'thumb')));
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id/image', async (req, reply) => {
    const id = Number(req.params.id);
    if (getProjectImageType(id) === undefined) return reply.code(404).send({ error: 'Projekt nicht gefunden.' });
    await removeProjectImages(id);
    setProjectImage(id, null);
    audit(req.user!.id, 'projektbild entfernt', String(id));
    return reply.code(204).send();
  });
}
