// neo-control: winziger Steuerdienst mit Docker-Zugriff – bewusst getrennt von der API.
// Kann ausschließlich den Minecraft-Container abfragen (Status, Logs), starten, stoppen, neu starten
// und dessen Welt aus einem Backup zurückspielen. Nur im internen Docker-Netz erreichbar,
// jede Anfrage braucht das geheime CONTROL_TOKEN.
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chown, readdir, rename, rm, stat } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

const TOKEN = process.env.CONTROL_TOKEN ?? '';
const CONTAINER = process.env.MC_CONTAINER ?? 'mc-neo';
const MC_DIR = process.env.MC_DATA_DIR ?? '/mc';
const BACKUP_DIR = process.env.BACKUP_DIR ?? '/backups';
const MC_UID = Number(process.env.MC_UID ?? 1000);
const MC_GID = Number(process.env.MC_GID ?? 1000);
const BACKUP_ID = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;

if (TOKEN.length < 24) {
  console.error('CONTROL_TOKEN fehlt oder ist zu kurz – Dienst startet nicht.');
  process.exit(1);
}

/* ───────────────────────── Docker-API über den Socket ───────────────────────── */

function docker(method: string, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: '/var/run/docker.sock', method, path, timeout: 120_000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let body: unknown = data;
        try { body = data ? JSON.parse(data) : null; } catch { /* Text */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Docker antwortet nicht')));
    req.end();
  });
}

const container = `/containers/${encodeURIComponent(CONTAINER)}`;

async function status() {
  const { status: code, body } = await docker('GET', `${container}/json`);
  if (code !== 200) throw new Error(`Container ${CONTAINER} nicht gefunden`);
  const state = body.State;
  let memory: { usage: number; limit: number } | null = null;
  if (state.Running) {
    const stats = await docker('GET', `${container}/stats?stream=false&one-shot=true`);
    const m = stats.body?.memory_stats;
    if (m?.usage) memory = { usage: m.usage - (m.stats?.inactive_file ?? 0), limit: m.limit };
  }
  return {
    running: state.Running as boolean,
    status: state.Status as string,
    health: (state.Health?.Status ?? null) as string | null,
    startedAt: state.StartedAt as string,
    memory,
  };
}

async function waitStopped() {
  for (let i = 0; i < 90; i++) {
    if (!(await status()).running) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Server hat sich nicht beendet');
}

async function stopServer() {
  // t=60: dem Server Zeit zum Speichern geben, bevor Docker hart beendet
  await docker('POST', `${container}/stop?t=60`);
  await waitStopped();
}

async function startServer() {
  const { status: code, body } = await docker('POST', `${container}/start`);
  if (code !== 204 && code !== 304) throw new Error(`Start fehlgeschlagen: ${JSON.stringify(body)}`);
}

/** Letzte Log-Zeilen des Servers (für Fehlermeldungen nach einem missglückten Start) */
function logs(): Promise<{ logs: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: '/var/run/docker.sock', method: 'GET', path: `${container}/logs?stdout=1&stderr=1&tail=80`, timeout: 15_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          // Ohne TTY liefert Docker einen Multiplex-Stream: je Block 8 Byte Kopf (Typ, 0, 0, 0, Länge als uint32)
          const raw = Buffer.concat(chunks);
          let text = '';
          let i = 0;
          while (i + 8 <= raw.length && raw[i] <= 2 && raw[i + 1] === 0) {
            const len = raw.readUInt32BE(i + 4);
            text += raw.subarray(i + 8, i + 8 + len).toString('utf8');
            i += 8 + len;
          }
          resolve({ logs: i === 0 ? raw.toString('utf8') : text });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Docker antwortet nicht')));
    req.end();
  });
}

/* ───────────────────────── Zurückspielen ───────────────────────── */

/** Zusätzlich zur Welt beim vollständigen Übernehmen (Umzug): alles außer server.properties (kommt aus der Konfiguration) */
const FULL_EXTRAS = ['whitelist.json', 'ops.json', 'banned-players.json', 'banned-ips.json', 'usercache.json', 'config'];

