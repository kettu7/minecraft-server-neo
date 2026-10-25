// Eigene Marker auf der Karte: Basen, Farmen, Sehenswürdigkeiten und Sonstiges. Alle Mitglieder dürfen
// Marker setzen; ändern und löschen dürfen nur der Ersteller und Admins. Die Website blendet sie in
// BlueMap ein (wie Bauprojekte und Lager) – BlueMap selbst muss dafür nichts wissen oder neu rendern.
import type { FastifyInstance } from 'fastify';
import { db } from './db.ts';
import type { User } from './users.ts';
import { notify } from './notifications.ts';
import { getState, setState } from './mod-manager.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS map_markers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name        TEXT NOT NULL,
    category    TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    dimension   TEXT NOT NULL DEFAULT 'minecraft:overworld',
    x           INTEGER NOT NULL,
    y           INTEGER NOT NULL,
    z           INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export const CATEGORIES = ['base', 'farm', 'sight', 'other'] as const;
export type MarkerCategory = (typeof CATEGORIES)[number];
const DIMENSIONS = ['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'];
/** Weltgrenze von Minecraft (Höhe großzügig für Datapacks mit höheren Welten) */
const MAX_XZ = 30_000_000;
const MAX_Y = 4096;

export interface MarkerInput {
  name: string;
  category: MarkerCategory;
  description: string;
  dimension: string;
  x: number;
  y: number;
  z: number;
}

export interface Marker extends MarkerInput {
  id: number;
  userId: number | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
}

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '');

/** Prüft die Eingabe; Text = Fehlermeldung für die Oberfläche */
export function parseMarker(body: Record<string, unknown>): MarkerInput | string {
  const name = clean(body.name, 40);
  if (!name) return 'Bitte einen Namen eingeben.';
  const category = body.category as MarkerCategory;
  if (!CATEGORIES.includes(category)) return 'Bitte eine Kategorie wählen.';
  const dimension = typeof body.dimension === 'string' ? body.dimension : 'minecraft:overworld';
  if (!DIMENSIONS.includes(dimension)) return 'Unbekannte Dimension.';
  const [x, y, z] = [body.x, body.y, body.z].map((v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Math.round(Number(v)) : NaN));
  if (![x, y, z].every(Number.isFinite)) return 'Bitte X, Y und Z als Zahlen angeben.';
  if (Math.abs(x) > MAX_XZ || Math.abs(z) > MAX_XZ || Math.abs(y) > MAX_Y) return 'Die Koordinaten liegen außerhalb der Welt.';
  return { name, category, description: clean(body.description, 300), dimension, x, y, z };
}

export const canEdit = (user: Pick<User, 'id' | 'role'>, ownerId: number | null) => user.role === 'admin' || ownerId === user.id;

type Row = Omit<Marker, 'canEdit'>;
const SELECT = `
  SELECT m.id, m.user_id AS userId, u.display_name AS createdBy, m.name, m.category, m.description, m.dimension,
         m.x, m.y, m.z, m.created_at AS createdAt, m.updated_at AS updatedAt
  FROM map_markers m LEFT JOIN users u ON u.id = m.user_id`;

export function listMarkers(user: Pick<User, 'id' | 'role'>): Marker[] {
  return (db.prepare(`${SELECT} ORDER BY m.name COLLATE NOCASE`).all() as unknown as Row[])
    .map((m) => ({ ...m, canEdit: canEdit(user, m.userId) }));
}

function getMarker(id: number) {
  return db.prepare(`${SELECT} WHERE m.id = ?`).get(id) as Row | undefined;
}

const ANNOUNCED = 'markers_announced';

export function registerMarkers(app: FastifyInstance) {
  // Einmalig: allen Mitgliedern das neue Feature vorstellen
  if (!getState<boolean>(ANNOUNCED)) {
    notify({
      kind: 'world',
      title: 'Neu: Eigene Marker auf der Karte',
      body: 'Markiere deine Basis, Farmen und Sehenswürdigkeiten direkt auf der Karte. Alle Mitglieder sehen sie.',
      link: '/karte',
      actionLabel: 'Zur Karte',
    });
    setState(ANNOUNCED, true);
  }

  app.get('/api/markers', async (req) => ({ markers: listMarkers(req.user!) }));

  app.post<{ Body: Record<string, unknown> }>('/api/markers', async (req, reply) => {
    const input = parseMarker(req.body ?? {});
    if (typeof input === 'string') return reply.code(400).send({ error: input });
    const res = db.prepare(`
      INSERT INTO map_markers (user_id, name, category, description, dimension, x, y, z) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user!.id, input.name, input.category, input.description, input.dimension, input.x, input.y, input.z);
    const marker = getMarker(Number(res.lastInsertRowid))!;
    return reply.code(201).send({ marker: { ...marker, canEdit: true } });
  });

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/markers/:id', async (req, reply) => {
    const existing = getMarker(Number(req.params.id));
    if (!existing) return reply.code(404).send({ error: 'Marker nicht gefunden.' });
    if (!canEdit(req.user!, existing.userId)) return reply.code(403).send({ error: 'Nur der Ersteller oder Admins dürfen diesen Marker ändern.' });
    const input = parseMarker(req.body ?? {});
    if (typeof input === 'string') return reply.code(400).send({ error: input });
    db.prepare(`
      UPDATE map_markers SET name = ?, category = ?, description = ?, dimension = ?, x = ?, y = ?, z = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(input.name, input.category, input.description, input.dimension, input.x, input.y, input.z, existing.id);
    return { marker: { ...getMarker(existing.id)!, canEdit: true } };
  });

  app.delete<{ Params: { id: string } }>('/api/markers/:id', async (req, reply) => {
    const existing = getMarker(Number(req.params.id));
    if (!existing) return reply.code(404).send({ error: 'Marker nicht gefunden.' });
    if (!canEdit(req.user!, existing.userId)) return reply.code(403).send({ error: 'Nur der Ersteller oder Admins dürfen diesen Marker löschen.' });
    db.prepare('DELETE FROM map_markers WHERE id = ?').run(existing.id);
    return { ok: true };
  });
}
