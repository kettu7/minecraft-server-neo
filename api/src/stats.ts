// Rangliste fürs Dashboard aus den Spieler-Statistiken von Minecraft (world/players/stats/<uuid>.json).
// Minecraft schreibt die Dateien beim Autosave (alle 5 Min.) und beim Ausloggen.
// „Zurücksetzen“ löscht nichts: es merkt sich die aktuellen Werte als Nullpunkt und zieht sie künftig ab.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from './auth.ts';
import { audit } from './users.ts';
import { getState, setState } from './mod-manager.ts';
import { FOODS } from './foods.ts';

const MC_DATA_DIR = process.env.MC_DATA_DIR ?? '';
const TOP = 10;
const CACHE_MS = 60_000;

type StatGroup = Record<string, number>;
export type PlayerStats = Record<string, StatGroup>;


/** „Benutzt“, aber kein Block: Werkzeuge, Waffen, Rüstung, Wurfgeschosse, Eimer, Tränke usw. */
const NOT_A_BLOCK = new RegExp('^(' + [
  '.*_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots|bucket|spawn_egg|boat|raft|minecart|dye|horse_armor|harness)',
  'music_disc_.*', '.*_banner_pattern', '.*_bundle', '.*_on_a_stick',
  'bow', 'crossbow', 'trident', 'mace', 'shield', 'elytra', 'shears', 'flint_and_steel', 'fishing_rod', 'brush', 'spyglass',
  'ender_pearl', 'ender_eye', 'snowball', 'egg', 'blue_egg', 'brown_egg', 'potion', 'splash_potion', 'lingering_potion',
  'experience_bottle', 'glass_bottle', 'firework_rocket', 'fire_charge', 'wind_charge', 'bone_meal', 'name_tag', 'lead',
  'saddle', 'totem_of_undying', 'goat_horn', 'bundle', 'written_book', 'writable_book', 'map', 'filled_map', 'compass',
  'recovery_compass', 'clock', 'arrow', 'spectral_arrow', 'tipped_arrow', 'turtle_helmet', 'wolf_armor',
].join('|') + ')$');

const sum = (group: StatGroup | undefined, keep: (id: string) => boolean = () => true) =>
  Object.entries(group ?? {}).reduce((a, [id, n]) => (keep(id.replace(/^minecraft:/, '')) ? a + n : a), 0);
const custom = (s: PlayerStats, key: string) => s['minecraft:custom']?.[`minecraft:${key}`] ?? 0;

export interface Category { key: string; title: string; caption: string; unit: string; value: (s: PlayerStats) => number }

/** Reihenfolge = Reihenfolge im Karussell */
export const CATEGORIES: Category[] = [
  { key: 'builder', title: 'Baumeister', caption: 'Meiste Blöcke platziert', unit: 'Blöcke',
    value: (s) => sum(s['minecraft:used'], (id) => !NOT_A_BLOCK.test(id) && !FOODS.has(id)) },
  { key: 'miner', title: 'Bergarbeiter', caption: 'Meiste Blöcke abgebaut', unit: 'Blöcke', value: (s) => sum(s['minecraft:mined']) },
  { key: 'diamonds', title: 'Diamantfieber', caption: 'Meiste Diamanten abgebaut', unit: 'Erze',
    value: (s) => sum(s['minecraft:mined'], (id) => id === 'diamond_ore' || id === 'deepslate_diamond_ore') },
  { key: 'hunter', title: 'Monsterjäger', caption: 'Meiste Mobs getötet', unit: 'Mobs', value: (s) => custom(s, 'mob_kills') },
  { key: 'traveler', title: 'Weltenbummler', caption: 'Weiteste Strecke zu Fuß', unit: 'km',
    value: (s) => (custom(s, 'walk_one_cm') + custom(s, 'sprint_one_cm') + custom(s, 'crouch_one_cm')) / 100_000 },
  { key: 'swimmer', title: 'Wasserratte', caption: 'Weiteste Strecke geschwommen', unit: 'km',
    value: (s) => (custom(s, 'swim_one_cm') + custom(s, 'walk_under_water_one_cm')) / 100_000 },
  { key: 'trader', title: 'Händler', caption: 'Meiste Villager-Trades', unit: 'Trades', value: (s) => custom(s, 'traded_with_villager') },
  { key: 'glutton', title: 'Vielfraß', caption: 'Meiste Essen gegessen', unit: 'Portionen',
    value: (s) => sum(s['minecraft:used'], (id) => FOODS.has(id)) + custom(s, 'eat_cake_slice') },
  { key: 'blaster', title: 'Sprengmeister', caption: 'Meiste TNT platziert', unit: 'TNT',
    value: (s) => sum(s['minecraft:used'], (id) => id === 'tnt' || id === 'tnt_minecart') },
  { key: 'gamer', title: 'Dauerzocker', caption: 'Meiste Spielzeit', unit: 'Std.', value: (s) => custom(s, 'play_time') / 72_000 },
  { key: 'unlucky', title: 'Pechvogel', caption: 'Meiste Tode', unit: 'Tode', value: (s) => custom(s, 'deaths') },
];

