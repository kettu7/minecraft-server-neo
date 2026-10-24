import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export type Rotation = 'NONE' | 'CLOCKWISE_90' | 'CLOCKWISE_180' | 'COUNTERCLOCKWISE_90';
export type Mirror = 'NONE' | 'LEFT_RIGHT' | 'FRONT_BACK';
export type Dimension = 'minecraft:overworld' | 'minecraft:the_nether' | 'minecraft:the_end';

export interface Placement {
  x: number;
  y: number;
  z: number;
  rotation: Rotation;
  mirror: Mirror;
  dimension: Dimension;
}

export interface Ref {
  id: number;
  name: string;
}

export interface ProjectSummary {
  id: number;
  name: string;
  description: string;
  schematicName: string;
  author: string;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  totalBlocks: number;
  createdAt: string;
  placement: Placement | null;
  /** URL des Projektbilds (mit Versionsparameter) oder null */
  image: string | null;
  placedBlocks: number | null;
  unloadedBlocks: number | null;
  checkedAt: string | null;
  storages: Ref[];
  /** Gesamtbedarf (Statistik) */
  required: number;
  /** schon verbaut */
  placed: number;
  /** noch zu verbauen = Bedarf − verbaut */
  open: number;
  /** davon durch Lagerbestand gedeckt */
  covered: number;
}

export interface Material {
  item: string;
  required: number;
  placed: number;
  open: number;
  stock: number;
  missing: number;
  /** Aufteilung von "open" */
  shulkers: number;
  stacks: number;
  items: number;
  stackSize: number;
}

export interface Project extends ProjectSummary {
  materials: Material[];
}

export interface StorageInput {
  name: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
  dimension: Dimension;
  includeShulkers: boolean;
}

export interface StorageSummary extends StorageInput {
  id: number;
  scannedAt: string | null;
  scanMs: number | null;
  scannedPositions: number | null;
  unloadedPositions: number | null;
  lastError: string | null;
  itemTypes: number;
  itemCount: number;
  containerCount: number;
  containers: Array<{ type: string; n: number }>;
  projects: Ref[];
}

export interface StockItem {
  item: string;
  count: number;
  shulkers: number;
  stacks: number;
  items: number;
}

export interface Storage extends StorageSummary {
  stock: StockItem[];
}

export interface RefreshReport {
  trigger: 'auto' | 'manual';
  startedAt: string;
  ms: number;
  storages: Array<{ id: number; name: string; ms: number; containers?: number; error?: string }>;
  projects: Array<{ id: number; ms: number; placed?: number; error?: string }>;
  error?: string;
}

export interface Status {
  intervalMinutes: number;
  running: boolean;
  lastRun: RefreshReport | null;
  /** Minecraft-Server für die Kopfzeile */
  server: { state: 'online' | 'starting' | 'offline'; online: number; max: number };
  /** letzte Änderung am Modpack (für „Aktualisiert …“ im Menü) */
  modpackUpdatedAt: string | null;
}

/** Beschriftungen wie in Litematica, damit man die Werte leicht wiederfindet */
export const ROTATION_LABELS: Record<Rotation, string> = {
  NONE: 'Keine (None)',
  CLOCKWISE_90: '90° im Uhrzeigersinn (Clockwise 90)',
  CLOCKWISE_180: '180° (Clockwise 180)',
  COUNTERCLOCKWISE_90: '90° gegen Uhrzeigersinn (Counterclockwise 90)',
};
export const MIRROR_LABELS: Record<Mirror, string> = {
  NONE: 'Keine (None)',
  LEFT_RIGHT: 'Links ↔ Rechts (Left Right)',
  FRONT_BACK: 'Vorne ↔ Hinten (Front Back)',
};
export const DIMENSION_LABELS: Record<Dimension, string> = {
  'minecraft:overworld': 'Oberwelt',
  'minecraft:the_nether': 'Nether',
  'minecraft:the_end': 'End',
};

