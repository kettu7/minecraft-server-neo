// Ordnet Items den Tabs des Creative-Inventars zu. Minecraft legt die Tabs im Code fest, nicht in den Daten –
// darum eine Annäherung über Item-Tags, „ist ein Block“ und Namensmuster. Jedes Item bekommt genau einen Tab.
import { FOODS } from '../src/foods.ts';

export const TABS = ['building', 'colored', 'natural', 'functional', 'redstone', 'tools', 'combat', 'food', 'ingredients', 'spawn_eggs'] as const;
export type Tab = (typeof TABS)[number];

const COLORS = 'white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black';
const COLORED = new RegExp(`^(${COLORS})_(wool|carpet|terracotta|glazed_terracotta|concrete|concrete_powder|stained_glass|stained_glass_pane|bed|candle|banner|shulker_box|cushion|wool_(slab|stairs)|concrete_(slab|stairs))$`);
const re = (parts: string[]) => new RegExp(`^(${parts.join('|')})$`);

const COMBAT = re([
  '.*_sword', '.*_spear', 'bow', 'crossbow', 'shield', 'trident', 'mace', 'totem_of_undying', 'end_crystal', 'wind_charge', 'snowball',
  '.*_horse_armor', 'wolf_armor', '.*arrow', 'egg', 'blue_egg', 'brown_egg', 'tnt',
]);
const TOOLS = re([
  '.*_pickaxe', '.*_shovel', '.*_hoe', '.*_axe', 'shears', 'flint_and_steel', 'fire_charge', 'fishing_rod', '.*_on_a_stick',
  '(?!milk_).*bucket', 'compass', 'recovery_compass', 'clock', 'spyglass', 'lead', 'name_tag', 'saddle', '.*_harness',
  '.*_boat', '.*_raft', '.*minecart', 'music_disc_.*', 'map', 'writable_book', 'written_book', '.*bundle', 'brush',
  'ender_pearl', 'ender_eye', 'firework_rocket', 'bone_meal', 'elytra', 'goat_horn', 'experience_bottle',
]);
const REDSTONE = re([
  'redstone', 'repeater', 'comparator', 'piston', 'sticky_piston', 'observer', 'hopper', 'dropper', 'dispenser', 'crafter', 'lever',
  '.*_button', '.*_pressure_plate', 'tripwire_hook', 'daylight_detector', 'target', 'note_block', 'redstone_torch',
  'redstone_block', 'redstone_lamp', '.*rail', 'trapped_chest', '(calibrated_)?sculk_sensor', 'lightning_rod', '.*_bulb',
  'slime_block', 'honey_block', 'lectern', 'tnt',
]);
const FUNCTIONAL = re([
  'crafting_table', '(blast_)?furnace', 'smoker', 'chest', 'barrel', 'ender_chest', 'shulker_box', '.*anvil', 'enchanting_table',
  'brewing_stand', 'cauldron', 'grindstone', 'stonecutter', 'loom', 'cartography_table', 'fletching_table', 'smithing_table',
  'beacon', 'bell', '.*campfire', '.*torch', '.*lantern', '.*_sign', '.*_hanging_sign', 'beehive', 'bee_nest', 'chiseled_bookshelf',
  'jukebox', 'composter', 'respawn_anchor', 'lodestone', 'conduit', 'scaffolding', 'ladder', '(glow_)?item_frame', 'painting',
  'armor_stand', 'flower_pot', '.*_(head|skull)', 'candle', 'decorated_pot', 'vault', 'trial_spawner', 'spawner', '.*_shelf',
  '.*copper_chest', '.*_golem_statue', 'end_portal_frame', 'dragon_egg', 'suspicious_(sand|gravel)', 'chain', '.*_chain',
  'creaking_heart', 'heavy_core', 'crafting_table',
]);
const NATURAL = re([
  'grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'dirt_path', 'farmland', 'mud', 'clay', 'gravel', '(red_)?sand',
  'snow', 'snow_block', 'powder_snow_bucket', '(packed_|blue_)?ice', 'stone', 'deepslate', 'granite', 'diorite', 'andesite', 'tuff', 'calcite',
  'dripstone_block', 'pointed_dripstone', 'netherrack', '(crimson|warped)_nylium', 'soul_(sand|soil)', 'basalt', 'blackstone', 'end_stone',
  'obsidian', 'crying_obsidian', 'bedrock', 'magma_block', 'glowstone', 'amethyst_block', 'budding_amethyst', '.*amethyst_bud', 'amethyst_cluster',
  'sculk', 'sculk_vein', 'sculk_catalyst', 'sculk_shrieker', 'moss_block', 'moss_carpet', 'pale_moss_.*', '.*azalea.*', 'glow_lichen', 'cobweb',
  'vine', '(twisting|weeping|cave)_vines', 'lily_pad', 'seagrass', 'kelp', 'sea_pickle', '.*coral.*', 'sponge', 'wet_sponge',
  'sugar_cane', 'cactus', 'bamboo', 'pumpkin', 'carved_pumpkin', 'jack_o_lantern', 'melon', '.*_seeds', 'nether_wart', '(crimson|warped)_(fungus|roots)',
  'nether_sprouts', 'shroomlight', '.*mushroom.*', 'hanging_roots', 'mangrove_roots', 'muddy_mangrove_roots', 'spore_blossom', 'big_dripleaf',
  'small_dripleaf', 'frogspawn', 'turtle_egg', 'sniffer_egg', '.*_egg_block', 'bush', 'firefly_bush', '(short|tall)_.*grass', '.*fern', 'dead_bush',
  'leaf_litter', 'wildflowers', 'cactus_flower', 'pitcher_plant', 'torchflower', 'hay_block', 'bee_nest', 'honeycomb_block', 'resin_clump',
  'open_eyeblossom', 'closed_eyeblossom', 'chorus_(plant|flower)', 'cocoa_beans', 'glow_berries', 'sweet_berries',
]);

