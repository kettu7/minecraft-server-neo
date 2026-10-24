// Benachrichtigungen: allgemeines Feature für Hinweise an alle Mitglieder oder nur an Admins
// (z. B. „Modpack aktualisiert“). Gelesen wird pro Konto gespeichert – was weggeklickt ist, kommt auf
// keinem Gerät wieder. Neue Mitglieder sehen nur Meldungen ab ihrer Anmeldung, nach 90 Tagen räumt die API auf.
import type { FastifyInstance } from 'fastify';
import { db } from './db.ts';
import type { User } from './users.ts';
import { getState, setState } from './mod-manager.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT NOT NULL DEFAULT 'info',
    title        TEXT NOT NULL,
    body         TEXT NOT NULL DEFAULT '',
    link         TEXT,
    action_label TEXT,
    audience     TEXT NOT NULL DEFAULT 'all',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS notification_reads (
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    read_at         TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, notification_id)
  );
`);

/** Art bestimmt das Symbol in der Oberfläche */
export const KINDS = ['info', 'modpack', 'restart', 'event', 'trophy', 'backup', 'world', 'project', 'warning'] as const;
export type NotificationKind = (typeof KINDS)[number];
export type Audience = 'all' | 'admin';

export interface NewNotification {
  kind?: NotificationKind;
  title: string;
  body?: string;
  /** interner Pfad, z. B. /modpack */
  link?: string;
  /** Beschriftung der Schaltfläche zum Link, z. B. „Zum Modpack“ */
  actionLabel?: string;
  audience?: Audience;
  /** nur für Beispieldaten: Zeitpunkt in der Vergangenheit */
  createdAt?: Date;
}

export interface Notification {
  id: number;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string | null;
  actionLabel: string | null;
  audience: Audience;
  createdAt: string;
  read: boolean;
}

const KEEP_DAYS = 90;
/** SQLite-Zeitformat (UTC), wie datetime('now') */
const sqlTime = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
const iso = (t: string) => `${t.replace(' ', 'T')}Z`;

export function notify(n: NewNotification): number {
  const res = db.prepare(`
    INSERT INTO notifications (kind, title, body, link, action_label, audience, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(n.kind ?? 'info', n.title, n.body ?? '', n.link ?? null, n.actionLabel ?? null, n.audience ?? 'all', sqlTime(n.createdAt ?? new Date()));
  return Number(res.lastInsertRowid);
}

/** Sichtbar: passende Zielgruppe, nicht älter als 90 Tage und nicht vor der Anmeldung des Kontos */
export function notificationsFor(user: Pick<User, 'id' | 'role' | 'createdAt'>): Notification[] {
  const since = sqlTime(new Date(Date.now() - KEEP_DAYS * 86400_000));
  const rows = db.prepare(`
    SELECT n.id, n.kind, n.title, n.body, n.link, n.action_label AS actionLabel, n.audience, n.created_at AS createdAt,
           r.read_at IS NOT NULL AS read
    FROM notifications n
    LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ?
    WHERE n.created_at >= ? AND n.created_at >= ? AND (n.audience = 'all' OR ? = 'admin')
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT 100
  `).all(user.id, since, user.createdAt.replace('T', ' ').slice(0, 19), user.role) as Array<Omit<Notification, 'read'> & { read: number }>;
  return rows.map((r) => ({ ...r, createdAt: iso(r.createdAt), read: !!r.read }));
}

export function markRead(userId: number, ids: number[]) {
  const insert = db.prepare('INSERT OR IGNORE INTO notification_reads (user_id, notification_id) VALUES (?, ?)');
  for (const id of ids) insert.run(userId, id);
}

export function purgeOldNotifications() {
  db.prepare('DELETE FROM notifications WHERE created_at < ?').run(sqlTime(new Date(Date.now() - KEEP_DAYS * 86400_000)));
}

/* ───────────────────────── Beispielmeldungen ───────────────────────── */

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

/**
 * Zum Ansehen der Toasts und der Glocke – einmalig angelegt, einfach wegklicken. Inhalte sind erfunden,
 * deshalb nur für Admins sichtbar: Mitspieler sollen keine ausgedachten Meldungen sehen.
 */
const DUMMY_LIST: NewNotification[] = [
  { kind: 'modpack', title: 'Modpack aktualisiert', body: '2 neue Mods, 1 aktualisiert. Bitte das Modpack neu herunterladen.',
    link: '/modpack', actionLabel: 'Zum Modpack', createdAt: ago(5) },
  { kind: 'restart', title: 'Geplanter Neustart um 05:00', body: 'Der Server ist danach in etwa einer Minute wieder da.', createdAt: ago(70) },
  { kind: 'event', title: 'Bauwettbewerb am Samstag', body: 'Thema: mittelalterliche Brücke. Treffpunkt um 20 Uhr am Spawn.', createdAt: ago(60 * 3) },
  { kind: 'trophy', title: 'Neuer Spitzenreiter', body: 'BlockBaron führt jetzt die Rangliste „Baumeister“ an.', link: '/', actionLabel: 'Zur Rangliste',
    createdAt: ago(60 * 26) },
  { kind: 'backup', title: 'Backup fehlgeschlagen', body: 'Das stündliche Backup konnte nicht erstellt werden: Minecraft-Server nicht erreichbar.',
    link: '/admin', actionLabel: 'Zu den Backups', createdAt: ago(60 * 50) },
  { kind: 'project', title: 'Neue Bauprojekte', body: 'Zwei neue Bauprojekte warten auf Material.', link: '/projekte', actionLabel: 'Ansehen',
    createdAt: ago(60 * 75) },
  { kind: 'info', title: 'Willkommen auf der neuen Website', body: 'Bauprojekte, Lager und die Karte findest du oben im Menü.', createdAt: ago(60 * 24 * 4) },
];
export const DUMMY_NOTIFICATIONS = DUMMY_LIST.map((n) => ({ ...n, audience: 'admin' as const }));

/* ───────────────────────── Routen ───────────────────────── */

export function registerNotifications(app: FastifyInstance) {
  purgeOldNotifications();
  setInterval(purgeOldNotifications, 24 * 3600_000).unref();
  if (!getState<boolean>('notifications_dummy_seeded')) {
    for (const n of [...DUMMY_NOTIFICATIONS].reverse()) notify(n);
    setState('notifications_dummy_seeded', true);
  }

  app.get('/api/notifications', async (req) => {
    const items = notificationsFor(req.user!);
    return { items, unread: items.filter((n) => !n.read).length };
  });

  // Eine Meldung schließen (Toast ✕ oder Schaltfläche) – kommt danach nicht wieder
  app.post<{ Params: { id: string } }>('/api/notifications/:id/read', async (req) => {
    markRead(req.user!.id, [Number(req.params.id)].filter(Number.isInteger));
    return { ok: true };
  });

  // Alle gelesen (Glocke geöffnet, „Alle schließen“)
  app.post('/api/notifications/read-all', async (req) => {
    markRead(req.user!.id, notificationsFor(req.user!).filter((n) => !n.read).map((n) => n.id));
    return { ok: true };
  });
}
