import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEAVE_MS, backedUp, step, type ActivityState } from '../src/backup-schedule.ts';

const HOUR = 3600_000;
const MIN = 60_000;
const fresh = (): ActivityState => ({ windowStart: 0, active: false, online: false, leftAt: null });

/** Minütlich durchspielen; players(t) liefert die Spielerzahl zur Minute t. Gibt die Backup-Zeitpunkte zurück. */
function simulate(minutes: number, players: (t: number) => number | null, onlyWithPlayers = true) {
  const s = fresh();
  const runs: Array<{ at: number; due: string }> = [];
  for (let t = 1; t <= minutes; t++) {
    const now = t * MIN;
    const due = step(s, now, players(t), onlyWithPlayers, HOUR);
    if (due) {
      runs.push({ at: t, due });
      backedUp(s, now);
    }
  }
  return runs;
}

test('leerer Server: keine Backups', () => {
  assert.deepEqual(simulate(5 * 60, () => 0), []);
});

test('Server nicht erreichbar zählt nicht als Aktivität', () => {
  assert.deepEqual(simulate(3 * 60, () => null), []);
});

test('ohne Einstellung: stur stündlich, auch ohne Spieler', () => {
  assert.deepEqual(simulate(3 * 60, () => 0, false).map((r) => r.at), [60, 120, 180]);
});

test('durchgehend gespielt: stündlich', () => {
  assert.deepEqual(simulate(3 * 60, () => 2).map((r) => r.due), ['hourly', 'hourly', 'hourly']);
});

test('letzter Spieler geht: Backup nach 5 Minuten, danach Ruhe', () => {
  const runs = simulate(4 * 60, (t) => (t >= 10 && t < 40 ? 1 : 0));
  assert.deepEqual(runs, [{ at: 40 + LEAVE_MS / MIN, due: 'leave' }]);
});

test('kurzer Disconnect unter 5 Minuten löst kein Backup aus', () => {
  const runs = simulate(50, (t) => (t >= 10 && t < 20) || t >= 22 ? 1 : 0);
  assert.deepEqual(runs, []);
});

test('Lücke geschlossen: kurz online zwischen zwei Stunden-Prüfungen wird gesichert', () => {
  // Spieler nur von Minute 70 bis 72 – das Verlassen-Backup erfasst das
  const runs = simulate(3 * 60, (t) => (t >= 70 && t < 72 ? 1 : 0));
  assert.deepEqual(runs, [{ at: 77, due: 'leave' }]);
});

test('übersprungene Runde: Spieler kommt nach der vollen Stunde – kein sofortiges Doppel-Backup', () => {
  // Leer bis Minute 65, dann durchgehend online → erstes Backup eine Stunde nach der übersprungenen Prüfung
  const runs = simulate(3 * 60, (t) => (t >= 65 ? 1 : 0));
  assert.equal(runs[0].at, 120);
  assert.equal(runs[0].due, 'hourly');
});

test('Backup von anderswo (manuell) startet ein neues Fenster', () => {
  const s = fresh();
  for (let t = 1; t <= 30; t++) step(s, t * MIN, 1, true, HOUR);
  backedUp(s, 30 * MIN);
  assert.equal(step(s, 61 * MIN, 1, true, HOUR), null);
  assert.equal(step(s, 90 * MIN, 1, true, HOUR), 'hourly');
});
