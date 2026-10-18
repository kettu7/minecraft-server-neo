import Fastify, { type FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import cookie from '@fastify/cookie';
import { writeFile, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { parseLitematic } from './litematic.ts';
import { DIMENSIONS, MIRRORS, ROTATIONS, type Placement } from './progress.ts';
import { MAX_HEIGHT, MAX_RADIUS, MAX_SCAN_POSITIONS, scanVolume } from './storage.ts';
import { registerAuth, requireAdmin } from './auth.ts';
import { liveStatus, MC_ADDRESS, registerServerAdmin } from './server-admin.ts';
import { registerStats, rankingSettings } from './stats.ts';
import { nextRestartAt, registerAutoRestart } from './auto-restart.ts';
import { registerConsole } from './console.ts';
import { registerProjectImages, removeProjectImages } from './project-images.ts';
import { registerMods } from './mods.ts';
import { registerModpack } from './modpack.ts';
import { contentDisposition } from './download-name.ts';
import { audit } from './users.ts';
import {
  backupStatus, createBackup, deleteBackup, listBackups, setPinned, startBackupScheduler, worldArchivePath,
} from './backup.ts';
import { refresh, refreshStatus, startScheduler, type RefreshReport } from './refresh.ts';
import {
  SCHEMATIC_DIR, allStorageIds, createProject, createStorage, deleteProject, deleteStorage, getProject, getStorage, getStorageArea,
  listProjects, listStorages, setOrder, projectIdsWithPlacement, setPlacement, setProjectStorages, storageIdsOfProject,
  updateStorage, type StorageInput,
} from './db.ts';

const app = Fastify({ logger: { level: 'info' } });
await app.register(cookie);
// Schematics (1 Datei) bzw. Projektbilder (groß + Vorschau = 2 Dateien)
await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 2 } });
// Anmeldung über Discord + Zugriffsprüfung für alle /api-Routen
await registerAuth(app);
await registerServerAdmin(app);
await registerAutoRestart(app);
await registerStats(app);
await registerConsole(app);
await registerProjectImages(app);
await registerMods(app);
await registerModpack(app);

app.get('/api/health', async () => ({ ok: true }));

/** Ein Lauf ohne Verbindung zum Server ist ein Fehler; Fehler einzelner Lager/Projekte stehen im Bericht. */
function sendRefresh<T>(reply: FastifyReply, report: RefreshReport, body: T) {
  if (report.error) return reply.code(502).send({ error: report.error });
  return { ...body, report };
}

/* ───────────────────────── Projekte ───────────────────────── */

app.get('/api/projects', async () => listProjects());

// Reihenfolge der Kacheln für alle (Drag & Drop in der Übersicht)
const orderIds = (body: unknown) => {
  const ids = (body as { ids?: unknown })?.ids;
  return Array.isArray(ids) && ids.length <= 1000 && ids.every((id) => Number.isInteger(id) && id > 0) ? (ids as number[]) : null;
};
app.put<{ Body: { ids?: number[] } }>('/api/projects/order', async (req, reply) => {
  const ids = orderIds(req.body);
  if (!ids) return reply.code(400).send({ error: 'Ungültige Reihenfolge.' });
  setOrder('projects', ids);
  return listProjects();
});
app.put<{ Body: { ids?: number[] } }>('/api/storages/order', async (req, reply) => {
  const ids = orderIds(req.body);
  if (!ids) return reply.code(400).send({ error: 'Ungültige Reihenfolge.' });
  setOrder('storages', ids);
  return listStorages();
});

app.get<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
  const project = getProject(Number(req.params.id));
  return project ?? reply.code(404).send({ error: 'Projekt nicht gefunden' });
});

// Upload: multipart mit Feldern "name", "description" (optional) und Datei "file" (.litematic)
app.post('/api/projects', async (req, reply) => {
  const fields: Record<string, string> = {};
  let file: { name: string; data: Buffer } | undefined;

  for await (const part of req.parts()) {
    if (part.type === 'file') file = { name: part.filename, data: await part.toBuffer() };
    else fields[part.fieldname] = String(part.value);
  }
  if (!file || !file.name.toLowerCase().endsWith('.litematic')) {
    return reply.code(400).send({ error: 'Bitte eine .litematic-Datei hochladen.' });
  }

  let schematic;
  try {
    schematic = await parseLitematic(file.data);
  } catch (err) {
    req.log.warn(err, 'Litematic konnte nicht gelesen werden');
    return reply.code(400).send({ error: 'Die Datei konnte nicht gelesen werden. Ist es eine gültige .litematic-Datei?' });
  }

  const name = fields.name?.trim() || schematic.name;
  const id = createProject(name, fields.description?.trim() ?? '', file.name, schematic);
  await writeFile(join(SCHEMATIC_DIR, `${id}.litematic`), file.data);
  return reply.code(201).send(getProject(id));
});