export interface RankingSettings { enabled: boolean }
interface Baseline { resetAt: string; values: Record<string, Record<string, number>> }
const SETTINGS = 'ranking';
const BASELINE = 'ranking_baseline';
/** Beispiel-Spieler zum Ansehen der Ranglisten; „Zurücksetzen“ entfernt sie */
const DUMMY = 'ranking_dummy';
const DUMMY_SEEDED = 'ranking_dummy_seeded';

type RankedPlayer = { uuid: string; name: string; values: Record<string, number> };

/** Erfundene Namen – keine echten Spieler */
const DUMMY_NAMES = ['BlockBaron', 'KieselKönigin', 'RedstoneRalf', 'Pixelpilz', 'EnderEmma', 'GlowstoneGabi', 'Schleimlord', 'TorfTom', 'NetherNina'];
/** typische Größenordnung je Kategorie (Platz 1 ungefähr) */
const DUMMY_SCALE: Record<string, number> = {
  builder: 42_000, miner: 65_000, diamonds: 180, hunter: 2_400, traveler: 310, swimmer: 24, trader: 520,
  glutton: 1_300, blaster: 140, gamer: 160, unlucky: 85,
};

/** Reproduzierbare Zufallswerte, damit die Beispieldaten nach jedem Neustart gleich sind */
export function dummyPlayers(): RankedPlayer[] {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647);
  return DUMMY_NAMES.map((name, i) => ({
    uuid: `dummy-${i}`,
    name,
    values: Object.fromEntries(Object.entries(DUMMY_SCALE).map(([key, max]) => {
      const v = max * (0.15 + 0.85 * rnd());
      return [key, max < 1_000 ? Math.round(v * 10) / 10 : Math.round(v)];
    })),
  }));
}

export const rankingSettings = (): RankingSettings => ({ enabled: getState<RankingSettings>(SETTINGS)?.enabled !== false });

/** Alle Spieler: UUID → Name und berechnete Werte je Kategorie */
async function readPlayers(): Promise<Array<{ uuid: string; name: string; values: Record<string, number> }>> {
  if (!MC_DATA_DIR) return [];
  const names = new Map<string, string>();
  const cache = await readFile(join(MC_DATA_DIR, 'usercache.json'), 'utf8').then((t) => JSON.parse(t) as Array<{ uuid: string; name: string }>, () => []);
  for (const e of cache) names.set(e.uuid, e.name);

  // Neuere Versionen: world/players/stats, ältere: world/stats
  const dirs = [join(MC_DATA_DIR, 'world', 'players', 'stats'), join(MC_DATA_DIR, 'world', 'stats')];
  const players = new Map<string, RankedPlayer & { mtime: number }>();
  for (const dir of dirs) {
    const files = await readdir(dir).catch(() => [] as string[]);
    for (const file of files.filter((f) => f.endsWith('.json'))) {
      const uuid = file.slice(0, -5);
      const name = names.get(uuid);
      if (!name) continue;
      const path = join(dir, file);
      const mtime = await stat(path).then((s) => s.mtimeMs, () => 0);
      const known = players.get(name.toLowerCase());
      if (known && known.mtime >= mtime) continue;
      const stats = await readFile(path, 'utf8').then((t) => (JSON.parse(t).stats ?? {}) as PlayerStats, () => null);
      if (!stats) continue;
      players.set(name.toLowerCase(), { uuid, name, mtime, values: Object.fromEntries(CATEGORIES.map((c) => [c.key, c.value(stats)])) });
    }
  }
  return [...players.values()].map(({ mtime: _m, ...p }) => p);
}

