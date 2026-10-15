// Admin → Server: Status, Whitelist an/aus, Spieler kicken/bannen, Ansagen, Neustart, Backup zurückspielen.
// Spielbefehle laufen über RCON, Start/Stopp/Zurückspielen über den Steuerdienst neo-control.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Rcon } from './rcon.ts';
import { requireAdmin } from './auth.ts';
import { audit, MINECRAFT_NAME } from './users.ts';
import { banInGame, cleanReason } from './moderation.ts';
import { BACKUP_ID, createBackup, setPinned } from './backup.ts';

const CONTROL_URL = process.env.CONTROL_URL ?? '';
const MC_DATA_DIR = process.env.MC_DATA_DIR ?? '';
export const WARNING_SECONDS = 10;

/* ───────────────────────── Hilfen ───────────────────────── */

export async function control(method: 'GET' | 'POST', path: string, timeoutMs = 300_000) {
  if (!CONTROL_URL) throw new Error('Steuerdienst nicht eingerichtet (nur im Docker-Betrieb verfügbar).');
  const res = await fetch(`${CONTROL_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.CONTROL_TOKEN ?? ''}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Steuerdienst: HTTP ${res.status}`);
  return body;
}

export async function rcon(...commands: string[]): Promise<string[]> {
  const r = new Rcon();
  try {
    await r.connect();
    const answers: string[] = [];
    for (const c of commands) answers.push(await r.command(c));
    return answers;
  } finally {
    r.close();
  }
}

/** "There are 2 of a max of 20 players online: Steve, Alex" */
export function parsePlayerList(answer: string) {
  const m = /There are (\d+) of a max(?: of)? (\d+) players online:?\s*(.*)$/i.exec(answer.trim());
  if (!m) return { online: 0, max: 0, names: [] as string[] };
  const names = m[3].split(',').map((n) => n.trim()).filter(Boolean);
  return { online: Number(m[1]), max: Number(m[2]), names };
}

/** Ansage im Chat: grünes [Neo] vor dem Text */
export function tellraw(message: string) {
  const text = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
  return `tellraw @a ${JSON.stringify([{ text: '[Neo] ', color: 'green', bold: true }, { text, color: 'white', bold: false }])}`;
}

async function readServerFile(name: string): Promise<string | undefined> {
  if (!MC_DATA_DIR) return undefined;
  return readFile(join(MC_DATA_DIR, name), 'utf8').catch(() => undefined);
}

async function whitelistState() {
  const props = await readServerFile('server.properties');
  const enabled = props ? /^white-list=true$/m.test(props) : null;
  const list = await readServerFile('whitelist.json');
  const names = list ? (JSON.parse(list) as Array<{ name: string }>).map((e) => e.name) : [];
  return { enabled, names };
}

export const wait = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

/* ───────────────────────── Routen ───────────────────────── */

