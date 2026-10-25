import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAP_IDLE_MS, mapStep, parseGameMode, type MapState } from '../src/player-watch.ts';
import { closeSession, withOpenSessions } from '../src/stats.ts';

const MIN = 60_000;

test('Karte: pausiert bei Spielern, rendert 5 Min. nach dem Letzten wieder', () => {
  const s: MapState = { paused: null, emptySince: null };
  assert.equal(mapStep(s, 0, 2, true), 'stop');
  s.paused = true;
  assert.equal(mapStep(s, MIN, 1, true), null);
  assert.equal(mapStep(s, 2 * MIN, 0, true), null);
  assert.equal(mapStep(s, 2 * MIN + MAP_IDLE_MS - 1, 0, true), null);
  // kurz wieder jemand da: Wartezeit beginnt neu
  assert.equal(mapStep(s, 3 * MIN, 1, true), null);
  assert.equal(mapStep(s, 4 * MIN, 0, true), null);
  assert.equal(mapStep(s, 4 * MIN + MAP_IDLE_MS, 0, true), 'start');
});

test('Karte: nach Serverneustart rendert BlueMap von selbst – bei Spielern wieder pausieren', () => {
  const s: MapState = { paused: true, emptySince: null };
  assert.equal(mapStep(s, 0, null, true), null);
  assert.equal(s.paused, false);
  assert.equal(mapStep(s, MIN, 1, true), 'stop');
});

test('Karte: abgeschaltet → einmal weiterrendern, sonst nichts', () => {
  const s: MapState = { paused: true, emptySince: null };
  assert.equal(mapStep(s, 0, 3, false), 'start');
  s.paused = false;
  assert.equal(mapStep(s, MIN, 3, false), null);
});

test('Spielmodus aus der RCON-Antwort', () => {
  assert.equal(parseGameMode('AfexRoX has the following entity data: 1'), 1);
  assert.equal(parseGameMode('No entity was found'), null);
});

test('Creative: laufender Abschnitt zählt nicht, abgeschlossener wandert in den Nullpunkt', () => {
  const start = { builder: 100, miner: 50 };
  const now = { builder: 400, miner: 60 };
  const players = [{ uuid: 'u', name: 'Steve', values: now }];
  const live = withOpenSessions(players, { u: { builder: 10 } }, { u: { name: 'Steve', start } });
  assert.equal(live.u.builder, 310);
  assert.equal(live.u.miner, 10);
  const closed = closeSession({ u: { builder: 10 } }, start, now, 'u');
  assert.equal(closed.u.builder, 310);
  // Datei älter als der Startpunkt (Absturz): nie negativ
  assert.equal(closeSession({}, start, { builder: 90 }, 'u').u.builder, 0);
});