function untar(archive: string, target: string, full = false): Promise<void> {
  return new Promise((resolve, reject) => {
    // Normal nur den Weltordner – Whitelist, OPs und Bans bleiben auf dem aktuellen Stand.
    // Beim Umzug (full) das ganze Archiv (Welt, OPs, Whitelist, Bans, Mod-Configs) – nur server.properties nicht,
    // die kommt aus der Konfiguration des Servers.
    const args = full
      ? ['xzf', archive, '-C', target, '--exclude=server.properties']
      : ['xzf', archive, '-C', target, 'world'];
    const tar = spawn('tar', args);
    let err = '';
    tar.stderr.on('data', (d) => (err += d));
    tar.on('error', reject);
    tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar: ${err.trim().slice(0, 300)}`))));
  });
}

async function chownRecursive(path: string) {
  await chown(path, MC_UID, MC_GID);
  if ((await stat(path)).isDirectory()) {
    for (const entry of await readdir(path)) await chownRecursive(join(path, entry));
  }
}

let busy = false;

async function restore(id: string, full = false) {
  if (!BACKUP_ID.test(id)) throw new Error('Ungültige Backup-ID');
  const archive = join(BACKUP_DIR, id, 'world.tar.gz');
  if (!existsSync(archive)) throw new Error('Backup nicht gefunden');

  const world = join(MC_DIR, 'world');
  const previous = join(MC_DIR, 'world.before-restore');
  await stopServer();
  try {
    await rm(previous, { recursive: true, force: true });
    if (existsSync(world)) await rename(world, previous);
    try {
      await untar(archive, MC_DIR, full);
      await chownRecursive(world);
      if (full) for (const p of FULL_EXTRAS) if (existsSync(join(MC_DIR, p))) await chownRecursive(join(MC_DIR, p));
    } catch (err) {
      // Fehlgeschlagen: alte Welt zurücklegen
      await rm(world, { recursive: true, force: true });
      if (existsSync(previous)) await rename(previous, world);
      throw err;
    }
    // Der Stand vor dem Zurückspielen liegt ohnehin als Backup vor
    await rm(previous, { recursive: true, force: true });
  } finally {
    await startServer();
  }
}

/* ───────────────────────── HTTP ───────────────────────── */

function authorized(req: IncomingMessage) {
  const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
  const expected = Buffer.from(TOKEN);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

const ACTIONS: Record<string, (arg?: string, full?: boolean) => Promise<unknown>> = {
  'GET /status': status,
  'GET /logs': logs,
  'POST /stop': stopServer,
  'POST /start': startServer,
  'POST /restart': async () => { await stopServer(); await startServer(); },
  'POST /restore': (id, full) => restore(id ?? '', full),
};

createServer(async (req, res) => {
  if (!authorized(req)) return send(res, 401, { error: 'Nicht autorisiert' });
  const url = new URL(req.url ?? '/', 'http://control');
  const action = ACTIONS[`${req.method} ${url.pathname}`];
  if (!action) return send(res, 404, { error: 'Unbekannt' });

  const mutating = req.method !== 'GET';
  if (mutating && busy) return send(res, 409, { error: 'Es läuft bereits eine Server-Aktion.' });
  if (mutating) busy = true;
  try {
    const result = await action(url.searchParams.get('id') ?? undefined, url.searchParams.get('full') === '1');
    console.log(new Date().toISOString(), req.method, url.pathname, url.searchParams.get('id') ?? '', 'ok');
    send(res, 200, result ?? { ok: true });
  } catch (err) {
    console.error(new Date().toISOString(), req.method, url.pathname, (err as Error).message);
    send(res, 500, { error: (err as Error).message });
  } finally {
    if (mutating) busy = false;
  }
}).listen(4000, () => console.log(`neo-control bereit (Container: ${CONTAINER})`));

/* ───────────────────────── Traefik-Diagnose (einmalig beim Start) ─────────────────────────
   Hilft beim Einrichten von HTTPS: Gibt nur die NAMEN der Traefik-Entrypoints und Zertifikats-Resolver
   sowie Traefik-Logzeilen zur eigenen Domain aus – keine Werte wie E-Mail, Passwörter oder Tokens.
   Abschalten mit TRAEFIK_DIAGNOSE=0. */

const TRAEFIK = process.env.TRAEFIK_CONTAINER ?? 'traefik';
const DOMAIN = process.env.DOMAIN ?? '';

function dockerRaw(path: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: '/var/run/docker.sock', method: 'GET', path, timeout: 15_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Docker antwortet nicht')));
    req.end();
  });
}

/** Erste Datei aus einem Tar-Archiv (Docker liefert Dateien aus Containern als Tar) */
function firstTarFile(tar: Buffer): string | undefined {
  if (tar.length < 512) return undefined;
  const size = parseInt(tar.subarray(124, 136).toString().replace(/\0.*$/, '').trim(), 8);
  return Number.isFinite(size) ? tar.subarray(512, 512 + size).toString('utf8') : undefined;
}

/** Namen direkt unter einem Abschnitt einer YAML-Datei, z. B. certificatesResolvers → [letsencrypt] */
function yamlChildKeys(text: string, section: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^\s*${section}\s*:`, 'i').test(l));
  if (start < 0) return [];
  const baseIndent = lines[start].search(/\S/);
  let childIndent = -1;
  const keys: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.search(/\S/);
    if (indent <= baseIndent) break;
    if (childIndent < 0) childIndent = indent;
    const m = /^\s*([A-Za-z0-9_.-]+)\s*:/.exec(line);
    if (indent === childIndent && m) keys.push(m[1]);
  }
  return keys;
}

