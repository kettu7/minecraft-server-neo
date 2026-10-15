// Modrinth- und Fabric-API (öffentlich, ohne Schlüssel) plus Lesen der installierten Mods im Server-Ordner.
// Mods werden über den SHA1-Hash ihrer Jar-Datei erkannt – auch automatisch mitinstallierte Abhängigkeiten.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './db.ts';
import { detectImageType } from './project-images.ts';

export const MC_DATA_DIR = process.env.MC_DATA_DIR ?? '';
export const LOADER = 'fabric';
const MODRINTH = 'https://api.modrinth.com/v2';
const FABRIC_META = 'https://meta.fabricmc.net/v2';
const USER_AGENT = 'MinecraftServerNeo/1.0 (private server dashboard)';
const HEADERS = { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' };
const CACHE_MS = 15 * 60_000;
// Mod-Bilder laufen über unseren Server, damit Browser der Besucher keine Anfragen an Modrinth schicken (Datenschutz)
const ICON_DIR = join(DATA_DIR, 'mod-icons');
export const PROJECT_ID = /^[A-Za-z0-9]{8}$/;

/* ───────────────────────── Typen ───────────────────────── */

export type Side = 'required' | 'optional' | 'unsupported' | 'unknown';

export interface MrVersion {
  id: string;
  project_id: string;
  version_number: string;
  version_type: 'release' | 'beta' | 'alpha';
  date_published: string;
  game_versions: string[];
  loaders: string[];
  files: Array<{ url: string; filename: string; primary: boolean; size: number; hashes: { sha1: string; sha512: string } }>;
  dependencies: Array<{
    project_id: string | null;
    version_id: string | null;
    dependency_type: 'required' | 'optional' | 'incompatible' | 'embedded';
  }>;
}

export interface MrProject {
  id: string;
  slug: string;
  title: string;
  description: string;
  icon_url: string | null;
  client_side: Side;
  server_side: Side;
  project_type: string;
  downloads: number;
}

export interface MrSearchHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  icon_url: string | null;
  client_side: Side;
  server_side: Side;
  downloads: number;
  categories: string[];
  date_modified: string;
}

export interface GameVersionTag {
  version: string;
  version_type: 'release' | 'snapshot' | 'alpha' | 'beta';
  date: string;
}

export interface JarFile {
  file: string;
  size: number;
  sha1: string;
}

/* ───────────────────────── Hilfen ───────────────────────── */

const cache = new Map<string, { at: number; value: unknown }>();

