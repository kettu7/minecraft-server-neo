// Liest .litematic-Dateien (gzip-komprimiertes NBT) und zählt die benötigten Items.
import nbt from 'prismarine-nbt';
import { blockToItems, modernBlockId, type Props } from './items.ts';

type Long = [number, number]; // prismarine-nbt: [high, low]
type Vec = { x: number; y: number; z: number };

interface PaletteEntry { Name: string; Properties?: Props }
interface Region {
  Position: Vec;
  Size: Vec;
  BlockStatePalette: PaletteEntry[];
  BlockStates: Long[];
}
interface Root {
  Metadata?: { Name?: string; Author?: string; EnclosingSize?: Vec };
  Regions?: Record<string, Region>;
}

export interface Schematic {
  name: string;
  author: string;
  size: Vec;
  totalBlocks: number;
  /** Item-ID → benötigte Anzahl, absteigend sortiert */
  materials: Array<{ item: string; count: number }>;
}

/** Ein Block mit Position relativ zum Ursprung der Schematic. */
export interface SchematicBlock extends Vec {
  name: string;
  props: Props;
}

function toUint64(l: Long): bigint {
  return BigInt.asUintN(64, (BigInt(l[0]) << 32n) | (BigInt(l[1]) & 0xffffffffn));
}

/**
 * Litematica speichert Paletten-Indizes dicht gepackt: Ein Eintrag kann über
 * die Grenze zweier Longs hinausgehen (anders als Vanilla-Chunks seit 1.16).
 */
function decodeIndices(longs: Long[], paletteSize: number, volume: number): Uint32Array {
  const bits = BigInt(Math.max(2, Math.ceil(Math.log2(paletteSize))));
  const mask = (1n << bits) - 1n;
  const data = longs.map(toUint64);
  const result = new Uint32Array(volume);

  for (let i = 0; i < volume; i++) {
    const start = BigInt(i) * bits;
    const startIdx = Number(start >> 6n);
    const endIdx = Number((start + bits - 1n) >> 6n);
    const offset = start & 63n;
    let value = data[startIdx] >> offset;
    if (startIdx !== endIdx) value |= data[endIdx] << (64n - offset);
    result[i] = Number(value & mask);
  }
  return result;
}

async function readRoot(buffer: Buffer): Promise<Root> {
  const { parsed } = await nbt.parse(buffer);
  const root = nbt.simplify(parsed) as Root;
  if (!root.Regions) throw new Error('Keine gültige .litematic-Datei (Regions fehlt).');
  for (const region of Object.values(root.Regions)) {
    for (const entry of region.BlockStatePalette) entry.Name = modernBlockId(entry.Name);
  }
  return root;
}

function regionVolume(r: Region) {
  return Math.abs(r.Size.x * r.Size.y * r.Size.z);
}

export async function parseLitematic(buffer: Buffer): Promise<Schematic> {
  const root = await readRoot(buffer);
  const totals = new Map<string, number>();
  let totalBlocks = 0;

  for (const region of Object.values(root.Regions!)) {
    const palette = region.BlockStatePalette;
    const counts = new Array<number>(palette.length).fill(0);
    for (const index of decodeIndices(region.BlockStates, palette.length, regionVolume(region))) counts[index]++;

    palette.forEach((entry, index) => {
      const n = counts[index];
      if (!n) return;
      const items = blockToItems(entry.Name, entry.Properties);
      if (items.length) totalBlocks += n;
      for (const [item, perBlock] of items) {
        totals.set(item, (totals.get(item) ?? 0) + perBlock * n);
      }
    });
  }

  const meta = root.Metadata ?? {};
  return {
    name: meta.Name ?? 'Unbenannt',
    author: meta.Author ?? '',
    size: meta.EnclosingSize ?? { x: 0, y: 0, z: 0 },
    totalBlocks,
    materials: [...totals]
      .map(([item, count]) => ({ item, count }))
      .sort((a, b) => b.count - a.count || a.item.localeCompare(b.item)),
  };
}

/**
 * Liefert alle Blöcke, die ein Item benötigen (also ohne Luft, obere Türhälften …),
 * mit Position relativ zum Ursprung der Schematic.
 */
export async function readBlocks(buffer: Buffer): Promise<SchematicBlock[]> {
  const root = await readRoot(buffer);
  const blocks: SchematicBlock[] = [];

  for (const region of Object.values(root.Regions!)) {
    const { Position: pos, Size: size, BlockStatePalette: palette } = region;
    const sx = Math.abs(size.x), sy = Math.abs(size.y), sz = Math.abs(size.z);
    // Negative Größen: Die Region erstreckt sich von Position aus in die negative Richtung
    const min = {
      x: pos.x + (size.x < 0 ? size.x + 1 : 0),
      y: pos.y + (size.y < 0 ? size.y + 1 : 0),
      z: pos.z + (size.z < 0 ? size.z + 1 : 0),
    };
    const relevant = palette.map((e) => blockToItems(e.Name, e.Properties).length > 0);
    const indices = decodeIndices(region.BlockStates, palette.length, sx * sy * sz);

    // Reihenfolge in der Datei: x läuft am schnellsten, dann z, dann y
    for (let i = 0; i < indices.length; i++) {
      const p = indices[i];
      if (!relevant[p]) continue;
      const x = i % sx, z = Math.floor(i / sx) % sz, y = Math.floor(i / (sx * sz));
      blocks.push({ x: min.x + x, y: min.y + y, z: min.z + z, name: palette[p].Name, props: palette[p].Properties ?? {} });
    }
  }
  return blocks;
}
