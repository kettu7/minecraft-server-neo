import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Schematic } from './litematic.ts';
import { LEGACY_BLOCKS, blockToItems, splitAmount } from './items.ts';
import type { Placement, ProgressResult } from './progress.ts';
import type { ScanResult, StorageArea } from './storage.ts';

export const DATA_DIR = process.env.DATA_DIR ?? join(import.meta.dirname, '..', 'data');
export const SCHEMATIC_DIR = join(DATA_DIR, 'schematics');
/** Projektbilder: <id>.<ext> und <id>-thumb.<ext> */
export const IMAGE_DIR = join(DATA_DIR, 'images');
mkdirSync(SCHEMATIC_DIR, { recursive: true });
mkdirSync(IMAGE_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'neo.db'));
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS projects (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    schematic_name TEXT NOT NULL,
    author         TEXT NOT NULL DEFAULT '',
    size_x INTEGER, size_y INTEGER, size_z INTEGER,
    total_blocks   INTEGER NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS materials (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    item       TEXT NOT NULL,
    required   INTEGER NOT NULL,
    collected  INTEGER NOT NULL DEFAULT 0,  -- nicht mehr genutzt (früher manuelle Eingabe)
    assignee   TEXT NOT NULL DEFAULT '',    -- nicht mehr genutzt
    PRIMARY KEY (project_id, item)
  );
  CREATE TABLE IF NOT EXISTS storages (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL,
    dimension          TEXT NOT NULL DEFAULT 'minecraft:overworld',
    x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,
    radius             INTEGER NOT NULL,
    height             INTEGER NOT NULL,
    include_shulkers   INTEGER NOT NULL DEFAULT 1,
    scanned_at         TEXT,
    scan_ms            INTEGER,
    scanned_positions  INTEGER,
    unloaded_positions INTEGER,
    last_error         TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS storage_containers (
    storage_id INTEGER NOT NULL REFERENCES storages(id) ON DELETE CASCADE,
    x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,
    type       TEXT NOT NULL,
    PRIMARY KEY (storage_id, x, y, z)
  );
  CREATE TABLE IF NOT EXISTS storage_stock (
    storage_id INTEGER NOT NULL REFERENCES storages(id) ON DELETE CASCADE,
    x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,
    item       TEXT NOT NULL,
    count      INTEGER NOT NULL,
    in_shulker INTEGER NOT NULL,
    PRIMARY KEY (storage_id, x, y, z, item, in_shulker)
  );
  CREATE TABLE IF NOT EXISTS project_storages (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    storage_id INTEGER NOT NULL REFERENCES storages(id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, storage_id)
  );
`);

// Spalten, die nach der ersten Version dazugekommen sind
function addColumn(table: string, column: string, definition: string) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('projects', 'origin_x', 'INTEGER');
addColumn('projects', 'origin_y', 'INTEGER');
addColumn('projects', 'origin_z', 'INTEGER');
addColumn('projects', 'rotation', "TEXT NOT NULL DEFAULT 'NONE'");
addColumn('projects', 'mirror', "TEXT NOT NULL DEFAULT 'NONE'");
addColumn('projects', 'dimension', "TEXT NOT NULL DEFAULT 'minecraft:overworld'");
addColumn('projects', 'placed_blocks', 'INTEGER');
addColumn('projects', 'unloaded_blocks', 'INTEGER');
addColumn('projects', 'checked_at', 'TEXT');
addColumn('projects', 'image_type', 'TEXT');        // z. B. image/webp; NULL = kein Bild
addColumn('projects', 'image_updated_at', 'TEXT');  // dient auch als Cache-Version für die Bild-URL
addColumn('materials', 'placed', 'INTEGER NOT NULL DEFAULT 0');

// Materiallisten aus älteren Schematics: umbenannte Blöcke auf den heutigen Item-Namen bringen
// (steht beides in einem Projekt, werden die Mengen zusammengelegt)
for (const [old, block] of Object.entries(LEGACY_BLOCKS)) {
  const [[item]] = blockToItems(block);
  if (item === old) continue;
  db.exec('BEGIN');
  db.prepare(`
    UPDATE materials SET required = required + (SELECT o.required FROM materials o WHERE o.project_id = materials.project_id AND o.item = ?)
    WHERE item = ? AND EXISTS (SELECT 1 FROM materials o WHERE o.project_id = materials.project_id AND o.item = ?)
  `).run(old, item, old);
  db.prepare('DELETE FROM materials WHERE item = ? AND EXISTS (SELECT 1 FROM materials n WHERE n.project_id = materials.project_id AND n.item = ?)').run(old, item);
  db.prepare('UPDATE materials SET item = ? WHERE item = ?').run(item, old);
  db.exec('COMMIT');
}
// Gemeinsame Reihenfolge der Kacheln (Drag & Drop); NULL = noch nie einsortiert → steht vorn
addColumn('projects', 'sort_order', 'INTEGER');
addColumn('storages', 'sort_order', 'INTEGER');

export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* ───────────────────────── Projekte ───────────────────────── */

interface ProjectRow {
  id: number; name: string; description: string; schematicName: string; author: string;
  sizeX: number; sizeY: number; sizeZ: number; totalBlocks: number; createdAt: string;
  originX: number | null; originY: number | null; originZ: number | null;
  rotation: string; mirror: string; dimension: string;
  placedBlocks: number | null; unloadedBlocks: number | null; checkedAt: string | null;
  imageType: string | null; imageUpdatedAt: string | null;
}

const PROJECT_COLUMNS = `
  id, name, description, schematic_name AS schematicName, author,
  size_x AS sizeX, size_y AS sizeY, size_z AS sizeZ, total_blocks AS totalBlocks, created_at AS createdAt,
  origin_x AS originX, origin_y AS originY, origin_z AS originZ, rotation, mirror, dimension,
  placed_blocks AS placedBlocks, unloaded_blocks AS unloadedBlocks, checked_at AS checkedAt,
  image_type AS imageType, image_updated_at AS imageUpdatedAt`;

/**
 * Bestand aller Lager eines Projekts. Liegt ein Behälter in mehreren dieser Lager
 * (überlappende Bereiche), zählt er nur einmal.
 */
function projectStock(projectId: number): Map<string, number> {
  const rows = db.prepare(`
    SELECT item, SUM(c) AS stock FROM (
      SELECT st.item, MAX(st.count) AS c
      FROM storage_stock st
      JOIN storages s ON s.id = st.storage_id
      JOIN project_storages ps ON ps.storage_id = s.id AND ps.project_id = ?
      WHERE s.include_shulkers = 1 OR st.in_shulker = 0
      GROUP BY s.dimension, st.x, st.y, st.z, st.item, st.in_shulker
    ) GROUP BY item`).all(projectId) as Array<{ item: string; stock: number }>;
  return new Map(rows.map((r) => [r.item, r.stock]));
}

function buildProject(row: ProjectRow) {
  const { originX, originY, originZ, rotation, mirror, dimension, imageType, imageUpdatedAt, ...rest } = row;
  // Bild-URL mit Version, damit der Browser nach dem Austauschen das neue Bild lädt
  const image = imageType ? `/api/projects/${row.id}/image?v=${encodeURIComponent(imageUpdatedAt ?? '')}` : null;
  const placement = originX === null || originY === null || originZ === null
    ? null
    : { x: originX, y: originY, z: originZ, rotation, mirror, dimension };

  const stock = projectStock(row.id);
  const materials = (db.prepare(
    'SELECT item, required, placed FROM materials WHERE project_id = ? ORDER BY required DESC, item',
  ).all(row.id) as Array<{ item: string; required: number; placed: number }>).map((m) => {
    const placed = Math.min(m.placed, m.required);
    const open = m.required - placed;
    const inStock = stock.get(m.item) ?? 0;
    return {
      item: m.item,
      required: m.required,
      placed,
      open,
      stock: inStock,
      missing: Math.max(0, open - inStock),
      ...splitAmount(open, m.item),
    };
  });

  const storages = db.prepare(`
    SELECT s.id, s.name FROM storages s JOIN project_storages ps ON ps.storage_id = s.id
    WHERE ps.project_id = ? ORDER BY s.name`).all(row.id);

  const sum = (f: (m: (typeof materials)[number]) => number) => materials.reduce((a, m) => a + f(m), 0);
  return {
    ...rest,
    placement,
    image,
    storages,
    required: sum((m) => m.required),
    placed: sum((m) => m.placed),
    open: sum((m) => m.open),
    covered: sum((m) => Math.min(m.stock, m.open)),
    materials,
  };
}

export function listProjects() {
  const rows = db.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY sort_order IS NOT NULL, sort_order, created_at DESC`).all() as unknown as ProjectRow[];
  return rows.map((r) => {
    const { materials, ...summary } = buildProject(r);
    return summary;
  });
}

