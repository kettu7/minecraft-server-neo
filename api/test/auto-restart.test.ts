import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextOccurrence } from '../src/auto-restart.ts';

const at = (iso: string) => new Date(iso);

test('nächster Termin heute, wenn die Uhrzeit noch kommt', () => {
  assert.equal(nextOccurrence('05:00', at('2026-10-17T03:00:00')).toString(), at('2026-10-17T05:00:00').toString());
});

test('Uhrzeit schon vorbei: morgen', () => {
  assert.equal(nextOccurrence('05:00', at('2026-10-17T09:00:00')).toString(), at('2026-10-18T05:00:00').toString());
});

test('weniger als 15 Minuten vorher: erst morgen, damit alle Ankündigungen rausgehen', () => {
  assert.equal(nextOccurrence('05:00', at('2026-10-17T04:50:00')).toString(), at('2026-10-18T05:00:00').toString());
});

test('Zeitumstellung: Termin bleibt bei 05:00 Ortszeit', () => {
  const next = nextOccurrence('05:00', at('2026-10-24T12:00:00'));
  assert.equal(next.getHours(), 5);
  assert.equal(next.getDate(), 25);
});
