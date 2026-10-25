import { Component, ElementRef, Injectable, computed, inject, output, signal, viewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { KeyValuePipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { DIMENSION_LABELS, Dimension, errorMessage } from './projects.service';
import { Icon } from './icon';

export type MarkerCategory = 'base' | 'farm' | 'sight' | 'other';

export interface MarkerInput {
  name: string;
  category: MarkerCategory;
  description: string;
  dimension: Dimension;
  x: number;
  y: number;
  z: number;
}

export interface MapMarker extends MarkerInput {
  id: number;
  userId: number | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
}

/** Symbol aus der Item-Bibliothek, Farbe des Namensschilds, Name der Ebene in BlueMap */
export const MARKER_CATEGORIES: Record<MarkerCategory, { label: string; set: string; item: string; color: string }> = {
  base: { label: 'Basis', set: 'Basen', item: 'red_bed', color: '#ff7a7a' },
  farm: { label: 'Farm', set: 'Farmen', item: 'wheat', color: '#f6c35b' },
  sight: { label: 'Sehenswürdigkeit', set: 'Sehenswürdigkeiten', item: 'compass', color: '#c792ff' },
  other: { label: 'Sonstiges', set: 'Sonstiges', item: 'book', color: '#aab4c8' },
};
export const MARKER_CATEGORY_KEYS = Object.keys(MARKER_CATEGORIES) as MarkerCategory[];
export const markerIcon = (c: MarkerCategory) => `/items/${MARKER_CATEGORIES[c].item}.png`;

@Injectable({ providedIn: 'root' })
export class MarkersService {
  private http = inject(HttpClient);
  async list() { return (await firstValueFrom(this.http.get<{ markers: MapMarker[] }>('/api/markers'))).markers; }
  async create(body: MarkerInput) { return (await firstValueFrom(this.http.post<{ marker: MapMarker }>('/api/markers', body))).marker; }
  async update(id: number, body: MarkerInput) { return (await firstValueFrom(this.http.put<{ marker: MapMarker }>(`/api/markers/${id}`, body))).marker; }
  remove(id: number) { return firstValueFrom(this.http.delete(`/api/markers/${id}`)); }
}

/**
 * Dialog für einen Marker: neu setzen, bearbeiten (Ersteller und Admins) oder nur ansehen.
 * Koordinaten kommen vom Klick in die Karte, lassen sich aber von Hand ändern.
 */
@Component({
  selector: 'app-marker-dialog',
  imports: [Icon, KeyValuePipe],
  template: `
    <dialog #dialog class="glass-dialog marker-dialog" (click)="backdropClose($event)" (close)="error.set('')">
      <div class="dialog-body">
        <header class="project-head">
          <div class="marker-dialog-title">
            <img class="marker-dialog-icon" [src]="icon(category())" alt="" />
            <div>
              <h2>{{ title() }}</h2>
              @if (marker(); as m) {
                <p class="hint">Gesetzt von {{ m.createdBy ?? 'gelöschtem Konto' }}<span class="sep" aria-hidden="true"></span>{{ day(m.createdAt) }}</p>
              }
            </div>
          </div>
          <button type="button" class="icon-btn" (click)="close()" title="Schließen" aria-label="Schließen"><app-icon name="x" [size]="18" /></button>
        </header>

        @if (editable()) {
          <form class="storage-form marker-form" (submit)="save($event, form)" #form>
            <label class="wide">Name
              <input name="name" type="text" required maxlength="40" placeholder="z. B. Kettus Basis" [value]="marker()?.name ?? ''" autocomplete="off" />
            </label>
            <fieldset class="wide marker-categories">
              <legend>Kategorie</legend>
              @for (c of categoryKeys; track c) {
                <label class="marker-category" [attr.data-category]="c">
                  <input type="radio" name="category" [value]="c" [checked]="category() === c" (change)="category.set(c)" />
                  <img [src]="icon(c)" alt="" />
                  <span>{{ categories[c].label }}</span>
                </label>
              }
            </fieldset>
            <label>X <input name="x" type="number" step="1" required [value]="position().x" /></label>
            <label>Y <input name="y" type="number" step="1" required [value]="position().y" /></label>
            <label>Z <input name="z" type="number" step="1" required [value]="position().z" /></label>
            <label>Dimension
              <select name="dimension">
                @for (o of dimensions | keyvalue: keep; track o.key) {
                  <option [value]="o.key" [selected]="position().dimension === o.key">{{ o.value }}</option>
                }
              </select>
            </label>
            <label class="wide"><span>Beschreibung <span class="optional">optional</span></span>
              <textarea name="description" rows="3" maxlength="300" placeholder="z. B. Eingang über die Brücke, Tür mit Knopf">{{ marker()?.description ?? '' }}</textarea>
            </label>
            @if (error()) { <p class="error wide">{{ error() }}</p> }
            <div class="wide form-footer">
              @if (marker()) {
                <button formExtra type="button" class="text-button danger-text with-icon" (click)="remove()" [disabled]="busy()">
                  <app-icon name="trash" [size]="15" />Löschen
                </button>
              }
              <button type="button" class="secondary" (click)="close()">Abbrechen</button>
              <button type="submit" [disabled]="busy()">{{ busy() ? 'Speichert …' : marker() ? 'Speichern' : 'Marker setzen' }}</button>
            </div>
          </form>
        } @else if (marker(); as m) {
          <dl class="marker-facts">
            <div><dt>Kategorie</dt><dd>{{ categories[m.category].label }}</dd></div>
            <div><dt>Koordinaten</dt><dd class="mono">{{ m.x }} {{ m.y }} {{ m.z }}</dd></div>
            <div><dt>Dimension</dt><dd>{{ dimensions[m.dimension] }}</dd></div>
          </dl>
          @if (m.description) { <p class="marker-description">{{ m.description }}</p> }
          <div class="form-footer">
            <button type="button" class="secondary with-icon" (click)="copy(m)">
              <app-icon [name]="copied() ? 'check' : 'copy'" [size]="15" />{{ copied() ? 'Kopiert' : 'Koordinaten kopieren' }}
            </button>
          </div>
        }
      </div>
    </dialog>
  `,
})
export class MarkerDialog {
  private api = inject(MarkersService);
  private dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  /** nach Anlegen, Ändern oder Löschen: Karte neu laden */
  changed = output<void>();

  protected readonly categories = MARKER_CATEGORIES;
  protected readonly categoryKeys = MARKER_CATEGORY_KEYS;
  protected readonly dimensions = DIMENSION_LABELS;
  protected keep = () => 0;
  protected icon = markerIcon;

  protected marker = signal<MapMarker | null>(null);
  protected category = signal<MarkerCategory>('base');
  protected position = signal<{ x: number; y: number; z: number; dimension: Dimension }>({ x: 0, y: 64, z: 0, dimension: 'minecraft:overworld' });
  protected busy = signal(false);
  protected error = signal('');
  protected copied = signal(false);
  protected editable = computed(() => !this.marker() || this.marker()!.canEdit);
  protected title = computed(() => this.marker()?.name ?? 'Neuer Marker');

  /** Neuer Marker an einer Stelle der Karte */
  openNew(at: { x: number; y: number; z: number; dimension: Dimension }) {
    this.marker.set(null);
    this.category.set('base');
    this.position.set(at);
    this.show();
  }

  /** Vorhandener Marker: bearbeiten, wenn erlaubt, sonst ansehen */
  openMarker(m: MapMarker) {
    this.marker.set(m);
    this.category.set(m.category);
    this.position.set({ x: m.x, y: m.y, z: m.z, dimension: m.dimension });
    this.copied.set(false);
    this.show();
  }

  private show() {
    this.error.set('');
    const el = this.dialog().nativeElement;
    if (!el.open) el.showModal();
    // Neuer Marker: gleich den Namen tippen
    if (!this.marker()) setTimeout(() => el.querySelector<HTMLInputElement>('input[name=name]')?.focus());
  }

  close() {
    this.dialog().nativeElement.close();
  }

  protected backdropClose(event: MouseEvent) {
    if (event.target === this.dialog().nativeElement) this.close();
  }

  protected async save(event: Event, form: HTMLFormElement) {
    event.preventDefault();
    const d = new FormData(form);
    const body: MarkerInput = {
      name: String(d.get('name') ?? ''),
      category: this.category(),
      description: String(d.get('description') ?? ''),
      dimension: String(d.get('dimension')) as Dimension,
      x: Number(d.get('x')),
      y: Number(d.get('y')),
      z: Number(d.get('z')),
    };
    await this.run(() => (this.marker() ? this.api.update(this.marker()!.id, body) : this.api.create(body)));
  }

  protected async remove() {
    const m = this.marker();
    if (!m || !confirm(`Marker „${m.name}“ löschen?`)) return;
    await this.run(() => this.api.remove(m.id));
  }

  private async run(action: () => Promise<unknown>) {
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
      this.changed.emit();
      this.close();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected async copy(m: MapMarker) {
    await navigator.clipboard?.writeText(`${m.x} ${m.y} ${m.z}`).catch(() => undefined);
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }

  protected day(iso: string) {
    return new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z')).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
}
