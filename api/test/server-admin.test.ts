import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlayerList, tellraw } from '../src/server-admin.ts';

test('Spielerliste aus "list" lesen', () => {
  assert.deepEqual(parsePlayerList('There are 2 of a max of 20 players online: Steve, Alex'), { online: 2, max: 20, names: ['Steve', 'Alex'] });
  assert.deepEqual(parsePlayerList('There are 0 of a max of 20 players online: '), { online: 0, max: 20, names: [] });
});

test('Ansagen: gültiges JSON, keine Zeilenumbrüche, Anführungszeichen maskiert', () => {
  const cmd = tellraw('Hallo "alle"\nzweite Zeile');
  assert.ok(cmd.startsWith('tellraw @a '));
  const json = JSON.parse(cmd.slice('tellraw @a '.length));
  assert.equal(json[1].text, 'Hallo "alle" zweite Zeile');
  assert.ok(!cmd.includes('\n'));
});

import { detectImageType } from '../src/project-images.ts';

test('Bildtyp an den ersten Bytes erkennen', () => {
  assert.equal(detectImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'binary')), 'image/webp');
  assert.equal(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(detectImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
  assert.equal(detectImageType(Buffer.from('<svg onload=alert(1)>')), undefined);
  assert.equal(detectImageType(Buffer.from('GIF89a')), undefined);
});

import { contentDisposition } from '../src/download-name.ts';

test('Dateiname für den Download: Umlaute, Sonderzeichen, Endung', () => {
  assert.equal(contentDisposition('haus.litematic'), `attachment; filename="haus.litematic"; filename*=UTF-8''haus.litematic`);
  assert.equal(contentDisposition('Großes Haus'), `attachment; filename="Gro_es Haus.litematic"; filename*=UTF-8''Gro%C3%9Fes%20Haus.litematic`);
  assert.equal(contentDisposition(String.raw`a/b\c".litematic`), `attachment; filename="a_b_c_.litematic"; filename*=UTF-8''a_b_c_.litematic`);
});

import { newerGameVersions } from '../src/mods.ts';

test('Mods: neuere Minecraft-Versionen', () => {
  const tags = [
    { version: '26.3', version_type: 'release' as const, date: '2026-09-15T11:23:02Z' },
    { version: '26.4-snapshot-1', version_type: 'snapshot' as const, date: '2026-09-22T13:38:53Z' },
    { version: '26.3-rc-1', version_type: 'snapshot' as const, date: '2026-09-10T11:28:25Z' },
    { version: '26.4', version_type: 'release' as const, date: '2026-12-01T10:00:00Z' },
    { version: 'b1.7.3', version_type: 'beta' as const, date: '2011-07-08T00:00:00Z' },
  ];
  assert.deepEqual(newerGameVersions(tags, '26.3').map((v) => v.version), ['26.4', '26.4-snapshot-1']);
  assert.deepEqual(newerGameVersions(tags, '26.4'), []);
  assert.deepEqual(newerGameVersions(tags, 'unbekannt'), []);
});