@Injectable({ providedIn: 'root' })
export class ProjectsService {
  private http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<ProjectSummary[]>('/api/projects'));
  }

  /** gemeinsame Reihenfolge der Kacheln speichern */
  order(ids: number[]) {
    return firstValueFrom(this.http.put<ProjectSummary[]>('/api/projects/order', { ids }));
  }

  get(id: number) {
    return firstValueFrom(this.http.get<Project>(`/api/projects/${id}`));
  }

  create(name: string, description: string, file: File) {
    const form = new FormData();
    form.append('name', name);
    form.append('description', description);
    form.append('file', file);
    return firstValueFrom(this.http.post<Project>('/api/projects', form));
  }

  setPlacement(id: number, placement: Placement) {
    return firstValueFrom(this.http.put<Project>(`/api/projects/${id}/placement`, placement));
  }

  setStorages(id: number, storageIds: number[]) {
    return firstValueFrom(this.http.put<Project>(`/api/projects/${id}/storages`, { storageIds }));
  }

  async uploadImage(id: number, file: Blob) {
    const [image, thumb] = await Promise.all([resizeImage(file, 1600, 0.85), resizeImage(file, 400, 0.8)]);
    const form = new FormData();
    form.append('image', image, 'bild');
    form.append('thumb', thumb, 'vorschau');
    return firstValueFrom(this.http.put(`/api/projects/${id}/image`, form));
  }

  deleteImage(id: number) {
    return firstValueFrom(this.http.delete(`/api/projects/${id}/image`));
  }

  refresh(id: number) {
    return firstValueFrom(this.http.post<{ project: Project; report: RefreshReport }>(`/api/projects/${id}/refresh`, {}));
  }

  delete(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/projects/${id}`));
  }
}

@Injectable({ providedIn: 'root' })
export class StoragesService {
  private http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<StorageSummary[]>('/api/storages'));
  }

  /** gemeinsame Reihenfolge der Kacheln speichern */
  order(ids: number[]) {
    return firstValueFrom(this.http.put<StorageSummary[]>('/api/storages/order', { ids }));
  }

  get(id: number) {
    return firstValueFrom(this.http.get<Storage>(`/api/storages/${id}`));
  }

  create(input: StorageInput) {
    return firstValueFrom(this.http.post<{ storage: Storage; report: RefreshReport }>('/api/storages', input));
  }

  update(id: number, input: StorageInput) {
    return firstValueFrom(this.http.put<{ storage: Storage; report?: RefreshReport }>(`/api/storages/${id}`, input));
  }

  scan(id: number) {
    return firstValueFrom(this.http.post<{ storage: Storage; report: RefreshReport }>(`/api/storages/${id}/scan`, {}));
  }

  delete(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/storages/${id}`));
  }

  status() {
    return firstValueFrom(this.http.get<Status>('/api/status'));
  }
}

/** 3240 Stein → "1 Shulker · 23 Stacks · 40" */
export function amountLabel(m: { shulkers: number; stacks: number; items: number }): string {
  const parts: string[] = [];
  if (m.shulkers) parts.push(`${m.shulkers} Shulker`);
  if (m.stacks) parts.push(`${m.stacks} ${m.stacks === 1 ? 'Stack' : 'Stacks'}`);
  if (m.items || !parts.length) parts.push(String(m.items));
  return parts.join(' · ');
}

/** SQLite liefert UTC als "YYYY-MM-DD HH:MM:SS" */
export function formatDate(sqlite: string): string {
  const iso = sqlite.includes('T') ? sqlite : sqlite.replace(' ', 'T') + 'Z';
  return new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}

/** Fehler einzelner Lager/Projekte aus einem Aktualisierungs-Bericht */
export function reportErrors(report?: RefreshReport): string {
  if (!report) return '';
  return [
    ...report.storages.filter((s) => s.error).map((s) => `Lager „${s.name}“: ${s.error}`),
    ...report.projects.filter((p) => p.error).map((p) => `Baufortschritt: ${p.error}`),
  ].join(' · ');
}

export function errorMessage(err: unknown): string {
  const e = err as { error?: { error?: string }; status?: number };
  if (e?.error?.error) return e.error.error;
  if (e?.status === 0) return 'API nicht erreichbar. Läuft der API-Server (npm run dev in api/)?';
  return 'Unbekannter Fehler.';
}

/**
 * Verkleinert ein Bild im Browser (längste Seite max. maxSize px) und speichert es als WebP
 * (Fallback JPEG). So bleiben auch 4K-Screenshots klein.
 */
export async function resizeImage(file: Blob, maxSize: number, quality: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const toBlob = (type: string) => new Promise<Blob | null>((r) => canvas.toBlob(r, type, quality));
  const webp = await toBlob('image/webp');
  if (webp?.type === 'image/webp') return webp;
  return (await toBlob('image/jpeg'))!;
}

/** Erstes Bild aus einem Einfüge-/Ablege-Ereignis */
export function imageFromTransfer(data: DataTransfer | null): File | undefined {
  return [...(data?.files ?? [])].find((f) => f.type.startsWith('image/'));
}

/** Behälter-Arten aus dem Scan → Anzeige (Doppelkisten zählen als zwei Kisten) */
export const CONTAINER_GROUPS = [
  { key: 'chest', types: ['chest', 'trapped_chest'], icon: 'chest', one: 'Kiste', many: 'Kisten' },
  { key: 'barrel', types: ['barrel'], icon: 'barrel', one: 'Fass', many: 'Fässer' },
  { key: 'shulker', types: ['shulker_box'], icon: 'shulker_box', one: 'Shulker', many: 'Shulker' },
];

/** Behälter nach Art zusammengefasst, z. B. 3 Kisten, 1 Fass */
export function containerGroups(containers: Array<{ type: string; n: number }>) {
  return CONTAINER_GROUPS
    .map((g) => ({ ...g, n: containers.filter((c) => g.types.includes(c.type)).reduce((a, c) => a + c.n, 0) }))
    .filter((g) => g.n > 0);
}
