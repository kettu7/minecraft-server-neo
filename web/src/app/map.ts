import { Component, ElementRef, computed, inject, input, signal, viewChild } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { isDemo, demo } from './demo';
import { ProjectSummary, ProjectsService, StorageSummary, StoragesService, Dimension } from './projects.service';

/** BlueMap-Kartennamen ↔ Dimensionen */
const MAP_OF: Record<Dimension, string> = {
  'minecraft:overworld': 'world',
  'minecraft:the_nether': 'world_the_nether',
  'minecraft:the_end': 'world_the_end',
};

const REFRESH_MS = 30_000;

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
 * Anklickbares Symbol mit Namensschild. Ein Klick öffnet die Detailseite (siehe Klick-Abfang unten),
 * beim Drüberfahren zeigt der Browser-Hinweis die Kennzahlen.
 */
function pin(kind: 'project' | 'storage', href: string, icon: string, name: string, tooltip: string) {
  return `<div class="neo-pin neo-pin--${kind}" data-neo-href="${href}" title="${escape(tooltip)}">
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
`;

@Component({
  selector: 'app-map',
  host: { class: 'map-page' },
  template: `
    <header class="map-head">
      <div>
        <span class="eyebrow">Live aus der Welt</span>
        <h1>Karte</h1>
      </div>
      <div class="legend">
        <span><i class="swatch project"></i>Bauprojekte ({{ projectCount() }})</span>
        <span><i class="swatch storage"></i>Lager ({{ storages().length }})</span>
      </div>
    </header>
    <div class="map-frame">
      @if (demo) {
        <!-- Offline-Demo: Standbild statt Live-Karte -->
        <img class="map-still" [src]="demoMap" alt="Karte der Welt (Standbild)" />
        <span class="map-still-note">Standbild<span class="sep" aria-hidden="true"></span>die 3D-Karte läuft live auf dem Server</span>
      } @else {
        <iframe #frame [src]="src()" title="Karte der Welt" (load)="onFrameLoad()"></iframe>
      }
    </div>
  `,
})
export class MapPage {
  private sanitizer = inject(DomSanitizer);
  private router = inject(Router);
  private projectsApi = inject(ProjectsService);
  private storagesApi = inject(StoragesService);
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
  protected projectCount = computed(() => this.projects().filter((p) => p.placement).length);
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
    const [projects, storages] = await Promise.all([
      this.projectsApi.list().catch(() => this.projects()),
      this.storagesApi.list().catch(() => this.storages()),
    ]);
    this.projects.set(projects);
    this.storages.set(storages);
  }

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
    const pinOf = (e: Event) => (e.target as HTMLElement | null)?.closest?.('[data-neo-href]');
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'dblclick']) {
      win.document.addEventListener(type, (e: Event) => { if (pinOf(e)) e.stopPropagation(); }, true);
    }
    win.document.addEventListener('click', (e: MouseEvent) => {
      const target = pinOf(e);
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      this.router.navigateByUrl(target.getAttribute('data-neo-href')!);
    }, true);

    // Beim Kartenwechsel (z. B. Nether) räumt BlueMap fremde Marker ab → neu setzen
    win.bluemap.events?.addEventListener?.('bluemapMapChanged', () => setTimeout(() => this.applyMarkers(), 300));
    this.applyMarkers();
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
        html: pin('project', `/projekte/${p.id}`, '/items/crafting_table.png', p.name,
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
        html: pin('storage', `/lager/${s.id}`, '/items/chest.png', s.name,
          `${s.name} – ${s.itemCount.toLocaleString('de-DE')} Items · ${s.itemTypes} Sorten · ${s.containerCount} Behälter`),
      };
    }

    try {
      root.updateMarkerSetFromData('neo-projekte', { label: 'Bauprojekte', toggleable: true, defaultHidden: false, sorting: 0, markers: projectMarkers });
      root.updateMarkerSetFromData('neo-lager', { label: 'Lager', toggleable: true, defaultHidden: false, sorting: 1, markers: storageMarkers });
      win.bluemap.mapViewer.redraw?.();
    } catch (err) {
      console.warn('Marker konnten nicht gesetzt werden', err);
    }
  }
}
