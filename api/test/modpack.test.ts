import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packIndex, resolvePack, serverPackMode, type PackSource } from '../src/modpack.ts';

const src = (projectId: string, title: string, extra: Partial<PackSource> = {}): PackSource => ({
  projectId, title, kind: 'mod', source: 'client', mode: 'required', locked: false, requires: [], ...extra,
});

test('Server-Mods im Pack: Pflicht, wenn Spieler ihn brauchen; nie, wenn nur Server', () => {
  assert.deepEqual(serverPackMode('required', 'excluded'), { mode: 'required', locked: true });
  assert.deepEqual(serverPackMode('unsupported', 'required'), { mode: 'excluded', locked: true });
  assert.deepEqual(serverPackMode('optional', 'auto'), { mode: 'excluded', locked: false });
  assert.deepEqual(serverPackMode('optional', 'optional'), { mode: 'optional', locked: false });
});

test('Benötigte Mods kommen automatisch ins Pack, Pflicht vererbt sich', () => {
  const api = src('API', 'Fabric API', { source: 'server', mode: 'excluded' });
  const malilib = src('MALI', 'MaLiLib', { mode: 'optional' });
  const litematica = src('LITE', 'Litematica', { requires: ['MALI', 'API'] });
  const shader = src('IRIS', 'Iris', { mode: 'optional', requires: ['API'] });
  const { entries, problems } = resolvePack([api, malilib, litematica, shader]);
  assert.equal(entries.get('API')?.mode, 'required');
  assert.match(entries.get('API')?.reason ?? '', /gebraucht von/);
  assert.equal(entries.get('MALI')?.mode, 'required');
  assert.equal(entries.get('IRIS')?.mode, 'optional');
  assert.deepEqual(problems, []);

  // Nur optionale Nutzer: Abhängigkeit bleibt optional
  const only = resolvePack([src('API', 'Fabric API', { mode: 'excluded' }), shader]);
  assert.equal(only.entries.get('API')?.mode, 'optional');

  // Abhängigkeit fehlt ganz
  assert.equal(resolvePack([src('X', 'X', { requires: ['FEHLT'] })]).problems.length, 1);
  // Ausgeschlossenes zieht nichts nach
  assert.equal(resolvePack([src('X', 'X', { mode: 'excluded', requires: ['FEHLT'] })]).entries.size, 0);
});

test('modrinth.index.json: Pfade je Art, Pflicht/optional, Abhängigkeiten', () => {
  const file = (name: string) => ({ url: `https://cdn.modrinth.com/data/x/${name}`, filename: name, sha1: 'a'.repeat(40), sha512: 'b'.repeat(128), size: 10 });
  const index = packIndex({ version: '1.3', minecraft: '26.3', loader: '0.19.5' }, [
    { kind: 'shader', mode: 'optional', file: file('complementary.zip') },
    { kind: 'mod', mode: 'required', file: file('sodium.jar') },
    { kind: 'resourcepack', mode: 'optional', file: file('faithful.zip') },
  ]);
  assert.equal(index.formatVersion, 1);
  assert.equal(index.versionId, '1.3');
  assert.deepEqual(index.dependencies, { minecraft: '26.3', 'fabric-loader': '0.19.5' });
  assert.deepEqual(index.files.map((f) => `${f.path}:${f.env.client}`), [
    'mods/sodium.jar:required', 'resourcepacks/faithful.zip:optional', 'shaderpacks/complementary.zip:optional',
  ]);
  assert.equal(index.files[0].env.server, 'unsupported');
});

test('Shader zieht Iris nach; optional bleibt optional', () => {
  const iris = src('YL57xq9U', 'Iris', { mode: 'excluded', requires: ['SODIUM'] });
  const sodium = src('SODIUM', 'Sodium', { mode: 'excluded' });
  const shader = src('COMP', 'Complementary', { kind: 'shader', mode: 'optional', requires: ['YL57xq9U'] });
  const { entries } = resolvePack([iris, sodium, shader]);
  assert.equal(entries.get('YL57xq9U')?.mode, 'optional');
  assert.equal(entries.get('SODIUM')?.mode, 'optional');
});
