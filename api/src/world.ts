// Hilfen rund um die Welt: Chunks laden, damit auch ohne Spieler in der Nähe geprüft werden kann.
import type { Rcon } from './rcon.ts';

export const DIMENSIONS = ['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

type Chunk = [number, number];

const MAX_FORCED_CHUNKS = 64;

/** Chunks (16×16), die die Positionen berühren. */
export function chunksOf(positions: Iterable<{ x: number; z: number }>): Chunk[] {
  const keys = new Set<string>();
  for (const p of positions) keys.add(`${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`);
  return [...keys].map((k) => k.split(',').map(Number) as Chunk);
}

/** Chunks eines Quaders (ohne jede Position einzeln aufzuzählen). */
export function chunksOfBox(minX: number, minZ: number, maxX: number, maxZ: number): Chunk[] {
  const chunks: Chunk[] = [];
  for (let cx = Math.floor(minX / 16); cx <= Math.floor(maxX / 16); cx++)
    for (let cz = Math.floor(minZ / 16); cz <= Math.floor(maxZ / 16); cz++) chunks.push([cx, cz]);
  return chunks;
}

/**
 * Lädt nicht geladene Chunks per /forceload, führt fn aus und gibt danach nur die Chunks
 * wieder frei, die hier markiert wurden (bestehende Forceloads bleiben unangetastet).
 */
export async function withLoadedChunks<T>(rcon: Rcon, dim: Dimension, chunks: Chunk[], fn: () => Promise<T>): Promise<T> {
  const added: Chunk[] = [];
  try {
    if (chunks.length <= MAX_FORCED_CHUNKS) {
      for (const [cx, cz] of chunks) {
        const answer = await rcon.command(`execute in ${dim} run forceload query ${cx * 16} ${cz * 16}`);
        if (/not marked/i.test(answer)) {
          await rcon.command(`execute in ${dim} run forceload add ${cx * 16} ${cz * 16}`);
          added.push([cx, cz]);
        }
      }
      // Chunks laden asynchron: kurz warten, bis jeder antwortet
      for (const [cx, cz] of added) {
        for (let attempt = 0; attempt < 20; attempt++) {
          const probe = await rcon.command(`execute in ${dim} if block ${cx * 16} 0 ${cz * 16} minecraft:air`);
          if (!/not loaded/i.test(probe)) break;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    }
    return await fn();
  } finally {
    for (const [cx, cz] of added) {
      await rcon.command(`execute in ${dim} run forceload remove ${cx * 16} ${cz * 16}`).catch(() => undefined);
    }
  }
}
