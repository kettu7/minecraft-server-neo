import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, rank, type PlayerStats } from '../src/stats.ts';

const value = (key: string, stats: PlayerStats) => CATEGORIES.find((c) => c.key === key)!.value(stats);

test('Baumeister zählt platzierte Blöcke, aber keine Werkzeuge oder Essen', () => {
  const stats = { 'minecraft:used': { 'minecraft:stone': 10, 'minecraft:diamond_pickaxe': 5, 'minecraft:bread': 3, 'minecraft:oak_door': 1 } };
  assert.equal(value('builder', stats), 11);
  assert.equal(value('glutton', stats), 3);
});

test('Strecken in km, Spielzeit in Stunden', () => {
  const stats = { 'minecraft:custom': { 'minecraft:walk_one_cm': 150_000, 'minecraft:sprint_one_cm': 50_000, 'minecraft:play_time': 144_000 } };
  assert.equal(value('traveler', stats), 2);
  assert.equal(value('gamer', stats), 2);
});

test('Rangliste sortiert absteigend, zieht den Nullpunkt ab und lässt Nullen weg', () => {
  const players = [
    { uuid: 'a', name: 'Anna', values: { unlucky: 5 } },
    { uuid: 'b', name: 'Ben', values: { unlucky: 8 } },
    { uuid: 'c', name: 'Cem', values: { unlucky: 2 } },
  ] as never;
  const deaths = rank(players, { b: { unlucky: 7 }, c: { unlucky: 2 } }).find((c) => c.key === 'unlucky')!;
  assert.deepEqual(deaths.players, [{ name: 'Anna', value: 5, place: 1 }, { name: 'Ben', value: 1, place: 2 }]);
});
