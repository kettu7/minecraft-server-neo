// Backups: Welt + Server-Einstellungen (aus dem Container gestreamt) und Website-Daten.
// Website-Teil: Datenbank, Schematics und Projektbilder.
// Ablauf: Speichern pausieren (save-off, save-all flush) → packen → Speichern wieder an (save-on).
// Gestaffelte Aufbewahrung: alles der letzten BACKUP_KEEP_HOURS Stunden, danach das neueste pro Tag
// für BACKUP_KEEP_DAYS Tage. Angepinnte Backups werden nie automatisch gelöscht.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { IMAGE_DIR, SCHEMATIC_DIR, db } from './db.ts';
import { Rcon } from './rcon.ts';

export const BACKUP_DIR = process.env.BACKUP_DIR ?? join(import.meta.dirname, '..', '..', 'backups');
export const INTERVAL_MINUTES = Number(process.env.BACKUP_INTERVAL_MINUTES ?? 60);
export const KEEP_HOURS = Number(process.env.BACKUP_KEEP_HOURS ?? 24);
export const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS ?? 14);
const MC_CONTAINER = process.env.MC_CONTAINER ?? 'mc-neo';
/** Im Docker-Betrieb ist der Server-Ordner direkt (schreibgeschützt) eingebunden – dann ohne docker exec packen */
const MC_DATA_DIR = process.env.MC_DATA_DIR ?? '';

/** Was aus /data gesichert wird (BlueMap-Kacheln, Bibliotheken und Mods lassen sich neu erzeugen) */
const WORLD_PATHS = [
  'world', 'server.properties', 'whitelist.json', 'ops.json', 'banned-players.json', 'banned-ips.json',
  'usercache.json', 'config',
];

export const WORLD_FILE = 'world.tar.gz';
const WEBSITE_DB = 'website.db';
const META = 'meta.json';
/** Backup-Ordner: 2026-10-14_19-30-00 */
export const BACKUP_ID = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;

export interface BackupMeta {
  createdAt: string;
  kind: 'auto' | 'manual' | 'import';
  by: string | null;
  durationMs: number;
  pinned: boolean;
}

export interface Backup extends BackupMeta {
  id: string;
  worldBytes: number;
  totalBytes: number;
}

/* ───────────────────────── Aufbewahrung ───────────────────────── */

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/**
 * Welche Backups bleiben? Angepinnte, das neueste überhaupt, alle der letzten keepHours Stunden
 * und für die letzten keepDays Tage jeweils das neueste eines Tages.
 */
export function backupsToKeep(
  backups: Array<{ id: string; createdAt: Date; pinned: boolean }>, now: Date, keepHours: number, keepDays: number,
): Set<string> {
  const keep = new Set<string>();
  const sorted = [...backups].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  if (sorted[0]) keep.add(sorted[0].id);
  const hourLimit = now.getTime() - keepHours * 3600_000;
  const dayLimit = now.getTime() - keepDays * 86400_000;
  const seenDays = new Set<string>();
  for (const b of sorted) {
    const t = b.createdAt.getTime();
    if (b.pinned || t >= hourLimit) keep.add(b.id);
    if (t >= dayLimit && !seenDays.has(dayKey(b.createdAt))) {
      seenDays.add(dayKey(b.createdAt));
      keep.add(b.id);
    }
  }
  return keep;
}

/* ───────────────────────── Auflisten ───────────────────────── */

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? await dirSize(p) : (await stat(p)).size;
  }
  return total;
}

async function readMeta(id: string): Promise<BackupMeta | undefined> {
  try {
    return JSON.parse(await readFile(join(BACKUP_DIR, id, META), 'utf8'));
  } catch {
    return undefined;
  }
}

export async function listBackups(): Promise<Backup[]> {
  await mkdir(BACKUP_DIR, { recursive: true });
  const result: Backup[] = [];
  for (const entry of await readdir(BACKUP_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !BACKUP_ID.test(entry.name)) continue;
    const meta = await readMeta(entry.name);
    if (!meta) continue;
    const dir = join(BACKUP_DIR, entry.name);
    const worldBytes = await stat(join(dir, WORLD_FILE)).then((s) => s.size, () => 0);
    result.push({ id: entry.name, ...meta, worldBytes, totalBytes: await dirSize(dir) });
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function setPinned(id: string, pinned: boolean): Promise<boolean> {
  const meta = BACKUP_ID.test(id) && await readMeta(id);
  if (!meta) return false;
  await writeFile(join(BACKUP_DIR, id, META), JSON.stringify({ ...meta, pinned }, null, 2));
  return true;
}

export async function deleteBackup(id: string): Promise<boolean> {
  if (!BACKUP_ID.test(id) || !(await readMeta(id))) return false;
  await rm(join(BACKUP_DIR, id), { recursive: true, force: true });
  return true;
}

export function worldArchivePath(id: string): string | undefined {
  return BACKUP_ID.test(id) ? join(BACKUP_DIR, id, WORLD_FILE) : undefined;
}

/* ───────────────────────── Sichern ───────────────────────── */

const pad = (n: number) => String(n).padStart(2, '0');
const idFor = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

/** Packt die Welt und streamt das Archiv in eine Datei (direkt oder per docker exec im Server-Container). */
function streamWorldArchive(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tarArgs = (dir: string) => ['czf', '-', '--exclude=world/session.lock', '--ignore-failed-read', '-C', dir, ...WORLD_PATHS];
    const tar = MC_DATA_DIR
      ? spawn('tar', tarArgs(MC_DATA_DIR))
      : spawn('docker', ['exec', MC_CONTAINER, 'tar', ...tarArgs('/data')]);
    const out = createWriteStream(target);
    let stderr = '';
    tar.stdout.pipe(out);
    tar.stderr.on('data', (d) => (stderr += d));
    tar.on('error', reject);
    tar.on('close', (code) => {
      out.end(() => (code === 0 ? resolve() : reject(new Error(`tar beendet mit Code ${code}: ${stderr.trim().slice(0, 300)}`))));
    });
  });
}