export function getProject(id: number) {
  const row = db.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`).get(id) as unknown as ProjectRow | undefined;
  return row ? buildProject(row) : undefined;
}

export function projectIdsWithPlacement(): number[] {
  return (db.prepare('SELECT id FROM projects WHERE origin_x IS NOT NULL').all() as Array<{ id: number }>).map((r) => r.id);
}

export function setPlacement(id: number, p: Placement): boolean {
  return db.prepare(`
    UPDATE projects SET origin_x = ?, origin_y = ?, origin_z = ?, rotation = ?, mirror = ?, dimension = ?,
                        placed_blocks = NULL, unloaded_blocks = NULL, checked_at = NULL
    WHERE id = ?`,
  ).run(p.x, p.y, p.z, p.rotation, p.mirror, p.dimension, id).changes > 0;
}

export function getPlacement(id: number): Placement | undefined {
  return (getProject(id)?.placement ?? undefined) as Placement | undefined;
}

export function saveProgress(id: number, result: ProgressResult) {
  transaction(() => {
    db.prepare("UPDATE projects SET placed_blocks = ?, unloaded_blocks = ?, checked_at = datetime('now') WHERE id = ?")
      .run(result.placed, result.unloaded, id);
    db.prepare('UPDATE materials SET placed = 0 WHERE project_id = ?').run(id);
    const update = db.prepare('UPDATE materials SET placed = ? WHERE project_id = ? AND item = ?');
    for (const [item, n] of result.placedItems) update.run(n, id, item);
  });
}

export function createProject(name: string, description: string, fileName: string, schematic: Schematic): number {
  return transaction(() => {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO projects (name, description, schematic_name, author, size_x, size_y, size_z, total_blocks)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(name, description, fileName, schematic.author, schematic.size.x, schematic.size.y, schematic.size.z, schematic.totalBlocks);
    const insert = db.prepare('INSERT INTO materials (project_id, item, required) VALUES (?, ?, ?)');
    for (const m of schematic.materials) insert.run(lastInsertRowid, m.item, m.count);
    return Number(lastInsertRowid);
  });
}

export function setProjectStorages(projectId: number, storageIds: number[]): boolean {
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) return false;
  transaction(() => {
    db.prepare('DELETE FROM project_storages WHERE project_id = ?').run(projectId);
    const insert = db.prepare('INSERT OR IGNORE INTO project_storages (project_id, storage_id) SELECT ?, id FROM storages WHERE id = ?');
    for (const sid of storageIds) insert.run(projectId, sid);
  });
  return true;
}

export function storageIdsOfProject(projectId: number): number[] {
  return (db.prepare('SELECT storage_id AS id FROM project_storages WHERE project_id = ?').all(projectId) as Array<{ id: number }>)
    .map((r) => r.id);
}

export function setProjectImage(id: number, type: string | null) {
  db.prepare(`UPDATE projects SET image_type = ?, image_updated_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END WHERE id = ?`)
    .run(type, type, id);
}

export function getProjectImageType(id: number): string | null | undefined {
  const row = db.prepare('SELECT image_type AS t FROM projects WHERE id = ?').get(id) as { t: string | null } | undefined;
  return row ? row.t : undefined;
}

export function deleteProject(id: number): boolean {
  return db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
}

/* ───────────────────────── Lager ───────────────────────── */

export interface StorageInput extends StorageArea {
  name: string;
  includeShulkers: boolean;
}

const STORAGE_COLUMNS = `
  s.id, s.name, s.dimension, s.x, s.y, s.z, s.radius, s.height,
  s.include_shulkers AS includeShulkers, s.scanned_at AS scannedAt, s.scan_ms AS scanMs,
  s.scanned_positions AS scannedPositions, s.unloaded_positions AS unloadedPositions, s.last_error AS lastError`;

/** Filter, der Shulker-Inhalte ausblendet, wenn der Schalter des Lagers aus ist */
const SHULKER_FILTER = '(s.include_shulkers = 1 OR st.in_shulker = 0)';

function storageSummary(row: Record<string, unknown>) {
  const id = row.id as number;
  const totals = db.prepare(`
    SELECT COUNT(DISTINCT st.item) AS itemTypes, COALESCE(SUM(st.count), 0) AS itemCount
    FROM storage_stock st JOIN storages s ON s.id = st.storage_id
    WHERE st.storage_id = ? AND ${SHULKER_FILTER}`).get(id) as { itemTypes: number; itemCount: number };
  const containers = db.prepare(`
    SELECT c.type, COUNT(*) AS n FROM storage_containers c JOIN storages s ON s.id = c.storage_id
    WHERE c.storage_id = ? AND (s.include_shulkers = 1 OR c.type NOT LIKE '%shulker_box')
    GROUP BY c.type ORDER BY n DESC`).all(id) as Array<{ type: string; n: number }>;
  const projects = db.prepare(`
    SELECT p.id, p.name FROM projects p JOIN project_storages ps ON ps.project_id = p.id
    WHERE ps.storage_id = ? ORDER BY p.name`).all(id);
  return {
    ...row,
    includeShulkers: row.includeShulkers === 1,
    ...totals,
    containerCount: containers.reduce((a, c) => a + c.n, 0),
    containers,
    projects,
  };
}

/** Reihenfolge speichern: Position in der Liste = sort_order; unbekannte IDs werden ignoriert */
export function setOrder(table: 'projects' | 'storages', ids: number[]) {
  const update = db.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`);
  transaction(() => ids.forEach((id, index) => update.run(index, id)));
}

