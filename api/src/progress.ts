// Prüft über RCON, welche Blöcke einer Schematic in der Welt schon stehen.
import { blockToItems } from './items.ts';
import type { SchematicBlock } from './litematic.ts';
import type { Rcon } from './rcon.ts';
import { chunksOf, withLoadedChunks, type Dimension } from './world.ts';

export { DIMENSIONS } from './world.ts';
export const ROTATIONS = ['NONE', 'CLOCKWISE_90', 'CLOCKWISE_180', 'COUNTERCLOCKWISE_90'] as const;
export const MIRRORS = ['NONE', 'LEFT_RIGHT', 'FRONT_BACK'] as const;

export interface Placement {
  x: number;
  y: number;
  z: number;
  rotation: (typeof ROTATIONS)[number];
  mirror: (typeof MIRRORS)[number];
  dimension: Dimension;
}

export interface ProgressResult {
  checked: number;
  placed: number;
  unloaded: number;
  /** Item-ID → verbaute Anzahl */
  placedItems: Map<string, number>;
}

// RCON prüft Block für Block; darüber dauert es zu lange (dann lohnt sich eine Server-Mod)
const MAX_BLOCKS = 20_000;

/** Wie Litematica: erst spiegeln, dann drehen, dann an den Ursprung verschieben. */
export function toWorld(b: { x: number; y: number; z: number }, p: Placement) {
  let { x, z } = b;
  if (p.mirror === 'LEFT_RIGHT') z = -z;
  if (p.mirror === 'FRONT_BACK') x = -x;
  switch (p.rotation) {
    case 'CLOCKWISE_90': [x, z] = [-z, x]; break;
    case 'CLOCKWISE_180': [x, z] = [-x, -z]; break;
    case 'COUNTERCLOCKWISE_90': [x, z] = [z, -x]; break;
  }
  return { x: p.x + x, y: p.y + b.y, z: p.z + z };
}

/**
 * Geprüft wird nur die Block-ID (Ausrichtung, Verbindungen usw. bleiben außen vor),
 * außer bei doppelten Stufen, die zwei Items zählen.
 */
function blockPredicate(b: SchematicBlock): string {
  if (b.name.endsWith('_slab') && b.props.type === 'double') return `${b.name}[type=double]`;
  return b.name;
}

export async function checkProgress(rcon: Rcon, blocks: SchematicBlock[], placement: Placement): Promise<ProgressResult> {
  if (blocks.length > MAX_BLOCKS) {
    throw new Error(`Die Schematic hat ${blocks.length} Blöcke; die RCON-Prüfung schafft höchstens ${MAX_BLOCKS}.`);
  }
  const result: ProgressResult = { checked: 0, placed: 0, unloaded: 0, placedItems: new Map() };
  const dim = placement.dimension;
  const world = blocks.map((b) => ({ block: b, at: toWorld(b, placement) }));

  await withLoadedChunks(rcon, dim, chunksOf(world.map((w) => w.at)), async () => {
    for (const { block: b, at: w } of world) {
      const answer = await rcon.command(`execute in ${dim} if block ${w.x} ${w.y} ${w.z} ${blockPredicate(b)}`);
      result.checked++;
      if (/passed/i.test(answer)) {
        result.placed++;
        for (const [item, n] of blockToItems(b.name, b.props)) {
          result.placedItems.set(item, (result.placedItems.get(item) ?? 0) + n);
        }
      } else if (/not loaded/i.test(answer)) {
        result.unloaded++;
      } else if (!/failed/i.test(answer)) {
        throw new Error(`Unerwartete Antwort vom Server: ${answer}`);
      }
    }
  });
  return result;
}
