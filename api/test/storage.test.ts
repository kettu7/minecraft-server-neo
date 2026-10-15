import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSnbt } from '../src/snbt.ts';
import { parseBlockData, scanVolume } from '../src/storage.ts';
import { chunksOfBox } from '../src/world.ts';

test('SNBT: Zahlen mit Suffix, Strings, Listen, typisierte Arrays', () => {
  assert.deepEqual(
    parseSnbt(`{a: 1b, b: -2.5f, "c:d": 'it\\'s', e: [I; 1, 2], f: [], g: {}, h: minecraft:stone, i: 3L}`),
    { a: 1, b: -2.5, 'c:d': "it's", e: [1, 2], f: [], g: {}, h: 'minecraft:stone', i: 3 },
  );
});

test('Kiste mit losen Items und einer gefüllten Shulkerkiste', () => {
  const answer = '-10, 64, 5 has the following block data: {components: {"minecraft:custom_name": \'{"text":"Lager"}\'}, '
    + 'id: "minecraft:chest", Items: [{Slot: 0b, id: "minecraft:spruce_trapdoor", count: 12}, '
    + '{Slot: 1b, count: 1, id: "minecraft:white_shulker_box", components: {"minecraft:container": ['
    + '{slot: 0, item: {id: "minecraft:dark_oak_leaves", count: 64}}, {slot: 1, item: {id: "minecraft:dark_oak_leaves", count: 30}}]}}], '
    + 'x: -10, y: 64, z: 5}';

  assert.deepEqual(parseBlockData(answer), {
    type: 'chest',
    items: [
      { item: 'spruce_trapdoor', count: 12, inShulker: false },
      { item: 'white_shulker_box', count: 1, inShulker: true },
      { item: 'dark_oak_leaves', count: 64, inShulker: true },
      { item: 'dark_oak_leaves', count: 30, inShulker: true },
    ],
  });
});

test('Abgestellte Shulkerkiste und Fass; Inhalt einer abgestellten Shulker gilt als "in Shulker"', () => {
  assert.deepEqual(
    parseBlockData('1, 2, 3 has the following block data: {id: "minecraft:red_shulker_box", Items: [{Slot: 0b, id: "minecraft:stone", count: 5}]}'),
    { type: 'red_shulker_box', items: [{ item: 'stone', count: 5, inShulker: true }] },
  );
  assert.deepEqual(
    parseBlockData('1, 2, 3 has the following block data: {id: "minecraft:barrel", Items: []}'),
    { type: 'barrel', items: [] },
  );
});

test('Keine Behälter: normale Blöcke, Öfen, Trichter', () => {
  assert.equal(parseBlockData('The target block is not a block entity'), undefined);
  assert.equal(parseBlockData('0, 0, 0 has the following block data: {id: "minecraft:furnace", Items: []}'), undefined);
  assert.equal(parseBlockData('0, 0, 0 has the following block data: {id: "minecraft:hopper", Items: []}'), undefined);
});

test('Größe des Scanbereichs und betroffene Chunks', () => {
  assert.equal(scanVolume({ radius: 10, height: 3 }), 21 * 21 * 7);
  assert.deepEqual(chunksOfBox(-5, -5, 5, 5), [[-1, -1], [-1, 0], [0, -1], [0, 0]]);
});
