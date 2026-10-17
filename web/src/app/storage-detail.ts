import { Component, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DecimalPipe } from '@angular/common';
import { StorageForm } from './storage-form';
import {
  DIMENSION_LABELS, Storage, StorageInput, StoragesService, amountLabel, containerGroups, errorMessage, formatDate, reportErrors,
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
    <a routerLink="/lager" class="back-button"><app-icon name="arrow-left" [size]="16" />Alle Lager</a>

    @if (storage(); as s) {
      <div class="detail-top">
      <header class="detail-head">
        <div class="detail-title">
          <span class="eyebrow">Lager</span>
          <h1>{{ s.name }}</h1>
          <div class="tile-chips">
            <span class="chip-gray" title="Mittelpunkt"><app-icon name="map-pin" [size]="13" />{{ s.x }} / {{ s.y }} / {{ s.z }}</span>
            <span class="chip-gray" title="Bereich in Blöcken (Breite × Tiefe × Höhe)">
              <app-icon name="box" [size]="13" />{{ 2 * s.radius + 1 }} × {{ 2 * s.radius + 1 }} × {{ 2 * s.height + 1 }} Blöcke
            </span>
            <span class="chip-gray"><app-icon name="world" [size]="13" />{{ dims[s.dimension] }}</span>
          </div>
        </div>
        <div class="head-actions">
          <button type="button" class="secondary with-icon" (click)="editOpen.set(!editOpen())" [attr.aria-expanded]="editOpen()">
            <app-icon name="pencil" [size]="15" />Bereich bearbeiten
          </button>
          <a class="button-link with-icon" routerLink="/karte" [queryParams]="{ x: s.x, y: s.y, z: s.z, dim: s.dimension }">
            <app-icon name="map-2" [size]="15" />Auf Karte zeigen
          </a>
          <button type="button" class="with-icon" (click)="scan(s)" [disabled]="busy()">
            <app-icon name="refresh" [size]="15" [class.spin]="scanning()" />{{ scanning() ? 'Scanne …' : 'Jetzt scannen' }}
          </button>
        </div>
      </header>

      <!-- Bereich bearbeiten: klappt unter dem Kopf auf -->
      <div class="create-reveal" [class.open]="editOpen()" [attr.inert]="editOpen() ? null : ''">
        <div class="create-inner">
          <section class="card create-card">
            <header class="create-head">
              <h2>Bereich bearbeiten</h2>
              <button type="button" class="icon-btn" (click)="editOpen.set(false)" title="Schließen" aria-label="Schließen">
                <app-icon name="x" [size]="18" />
              </button>
            </header>
            <app-storage-form [initial]="s" submitLabel="Speichern & scannen" [busy]="busy()" (saved)="save(s, $event)">
              @if (auth.isAdmin()) {
                <button formExtra type="button" class="text-button danger-text with-icon" (click)="remove(s)">
                  <app-icon name="trash" [size]="15" />Lager löschen
                </button>
              }
            </app-storage-form>
          </section>
        </div>
      </div>
      </div>

      @if (error()) {
        <p class="error">{{ error() }}</p>
      }

      <section class="card storage-overview">
        <dl class="tile-stats big">
          <div><dt>Items</dt><dd>{{ s.itemCount | number }}</dd></div>
          <div><dt>Sorten</dt><dd>{{ s.itemTypes | number }}</dd></div>
          <div><dt>Behälter</dt><dd>{{ s.containerCount | number }}</dd></div>
        </dl>
        @if (groups(s).length) {
          <div class="tile-chips">
            @for (g of groups(s); track g.key) {
              <span class="chip-gray chip-item"><app-item-icon [item]="g.icon" [size]="16" />{{ g.n }} {{ g.n === 1 ? g.one : g.many }}</span>
            }
            @if (!s.includeShulkers) { <span class="chip-gray">Shulker nicht eingerechnet</span> }
          </div>
        }

        @if (s.projects.length) {
          <div class="supply">
            <span class="supply-label"><app-icon name="hammer" [size]="15" />Versorgt</span>
            <div class="supply-links">
              @for (p of s.projects; track p.id) {
                <a class="supply-link" [routerLink]="['/projekte', p.id]">{{ p.name }}<app-icon name="arrow-right" [size]="14" /></a>
              }
            </div>
          </div>
        }

        <p class="scan-meta">
          @if (s.scannedAt) {
            Zuletzt gescannt {{ date(s.scannedAt) }}
            @if (s.scanMs !== null) { <span class="sep" aria-hidden="true"></span>{{ s.scannedPositions | number }} Blöcke in {{ s.scanMs / 1000 | number: '1.1-1' }} s }
          } @else {
            Noch nicht gescannt
          }
        </p>
        @if (s.lastError) {
          <p class="error small with-icon"><app-icon name="alert-triangle" [size]="14" />Letzter Scan fehlgeschlagen: {{ s.lastError }}</p>
        }
        @if (s.unloadedPositions) {
          <p class="warn small-text with-icon"><app-icon name="alert-triangle" [size]="14" />{{ s.unloadedPositions | number }} Blöcke lagen in nicht geladenen Bereichen und wurden übersprungen.</p>
        }
      </section>

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
    } @else if (error()) {
      <p class="error">{{ error() }}</p>
    } @else {
      <p class="hint">Lade …</p>
    }
  `,
  host: { '(document:keydown.escape)': 'editOpen.set(false)' },
})
export class StorageDetail {
  private api = inject(StoragesService);
  private router = inject(Router);

  id = input.required<string>();
  storage = signal<Storage | undefined>(undefined);
  error = signal('');
  busy = signal(false);
  scanning = signal(false);
  editOpen = signal(false);
  query = signal('');
  groups = (s: Storage) => containerGroups(s.containers);

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

  async scan(s: Storage) {
    this.scanning.set(true);
    await this.run(() => this.api.scan(s.id));
    this.scanning.set(false);
  }

  async save(s: Storage, input: StorageInput) {
    if (await this.run(() => this.api.update(s.id, input))) this.editOpen.set(false);
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

  /** true, wenn die Anfrage geklappt hat */
  private async run(request: () => Promise<{ storage: Storage; report?: Parameters<typeof reportErrors>[0] }>) {
    this.busy.set(true);
    try {
      const { storage, report } = await request();
      this.storage.set(storage);
      this.error.set(reportErrors(report));
      return true;
    } catch (err) {
      this.error.set(errorMessage(err));
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
