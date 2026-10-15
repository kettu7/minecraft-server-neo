import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBlocks } from '../src/litematic.ts';
import { toWorld, type Placement } from '../src/progress.ts';
import { buildLitematic } from './fixtures.ts';

const at = (p: Partial<Placement>): Placement =>
  ({ x: 100, y: 64, z: -50, rotation: 'NONE', mirror: 'NONE', dimension: 'minecraft:overworld', ...p });

test('readBlocks liefert Positionen in Litematica-Reihenfolge (x, dann z, dann y) ohne Luft', async () => {
  // 2×2×2: nur zwei Blöcke gesetzt
  const indices = [1, 0, 0, 0, 0, 0, 0, 2]; // (0,0,0) Stein, (1,1,1) Erde
  const file = buildLitematic('Würfel', { x: 2, y: 2, z: 2 }, [
    { Name: 'minecraft:air' }, { Name: 'minecraft:stone' }, { Name: 'minecraft:dirt' },
  ], indices);

  const blocks = await readBlocks(file);
  assert.deepEqual(blocks.map(({ x, y, z, name }) => ({ x, y, z, name })), [
    { x: 0, y: 0, z: 0, name: 'minecraft:stone' },
    { x: 1, y: 1, z: 1, name: 'minecraft:dirt' },
  ]);
});

test('toWorld: Drehung und Spiegelung wie Litematica', () => {
  const b = { x: 2, y: 1, z: 3 };
  assert.deepEqual(toWorld(b, at({})), { x: 102, y: 65, z: -47 });
  assert.deepEqual(toWorld(b, at({ rotation: 'CLOCKWISE_90' })), { x: 97, y: 65, z: -48 });
  assert.deepEqual(toWorld(b, at({ rotation: 'CLOCKWISE_180' })), { x: 98, y: 65, z: -53 });
  assert.deepEqual(toWorld(b, at({ rotation: 'COUNTERCLOCKWISE_90' })), { x: 103, y: 65, z: -52 });
  assert.deepEqual(toWorld(b, at({ mirror: 'FRONT_BACK' })), { x: 98, y: 65, z: -47 });
  assert.deepEqual(toWorld(b, at({ mirror: 'LEFT_RIGHT' })), { x: 102, y: 65, z: -53 });
});
