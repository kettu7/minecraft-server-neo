import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notificationsFor, notify } from '../src/notifications.ts';
import { changesBetween, describePackChange, type PackSnapshot } from '../src/modpack.ts';

const snap = (files: Array<[string, string, string]>, minecraft = '26.3'): PackSnapshot => ({
  hash: files.map((f) => f.join()).join(';'), minecraft, files: files.map(([id, title, sha1]) => ({ id, title, sha1 })),
});

test('Modpack-Änderung: neu, aktualisiert, entfernt', () => {
  const before = snap([['a', 'Sodium', '1'], ['b', 'Iris', '1'], ['c', 'Chunky', '1']]);
  const after = snap([['a', 'Sodium', '2'], ['b', 'Iris', '1'], ['d', 'Litematica', '1']]);
  assert.equal(describePackChange(before, after),
    'Neu: Litematica. Aktualisiert: Sodium. Entfernt: Chunky. Bitte das Modpack neu herunterladen.');
});

test('Modpack: nur Pflicht/optional getauscht – keine Meldung', () => {
  const s = snap([['a', 'Sodium', '1']]);
  assert.equal(describePackChange(s, { ...s, hash: 'anders' }), null);
});

test('Modpack: lange Listen werden gekürzt, Minecraft-Version wird genannt', () => {
  const before = snap([], '26.2');
  const after = snap([['a', 'A', '1'], ['b', 'B', '1'], ['c', 'C', '1'], ['d', 'D', '1'], ['e', 'E', '1']]);
  assert.equal(describePackChange(before, after),
    'Jetzt für Minecraft 26.3. Neu: A, B, C und 2 weitere. Bitte das Modpack neu herunterladen.');
});

test('Benachrichtigungen: Zielgruppe und Anmeldedatum', () => {
  const marker = `Test ${Date.now()}`;
  notify({ title: `${marker} alle`, createdAt: new Date(Date.now() - 60_000) });
  notify({ title: `${marker} admin`, audience: 'admin', createdAt: new Date(Date.now() - 60_000) });
  notify({ title: `${marker} alt`, createdAt: new Date(Date.now() - 10 * 86400_000) });
  const seen = (role: 'player' | 'admin', createdAt: string) =>
    notificationsFor({ id: 999_999, role, createdAt }).map((n) => n.title).filter((t) => t.startsWith(marker)).sort();

  const longAgo = '2020-01-01 00:00:00';
  assert.deepEqual(seen('player', longAgo), [`${marker} alle`, `${marker} alt`]);
  assert.deepEqual(seen('admin', longAgo), [`${marker} admin`, `${marker} alle`, `${marker} alt`]);
  // Konto erst vor 2 Tagen angelegt: die 10 Tage alte Meldung sieht es nicht
  const twoDaysAgo = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
  assert.deepEqual(seen('player', twoDaysAgo), [`${marker} alle`]);
});

test('Modpack-Seite: Neu, Aktualisiert und Entfernt gegenüber dem vorigen Stand', () => {
  const before: PackSnapshot = { ...snap([['a', 'Sodium', '1'], ['c', 'Chunky', '1']]), version: '1.4' };
  before.files[1].mode = 'optional';
  const after = snap([['a', 'Sodium', '2'], ['d', 'Litematica', '1']]);
  assert.deepEqual(changesBetween(before, after), {
    since: '1.4', added: ['d'], updated: ['a'], removed: [{ title: 'Chunky', mode: 'optional', kind: 'mod' }],
  });
  assert.deepEqual(changesBetween(undefined, after).added, []);
});