export function listStorages() {
  return db.prepare(`SELECT ${STORAGE_COLUMNS} FROM storages s ORDER BY s.sort_order IS NOT NULL, s.sort_order, s.name`).all().map(storageSummary);
}

export function getStorage(id: number) {
  const row = db.prepare(`SELECT ${STORAGE_COLUMNS} FROM storages s WHERE s.id = ?`).get(id);
  if (!row) return undefined;
  const stock = (db.prepare(`
    SELECT st.item, SUM(st.count) AS count FROM storage_stock st JOIN storages s ON s.id = st.storage_id
    WHERE st.storage_id = ? AND ${SHULKER_FILTER}
    GROUP BY st.item ORDER BY count DESC, st.item`).all(id) as Array<{ item: string; count: number }>)
    .map((s) => ({ ...s, ...splitAmount(s.count, s.item) }));
  return { ...storageSummary(row), stock };
}

export function getStorageArea(id: number): (StorageArea & { name: string }) | undefined {
  return db.prepare('SELECT name, x, y, z, radius, height, dimension FROM storages WHERE id = ?').get(id) as
    (StorageArea & { name: string }) | undefined;
}

export function allStorageIds(): number[] {
  return (db.prepare('SELECT id FROM storages').all() as Array<{ id: number }>).map((r) => r.id);
}