// Standort der Blaupause in der Welt (Werte aus Litematica: Schematic Placements → Configure)
app.put<{ Params: { id: string }; Body: Partial<Placement> }>('/api/projects/:id/placement', async (req, reply) => {
  const b = req.body ?? {};
  const placement = {
    x: Number(b.x), y: Number(b.y), z: Number(b.z),
    rotation: b.rotation ?? 'NONE', mirror: b.mirror ?? 'NONE', dimension: b.dimension ?? 'minecraft:overworld',
  } as Placement;
  if (![placement.x, placement.y, placement.z].every(Number.isInteger)
    || !ROTATIONS.includes(placement.rotation) || !MIRRORS.includes(placement.mirror) || !DIMENSIONS.includes(placement.dimension)) {
    return reply.code(400).send({ error: 'Ungültiger Standort. X, Y und Z müssen ganze Zahlen sein.' });
  }
  const id = Number(req.params.id);
  if (!setPlacement(id, placement)) return reply.code(404).send({ error: 'Projekt nicht gefunden' });
  return getProject(id);
});

// Welche Lager versorgen dieses Projekt?
app.put<{ Params: { id: string }; Body: { storageIds?: number[] } }>('/api/projects/:id/storages', async (req, reply) => {
  const ids = (req.body?.storageIds ?? []).map(Number).filter(Number.isInteger);
  const id = Number(req.params.id);
  if (!setProjectStorages(id, ids)) return reply.code(404).send({ error: 'Projekt nicht gefunden' });
  return getProject(id);
});

// Lager des Projekts scannen und Baufortschritt prüfen
app.post<{ Params: { id: string } }>('/api/projects/:id/refresh', async (req, reply) => {
  const id = Number(req.params.id);
  if (!getProject(id)) return reply.code(404).send({ error: 'Projekt nicht gefunden' });
  const report = await refresh({ storageIds: storageIdsOfProject(id), projectIds: [id] }, 'manual', req.log);
  return sendRefresh(reply, report, { project: getProject(id) });
});

// Blaupause herunterladen (z. B. in den schematics-Ordner von Litematica)
app.get<{ Params: { id: string } }>('/api/projects/:id/schematic', async (req, reply) => {
  const id = Number(req.params.id);
  const project = getProject(id);
  const file = join(SCHEMATIC_DIR, `${id}.litematic`);
  const size = project && await stat(file).then((s) => s.size, () => undefined);
  if (!project || size === undefined) return reply.code(404).send({ error: 'Blaupause nicht gefunden.' });
  return reply
    .header('Content-Type', 'application/octet-stream')
    .header('Content-Length', size)
    .header('Content-Disposition', contentDisposition(String(project.schematicName)))
    .send(createReadStream(file));
});

app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const id = Number(req.params.id);
  audit(req.user!.id, 'projekt gelöscht', String(getProject(id)?.name ?? id));
  if (!deleteProject(id)) return reply.code(404).send({ error: 'Projekt nicht gefunden' });
  await rm(join(SCHEMATIC_DIR, `${id}.litematic`), { force: true });
  await removeProjectImages(id);
  return reply.code(204).send();
});

/* ───────────────────────── Lager ───────────────────────── */

function parseStorage(b: Partial<Record<keyof StorageInput, unknown>>): StorageInput | string {
  const s = {
    name: String(b.name ?? '').trim().slice(0, 60),
    x: Number(b.x), y: Number(b.y), z: Number(b.z),
    radius: Number(b.radius), height: Number(b.height),
    dimension: (b.dimension ?? 'minecraft:overworld') as StorageInput['dimension'],
    includeShulkers: b.includeShulkers !== false,
  };
  if (!s.name) return 'Bitte einen Namen angeben.';
  if (![s.x, s.y, s.z, s.radius, s.height].every(Number.isInteger)) return 'Koordinaten, Radius und Höhe müssen ganze Zahlen sein.';
  if (s.radius < 0 || s.radius > MAX_RADIUS) return `Radius muss zwischen 0 und ${MAX_RADIUS} liegen.`;
  if (s.height < 0 || s.height > MAX_HEIGHT) return `Höhe muss zwischen 0 und ${MAX_HEIGHT} liegen.`;
  if (!DIMENSIONS.includes(s.dimension)) return 'Unbekannte Dimension.';
  const volume = scanVolume(s);
  if (volume > MAX_SCAN_POSITIONS) return `Bereich zu groß: ${volume} Positionen (höchstens ${MAX_SCAN_POSITIONS}).`;
  return s;
}

app.get('/api/storages', async () => listStorages());

