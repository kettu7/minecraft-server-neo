// Admin → Mods → Konfiguration: Die Config-Dateien der Mods (Ordner config/ im Server-Ordner) ansehen und ändern.
// Gelesen wird hier (der Server-Ordner ist nur lesend eingebunden), geschrieben vom Steuerdienst neo-control.
// Vor dem Speichern wird das Format geprüft und der alte Stand gemerkt, damit sich jede Änderung zurückholen lässt.
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import JSON5 from 'json5';
import { parse as parseToml } from 'smol-toml';
import { db } from './db.ts';
import { requireAdmin } from './auth.ts';
import { audit } from './users.ts';
import { control } from './server-admin.ts';
import { installedVersions, MC_DATA_DIR } from './modrinth.ts';
import { readFabricMeta } from './mod-compat.ts';
import { listManaged } from './mod-manager.ts';

export const CONFIG_EXTENSIONS = ['.json', '.json5', '.toml', '.properties', '.yml', '.yaml', '.cfg', '.conf', '.txt', '.snbt'];
export const CONFIG_MAX_BYTES = 512 * 1024;
const MAX_FILES = 400;
const MAX_DEPTH = 3;
const KEEP_VERSIONS = 20;

db.exec(`
  CREATE TABLE IF NOT EXISTS config_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    path       TEXT NOT NULL,
    content    TEXT NOT NULL,
    by_name    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS config_history_path ON config_history (path, id);
`);

/* ───────────────────────── Reine Hilfen (getestet) ───────────────────────── */

const extensionOf = (path: string) => {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot).toLowerCase();
};

/** Pfad relativ zu config/ prüfen: nur Unterordner und Dateien, keine "..", keine versteckten Namen. null = ungültig */
export function safeConfigPath(rel: unknown): string | null {
  if (typeof rel !== 'string' || !rel || rel.length > 200 || /[\\\0]/.test(rel)) return null;
  if (rel.split('/').some((p) => !p || p.startsWith('.'))) return null;
  return CONFIG_EXTENSIONS.includes(extensionOf(rel)) ? rel : null;
}

/** Inhalt auf das Format prüfen, das die Endung verspricht. Liefert eine verständliche Meldung oder null (in Ordnung). */
export function configProblem(path: string, content: string): string | null {
  if (content.includes('\0')) return 'Die Datei enthält ungültige Zeichen.';
  try {
    switch (extensionOf(path)) {
      case '.json': JSON.parse(content); break;
      case '.json5': JSON5.parse(content); break;
      case '.toml': parseToml(content); break;
    }
  } catch (err) {
    const format = { '.json': 'JSON', '.json5': 'JSON5', '.toml': 'TOML' }[extensionOf(path)];
    return `Kein gültiges ${format}: ${(err as Error).message.split('\n')[0]}`;
  }
  return null;
}

/** Zeilenenden der Datei beibehalten: Browser liefern \n, Windows-Dateien brauchen \r\n */
export function keepLineEndings(original: string, next: string) {
  return original.includes('\r\n') && !next.includes('\r') ? next.replace(/\n/g, '\r\n') : next;
}

const dashed = (s: string) => s.toLowerCase().replace(/[_.\s]+/g, '-');
const squeezed = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Welcher Mod gehört die Datei? Üblich ist config/<modid>.json oder config/<modid>/… (auch config/<modid>-client.toml).
 * Bei mehreren Treffern gewinnt der längste Name (fabric-api vor fabric).
 */
export function ownerOf<T>(path: string, owners: Array<{ key: string; ref: T }>): T | null {
  const top = path.split('/')[0];
  const stem = path.includes('/') ? top : top.slice(0, top.length - extensionOf(top).length);
  let best: { length: number; ref: T } | null = null;
  for (const { key, ref } of owners) {
    if (squeezed(key).length < 3) continue;
    const fits = squeezed(stem) === squeezed(key) || dashed(stem).startsWith(`${dashed(key)}-`);
    if (fits && (!best || key.length > best.length)) best = { length: key.length, ref };
  }
  return best?.ref ?? null;
}

/* ───────────────────────── Dateien lesen ───────────────────────── */

const CONFIG_DIR = MC_DATA_DIR ? join(MC_DATA_DIR, 'config') : '';

interface ConfigEntry { path: string; size: number; modified: number }

async function walk(dir: string, prefix: string, depth: number, out: ConfigEntry[]) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (out.length >= MAX_FILES || entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) await walk(join(dir, entry.name), rel, depth + 1, out);
    } else if (entry.isFile() && safeConfigPath(rel)) {
      const info = await stat(join(dir, entry.name));
      if (info.size <= CONFIG_MAX_BYTES) out.push({ path: rel, size: info.size, modified: info.mtimeMs });
    }
  }
}

/** Mod-IDs der installierten Jars (aus der fabric.mod.json), je Datei einmal gelesen */
const idCache = new Map<string, string[]>();

async function jarIds(file: string): Promise<string[]> {
  const path = join(MC_DATA_DIR, 'mods', file);
  const info = await stat(path);
  const key = `${file}|${info.size}|${info.mtimeMs}`;
  let ids = idCache.get(key);
  if (!ids) {
    try {
      const meta = readFabricMeta(await readFile(path));
      ids = meta ? [meta.mods[0].id, ...meta.mods[0].provides] : [];
    } catch {
      ids = [];
    }
    idCache.set(key, ids);
  }
  return ids;
}

