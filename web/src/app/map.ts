import { Component, ElementRef, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { isDemo, demo } from './demo';
import { ProjectSummary, ProjectsService, StorageSummary, StoragesService, Dimension } from './projects.service';
import { Icon } from './icon';
import { MARKER_CATEGORIES, MARKER_CATEGORY_KEYS, MapMarker, MarkerDialog, MarkersService, markerIcon } from './markers';

/** BlueMap-Kartennamen ↔ Dimensionen */
const MAP_OF: Record<Dimension, string> = {
  'minecraft:overworld': 'world',
  'minecraft:the_nether': 'world_the_nether',
  'minecraft:the_end': 'world_the_end',
};

const DIMENSION_OF = Object.fromEntries(Object.entries(MAP_OF).map(([dim, map]) => [map, dim])) as Record<string, Dimension>;

const REFRESH_MS = 30_000;
/** Kameraabstand, ab dem BlueMap die genaue Ansicht lädt (Klick liefert dann auch die Höhe) */
const PICK_DISTANCE = 80;

/** Mitte des Grundrisses eines Projekts in Weltkoordinaten (Drehung/Spiegelung wie Litematica) */
export function projectCenter(p: ProjectSummary): { x: number; z: number } | null {
  const pl = p.placement;
  if (!pl) return null;
  const toWorld = (x: number, z: number) => {
    if (pl.mirror === 'LEFT_RIGHT') z = -z;
    if (pl.mirror === 'FRONT_BACK') x = -x;
    switch (pl.rotation) {
      case 'CLOCKWISE_90': [x, z] = [-z, x]; break;
      case 'CLOCKWISE_180': [x, z] = [-x, -z]; break;
      case 'COUNTERCLOCKWISE_90': [x, z] = [z, -x]; break;
    }
    return { x: pl.x + x, z: pl.z + z };
  };
  const a = toWorld(0, 0);
  const b = toWorld(p.sizeX - 1, p.sizeZ - 1);
  return { x: (a.x + b.x) / 2 + 0.5, z: (a.z + b.z) / 2 + 0.5 };
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pct = (part: number, total: number) => (total ? Math.round(Math.min(1, part / total) * 100) : 100);

/**
 * Anklickbares Symbol mit Namensschild. Ein Klick öffnet die Detailseite bzw. den Marker (siehe Klick-Abfang
 * unten), beim Drüberfahren zeigt der Browser-Hinweis die Kennzahlen.
 */
function pin(kind: string, target: { href: string } | { marker: number }, icon: string, name: string, tooltip: string) {
  const attr = 'href' in target ? `data-neo-href="${target.href}"` : `data-neo-marker="${target.marker}"`;
  return `<div class="neo-pin neo-pin--${kind}" ${attr} title="${escape(tooltip)}">
    <img src="${icon}" alt="">
    <span>${escape(name)}</span>
  </div>`;
}

/** Styles für die Symbole – sie werden im Dokument der Karte angezeigt */
const PIN_STYLE = `
  .neo-pin { pointer-events: auto; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 3px;
    transform: translate(-50%, -16px); transition: transform .12s ease; user-select: none; }
  .neo-pin:hover { transform: translate(-50%, -16px) scale(1.12); }
  .neo-pin img { width: 32px; height: 32px; image-rendering: pixelated; filter: drop-shadow(0 3px 4px rgba(0,0,0,.75)); }
  .neo-pin span { font: 700 11px/1 system-ui, sans-serif; color: #fff; white-space: nowrap; padding: 4px 8px; border-radius: 99px;
    background: rgba(9, 13, 24, .82); border: 1.5px solid; box-shadow: 0 4px 10px rgba(0,0,0,.4); }
  .neo-pin--project span { border-color: #5aa9ff; }
  .neo-pin--storage span { border-color: #5fe35c; }
${MARKER_CATEGORY_KEYS.map((c) => `  .neo-pin--${c} span { border-color: ${MARKER_CATEGORIES[c].color}; }`).join('\n')}
  body.neo-picking, body.neo-picking canvas { cursor: crosshair !important; }
`;

@Component({
  selector: 'app-map',
  host: { class: 'map-page', '(document:keydown.escape)': 'picking.set(false)' },
  imports: [Icon, MarkerDialog],
  template: `
    <header class="map-head">
      <div>
        <span class="eyebrow">Live aus der Welt</span>
        <h1>Karte</h1>
      </div>
      <div class="map-tools">
        <div class="legend">
          <span><i class="swatch project"></i>Bauprojekte ({{ projectCount() }})</span>
          <span><i class="swatch storage"></i>Lager ({{ storages().length }})</span>
          @for (c of usedCategories(); track c.key) {
            <span><img class="legend-icon" [src]="c.icon" alt="" />{{ c.set }} ({{ c.count }})</span>
          }
        </div>
        @if (!demo) {
          <button type="button" class="with-icon" (click)="togglePicking()" [class.secondary]="picking()" [attr.aria-pressed]="picking()">
            <app-icon [name]="picking() ? 'x' : 'map-pin'" [size]="16" />{{ picking() ? 'Abbrechen' : 'Marker setzen' }}
          </button>
        }
      </div>
    </header>
    <div class="map-frame">
      @if (demo) {
        <!-- Offline-Demo: Standbild statt Live-Karte -->
        <img class="map-still" [src]="demoMap" alt="Karte der Welt (Standbild)" />
        <span class="map-still-note">Standbild<span class="sep" aria-hidden="true"></span>die 3D-Karte läuft live auf dem Server</span>
      } @else {
        <iframe #frame [src]="src()" title="Karte der Welt" (load)="onFrameLoad()"></iframe>
        @if (picking()) {
          <div class="map-pick-banner" role="status">
            <app-icon name="map-pin" [size]="16" />
            <span>{{ pickCloser() ? 'Jetzt genau auf die Stelle klicken.' : 'Klicke auf die Stelle, an der der Marker stehen soll.' }}</span>
            <button type="button" class="link" (click)="enterManually()">Koordinaten eingeben</button>
          </div>
        }
      }
    </div>
    <app-marker-dialog (changed)="refresh()" />
  `,
})
export class MapPage {
  private sanitizer = inject(DomSanitizer);
  private router = inject(Router);
  private projectsApi = inject(ProjectsService);
  private storagesApi = inject(StoragesService);
  private markersApi = inject(MarkersService);
  private dialog = viewChild.required(MarkerDialog);
  private frame = viewChild<ElementRef<HTMLIFrameElement>>('frame');
  protected demo = isDemo;
  protected demoMap = demo?.assets['demo:map'] ?? '';

  /** Optionaler Fokus aus der Adresse: /karte?x=…&y=…&z=…&dim=… */
  x = input<string>();
  y = input<string>();
  z = input<string>();
  dim = input<string>();

  protected projects = signal<ProjectSummary[]>([]);
  protected storages = signal<StorageSummary[]>([]);
  protected markers = signal<MapMarker[]>([]);
  /** „Marker setzen“: der nächste Klick in die Karte bestimmt die Stelle */
  protected picking = signal(false);
  /** erster Klick war zu weit weg: Karte ist herangezoomt, jetzt genau klicken */
  protected pickCloser = signal(false);
  protected projectCount = computed(() => this.projects().filter((p) => p.placement).length);
  /** Legende: nur Kategorien, die es auch gibt */
  protected usedCategories = computed(() => MARKER_CATEGORY_KEYS
    .map((key) => ({ key, set: MARKER_CATEGORIES[key].set, icon: markerIcon(key), count: this.markers().filter((m) => m.category === key).length }))
    .filter((c) => c.count > 0));
  private timer?: ReturnType<typeof setInterval>;
  private frameReady = false;

  /** Die Adresse wird nur einmal gesetzt; danach bewegt man sich frei in der Karte */
  protected src = computed(() => {
    const dimension = (this.dim() as Dimension) || 'minecraft:overworld';
    const map = MAP_OF[dimension] ?? 'world';
    const focus = this.x() !== undefined && this.z() !== undefined;
    const [x, y, z] = focus ? [Number(this.x()), Number(this.y() ?? 64), Number(this.z())] : [0, 64, 0];
    const distance = focus ? 90 : 600;
    return this.sanitizer.bypassSecurityTrustResourceUrl(`/map/#${map}:${x}:${y}:${z}:${distance}:0:0:0:0:perspective`);
  });

  async ngOnInit() {
    await this.loadData();
    this.timer = setInterval(async () => {
      await this.loadData();
      this.applyMarkers();
    }, REFRESH_MS);
  }

  ngOnDestroy() {
    clearInterval(this.timer);
  }

  private async loadData() {
    const [projects, storages, markers] = await Promise.all([
      this.projectsApi.list().catch(() => this.projects()),
      this.storagesApi.list().catch(() => this.storages()),
      this.demo ? [] : this.markersApi.list().catch(() => this.markers()),
    ]);
    this.projects.set(projects);
    this.storages.set(storages);
    this.markers.set(markers);
  }

  /** Nach Anlegen, Ändern oder Löschen eines Markers */
  protected async refresh() {
    await this.loadData();
    this.applyMarkers();
  }

  /** Aktuelle Karte als Dimension (für neue Marker) */
  private currentDimension(): Dimension {
    return DIMENSION_OF[this.win()?.bluemap?.mapViewer?.map?.data?.id] ?? 'minecraft:overworld';
  }

  protected togglePicking() {
    this.pickCloser.set(false);
    this.picking.set(!this.picking());
  }

  /** Ohne Klick: Kartenmitte als Vorschlag, Koordinaten lassen sich im Dialog ändern */
  protected enterManually() {
    this.picking.set(false);
    const p = this.win()?.bluemap?.mapViewer?.controlsManager?.position;
    this.dialog().openNew({
      // Höhe kennt die Übersicht nicht – Meereshöhe als Vorschlag
      x: Math.floor(p?.x ?? 0), y: Math.round(p?.y || 64), z: Math.floor(p?.z ?? 0), dimension: this.currentDimension(),
    });
  }

  /** Kamera sanft auf eine Stelle fahren, nah genug für die genaue Höhe */
  private zoomTo(x: number, z: number) {
    const win = this.win();
    const c = win?.bluemap?.mapViewer?.controlsManager;
    if (!c) return;
    const from = { x: c.position.x, z: c.position.z, d: c.distance };
    // Genaue Kacheln zeigt BlueMap erst innerhalb seiner Sichtweite für Details (Einstellung im Kartenmenü)
    const hires = win.bluemap.mapViewer.data?.loadedHiresViewDistance ?? 100;
    const to = { x, z, d: Math.min(from.d, PICK_DISTANCE, hires * 0.7) };
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 500);
      const k = t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      c.position.x = from.x + (to.x - from.x) * k;
      c.position.z = from.z + (to.z - from.z) * k;
      c.distance = from.d + (to.d - from.d) * k;
      if (t < 1) win.requestAnimationFrame(step);
    };
    win.requestAnimationFrame(step);
  }

  /** Auswahlmodus auch im Dokument der Karte zeigen (Fadenkreuz) */
  private pickingCursor = effect(() => this.win()?.document?.body?.classList.toggle('neo-picking', this.picking()));

  /** Wartet, bis BlueMap im iframe bereit ist, und blendet dann die eigenen Marker ein */
  async onFrameLoad() {
    for (let i = 0; i < 100 && !this.viewer(); i++) await new Promise((r) => setTimeout(r, 150));
    const win = this.win();
    if (!win?.bluemap || this.frameReady) return;
    this.frameReady = true;

    const style = win.document.createElement('style');
    style.textContent = PIN_STYLE;
    win.document.head.appendChild(style);

    // Klicks auf unsere Symbole abfangen, bevor BlueMap sie als Klick auf die Karte wertet
    const pinOf = (e: Event) => (e.target as HTMLElement | null)?.closest?.('[data-neo-href], [data-neo-marker]');
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'dblclick']) {
      win.document.addEventListener(type, (e: Event) => { if (pinOf(e)) e.stopPropagation(); }, true);
    }
    win.document.addEventListener('click', (e: MouseEvent) => {
      const target = pinOf(e);
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      const markerId = Number(target.getAttribute('data-neo-marker'));
      const marker = this.markers().find((m) => m.id === markerId);
      if (marker) this.dialog().openMarker(marker);
      else if (target.hasAttribute('data-neo-href')) this.router.navigateByUrl(target.getAttribute('data-neo-href')!);
    }, true);

    // „Marker setzen“: Klick in die Karte liefert die getroffene Blockoberfläche
    // Weit weg trifft der Klick nur die grobe Übersicht (ohne Höhe) → erst auf die Stelle zoomen
    win.bluemap.events?.addEventListener?.('bluemapMapInteraction', (e: CustomEvent) => {
      const exact = e.detail?.hiresHit?.point;
      const rough = e.detail?.hit?.point;
      if (!this.picking() || !rough) return;
      if (!exact) {
        this.zoomTo(rough.x, rough.z);
        this.pickCloser.set(true);
        return;
      }
      this.picking.set(false);
      this.dialog().openNew({ x: Math.floor(exact.x), y: Math.round(exact.y), z: Math.floor(exact.z), dimension: this.currentDimension() });
    });
    win.document.body.classList.toggle('neo-picking', this.picking());

    // Beim Kartenwechsel (z. B. Nether) räumt BlueMap fremde Marker ab → neu setzen
    win.bluemap.events?.addEventListener?.('bluemapMapChanged', () => setTimeout(() => this.applyMarkers(), 300));
    this.applyMarkers();
    // Kurz nach dem Start liest BlueMap seine Marker-Datei ein und räumt dabei fremde Ebenen ab → nachlegen
    for (const ms of [1_500, 4_000]) setTimeout(() => this.applyMarkers(), ms);
  }

  private win(): any {
    try {
      return this.frame()?.nativeElement.contentWindow;
    } catch {
      return undefined;
    }
  }

  private viewer() {
    return this.win()?.bluemap?.mapViewer?.markers;
  }

  private applyMarkers() {
    const win = this.win();
    const root = this.viewer();
    if (!win || !root) return;
    const mapId: string = win.bluemap.mapViewer.map?.data?.id ?? 'world';
    const inThisMap = (dim: string | undefined) => MAP_OF[(dim ?? 'minecraft:overworld') as Dimension] === mapId;

    const projectMarkers: Record<string, unknown> = {};
    for (const p of this.projects()) {
      if (!p.placement || !inThisMap(p.placement.dimension)) continue;
      const c = projectCenter(p)!;
      projectMarkers[`p${p.id}`] = {
        type: 'html', label: p.name, sorting: 0, listed: true, classes: [],
        // Auf Bodenhöhe des Bauplatzes, nicht über der Spitze des Bauwerks
        position: { x: c.x, y: p.placement.y + 1, z: c.z },
        anchor: { x: 0, y: 0 },
        html: pin('project', { href: `/projekte/${p.id}` }, '/items/crafting_table.png', p.name,
          `${p.name} – Verbaut ${pct(p.placed, p.required)} % · Im Lager ${pct(p.covered, p.open)} %`),
      };
    }

    const storageMarkers: Record<string, unknown> = {};
    for (const s of this.storages()) {
      if (!inThisMap(s.dimension)) continue;
      storageMarkers[`s${s.id}`] = {
        type: 'html', label: s.name, sorting: 1, listed: true, classes: [],
        position: { x: s.x + 0.5, y: s.y + 1, z: s.z + 0.5 },
        anchor: { x: 0, y: 0 },
        html: pin('storage', { href: `/lager/${s.id}` }, '/items/chest.png', s.name,
          `${s.name} – ${s.itemCount.toLocaleString('de-DE')} Items · ${s.itemTypes} Sorten · ${s.containerCount} Behälter`),
      };
    }

    // Eigene Marker: eine Ebene je Kategorie, im BlueMap-Menü einzeln ein- und ausblendbar
    const markerSets = MARKER_CATEGORY_KEYS.map((category, i) => {
      const entries: Record<string, unknown> = {};
      for (const m of this.markers()) {
        if (m.category !== category || !inThisMap(m.dimension)) continue;
        const by = m.createdBy ? ` · von ${m.createdBy}` : '';
        entries[`m${m.id}`] = {
          type: 'html', label: m.name, sorting: 0, listed: true, classes: [],
          position: { x: m.x + 0.5, y: m.y, z: m.z + 0.5 },
          anchor: { x: 0, y: 0 },
          html: pin(category, { marker: m.id }, markerIcon(category), m.name,
            `${m.name} – ${MARKER_CATEGORIES[category].label}${by}${m.description ? `\n${m.description}` : ''}`),
        };
      }
      return { id: `neo-marker-${category}`, data: { label: MARKER_CATEGORIES[category].set, toggleable: true, defaultHidden: false, sorting: 2 + i, markers: entries } };
    });

    try {
      for (const set of markerSets) root.updateMarkerSetFromData(set.id, set.data);
      root.updateMarkerSetFromData('neo-projekte', { label: 'Bauprojekte', toggleable: true, defaultHidden: false, sorting: 0, markers: projectMarkers });
      root.updateMarkerSetFromData('neo-lager', { label: 'Lager', toggleable: true, defaultHidden: false, sorting: 1, markers: storageMarkers });
      win.bluemap.mapViewer.redraw?.();
    } catch (err) {
      console.warn('Marker konnten nicht gesetzt werden', err);
    }
  }
}
