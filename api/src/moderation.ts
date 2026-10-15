// Bans im Spiel: setzen und aufheben per RCON, auflisten über banned-players.json des Servers.
// (RCON hängt mehrzeilige Antworten ohne Umbruch aneinander – "banlist" ist dadurch nicht eindeutig lesbar.)
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Rcon } from './rcon.ts';

export interface ServerBan {
  name: string;
  reason: string;
  source: string;
  created: string;
}

/** Läuft die API direkt neben dem Server (später im selben Docker-Netz), kann sie die Datei direkt lesen. */
const MC_DATA_DIR = process.env.MC_DATA_DIR ?? '';
const MC_CONTAINER = process.env.MC_CONTAINER ?? 'mc-neo';

async function readBannedPlayersJson(): Promise<string> {
  if (MC_DATA_DIR) return readFile(join(MC_DATA_DIR, 'banned-players.json'), 'utf8');
  const { stdout } = await promisify(execFile)('docker', ['exec', MC_CONTAINER, 'cat', '/data/banned-players.json']);
  return stdout;
}

export async function serverBans(): Promise<ServerBan[]> {
  try {
    const list = JSON.parse(await readBannedPlayersJson()) as Array<Record<string, string>>;
    return list.map((b) => ({ name: b.name, reason: b.reason ?? '', source: b.source ?? '', created: b.created ?? '' }));
  } catch {
    return [];
  }
}

/** Grund für Befehle säubern: eine Zeile, keine Steuerzeichen, begrenzte Länge */
export function cleanReason(reason: string): string {
  return reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120);
}

async function run(command: string): Promise<string> {
  const rcon = new Rcon();
  try {
    await rcon.connect();
    return await rcon.command(command);
  } finally {
    rcon.close();
  }
}

/** Bannt im Spiel; liefert eine Fehlermeldung oder undefined bei Erfolg */
export async function banInGame(name: string, reason: string): Promise<string | undefined> {
  try {
    const answer = await run(`ban ${name} ${cleanReason(reason) || 'Gebannt über die Website'}`);
    if (/banned|already banned/i.test(answer)) return undefined;
    return answer;
  } catch (err) {
    return `Server nicht erreichbar: ${(err as Error).message}`;
  }
}

export async function pardonInGame(name: string): Promise<string | undefined> {
  try {
    const answer = await run(`pardon ${name}`);
    if (/unbanned|isn't banned|not banned|nothing changed/i.test(answer)) return undefined;
    return answer;
  } catch (err) {
    return `Server nicht erreichbar: ${(err as Error).message}`;
  }
}
