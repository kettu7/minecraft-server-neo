import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLitematic } from '../src/litematic.ts';
import { blockToItems, splitAmount } from '../src/items.ts';
import { buildLitematic, type Block } from './fixtures.ts';

test('zählt Blöcke aus einer Litematic-Datei und rechnet Sonderfälle um', async () => {
  const palette: Block[] = [
    { Name: 'minecraft:air' },
    { Name: 'minecraft:oak_planks' },
    { Name: 'minecraft:oak_door', Properties: { half: 'lower' } },
    { Name: 'minecraft:oak_door', Properties: { half: 'upper' } },
    { Name: 'minecraft:stone_slab', Properties: { type: 'double' } },
    { Name: 'minecraft:wall_torch', Properties: { facing: 'north' } },
  ];
  // 5×5×5 = 125 Blöcke; 6 Paletteneinträge → 3 Bit, Werte gehen über Long-Grenzen
  const indices = Array.from({ length: 125 }, (_, i) => {
    if (i < 100) return 1;      // 100 Planken
    if (i < 103) return 2;      // 3 Türen unten
    if (i < 106) return 3;      // 3 Türen oben → nicht zählen
    if (i < 110) return 4;      // 4 doppelte Stufen → 8 Stufen
    if (i < 112) return 5;      // 2 Wandfackeln → Fackeln
    return 0;                   // Luft
  });

  const result = await parseLitematic(buildLitematic('Testhaus', { x: 5, y: 5, z: 5 }, palette, indices));

  assert.equal(result.name, 'Testhaus');
  assert.deepEqual(result.materials, [
    { item: 'oak_planks', count: 100 },
    { item: 'stone_slab', count: 8 },
    { item: 'oak_door', count: 3 },
    { item: 'torch', count: 2 },
  ]);
});

test('Sonderfälle bei der Item-Umrechnung', () => {
  assert.deepEqual(blockToItems('minecraft:potted_poppy'), [['flower_pot', 1], ['poppy', 1]]);
  assert.deepEqual(blockToItems('minecraft:oak_wall_sign'), [['oak_sign', 1]]);
  assert.deepEqual(blockToItems('minecraft:red_bed', { part: 'head' }), []);
  assert.deepEqual(blockToItems('minecraft:redstone_wire', { power: '0' }), [['redstone', 1]]);
  assert.deepEqual(blockToItems('minecraft:snow', { layers: '3' }), [['snow', 3]]);
  assert.deepEqual(blockToItems('minecraft:water', { level: '3' }), []);
  assert.deepEqual(blockToItems('minecraft:cobblestone_wall'), [['cobblestone_wall', 1]]);
});

test('teilt Mengen in Shulker, Stacks und Rest', () => {
  assert.deepEqual(splitAmount(3240, 'stone'), { shulkers: 1, stacks: 23, items: 40, stackSize: 64 });
  assert.deepEqual(splitAmount(20, 'oak_sign'), { shulkers: 0, stacks: 1, items: 4, stackSize: 16 });
});
