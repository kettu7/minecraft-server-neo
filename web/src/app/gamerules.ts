/** Deutsche Beschreibung der Vanilla-Gamerules; unbekannte (z. B. von Mods) erscheinen unter „Mods & Weitere“ mit ihrer ID */
export interface GameruleInfo { label: string; hint?: string; group: GameruleGroup; default: boolean | number }

export const GAMERULE_GROUPS = ['Spieler', 'Welt & Zeit', 'Mobs', 'Drops & Explosionen', 'Technik', 'Mods & Weitere'] as const;
export type GameruleGroup = (typeof GAMERULE_GROUPS)[number];

export const GAMERULES: Record<string, GameruleInfo> = {
  // Spieler
  keep_inventory: { group: 'Spieler', label: 'Inventar behalten', hint: 'Nach dem Tod bleiben Items und Erfahrung erhalten.', default: false },
  immediate_respawn: { group: 'Spieler', label: 'Sofort wiederbeleben', hint: 'Ohne Todesbildschirm.', default: false },
  pvp: { group: 'Spieler', label: 'PvP', hint: 'Spieler können sich gegenseitig Schaden zufügen.', default: true },
  natural_health_regeneration: { group: 'Spieler', label: 'Natürliche Regeneration', hint: 'Leben füllt sich bei vollem Hunger auf.', default: true },
  fall_damage: { group: 'Spieler', label: 'Fallschaden', default: true },
  fire_damage: { group: 'Spieler', label: 'Feuerschaden', default: true },
  drowning_damage: { group: 'Spieler', label: 'Ertrinken', default: true },
  freeze_damage: { group: 'Spieler', label: 'Erfrieren', hint: 'Schaden im Pulverschnee.', default: true },
  players_sleeping_percentage: { group: 'Spieler', label: 'Schlafen überspringt die Nacht ab', hint: 'Anteil der Spieler in Prozent, die im Bett liegen müssen.', default: 100 },
  show_death_messages: { group: 'Spieler', label: 'Todesnachrichten im Chat', default: true },
  show_advancement_messages: { group: 'Spieler', label: 'Fortschritte im Chat', default: true },
  locator_bar: { group: 'Spieler', label: 'Ortungsleiste', hint: 'Zeigt die Richtung anderer Spieler.', default: true },
  respawn_radius: { group: 'Spieler', label: 'Spawn-Radius', hint: 'Streuung um den Weltspawn in Blöcken.', default: 10 },
  ender_pearls_vanish_on_death: { group: 'Spieler', label: 'Enderperlen verschwinden beim Tod', default: true },
  reduced_debug_info: { group: 'Spieler', label: 'Reduzierte Debug-Infos', hint: 'Blendet Koordinaten im F3-Menü aus.', default: false },
  limited_crafting: { group: 'Spieler', label: 'Nur freigeschaltete Rezepte', default: false },
  spectators_generate_chunks: { group: 'Spieler', label: 'Zuschauer laden neue Gebiete', default: true },
  allow_entering_nether_using_portals: { group: 'Spieler', label: 'Nether-Portale', default: true },
  players_nether_portal_default_delay: { group: 'Spieler', label: 'Portal-Wartezeit', hint: 'In Ticks (20 = 1 Sekunde).', default: 80 },
  players_nether_portal_creative_delay: { group: 'Spieler', label: 'Portal-Wartezeit im Kreativmodus', hint: 'In Ticks.', default: 0 },

  // Welt & Zeit
  advance_time: { group: 'Welt & Zeit', label: 'Tageszeit läuft', hint: 'Aus = Zeit bleibt stehen.', default: true },
  advance_weather: { group: 'Welt & Zeit', label: 'Wetter ändert sich', default: true },
  random_tick_speed: { group: 'Welt & Zeit', label: 'Wachstumstempo', hint: 'Zufallsticks pro Chunk: Pflanzen wachsen, Blätter zerfallen, Eis schmilzt.', default: 3 },
  fire_spread_radius_around_player: { group: 'Welt & Zeit', label: 'Feuer breitet sich aus im Umkreis von', hint: 'Blöcke um Spieler; 0 = Feuer breitet sich nicht aus.', default: 128 },
  spread_vines: { group: 'Welt & Zeit', label: 'Ranken wachsen', default: true },
  water_source_conversion: { group: 'Welt & Zeit', label: 'Neue Wasserquellen entstehen', default: true },
  lava_source_conversion: { group: 'Welt & Zeit', label: 'Neue Lavaquellen entstehen', default: false },
  max_snow_accumulation_height: { group: 'Welt & Zeit', label: 'Maximale Schneehöhe', hint: 'In Schichten.', default: 1 },
  projectiles_can_break_blocks: { group: 'Welt & Zeit', label: 'Geschosse zerstören Blöcke', hint: 'z. B. Dekorierte Töpfe, Chorusblüten.', default: true },
  global_sound_events: { group: 'Welt & Zeit', label: 'Globale Geräusche', hint: 'Wither und Enderdrache überall hörbar.', default: true },

  // Mobs
  mob_griefing: { group: 'Mobs', label: 'Mobs verändern Blöcke', hint: 'Creeper-Krater, Endermen tragen Blöcke, Dorfbewohner ernten.', default: true },
  spawn_mobs: { group: 'Mobs', label: 'Mobs spawnen', default: true },
  spawn_monsters: { group: 'Mobs', label: 'Monster spawnen', default: true },
  spawn_phantoms: { group: 'Mobs', label: 'Phantome', hint: 'Erscheinen nach drei Nächten ohne Schlaf.', default: true },
  spawn_patrols: { group: 'Mobs', label: 'Plünderer-Patrouillen', default: true },
  spawn_wandering_traders: { group: 'Mobs', label: 'Fahrende Händler', default: true },
  spawn_wardens: { group: 'Mobs', label: 'Wärter', default: true },
  raids: { group: 'Mobs', label: 'Überfälle', default: true },
  universal_anger: { group: 'Mobs', label: 'Neutrale Mobs auf alle wütend', default: false },
  forgive_dead_players: { group: 'Mobs', label: 'Neutrale Mobs vergessen Wut nach dem Tod', default: true },
  max_entity_cramming: { group: 'Mobs', label: 'Maximale Wesen auf einem Block', hint: 'Darüber nehmen sie Schaden.', default: 24 },
  spawner_blocks_work: { group: 'Mobs', label: 'Spawner aktiv', default: true },

  // Drops & Explosionen
  block_drops: { group: 'Drops & Explosionen', label: 'Blöcke droppen Items', default: true },
  mob_drops: { group: 'Drops & Explosionen', label: 'Mobs droppen Beute', default: true },
  entity_drops: { group: 'Drops & Explosionen', label: 'Objekte droppen Items', hint: 'Loren, Rahmen, Rüstungsständer.', default: true },
  tnt_explodes: { group: 'Drops & Explosionen', label: 'TNT explodiert', default: true },
  block_explosion_drop_decay: { group: 'Drops & Explosionen', label: 'Block-Explosionen vernichten Drops', hint: 'z. B. Betten im Nether.', default: true },
  mob_explosion_drop_decay: { group: 'Drops & Explosionen', label: 'Mob-Explosionen vernichten Drops', hint: 'z. B. Creeper.', default: true },
  tnt_explosion_drop_decay: { group: 'Drops & Explosionen', label: 'TNT vernichtet Drops', default: false },

  // Technik
  command_blocks_work: { group: 'Technik', label: 'Befehlsblöcke aktiv', default: true },
  command_block_output: { group: 'Technik', label: 'Befehlsblöcke melden im Chat', default: true },
  send_command_feedback: { group: 'Technik', label: 'Rückmeldung zu Befehlen im Chat', default: true },
  log_admin_commands: { group: 'Technik', label: 'Admin-Befehle protokollieren', default: true },
  player_movement_check: { group: 'Technik', label: 'Bewegungsprüfung', hint: 'Schutz gegen zu schnelle Bewegung (Cheats).', default: true },
  elytra_movement_check: { group: 'Technik', label: 'Elytren-Prüfung', default: true },
  max_block_modifications: { group: 'Technik', label: 'Max. Blöcke pro Befehl', hint: 'Grenze für /fill und /clone.', default: 32768 },
  max_command_forks: { group: 'Technik', label: 'Max. Befehlsverzweigungen', default: 65536 },
  max_command_sequence_length: { group: 'Technik', label: 'Max. Befehlskette', default: 65536 },
};
