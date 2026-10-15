// Mod-Manager: Die Website führt die Liste der Server-Mods (mit fester Version) und schreibt daraus die Datei,
// die der Minecraft-Container beim Start liest (MODRINTH_PROJECTS=@/neo/modrinth-projects.txt).
// Änderungen sind erst "geplant" und werden mit "Übernehmen" wirksam: Backup → Warnung im Chat → Neustart → Prüfung.
// Deaktivierte Mods bleiben in der Liste (inkl. Version und Notiz), werden aber nicht geladen; ihre Configs bleiben liegen.
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { db, transaction } from './db.ts';
import { requireAdmin } from './auth.ts';
import { audit, type User } from './users.ts';
import { createBackup } from './backup.ts';
import { control, rcon, tellraw, wait, WARNING_SECONDS } from './server-admin.ts';
import {
  installedVersions,
  latestByHash,
  NONE,
  pickVersion,
  PROJECT_ID,
  projectsById,
  projectVersions,
  readInstallation,
  versionsById,
  type MrProject,
  type MrVersion,
  type Side,
} from './modrinth.ts';

const MODS_FILE = process.env.MODS_FILE ?? '';

db.exec(`
  CREATE TABLE IF NOT EXISTS server_mods (
    project_id        TEXT PRIMARY KEY,
    slug              TEXT NOT NULL,
    title             TEXT NOT NULL,
    description       TEXT NOT NULL DEFAULT '',
    has_icon          INTEGER NOT NULL DEFAULT 0,
    client_side       TEXT NOT NULL DEFAULT 'unknown',
    server_side       TEXT NOT NULL DEFAULT 'unknown',
    version_id        TEXT NOT NULL,
    version_number    TEXT NOT NULL,
    version_type      TEXT NOT NULL DEFAULT 'release',
    version_published TEXT NOT NULL DEFAULT '',
    requires          TEXT NOT NULL DEFAULT '[]',  -- Projekt-IDs der benötigten Mods (JSON)
    enabled           INTEGER NOT NULL DEFAULT 1,
    auto              INTEGER NOT NULL DEFAULT 0,   -- als Abhängigkeit automatisch hinzugefügt
    note              TEXT NOT NULL DEFAULT '',
    added_by          TEXT,
    added_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS mod_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);
// Modpack: Soll ein Server-Mod auch beim Spieler installiert werden? auto | required | optional | excluded
if (!(db.prepare('PRAGMA table_info(server_mods)').all() as Array<{ name: string }>).some((c) => c.name === 'pack_mode')) {
  db.exec("ALTER TABLE server_mods ADD COLUMN pack_mode TEXT NOT NULL DEFAULT 'auto'");
}

/* ───────────────────────── Typen ───────────────────────── */

export interface ManagedMod {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  hasIcon: boolean;
  clientSide: Side;
  serverSide: Side;
  versionId: string;
  versionNumber: string;
  versionType: string;
  versionPublished: string;
  requires: string[];
  enabled: boolean;
  auto: boolean;
  note: string;
  addedBy: string | null;
  addedAt: string;
}

export interface ModChange {
  projectId: string;
  title: string;
  kind: 'add' | 'remove' | 'enable' | 'disable' | 'version';
  from?: string;
  to?: string;
}

interface ApplyJob {
  running: boolean;
  step: string;
  by: string;
  startedAt: string;
  finishedAt?: string;
  ok?: boolean;
  error?: string;
  problems?: string[];
  backupId?: string;
  logs?: string;
}

/* ───────────────────────── Reine Hilfen (getestet) ───────────────────────── */

/** Inhalt der Datei für den Minecraft-Container. Deaktivierte Mods stehen als Kommentar drin. */
export function modsFileContent(mods: ManagedMod[], by: string, at = new Date()) {
  const lines = [
    '# Minecraft Server Neo – Server-Mods',
    '# Wird von der Website verwaltet (Admin → Mods) und beim Übernehmen neu geschrieben.',
    '# Format: fabric:<Projekt-ID>:<Versions-ID>',
    `# Stand: ${at.toISOString()} (${by.replace(/[\r\n]/g, ' ')})`,
  ];
  for (const m of [...mods].sort((a, b) => a.title.localeCompare(b.title, 'de'))) {
    lines.push('', `# ${m.enabled ? '' : '[deaktiviert] '}${m.title} ${m.versionNumber}`.replace(/[\r\n]/g, ' '));
    lines.push(`${m.enabled ? '' : '# '}fabric:${m.projectId}:${m.versionId}`);
  }
  return lines.join('\n') + '\n';
}

