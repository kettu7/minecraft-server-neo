// Übersetzt Blockzustände aus einer Schematic in die Items, die man zum Bauen braucht.
// Orientiert sich an Litematicas Materialliste.

export type Props = Record<string, string>;

/** Blöcke, die man nicht als Item platziert (oder die von selbst entstehen). */
const IGNORED = new Set([
  'air', 'cave_air', 'void_air', 'piston_head', 'moving_piston', 'fire', 'soul_fire',
  'nether_portal', 'end_portal', 'end_gateway', 'bubble_column', 'frosted_ice', 'light',
]);

/** Block-ID → Item-ID, wo sie sich unterscheiden. */
const RENAMED: Record<string, string> = {
  redstone_wire: 'redstone',
  tripwire: 'string',
  wheat: 'wheat_seeds',
  carrots: 'carrot',
  potatoes: 'potato',
  beetroots: 'beetroot_seeds',
  melon_stem: 'melon_seeds',
  attached_melon_stem: 'melon_seeds',
  pumpkin_stem: 'pumpkin_seeds',
  attached_pumpkin_stem: 'pumpkin_seeds',
  torchflower_crop: 'torchflower_seeds',
  pitcher_crop: 'pitcher_pod',
  cocoa: 'cocoa_beans',
  sweet_berry_bush: 'sweet_berries',
  cave_vines: 'glow_berries',
  cave_vines_plant: 'glow_berries',
  kelp_plant: 'kelp',
  twisting_vines_plant: 'twisting_vines',
  weeping_vines_plant: 'weeping_vines',
  bamboo_sapling: 'bamboo',
  big_dripleaf_stem: 'big_dripleaf',
  tall_seagrass: 'seagrass',
  farmland: 'dirt',
  dirt_path: 'dirt',
  powder_snow: 'powder_snow_bucket',
  water: 'water_bucket',
  lava: 'lava_bucket',
};

/** Blöcke, deren Anzahl in einer Eigenschaft steckt (z. B. 3 Kerzen auf einem Block). */
const COUNT_PROPERTY: Record<string, string> = {
  snow: 'layers',
  sea_pickle: 'pickles',
  turtle_egg: 'eggs',
  pink_petals: 'flower_amount',
  wildflowers: 'flower_amount',
  leaf_litter: 'segment_amount',
};

const WALL_VARIANT = /_wall_(torch|sign|hanging_sign|banner|head|skull|fan)$/;

function stripNamespace(id: string): string {
  return id.startsWith('minecraft:') ? id.slice('minecraft:'.length) : id;
}

/**
 * Von Mojang umbenannte Blöcke: Schematics aus älteren Versionen enthalten noch den alten Namen,
 * den der Server nicht mehr kennt („Unknown block type“).
 */
export const LEGACY_BLOCKS: Record<string, string> = {
  grass_path: 'dirt_path', // 1.17
  grass: 'short_grass', // 1.20.3
  chain: 'iron_chain', // 1.21.9 (seitdem gibt es auch Kupferketten)
};

/** Alter Blockname → heutiger, mit Namespace wie in der Schematic */
export function modernBlockId(id: string): string {
  const renamed = LEGACY_BLOCKS[stripNamespace(id)];
  return renamed ? `minecraft:${renamed}` : id;
}

/** Liefert die Items (mit Anzahl), die für genau einen Block dieses Zustands nötig sind. */
export function blockToItems(blockId: string, props: Props = {}): Array<[string, number]> {
  const id = stripNamespace(blockId);
  if (IGNORED.has(id)) return [];

  // Flüssigkeiten: nur Quellblöcke zählen
  if ((id === 'water' || id === 'lava') && props.level !== undefined && props.level !== '0') return [];

  // Zweiteilige Blöcke (Türen, hohe Pflanzen, Betten) nur einmal zählen
  if (props.half === 'upper') return [];
  if (id.endsWith('_bed') && props.part === 'head') return [];

  // Topfpflanzen: Blumentopf + Pflanze
  if (id.startsWith('potted_')) return [['flower_pot', 1], [id.slice('potted_'.length), 1]];

  // Kerzen auf Kuchen: Kuchen + Kerze
  if (id === 'candle_cake') return [['cake', 1], ['candle', 1]];
  if (id.endsWith('_candle_cake')) return [['cake', 1], [id.replace(/_cake$/, ''), 1]];

  // Wandvarianten (Wandfackel → Fackel, Wandschild → Schild …)
  if (id === 'wall_torch') return [['torch', 1]];
  if (WALL_VARIANT.test(id)) return [[id.replace('_wall_', '_'), 1]];

  // Doppelte Stufen bestehen aus zwei Stufen
  if (id.endsWith('_slab') && props.type === 'double') return [[id, 2]];

  if (id.endsWith('candle') && props.candles) return [[id, Number(props.candles)]];
  const countProp = COUNT_PROPERTY[id];
  if (countProp && props[countProp]) return [[id, Number(props[countProp])]];

  return [[RENAMED[id] ?? id, 1]];
}

/** Maximale Stapelgröße eines Items (Standard 64). */
export function stackSize(item: string): number {
  if (item.endsWith('_bed') || (item.endsWith('_bucket') && item !== 'bucket')) return 1;
  if (item.endsWith('_sign') || item.endsWith('_banner') || item === 'bucket') return 16;
  if (['snowball', 'egg', 'ender_pearl', 'honey_bottle', 'armor_stand'].includes(item)) return 16;
  if (item === 'cake' || item.endsWith('shulker_box')) return 1;
  return 64;
}

/** Zerlegt eine Menge in Shulkerkisten, Stacks und Rest (eine Shulkerkiste fasst 27 Stacks). */
export function splitAmount(count: number, item: string) {
  const stack = stackSize(item);
  const perShulker = stack * 27;
  const shulkers = Math.floor(count / perShulker);
  const rest = count - shulkers * perShulker;
  return { shulkers, stacks: Math.floor(rest / stack), items: rest % stack, stackSize: stack };
}