export function createStorage(s: StorageInput): number {
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO storages (name, dimension, x, y, z, radius, height, include_shulkers) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(s.name, s.dimension, s.x, s.y, s.z, s.radius, s.height, s.includeShulkers ? 1 : 0);
  return Number(lastInsertRowid);
}

/** Gibt zurück, ob sich der Bereich geändert hat (dann muss neu gescannt werden). */
export function updateStorage(id: number, s: StorageInput): { found: boolean; areaChanged: boolean } {
  const before = getStorageArea(id);
  if (!before) return { found: false, areaChanged: false };
  db.prepare(`
    UPDATE storages SET name = ?, dimension = ?, x = ?, y = ?, z = ?, radius = ?, height = ?, include_shulkers = ?
    WHERE id = ?`).run(s.name, s.dimension, s.x, s.y, s.z, s.radius, s.height, s.includeShulkers ? 1 : 0, id);
  const areaChanged = (['x', 'y', 'z', 'radius', 'height', 'dimension'] as const).some((k) => before[k] !== s[k]);
  return { found: true, areaChanged };
}

export function saveScan(id: number, result: ScanResult, ms: number) {
  transaction(() => {
    db.prepare('DELETE FROM storage_containers WHERE storage_id = ?').run(id);
    db.prepare('DELETE FROM storage_stock WHERE storage_id = ?').run(id);
    const container = db.prepare('INSERT INTO storage_containers (storage_id, x, y, z, type) VALUES (?, ?, ?, ?, ?)');
    const stock = db.prepare(`
      INSERT INTO storage_stock (storage_id, x, y, z, item, count, in_shulker) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET count = count + excluded.count`);
    for (const c of result.containers) {
      container.run(id, c.x, c.y, c.z, c.type);
      for (const e of c.items) stock.run(id, c.x, c.y, c.z, e.item, e.count, e.inShulker ? 1 : 0);
    }
    db.prepare(`
      UPDATE storages SET scanned_at = datetime('now'), scan_ms = ?, scanned_positions = ?, unloaded_positions = ?, last_error = NULL
      WHERE id = ?`).run(ms, result.positions, result.unloaded, id);
  });
}

export function saveScanError(id: number, message: string) {
  db.prepare('UPDATE storages SET last_error = ? WHERE id = ?').run(message, id);
}

export function deleteStorage(id: number): boolean {
  return db.prepare('DELETE FROM storages WHERE id = ?').run(id).changes > 0;
}
