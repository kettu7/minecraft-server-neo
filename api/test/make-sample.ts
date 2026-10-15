// Erzeugt ein Beispielhaus als .litematic in ../testdaten (zum Ausprobieren ohne Spiel).
// Aufruf: node test/make-sample.ts
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildLitematic, type Block } from './fixtures.ts';

const palette: Block[] = [
  { Name: 'minecraft:air' },
  { Name: 'minecraft:cobblestone' },
  { Name: 'minecraft:oak_planks' },
  { Name: 'minecraft:oak_log', Properties: { axis: 'y' } },
  { Name: 'minecraft:glass_pane' },
  { Name: 'minecraft:oak_door', Properties: { half: 'lower', facing: 'south' } },
  { Name: 'minecraft:oak_door', Properties: { half: 'upper', facing: 'south' } },
  { Name: 'minecraft:spruce_slab', Properties: { type: 'bottom' } },
  { Name: 'minecraft:wall_torch', Properties: { facing: 'south' } },
];
const [AIR, COBBLE, PLANKS, LOG, GLASS, DOOR_L, DOOR_U, SLAB, TORCH] = palette.keys();

const size = { x: 9, y: 6, z: 7 };
const indices: number[] = [];
// Litematica-Reihenfolge: x läuft am schnellsten, dann z, dann y
for (let y = 0; y < size.y; y++)
  for (let z = 0; z < size.z; z++)
    for (let x = 0; x < size.x; x++) {
      const edgeX = x === 0 || x === size.x - 1;
      const edgeZ = z === 0 || z === size.z - 1;
      const corner = edgeX && edgeZ;
      let b = AIR;
      if (y === 0) b = COBBLE;
      else if (y === 5) b = SLAB;
      else if (y === 4) b = edgeX || edgeZ ? LOG : PLANKS;
      else if (corner) b = LOG;
      else if (edgeX || edgeZ) {
        if (z === 0 && x === 4) b = y === 1 ? DOOR_L : y === 2 ? DOOR_U : PLANKS;
        else if (y === 2 && (x === 2 || x === 6 || z === 3)) b = GLASS;
        else b = PLANKS;
      } else if (y === 3 && z === 1 && (x === 2 || x === 6)) b = TORCH;
      indices.push(b);
    }

const out = join(import.meta.dirname, '..', '..', 'testdaten');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'beispiel-haus.litematic'), buildLitematic('Beispielhaus', size, palette, indices));
console.log('geschrieben:', join(out, 'beispiel-haus.litematic'));
