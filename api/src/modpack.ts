// Modpack für Spieler (.mrpack, Modrinth-Format): gleiche Basis für alle, passend zum Server.
// Inhalt: Server-Mods, die auch beim Spieler laufen müssen (automatisch), plus reine Spieler-Mods,
// Ressourcenpakete und Shader, die ein Admin hinzufügt – jeweils als Pflicht oder optional.
// Das Pack enthält keine Jar-Dateien, nur Download-Links zu Modrinth samt Prüfsummen; der Launcher lädt selbst.
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { db, transaction } from './db.ts';
import { requireAdmin } from './auth.ts';
import { audit } from './users.ts';
import { notify } from './notifications.ts';
import { appliedMods, ensureSeeded, getState, listManaged, requiredProjects, setState } from './mod-manager.ts';
import {
  cached,
  iconUrl,
  PACK_KINDS,
  pickVersion,
  primaryFile,
  PROJECT_ID,
  projectsById,
  projectVersions,
  readInstallation,
  searchMods,
  versionsById,
  type MrVersion,
  type PackKind,
  type Side,
} from './modrinth.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS pack_items (
    project_id        TEXT PRIMARY KEY,
    kind              TEXT NOT NULL DEFAULT 'mod',      -- mod | resourcepack | shader
    slug              TEXT NOT NULL,
    title             TEXT NOT NULL,
    description       TEXT NOT NULL DEFAULT '',
    has_icon          INTEGER NOT NULL DEFAULT 0,
    client_side       TEXT NOT NULL DEFAULT 'unknown',
    server_side       TEXT NOT NULL DEFAULT 'unknown',
    version_id        TEXT NOT NULL,
    version_number    TEXT NOT NULL,
    version_published TEXT NOT NULL DEFAULT '',
    requires          TEXT NOT NULL DEFAULT '[]',
    mode              TEXT NOT NULL DEFAULT 'required', -- required | optional | excluded
    auto              INTEGER NOT NULL DEFAULT 0,       -- als Abhängigkeit hinzugefügt
    note              TEXT NOT NULL DEFAULT '',
    file_url          TEXT NOT NULL,
    file_name         TEXT NOT NULL,
    file_sha1         TEXT NOT NULL,
    file_sha512       TEXT NOT NULL,
    file_size         INTEGER NOT NULL,
    added_by          TEXT,
    added_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

/* ───────────────────────── Typen ───────────────────────── */

export type PackMode = 'required' | 'optional' | 'excluded';
export type ServerPackMode = 'auto' | PackMode;

export interface PackSource {
  projectId: string;
  title: string;
  kind: PackKind;
  source: 'server' | 'client';
  mode: PackMode;
  /** muss beim Spieler installiert sein, sonst kommt man nicht auf den Server */
  locked: boolean;
  requires: string[];
}

export interface PackFile {
  url: string;
  filename: string;
  sha1: string;
  sha512: string;
  size: number;
}

/* ───────────────────────── Reine Hilfen (getestet) ───────────────────────── */

/** Effektiver Modus eines Server-Mods im Pack */
export function serverPackMode(clientSide: Side, setting: ServerPackMode): { mode: PackMode; locked: boolean } {
  if (clientSide === 'required') return { mode: 'required', locked: true };
  if (clientSide === 'unsupported') return { mode: 'excluded', locked: true };
  return { mode: setting === 'auto' ? 'excluded' : setting, locked: false };
}

/**
 * Was kommt ins Pack? Benötigte Mods werden automatisch aufgenommen (bzw. zur Pflicht, wenn ein Pflicht-Mod sie braucht).
 * Gibt je Projekt den endgültigen Modus und ggf. den Grund zurück, außerdem fehlende Abhängigkeiten.
 */