let running = false;
let lastRun: { at: string; ok: boolean; error?: string; id?: string } | undefined;
let nextRunAt: Date | undefined;

export function backupStatus() {
  return {
    running,
    lastRun: lastRun ?? null,
    nextRunAt: nextRunAt?.toISOString() ?? null,
    intervalMinutes: INTERVAL_MINUTES,
    keepHours: KEEP_HOURS,
    keepDays: KEEP_DAYS,
  };
}

export async function createBackup(kind: BackupMeta['kind'], by: string | null, log: FastifyBaseLogger): Promise<Backup> {
  if (running) throw new Error('Es läuft bereits ein Backup.');
  running = true;
  const start = new Date();
  const id = idFor(start);
  const partial = join(BACKUP_DIR, `${id}.partial`);
  const rcon = new Rcon();
  let savingOff = false;

  try {
    await mkdir(partial, { recursive: true });

    // 1. Welt: Speichern pausieren, alles auf die Platte schreiben, packen
    await rcon.connect();
    await rcon.command('save-off');
    savingOff = true;
    await rcon.command('save-all flush');
    await streamWorldArchive(join(partial, WORLD_FILE));
    await rcon.command('save-on');
    savingOff = false;

    // 2. Website: konsistente Kopie der Datenbank + hochgeladene Schematics
    db.exec(`VACUUM INTO '${join(partial, WEBSITE_DB).replace(/'/g, "''")}'`);
    await cp(SCHEMATIC_DIR, join(partial, 'schematics'), { recursive: true });
    await cp(IMAGE_DIR, join(partial, 'images'), { recursive: true });

    const meta: BackupMeta = { createdAt: start.toISOString(), kind, by, durationMs: Date.now() - start.getTime(), pinned: false };
    await writeFile(join(partial, META), JSON.stringify(meta, null, 2));
    await rename(partial, join(BACKUP_DIR, id));

    lastRun = { at: start.toISOString(), ok: true, id };
    log.info({ id, kind, ms: meta.durationMs }, 'Backup erstellt');
    await prune(log);
    return (await listBackups()).find((b) => b.id === id)!;
  } catch (err) {
    const message = (err as NodeJS.ErrnoException).code === 'ECONNREFUSED'
      ? 'Minecraft-Server nicht erreichbar.'
      : (err as Error).message;
    lastRun = { at: start.toISOString(), ok: false, error: message };
    log.error(err, 'Backup fehlgeschlagen');
    await rm(partial, { recursive: true, force: true });
    throw new Error(message);
  } finally {
    // Speichern auf jeden Fall wieder einschalten
    if (savingOff) await rcon.command('save-on').catch(() => undefined);
    rcon.close();
    running = false;
  }
}

async function prune(log: FastifyBaseLogger) {
  const backups = await listBackups();
  const keep = backupsToKeep(
    backups.map((b) => ({ id: b.id, createdAt: new Date(b.createdAt), pinned: b.pinned })), new Date(), KEEP_HOURS, KEEP_DAYS,
  );
  for (const b of backups) {
    if (!keep.has(b.id)) {
      await rm(join(BACKUP_DIR, b.id), { recursive: true, force: true });
      log.info({ id: b.id }, 'Altes Backup gelöscht');
    }
  }
  // Reste abgebrochener Läufe entfernen
  for (const entry of await readdir(BACKUP_DIR)) {
    if (entry.endsWith('.partial') && !running) await rm(join(BACKUP_DIR, entry), { recursive: true, force: true });
  }
}

/** Automatische Backups: beim Start nachholen, wenn das letzte zu alt ist, danach im festen Takt. */
export async function startBackupScheduler(log: FastifyBaseLogger) {
  if (!(INTERVAL_MINUTES > 0)) return;
  const interval = INTERVAL_MINUTES * 60_000;
  const run = () => {
    nextRunAt = new Date(Date.now() + interval);
    createBackup('auto', null, log).catch(() => undefined);
  };
  const [latest] = await listBackups();
  const due = !latest || Date.now() - new Date(latest.createdAt).getTime() >= interval;
  const firstDelay = due ? 60_000 : interval - (Date.now() - new Date(latest.createdAt).getTime());
  nextRunAt = new Date(Date.now() + firstDelay);
  setTimeout(() => {
    run();
    setInterval(run, interval).unref();
  }, firstDelay).unref();
  log.info(`Automatische Backups alle ${INTERVAL_MINUTES} Min. (nächstes ${nextRunAt.toLocaleTimeString('de-DE')})`);
}

