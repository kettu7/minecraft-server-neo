// Spieler-Wächter: alle 30 Sekunden schauen, wer online ist und in welchem Spielmodus.
// – Karte: BlueMap rendert nur, wenn niemand spielt. Neue Chunks zu generieren und gleichzeitig für die Karte
//   zu rendern, ist für 2 Kerne zu viel („Can't keep up!“). Kommt jemand online, pausiert das Rendern;
//   ist der Server 5 Minuten leer, holt BlueMap alles nach. Abschaltbar (Admin → Server → Einstellungen).
// – Ranglisten: Was im Creative- oder Zuschauermodus passiert, zählt nicht (stats.ts).
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { requireAdmin } from './auth.ts';
import { audit, MINECRAFT_NAME } from './users.ts';
import { getState, setState } from './mod-manager.ts';
import { liveStatus, rcon } from './server-admin.ts';
import { trackGameModes } from './stats.ts';

export interface MapSettings { pauseWhilePlaying: boolean }

const KEY = 'map_settings';
const TICK_MS = 30_000;
/** so lange muss der Server leer sein, bevor die Karte weiterrendert – ein kurzer Disconnect zählt nicht */
export const MAP_IDLE_MS = 5 * 60_000;
/** playerGameType: 0 Survival, 1 Creative, 2 Abenteuer, 3 Zuschauer */
const EXCLUDED_MODES = new Set([1, 3]);

export function mapSettings(): MapSettings {
  return { pauseWhilePlaying: getState<Partial<MapSettings>>(KEY)?.pauseWhilePlaying !== false };
}

export interface MapState {
  /** Rendern pausiert? null = unbekannt (API gerade gestartet) */
  paused: boolean | null;
  /** seit wann niemand online ist */
  emptySince: number | null;
}

/** Ein Schritt pro Prüfung (players null = Server nicht erreichbar): Was soll BlueMap jetzt tun? */
export function mapStep(s: MapState, now: number, players: number | null, enabled: boolean): 'stop' | 'start' | null {
  if (players === null) {
    // Beim nächsten Serverstart rendert BlueMap von selbst wieder
    s.paused = false;
    s.emptySince = null;
    return null;
  }
  if (players > 0) s.emptySince = null;
  else s.emptySince ??= now;

  if (!enabled) return s.paused === false ? null : 'start';
  if (players > 0) return s.paused === true ? null : 'stop';
  return s.paused !== false && now - s.emptySince! >= MAP_IDLE_MS ? 'start' : null;
}

const state: MapState = { paused: null, emptySince: null };

/** „Steve has the following entity data: 1“ → 1 */
export function parseGameMode(answer: string): number | null {
  const m = /entity data:\s*(\d+)\s*$/i.exec(answer.trim());
  return m ? Number(m[1]) : null;
}

async function gameModes(names: string[]) {
  const valid = names.filter((n) => MINECRAFT_NAME.test(n));
  const answers = valid.length ? await rcon(...valid.map((n) => `data get entity ${n} playerGameType`)) : [];
  const modes = new Map<string, boolean>();
  valid.forEach((name, i) => {
    const mode = parseGameMode(answers[i]);
    if (mode !== null) modes.set(name.toLowerCase(), EXCLUDED_MODES.has(mode));
  });
  return modes;
}

let running: Promise<void> | null = null;
/** Nie zwei Prüfungen gleichzeitig (Intervall und Schalter in der Website) */
function tick(log: FastifyBaseLogger) {
  running ??= check(log).finally(() => (running = null));
  return running;
}

async function check(log: FastifyBaseLogger) {
  const live = await liveStatus().catch(() => null);
  const online = live?.state === 'online';

  const due = mapStep(state, Date.now(), online ? live.online : null, mapSettings().pauseWhilePlaying);
  if (due) {
    await rcon(`bluemap ${due}`);
    state.paused = due === 'stop';
    log.info(due === 'stop' ? 'Karte pausiert – es wird gespielt' : 'Karte rendert wieder');
  }

  if (online) await trackGameModes(await gameModes(live.names), () => rcon('save-all'));
}

export function registerMapSettings(app: FastifyInstance) {
  app.get('/api/map/settings', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { ...mapSettings(), paused: state.paused === true };
  });

  app.post<{ Body: Partial<MapSettings> }>('/api/map/settings', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const next: MapSettings = { pauseWhilePlaying: req.body?.pauseWhilePlaying !== false };
    setState(KEY, next);
    audit(req.user!.id, next.pauseWhilePlaying ? 'karte nur ohne spieler' : 'karte rendert immer', '');
    // gleich anwenden statt bis zur nächsten Prüfung zu warten
    await tick(req.log).catch(() => undefined);
    return { ...next, paused: state.paused === true };
  });
}

export function startPlayerWatch(log: FastifyBaseLogger) {
  setInterval(() => tick(log).catch((err: Error) => log.warn(`Spieler-Wächter: ${err.message}`)), TICK_MS).unref();
}