/** Ergebnis für 15 Minuten merken; fresh = neu holen */
export async function cached<T>(key: string, fresh: boolean, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function request<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const NONE: Record<string, MrVersion> = {};

export const versionSummary = (v: MrVersion) => ({
  id: v.id,
  number: v.version_number,
  type: v.version_type,
  published: v.date_published,
});

export const iconUrl = (projectId: string) => `/api/mods/icons/${projectId}`;

/* ───────────────────────── Modrinth ───────────────────────── */

export const versionsByHash = (hashes: string[]) =>
  hashes.length ? request<Record<string, MrVersion>>(`${MODRINTH}/version_files`, { hashes, algorithm: 'sha1' }) : Promise.resolve(NONE);

/** Neueste passende Version je Hash für Fabric + Spielversion. Fehlt ein Hash, gibt es keine passende Version. */
export const latestByHash = (hashes: string[], gameVersion: string) =>
  hashes.length
    ? request<Record<string, MrVersion>>(`${MODRINTH}/version_files/update`, {
        hashes,
        algorithm: 'sha1',
        loaders: [LOADER],
        game_versions: [gameVersion],
      })
    : Promise.resolve(NONE);

export const projectsById = (ids: string[]) =>
  ids.length ? request<MrProject[]>(`${MODRINTH}/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`) : Promise.resolve([]);

export const versionsById = (ids: string[]) =>
  ids.length ? request<MrVersion[]>(`${MODRINTH}/versions?ids=${encodeURIComponent(JSON.stringify(ids))}`) : Promise.resolve([]);

/** Was ins Modpack kann: Mods (Fabric), Ressourcenpakete, Shader (für Iris) */
export type PackKind = 'mod' | 'resourcepack' | 'shader';
export const PACK_KINDS: PackKind[] = ['mod', 'resourcepack', 'shader'];
const KIND_LOADERS: Record<PackKind, string[]> = { mod: [LOADER], resourcepack: ['minecraft'], shader: ['iris'] };

/** Alle Versionen eines Projekts für die Spielversion (Mods: Fabric), neueste zuerst */
export const projectVersions = (projectId: string, gameVersion: string, kind: PackKind = 'mod') =>
  request<MrVersion[]>(
    `${MODRINTH}/project/${encodeURIComponent(projectId)}/version?loaders=${encodeURIComponent(JSON.stringify(KIND_LOADERS[kind]))}` +
      `&game_versions=${encodeURIComponent(JSON.stringify([gameVersion]))}`,
  );

/** Hauptdatei einer Version (für Downloads im Modpack) */
export const primaryFile = (v: MrVersion) => v.files.find((f) => f.primary) ?? v.files[0];

export const gameVersionTags = () => request<GameVersionTag[]>(`${MODRINTH}/tag/game_version`);

export const loaderVersions = (gameVersion: string) =>
  request<Array<{ loader: { version: string; stable: boolean } }>>(`${FABRIC_META}/versions/loader/${encodeURIComponent(gameVersion)}`);

/**
 * Suche für die laufende Version. side = server: Mods, die auf dem Server laufen;
 * side = client: was beim Spieler läuft (Mods, Ressourcenpakete, Shader).
 */
export async function searchMods(query: string, gameVersion: string, side: 'server' | 'client', offset = 0, kind: PackKind = 'mod') {
  const facets = [[`versions:${gameVersion}`], [`project_type:${kind}`]];
  if (kind === 'mod') facets.push([`categories:${LOADER}`]);
  if (kind === 'shader') facets.push(['categories:iris']);
  if (kind === 'mod') {
    facets.push(side === 'server' ? ['server_side:required', 'server_side:optional'] : ['client_side:required', 'client_side:optional']);
  }
  const params = new URLSearchParams({
    query,
    facets: JSON.stringify(facets),
    limit: '20',
    offset: String(offset),
    index: query ? 'relevance' : 'downloads',
  });
  return request<{ hits: MrSearchHit[]; total_hits: number }>(`${MODRINTH}/search?${params}`);
}

/** Beste Version für die Spielversion: neueste Vollversion, sonst neueste Beta/Alpha */
export function pickVersion(versions: MrVersion[]): MrVersion | undefined {
  const sorted = [...versions].sort((a, b) => b.date_published.localeCompare(a.date_published));
  return sorted.find((v) => v.version_type === 'release') ?? sorted[0];
}

/* ───────────────────────── Installierte Mods ───────────────────────── */

async function readJson<T>(name: string): Promise<T | undefined> {
  if (!MC_DATA_DIR) return undefined;
  return readFile(join(MC_DATA_DIR, name), 'utf8').then((t) => JSON.parse(t) as T).catch(() => undefined);
}

/** Hashes ändern sich nur, wenn sich die Datei ändert – daher nach Name, Größe und Änderungszeit zwischenspeichern */
const hashCache = new Map<string, string>();

export async function readJars(): Promise<JarFile[]> {
  if (!MC_DATA_DIR) return [];
  const dir = join(MC_DATA_DIR, 'mods');
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.jar')).sort();
  return Promise.all(
    names.map(async (file) => {
      const path = join(dir, file);
      const s = await stat(path);
      const key = `${file}|${s.size}|${s.mtimeMs}`;
      let sha1 = hashCache.get(key);
      if (!sha1) {
        sha1 = createHash('sha1').update(await readFile(path)).digest('hex');
        hashCache.set(key, sha1);
      }
      return { file, size: s.size, sha1 };
    }),
  );
}

export async function readInstallation() {
  const fabric = await readJson<{ origin?: { game?: string; loader?: string } }>('.fabric-manifest.json');
  return {
    minecraft: fabric?.origin?.game ?? null,
    loader: fabric?.origin?.loader ?? null,
    jars: await readJars(),
  };
}

/** Installierte Mods: Projekt-ID → Version (nur Mods, die Modrinth kennt) */
export async function installedVersions(fresh = false) {
  const jars = await readJars();
  const hashes = jars.map((j) => j.sha1);
  const versions = await cached(`hashes|${hashes.join(',')}`, fresh, () => versionsByHash(hashes));
  const byProject = new Map<string, { jar: JarFile; version: MrVersion }>();
  for (const jar of jars) {
    const v = versions[jar.sha1];
    if (v) byProject.set(v.project_id, { jar, version: v });
  }
  return { jars, versions, byProject };
}

/* ───────────────────────── Mod-Bilder ───────────────────────── */

/** Bild einmal von Modrinth holen und auf der Platte ablegen. Nur Rasterbilder (kein SVG). */
export async function modIcon(projectId: string): Promise<{ data: Buffer; type: string } | undefined> {
  const path = join(ICON_DIR, projectId);
  const stored = await readFile(path).catch(() => undefined);
  if (stored) {
    const type = detectImageType(stored);
    return type ? { data: stored, type } : undefined;
  }
  const [project] = await projectsById([projectId]);
  if (!project?.icon_url || new URL(project.icon_url).host !== 'cdn.modrinth.com') return undefined;
  const res = await fetch(project.icon_url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return undefined;
  const data = Buffer.from(await res.arrayBuffer());
  const type = detectImageType(data);
  if (!type || data.length > 2 * 1024 * 1024) return undefined;
  await mkdir(ICON_DIR, { recursive: true });
  await writeFile(path, data);
  return { data, type };
}
