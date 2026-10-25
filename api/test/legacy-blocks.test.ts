import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockToItems, modernBlockId } from '../src/items.ts';

test('Alte Blocknamen aus älteren Schematics werden übersetzt', () => {
  assert.equal(modernBlockId('minecraft:chain'), 'minecraft:iron_chain');
  assert.equal(modernBlockId('minecraft:grass'), 'minecraft:short_grass');
  assert.equal(modernBlockId('minecraft:grass_path'), 'minecraft:dirt_path');
  // Heutige Namen bleiben, wie sie sind
  assert.equal(modernBlockId('minecraft:iron_chain'), 'minecraft:iron_chain');
  assert.equal(modernBlockId('minecraft:grass_block'), 'minecraft:grass_block');
});

test('Materialliste nutzt den heutigen Item-Namen', () => {
  assert.deepEqual(blockToItems(modernBlockId('minecraft:chain'), { axis: 'y' }), [['iron_chain', 1]]);
  assert.deepEqual(blockToItems(modernBlockId('minecraft:grass_path')), [['dirt', 1]]);
});
