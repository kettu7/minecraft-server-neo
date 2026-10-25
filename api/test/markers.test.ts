import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canEdit, parseMarker } from '../src/markers.ts';

test('Marker: gültige Eingabe wird bereinigt und gerundet', () => {
  assert.deepEqual(parseMarker({ name: '  Basis  von Kettu ', category: 'base', x: 120.6, y: '64', z: -300 }), {
    name: 'Basis  von Kettu', category: 'base', description: '', dimension: 'minecraft:overworld', x: 121, y: 64, z: -300,
  });
});

test('Marker: Fehler für fehlende oder falsche Angaben', () => {
  assert.equal(parseMarker({ category: 'base', x: 0, y: 0, z: 0 }), 'Bitte einen Namen eingeben.');
  assert.equal(parseMarker({ name: 'A', category: 'shop', x: 0, y: 0, z: 0 }), 'Bitte eine Kategorie wählen.');
  assert.equal(parseMarker({ name: 'A', category: 'farm', x: '', y: 0, z: 0 }), 'Bitte X, Y und Z als Zahlen angeben.');
  assert.equal(parseMarker({ name: 'A', category: 'farm', x: 40_000_000, y: 0, z: 0 }), 'Die Koordinaten liegen außerhalb der Welt.');
  assert.equal(parseMarker({ name: 'A', category: 'farm', dimension: 'minecraft:moon', x: 0, y: 0, z: 0 }), 'Unbekannte Dimension.');
});

test('Marker: ändern dürfen nur Ersteller und Admins', () => {
  assert.equal(canEdit({ id: 1, role: 'player' }, 1), true);
  assert.equal(canEdit({ id: 2, role: 'player' }, 1), false);
  assert.equal(canEdit({ id: 2, role: 'admin' }, 1), true);
  // Konto des Erstellers gelöscht: nur noch Admins
  assert.equal(canEdit({ id: 2, role: 'player' }, null), false);
});
