// Umzug: Ein Backup als "Umzugspaket" (eine .tar-Datei) herunterladen, auf einem anderen Server hochladen und dort
// komplett übernehmen – Welt samt OPs/Whitelist/Mod-Configs, Website-Datenbank, Blaupausen, Projektbilder,
// Item-Bibliothek und Mod-Liste. Die Website-Datenbank wird beim Neustart der API getauscht (siehe db.ts).
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from './auth.ts';
import { audit } from './users.ts';
import { DATA_DIR, IMAGE_DIR, SCHEMATIC_DIR } from './db.ts';
import { BACKUP_DIR, BACKUP_ID, createBackup, setPinned } from './backup.ts';
import { control, rcon, tellraw, wait, WARNING_SECONDS } from './server-admin.ts';
import { modsFileContent, type ManagedMod } from './mod-manager.ts';

const ITEMS_DIR = process.env.ITEMS_DIR ?? '';
const MODS_FILE = process.env.MODS_FILE ?? '';
const MAX_PACKAGE_BYTES = 2 * 1024 ** 3;
/** Liegt diese Datei im Datenordner, tauscht die API sie beim nächsten Start gegen ihre Datenbank (db.ts) */
export const IMPORT_DB = join(DATA_DIR, 'neo.db.import');

/* ───────────────────────── Hilfen (getestet) ───────────────────────── */

/**
 * Prüft die Liste eines hochgeladenen Pakets (Ausgabe von "tar tvf"): genau ein Backup-Ordner, keine absoluten Pfade,
 * kein "..", keine Links oder Gerätedateien. Gibt die Backup-ID oder einen Fehler zurück.
 */
