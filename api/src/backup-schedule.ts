// Automatische Backups nach Spieleraktivität: Jede Minute wird geschaut, ob jemand online ist.
// Stündlich gesichert wird nur, wenn seit dem letzten Backup jemand gespielt hat; verlässt der letzte
// Spieler den Server, folgt nach 5 Minuten ein Backup, damit die Sitzung sofort gesichert ist.
// Ohne Spieler ändert sich an der Welt praktisch nichts – stündliche Kopien wären reine Doppel.
// Abschaltbar (Admin → Server → Einstellungen): dann wie früher stur im festen Takt.
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { requireAdmin } from './auth.ts';
import { audit } from './users.ts';
import { INTERVAL_MINUTES, backupStatus, createBackup, listBackups, setSchedule } from './backup.ts';
import { getState, setState } from './mod-manager.ts';
import { liveStatus } from './server-admin.ts';

export interface BackupSettings { onlyWithPlayers: boolean }

const KEY = 'backup_settings';
const TICK_MS = 60_000;
/** so lange nach dem Verlassen des letzten Spielers warten – ein kurzer Disconnect löst kein Backup aus */
export const LEAVE_MS = 5 * 60_000;
const BY_LEAVE = 'Server verlassen';

export function backupSettings(): BackupSettings {
  return { onlyWithPlayers: getState<Partial<BackupSettings>>(KEY)?.onlyWithPlayers !== false };
}

export interface ActivityState {
  /** Beginn des laufenden Stunden-Fensters (letztes Backup oder übersprungene Runde) */
  windowStart: number;
  /** seit dem letzten Backup war jemand online */
  active: boolean;
  /** bei der letzten Messung war jemand online */
  online: boolean;
  /** Zeitpunkt, zu dem der letzte Spieler gegangen ist */
  leftAt: number | null;
}

export type Due = 'hourly' | 'leave' | null;

/**
 * Ein Schritt pro Minute: Spielerzahl einrechnen (null = Server nicht erreichbar → keine Aussage)
 * und entscheiden, ob jetzt gesichert wird. Ändert den Zustand.
 */
export function step(s: ActivityState, now: number, players: number | null, onlyWithPlayers: boolean, intervalMs: number): Due {
  if (players !== null) {
    if (players > 0) {
      s.active = true;
      s.leftAt = null;
    } else if (s.online) {
      s.leftAt = now;
    }
    s.online = players > 0;
  }
  const hourDue = now - s.windowStart >= intervalMs;
  if (!onlyWithPlayers) return hourDue ? 'hourly' : null;

  if (s.active && s.leftAt !== null && now - s.leftAt >= LEAVE_MS) return 'leave';
  if (!hourDue) return null;
  if (s.active) return 'hourly';
  // Niemand war da: Runde überspringen, nächste Prüfung eine Stunde später
  s.windowStart = now;
  return null;
}

/** Nach jedem erfolgreichen Backup (auch manuell oder vor dem Neustart) beginnt ein neues Fenster */
export function backedUp(s: ActivityState, at: number) {
  s.windowStart = at;
  s.active = s.online;
  s.leftAt = null;
}

const state: ActivityState = { windowStart: Date.now(), active: false, online: false, leftAt: null };
let seenRun: string | null = null;

/** Für den geplanten Neustart: Lohnt ein Backup? (Nur bei Aktivität, wenn so eingestellt) */
export const backupNeeded = () => !backupSettings().onlyWithPlayers || state.active;

function publish() {
  setSchedule(new Date(state.windowStart + INTERVAL_MINUTES * 60_000), backupSettings().onlyWithPlayers);
}

async function tick(log: FastifyBaseLogger) {
  // Erfolgreiche Backups von anderswo (manuell, Neustart, Neue Welt) übernehmen
  const last = backupStatus().lastRun;
  if (last?.ok && last.at !== seenRun) {
    seenRun = last.at;
    backedUp(state, new Date(last.at).getTime());
  }
  if (backupStatus().running) return;

  const live = await liveStatus().catch(() => null);
  const players = live?.state === 'online' ? live.online : null;
  const due = step(state, Date.now(), players, backupSettings().onlyWithPlayers, INTERVAL_MINUTES * 60_000);
  publish();
  if (!due) return;

  try {
    await createBackup('auto', due === 'leave' ? BY_LEAVE : null, log);
  } catch {
    // Fehler steht in lastRun; nicht jede Minute neu versuchen, sondern in der nächsten Runde
    state.windowStart = Date.now();
    state.leftAt = null;
  }
  publish();
}

export function registerBackupSettings(app: FastifyInstance) {
  app.get('/api/backups/settings', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return backupSettings();
  });

  app.post<{ Body: Partial<BackupSettings> }>('/api/backups/settings', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const next: BackupSettings = { onlyWithPlayers: req.body?.onlyWithPlayers !== false };
    setState(KEY, next);
    publish();
    audit(req.user!.id, next.onlyWithPlayers ? 'backups nur bei aktivität' : 'backups im festen takt', '');
    return next;
  });
}

export async function startBackupScheduler(log: FastifyBaseLogger) {
  if (!(INTERVAL_MINUTES > 0)) return;
  // Fenster ab dem letzten Backup; ohne Backup ist das erste nach einer Minute fällig
  const [latest] = await listBackups();
  state.windowStart = latest ? new Date(latest.createdAt).getTime() : Date.now() - INTERVAL_MINUTES * 60_000;
  seenRun = backupStatus().lastRun?.at ?? null;
  publish();
  setInterval(() => tick(log).catch(() => undefined), TICK_MS).unref();
  log.info(`Automatische Backups alle ${INTERVAL_MINUTES} Min.${backupSettings().onlyWithPlayers ? ', nur bei Spieleraktivität' : ''}`);
}