app.get<{ Params: { id: string } }>('/api/storages/:id', async (req, reply) => {
  return getStorage(Number(req.params.id)) ?? reply.code(404).send({ error: 'Lager nicht gefunden' });
});

app.post<{ Body: Partial<StorageInput> }>('/api/storages', async (req, reply) => {
  const input = parseStorage(req.body ?? {});
  if (typeof input === 'string') return reply.code(400).send({ error: input });
  const id = createStorage(input);
  const report = await refresh({ storageIds: [id], projectIds: [] }, 'manual', req.log);
  // Das Lager ist angelegt, auch wenn der erste Scan scheitert (Fehler steht dann am Lager)
  return reply.code(201).send({ storage: getStorage(id), report });
});

app.put<{ Params: { id: string }; Body: Partial<StorageInput> }>('/api/storages/:id', async (req, reply) => {
  const input = parseStorage(req.body ?? {});
  if (typeof input === 'string') return reply.code(400).send({ error: input });
  const id = Number(req.params.id);
  const { found, areaChanged } = updateStorage(id, input);
  if (!found) return reply.code(404).send({ error: 'Lager nicht gefunden' });
  if (!areaChanged) return { storage: getStorage(id) };
  const report = await refresh({ storageIds: [id], projectIds: [] }, 'manual', req.log);
  return { storage: getStorage(id), report };
});

app.post<{ Params: { id: string } }>('/api/storages/:id/scan', async (req, reply) => {
  const id = Number(req.params.id);
  if (!getStorage(id)) return reply.code(404).send({ error: 'Lager nicht gefunden' });
  const report = await refresh({ storageIds: [id], projectIds: [] }, 'manual', req.log);
  return sendRefresh(reply, report, { storage: getStorage(id) });
});

app.delete<{ Params: { id: string } }>('/api/storages/:id', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  audit(req.user!.id, 'lager gelöscht', getStorageArea(Number(req.params.id))?.name ?? req.params.id);
  if (!deleteStorage(Number(req.params.id))) return reply.code(404).send({ error: 'Lager nicht gefunden' });
  return reply.code(204).send();
});

/* ───────────────────────── Backups (Admin) ───────────────────────── */

app.get('/api/backups', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  return { backups: await listBackups(), status: backupStatus() };
});

app.post('/api/backups', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  try {
    const backup = await createBackup('manual', req.user!.displayName, req.log);
    audit(req.user!.id, 'backup erstellt', backup.id);
    return backup;
  } catch (err) {
    return reply.code(502).send({ error: (err as Error).message });
  }
});

// Anpinnen schützt vor dem automatischen Aufräumen
app.patch<{ Params: { id: string }; Body: { pinned?: boolean } }>('/api/backups/:id', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const pinned = req.body?.pinned === true;
  if (!(await setPinned(req.params.id, pinned))) return reply.code(404).send({ error: 'Backup nicht gefunden.' });
  audit(req.user!.id, pinned ? 'backup angepinnt' : 'backup gelöst', req.params.id);
  return { ok: true };
});

app.delete<{ Params: { id: string } }>('/api/backups/:id', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  if (!(await deleteBackup(req.params.id))) return reply.code(404).send({ error: 'Backup nicht gefunden.' });
  audit(req.user!.id, 'backup gelöscht', req.params.id);
  return reply.code(204).send();
});

app.get<{ Params: { id: string } }>('/api/backups/:id/download', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const file = worldArchivePath(req.params.id);
  const size = file && await stat(file).then((s) => s.size, () => undefined);
  if (!file || size === undefined) return reply.code(404).send({ error: 'Backup nicht gefunden.' });
  audit(req.user!.id, 'backup heruntergeladen', req.params.id);
  return reply
    .header('Content-Type', 'application/gzip')
    .header('Content-Length', size)
    .header('Content-Disposition', `attachment; filename="neo-welt-${req.params.id}.tar.gz"`)
    .send(createReadStream(file));
});

/* ───────────────────────── Aktualisierung ───────────────────────── */

app.get('/api/status', async () => {
  const { names: _names, ...server } = await liveStatus();
  return { ...refreshStatus(), server };
});

// Dashboard: Server mit Spielernamen, Adresse und nächstem geplanten Neustart
app.get('/api/dashboard', async () => ({
  server: await liveStatus(),
  address: MC_ADDRESS,
  nextRestartAt: nextRestartAt(),
  rankings: rankingSettings().enabled,
}));

app.post('/api/refresh', async (req, reply) => {
  const report = await refresh({ storageIds: allStorageIds(), projectIds: projectIdsWithPlacement() }, 'manual', req.log);
  return sendRefresh(reply, report, {});
});

await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3000) });
startScheduler(app.log);
await startBackupScheduler(app.log);