async function owners() {
  const managed = listManaged();
  const byId = new Map(managed.map((m) => [m.projectId, m]));
  const list: Array<{ key: string; ref: { projectId: string; title: string } }> = [];
  // Namen aus der Mod-Liste (Kurzname bei Modrinth) ...
  for (const m of managed) list.push({ key: m.slug, ref: { projectId: m.projectId, title: m.title } });
  // ... und die echten Mod-IDs aus den installierten Dateien
  const installed = await installedVersions().catch(() => null);
  for (const [projectId, { jar }] of installed?.byProject ?? []) {
    const mod = byId.get(projectId);
    if (!mod) continue;
    for (const id of await jarIds(jar.file).catch(() => [])) list.push({ key: id, ref: { projectId, title: mod.title } });
  }
  return list;
}

async function readConfig(rel: string) {
  const file = join(CONFIG_DIR, ...rel.split('/'));
  // Der Pfad muss wirklich unter config/ liegen (keine Links nach außen) und eine normale Datei sein
  const [real, root, info] = await Promise.all([realpath(file), realpath(CONFIG_DIR), lstat(file)]);
  if (real !== join(root, ...rel.split('/')) || !info.isFile()) throw new Error('Datei nicht gefunden.');
  if (info.size > CONFIG_MAX_BYTES) throw new Error('Datei ist zu groß.');
  return { content: await readFile(file, 'utf8'), modified: info.mtimeMs, size: info.size };
}

/* ───────────────────────── Verlauf ───────────────────────── */

const historyOf = (path: string) =>
  db.prepare(`SELECT id, by_name AS by, created_at AS createdAt, length(content) AS size FROM config_history WHERE path = ? ORDER BY id DESC LIMIT ?`)
    .all(path, KEEP_VERSIONS) as Array<{ id: number; by: string; createdAt: string; size: number }>;

function remember(path: string, content: string, by: string) {
  db.prepare('INSERT INTO config_history (path, content, by_name) VALUES (?, ?, ?)').run(path, content, by);
  db.prepare(`DELETE FROM config_history WHERE path = ? AND id NOT IN (SELECT id FROM config_history WHERE path = ? ORDER BY id DESC LIMIT ?)`)
    .run(path, path, KEEP_VERSIONS);
}

/* ───────────────────────── Routen ───────────────────────── */

export async function registerConfigFiles(app: FastifyInstance) {
  const unavailable = (reply: Parameters<typeof requireAdmin>[1]) =>
    reply.code(503).send({ error: 'Server-Dateien nicht eingebunden (nur im Docker-Betrieb verfügbar).' });

  app.get('/api/configs', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!CONFIG_DIR) return unavailable(reply);
    const entries: ConfigEntry[] = [];
    await walk(CONFIG_DIR, '', 1, entries);
    const known = await owners();
    return {
      files: entries
        .sort((a, b) => a.path.localeCompare(b.path, 'de'))
        .map((f) => ({ ...f, mod: ownerOf(f.path, known) })),
    };
  });

  app.get<{ Querystring: { path?: string } }>('/api/configs/file', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!CONFIG_DIR) return unavailable(reply);
    const path = safeConfigPath(req.query.path);
    if (!path) return reply.code(400).send({ error: 'Ungültiger Pfad.' });
    try {
      return { path, ...(await readConfig(path)), history: historyOf(path) };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message === 'Datei ist zu groß.' ? 'Datei ist zu groß.' : 'Datei nicht gefunden.' });
    }
  });

  // Früherer Stand zum Zurückholen (landet im Editor, gespeichert wird erst per Knopf)
  app.get<{ Params: { id: string } }>('/api/configs/history/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const row = db.prepare('SELECT path, content, by_name AS by, created_at AS createdAt FROM config_history WHERE id = ?').get(Number(req.params.id));
    return row ?? reply.code(404).send({ error: 'Stand nicht gefunden.' });
  });

  app.put<{ Body: { path?: string; content?: string; modified?: number } }>('/api/configs/file', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!CONFIG_DIR) return unavailable(reply);
    const path = safeConfigPath(req.body?.path);
    const content = req.body?.content;
    if (!path || typeof content !== 'string') return reply.code(400).send({ error: 'Pfad oder Inhalt fehlt.' });
    if (Buffer.byteLength(content) > CONFIG_MAX_BYTES) return reply.code(400).send({ error: 'Datei ist zu groß (höchstens 512 KB).' });
    const problem = configProblem(path, content);
    if (problem) return reply.code(400).send({ error: problem });

    let current;
    try {
      current = await readConfig(path);
    } catch {
      return reply.code(404).send({ error: 'Datei nicht gefunden.' });
    }
    // Hat sich die Datei seit dem Laden geändert (z. B. schreibt die Mod sie beim Beenden neu), nicht blind überschreiben
    if (typeof req.body.modified === 'number' && Math.abs(req.body.modified - current.modified) > 1) {
      return reply.code(409).send({ error: 'Die Datei wurde inzwischen geändert (zum Beispiel von der Mod selbst). Bitte neu laden.' });
    }

    const next = keepLineEndings(current.content, content);
    if (next === current.content) return { ok: true, unchanged: true, modified: current.modified, history: historyOf(path) };
    try {
      await control('PUT', `/config?path=${encodeURIComponent(path)}`, 15_000, { content: next });
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
    remember(path, current.content, req.user!.displayName);
    // Nur Pfad und Größe ins Protokoll – Configs können Zugangsdaten enthalten
    audit(req.user!.id, 'config geändert', `${path} (${Buffer.byteLength(next)} Byte)`);
    const saved = await readConfig(path).catch(() => null);
    return { ok: true, modified: saved?.modified ?? Date.now(), history: historyOf(path) };
  });
}
