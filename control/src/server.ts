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

function untar(archive: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Nur den Weltordner – Whitelist, OPs und Bans bleiben auf dem aktuellen Stand
    const tar = spawn('tar', ['xzf', archive, '-C', target, 'world']);
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

async function restore(id: string) {
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
      await untar(archive, MC_DIR);
      await chownRecursive(world);
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

const ACTIONS: Record<string, (arg?: string) => Promise<unknown>> = {
  'GET /status': status,
  'GET /logs': logs,
  'POST /stop': stopServer,
  'POST /start': startServer,
  'POST /restart': async () => { await stopServer(); await startServer(); },
  'POST /restore': (id) => restore(id ?? ''),
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
    const result = await action(url.searchParams.get('id') ?? undefined);
    console.log(new Date().toISOString(), req.method, url.pathname, url.searchParams.get('id') ?? '', 'ok');
    send(res, 200, result ?? { ok: true });
  } catch (err) {
    console.error(new Date().toISOString(), req.method, url.pathname, (err as Error).message);
    send(res, 500, { error: (err as Error).message });
  } finally {
    if (mutating) busy = false;
  }
}).listen(4000, () => console.log(`neo-control bereit (Container: ${CONTAINER})`));