async function traefikDiagnose() {
  if (process.env.TRAEFIK_DIAGNOSE === '0') return;
  const log = (msg: string) => console.log(`[traefik-diagnose] ${msg}`);
  try {
    const { status, body } = await dockerRaw(`/containers/${encodeURIComponent(TRAEFIK)}/json`);
    if (status !== 200) return log(`Container "${TRAEFIK}" nicht gefunden.`);
    const info = JSON.parse(body.toString());
    const args: string[] = [...(info.Config?.Entrypoint ?? []), ...(info.Config?.Cmd ?? []), ...(info.Args ?? [])];
    const names = (re: RegExp) => [...new Set(args.map((a) => re.exec(a)?.[1]).filter((n): n is string => !!n))];
    const entrypoints = names(/^--entrypoints\.([^.=]+)\./i);
    const resolvers = names(/^--certificatesresolvers\.([^.=]+)\./i);
    const challenges = names(/^--certificatesresolvers\.[^.=]+\.acme\.(httpchallenge|tlschallenge|dnschallenge)\b/i);
    log(`Aus Startparametern – Entrypoints: ${entrypoints.join(', ') || '–'} | Resolver: ${resolvers.join(', ') || '–'} | Challenge: ${challenges.join(', ') || '–'}`);
    log(`Eingebundene Pfade im Container: ${(info.Mounts ?? []).map((m: { Destination: string }) => m.Destination).join(', ') || '–'}`);

    // Statische Konfigurationsdatei (falls vorhanden): nur Abschnittsnamen auslesen
    const candidates = ['/etc/traefik/traefik.yml', '/etc/traefik/traefik.yaml', '/traefik.yml', '/traefik.yaml'];
    for (const m of info.Mounts ?? []) {
      if (/\.ya?ml$/i.test(m.Destination)) candidates.push(m.Destination);
      else candidates.push(`${m.Destination}/traefik.yml`, `${m.Destination}/traefik.yaml`);
    }
    for (const path of [...new Set(candidates)]) {
      const res = await dockerRaw(`/containers/${encodeURIComponent(TRAEFIK)}/archive?path=${encodeURIComponent(path)}`).catch(() => null);
      if (res?.status !== 200) continue;
      const text = firstTarFile(res.body);
      if (!text) continue;
      log(`Konfigurationsdatei ${path} – Entrypoints: ${yamlChildKeys(text, 'entryPoints').join(', ') || '–'} | Resolver: ${yamlChildKeys(text, 'certificatesResolvers').join(', ') || '–'}`);
    }

    // Traefik-Log: nur Zeilen zur eigenen Domain bzw. zu Zertifikaten
    const logs = await dockerRaw(`/containers/${encodeURIComponent(TRAEFIK)}/logs?stdout=1&stderr=1&tail=2000`);
    const raw = logs.body;
    let text = '';
    for (let i = 0; i + 8 <= raw.length && raw[i] <= 2; ) {
      const len = raw.readUInt32BE(i + 4);
      text += raw.subarray(i + 8, i + 8 + len).toString('utf8');
      i += 8 + len;
    }
    if (!text) text = raw.toString('utf8');
    const pattern = new RegExp(`${DOMAIN ? DOMAIN.replace(/\./g, '\.') + '|' : ''}resolver|acme|certificate`, 'i');
    const relevant = text.split('\n').filter((l) => pattern.test(l)).slice(-15);
    log(`Logzeilen zu Domain/Zertifikaten (${relevant.length}):`);
    for (const line of relevant) log(`  ${line.slice(0, 400)}`);
  } catch (err) {
    log(`fehlgeschlagen: ${(err as Error).message}`);
  }
}

void traefikDiagnose();
