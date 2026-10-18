import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNoise, maskIps, parseGameruleHelp, parseGameruleValue, plain } from '../src/console.ts';

test('IP-Adressen im Log werden unkenntlich', () => {
  assert.equal(
    maskIps('Steve[/203.0.113.7:54321] logged in with entity id 42'),
    'Steve[/•••] logged in with entity id 42',
  );
  assert.equal(maskIps('Alex[/[2001:db8::1]:51000] logged in'), 'Alex[/[•••]] logged in');
  assert.equal(maskIps('[10:03:15] [Server thread/INFO]: Done'), '[10:03:15] [Server thread/INFO]: Done');
  assert.equal(maskIps('RCON Client /0:0:0:0:0:0:0:1 started'), 'RCON Client /••• started');
  assert.equal(maskIps('Steve[/2001:db8:85a3::8a2e:370:7334] logged in'), 'Steve[/•••] logged in');
  assert.equal(maskIps('Version 1.21.11 bleibt'), 'Version 1.21.11 bleibt');
});

test('Gamerule-Hilfe: IDs ohne doppelte minecraft:-Schreibweise, Mod-Regeln bleiben', () => {
  const help = '/gamerule keep_inventory [<value>]/gamerule minecraft:keep_inventory [<value>]/gamerule universal_graves:protection_time [<value>]';
  assert.deepEqual(parseGameruleHelp(help), ['keep_inventory', 'universal_graves:protection_time']);
});

test('Gamerule-Wert aus der Antwort, Farbcodes entfernt', () => {
  assert.equal(parseGameruleValue('Game rule keep_inventory is currently set to false'), 'false');
  assert.equal(parseGameruleValue('Game rule random_tick_speed is currently set to 3'), '3');
  assert.equal(parseGameruleValue('Incorrect argument for command'), null);
  assert.equal(plain('§aGrün§r normal'), 'Grün normal');
});

test('RCON-Verbindungsmeldungen gelten als Rauschen', () => {
  assert.ok(isNoise('[10:03:15] [RCON Client /x #92/INFO]: Thread RCON Client /x shutting down'));
  assert.ok(isNoise('[10:03:15] [RCON Listener #1/INFO]: Thread RCON Client /x started'));
  assert.ok(!isNoise('[10:03:15] [Server thread/INFO]: Steve joined the game'));
});
