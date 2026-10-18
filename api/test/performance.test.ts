import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpuPercent, parseTickQuery } from '../src/performance.ts';
import { opResult } from '../src/ops.ts';

const NORMAL = 'The game is running normallyTarget tick rate: 20.0 per second.\n\u001b[0mAverage time per tick: 3.0ms (Target: 50.0ms)Percentiles: P50: 0.9ms P95: 5.1ms P99: 50.2ms. Sample: 100';

test('Tick-Abfrage: Zeit pro Tick, P95 und TPS', () => {
  assert.deepEqual(parseTickQuery(NORMAL), { target: 20, mspt: 3, p95: 5.1, tps: 20, state: 'normal' });
});

test('langsame Ticks senken die TPS', () => {
  const slow = NORMAL.replace('3.0ms (Target', '80.0ms (Target');
  assert.equal(parseTickQuery(slow).tps, 12.5);
});

test('CPU-Anteil aus zwei Zählerständen', () => {
  assert.equal(cpuPercent({ total: 1_000, system: 10_000 }, { total: 3_000, system: 20_000, cpus: 4 }), 20);
  assert.equal(cpuPercent(null, { total: 1, system: 1, cpus: 1 }), null);
});

test('Antworten von /op und /deop', () => {
  assert.equal(opResult('Made Actrazz a server operator'), 'ok');
  assert.equal(opResult('Made Actrazz no longer a server operator'), 'ok');
  assert.equal(opResult('Nothing changed. The player is already an operator'), 'unchanged');
  assert.equal(opResult('That player does not exist'), 'error');
});
