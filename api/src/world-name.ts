// Name der aktuellen Welt – steht in jedem Backup, damit man Archive später zuordnen kann.
import { db } from './db.ts';

db.exec('CREATE TABLE IF NOT EXISTS mod_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

const KEY = 'world_name';
export const DEFAULT_WORLD_NAME = 'Neo';
export const WORLD_NAME_MAX = 40;

export function currentWorldName(): string {
  const row = db.prepare('SELECT value FROM mod_state WHERE key = ?').get(KEY) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as string) : DEFAULT_WORLD_NAME;
}

export function setWorldName(name: string) {
  db.prepare('INSERT INTO mod_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(KEY, JSON.stringify(name));
}

/** Weltname bereinigen: Steuerzeichen raus, Leerraum zusammenziehen; leer → null */
export function cleanWorldName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const name = input.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, WORLD_NAME_MAX);
  return name || null;
}
