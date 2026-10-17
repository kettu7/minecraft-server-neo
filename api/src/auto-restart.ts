// Geplanter Neustart: nach X Stunden Laufzeit startet der Server neu. Vorher wird 15, 5 und 1 Minute vorher
// im Chat angekündigt und ein Backup gezogen. Läuft der Server nicht, passiert nichts.
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { requireAdmin } from './auth.ts';
import { audit } from './users.ts';
import { backupStatus, createBackup } from './backup.ts';
import { applyRunning, getState, setState } from './mod-manager.ts';
import { control, rcon, tellraw, wait } from './server-admin.ts';

export interface AutoRestartSettings { enabled: boolean; hours: number }

const KEY = 'auto_restart';
const MIN_HOURS = 1;
const MAX_HOURS = 168;
/** Ankündigungen in Minuten vor dem Neustart */
export const WARNINGS = [15, 5, 1];
const CHECK_MS = 20_000;
/** Wenn das Backup scheitert, wird der Neustart um diese Zeit verschoben */
const RETRY_MS = 60 * 60_000;

export const settings = (): AutoRestartSettings => getState<AutoRestartSettings>(KEY) ?? { enabled: false, hours: 24 };

/** Startzeit + X Stunden – aber frühestens so, dass alle Ankündigungen noch rausgehen */
export function plannedAt(startedAt: number, hours: number, now: number) {
  return Math.max(startedAt + hours * 3_600_000, now + WARNINGS[0] * 60_000);
}

/** Plan für den aktuell laufenden Container (neu, sobald der Server neu gestartet wurde oder die Einstellung ändert) */
let plan: { startedAt: string; hours: number; at: number; warned: Set<number> } | null = null;
let restarting = false;

export const nextRestartAt = () => (settings().enabled && plan ? new Date(plan.at).toISOString() : null);

async function tick(log: FastifyBaseLogger) {
  const s = settings();
  if (!s.enabled || restarting) return;
  const status = (await control('GET', '/status', 10_000).catch(() => null)) as
    | { running: boolean; health: string | null; startedAt: string } | null;
  if (!status?.running || status.health !== 'healthy') return;

  const now = Date.now();
  if (!plan || plan.startedAt !== status.startedAt || plan.hours !== s.hours) {
    plan = { startedAt: status.startedAt, hours: s.hours, at: plannedAt(new Date(status.startedAt).getTime(), s.hours, now), warned: new Set() };
  }

  const minutesLeft = (plan.at - now) / 60_000;
  for (const m of WARNINGS) {
    if (minutesLeft <= m && minutesLeft > m - 1 && !plan.warned.has(m)) {
      plan.warned.add(m);
      await rcon(tellraw(`Geplanter Neustart in ${m} ${m === 1 ? 'Minute' : 'Minuten'}.`)).catch(() => undefined);
    }
  }
  if (minutesLeft > 0) return;
  if (applyRunning()) return; // Mod-Änderungen starten den Server ohnehin neu

  restarting = true;
  try {
    // Läuft gerade das stündliche Backup, darauf warten – danach ein eigenes ziehen
    while (backupStatus().running) await wait(2);
    try {
      await createBackup('auto', 'Geplanter Neustart', log);
    } catch (err) {
      plan.at = Date.now() + RETRY_MS;
      plan.warned.clear();
      audit(null, 'geplanter neustart verschoben', `Backup fehlgeschlagen: ${(err as Error).message}`);
      await rcon(tellraw('Geplanter Neustart verschoben.')).catch(() => undefined);
      return;
    }
    await rcon(tellraw('Server startet jetzt neu – gleich wieder da!'), 'save-all flush').catch(() => undefined);
    await wait(3);
    audit(null, 'geplanter neustart', `nach ${s.hours} Std.`);
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
    const hours = Number(req.body?.hours ?? settings().hours);
    if (!Number.isInteger(hours) || hours < MIN_HOURS || hours > MAX_HOURS) {
      return reply.code(400).send({ error: `Bitte eine ganze Zahl von ${MIN_HOURS} bis ${MAX_HOURS} Stunden.` });
    }
    const next: AutoRestartSettings = { enabled: req.body?.enabled === true, hours };
    setState(KEY, next);
    plan = null;
    audit(req.user!.id, next.enabled ? 'geplanter neustart an' : 'geplanter neustart aus', `alle ${hours} Std.`);
    await tick(req.log).catch(() => undefined);
    return { ...next, nextAt: nextRestartAt() };
  });

  if (process.env.CONTROL_URL) setInterval(() => tick(app.log).catch(() => undefined), CHECK_MS).unref();
}
