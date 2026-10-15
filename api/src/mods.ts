// Admin → Mods: Welche Minecraft-/Fabric-Version läuft, welche Mods sind in der Liste bzw. installiert,
// gibt es Updates, Mod-Suche, und laufen die Mods schon auf einer neueren Minecraft-Version (Upgrade-Check)?
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from './auth.ts';
import {
  cached,
  gameVersionTags,
  iconUrl,
  installedVersions,
  latestByHash,
  loaderVersions,
  MC_DATA_DIR,
  modIcon,
  NONE,
  PROJECT_ID,
  projectsById,
  readInstallation,
  searchMods,
  versionSummary,
  type GameVersionTag,
} from './modrinth.ts';
import { listManaged, managedOverview, registerModManager } from './mod-manager.ts';

/* ───────────────────────── Hilfen (getestet) ───────────────────────── */

/** Neuere Minecraft-Versionen als die laufende (Releases und Snapshots), neueste zuerst */
export function newerGameVersions(tags: GameVersionTag[], current: string) {
  const sorted = [...tags].sort((a, b) => b.date.localeCompare(a.date));
  const index = sorted.findIndex((t) => t.version === current);
  const newer = index < 0 ? [] : sorted.slice(0, index);
  return newer
    .filter((t) => t.version_type === 'release' || t.version_type === 'snapshot')
    .map((t) => ({ version: t.version, type: t.version_type as 'release' | 'snapshot', date: t.date }));
}

/* ───────────────────────── Übersicht ───────────────────────── */

async function overview(fresh: boolean) {
  const install = await readInstallation();
  const game = install.minecraft;
  const remote = await cached(`versions|${game}`, fresh, async () => {
    const [tags, loaders] = await Promise.all([gameVersionTags(), game ? loaderVersions(game).catch(() => []) : []]);
    return { tags, loaders, checkedAt: new Date().toISOString() };
  });
  const stableLoaders = remote.loaders.filter((l) => l.loader.stable);
  const latestLoader = (stableLoaders[0] ?? remote.loaders[0])?.loader.version ?? null;
  const newer = game ? newerGameVersions(remote.tags, game) : [];

  return {
    minecraft: {
      version: game,
      newerReleases: newer.filter((v) => v.type === 'release'),
      snapshots: newer.filter((v) => v.type === 'snapshot'),
    },
    loader: { name: 'Fabric', version: install.loader, latest: latestLoader },
    ...(await managedOverview(game, fresh)),
    checkedAt: fresh ? new Date().toISOString() : remote.checkedAt,
  };
}

/** Upgrade-Check: Gibt es jeden installierten Mod schon für die Ziel-Version? */
async function upgradeCheck(target: string, fresh: boolean) {
  const { jars, versions } = await installedVersions(fresh);
  const hashes = jars.map((j) => j.sha1);
  return cached(`upgrade|${target}|${hashes.join(',')}`, fresh, async () => {
    const [compatible, loaders] = await Promise.all([
      latestByHash(hashes, target).catch(() => NONE),
      loaderVersions(target).catch(() => []),
    ]);
    const projects = new Map((await projectsById([...new Set(Object.values(versions).map((v) => v.project_id))])).map((p) => [p.id, p]));
    const mods = jars.map((jar) => {
      const v = versions[jar.sha1];
      const p = v && projects.get(v.project_id);
      const next = compatible[jar.sha1];
      return {
        file: jar.file,
        title: p?.title ?? jar.file,
        icon: p?.icon_url ? iconUrl(p.id) : null,
        known: !!v,
        version: next ? versionSummary(next) : null,
      };
    });
    mods.sort((a, b) => Number(!!a.version) - Number(!!b.version) || a.title.localeCompare(b.title, 'de'));
    return {
      target,
      loaderAvailable: loaders.length > 0,
      ready: mods.filter((m) => m.version).length,
      total: mods.length,
      mods,
      checkedAt: new Date().toISOString(),
    };
  });
}

/* ───────────────────────── Routen ───────────────────────── */

const GAME_VERSION = /^[0-9a-z.+-]{1,40}$/i;
const modrinthError = (err: unknown) => ({ error: `Modrinth nicht erreichbar: ${(err as Error).message}` });

export async function registerMods(app: FastifyInstance) {
  app.get<{ Querystring: { refresh?: string } }>('/api/mods', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!MC_DATA_DIR) return reply.code(503).send({ error: 'Server-Dateien nicht eingebunden (nur im Docker-Betrieb verfügbar).' });
    try {
      return await overview(req.query.refresh === '1');
    } catch (err) {
      return reply.code(502).send(modrinthError(err));
    }
  });

  // Mod-Suche bei Modrinth: nur Fabric-Mods für unsere Version, die auf dem Server laufen
  app.get<{ Querystring: { q?: string; offset?: string } }>('/api/mods/search', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const query = (req.query.q ?? '').trim().slice(0, 100);
    const offset = Math.max(0, Math.min(1000, Number(req.query.offset) || 0));
    try {
      const { minecraft } = await readInstallation();
      if (!minecraft) return reply.code(503).send({ error: 'Minecraft-Version unbekannt.' });
      const result = await cached(`search|${minecraft}|${query}|${offset}`, false, () => searchMods(query, minecraft, 'server', offset));
      const inList = new Set(listManaged().map((m) => m.projectId));
      return {
        total: result.total_hits,
        hits: result.hits.map((h) => ({
          projectId: h.project_id,
          slug: h.slug,
          title: h.title,
          description: h.description,
          icon: h.icon_url ? iconUrl(h.project_id) : null,
          url: `https://modrinth.com/mod/${h.slug}`,
          downloads: h.downloads,
          clientSide: h.client_side,
          serverSide: h.server_side,
          updated: h.date_modified,
          inList: inList.has(h.project_id),
        })),
      };
    } catch (err) {
      return reply.code(502).send(modrinthError(err));
    }
  });

  // Für alle Mitglieder (später auch für das Modpack); Bilder ändern sich praktisch nie
  app.get<{ Params: { id: string } }>('/api/mods/icons/:id', async (req, reply) => {
    if (!PROJECT_ID.test(req.params.id)) return reply.code(400).send({ error: 'Ungültige Projekt-ID.' });
    const icon = await modIcon(req.params.id).catch(() => undefined);
    if (!icon) return reply.code(404).send({ error: 'Kein Bild.' });
    return reply.header('Content-Type', icon.type).header('Cache-Control', 'public, max-age=604800').send(icon.data);
  });

  app.get<{ Querystring: { version?: string; refresh?: string } }>('/api/mods/upgrade', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const target = req.query.version ?? '';
    if (!GAME_VERSION.test(target)) return reply.code(400).send({ error: 'Ungültige Minecraft-Version.' });
    try {
      return await upgradeCheck(target, req.query.refresh === '1');
    } catch (err) {
      return reply.code(502).send(modrinthError(err));
    }
  });

  await registerModManager(app);
}
