import { Component, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DecimalPipe, KeyValuePipe, PercentPipe } from '@angular/common';
import {
  DIMENSION_LABELS, MIRROR_LABELS, Material, Placement, Project, ProjectsService, ROTATION_LABELS, StorageSummary, StoragesService,
  amountLabel, errorMessage, formatDate, reportErrors,
} from './projects.service';
import { ItemIcon, ItemLanguageSwitch, ItemLibrary } from './items';
import { AuthService } from './auth';
import { ProjectImage } from './project-image';
import { Icon } from './icon';

/** Seite lädt sich regelmäßig neu, damit die automatische Aktualisierung sichtbar wird */
const POLL_MS = 30_000;

@Component({
  selector: 'app-project-detail',
  imports: [RouterLink, DecimalPipe, PercentPipe, KeyValuePipe, ItemIcon, ItemLanguageSwitch, ProjectImage, Icon],
  template: `
    <a routerLink="/" class="back-button"><app-icon name="arrow-left" [size]="16" />Alle Projekte</a>

    @if (project(); as p) {
      <div class="detail-top">
      <header class="detail-head">
        <div class="detail-title">
          <span class="eyebrow">Bauprojekt</span>
          <h1>{{ p.name }}</h1>
          <div class="tile-chips">
            <span class="chip-gray" title="Schematic-Datei"><app-icon name="file" [size]="13" />{{ p.schematicName }}</span>
            <span class="chip-gray" title="Maße (Breite × Höhe × Tiefe)"><app-icon name="box" [size]="13" />{{ p.sizeX }}×{{ p.sizeY }}×{{ p.sizeZ }}</span>
            <span class="chip-gray" title="Blöcke insgesamt"><app-icon name="stack-2" [size]="13" />{{ p.totalBlocks | number }} Blöcke</span>
          </div>
          @if (p.description) { <p class="hint">{{ p.description }}</p> }
        </div>
        <div class="head-actions">
          <button type="button" class="secondary with-icon" (click)="editOpen.set(!editOpen())" [attr.aria-expanded]="editOpen()">
            <app-icon name="pencil" [size]="15" />Standort bearbeiten
          </button>
          <button type="button" class="with-icon" (click)="refresh(p)" [disabled]="busy()">
            <app-icon name="refresh" [size]="15" [class.spin]="refreshing()" />{{ refreshing() ? 'Aktualisiere …' : 'Aktualisieren' }}
          </button>
        </div>
      </header>

      <!-- Standort bearbeiten: klappt unter dem Kopf auf -->
      <div class="create-reveal" [class.open]="editOpen()" [attr.inert]="editOpen() ? null : ''">
        <div class="create-inner">
          <section class="card create-card">
            <header class="create-head">
              <h2>Standort bearbeiten</h2>
              <button type="button" class="icon-btn" (click)="editOpen.set(false)" title="Schließen" aria-label="Schließen">
                <app-icon name="x" [size]="18" />
              </button>
            </header>
            <p class="hint">Werte aus Litematica: <kbd>M</kbd> → Schematic Placements → Configure.</p>
            <form class="placement" (submit)="savePlacement($event, form)" #form>
              <label>X <input name="x" type="number" step="1" required [value]="p.placement?.x ?? ''" /></label>
              <label>Y <input name="y" type="number" step="1" required [value]="p.placement?.y ?? ''" /></label>
              <label>Z <input name="z" type="number" step="1" required [value]="p.placement?.z ?? ''" /></label>
              <label>Drehung
                <select name="rotation">
                  @for (o of rotations | keyvalue: keep; track o.key) {
                    <option [value]="o.key" [selected]="(p.placement?.rotation ?? 'NONE') === o.key">{{ o.value }}</option>
                  }
                </select>
              </label>
              <label>Spiegelung
                <select name="mirror">
                  @for (o of mirrors | keyvalue: keep; track o.key) {
                    <option [value]="o.key" [selected]="(p.placement?.mirror ?? 'NONE') === o.key">{{ o.value }}</option>
                  }
                </select>
              </label>
              <label>Dimension
                <select name="dimension">
                  @for (o of dimensions | keyvalue: keep; track o.key) {
                    <option [value]="o.key" [selected]="(p.placement?.dimension ?? 'minecraft:overworld') === o.key">{{ o.value }}</option>
                  }
                </select>
              </label>
              <div class="form-footer">
                @if (auth.isAdmin()) {
                  <button formExtra type="button" class="text-button danger-text with-icon" (click)="remove(p)">
                    <app-icon name="trash" [size]="15" />Projekt löschen
                  </button>
                }
                <button type="submit" [disabled]="busy()">Speichern & prüfen</button>
              </div>
            </form>
          </section>
        </div>
      </div>
      </div>

      @if (error()) {
        <p class="error">{{ error() }}</p>
      }

      <div class="detail-grid">
        <app-project-image [projectId]="p.id" [image]="p.image" (changed)="load()" />

        <section class="card progress-card">
          <div class="progress-block">
            <div class="progress-label">
              <strong>Im Lager vorrätig</strong>
              <span class="progress-pct">{{ ratioOf(p.covered, p.open) | percent }}</span>
            </div>
            <div class="bar big"><div [style.width.%]="ratioOf(p.covered, p.open) * 100"></div></div>
            <span class="hint">
              @if (p.storages.length) { {{ p.covered | number }} von {{ p.open | number }} offenen Items }
              @else { Noch kein Lager zugeordnet }
            </span>
          </div>

          <div class="progress-block">
            <div class="progress-label">
              <strong>Verbaut</strong>
              <span class="progress-pct built">{{ p.checkedAt ? (ratioOf(p.placed, p.required) | percent) : '–' }}</span>
            </div>
            <div class="bar big built"><div [style.width.%]="ratioOf(p.placed, p.required) * 100"></div></div>
            <span class="hint">
              @if (p.checkedAt) { {{ p.placed | number }} von {{ p.required | number }} Items<span class="sep" aria-hidden="true"></span>geprüft {{ date(p.checkedAt) }} }
              @else { Noch nicht geprüft – dafür den Standort angeben }
            </span>
          </div>

          <div class="progress-block location-block">
            <div class="progress-label"><strong>Standort in der Welt</strong></div>
            @if (p.placement; as pl) {
              <div class="tile-chips">
                <span class="coord"><b>X</b>{{ pl.x }}</span>
                <span class="coord"><b>Y</b>{{ pl.y }}</span>
                <span class="coord"><b>Z</b>{{ pl.z }}</span>
                <span class="chip-gray"><app-icon name="world" [size]="13" />{{ dimensions[pl.dimension] }}</span>
                @if (pl.rotation !== 'NONE') { <span class="chip-gray"><app-icon name="rotate" [size]="13" />{{ rotationShort[pl.rotation] }}</span> }
                @if (pl.mirror !== 'NONE') { <span class="chip-gray"><app-icon name="flip-vertical" [size]="13" />gespiegelt</span> }
              </div>
            } @else {
              <span class="hint">Noch kein Standort – <button type="button" class="link" (click)="editOpen.set(true)">jetzt angeben</button></span>
            }
            @if (p.unloadedBlocks) {
              <span class="warn small-text with-icon"><app-icon name="alert-triangle" [size]="14" />{{ p.unloadedBlocks | number }} Blöcke lagen in nicht geladenen Bereichen.</span>
            }
          </div>

          <div class="progress-actions">
            <div class="action-row">
              <a class="button-link with-icon" [href]="'/api/projects/' + p.id + '/schematic'" download>
                <app-icon name="file-download" [size]="15" />Blaupause
              </a>
              @if (p.placement) {
                <a class="button-link with-icon" routerLink="/karte"
                   [queryParams]="{ x: p.placement.x, y: p.placement.y, z: p.placement.z, dim: p.placement.dimension }">
                  <app-icon name="map-2" [size]="15" />Karte
                </a>
              }
            </div>
            <div class="action-row tertiary">
              <button type="button" class="text-button with-icon" popovertarget="schematic-help">
                <app-icon name="info-circle" [size]="15" />Blaupause im Spiel verwenden
              </button>
            </div>
            <p class="hint progress-meta">Aktualisiert sich automatisch alle {{ interval() }} Min.</p>
          </div>
        </section>
      </div>

      <div id="schematic-help" popover class="popover-card">
        <header class="create-head">
          <strong>Blaupause im Spiel verwenden</strong>
          <button type="button" class="icon-btn" popovertarget="schematic-help" popovertargetaction="hide" aria-label="Schließen">
            <app-icon name="x" [size]="16" />
          </button>
        </header>
        <ol>
          <li>Blaupause herunterladen.</li>
          <li>In den Ordner <code>schematics</code> deiner Instanz legen – in der Modrinth App: Instanz → ⋮ → Ordner öffnen.</li>
          <li>Im Spiel <kbd>M</kbd> → Load Schematics → Datei wählen → Load Schematic.</li>
        </ol>
      </div>

      <section class="card">
        <div class="section-head">
          <h3>Lager</h3>
          <a routerLink="/lager" class="more-link">Lager verwalten<app-icon name="arrow-right" [size]="15" /></a>
        </div>
        @if (!allStorages().length) {
          <p class="hint">Noch keine Lager. <a routerLink="/lager">Jetzt eins anlegen</a></p>
        } @else {
          <p class="hint">Der Bestand ausgewählter Lager zählt für dieses Projekt.</p>
          <div class="select-chips" role="group" aria-label="Lager für dieses Projekt">
            @for (s of allStorages(); track s.id) {
              <button type="button" class="select-chip" [class.on]="assigned().has(s.id)" [attr.aria-pressed]="assigned().has(s.id)"
                      (click)="toggleStorage(p, s.id)" [disabled]="busy()">
                <span class="select-check">@if (assigned().has(s.id)) { <app-icon name="check" [size]="13" [stroke]="3" /> }</span>
                {{ s.name }}
                <span class="select-meta">{{ s.itemCount | number }} Items</span>
              </button>
            }
          </div>
        }
      </section>

      <section class="mat-panel">
        <header class="mat-toolbar">
          <div class="segmented" role="group" aria-label="Materialien filtern">
            @for (f of filters(); track f.key) {
              <button type="button" [class.active]="filter() === f.key" [attr.aria-pressed]="filter() === f.key" (click)="filter.set(f.key)">
                {{ f.label }} <span class="seg-count">{{ f.count }}</span>
              </button>
            }
          </div>
          <div class="mat-toolbar-right">
            <span class="mat-legend">
              <span><i class="lg placed"></i>Verbaut</span>
              <span><i class="lg stock"></i>Im Lager</span>
              <span><i class="lg missing"></i>Fehlt</span>
            </span>
            <app-item-lang />
          </div>
        </header>

        <div class="mat-scroll">
          <table class="mat-table">
            <thead>
              <tr>
                <th>Material</th>
                <th class="num">Gesamt</th>
                <th class="num">Verbaut</th>
                <th class="num">Offen</th>
                <th class="num">Im Lager</th>
                <th class="progress-col">Fortschritt</th>
                <th class="status-col">Status</th>
              </tr>
            </thead>
            <tbody>
              @for (m of visible(); track m.item) {
                <tr [attr.data-state]="state(m)">
                  <td>
                    <div class="item-cell">
                      <app-item-icon [item]="m.item" />
                      <div class="item-text">
                        <strong>{{ name(m.item) }}</strong>
                        <span class="mono">{{ m.item }}</span>
                      </div>
                    </div>
                  </td>
                  <td class="num">{{ m.required | number }}</td>
                  <td class="num" [class.zero]="!m.placed">{{ m.placed | number }}</td>
                  <td class="num strong" [class.zero]="!m.open" [title]="m.open ? amount(m) : ''">{{ m.open | number }}</td>
                  <td class="num" [class.zero]="!m.stock" [class.good]="m.open > 0 && m.stock >= m.open">{{ m.stock | number }}</td>
                  <td class="progress-col">
                    <div class="mat-progress" [title]="progressTitle(m)">
                      <div class="seg-bar">
                        <span class="placed" [style.width.%]="share(m.placed, m.required)"></span>
                        <span class="stock" [style.width.%]="share(Math.min(m.stock, m.open), m.required)"></span>
                      </div>
                      <span class="pct">{{ share(m.placed + Math.min(m.stock, m.open), m.required) | number: '1.0-0' }} %</span>
                    </div>
                  </td>
                  <td class="status-col">
                    @switch (state(m)) {
                      @case ('done') { <span class="status-tag" data-state="done"><app-icon name="circle-check-filled" [size]="16" />Verbaut</span> }
                      @case ('covered') { <span class="status-tag" data-state="covered"><app-icon name="circle-check" [size]="16" />Vorrätig</span> }
                      @case ('partial') { <span class="status-tag" data-state="partial"><app-icon name="circle-half-2" [size]="16" />Fehlen <b>{{ m.missing | number }}</b></span> }
                      @default { <span class="status-tag" data-state="missing"><app-icon name="circle-dashed" [size]="16" />Fehlen <b>{{ m.missing | number }}</b></span> }
                    }
                  </td>
                </tr>
              } @empty {
                <tr class="empty"><td colspan="7">@if (filter() === 'missing') { <span class="with-icon"><app-icon name="confetti" [size]="18" />Nichts fehlt – ran ans Bauen!</span> } @else { Keine Materialien in dieser Ansicht. }</td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    } @else if (error()) {
      <p class="error">{{ error() }}</p>
    } @else {
      <p class="hint">Lade …</p>
    }
  `,
  host: { '(document:keydown.escape)': 'editOpen.set(false)' },
})
export class ProjectDetail {
  private api = inject(ProjectsService);
  private storagesApi = inject(StoragesService);
  private router = inject(Router);