/** id ohne Namespace, isBlock = es gibt einen Block mit diesem Namen, tags = Item-Tags ohne Namespace */
export function creativeTab(id: string, isBlock: boolean, tags: Set<string>): Tab {
  if (id.endsWith('_spawn_egg')) return 'spawn_eggs';
  if (FOODS.has(id) || /^(milk_bucket|cake|ominous_bottle|(splash_|lingering_)?potion)$/.test(id)) return 'food';
  if (['swords', 'spears', 'head_armor', 'chest_armor', 'leg_armor', 'foot_armor', 'arrows', 'eggs'].some((t) => tags.has(t)) || COMBAT.test(id)) {
    return id === 'tnt' ? 'redstone' : 'combat';
  }
  if (['pickaxes', 'shovels', 'hoes', 'axes', 'boats', 'chest_boats', 'compasses', 'bundles', 'harnesses'].some((t) => tags.has(t)) || TOOLS.test(id)) return 'tools';
  if (tags.has('buttons') || tags.has('rails') || REDSTONE.test(id)) return 'redstone';
  if (COLORED.test(id)) return 'colored';
  if (!isBlock) return 'ingredients';
  if (['wool', 'wool_carpets', 'terracotta', 'glazed_terracotta', 'concrete', 'concrete_powders', 'beds', 'candles', 'banners', 'shulker_boxes'].some((t) => tags.has(t)) && id !== 'shulker_box' && id !== 'candle') {
    return 'colored';
  }
  if (tags.has('signs') || tags.has('hanging_signs') || tags.has('skulls') || tags.has('lanterns') || FUNCTIONAL.test(id)) return 'functional';
  if (/^(stripped_)/.test(id)) return 'building';
  if (['logs', 'leaves', 'saplings', 'flowers', 'small_flowers', 'mushrooms', 'dirt', 'sand', 'grass_blocks', 'moss_blocks', 'ores', 'mud'].some((t) => tags.has(t))
    || /_ore$/.test(id) || /^raw_.*_block$/.test(id) || NATURAL.test(id)) {
    return 'natural';
  }
  return 'building';
}
