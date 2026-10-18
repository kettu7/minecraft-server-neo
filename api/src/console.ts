// Admin → Server: Konsole (Live-Log + Befehle über RCON) und Gamerules.
// Gamerules liegen in der Welt (level.dat) – sie überleben Neustarts und kollidieren nicht mit der Docker-Konfiguration.
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from './auth.ts';
import { audit } from './users.ts';
import { control, rcon } from './server-admin.ts';

const LOG_LINES = 300;
const MAX_COMMAND = 500;

/** Bekannte Vanilla-Gamerules (Namen seit 1.21.11 in snake_case). Mod-Gamerules kommen über „help gamerule“ dazu. */
export const VANILLA_GAMERULES = [
  'advance_time', 'advance_weather', 'allow_entering_nether_using_portals', 'block_drops', 'block_explosion_drop_decay',
  'command_block_output', 'command_blocks_work', 'drowning_damage', 'elytra_movement_check', 'ender_pearls_vanish_on_death',
  'entity_drops', 'fall_damage', 'fire_damage', 'fire_spread_radius_around_player', 'forgive_dead_players', 'freeze_damage',
  'global_sound_events', 'immediate_respawn', 'keep_inventory', 'lava_source_conversion', 'limited_crafting', 'locator_bar',
  'log_admin_commands', 'max_block_modifications', 'max_command_forks', 'max_command_sequence_length', 'max_entity_cramming',
  'max_snow_accumulation_height', 'mob_drops', 'mob_explosion_drop_decay', 'mob_griefing', 'natural_health_regeneration',
  'player_movement_check', 'players_nether_portal_creative_delay', 'players_nether_portal_default_delay',
  'players_sleeping_percentage', 'projectiles_can_break_blocks', 'pvp', 'raids', 'random_tick_speed', 'reduced_debug_info',
  'respawn_radius', 'send_command_feedback', 'show_advancement_messages', 'show_death_messages', 'spawn_mobs', 'spawn_monsters',
  'spawn_patrols', 'spawn_phantoms', 'spawn_wandering_traders', 'spawn_wardens', 'spawner_blocks_work',
  'spectators_generate_chunks', 'spread_vines', 'tnt_explodes', 'tnt_explosion_drop_decay', 'universal_anger',
  'water_source_conversion',
];

const RULE_ID = /^[a-z0-9_.-]+(:[a-z0-9_./-]+)?$/;

/** Farbcodes (§x) und ANSI-Steuerzeichen entfernen */
export const plain = (text: string) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/§[0-9a-fk-orx]/gi, '');

/** IP-Adressen im Log unkenntlich machen (Datenschutz – die Konsole braucht sie nicht).
 *  IPv6 nur mit mindestens drei Doppelpunkten – Uhrzeiten wie [10:03:15] bleiben stehen. */
export function maskIps(text: string) {
  return text
    .replace(/\/\[[0-9a-f:.%\w]+\](?::\d{1,5})?/gi, '/[•••]')
    .replace(/(?<![\w:])(?:[0-9a-f]{0,4}:){3,7}[0-9a-f]{0,4}(?:%\w+)?(?![\w:])/gi, '•••')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, '•••');
}

/** Rauschen ausblenden: jede Abfrage der Website öffnet eine RCON-Verbindung und erzeugt zwei Logzeilen */
export const isNoise = (line: string) => /\[RCON (Client|Listener)\b/.test(line);

/** „help gamerule“ → Liste der Regel-IDs (ohne doppelte „minecraft:“-Schreibweise) */
export function parseGameruleHelp(help: string): string[] {
  const ids = new Set<string>();
  for (const m of help.matchAll(/gamerule ([a-z0-9_.:/-]+)/g)) {
    const id = m[1].replace(/^minecraft:/, '');
    if (RULE_ID.test(id)) ids.add(id);
  }
  return [...ids];
}

/** „Game rule keep_inventory is currently set to false“ → 'false' */
export function parseGameruleValue(answer: string): string | null {
  return /currently set to:? (\S+)/i.exec(plain(answer))?.[1] ?? null;
}

type Rule = { id: string; value: boolean | number; type: 'boolean' | 'integer' };

async function readGamerules(): Promise<Rule[]> {
  const [help] = await rcon('help gamerule');
  const ids = [...new Set([...VANILLA_GAMERULES, ...parseGameruleHelp(help)])].sort();
  const answers = await rcon(...ids.map((id) => `gamerule ${id}`));
  const rules: Rule[] = [];
  ids.forEach((id, i) => {
    const raw = parseGameruleValue(answers[i]);
    if (raw === 'true' || raw === 'false') rules.push({ id, value: raw === 'true', type: 'boolean' });
    else if (raw !== null && /^-?\d+$/.test(raw)) rules.push({ id, value: Number(raw), type: 'integer' });
    // alles andere (unbekannte Regel, Fehlermeldung) wird übersprungen
  });
  return rules;
}

export async function registerConsole(app: FastifyInstance) {
  app.get('/api/server/console', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    try {
      const { logs } = (await control('GET', '/logs?tail=1000', 15_000)) as { logs: string };
      const lines = plain(logs).split('\n').filter((l) => l.trim() && !isNoise(l)).slice(-LOG_LINES);
      return { logs: maskIps(lines.join('\n')) };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.post<{ Body: { command?: string } }>('/api/server/command', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const command = (req.body?.command ?? '').trim().replace(/^\//, '');
    if (!command) return reply.code(400).send({ error: 'Bitte einen Befehl eingeben.' });
    if (command.length > MAX_COMMAND || /[\r\n]/.test(command)) return reply.code(400).send({ error: 'Befehl zu lang oder mehrzeilig.' });
    let answer: string;
    try {
      [answer] = await rcon(command);
    } catch (err) {
      return reply.code(502).send({ error: `Server nicht erreichbar: ${(err as Error).message}` });
    }
    audit(req.user!.id, 'konsole', command.slice(0, 200));
    return { command, answer: plain(answer) };
  });

  app.get('/api/server/gamerules', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    try {
      return { rules: await readGamerules() };
    } catch (err) {
      return reply.code(502).send({ error: `Server nicht erreichbar: ${(err as Error).message}` });
    }
  });

  app.post<{ Body: { id?: string; value?: boolean | number } }>('/api/server/gamerules', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = req.body?.id ?? '';
    const value = req.body?.value;
    if (!RULE_ID.test(id)) return reply.code(400).send({ error: 'Unbekannte Gamerule.' });
    if (typeof value !== 'boolean' && !(typeof value === 'number' && Number.isInteger(value))) {
      return reply.code(400).send({ error: 'Wert muss an/aus oder eine ganze Zahl sein.' });
    }
    let answer: string;
    try {
      [answer] = await rcon(`gamerule ${id} ${value}`);
    } catch (err) {
      return reply.code(502).send({ error: `Server nicht erreichbar: ${(err as Error).message}` });
    }
    if (!/(now|already) set to/i.test(plain(answer))) return reply.code(400).send({ error: plain(answer) || 'Gamerule nicht geändert.' });
    audit(req.user!.id, 'gamerule', `${id} = ${value}`);
    return { id, value };
  });
}