  /** Aus der Route /projekte/:id */
  id = input.required<string>();

  project = signal<Project | undefined>(undefined);
  allStorages = signal<StorageSummary[]>([]);
  interval = signal(5);
  error = signal('');
  /** Filter der Materialliste */
  filter = signal<'all' | 'missing' | 'covered' | 'done'>('all');
  protected readonly Math = Math;
  busy = signal(false);
  refreshing = signal(false);
  /** Standort bearbeiten offen – beim ersten Laden automatisch, wenn noch kein Standort gesetzt ist */
  editOpen = signal(false);
  private firstLoad = true;

  assigned = computed(() => new Set(this.project()?.storages.map((s) => s.id) ?? []));
  filters = computed(() => {
    const m = this.project()?.materials ?? [];
    const count = (st: string) => m.filter((x) => this.state(x) === st || (st === 'missing' && this.state(x) === 'partial')).length;
    return [
      { key: 'all' as const, label: 'Alle', count: m.length },
      { key: 'missing' as const, label: 'Fehlend', count: count('missing') },
      { key: 'covered' as const, label: 'Vorrätig', count: count('covered') },
      { key: 'done' as const, label: 'Verbaut', count: count('done') },
    ];
  });
  visible = computed(() => {
    const materials = this.project()?.materials ?? [];
    const f = this.filter();
    if (f === 'all') return materials;
    return materials.filter((m) => {
      const st = this.state(m);
      return f === 'missing' ? st === 'missing' || st === 'partial' : st === f;
    });
  });