export function resolvePack(sources: PackSource[]) {
  const byId = new Map(sources.map((s) => [s.projectId, s]));
  const result = new Map<string, { mode: 'required' | 'optional'; reason?: string }>();
  for (const s of sources) if (s.mode !== 'excluded') result.set(s.projectId, { mode: s.mode });
  const problems: string[] = [];

  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, entry] of result) {
      const s = byId.get(id)!;
      for (const dep of s.requires) {
        const target = result.get(dep);
        const depSource = byId.get(dep);
        if (!target) {
          if (!depSource) continue; // nicht in der Liste: unten als Problem gemeldet
          result.set(dep, { mode: entry.mode, reason: `gebraucht von ${s.title}` });
          changed = true;
        } else if (entry.mode === 'required' && target.mode === 'optional') {
          result.set(dep, { mode: 'required', reason: `gebraucht von ${s.title}` });
          changed = true;
        }
      }
    }
  }
  for (const [id] of result) {
    const s = byId.get(id)!;
    for (const dep of s.requires) {
      if (!byId.has(dep)) problems.push(`${s.title} braucht einen Mod, der nicht im Pack ist (${dep}).`);
    }
  }
  return { entries: result, problems };
}

/** Ordner im Spiel-Verzeichnis je Art */
export const packFolder = (kind: PackKind) => ({ mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' })[kind];

/** modrinth.index.json nach Modrinth-Spezifikation (formatVersion 1) */
export function packIndex(
  meta: { version: string; minecraft: string; loader: string },
  files: Array<{ kind: PackKind; mode: 'required' | 'optional'; file: PackFile }>,
) {
  return {
    formatVersion: 1,
    game: 'minecraft',
    versionId: meta.version,
    name: 'Neo',
    summary: 'Modpack für den Minecraft-Server Neo – gleiche Mods für alle.',
    files: files
      .map((f) => ({
        path: `${packFolder(f.kind)}/${f.file.filename}`,
        hashes: { sha1: f.file.sha1, sha512: f.file.sha512 },
        env: { client: f.mode, server: 'unsupported' },
        downloads: [f.file.url],
        fileSize: f.file.size,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    dependencies: { minecraft: meta.minecraft, 'fabric-loader': meta.loader },
  };
}

/* ───────────────────────── Datenbank ───────────────────────── */

interface ItemRow {
  project_id: string; kind: PackKind; slug: string; title: string; description: string; has_icon: number;
  client_side: Side; server_side: Side; version_id: string; version_number: string; version_published: string;
  requires: string; mode: PackMode; auto: number; note: string; file_url: string; file_name: string;
  file_sha1: string; file_sha512: string; file_size: number; added_by: string | null; added_at: string;
}

const listItems = () => db.prepare('SELECT * FROM pack_items ORDER BY title COLLATE NOCASE').all() as unknown as ItemRow[];
const getItem = (id: string) => db.prepare('SELECT * FROM pack_items WHERE project_id = ?').get(id) as unknown as ItemRow | undefined;
const serverPackSettings = () =>
  new Map((db.prepare('SELECT project_id, pack_mode FROM server_mods').all() as Array<{ project_id: string; pack_mode: ServerPackMode }>)
    .map((r) => [r.project_id, r.pack_mode]));

function saveItem(r: ItemRow) {
  db.prepare(`
    INSERT INTO pack_items (project_id, kind, slug, title, description, has_icon, client_side, server_side, version_id, version_number,
      version_published, requires, mode, auto, note, file_url, file_name, file_sha1, file_sha512, file_size, added_by, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET kind = excluded.kind, slug = excluded.slug, title = excluded.title,
      description = excluded.description, has_icon = excluded.has_icon, client_side = excluded.client_side,
      server_side = excluded.server_side, version_id = excluded.version_id, version_number = excluded.version_number,
      version_published = excluded.version_published, requires = excluded.requires, mode = excluded.mode, auto = excluded.auto,
      note = excluded.note, file_url = excluded.file_url, file_name = excluded.file_name, file_sha1 = excluded.file_sha1,
      file_sha512 = excluded.file_sha512, file_size = excluded.file_size
  `).run(
    r.project_id, r.kind, r.slug, r.title, r.description, r.has_icon, r.client_side, r.server_side, r.version_id, r.version_number,
    r.version_published, r.requires, r.mode, r.auto, r.note, r.file_url, r.file_name, r.file_sha1, r.file_sha512, r.file_size,
    r.added_by, r.added_at,
  );
}

function versionRow(base: Omit<ItemRow, 'version_id' | 'version_number' | 'version_published' | 'requires' | 'file_url' | 'file_name' | 'file_sha1' | 'file_sha512' | 'file_size'>, v: MrVersion, requires: string[]): ItemRow {
  const f = primaryFile(v);
  if (!f) throw new Error(`${base.title} ${v.version_number} hat keine Datei.`);
  return {
    ...base,
    version_id: v.id,
    version_number: v.version_number,
    version_published: v.date_published,
    requires: JSON.stringify(requires),
    file_url: f.url,
    file_name: f.filename,
    file_sha1: f.hashes.sha1,
    file_sha512: f.hashes.sha512,
    file_size: f.size,
  };
}

/* ───────────────────────── Pack zusammenstellen ───────────────────────── */

async function gameAndLoader() {
  const { minecraft, loader } = await readInstallation();
  if (!minecraft || !loader) throw new Error('Minecraft-/Fabric-Version unbekannt (Server-Dateien nicht gefunden).');
  return { minecraft, loader };
}

/** Alles, was fürs Pack in Frage kommt, mit endgültigem Modus und Datei */
async function assemble() {
  await ensureSeeded();
  // Server-Mods: nur der übernommene Stand – das Pack muss zum laufenden Server passen
  const server = appliedMods().filter((m) => m.enabled);
  const settings = serverPackSettings();
  const items = listItems();
  const serverIds = new Set(server.map((m) => m.projectId));

  const sources: PackSource[] = [
    ...server.map((m) => {
      const { mode, locked } = serverPackMode(m.clientSide, settings.get(m.projectId) ?? 'auto');
      return { projectId: m.projectId, title: m.title, kind: 'mod' as const, source: 'server' as const, mode, locked, requires: m.requires };
    }),
    ...items
      .filter((i) => !serverIds.has(i.project_id))
      .map((i) => ({
        projectId: i.project_id, title: i.title, kind: i.kind, source: 'client' as const, mode: i.mode, locked: false,
        requires: JSON.parse(i.requires) as string[],
      })),
  ];
  const { entries, problems } = resolvePack(sources);

  // Dateien der Server-Mods (übernommene Version) bei Modrinth nachschlagen
  const versionIds = server.map((m) => m.versionId).sort();
  const versions = await cached(`pack-versions|${versionIds.join(',')}`, false, () => versionsById(versionIds));
  const serverFiles = new Map<string, PackFile>();
  for (const v of versions) {
    const f = primaryFile(v);
    if (f) serverFiles.set(v.project_id, { url: f.url, filename: f.filename, sha1: f.hashes.sha1, sha512: f.hashes.sha512, size: f.size });
  }
  const itemFiles = new Map(items.map((i) => [i.project_id, {
    url: i.file_url, filename: i.file_name, sha1: i.file_sha1, sha512: i.file_sha512, size: i.file_size,
  }]));

  const files: Array<{ projectId: string; kind: PackKind; mode: 'required' | 'optional'; file: PackFile }> = [];
  for (const [id, entry] of entries) {
    const source = sources.find((s) => s.projectId === id)!;
    const file = source.source === 'server' ? serverFiles.get(id) : itemFiles.get(id);
    if (!file) problems.push(`Für ${source.title} wurde keine Datei gefunden.`);
    else files.push({ projectId: id, kind: source.kind, mode: entry.mode, file });
  }
  return { server, items, sources, entries, problems, files };
}

/** Versionsnummer des Packs: zählt hoch, sobald sich der Inhalt ändert */
async function packVersion(files: Array<{ mode: string; file: PackFile }>, minecraft: string, loader: string) {
  const fingerprint = createHash('sha1')
    .update([minecraft, loader, ...files.map((f) => `${f.file.sha1}|${f.mode}`).sort()].join('\n'))
    .digest('hex');
  const state = getState<{ hash: string; n: number; at: string }>('pack_version');
  if (state?.hash === fingerprint) return state;
  const next = { hash: fingerprint, n: (state?.n ?? 0) + 1, at: new Date().toISOString() };
  setState('pack_version', next);
  return next;
}

async function packInfo() {
  const { minecraft, loader } = await gameAndLoader();
  const a = await assemble();
  const v = await packVersion(a.files, minecraft, loader);
  return { ...a, minecraft, loader, version: `1.${v.n}`, updatedAt: v.at };
}

/* ───────────────────────── Änderungen melden ───────────────────────── */

/** Stand des Packs, wie er zuletzt an die Spieler gemeldet wurde */
export interface PackSnapshot { hash: string; minecraft: string; files: Array<{ id: string; title: string; sha1: string }> }
const NOTIFIED = 'pack_notified';
const PENDING = 'pack_pending';
/** so lange muss das Pack unverändert bleiben, bevor gemeldet wird – mehrere Klicks im Admin ergeben eine Meldung */
export const PACK_STABLE_MS = 5 * 60_000;

const names = (list: Array<{ title: string }>) => list.length > 3
  ? `${list.slice(0, 3).map((f) => f.title).join(', ')} und ${list.length - 3} weitere`
  : list.map((f) => f.title).join(', ');

/** Was hat sich für die Spieler geändert? null = nichts, wofür man neu herunterladen müsste */
export function describePackChange(before: PackSnapshot, after: PackSnapshot): string | null {
  const old = new Map(before.files.map((f) => [f.id, f]));
  const now = new Map(after.files.map((f) => [f.id, f]));
  const added = after.files.filter((f) => !old.has(f.id));
  const removed = before.files.filter((f) => !now.has(f.id));
  const updated = after.files.filter((f) => old.has(f.id) && old.get(f.id)!.sha1 !== f.sha1);
  const parts: string[] = [];
  if (before.minecraft !== after.minecraft) parts.push(`Jetzt für Minecraft ${after.minecraft}.`);
  if (added.length) parts.push(`Neu: ${names(added)}.`);
  if (updated.length) parts.push(`Aktualisiert: ${names(updated)}.`);
  if (removed.length) parts.push(`Entfernt: ${names(removed)}.`);
  return parts.length ? `${parts.join(' ')} Bitte das Modpack neu herunterladen.` : null;
}

/** Regelmäßig: Pack neu berechnen und Änderungen (nach kurzer Ruhezeit) als Benachrichtigung an alle melden */
export async function checkPackChanges(log: FastifyBaseLogger, now = Date.now()) {
  const p = await packInfo();
  const titles = new Map(p.sources.map((s) => [s.projectId, s.title]));
  const current: PackSnapshot = {
    hash: getState<{ hash: string }>('pack_version')!.hash,
    minecraft: p.minecraft,
    files: p.files.map((f) => ({ id: f.projectId, title: titles.get(f.projectId) ?? f.projectId, sha1: f.file.sha1 })),
  };
  const notified = getState<PackSnapshot>(NOTIFIED);
  // Erster Lauf: nur merken, nichts melden
  if (!notified || notified.hash === current.hash) {
    if (!notified) setState(NOTIFIED, current);
    setState(PENDING, null);
    return;
  }
  const pending = getState<{ hash: string; since: number }>(PENDING);
  if (pending?.hash !== current.hash) {
    setState(PENDING, { hash: current.hash, since: now });
    return;
  }
  if (now - pending.since < PACK_STABLE_MS) return;

  const body = describePackChange(notified, current);
  if (body) {
    notify({ kind: 'modpack', title: `Modpack aktualisiert (Version ${p.version})`, body, link: '/modpack', actionLabel: 'Zum Modpack' });
    log.info({ version: p.version }, 'Modpack-Änderung gemeldet');
  }
  setState(NOTIFIED, current);
  setState(PENDING, null);
}

/** Wann sich das Pack zuletzt geändert hat (für „Aktualisiert …“ im Menü und Dashboard) */
export const packUpdatedAt = () => getState<{ at: string }>('pack_version')?.at ?? null;

/* ───────────────────────── Routen ───────────────────────── */

/** Iris (Fabric) – Shader brauchen ihn, das steht bei Modrinth aber nicht als Abhängigkeit drin */
export const IRIS_ID = 'YL57xq9U';

/** Benötigte Projekte: Mods laut Modrinth, Shader immer Iris, Ressourcenpakete nichts */
const packRequires = async (kind: PackKind, v: MrVersion) =>
  kind === 'mod' ? requiredProjects(v) : kind === 'shader' ? [IRIS_ID] : [];

const KIND = (k: unknown): PackKind => (PACK_KINDS.includes(k as PackKind) ? (k as PackKind) : 'mod');
const MODES: PackMode[] = ['required', 'optional', 'excluded'];
const kindPath = (kind: PackKind, slug: string) => `https://modrinth.com/${kind}/${slug}`;

export async function registerModpack(app: FastifyInstance) {
  const check = () => checkPackChanges(app.log).catch((err) => app.log.debug(err, 'Modpack-Prüfung übersprungen'));
  setTimeout(check, 30_000).unref();
  setInterval(check, 2 * 60_000).unref();

  // Für alle Mitglieder: was ist drin, welche Version
  app.get('/api/modpack', async (_req, reply) => {
    try {
      const p = await packInfo();
      const items = new Map(p.items.map((i) => [i.project_id, i]));
      const server = new Map(p.server.map((m) => [m.projectId, m]));
      const contents = [...p.entries].map(([id, e]) => {
        const s = server.get(id);
        const i = items.get(id);
        const kind = (i?.kind ?? 'mod') as PackKind;
        const slug = s?.slug ?? i!.slug;
        return {
          projectId: id,
          title: s?.title ?? i!.title,
          description: s?.description ?? i!.description,
          icon: (s?.hasIcon ?? !!i?.has_icon) ? iconUrl(id) : null,
          url: kindPath(kind, slug),
          kind,
          mode: e.mode,
          versionNumber: s?.versionNumber ?? i!.version_number,
          fromServer: !!s,
        };
      });
      contents.sort((a, b) => a.title.localeCompare(b.title, 'de'));
      return {
        name: 'Neo',
        version: p.version,
        updatedAt: p.updatedAt,
        minecraft: p.minecraft,
        loader: p.loader,
        size: p.files.reduce((sum, f) => sum + f.file.size, 0),
        contents,
        problems: p.problems,
      };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.get('/api/modpack/download', async (_req, reply) => {
    try {
      const p = await packInfo();
      const zip = new AdmZip();
      const index = packIndex({ version: p.version, minecraft: p.minecraft, loader: p.loader }, p.files);
      zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index, null, 2)));
      const name = `Neo-${p.version}.mrpack`;
      return reply
        .header('Content-Type', 'application/x-modrinth-modpack+zip')
        .header('Content-Disposition', `attachment; filename="${name}"`)
        .header('Cache-Control', 'no-store')
        .send(zip.toBuffer());
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // Admin: alles, was ins Pack kann, mit Einstellungen und Updates
  app.get('/api/modpack/manage', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    try {
      const p = await packInfo();
      const settings = serverPackSettings();
      const latest = new Map<string, MrVersion | undefined>();
      await Promise.all(
        p.items.map(async (i) => {
          const versions = await cached(`pack-latest|${i.project_id}|${p.minecraft}`, false,
            () => projectVersions(i.project_id, p.minecraft, i.kind)).catch(() => []);
          latest.set(i.project_id, pickVersion(versions));
        }),
      );
      // Reine Server-Mods (beim Spieler nicht lauffähig) gehören nie ins Pack – gar nicht erst anzeigen
      const rows = p.sources.filter((s) => !(s.locked && s.mode === 'excluded')).map((s) => {
        const e = p.entries.get(s.projectId);
        const m = p.server.find((x) => x.projectId === s.projectId);
        const i = p.items.find((x) => x.project_id === s.projectId);
        const l = latest.get(s.projectId);
        const kind = s.kind;
        return {
          projectId: s.projectId,
          title: s.title,
          description: m?.description ?? i?.description ?? '',
          icon: (m?.hasIcon ?? !!i?.has_icon) ? iconUrl(s.projectId) : null,
          url: kindPath(kind, m?.slug ?? i?.slug ?? s.projectId),
          kind,
          source: s.source,
          clientSide: m?.clientSide ?? i?.client_side ?? 'unknown',
          setting: s.source === 'server' ? settings.get(s.projectId) ?? 'auto' : i!.mode,
          locked: s.locked,
          mode: e?.mode ?? 'excluded',
          reason: e?.reason ?? null,
          /** Mods im Pack, die diesen Eintrag brauchen (Grund für „Pflicht · für X Mods“) */
          neededBy: p.sources.filter((x) => p.entries.has(x.projectId) && x.requires.includes(s.projectId)).map((x) => x.title),
          auto: !!i?.auto,
          note: i?.note ?? '',
          versionNumber: m?.versionNumber ?? i!.version_number,
          update: i && l && l.id !== i.version_id && l.date_published > i.version_published ? { id: l.id, number: l.version_number } : null,
        };
      });
      rows.sort((a, b) => a.title.localeCompare(b.title, 'de'));
      return {
        version: p.version,
        updatedAt: p.updatedAt,
        minecraft: p.minecraft,
        loader: p.loader,
        size: p.files.reduce((sum, f) => sum + f.file.size, 0),
        counts: {
          required: [...p.entries.values()].filter((e) => e.mode === 'required').length,
          optional: [...p.entries.values()].filter((e) => e.mode === 'optional').length,
        },
        rows,
        problems: p.problems,
        pendingServerChanges: listManaged().length !== appliedMods().length,
      };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // Suche: alles, was beim Spieler läuft
  app.get<{ Querystring: { q?: string; offset?: string; kind?: string } }>('/api/modpack/search', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const query = (req.query.q ?? '').trim().slice(0, 100);
    const offset = Math.max(0, Math.min(1000, Number(req.query.offset) || 0));
    const kind = KIND(req.query.kind);
    try {
      const { minecraft } = await gameAndLoader();
      const result = await cached(`packsearch|${minecraft}|${kind}|${query}|${offset}`, false,
        () => searchMods(query, minecraft, 'client', offset, kind));
      const inPack = new Set([...listItems().map((i) => i.project_id), ...appliedMods().map((m) => m.projectId)]);
      return {
        total: result.total_hits,
        hits: result.hits.map((h) => ({
          projectId: h.project_id,
          slug: h.slug,
          title: h.title,
          description: h.description,
          icon: h.icon_url ? iconUrl(h.project_id) : null,
          url: kindPath(kind, h.slug),
          downloads: h.downloads,
          clientSide: h.client_side,
          serverSide: h.server_side,
          inList: inPack.has(h.project_id),
        })),
      };
    } catch (err) {
      return reply.code(502).send({ error: `Modrinth nicht erreichbar: ${(err as Error).message}` });
    }
  });

  // Hinzufügen (inkl. benötigter Mods, die weder auf dem Server noch im Pack sind)
  app.post<{ Body: { projectId?: string; kind?: string; mode?: string } }>('/api/modpack/items', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const projectId = req.body?.projectId ?? '';
    const kind = KIND(req.body?.kind);
    const mode: PackMode = req.body?.mode === 'optional' ? 'optional' : 'required';
    if (!PROJECT_ID.test(projectId)) return reply.code(400).send({ error: 'Ungültige Projekt-ID.' });
    try {
      const { minecraft } = await gameAndLoader();
      const serverIds = new Set(appliedMods().map((m) => m.projectId));
      if (serverIds.has(projectId)) return reply.code(400).send({ error: 'Der Mod läuft schon auf dem Server – unten bei „Vom Server“ einstellen.' });
      const plan = new Map<string, ItemRow>();
      // Abhängigkeiten erben Pflicht/optional vom Eintrag, der sie braucht
      const add = async (id: string, k: PackKind, asDependency: boolean, itemMode: PackMode) => {
        if (plan.has(id) || serverIds.has(id) || (asDependency && getItem(id))) return;
        if (!asDependency && getItem(id)) throw new Error('Ist schon im Modpack.');
        const [[project], versions] = await Promise.all([projectsById([id]), projectVersions(id, minecraft, k)]);
        if (!project) throw new Error('Nicht gefunden.');
        if (k === 'mod' && project.client_side === 'unsupported') throw new Error(`${project.title} läuft nur auf dem Server.`);
        const v = pickVersion(versions);
        if (!v) throw new Error(`${project.title} gibt es (noch) nicht für Minecraft ${minecraft}${k === 'mod' ? ' (Fabric)' : ''}.`);
        const requires = await packRequires(k, v);
        plan.set(id, versionRow({
          project_id: id, kind: k, slug: project.slug, title: project.title, description: project.description,
          has_icon: project.icon_url ? 1 : 0, client_side: project.client_side, server_side: project.server_side,
          mode: itemMode, auto: asDependency ? 1 : 0, note: '', added_by: req.user!.displayName,
          added_at: new Date().toISOString(),
        }, v, requires));
        for (const dep of requires) await add(dep, 'mod', true, itemMode);
      };
      await add(projectId, kind, false, mode);
      transaction(() => plan.forEach((r) => saveItem(r)));
      const added = [...plan.values()];
      audit(req.user!.id, 'modpack: hinzugefügt', added.map((r) => `${r.title} ${r.version_number}`).join(', '));
      return { added: added.map((r) => ({ projectId: r.project_id, title: r.title, auto: !!r.auto })) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Modus, Notiz oder Version eines Pack-Eintrags ändern
  app.patch<{ Params: { id: string }; Body: { mode?: string; note?: string; versionId?: string } }>('/api/modpack/items/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const item = getItem(req.params.id);
    if (!item) return reply.code(404).send({ error: 'Nicht im Modpack.' });
    const body = req.body ?? {};
    let next: ItemRow = { ...item };
    try {
      if (body.mode !== undefined) {
        if (!MODES.includes(body.mode as PackMode)) return reply.code(400).send({ error: 'Ungültiger Modus.' });
        next.mode = body.mode as PackMode;
      }
      if (typeof body.note === 'string') next.note = body.note.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 300);
      if (body.versionId) {
        const { minecraft } = await gameAndLoader();
        const versions = await projectVersions(item.project_id, minecraft, item.kind);
        const v = body.versionId === 'latest' ? pickVersion(versions) : versions.find((x) => x.id === body.versionId);
        if (!v) return reply.code(400).send({ error: `Keine passende Version von ${item.title}.` });
        next = versionRow(next, v, await packRequires(item.kind, v));
      }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    saveItem(next);
    audit(req.user!.id, 'modpack: geändert', `${item.title}${body.mode ? ` → ${body.mode}` : ''}${body.versionId ? ` → ${next.version_number}` : ''}`);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/modpack/items/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const item = getItem(req.params.id);
    if (!item) return reply.code(404).send({ error: 'Nicht im Modpack.' });
    const users = listItems().filter((i) => i.mode !== 'excluded' && (JSON.parse(i.requires) as string[]).includes(item.project_id));
    if (users.length) {
      return reply.code(409).send({ error: `${item.title} wird noch gebraucht von ${users.map((u) => u.title).join(', ')}.` });
    }
    db.prepare('DELETE FROM pack_items WHERE project_id = ?').run(item.project_id);
    audit(req.user!.id, 'modpack: entfernt', item.title);
    return { ok: true };
  });

  // Server-Mods: auch beim Spieler installieren? (auto = nur wenn nötig)
  app.patch<{ Params: { id: string }; Body: { mode?: string } }>('/api/modpack/server/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const mode = req.body?.mode as ServerPackMode;
    if (!['auto', ...MODES].includes(mode)) return reply.code(400).send({ error: 'Ungültiger Modus.' });
    const r = db.prepare('UPDATE server_mods SET pack_mode = ? WHERE project_id = ?').run(mode, req.params.id);
    if (!r.changes) return reply.code(404).send({ error: 'Kein Server-Mod.' });
    audit(req.user!.id, 'modpack: server-mod', `${req.params.id} → ${mode}`);
    return { ok: true };
  });
}