/** Top-Liste je Kategorie, abzüglich Nullpunkt; Spieler mit 0 erscheinen nicht */
export function rank(
  players: Array<{ uuid: string; name: string; values: Record<string, number> }>,
  baseline: Baseline['values'] = {},
) {
  return CATEGORIES.map((c) => {
    const all = players
      .map((p) => ({ name: p.name, value: Math.max(0, p.values[c.key] - (baseline[p.uuid]?.[c.key] ?? 0)) }))
      .filter((p) => p.value > 0)
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
    return { key: c.key, title: c.title, caption: c.caption, unit: c.unit, players: all.map((p, i) => ({ ...p, place: i + 1 })) };
  });
}

let cached: { at: number; value: ReturnType<typeof rank> } | null = null;
async function rankings(fresh = false) {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = rank([...(await readPlayers()), ...(getState<RankedPlayer[]>(DUMMY) ?? [])], getState<Baseline>(BASELINE)?.values);
  cached = { at: Date.now(), value };
  return value;
}

export async function registerStats(app: FastifyInstance) {
  // Einmalig Beispiel-Spieler anlegen, damit die Ranglisten gleich nach etwas aussehen
  if (!getState<boolean>(DUMMY_SEEDED)) {
    setState(DUMMY, dummyPlayers());
    setState(DUMMY_SEEDED, true);
  }

  // Für alle Mitglieder: Top 10 je Kategorie plus der eigene Platz
  app.get('/api/rankings', async (req) => {
    const settings = rankingSettings();
    if (!settings.enabled) return { enabled: false, categories: [] };
    const me = req.user?.minecraftName?.toLowerCase();
    const categories = (await rankings()).map((c) => ({
      ...c,
      players: c.players.slice(0, TOP),
      me: me ? c.players.find((p) => p.name.toLowerCase() === me) ?? null : null,
    }));
    return { enabled: true, resetAt: getState<Baseline>(BASELINE)?.resetAt ?? null, categories };
  });

  app.get('/api/rankings/settings', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { ...rankingSettings(), resetAt: getState<Baseline>(BASELINE)?.resetAt ?? null };
  });

  app.post<{ Body: Partial<RankingSettings> }>('/api/rankings/settings', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const enabled = req.body?.enabled === true;
    setState(SETTINGS, { enabled });
    audit(req.user!.id, enabled ? 'rangliste eingeblendet' : 'rangliste ausgeblendet');
    return { ...rankingSettings(), resetAt: getState<Baseline>(BASELINE)?.resetAt ?? null };
  });

  // Nullpunkt setzen: alle Ranglisten beginnen bei 0, die Statistiken im Spiel bleiben unberührt
  app.post('/api/rankings/reset', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const players = await readPlayers();
    const baseline: Baseline = { resetAt: new Date().toISOString(), values: Object.fromEntries(players.map((p) => [p.uuid, p.values])) };
    setState(BASELINE, baseline);
    setState(DUMMY, []); // Beispiel-Spieler verschwinden beim Zurücksetzen
    cached = null;
    audit(req.user!.id, 'rangliste zurückgesetzt');
    return { ...rankingSettings(), resetAt: baseline.resetAt };
  });
}