  readonly rotations = ROTATION_LABELS;
  readonly mirrors = MIRROR_LABELS;
  readonly dimensions = DIMENSION_LABELS;
  /** Kurzform der Drehung für den Standort-Chip */
  readonly rotationShort: Record<string, string> = { CLOCKWISE_90: '90°', CLOCKWISE_180: '180°', COUNTERCLOCKWISE_90: '270°' };
  /** keyvalue-Pipe soll die Reihenfolge der Definition behalten */
  keep = () => 0;

  protected auth = inject(AuthService);
  private library = inject(ItemLibrary);
  name = (id: string) => this.library.name(id);
  amount = amountLabel;
  date = formatDate;
  private timer?: ReturnType<typeof setInterval>;

  ngOnInit() {
    this.load();
    this.storagesApi.list().then((s) => this.allStorages.set(s)).catch(() => undefined);
    this.storagesApi.status().then((s) => this.interval.set(s.intervalMinutes)).catch(() => undefined);
    this.timer = setInterval(() => !this.busy() && this.load(), POLL_MS);
  }

  ngOnDestroy() {
    clearInterval(this.timer);
  }

  protected load() {
    this.api.get(Number(this.id()))
      .then((p) => {
        this.project.set(p);
        if (this.firstLoad && !p.placement) this.editOpen.set(true);
        this.firstLoad = false;
      })
      .catch((err) => this.error.set(errorMessage(err)));
  }

