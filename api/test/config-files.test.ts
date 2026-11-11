import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configProblem, keepLineEndings, ownerOf, safeConfigPath } from '../src/config-files.ts';

test('Pfade: nur Dateien unter config/, keine Ausbrüche', () => {
  assert.equal(safeConfigPath('polymer/auto-host.json'), 'polymer/auto-host.json');
  assert.equal(safeConfigPath('lithium.properties'), 'lithium.properties');
  for (const bad of ['', '../server.properties', 'a/../b.json', '/etc/passwd', 'a\\b.json', '.hidden.json', 'a/.git/x.json', 'a//b.json', 'mod.jar', 'mod', 'a\0.json']) {
    assert.equal(safeConfigPath(bad), null, bad);
  }
  assert.equal(safeConfigPath(42), null);
});

test('Formatprüfung nach Endung', () => {
  assert.equal(configProblem('a.json', '{"a": 1}'), null);
  assert.match(configProblem('a.json', '{"a": 1,}')!, /Kein gültiges JSON/);
  assert.equal(configProblem('a.json5', '{ a: 1, /* Kommentar */ }'), null);
  assert.match(configProblem('a.json5', '{ a: ')!, /JSON5/);
  assert.equal(configProblem('a.toml', 'key = "wert"\n[tabelle]\nzahl = 3'), null);
  assert.match(configProblem('a.toml', 'key = ')!, /TOML/);
  // Ohne Formatvorgabe wird nichts bemängelt
  assert.equal(configProblem('a.properties', 'irgendwas ohne gleichheitszeichen'), null);
  assert.match(configProblem('a.txt', 'a\0b')!, /ungültige Zeichen/);
});

test('Zeilenenden bleiben erhalten', () => {
  assert.equal(keepLineEndings('a\r\nb\r\n', 'a\nc\n'), 'a\r\nc\r\n');
  assert.equal(keepLineEndings('a\nb\n', 'a\nc\n'), 'a\nc\n');
  assert.equal(keepLineEndings('a\r\nb', 'a\r\nc'), 'a\r\nc');
});

test('Zuordnung der Dateien zu Mods', () => {
  const owners = [
    { key: 'polymer', ref: 'Polymer' },
    { key: 'seamless-crafting', ref: 'Seamless Crafting' },
    { key: 'seamless_lib', ref: 'SeamlessLib' },
    { key: 'fabric', ref: 'Fabric' },
    { key: 'fabric-api', ref: 'Fabric API' },
  ];
  assert.equal(ownerOf('polymer/auto-host.json', owners), 'Polymer');
  assert.equal(ownerOf('polymer.json', owners), 'Polymer');
  // Unterstrich und Bindestrich gelten gleich, auch ohne Trennzeichen
  assert.equal(ownerOf('seamless_crafting.json5', owners), 'Seamless Crafting');
  assert.equal(ownerOf('seamlesslib.toml', owners), 'SeamlessLib');
  assert.equal(ownerOf('polymer-client.toml', owners), 'Polymer');
  // Längster Name gewinnt
  assert.equal(ownerOf('fabric-api-extras.json', owners), 'Fabric API');
  // Keine Teilwörter: "polymers" ist nicht "polymer"
  assert.equal(ownerOf('polymers.json', owners), null);
  assert.equal(ownerOf('unbekannt.json', owners), null);
  // Zu kurze Namen werden nicht geraten
  assert.equal(ownerOf('ab.json', [{ key: 'ab', ref: 'x' }]), null);
});
