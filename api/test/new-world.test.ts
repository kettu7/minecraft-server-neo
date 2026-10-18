import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEED } from '../src/new-world.ts';
import { cleanWorldName, currentWorldName, setWorldName } from '../src/world-name.ts';

test('Weltname wird bereinigt und gespeichert', () => {
  assert.equal(cleanWorldName('  Neue   Welt\n2 '), 'Neue Welt 2');
  assert.equal(cleanWorldName('   '), null);
  assert.equal(cleanWorldName(42), null);
  const before = currentWorldName();
  setWorldName('Testwelt');
  assert.equal(currentWorldName(), 'Testwelt');
  setWorldName(before);
});

test('Seeds: Zahlen und Wörter erlaubt, nichts was server.properties kaputt macht', () => {
  assert.ok(SEED.test(''));
  assert.ok(SEED.test('-123456789'));
  assert.ok(SEED.test('Bambuswald 2'));
  assert.ok(!SEED.test('a=b'));
  assert.ok(!SEED.test('zeile\numbruch'));
  assert.ok(!SEED.test('x'.repeat(65)));
});