export function checkPackageListing(verbose: string): { id: string } | { error: string } {
  const lines = verbose.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  if (!lines.length) return { error: 'Das Paket ist leer.' };
  let id = '';
  for (const line of lines) {
    const type = line[0];
    if (type !== '-' && type !== 'd') return { error: 'Das Paket enthält Links oder Sonderdateien – abgelehnt.' };
    // "tar tvf": Rechte, Besitzer, Größe, Datum, Uhrzeit, Name
    const name = line.split(/\s+/).slice(5).join(' ');
    if (!name || name.startsWith('/') || name.split('/').includes('..')) return { error: `Ungültiger Pfad im Paket: ${name}` };
    const top = name.replace(/^\.\//, '').split('/')[0];
    if (!BACKUP_ID.test(top)) return { error: 'Das ist kein Umzugspaket dieser Website.' };
    if (id && id !== top) return { error: 'Das Paket enthält mehrere Backups.' };
    id = top;
  }
  return { id };
}

/* ───────────────────────── tar ───────────────────────── */

function run(cmd: string, args: string[], stdout?: NodeJS.WritableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = '';
    let err = '';
    if (stdout) p.stdout.pipe(stdout);
    else p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd}: ${err.trim().slice(0, 300) || `Code ${code}`}`))));
  });
}

/* ───────────────────────── Übernehmen ───────────────────────── */

/** Mod-Liste des übernommenen Stands (aus der mitgebrachten Datenbank) */
function appliedModsFrom(dbFile: string): ManagedMod[] {
  const source = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const row = source.prepare("SELECT value FROM mod_state WHERE key = 'applied'").get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as ManagedMod[]) : [];
  } catch {
    return [];
  } finally {
    source.close();
  }
}

async function replaceDirContents(target: string, source: string) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(target)) await rm(join(target, entry), { recursive: true, force: true });
  if (existsSync(source)) await cp(source, target, { recursive: true });
}

/* ───────────────────────── Routen ───────────────────────── */

export async function registerMigration(app: FastifyInstance) {
  // Hochladen als rohe .tar-Datei (kein multipart), damit auch große Pakete gestreamt werden
  app.addContentTypeParser('application/x-tar', (_req, payload, done) => done(null, payload));

  app.get<{ Params: { id: string } }>('/api/backups/:id/package', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = req.params.id;
    if (!BACKUP_ID.test(id) || !existsSync(join(BACKUP_DIR, id))) return reply.code(404).send({ error: 'Backup nicht gefunden.' });
    // Backup-Ordner + Item-Bibliothek (als <id>/items) in ein Paket
    const args = ['cf', '-', '-C', BACKUP_DIR, '--exclude', `${id}/items`, id];
    if (ITEMS_DIR && existsSync(ITEMS_DIR)) {
      args.push('-C', dirname(ITEMS_DIR), `--transform=s,^${basename(ITEMS_DIR)},${id}/items,`, basename(ITEMS_DIR));
    }
    const tar = spawn('tar', args);
    tar.stderr.on('data', (d) => req.log.warn({ tar: String(d) }, 'Umzugspaket'));
    audit(req.user!.id, 'umzugspaket heruntergeladen', id);
    return reply
      .header('Content-Type', 'application/x-tar')
      .header('Content-Disposition', `attachment; filename="neo-umzug-${id}.tar"`)
      .send(tar.stdout);
  });

  app.put('/api/backups/import', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = req.body as Readable | undefined;
    if (!body || typeof body.pipe !== 'function') return reply.code(400).send({ error: 'Bitte eine .tar-Datei hochladen.' });
    await mkdir(BACKUP_DIR, { recursive: true });
    const tmp = join(BACKUP_DIR, `.upload-${Date.now()}.tar`);
    const staging = join(BACKUP_DIR, `.upload-${Date.now()}`);
    try {
      let bytes = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          cb(bytes > MAX_PACKAGE_BYTES ? new Error('Das Paket ist zu groß (max. 2 GB).') : null, chunk);
        },
      });
      await pipeline(body, limit, createWriteStream(tmp));

      const checked = checkPackageListing(await run('tar', ['tvf', tmp]));
      if ('error' in checked) return reply.code(400).send({ error: checked.error });
      const target = join(BACKUP_DIR, checked.id);
      if (existsSync(target)) return reply.code(409).send({ error: `Ein Backup ${checked.id} gibt es hier schon.` });

      await mkdir(staging, { recursive: true });
      await run('tar', ['xf', tmp, '-C', staging, '--no-same-owner', '--no-same-permissions']);
      const extracted = join(staging, checked.id);
      if (!existsSync(join(extracted, 'meta.json')) || !existsSync(join(extracted, 'world.tar.gz'))) {
        return reply.code(400).send({ error: 'Im Paket fehlen Welt oder Beschreibung (meta.json).' });
      }
      const meta = JSON.parse(await readFile(join(extracted, 'meta.json'), 'utf8'));
      await writeFile(join(extracted, 'meta.json'), JSON.stringify({ ...meta, kind: 'import', by: req.user!.displayName, pinned: true }, null, 2));
      await rename(extracted, target);
      audit(req.user!.id, 'umzugspaket hochgeladen', `${checked.id} (${Math.round(bytes / 1024 / 1024)} MB)`);
      return { ok: true, id: checked.id, bytes };
    } catch (err) {
      const message = (err as Error).message;
      return reply.code(400).send({
        error: /not look like a tar|unexpected EOF|Unexpected EOF/i.test(message)
          ? 'Das ist kein gültiges Umzugspaket (.tar) – bitte die heruntergeladene Datei unverändert hochladen.'
          : message,
      });
    } finally {
      await rm(tmp, { force: true });
      await rm(staging, { recursive: true, force: true });
    }
  });

  // Alles übernehmen: Welt (inkl. OPs/Whitelist/Configs), Website-Daten, Item-Bibliothek, Mod-Liste
  app.post<{ Params: { id: string } }>('/api/backups/:id/restore-all', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = req.params.id;
    const dir = join(BACKUP_DIR, id);
    if (!BACKUP_ID.test(id) || !existsSync(join(dir, 'world.tar.gz'))) return reply.code(404).send({ error: 'Backup nicht gefunden.' });
    if (!existsSync(join(dir, 'website.db'))) return reply.code(400).send({ error: 'In diesem Backup fehlen die Website-Daten.' });

    let safety;
    try {
      safety = await createBackup('manual', `Vor Übernahme (${req.user!.displayName})`, req.log);
      await setPinned(safety.id, true);
    } catch (err) {
      return reply.code(502).send({ error: `Sicherheits-Backup fehlgeschlagen, nichts geändert: ${(err as Error).message}` });
    }

    try {
      // 1. Website-Daten vorbereiten (Datenbank wird beim Neustart der API getauscht)
      await cp(join(dir, 'website.db'), IMPORT_DB);
      await replaceDirContents(SCHEMATIC_DIR, join(dir, 'schematics'));
      await replaceDirContents(IMAGE_DIR, join(dir, 'images'));
      // 2. Item-Bibliothek
      const items = existsSync(join(dir, 'items')) && ITEMS_DIR;
      if (items) await replaceDirContents(ITEMS_DIR, join(dir, 'items'));
      // 3. Mod-Liste des mitgebrachten Stands, damit der Server gleich die richtigen Mods lädt
      const mods = appliedModsFrom(IMPORT_DB);
      if (MODS_FILE && mods.length) await writeFile(MODS_FILE, modsFileContent(mods, `${req.user!.displayName} (Übernahme ${id})`));
      // 4. Welt samt Server-Dateien ersetzen und Server neu starten
      await rcon(tellraw(`Der Server übernimmt in ${WARNING_SECONDS} Sekunden einen gespeicherten Stand und startet neu.`)).catch(() => undefined);
      await wait(WARNING_SECONDS);
      await control('POST', `/restore?id=${encodeURIComponent(id)}&full=1`);
      audit(req.user!.id, 'umzug übernommen', `${id} (Sicherheits-Backup ${safety.id}, ${mods.length} Mods${items ? ', Items' : ''})`);
    } catch (err) {
      await rm(IMPORT_DB, { force: true });
      audit(req.user!.id, 'umzug fehlgeschlagen', `${id}: ${(err as Error).message}`);
      return reply.code(502).send({ error: `Übernahme fehlgeschlagen: ${(err as Error).message}. Sicherheits-Backup: ${safety.id}` });
    }

    // 5. API neu starten → Datenbank tauschen (Docker startet den Container automatisch wieder)
    setTimeout(() => process.exit(0), 1500);
    return { ok: true, safetyBackup: safety.id, relogin: true };
  });
}