/** Was ändert sich gegenüber dem zuletzt übernommenen Stand? */
export function pendingChanges(desired: ManagedMod[], applied: ManagedMod[]): ModChange[] {
  const before = new Map(applied.map((m) => [m.projectId, m]));
  const now = new Map(desired.map((m) => [m.projectId, m]));
  const changes: ModChange[] = [];
  for (const m of desired) {
    const a = before.get(m.projectId);
    if (!a) {
      if (m.enabled) changes.push({ projectId: m.projectId, title: m.title, kind: 'add', to: m.versionNumber });
      continue;
    }
    if (a.enabled && !m.enabled) changes.push({ projectId: m.projectId, title: m.title, kind: 'disable' });
    else if (!a.enabled && m.enabled) changes.push({ projectId: m.projectId, title: m.title, kind: 'enable', to: m.versionNumber });
    else if (m.enabled && a.versionId !== m.versionId) {
      changes.push({ projectId: m.projectId, title: m.title, kind: 'version', from: a.versionNumber, to: m.versionNumber });
    }
  }
  for (const a of applied) {
    if (!now.has(a.projectId) && a.enabled) changes.push({ projectId: a.projectId, title: a.title, kind: 'remove' });
  }
  return changes;
}

/** Aktive Mods, die projectId brauchen */
export function dependentsOf(mods: ManagedMod[], projectId: string) {
  return mods.filter((m) => m.enabled && m.projectId !== projectId && m.requires.includes(projectId));
}

/** Aktive Mods, deren benötigte Mods fehlen oder deaktiviert sind */
export function missingDependencies(mods: ManagedMod[]) {
  const enabled = new Map(mods.filter((m) => m.enabled).map((m) => [m.projectId, m]));
  const all = new Map(mods.map((m) => [m.projectId, m]));
  const problems: Array<{ mod: string; needs: string }> = [];
  for (const m of enabled.values()) {
    for (const dep of m.requires) {
      if (!enabled.has(dep)) problems.push({ mod: m.title, needs: all.get(dep)?.title ?? dep });
    }
  }
  return problems;
}

/* ───────────────────────── Datenbank ───────────────────────── */

interface Row {
  project_id: string; slug: string; title: string; description: string; has_icon: number;
  client_side: string; server_side: string; version_id: string; version_number: string; version_type: string;
  version_published: string; requires: string; enabled: number; auto: number; note: string; added_by: string | null; added_at: string;
}

const fromRow = (r: Row): ManagedMod => ({
  projectId: r.project_id,
  slug: r.slug,
  title: r.title,
  description: r.description,
  hasIcon: !!r.has_icon,
  clientSide: r.client_side as Side,
  serverSide: r.server_side as Side,
  versionId: r.version_id,
  versionNumber: r.version_number,
  versionType: r.version_type,
  versionPublished: r.version_published,
  requires: JSON.parse(r.requires) as string[],
  enabled: !!r.enabled,
  auto: !!r.auto,
  note: r.note,
  addedBy: r.added_by,
  addedAt: r.added_at,
});

export function listManaged(): ManagedMod[] {
  return (db.prepare('SELECT * FROM server_mods ORDER BY title COLLATE NOCASE').all() as unknown as Row[]).map(fromRow);
}

