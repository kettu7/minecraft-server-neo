import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plannedAt } from '../src/auto-restart.ts';

const H = 3_600_000;
const M = 60_000;

test('Neustart nach X Stunden Laufzeit', () => {
  assert.equal(plannedAt(0, 24, 2 * H), 24 * H);
});

test('überfällig oder kurz davor: erst nach allen Ankündigungen (15 Min.)', () => {
  assert.equal(plannedAt(0, 6, 10 * H), 10 * H + 15 * M);
  assert.equal(plannedAt(0, 6, 6 * H - 5 * M), 6 * H + 10 * M);
});
