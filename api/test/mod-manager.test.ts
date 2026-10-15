import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dependentsOf, missingDependencies, modsFileContent, pendingChanges, type ManagedMod } from '../src/mod-manager.ts';

const mod = (projectId: string, title: string, extra: Partial<ManagedMod> = {}): ManagedMod => ({
  projectId, slug: title.toLowerCase(), title, description: '', hasIcon: false, clientSide: 'optional', serverSide: 'required',
  versionId: `${projectId}v1`, versionNumber: '1.0', versionType: 'release', versionPublished: '2026-01-01', requires: [],
  enabled: true, auto: false, note: '', addedBy: null, addedAt: '2026-01-01', ...extra,
});

const api = mod('P7dR8mSH', 'Fabric API');
const chunky = mod('fALzjamp', 'Chunky', { requires: ['P7dR8mSH'] });
const graves = mod('yn9u3ypm', 'Universal Graves', { requires: ['P7dR8mSH'] });

test('Mod-Datei: aktive Mods als Eintrag, deaktivierte als Kommentar, alphabetisch', () => {
  const text = modsFileContent([graves, { ...chunky, enabled: false }, api], 'Steve', new Date('2026-10-14T20:00:00Z'));
  const entries = text.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(entries, ['fabric:P7dR8mSH:P7dR8mSHv1', 'fabric:yn9u3ypm:yn9u3ypmv1']);
  assert.ok(text.includes('# [deaktiviert] Chunky 1.0\n# fabric:fALzjamp:fALzjampv1'));
  assert.ok(text.includes('(Steve)'));
  assert.ok(text.indexOf('Chunky') < text.indexOf('Fabric API'));
  // Zeilenumbrüche im Namen dürfen keine eigenen Einträge erzeugen
  const evil = modsFileContent([mod('AAAAAAAA', 'Böse\nfabric:XXXXXXXX:yyy')], 'x');
  assert.ok(!evil.split('\n').includes('fabric:XXXXXXXX:yyy'));
});

test('Geplante Änderungen gegenüber dem übernommenen Stand', () => {
  const applied = [api, chunky];
  const desired = [api, { ...chunky, enabled: false }, graves];
  assert.deepEqual(pendingChanges(desired, applied).map((c) => `${c.kind}:${c.title}`), ['disable:Chunky', 'add:Universal Graves']);
  const updated = [{ ...api, versionId: 'neu', versionNumber: '2.0' }];
  assert.deepEqual(pendingChanges(updated, applied).map((c) => `${c.kind}:${c.title}:${c.from ?? ''}>${c.to ?? ''}`), [
    'version:Fabric API:1.0>2.0',
    'remove:Chunky:>',
  ]);
  assert.deepEqual(pendingChanges(applied, applied), []);
});

test('Abhängigkeiten: wer braucht wen, was fehlt', () => {
  assert.deepEqual(dependentsOf([api, chunky, { ...graves, enabled: false }], api.projectId).map((m) => m.title), ['Chunky']);
  assert.deepEqual(missingDependencies([{ ...api, enabled: false }, chunky]), [{ mod: 'Chunky', needs: 'Fabric API' }]);
  assert.deepEqual(missingDependencies([graves]), [{ mod: 'Universal Graves', needs: 'P7dR8mSH' }]);
  assert.deepEqual(missingDependencies([api, chunky]), []);
});