export async function registerServerAdmin(app: FastifyInstance) {
  app.get('/api/server', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const [container, players, whitelist] = await Promise.all([
      control('GET', '/status', 10_000).catch((err: Error) => ({ error: err.message })),
      rcon('list').then(([a]) => parsePlayerList(a)).catch(() => null),
      whitelistState(),
    ]);
    return { container, players, whitelist, controlAvailable: !!CONTROL_URL };
  });

  app.post<{ Body: { enabled?: boolean } }>('/api/server/whitelist', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const enabled = req.body?.enabled === true;
    try {
      await rcon(enabled ? 'whitelist on' : 'whitelist off', 'whitelist reload');
    } catch (err) {
      return reply.code(502).send({ error: `Server nicht erreichbar: ${(err as Error).message}` });
    }
    audit(req.user!.id, enabled ? 'whitelist eingeschaltet' : 'whitelist ausgeschaltet');
    // Server schreibt server.properties kurz danach
    await wait(0.5);
    return whitelistState();
  });

  app.post<{ Body: { name?: string; reason?: string } }>('/api/server/kick', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const name = req.body?.name ?? '';
    if (!MINECRAFT_NAME.test(name)) return reply.code(400).send({ error: 'Ungültiger Spielername.' });
    const reason = cleanReason(req.body?.reason ?? '') || 'Vom Admin gekickt';
    const [answer] = await rcon(`kick ${name} ${reason}`).catch((err: Error) => [`Fehler: ${err.message}`]);
    if (!/kicked/i.test(answer)) return reply.code(502).send({ error: answer || 'Kick fehlgeschlagen.' });
    audit(req.user!.id, 'gekickt', `${name}: ${reason}`);
    return { ok: true };
  });

  // Bann nur im Spiel (für Spieler ohne Website-Konto); erscheint in der Bannliste unter "nur im Spiel"
  app.post<{ Body: { name?: string; reason?: string } }>('/api/server/ban', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const name = req.body?.name ?? '';
    if (!MINECRAFT_NAME.test(name)) return reply.code(400).send({ error: 'Ungültiger Spielername.' });
    const reason = cleanReason(req.body?.reason ?? '');
    const error = await banInGame(name, reason);
    if (error) return reply.code(502).send({ error });
    audit(req.user!.id, 'gebannt (spiel)', `${name}${reason ? `: ${reason}` : ''}`);
    return { ok: true };
  });

  app.post<{ Body: { message?: string } }>('/api/server/say', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const message = (req.body?.message ?? '').trim();
    if (!message) return reply.code(400).send({ error: 'Bitte einen Text eingeben.' });
    try {
      await rcon(tellraw(message));
    } catch (err) {
      return reply.code(502).send({ error: `Server nicht erreichbar: ${(err as Error).message}` });
    }
    audit(req.user!.id, 'ansage', message.slice(0, 200));
    return { ok: true };
  });

  app.post('/api/server/restart', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    await rcon(tellraw(`Server startet in ${WARNING_SECONDS} Sekunden neu – gleich wieder da!`), 'save-all flush').catch(() => undefined);
    audit(req.user!.id, 'server neu gestartet');
    await wait(WARNING_SECONDS);
    try {
      await control('POST', '/restart');
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
    return { ok: true };
  });

  // Backup zurückspielen: vorher Sicherheits-Backup (angepinnt), dann Server stoppen, Welt ersetzen, starten
  app.post<{ Params: { id: string } }>('/api/backups/:id/restore', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = req.params.id;
    if (!BACKUP_ID.test(id)) return reply.code(404).send({ error: 'Backup nicht gefunden.' });
    if (!CONTROL_URL) return reply.code(400).send({ error: 'Zurückspielen geht nur im Docker-Betrieb.' });

    let safety;
    try {
      safety = await createBackup('manual', `Vor Wiederherstellung (${req.user!.displayName})`, req.log);
      await setPinned(safety.id, true);
    } catch (err) {
      return reply.code(502).send({ error: `Sicherheits-Backup fehlgeschlagen, nichts geändert: ${(err as Error).message}` });
    }

    await rcon(tellraw(`Die Welt wird in ${WARNING_SECONDS} Sekunden auf einen früheren Stand zurückgesetzt. Server startet neu.`))
      .catch(() => undefined);
    await wait(WARNING_SECONDS);
    try {
      await control('POST', `/restore?id=${encodeURIComponent(id)}`);
    } catch (err) {
      audit(req.user!.id, 'wiederherstellung fehlgeschlagen', `${id}: ${(err as Error).message}`);
      return reply.code(502).send({ error: `Zurückspielen fehlgeschlagen: ${(err as Error).message}. Sicherheits-Backup: ${safety.id}` });
    }
    audit(req.user!.id, 'backup zurückgespielt', `${id} (Sicherheits-Backup ${safety.id})`);
    return { ok: true, safetyBackup: safety.id };
  });
}
