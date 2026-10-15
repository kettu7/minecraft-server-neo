import { gzipSync } from 'node:zlib';
import nbt from 'prismarine-nbt';

export type Block = { Name: string; Properties?: Record<string, string> };
type Vec = { x: number; y: number; z: number };

/** Baut eine .litematic-Datei mit dicht gepackten Paletten-Indizes (wie Litematica). */
export function buildLitematic(name: string, size: Vec, palette: Block[], indices: number[]): Buffer {
  const bits = BigInt(Math.max(2, Math.ceil(Math.log2(palette.length))));
  const longs = new Array<bigint>(Math.ceil((indices.length * Number(bits)) / 64)).fill(0n);
  indices.forEach((value, i) => {
    const start = BigInt(i) * bits;
    const idx = Number(start >> 6n);
    const offset = start & 63n;
    longs[idx] = BigInt.asUintN(64, longs[idx] | (BigInt(value) << offset));
    if (offset + bits > 64n) longs[idx + 1] |= BigInt(value) >> (64n - offset);
  });
  // prismarine-nbt erwartet Longs als [high, low]; die mitgelieferten Typen kennen das nicht
  const asPairs = longs.map((l) => [Number(BigInt.asIntN(32, l >> 32n)), Number(BigInt.asIntN(32, l))]) as never;

  const vec = (v: Vec) => nbt.comp({ x: nbt.int(v.x), y: nbt.int(v.y), z: nbt.int(v.z) });
  const block = (b: Block) => ({
    Name: nbt.string(b.Name),
    ...(b.Properties ? { Properties: nbt.comp(Object.fromEntries(Object.entries(b.Properties).map(([k, v]) => [k, nbt.string(v)]))) } : {}),
  });

  const root = nbt.comp({
    Version: nbt.int(7),
    Metadata: nbt.comp({ Name: nbt.string(name), Author: nbt.string('Neo-Test'), EnclosingSize: vec(size) }),
    Regions: nbt.comp({
      main: nbt.comp({
        Position: vec({ x: 0, y: 0, z: 0 }),
        Size: vec(size),
        BlockStatePalette: { type: 'list', value: { type: 'compound', value: palette.map(block) } } as never,
        BlockStates: nbt.longArray(asPairs),
      }),
    }),
  });
  return gzipSync(nbt.writeUncompressed(root as never));
}
