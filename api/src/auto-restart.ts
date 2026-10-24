// Geplanter Neustart: jeden Tag zur festen Uhrzeit (Zeitzone des Containers, TZ=Europe/Berlin).
// 15, 5 und 1 Minute vorher wird im Chat angekündigt, direkt davor ein Backup gezogen –
// bei „Backups nur bei Spieleraktivität“ nur, wenn seit dem letzten Backup jemand gespielt hat.
// Sind Mod-Änderungen „beim Neustart“ vorgemerkt, übernimmt der Neustart sie (mit eigenem Backup und Prüfung).
// Läuft der Server zur geplanten Zeit nicht, wird der Termin übersprungen.
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { requireAdmin } from './auth.ts';
import { audit } from './users.ts';
import { backupStatus, createBackup } from './backup.ts';
import { backupNeeded } from './backup-schedule.ts';
import {
  applyAtRestart, applyBlocker, applyRunning, getState, runScheduledApply, setApplyAtRestart, setState,
} from './mod-manager.ts';
import { control, rcon, tellraw, wait } from './server-admin.ts';

export interface AutoRestartSettings { enabled: boolean; time: string }

const KEY = 'auto_restart';
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Ankündigungen in Minuten vor dem Neustart */
export const WARNINGS = [15, 5, 1];
const CHECK_MS = 20_000;
/** Wenn das Backup scheitert, wird der Neustart um diese Zeit verschoben */
const RETRY_MS = 60 * 60_000;

export function settings(): AutoRestartSettings {
  const s = getState<Partial<AutoRestartSettings>>(KEY);
  return { enabled: s?.enabled === true, time: s?.time && TIME.test(s.time) ? s.time : '05:00' };
}

/** Nächster Termin zur Uhrzeit „HH:MM“ – frühestens so, dass alle Ankündigungen noch rausgehen */
export function nextOccurrence(time: string, now: Date): Date {
  const [h, m] = time.split(':').map(Number);
  const at = new Date(now);
  at.setHours(h, m, 0, 0);
  while (at.getTime() < now.getTime() + WARNINGS[0] * 60_000) at.setDate(at.getDate() + 1);
  return at;
}

let plan: { time: string; at: number; warned: Set<number> } | null = null;
let restarting = false;

function currentPlan(s: AutoRestartSettings) {
  if (!plan || plan.time !== s.time) plan = { time: s.time, at: nextOccurrence(s.time, new Date()).getTime(), warned: new Set() };
  return plan;
}

export const nextRestartAt = () => {
  const s = settings();
  return s.enabled ? new Date(currentPlan(s).at).toISOString() : null;
};

async function tick(log: FastifyBaseLogger) {
  const s = settings();
  if (!s.enabled || restarting) return;
  const p = currentPlan(s);
  const minutesLeft = (p.at - Date.now()) / 60_000;

  for (const m of WARNINGS) {
    if (minutesLeft <= m && minutesLeft > m - 1 && !p.warned.has(m)) {
      p.warned.add(m);
      const mods = applyAtRestart() ? ' mit Mod-Updates' : '';
      await rcon(tellraw(`Geplanter Neustart${mods} in ${m} ${m === 1 ? 'Minute' : 'Minuten'}.`)).catch(() => undefined);
    }
  }
  if (minutesLeft > 0) return;
  if (applyRunning()) return; // Mod-Änderungen laufen gerade – kurz danach erneut versuchen

  const status = (await control('GET', '/status', 10_000).catch(() => null)) as { running: boolean } | null;
  if (!status?.running) {
    plan = null; // Server aus: Termin überspringen, nächster ist morgen
    return;
  }

  restarting = true;
  try {
    // Vorgemerkte Mod-Änderungen: das Übernehmen sichert, startet neu und prüft selbst
    if (applyAtRestart()) {
      while (backupStatus().running) await wait(2);
      if (await runScheduledApply(log)) {
        audit(null, 'geplanter neustart', `täglich ${s.time} Uhr, mit Mod-Änderungen`);
        plan = null;
        return;
      }
    }

    // Läuft gerade das stündliche Backup, darauf warten – danach ein eigenes ziehen
    while (backupStatus().running) await wait(2);
    try {
      if (backupNeeded()) await createBackup('auto', 'Geplanter Neustart', log);
    } catch (err) {
      p.at = Date.now() + RETRY_MS;
      p.warned.clear();
      audit(null, 'geplanter neustart verschoben', `Backup fehlgeschlagen: ${(err as Error).message}`);
      await rcon(tellraw('Geplanter Neustart verschoben.')).catch(() => undefined);
      return;
    }
    await rcon(tellraw('Server startet jetzt neu – gleich wieder da!'), 'save-all flush').catch(() => undefined);
    await wait(3);
    audit(null, 'geplanter neustart', `täglich ${s.time} Uhr`);
    plan = null;
    await control('POST', '/restart');
  } catch (err) {
    log.error(`Geplanter Neustart fehlgeschlagen: ${(err as Error).message}`);
  } finally {
    restarting = false;
  }
}

export async function registerAutoRestart(app: FastifyInstance) {
  app.get('/api/server/auto-restart', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { ...settings(), nextAt: nextRestartAt() };
  });

  app.post<{ Body: Partial<AutoRestartSettings> }>('/api/server/auto-restart', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const time = req.body?.time ?? settings().time;
    if (!TIME.test(time)) return reply.code(400).send({ error: 'Bitte eine Uhrzeit im Format HH:MM angeben.' });
    const next: AutoRestartSettings = { enabled: req.body?.enabled === true, time };
    setState(KEY, next);
    plan = null;
    // Ohne geplanten Neustart gibt es keinen Termin für vorgemerkte Mod-Änderungen
    if (!next.enabled) setApplyAtRestart(null);
    audit(req.user!.id, next.enabled ? 'geplanter neustart an' : 'geplanter neustart aus', `täglich ${time} Uhr`);
    return { ...next, nextAt: nextRestartAt() };
  });

  // Mod-Änderungen beim nächsten geplanten Neustart übernehmen (an) bzw. Vormerkung zurücknehmen (aus)
  app.post<{ Body: { enabled?: boolean } }>('/api/mods/apply-at-restart', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (req.body?.enabled !== true) {
      setApplyAtRestart(null);
      audit(req.user!.id, 'mod-änderungen nicht mehr beim neustart');
      return { applyAtRestart: null };
    }
    if (!settings().enabled) return reply.code(400).send({ error: 'Der geplante Neustart ist aus – unter Admin → Server einschalten.' });
    if (applyRunning()) return reply.code(409).send({ error: 'Gerade werden Änderungen übernommen – bitte kurz warten.' });
    const blocker = applyBlocker();
    if (blocker) return reply.code(400).send({ error: blocker });
    const value = { by: req.user!.displayName, userId: req.user!.id, at: new Date().toISOString() };
    setApplyAtRestart(value);
    audit(req.user!.id, 'mod-änderungen beim neustart', `täglich ${settings().time} Uhr`);
    return { applyAtRestart: value };
  });

  if (process.env.CONTROL_URL) setInterval(() => tick(app.log).catch(() => undefined), CHECK_MS).unref();
}
