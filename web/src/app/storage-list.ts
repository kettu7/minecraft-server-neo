import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DecimalPipe } from '@angular/common';
import { StorageForm } from './storage-form';
import { ItemIcon } from './items';
import { Icon } from './icon';
import { DIMENSION_LABELS, StorageInput, StorageSummary, StoragesService, containerGroups, errorMessage, reportErrors } from './projects.service';

@Component({
  selector: 'app-storage-list',
  imports: [RouterLink, DecimalPipe, StorageForm, ItemIcon, Icon],
  template: `
    <header class="page-head">
      <span class="eyebrow">Gespiegelt aus der Welt</span>
      <h1>Lager</h1>
      <p class="hint">Kisten, Fässer und Shulker aus der Welt.</p>
    </header>

    <!-- Neues Lager: erst nur der Button, ein Klick klappt das Formular auf -->
    <div class="create-panel" [class.open]="createOpen()">
      <button type="button" class="wide-button with-icon" (click)="createOpen.set(true)" [attr.aria-expanded]="createOpen()"
              [attr.tabindex]="createOpen() ? -1 : null">
        <app-icon name="plus" [size]="18" [stroke]="2.5" />Neues Lager anlegen
      </button>
      <div class="create-reveal" [attr.inert]="createOpen() ? null : ''">
        <div class="create-inner">
          <section class="card create-card">
            <header class="create-head">
              <h2>Neues Lager</h2>
              <button type="button" class="icon-btn" (click)="closeCreate()" title="Schließen" aria-label="Schließen">
                <app-icon name="x" [size]="18" />
              </button>
            </header>
            <p class="hint">Mittelpunkt und Radius des Bereichs festlegen – die Koordinaten siehst du im Spiel mit <kbd>F3</kbd>.</p>
            <app-storage-form submitLabel="Anlegen & scannen" [busy]="busy()" (saved)="create($event)" />
            @if (error()) {
              <p class="error">{{ error() }}</p>
            }
          </section>
        </div>
      </div>
    </div>

    <section>
      @if (loading()) {
        <p class="hint">Lade …</p>
      } @else if (!storages().length) {
        <p class="hint">Noch keine Lager.</p>
      } @else {
        <ul class="projects storage-tiles">
          @for (s of storages(); track s.id) {
            <li>
              <a class="card storage-tile" [routerLink]="['/lager', s.id]">
                <div class="storage-tile-head">
                  <span class="storage-tile-icon"><app-item-icon item="chest" [size]="30" /></span>
                  <div class="storage-tile-title">
                    <strong>{{ s.name }}</strong>
                    <span class="storage-tile-sub">
                      <app-icon name="map-pin" [size]="13" />
                      <span class="mono">{{ s.x }} / {{ s.y }} / {{ s.z }}</span>
                      @if (s.dimension !== 'minecraft:overworld') { <span class="sep" aria-hidden="true"></span>{{ dimensions[s.dimension] }} }
                    </span>
                  </div>
                  <app-icon class="tile-arrow" name="arrow-right" [size]="18" />
                </div>

                <dl class="tile-stats">
                  <div><dt>Items</dt><dd>{{ s.itemCount | number }}</dd></div>
                  <div><dt>Sorten</dt><dd>{{ s.itemTypes | number }}</dd></div>
                  <div><dt>Behälter</dt><dd>{{ s.containerCount | number }}</dd></div>
                </dl>

                @if (groups(s).length) {
                  <div class="tile-chips">
                    @for (g of groups(s); track g.key) {
                      <span class="chip-gray chip-item"><app-item-icon [item]="g.icon" [size]="16" />{{ g.n }} {{ g.n === 1 ? g.one : g.many }}</span>
                    }
                  </div>
                }

                @if (s.projects.length) {
                  <p class="tile-foot"><app-icon name="hammer" [size]="13" />Für {{ projectNames(s) }}</p>
                }
                @if (s.lastError) {
                  <p class="error small with-icon"><app-icon name="alert-triangle" [size]="14" />{{ s.lastError }}</p>
                }
              </a>
            </li>
          }
        </ul>
      }
    </section>
  `,
  host: { '(document:keydown.escape)': 'closeCreate()' },
})
export class StorageList {
  private api = inject(StoragesService);
  private router = inject(Router);

  storages = signal<StorageSummary[]>([]);
  loading = signal(true);
  busy = signal(false);
  error = signal('');
  createOpen = signal(false);
  readonly dimensions = DIMENSION_LABELS;

  constructor() {
    this.api.list()
      .then((s) => this.storages.set(s))
      .catch((err) => this.error.set(errorMessage(err)))
      .finally(() => this.loading.set(false));
  }

  closeCreate() {
    if (this.busy()) return;
    this.createOpen.set(false);
    this.error.set('');
  }

  groups = (s: StorageSummary) => containerGroups(s.containers);

  projectNames(s: StorageSummary) {
    return s.projects.map((p) => p.name).join(', ');
  }

  async create(input: StorageInput) {
    this.busy.set(true);
    this.error.set('');
    try {
      const { storage, report } = await this.api.create(input);
      const problem = report.error ?? reportErrors(report);
      // Bei Scan-Fehler bleibt man hier und sieht die Meldung; das Lager ist trotzdem angelegt
      if (problem) {
        this.error.set(`Lager angelegt, aber Scan fehlgeschlagen: ${problem}`);
        this.storages.set(await this.api.list());
      } else {
        this.router.navigate(['/lager', storage.id]);
      }
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