  /** Zustand eines Materials: verbaut, im Lager gedeckt, teilweise im Lager, fehlt */
  state(m: Material): 'done' | 'covered' | 'partial' | 'missing' {
    if (m.open === 0) return 'done';
    if (m.missing === 0) return 'covered';
    return m.stock > 0 ? 'partial' : 'missing';
  }

  /** Anteil in Prozent (0–100) */
  share(part: number, total: number) {
    return total ? Math.min(100, (part / total) * 100) : 0;
  }

  progressTitle(m: Material) {
    const n = (v: number) => v.toLocaleString('de-DE');
    return `Verbaut ${n(m.placed)} · im Lager ${n(Math.min(m.stock, m.open))} · fehlt ${n(m.missing)} (von ${n(m.required)})`;
  }

  ratioOf(part: number, total: number) {
    return total ? Math.min(1, part / total) : 1;
  }

  toggleStorage(p: Project, storageId: number) {
    const ids = new Set(this.assigned());
    if (ids.has(storageId)) ids.delete(storageId);
    else ids.add(storageId);
    this.save(() => this.api.setStorages(p.id, [...ids]));
  }

  savePlacement(event: Event, form: HTMLFormElement) {
    event.preventDefault();
    const data = new FormData(form);
    const placement = {
      x: Number(data.get('x')), y: Number(data.get('y')), z: Number(data.get('z')),
      rotation: data.get('rotation'), mirror: data.get('mirror'), dimension: data.get('dimension'),
    } as Placement;
    this.save(() => this.api.setPlacement(this.project()!.id, placement)).then((ok) => ok && this.editOpen.set(false));
  }

  async refresh(p: Project) {
    this.refreshing.set(true);
    this.busy.set(true);
    try {
      const { project, report } = await this.api.refresh(p.id);
      this.project.set(project);
      this.error.set(reportErrors(report));
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
      this.refreshing.set(false);
    }
  }

  async remove(p: Project) {
    if (!confirm(`Projekt „${p.name}“ wirklich löschen?`)) return;
    try {
      await this.api.delete(p.id);
      this.router.navigate(['/']);
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  /** true, wenn das Speichern geklappt hat */
  private async save(request: () => Promise<Project>) {
    this.busy.set(true);
    try {
      this.project.set(await request());
      this.error.set('');
      return true;
    } catch (err) {
      this.error.set(errorMessage(err));
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
