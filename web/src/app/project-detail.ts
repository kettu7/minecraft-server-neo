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
    <a routerLink="/" class="back"><app-icon name="arrow-left" [size]="14" />Alle Projekte</a>

    @if (project(); as p) {
      <header class="detail-head">
        <div>
          <span class="eyebrow">Bauprojekt</span>
          <h1>{{ p.name }}</h1>
          <p class="hint">
            {{ p.schematicName }} · {{ p.sizeX }}×{{ p.sizeY }}×{{ p.sizeZ }} · {{ p.totalBlocks | number }} Blöcke
            @if (p.description) { · {{ p.description }} }
          </p>
          <details class="download-help">
            <summary>Blaupause im Spiel öffnen?</summary>
            <ol>
              <li>„Blaupause herunterladen“ klicken.</li>
              <li>Datei in den <code>schematics</code>-Ordner deiner Instanz verschieben, z. B.
                <code>%APPDATA%\\ModrinthApp\\profiles\\custom\\schematics</code>
                (in der Modrinth App: Instanz → ⋮ → Ordner öffnen).</li>
              <li>Im Spiel <kbd>M</kbd> → Load Schematics → Datei wählen → Load Schematic.</li>
            </ol>
          </details>
        </div>
        <div class="head-actions">
          <a class="button-link" [href]="'/api/projects/' + p.id + '/schematic'" download
             title="In den schematics-Ordner deiner Minecraft-Instanz speichern, dann im Spiel M → Load Schematics">Blaupause herunterladen</a>
          @if (p.placement) {
            <a class="button-link" routerLink="/karte"
               [queryParams]="{ x: p.placement.x, y: p.placement.y, z: p.placement.z, dim: p.placement.dimension }">Auf Karte zeigen</a>
          }
          <button (click)="refresh(p)" [disabled]="busy()">{{ refreshing() ? 'Aktualisiere …' : 'Jetzt aktualisieren' }}</button>
          @if (auth.isAdmin()) {
            <button class="danger" (click)="remove(p)">Löschen</button>
          }
        </div>
      </header>

      <app-project-image [projectId]="p.id" [image]="p.image" (changed)="load()" />

      @if (error()) {
        <p class="error">{{ error() }}</p>
      }

      <section class="card progress-card">
        <div>
          <div class="project-head">
            <strong>Im Lager gedeckt</strong>
            <span>{{ p.covered | number }} / {{ p.open | number }} offene Items ({{ ratioOf(p.covered, p.open) | percent }})</span>
          </div>
          <div class="bar big"><div [style.width.%]="ratioOf(p.covered, p.open) * 100"></div></div>
          @if (!p.storages.length) {
            <small class="hint">Noch kein Lager zugeordnet (siehe unten).</small>
          }
        </div>
        <div>
          <div class="project-head">
            <strong>Verbaut</strong>
            @if (p.checkedAt) {
              <span>{{ p.placed | number }} / {{ p.required | number }} Items ({{ ratioOf(p.placed, p.required) | percent }})</span>
            } @else {
              <span class="hint">noch nicht geprüft</span>
            }
          </div>
          <div class="bar big built"><div [style.width.%]="ratioOf(p.placed, p.required) * 100"></div></div>
          <small class="hint">
            Gesamtbedarf {{ p.required | number }} Items
            @if (p.checkedAt) { · geprüft {{ date(p.checkedAt) }} }
            · automatisch alle {{ interval() }} Min.
          </small>
        </div>
      </section>

      <section class="card">
        <div class="project-head">
          <h3>Lager</h3>
          <a routerLink="/lager" class="hint more-link">Lager verwalten<app-icon name="arrow-right" [size]="14" /></a>
        </div>
        @if (!allStorages().length) {
          <p class="hint">Es gibt noch keine Lager. <a routerLink="/lager">Jetzt eins anlegen</a>.</p>
        } @else {
          <p class="hint">Bestand dieser Lager zählt für das Projekt. Mehrere Projekte können sich ein Lager teilen.</p>
          <div class="chips">
            @for (s of allStorages(); track s.id) {
              <label class="chip" [class.on]="assigned().has(s.id)">
                <input type="checkbox" [checked]="assigned().has(s.id)" (change)="toggleStorage(p, s.id)" [disabled]="busy()" />
                {{ s.name }} <span class="hint">· {{ s.itemCount | number }} Items</span>
              </label>
            }
          </div>
        }
      </section>

      <details class="card" [open]="!p.placement">
        <summary>
          Standort in der Welt
          @if (p.placement) { <span class="hint mono">· {{ p.placement.x }} / {{ p.placement.y }} / {{ p.placement.z }}</span> }
        </summary>
        <p class="hint">
          Werte aus Litematica übernehmen: <kbd>M</kbd> → Schematic Placements → Configure.
          Daraus wird berechnet, welche Blöcke schon verbaut sind.
        </p>
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
          <div class="actions">
            <button type="submit" class="secondary" [disabled]="busy()">Standort speichern</button>
          </div>
        </form>
        @if (p.unloadedBlocks) {
          <p class="warn">{{ p.unloadedBlocks | number }} Blöcke konnten nicht geprüft werden (Bereich nicht geladen).</p>
        }
      </details>

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
                      @case ('done') { <span class="pill" data-state="done"><i></i>Verbaut</span> }
                      @case ('covered') { <span class="pill" data-state="covered"><i></i>Gedeckt</span> }
                      @case ('partial') { <span class="pill" data-state="partial"><i></i>Fehlen {{ m.missing | number }}</span> }
                      @default { <span class="pill" data-state="missing"><i></i>Fehlen {{ m.missing | number }}</span> }
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

  assigned = computed(() => new Set(this.project()?.storages.map((s) => s.id) ?? []));
  filters = computed(() => {
    const m = this.project()?.materials ?? [];
    const count = (st: string) => m.filter((x) => this.state(x) === st || (st === 'missing' && this.state(x) === 'partial')).length;
    return [
      { key: 'all' as const, label: 'Alle', count: m.length },
      { key: 'missing' as const, label: 'Fehlend', count: count('missing') },
      { key: 'covered' as const, label: 'Gedeckt', count: count('covered') },
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
      .then((p) => this.project.set(p))
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
    this.save(() => this.api.setPlacement(this.project()!.id, placement));
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

  private async save(request: () => Promise<Project>) {
    this.busy.set(true);
    try {
      this.project.set(await request());
      this.error.set('');
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
