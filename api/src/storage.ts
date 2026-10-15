// Scannt einen Lagerbereich über RCON: findet Behälter und liest ihren Inhalt aus.
import type { Rcon } from './rcon.ts';
import { parseSnbt, type SnbtValue } from './snbt.ts';
import { chunksOfBox, withLoadedChunks, type Dimension } from './world.ts';

export interface StorageArea {
  x: number;
  y: number;
  z: number;
  /** horizontal, in X und Z */
  radius: number;
  /** nach oben und unten */
  height: number;
  dimension: Dimension;
}

export interface StockEntry {
  item: string;
  count: number;
  /** liegt in einer Shulkerkiste (oder ist selbst eine) – per Schalter ausblendbar */
  inShulker: boolean;
}

export interface ContainerContent {
  x: number;
  y: number;
  z: number;
  type: string;
  items: StockEntry[];
}

export interface ScanResult {
  containers: ContainerContent[];
  positions: number;
  unloaded: number;
}

export const MAX_SCAN_POSITIONS = 20_000;
export const MAX_RADIUS = 32;
export const MAX_HEIGHT = 16;

export function scanVolume(a: Pick<StorageArea, 'radius' | 'height'>) {
  return (2 * a.radius + 1) ** 2 * (2 * a.height + 1);
}

const strip = (id: string) => id.replace(/^minecraft:/, '');
const isShulker = (id: string) => strip(id).endsWith('shulker_box');

export function isContainer(blockEntityId: string): boolean {
  const id = strip(blockEntityId);
  return id === 'chest' || id === 'trapped_chest' || id === 'barrel' || isShulker(id);
}

type Obj = { [key: string]: SnbtValue };
const asObj = (v: SnbtValue | undefined): Obj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
const asList = (v: SnbtValue | undefined): SnbtValue[] => (Array.isArray(v) ? v : []);

/** Zieht alle Items aus einer Items-Liste, inklusive Inhalt von Shulkerkisten (auch verschachtelt). */
export function extractItems(list: SnbtValue[], inShulker: boolean, out: StockEntry[] = []): StockEntry[] {
  for (const raw of list) {
    const stack = asObj(raw);
    if (!stack || typeof stack.id !== 'string') continue;
    const count = Number(stack.count ?? stack.Count ?? 1);
    out.push({ item: strip(stack.id), count, inShulker: inShulker || isShulker(stack.id) });

    if (isShulker(stack.id)) {
      // Seit 1.20.5: components."minecraft:container" = [{slot, item: {id, count}}]
      const content = asList(asObj(stack.components)?.['minecraft:container']).map((e) => asObj(e)?.item ?? e);
      // Ältere Welten: tag.BlockEntityTag.Items
      const legacy = asList(asObj(asObj(asObj(stack.tag)?.BlockEntityTag))?.Items);
      extractItems([...content, ...legacy], true, out);
    }
  }
  return out;
}

/** Wertet die Antwort von "/data get block x y z" aus; undefined = kein (zählbarer) Behälter. */
export function parseBlockData(answer: string): { type: string; items: StockEntry[] } | undefined {
  const start = answer.indexOf('{');
  if (start < 0) return undefined;
  const data = asObj(parseSnbt(answer.slice(start)));
  const id = typeof data?.id === 'string' ? data.id : '';
  if (!isContainer(id)) return undefined;
  return { type: strip(id), items: extractItems(asList(data!.Items), isShulker(id)) };
}

export async function scanStorage(rcon: Rcon, a: StorageArea): Promise<ScanResult> {
  const positions = scanVolume(a);
  if (positions > MAX_SCAN_POSITIONS) {
    throw new Error(`Bereich zu groß (${positions} Positionen, höchstens ${MAX_SCAN_POSITIONS}). Radius oder Höhe verkleinern.`);
  }
  const result: ScanResult = { containers: [], positions, unloaded: 0 };
  const chunks = chunksOfBox(a.x - a.radius, a.z - a.radius, a.x + a.radius, a.z + a.radius);

  await withLoadedChunks(rcon, a.dimension, chunks, async () => {
    for (let y = a.y - a.height; y <= a.y + a.height; y++)
      for (let x = a.x - a.radius; x <= a.x + a.radius; x++)
        for (let z = a.z - a.radius; z <= a.z + a.radius; z++) {
          const answer = await rcon.command(`execute in ${a.dimension} run data get block ${x} ${y} ${z}`);
          if (/not loaded/i.test(answer)) { result.unloaded++; continue; }
          const container = parseBlockData(answer);
          if (container) result.containers.push({ x, y, z, ...container });
        }
  });
  return result;
}
