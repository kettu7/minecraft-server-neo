// Benutzer, Sitzungen und Protokoll. Anmeldung ausschließlich über Discord, Rollen werden auf der Website vergeben.
import { createHash, randomBytes } from 'node:crypto';
import { db } from './db.ts';

export const ROLES = ['pending', 'player', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface User {
  id: number;
  discordId: string;
  username: string;
  displayName: string;
  avatar: string | null;
  role: Role;
  /** Inhaber: hat Admin-Rechte und kann von niemandem herabgestuft, gelöscht oder gebannt werden */
  isOwner: boolean;
  minecraftName: string | null;
  /** Name, den die Website zuletzt auf die Whitelist gesetzt hat */
  whitelistedName: string | null;
  whitelistError: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

export const SESSION_DAYS = 30;

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id       TEXT NOT NULL UNIQUE,
    username         TEXT NOT NULL,
    display_name     TEXT NOT NULL,
    avatar           TEXT,
    role             TEXT NOT NULL DEFAULT 'pending',
    minecraft_name   TEXT,
    whitelisted_name TEXT,
    whitelist_error  TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at    TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action     TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS bans (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id     TEXT NOT NULL UNIQUE,
    display_name   TEXT NOT NULL,
    minecraft_name TEXT,
    reason         TEXT NOT NULL DEFAULT '',
    banned_by      TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Inhaber-Flag (nachträglich hinzugekommen). Gibt es noch keinen, wird der älteste Admin Inhaber.
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'is_owner')) {
  db.exec('ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0');
}
if (!db.prepare('SELECT 1 FROM users WHERE is_owner = 1').get()) {
  db.exec("UPDATE users SET is_owner = 1 WHERE id = (SELECT MIN(id) FROM users WHERE role = 'admin')");
}

const USER_COLUMNS = `
  id, discord_id AS discordId, username, display_name AS displayName, avatar, role, is_owner = 1 AS isOwner,
  minecraft_name AS minecraftName, whitelisted_name AS whitelistedName, whitelist_error AS whitelistError,
  created_at AS createdAt, last_login_at AS lastLoginAt`;

/** Minecraft-Namen: 3–16 Zeichen, Buchstaben, Ziffern, Unterstrich */
export const MINECRAFT_NAME = /^[A-Za-z0-9_]{3,16}$/;

/** SQLite liefert 0/1 – als boolean zurückgeben */
const fixOwner = (u: User): User => ({ ...u, isOwner: Boolean(u.isOwner) });

export function getUser(id: number): User | undefined {
  const u = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id) as User | undefined;
  return u && fixOwner(u);
}

export function listUsers(): User[] {
  return (db.prepare(`
    SELECT ${USER_COLUMNS} FROM users
    ORDER BY is_owner DESC, CASE role WHEN 'pending' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, display_name COLLATE NOCASE`,
  ).all() as unknown as User[]).map(fixOwner);
}

export function countAdmins(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n;
}

/**
 * Legt den Benutzer beim ersten Login an oder aktualisiert Name/Avatar.
 * Gibt es noch keinen Admin, wird der Erste zum Admin – damit sich der Betreiber nicht aussperrt.
 */
export function upsertDiscordUser(d: { id: string; username: string; displayName: string; avatar: string | null }): User {
  const existing = db.prepare('SELECT id FROM users WHERE discord_id = ?').get(d.id) as { id: number } | undefined;
  if (existing) {
    db.prepare(`UPDATE users SET username = ?, display_name = ?, avatar = ?, last_login_at = datetime('now') WHERE id = ?`)
      .run(d.username, d.displayName, d.avatar, existing.id);
    return getUser(existing.id)!;
  }
  const first = countAdmins() === 0;
  const role: Role = first ? 'admin' : 'pending';
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO users (discord_id, username, display_name, avatar, role, is_owner, last_login_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(d.id, d.username, d.displayName, d.avatar, role, first ? 1 : 0);
  const id = Number(lastInsertRowid);
  audit(id, 'registriert', first ? 'erster Benutzer → Inhaber' : 'wartet auf Freischaltung');
  return getUser(id)!;
}

export function setRole(id: number, role: Role) {
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
}

export function setMinecraftName(id: number, name: string | null) {
  db.prepare('UPDATE users SET minecraft_name = ? WHERE id = ?').run(name, id);
}

export function setWhitelistState(id: number, whitelistedName: string | null, error: string | null) {
  db.prepare('UPDATE users SET whitelisted_name = ?, whitelist_error = ? WHERE id = ?').run(whitelistedName, error, id);
}

export function minecraftNameTaken(name: string, exceptUserId: number): boolean {
  return !!db.prepare('SELECT 1 FROM users WHERE minecraft_name = ? COLLATE NOCASE AND id <> ?').get(name, exceptUserId);
}

export function deleteUser(id: number): boolean {
  return db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
}

/* ───────────────────────── Sitzungen ───────────────────────── */

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Gibt das Token für das Cookie zurück; in der Datenbank liegt nur der Hash. */
export function createSession(userId: number): string {
  const token = randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))`)
    .run(hash(token), userId, `+${SESSION_DAYS} days`);
  return token;
}

export function userForSession(token: string | undefined): User | undefined {
  if (!token) return undefined;
  const row = db.prepare(`SELECT user_id AS id FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')`)
    .get(hash(token)) as { id: number } | undefined;
  return row ? getUser(row.id) : undefined;
}

export function deleteSession(token: string | undefined) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
}

export function purgeExpiredSessions() {
  db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run();
}

/* ───────────────────────── Protokoll ───────────────────────── */

export function audit(userId: number | null, action: string, detail = '') {
  db.prepare('INSERT INTO audit_log (user_id, action, detail) VALUES (?, ?, ?)').run(userId, action, detail);
}

export function listAudit(limit = 200) {
  return db.prepare(`
    SELECT a.id, a.action, a.detail, a.created_at AS createdAt, u.display_name AS user
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.id DESC LIMIT ?`).all(limit);
}

/* ───────────────────────── Bans ───────────────────────── */

export interface Ban {
  id: number;
  discordId: string;
  displayName: string;
  minecraftName: string | null;
  reason: string;
  bannedBy: string | null;
  createdAt: string;
}

export function isBanned(discordId: string): boolean {
  return !!db.prepare('SELECT 1 FROM bans WHERE discord_id = ?').get(discordId);
}

export function addBan(u: User, reason: string, bannedBy: string) {
  db.prepare(`
    INSERT INTO bans (discord_id, display_name, minecraft_name, reason, banned_by) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET reason = excluded.reason, banned_by = excluded.banned_by`,
  ).run(u.discordId, u.displayName, u.minecraftName, reason, bannedBy);
}

export function listBans(): Ban[] {
  return db.prepare(`
    SELECT id, discord_id AS discordId, display_name AS displayName, minecraft_name AS minecraftName, reason,
           banned_by AS bannedBy, created_at AS createdAt
    FROM bans ORDER BY id DESC`).all() as unknown as Ban[];
}

export function getBan(id: number): Ban | undefined {
  return listBans().find((b) => b.id === id);
}

export function removeBan(id: number): boolean {
  return db.prepare('DELETE FROM bans WHERE id = ?').run(id).changes > 0;
}
