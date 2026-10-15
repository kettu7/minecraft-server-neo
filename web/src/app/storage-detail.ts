import { Component, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DecimalPipe } from '@angular/common';
import { StorageForm } from './storage-form';
import {
  DIMENSION_LABELS, Storage, StorageInput, StoragesService, amountLabel, errorMessage, formatDate, reportErrors,
} from './projects.service';
import { ItemIcon, ItemLanguageSwitch, ItemLibrary } from './items';
import { AuthService } from './auth';
import { Icon } from './icon';

/** Seite lädt sich regelmäßig neu, damit die automatische Aktualisierung sichtbar wird */
const POLL_MS = 30_000;

@Component({
  selector: 'app-storage-detail',
  imports: [RouterLink, DecimalPipe, StorageForm, ItemIcon, ItemLanguageSwitch, Icon],
  template: `
    <a routerLink="/lager" class="back"><app-icon name="arrow-left" [size]="14" />Alle Lager</a>

    @if (storage(); as s) {
      <header class="detail-head">
        <div>
          <span class="eyebrow">Lager</span>
          <h1>{{ s.name }}</h1>
          <p class="hint">
            {{ dims[s.dimension] }} · Mitte {{ s.x }} / {{ s.y }} / {{ s.z }} · Radius {{ s.radius }} · Höhe ±{{ s.height }}
          </p>
        </div>
        <div class="head-actions">
          <a class="button-link" routerLink="/karte" [queryParams]="{ x: s.x, y: s.y, z: s.z, dim: s.dimension }">Auf Karte zeigen</a>
          <button (click)="scan(s)" [disabled]="busy()">{{ busy() ? 'Scanne …' : 'Jetzt scannen' }}</button>
          @if (auth.isAdmin()) {
            <button class="danger" (click)="remove(s)">Löschen</button>
          }
        </div>
      </header>

      <section class="card stats">
        <div><strong>{{ s.itemCount | number }}</strong><span class="hint">Items</span></div>
        <div><strong>{{ s.itemTypes }}</strong><span class="hint">Sorten</span></div>
        <div>
          <strong>{{ s.containerCount }}</strong>
          <span class="hint">
            Behälter
            @for (c of s.containers; track c.type) { · {{ c.n }}× {{ name(c.type) }} }
          </span>
        </div>
        <div>
          <strong>{{ s.scannedAt ? date(s.scannedAt) : '–' }}</strong>
          <span class="hint">
            zuletzt gescannt
            @if (s.scanMs !== null) { · {{ s.scannedPositions | number }} Positionen in {{ s.scanMs / 1000 | number: '1.1-1' }} s }
          </span>
        </div>
      </section>

      @if (s.lastError) {
        <p class="error">Letzter Scan fehlgeschlagen: {{ s.lastError }}</p>
      }
      @if (s.unloadedPositions) {
        <p class="warn">{{ s.unloadedPositions | number }} Positionen waren nicht geladen und wurden übersprungen.</p>
      }
      @if (error()) {
        <p class="error">{{ error() }}</p>
      }

      <label class="card toggle">
        <input type="checkbox" [checked]="s.includeShulkers" (change)="toggleShulkers(s)" [disabled]="busy()" />
        <span>
          <strong>Shulkerkisten einrechnen</strong>
          <span class="hint">Abgestellte Shulker und Shulker in Kisten. Ausschalten, um sie z. B. als privates Lager zu nutzen.</span>
        </span>
      </label>

      @if (s.projects.length) {
        <p class="hint">
          Versorgt:
          @for (p of s.projects; track p.id; let last = $last) {
            <a [routerLink]="['/projekte', p.id]">{{ p.name }}</a>@if (!last) {, }
          }
        </p>
      }

      <div class="toolbar">
        <div class="toolbar-group">
          <input type="search" placeholder="Item suchen …" (input)="query.set($any($event.target).value)" />
          <app-item-lang />
        </div>
        <span class="hint">{{ filtered().length }} von {{ s.stock.length }} Sorten</span>
      </div>

      <table class="materials">
        <thead>
          <tr><th>Item</th><th class="num">Bestand</th><th class="num">in Shulkern / Stacks</th></tr>
        </thead>
        <tbody>
          @for (i of filtered(); track i.item) {
            <tr>
              <td>
                <div class="item-cell">
                  <app-item-icon [item]="i.item" />
                  <div><strong>{{ name(i.item) }}</strong><div class="hint mono">{{ i.item }}</div></div>
                </div>
              </td>
              <td class="num">{{ i.count | number }}</td>
              <td class="num hint">{{ amount(i) }}</td>
            </tr>
          } @empty {
            <tr><td colspan="3" class="hint">{{ s.scannedAt ? 'Keine Items gefunden.' : 'Noch nicht gescannt.' }}</td></tr>
          }
        </tbody>
      </table>

      <details class="card">
        <summary>Bereich bearbeiten</summary>
        <app-storage-form [initial]="s" submitLabel="Speichern" [busy]="busy()" (saved)="save(s, $event)" />
      </details>
    } @else if (error()) {
      <p class="error">{{ error() }}</p>
    } @else {
      <p class="hint">Lade …</p>
    }
  `,
})
export class StorageDetail {
  private api = inject(StoragesService);
  private router = inject(Router);

  id = input.required<string>();
  storage = signal<Storage | undefined>(undefined);
  error = signal('');
  busy = signal(false);
  query = signal('');

  filtered = computed(() => {
    const q = this.query();
    return (this.storage()?.stock ?? []).filter((i) => this.library.matches(i.item, q));
  });

  readonly dims = DIMENSION_LABELS;
  protected auth = inject(AuthService);
  private library = inject(ItemLibrary);
  name = (id: string) => this.library.name(id);
  amount = amountLabel;
  date = formatDate;
  private timer?: ReturnType<typeof setInterval>;

  ngOnInit() {
    this.load();
    this.timer = setInterval(() => !this.busy() && this.load(), POLL_MS);
  }

  ngOnDestroy() {
    clearInterval(this.timer);
  }

  private load() {
    this.api.get(Number(this.id()))
      .then((s) => this.storage.set(s))
      .catch((err) => this.error.set(errorMessage(err)));
  }

  scan(s: Storage) {
    this.run(() => this.api.scan(s.id));
  }

  save(s: Storage, input: StorageInput) {
    this.run(() => this.api.update(s.id, input));
  }

  toggleShulkers(s: Storage) {
    const { name, x, y, z, radius, height, dimension } = s;
    this.run(() => this.api.update(s.id, { name, x, y, z, radius, height, dimension, includeShulkers: !s.includeShulkers }));
  }

  async remove(s: Storage) {
    if (!confirm(`Lager „${s.name}“ wirklich löschen? Projekte verlieren dann diesen Bestand.`)) return;
    try {
      await this.api.delete(s.id);
      this.router.navigate(['/lager']);
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  private async run(request: () => Promise<{ storage: Storage; report?: Parameters<typeof reportErrors>[0] }>) {
    this.busy.set(true);
    try {
      const { storage, report } = await request();
      this.storage.set(storage);
      this.error.set(reportErrors(report));
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