function getManaged(projectId: string): ManagedMod | undefined {
  const r = db.prepare('SELECT * FROM server_mods WHERE project_id = ?').get(projectId) as unknown as Row | undefined;
  return r && fromRow(r);
}

function saveManaged(m: ManagedMod) {
  db.prepare(`
    INSERT INTO server_mods (project_id, slug, title, description, has_icon, client_side, server_side, version_id, version_number,
      version_type, version_published, requires, enabled, auto, note, added_by, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET slug = excluded.slug, title = excluded.title, description = excluded.description,
      has_icon = excluded.has_icon, client_side = excluded.client_side, server_side = excluded.server_side,
      version_id = excluded.version_id, version_number = excluded.version_number, version_type = excluded.version_type,
      version_published = excluded.version_published, requires = excluded.requires, enabled = excluded.enabled,
      auto = excluded.auto, note = excluded.note
  `).run(
    m.projectId, m.slug, m.title, m.description, m.hasIcon ? 1 : 0, m.clientSide, m.serverSide, m.versionId, m.versionNumber,
    m.versionType, m.versionPublished, JSON.stringify(m.requires), m.enabled ? 1 : 0, m.auto ? 1 : 0, m.note, m.addedBy, m.addedAt,
  );
}

export function getState<T>(key: string): T | undefined {
  const r = db.prepare('SELECT value FROM mod_state WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? (JSON.parse(r.value) as T) : undefined;
}

export function setState(key: string, value: unknown) {
  db.prepare('INSERT INTO mod_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export const appliedMods = () => getState<ManagedMod[]>('applied') ?? [];

/* ───────────────────────── Modrinth → Liste ───────────────────────── */

export const requiredProjects = async (v: MrVersion) => {
  const deps = v.dependencies.filter((d) => d.dependency_type === 'required');
  const ids = new Set(deps.map((d) => d.project_id).filter((id): id is string => !!id));
  // Manche Mods geben nur die Versions-ID der Abhängigkeit an
  const byVersion = deps.filter((d) => !d.project_id && d.version_id).map((d) => d.version_id!);
  for (const dv of await versionsById(byVersion)) ids.add(dv.project_id);
  return [...ids];
};

function toManaged(p: MrProject, v: MrVersion, requires: string[], extra: Partial<ManagedMod>): ManagedMod {
  return {
    projectId: p.id,
    slug: p.slug,
    title: p.title,
    description: p.description,
    hasIcon: !!p.icon_url,
    clientSide: p.client_side,
    serverSide: p.server_side,
    versionId: v.id,
    versionNumber: v.version_number,
    versionType: v.version_type,
    versionPublished: v.date_published,
    requires,
    enabled: true,
    auto: false,
    note: '',
    addedBy: null,
    addedAt: new Date().toISOString(),
    ...extra,
  };
}

/** Erster Aufruf: Liste aus den installierten Mods übernehmen, damit nichts verloren geht */
export async function ensureSeeded() {
  if (getState('seeded')) return;
  const { byProject } = await installedVersions(true);
  const projects = await projectsById([...byProject.keys()]);
  const mods: ManagedMod[] = [];
  for (const p of projects) {
    const v = byProject.get(p.id)!.version;
    mods.push(toManaged(p, v, await requiredProjects(v), { addedBy: 'Bestand' }));
  }
  transaction(() => {
    for (const m of mods) saveManaged(m);
    setState('applied', mods);
    setState('seeded', new Date().toISOString());
  });
  if (MODS_FILE) await writeModsFile(mods, 'Bestand übernommen');
}

/**
 * Plant das Hinzufügen eines Mods samt benötigter Mods (rekursiv).
 * Gibt die zu speichernden Einträge zurück; vorhandene, deaktivierte Abhängigkeiten werden wieder aktiviert.
 */
async function planAdd(projectId: string, game: string, by: string, asDependency: boolean, plan = new Map<string, ManagedMod>()) {
  if (plan.has(projectId)) return plan;
  const existing = getManaged(projectId);
  if (existing) {
    if (!asDependency) throw new Error(`${existing.title} ist schon in der Liste.`);
    if (!existing.enabled) plan.set(projectId, { ...existing, enabled: true });
    return plan;
  }
  const [[project], versions] = await Promise.all([projectsById([projectId]), projectVersions(projectId, game)]);
  if (!project) throw new Error('Mod nicht gefunden.');
  if (project.project_type !== 'mod') throw new Error(`${project.title} ist kein Mod.`);
  if (project.server_side === 'unsupported') {
    throw new Error(`${project.title} läuft nur beim Spieler – der kommt später ins Modpack, nicht auf den Server.`);
  }
  const version = pickVersion(versions);
  if (!version) throw new Error(`${project.title} gibt es (noch) nicht für Fabric ${game}.`);
  const requires = await requiredProjects(version);
  plan.set(projectId, toManaged(project, version, requires, { auto: asDependency, addedBy: by }));
  for (const dep of requires) await planAdd(dep, game, by, true, plan);
  return plan;
}

async function currentGameVersion() {
  const { minecraft } = await readInstallation();
  if (!minecraft) throw new Error('Minecraft-Version unbekannt (Server-Dateien nicht gefunden).');
  return minecraft;
}

/* ───────────────────────── Datei schreiben ───────────────────────── */

async function writeModsFile(mods: ManagedMod[], by: string) {
  if (!MODS_FILE) throw new Error('MODS_FILE ist nicht gesetzt – Übernehmen geht nur im Docker-Betrieb.');
  const tmp = `${MODS_FILE}.tmp`;
  await writeFile(tmp, modsFileContent(mods, by));
  await rename(tmp, MODS_FILE);
}

/* ───────────────────────── Übernehmen ───────────────────────── */

let job: ApplyJob | null = null;
export const applyStatus = () => job ?? getState<ApplyJob>('last_apply') ?? null;
export const applyRunning = () => !!job?.running;

async function serverLogs(): Promise<string> {
  const body = (await control('GET', '/logs', 15_000).catch(() => ({ logs: '' }))) as { logs?: string };
  return (body.logs ?? '').slice(-6000);
}

async function waitHealthy(timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  // Der Container braucht nach dem Start ein paar Sekunden, bis der Healthcheck läuft
  await wait(10);
  while (Date.now() < until) {
    const s = (await control('GET', '/status', 10_000).catch(() => null)) as { running?: boolean; health?: string | null } | null;
    if (s?.running && s.health === 'healthy') return true;
    await wait(3);
  }
  return false;
}

async function runApply(user: User, log: FastifyBaseLogger) {
  const desired = listManaged();
  const previous = appliedMods();
  const changes = pendingChanges(desired, previous);
  job = { running: true, step: 'Backup wird erstellt', by: user.displayName, startedAt: new Date().toISOString() };
  const finish = (result: Partial<ApplyJob>) => {
    job = { ...job!, ...result, running: false, finishedAt: new Date().toISOString() };
    setState('last_apply', job);
    job = null;
  };

  try {
    const backup = await createBackup('manual', `Vor Mod-Änderung (${user.displayName})`, log);
    job.backupId = backup.id;

    job.step = 'Mod-Liste wird geschrieben';
    await writeModsFile(desired, user.displayName);

    job.step = 'Spieler werden gewarnt';
    await rcon(tellraw(`Server startet in ${WARNING_SECONDS} Sekunden neu (Mod-Änderung) – gleich wieder da!`)).catch(() => undefined);
    await wait(WARNING_SECONDS);

    job.step = 'Server wird neu gestartet';
    await control('POST', '/restart');

    job.step = 'Server startet und lädt Mods';
    if (!(await waitHealthy(6 * 60_000))) {
      const logs = await serverLogs();
      // Alte Liste zurückschreiben, damit der nächste Start wieder klappt
      await writeModsFile(previous, `${user.displayName} (zurückgesetzt nach Fehler)`).catch(() => undefined);
      audit(user.id, 'mods übernehmen fehlgeschlagen', 'Server startete nicht');
      return finish({
        ok: false,
        error: 'Der Server ist nicht sauber gestartet. Die alte Mod-Liste wurde zurückgeschrieben – Server unter „Server“ neu starten. Deine geplanten Änderungen bleiben erhalten.',
        logs,
      });
    }

    job.step = 'Installation wird geprüft';
    const { byProject } = await installedVersions(true);
    const problems: string[] = [];
    for (const m of desired) {
      const installed = byProject.get(m.projectId);
      if (m.enabled && !installed) problems.push(`${m.title} wurde nicht installiert.`);
      else if (m.enabled && installed && installed.version.id !== m.versionId) {
        problems.push(`${m.title}: installiert ist ${installed.version.version_number} statt ${m.versionNumber}.`);
      } else if (!m.enabled && installed) problems.push(`${m.title} ist noch installiert (liegt die Datei von Hand im mods-Ordner?).`);
    }
    setState('applied', desired);
    audit(user.id, 'mods übernommen', changes.map((c) => `${c.kind}: ${c.title}${c.to ? ` ${c.to}` : ''}`).join(', ').slice(0, 500));
    finish({ ok: problems.length === 0, problems });
  } catch (err) {
    log.error(err, 'Mods übernehmen fehlgeschlagen');
    audit(user.id, 'mods übernehmen fehlgeschlagen', (err as Error).message);
    finish({ ok: false, error: (err as Error).message });
  }
}

/* ───────────────────────── Übersicht für die Website ───────────────────────── */

export async function managedOverview(game: string | null, fresh: boolean) {
  await ensureSeeded();
  const desired = listManaged();
  const applied = appliedMods();
  const appliedById = new Map(applied.map((m) => [m.projectId, m]));
  const { jars, byProject } = await installedVersions(fresh);
  const updates = game ? await latestByHash(jars.map((j) => j.sha1), game).catch(() => NONE) : NONE;
  const titles = new Map(desired.map((m) => [m.projectId, m.title]));

  const managed = desired.map((m) => {
    const a = appliedById.get(m.projectId);
    const installed = byProject.get(m.projectId);
    const latest = installed ? updates[installed.jar.sha1] : undefined;
    let state: 'active' | 'new' | 'enabling' | 'disabling' | 'disabled' | 'version' | 'missing';
    if (!a) state = m.enabled ? 'new' : 'disabled';
    else if (a.enabled && !m.enabled) state = 'disabling';
    else if (!a.enabled && m.enabled) state = 'enabling';
    else if (!m.enabled) state = 'disabled';
    else if (a.versionId !== m.versionId) state = 'version';
    else state = installed?.version.id === m.versionId ? 'active' : 'missing';
    const dependents = desired.filter((d) => d.requires.includes(m.projectId));
    return {
      ...m,
      icon: m.hasIcon ? `/api/mods/icons/${m.projectId}` : null,
      url: `https://modrinth.com/mod/${m.slug}`,
      state,
      installed: installed ? { file: installed.jar.file, versionId: installed.version.id, number: installed.version.version_number } : null,
      update:
        latest && latest.id !== m.versionId && latest.date_published > m.versionPublished
          ? { id: latest.id, number: latest.version_number, type: latest.version_type, published: latest.date_published }
          : null,
      requiresTitles: m.requires.map((id) => ({ id, title: titles.get(id) ?? id, ok: desired.some((d) => d.projectId === id && d.enabled) })),
      requiredBy: dependents.filter((d) => d.enabled).map((d) => d.title),
      orphan: m.auto && dependents.length === 0,
    };
  });

  const managedIds = new Set(desired.map((m) => m.projectId));
  const unmanaged = jars
    .filter((j) => ![...byProject.entries()].some(([id, v]) => v.jar.sha1 === j.sha1 && managedIds.has(id)))
    .map((j) => ({ file: j.file, size: j.size }));

  return {
    managed,
    unmanaged,
    pending: pendingChanges(desired, applied),
    dependencyProblems: missingDependencies(desired),
    apply: applyStatus(),
    canApply: !!MODS_FILE,
  };
}

/* ───────────────────────── Routen ───────────────────────── */

export async function registerModManager(app: FastifyInstance) {
  const guard = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (applyRunning()) {
      reply.code(409).send({ error: 'Gerade werden Änderungen übernommen – bitte kurz warten.' });
      return false;
    }
    return true;
  };

  // Mod hinzufügen (inkl. benötigter Mods)
  app.post<{ Body: { projectId?: string } }>('/api/mods/manage', async (req, reply) => {
    if (!requireAdmin(req, reply) || !guard(reply)) return;
    const projectId = req.body?.projectId ?? '';
    if (!PROJECT_ID.test(projectId)) return reply.code(400).send({ error: 'Ungültige Projekt-ID.' });
    try {
      await ensureSeeded();
      const plan = await planAdd(projectId, await currentGameVersion(), req.user!.displayName, false);
      transaction(() => plan.forEach((m) => saveManaged(m)));
      const added = [...plan.values()];
      audit(req.user!.id, 'mod geplant', added.map((m) => `${m.title} ${m.versionNumber}`).join(', '));
      return { added: added.map((m) => ({ projectId: m.projectId, title: m.title, auto: m.auto })) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Aktivieren/Deaktivieren, Notiz, Version (versionId: "latest" = neueste passende)
  app.patch<{ Params: { id: string }; Body: { enabled?: boolean; cascade?: boolean; note?: string; versionId?: string } }>(
    '/api/mods/manage/:id',
    async (req, reply) => {
      if (!requireAdmin(req, reply) || !guard(reply)) return;
      const mod = getManaged(req.params.id);
      if (!mod) return reply.code(404).send({ error: 'Mod nicht in der Liste.' });
      const body = req.body ?? {};
      const changed: ManagedMod[] = [];
      const by = req.user!.displayName;

      try {
        if (typeof body.note === 'string') {
          changed.push({ ...mod, note: body.note.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 300) });
        }
        if (body.versionId) {
          const game = await currentGameVersion();
          const versions = await projectVersions(mod.projectId, game);
          const version = body.versionId === 'latest' ? pickVersion(versions) : versions.find((v) => v.id === body.versionId);
          if (!version) return reply.code(400).send({ error: `Keine passende Version von ${mod.title} für ${game}.` });
          const requires = await requiredProjects(version);
          const next = {
            ...(changed[0] ?? mod),
            versionId: version.id,
            versionNumber: version.version_number,
            versionType: version.version_type,
            versionPublished: version.date_published,
            requires,
          };
          changed.splice(0, changed.length, next);
          // Neue Abhängigkeiten der neuen Version gleich mit einplanen
          const plan = new Map<string, ManagedMod>();
          for (const dep of requires) await planAdd(dep, game, by, true, plan);
          changed.push(...plan.values());
        }
        if (typeof body.enabled === 'boolean') {
          const base = changed[0] ?? mod;
          changed.splice(0, 1, { ...base, enabled: body.enabled });
          if (body.enabled) {
            // Benötigte Mods mit einschalten
            const plan = new Map<string, ManagedMod>();
            for (const dep of base.requires) await planAdd(dep, await currentGameVersion(), by, true, plan);
            changed.push(...plan.values());
          } else {
            const dependents = dependentsOf(listManaged(), mod.projectId);
            if (dependents.length && !body.cascade) {
              return reply.code(409).send({
                error: `${dependents.map((d) => d.title).join(', ')} ${dependents.length === 1 ? 'braucht' : 'brauchen'} ${mod.title}.`,
                dependents: dependents.map((d) => d.title),
              });
            }
            // Abhängige Mods mit ausschalten (rekursiv)
            const off = new Set<string>([mod.projectId]);
            const all = listManaged();
            let grew = true;
            while (grew) {
              grew = false;
              for (const m of all) {
                if (m.enabled && !off.has(m.projectId) && m.requires.some((r) => off.has(r))) {
                  off.add(m.projectId);
                  changed.push({ ...m, enabled: false });
                  grew = true;
                }
              }
            }
          }
        }
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }

      transaction(() => changed.forEach((m) => saveManaged(m)));
      if (typeof body.enabled === 'boolean' || body.versionId) {
        audit(req.user!.id, body.versionId ? 'mod-version geplant' : body.enabled ? 'mod aktiviert (geplant)' : 'mod deaktiviert (geplant)',
          changed.map((m) => `${m.title}${body.versionId ? ` ${m.versionNumber}` : ''}`).join(', '));
      }
      return { ok: true, changed: changed.map((m) => m.title) };
    },
  );

  // Aus der Liste entfernen (Configs bleiben auf dem Server liegen)
  app.delete<{ Params: { id: string } }>('/api/mods/manage/:id', async (req, reply) => {
    if (!requireAdmin(req, reply) || !guard(reply)) return;
    const mod = getManaged(req.params.id);
    if (!mod) return reply.code(404).send({ error: 'Mod nicht in der Liste.' });
    const dependents = dependentsOf(listManaged(), mod.projectId);
    if (dependents.length) {
      return reply.code(409).send({
        error: `${mod.title} wird noch gebraucht von ${dependents.map((d) => d.title).join(', ')}. Erst diese entfernen oder deaktivieren.`,
      });
    }
    db.prepare('DELETE FROM server_mods WHERE project_id = ?').run(mod.projectId);
    audit(req.user!.id, 'mod entfernt (geplant)', mod.title);
    return { ok: true };
  });

  // Geplante Änderungen verwerfen: zurück zum zuletzt übernommenen Stand
  app.post('/api/mods/discard', async (req, reply) => {
    if (!requireAdmin(req, reply) || !guard(reply)) return;
    const applied = appliedMods();
    // Modpack-Einstellung je Mod behalten
    const packModes = db.prepare('SELECT project_id, pack_mode FROM server_mods').all() as Array<{ project_id: string; pack_mode: string }>;
    transaction(() => {
      db.exec('DELETE FROM server_mods');
      for (const m of applied) saveManaged(m);
      const restore = db.prepare('UPDATE server_mods SET pack_mode = ? WHERE project_id = ?');
      for (const p of packModes) restore.run(p.pack_mode, p.project_id);
    });
    audit(req.user!.id, 'mod-änderungen verworfen');
    return { ok: true };
  });

  // Übernehmen: läuft im Hintergrund, Fortschritt über GET /api/mods (apply)
  app.post('/api/mods/apply', async (req, reply) => {
    if (!requireAdmin(req, reply) || !guard(reply)) return;
    if (!MODS_FILE) return reply.code(400).send({ error: 'Übernehmen geht nur im Docker-Betrieb.' });
    const desired = listManaged();
    const problems = missingDependencies(desired);
    if (problems.length) {
      return reply.code(400).send({ error: `Es fehlen benötigte Mods: ${problems.map((p) => `${p.mod} braucht ${p.needs}`).join('; ')}.` });
    }
    if (!pendingChanges(desired, appliedMods()).length) return reply.code(400).send({ error: 'Es gibt nichts zu übernehmen.' });
    void runApply(req.user!, req.log);
    return { ok: true };
  });

  // Aktuelle Datei (zur Kontrolle)
  app.get('/api/mods/file', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!MODS_FILE) return reply.code(404).send({ error: 'Keine Datei.' });
    const text = await readFile(MODS_FILE, 'utf8').catch(() => '');
    return reply.type('text/plain; charset=utf-8').send(text);
  });
}
