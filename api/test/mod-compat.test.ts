import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { findConflicts, readFabricMeta, satisfies, type FabricMeta } from '../src/mod-compat.ts';

test('Versionsbereiche nach Fabric-Regeln', () => {
  assert.equal(satisfies('0.165.0+26.3', '>=0.161.0 <0.162.0'), false);
  assert.equal(satisfies('0.161.4+26.3', '>=0.161.0 <0.162.0'), true);
  assert.equal(satisfies('0.165.0+26.3', '>=0.160.0'), true);
  assert.equal(satisfies('0.165.0', '*'), true);
  assert.equal(satisfies('26.3', '~26.3'), true);
  assert.equal(satisfies('26.4', '~26.3'), false);
  assert.equal(satisfies('3.4.1', '^3.0.0'), true);
  assert.equal(satisfies('4.0.0', '^3.0.0'), false);
  assert.equal(satisfies('0.161.7', '0.161.x'), true);
  assert.equal(satisfies('0.162.0', '0.161.x'), false);
  // Liste = eine Alternative reicht
  assert.equal(satisfies('26.3', ['26.2', '26.3']), true);
  // Vorabversion liegt vor der fertigen
  assert.equal(satisfies('1.0.0-beta.2', '>=1.0.0'), false);
  // Nicht auswertbar → keine Aussage statt falschem Alarm
  assert.equal(satisfies('build-abc', '>=1.0.0'), null);
});

const meta = (id: string, version: string, depends: FabricMeta['depends'] = {}, extra: Partial<FabricMeta> = {}): FabricMeta =>
  ({ mods: [{ id, version, provides: [] }], depends, breaks: {}, environment: '*', ...extra });

test('Seamless Crafting mit zu neuer Fabric API wird erkannt', () => {
  const problems = findConflicts([
    { title: 'Fabric API', meta: meta('fabric-api', '0.165.0+26.3') },
    { title: 'Seamless Crafting', meta: meta('seamless_crafting', '2.1.1+mc26.3', { 'fabric-api': '>=0.161.0 <0.162.0', minecraft: '26.3' }) },
  ], { minecraft: '26.3', loader: '0.20.1' });
  assert.deepEqual(problems, ['Seamless Crafting braucht Fabric API >=0.161.0 <0.162.0, geplant ist 0.165.0+26.3.']);
});

test('Minecraft, Loader, breaks; Client-Mods und fehlende Angaben werden nicht bemängelt', () => {
  const problems = findConflicts([
    { title: 'Alt', meta: meta('alt', '1.0', { minecraft: '~26.2' }) },
    { title: 'Neu', meta: meta('neu', '1.0', { fabricloader: '>=0.21.0' }) },
    { title: 'Streit', meta: meta('streit', '1.0', {}, { breaks: { neu: '*' } }) },
    { title: 'Nur Client', meta: meta('client', '1.0', { minecraft: '26.1' }, { environment: 'client' }) },
    { title: 'Unbekannt', meta: null },
    { title: 'Braucht Fehlendes', meta: meta('x', '1.0', { gibtsnicht: '*' }) },
  ], { minecraft: '26.3', loader: '0.20.1' });
  assert.deepEqual(problems, [
    'Alt braucht Minecraft ~26.2, geplant ist 26.3.',
    'Neu braucht Fabric Loader >=0.21.0, geplant ist 0.20.1.',
    'Streit verträgt sich nicht mit Neu 1.0.',
  ]);
});

test('fabric.mod.json lesen, auch mitgelieferte Mods (Jar in Jar)', () => {
  const inner = new AdmZip();
  inner.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ id: 'fabric-api-base', version: '1.0.5' })));
  const outer = new AdmZip();
  outer.addFile('fabric.mod.json', Buffer.from(JSON.stringify({
    id: 'fabric-api', version: '0.165.0+26.3', depends: { fabricloader: '>=0.18.0' },
    description: 'Zeilen\numbruch im Text', jars: [{ file: 'META-INF/jars/base.jar' }],
  })));
  outer.addFile('META-INF/jars/base.jar', inner.toBuffer());
  const m = readFabricMeta(outer.toBuffer())!;
  assert.deepEqual(m.mods.map((x) => x.id), ['fabric-api', 'fabric-api-base']);
  assert.deepEqual(m.depends, { fabricloader: '>=0.18.0' });
});
