import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addError, desiredWhitelistName, whitelistCommands } from '../src/whitelist.ts';
import { MINECRAFT_NAME } from '../src/users.ts';

test('Nur Spieler und Admins mit Minecraft-Namen gehören auf die Whitelist', () => {
  assert.equal(desiredWhitelistName('pending', 'Alex'), null);
  assert.equal(desiredWhitelistName('player', 'Alex'), 'Alex');
  assert.equal(desiredWhitelistName('admin', 'Alex'), 'Alex');
  assert.equal(desiredWhitelistName('player', null), null);
});

test('Whitelist-Befehle: hinzufügen, entfernen, umbenennen, nichts tun', () => {
  assert.deepEqual(whitelistCommands(null, 'Steve'), ['whitelist add Steve']);
  assert.deepEqual(whitelistCommands('Steve', null), ['whitelist remove Steve']);
  assert.deepEqual(whitelistCommands('Steve', 'Alex'), ['whitelist remove Steve', 'whitelist add Alex']);
  assert.deepEqual(whitelistCommands('Steve', 'steve'), []);
  assert.deepEqual(whitelistCommands(null, null), []);
});

test('Antworten von "whitelist add" auswerten', () => {
  assert.equal(addError('Added Steve to the whitelist'), undefined);
  assert.equal(addError('Player is already whitelisted'), undefined);
  assert.equal(addError('That player does not exist'), 'Minecraft-Name existiert nicht.');
});

test('Minecraft-Namen prüfen', () => {
  assert.ok(MINECRAFT_NAME.test('Alex'));
  assert.ok(MINECRAFT_NAME.test('a_b'));
  assert.ok(!MINECRAFT_NAME.test('ab'));
  assert.ok(!MINECRAFT_NAME.test('name with space'));
  assert.ok(!MINECRAFT_NAME.test('a'.repeat(17)));
});
