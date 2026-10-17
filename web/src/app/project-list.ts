import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DecimalPipe, PercentPipe } from '@angular/common';
import { ItemIcon } from './items';
import { Icon } from './icon';
import { ProjectsService, ProjectSummary, errorMessage } from './projects.service';
import { Reorder } from './reorder';

/** Liste in die Reihenfolge der IDs bringen (Vorschau beim Ziehen) */
const byIds = <T extends { id: number }>(list: T[], ids: number[]) =>
  ids.map((id) => list.find((x) => x.id === id)).filter((x): x is T => !!x);

@Component({
  selector: 'app-project-list',
  imports: [Reorder, RouterLink, DecimalPipe, PercentPipe, ItemIcon, Icon],
  template: `
    <header class="page-head">
      <span class="eyebrow">Gemeinsam bauen</span>
      <h1>Bauprojekte</h1>
      <p class="hint">Blaupausen, Material und Baufortschritt im Blick.</p>
    </header>

    <!-- Neues Bauprojekt: erst nur der Button, ein Klick klappt das Formular auf -->
    <div class="create-panel" [class.open]="createOpen()">
      <button type="button" class="wide-button with-icon" (click)="openCreate()" [attr.aria-expanded]="createOpen()"
              [attr.tabindex]="createOpen() ? -1 : null">
        <app-icon name="plus" [size]="18" [stroke]="2.5" />Neues Bauprojekt anlegen
      </button>
      <div class="create-reveal" [attr.inert]="createOpen() ? null : ''">
        <div class="create-inner">
        <section class="card create-card">
          <header class="create-head">
            <h2>Neues Bauprojekt</h2>
            <button type="button" class="icon-btn" (click)="closeCreate()" title="Schließen" aria-label="Schließen">
              <app-icon name="x" [size]="18" />
            </button>
          </header>
          <p class="hint">
            Bauprojekte entstehen aus Litematica-Schematics (<code>.litematic</code>). Fertige Bauten findest du z. B. bei
            <a href="https://www.shulkr.com/" target="_blank" rel="noopener noreferrer">Shulkr</a>.
          </p>
          <form class="upload" (submit)="create($event, nameInput, descInput, fileInput)">
            <label>
              Name
              <input #nameInput type="text" placeholder="z. B. Starterhaus (sonst Name aus der Datei)" maxlength="80" />
            </label>
            <label>
              Beschreibung
              <input #descInput type="text" placeholder="optional, z. B. Koordinaten" maxlength="200" />
            </label>
            <label>
              Schematic
              <input #fileInput type="file" accept=".litematic" required />
            </label>
            <button type="submit" [disabled]="busy()">{{ busy() ? 'Wird gelesen …' : 'Materialliste erstellen' }}</button>
          </form>
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
      } @else if (!projects().length) {
        <p class="hint">Noch keine Projekte.</p>
      } @else {
        <ul class="projects" [appReorder]="ids()" (reorder)="preview($event)" (reorderEnd)="saveOrder($event)">
          @for (p of projects(); track p.id) {
            <li [attr.data-reorder-id]="p.id">
              <a class="card project with-thumb" [routerLink]="['/projekte', p.id]">
                <div class="project-thumb">
                  @if (p.image) {
                    <img [src]="p.image + '&size=thumb'" alt="" loading="lazy" />
                  } @else {
                    <app-item-icon item="crafting_table" [size]="40" />
                  }
                </div>
                <div class="project-body">
                <div class="project-head">
                  <strong>{{ p.name }}</strong>
                  <span class="badge">{{ ratio(p.placed, p.required) | percent }}</span>
                </div>
                <div class="tile-chips">
                  <span class="chip-gray" title="Maße (Breite × Höhe × Tiefe)"><app-icon name="box" [size]="13" />{{ p.sizeX }}×{{ p.sizeY }}×{{ p.sizeZ }}</span>
                  <span class="chip-gray" title="Items insgesamt"><app-icon name="stack-2" [size]="13" />{{ p.required | number }} Items</span>
                </div>
                @if (p.description) { <p class="hint project-desc">{{ p.description }}</p> }
                <div class="mini-progress">
                  <span class="hint">Im Lager</span>
                  <div class="bar"><div [style.width.%]="ratio(p.covered, p.open) * 100"></div></div>
                  <span class="hint">{{ ratio(p.covered, p.open) | percent }}</span>
                  <span class="hint">Verbaut</span>
                  <div class="bar built"><div [style.width.%]="ratio(p.placed, p.required) * 100"></div></div>
                  <span class="hint">{{ ratio(p.placed, p.required) | percent }}</span>
                </div>
                </div>
              </a>
            </li>
          }
        </ul>
        @if (projects().length > 1) {
          <p class="hint reorder-hint with-icon"><app-icon name="selector" [size]="14" />Zum Sortieren eine Kachel 1 Sekunde gedrückt halten und ziehen.</p>
        }
      }
    </section>
  `,
  host: { '(document:keydown.escape)': 'closeCreate()' },
})
export class ProjectList {
  protected ids = computed(() => this.projects().map((x) => x.id));

  /** Vorschau während des Ziehens */
  protected preview(ids: number[]) {
    this.projects.set(byIds(this.projects(), ids));
  }

  /** Reihenfolge für alle speichern; bei Fehler den Serverstand zurückholen */
  protected async saveOrder(ids: number[]) {
    try {
      this.projects.set(await this.api.order(ids));
    } catch (err) {
      this.error.set(errorMessage(err));
      this.projects.set(await this.api.list());
    }
  }

  private api = inject(ProjectsService);
  private router = inject(Router);

  projects = signal<ProjectSummary[]>([]);
  loading = signal(true);
  busy = signal(false);
  error = signal('');
  createOpen = signal(false);
  private nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');

  constructor() {
    this.load();
  }

  async load() {
    try {
      this.projects.set(await this.api.list());
      this.error.set('');
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  openCreate() {
    this.createOpen.set(true);
    // Nach dem Aufklappen ins erste Feld
    setTimeout(() => this.nameInput()?.nativeElement.focus(), 250);
  }

  closeCreate() {
    if (this.busy()) return;
    this.createOpen.set(false);
    this.error.set('');
  }

  ratio(part: number, total: number) {
    return total ? Math.min(1, part / total) : 1;
  }

  async create(event: Event, name: HTMLInputElement, desc: HTMLInputElement, file: HTMLInputElement) {
    event.preventDefault();
    const f = file.files?.[0];
    if (!f) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const project = await this.api.create(name.value, desc.value, f);
      this.router.navigate(['/projekte', project.id]);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
