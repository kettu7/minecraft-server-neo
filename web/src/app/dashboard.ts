import { Component, ElementRef, Injectable, computed, inject, signal, viewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DecimalPipe, PercentPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth';
import { ProjectSummary, ProjectsService, StorageSummary, StoragesService, errorMessage } from './projects.service';
import { Modpack, ModpackService } from './modpack';
import { ItemIcon } from './items';
import { Icon } from './icon';
import type { IconName } from './icons.generated';

export interface DashboardInfo {
  server: { state: 'online' | 'starting' | 'offline'; online: number; max: number; names: string[] };
  address: string;
  nextRestartAt: string | null;
  rankings: boolean;
}

export interface RankingCategory {
  key: string;
  title: string;
  caption: string;
  unit: string;
  players: Array<{ name: string; value: number; place: number }>;
  me: { name: string; value: number; place: number } | null;
}

@Injectable({ providedIn: 'root' })
export class DashboardService {
  private http = inject(HttpClient);
  info() { return firstValueFrom(this.http.get<DashboardInfo>('/api/dashboard')); }
  rankings() { return firstValueFrom(this.http.get<{ enabled: boolean; categories: RankingCategory[] }>('/api/rankings')); }
}

/** Icon und Farbe je Rangliste – Farben aus der Palette der Seite (Grün, Blau, Gold, Rot …) */
const CATEGORY_LOOK: Record<string, { icon: IconName; color: string }> = {
  builder: { icon: 'building-castle', color: '#f6c35b' },
  miner: { icon: 'pick', color: '#a7b4c6' },
  diamonds: { icon: 'diamond', color: '#5ce0e6' },
  hunter: { icon: 'sword', color: '#ff6b6b' },
  traveler: { icon: 'walk', color: '#5fe35c' },
  swimmer: { icon: 'swimming', color: '#5aa9ff' },
  trader: { icon: 'coins', color: '#3fd69a' },
  glutton: { icon: 'meat', color: '#ff9b5c' },
  blaster: { icon: 'bomb', color: '#ff5f8f' },
  gamer: { icon: 'device-gamepad-2', color: '#a68bff' },
  unlucky: { icon: 'skull', color: '#c49ad6' },
};

const POLL_MS = 15_000;
const ROTATE_MS = 8_000;

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink, DecimalPipe, PercentPipe, ItemIcon, Icon],
  template: `
    <header class="page-head">
      <span class="eyebrow">Dashboard</span>
      <h1>{{ greeting() }}, {{ auth.me()?.displayName }}</h1>
      <p class="hint">Schön, dass du da bist. Hier siehst du, was auf Neo gerade los ist.</p>
    </header>

    @if (error()) { <p class="error">{{ error() }}</p> }

    <div class="dash-top">
      <!-- Serverstatus -->
      <section class="card server-hero" [attr.data-state]="info()?.server?.state ?? 'loading'">
        @if (info(); as i) {
          <div class="server-hero-head">
            <div class="server-hero-state">
              <span class="pulse-dot" aria-hidden="true"></span>
              <div>
                <strong>{{ stateLabel() }}</strong>
                <span class="hint">
                  @if (i.server.state === 'online') { {{ i.server.online }} von {{ i.server.max }} Spielern online }
                  @else if (i.server.state === 'starting') { Gleich wieder erreichbar }
                  @else { Gerade nicht erreichbar }
                  @if (i.nextRestartAt) { <span class="sep" aria-hidden="true"></span>Neustart {{ when(i.nextRestartAt) }} }
                </span>
              </div>
            </div>
            <div class="copy-input compact-copy">
              <code>{{ i.address }}</code>
              <button type="button" class="icon-btn framed" (click)="copy(i.address)" [title]="copied() ? 'Kopiert' : 'Adresse kopieren'" aria-label="Adresse kopieren">
                <app-icon [name]="copied() ? 'check' : 'copy'" [size]="16" />
              </button>
            </div>
          </div>

          @if (i.server.names.length) {
            <ul class="player-chips" aria-label="Spieler online">
              @for (name of i.server.names; track name) {
                <li class="player-chip">
                  <span class="mc-head small" aria-hidden="true">
                    <span class="mc-head-letter">{{ name[0] }}</span>
                    <span class="mc-head-skin" [style.background-image]="'url(/api/server/skins/' + name + ')'"></span>
                  </span>
                  {{ name }}
                </li>
              }
            </ul>
          } @else if (i.server.state === 'online') {
            <p class="hint server-empty">Gerade ist niemand online.</p>
          }
        } @else {
          <p class="hint">Lade …</p>
        }
      </section>

      <!-- Modpack -->
      <a class="card modpack-teaser" routerLink="/modpack">
        <span class="teaser-icon"><app-icon name="package" [size]="22" /></span>
        <strong>Modpack</strong>
        <span class="hint">Alle spielen mit derselben Basis. Einmal installieren und loslegen.</span>
        @if (pack(); as p) {
          <span class="tile-chips">
            <span class="chip-gray">Minecraft {{ p.minecraft }}</span>
            <span class="chip-gray">Fabric {{ p.loader }}</span>
            <span class="chip-gray">{{ p.contents.length }} Inhalte</span>
          </span>
        }
        <span class="teaser-link">Zum Modpack<app-icon name="arrow-right" [size]="15" /></span>
      </a>
    </div>

    <!-- Bauprojekte als Reihe -->
    <section class="dash-section">
      <header class="section-head">
        <h2>Bauprojekte</h2>
        <div class="section-actions">
          @if (projects().length > 2) {
            <div class="rail-arrows">
              <button type="button" class="icon-btn framed" (click)="scrollProjects(-1)" aria-label="Zurück"><app-icon name="chevron-left" [size]="16" /></button>
              <button type="button" class="icon-btn framed" (click)="scrollProjects(1)" aria-label="Weiter"><app-icon name="chevron-right" [size]="16" /></button>
            </div>
          }
          <a class="text-link with-icon" routerLink="/projekte">Alle anzeigen<app-icon name="arrow-right" [size]="14" /></a>
        </div>
      </header>
      @if (!loaded()) {
        <p class="hint">Lade …</p>
      } @else if (!projects().length) {
        <p class="hint">Noch keine Projekte. <a class="text-link" routerLink="/projekte">Erstes Projekt anlegen</a></p>
      } @else {
        <div class="rail" #projectRail>
          @for (p of projects(); track p.id) {
            <a class="rail-card" [routerLink]="['/projekte', p.id]" [class.done]="done(p)">
              <div class="rail-thumb">
                @if (p.image) { <img [src]="p.image + '&size=thumb'" alt="" loading="lazy" /> }
                @else { <app-item-icon item="crafting_table" [size]="44" /> }
                <span class="rail-badge">{{ done(p) ? 'Fertig' : (ratio(p.placed, p.required) | percent) }}</span>
              </div>
              <div class="rail-body">
                <strong>{{ p.name }}</strong>
                <span class="hint">{{ p.sizeX }} × {{ p.sizeY }} × {{ p.sizeZ }}<span class="sep" aria-hidden="true"></span>{{ p.required | number }} Items</span>
                <div class="bar built"><div [style.width.%]="ratio(p.placed, p.required) * 100"></div></div>
              </div>
            </a>
          }
        </div>
      }
    </section>

    <!-- Lager kompakt -->
    @if (storages().length) {
      <section class="dash-section">
        <header class="section-head">
          <h2>Lager</h2>
          <a class="text-link with-icon" routerLink="/lager">Alle anzeigen<app-icon name="arrow-right" [size]="14" /></a>
        </header>
        <div class="mini-tiles">
          @for (s of storages(); track s.id) {
            <a class="mini-tile" [routerLink]="['/lager', s.id]">
              <app-item-icon item="chest" [size]="28" />
              <span class="mini-tile-text">
                <strong>{{ s.name }}</strong>
                <span class="hint">{{ s.itemCount | number }} Items<span class="sep" aria-hidden="true"></span>{{ s.containerCount }} Behälter</span>
              </span>
              <app-icon class="tile-arrow" name="arrow-right" [size]="16" />
            </a>
          }
        </div>
      </section>
    }

    <!-- Ranglisten als Karussell -->
    @if (rankings().length) {
      <section class="dash-section" (mouseenter)="paused.set(true)" (mouseleave)="paused.set(false)"
               (focusin)="paused.set(true)" (focusout)="paused.set(false)">
        <header class="section-head">
          <h2 class="with-icon"><app-icon name="trophy" [size]="20" />Ranglisten</h2>
          <div class="rail-arrows">
            <button type="button" class="icon-btn framed" (click)="step(-1)" aria-label="Vorherige Rangliste"><app-icon name="chevron-left" [size]="16" /></button>
            <button type="button" class="icon-btn framed" (click)="step(1)" aria-label="Nächste Rangliste"><app-icon name="chevron-right" [size]="16" /></button>
          </div>
        </header>
        <div class="rail rank-rail" #rankRail (scroll)="onRankScroll()" (scrollend)="onRankScrollEnd()" aria-roledescription="Karussell">
          @for (c of rankings(); track c.key) {
            <article class="rank-card" [style.--rank]="look(c.key).color" [attr.aria-label]="c.title">
              <header class="rank-head">
                <span class="rank-icon"><app-icon [name]="look(c.key).icon" [size]="22" /></span>
                <div>
                  <h3>{{ c.title }}</h3>
                  <span class="hint">{{ c.caption }}</span>
                </div>
              </header>
              @if (c.players.length) {
                <ol class="rank-list">
                  @for (p of c.players; track p.name) {
                    <li [class.me]="isMe(p.name)" [attr.data-place]="p.place">
                      <span class="rank-place">{{ p.place }}</span>
                      <span class="rank-name">{{ p.name }}</span>
                      <span class="rank-value">{{ format(p.value, c.unit) }}</span>
                    </li>
                  }
                </ol>
                @if (c.me && c.me.place > c.players.length) {
                  <p class="rank-me"><span>Du</span>Platz {{ c.me.place }}<span class="sep" aria-hidden="true"></span>{{ format(c.me.value, c.unit) }}</p>
                }
              } @else {
                <p class="hint rank-empty">Noch niemand – das ist deine Chance.</p>
              }
            </article>
          }
        </div>
        <div class="rail-dots" role="tablist" aria-label="Ranglisten">
          @for (d of pages(); track d) {
            <button type="button" role="tab" [class.active]="page() === d" [attr.aria-selected]="page() === d"
                    (click)="goTo(d)" [attr.aria-label]="'Seite ' + (d + 1)"></button>
          }
        </div>
      </section>
    }
  `,
})
export class Dashboard {
  protected auth = inject(AuthService);
  private api = inject(DashboardService);
  private projectsApi = inject(ProjectsService);
  private storagesApi = inject(StoragesService);
  private packApi = inject(ModpackService);

  protected info = signal<DashboardInfo | undefined>(undefined);
  protected pack = signal<Modpack | undefined>(undefined);
  protected projects = signal<ProjectSummary[]>([]);
  protected storages = signal<StorageSummary[]>([]);
  protected rankings = signal<RankingCategory[]>([]);
  protected loaded = signal(false);
  protected error = signal('');
  protected copied = signal(false);
  protected paused = signal(false);
  protected page = signal(0);
  private perView = signal(3);

  private rankRail = viewChild<ElementRef<HTMLElement>>('rankRail');
  private projectRail = viewChild<ElementRef<HTMLElement>>('projectRail');
  protected pages = computed(() => Array.from({ length: Math.max(1, this.rankings().length - this.perView() + 1) }, (_, i) => i));
  protected stateLabel = computed(() => ({ online: 'Server online', starting: 'Server startet …', offline: 'Server offline' })[this.info()?.server.state ?? 'offline']);
  protected greeting = computed(() => {
    const h = new Date().getHours();
    return h >= 5 && h < 11 ? 'Guten Morgen' : h < 18 && h >= 11 ? 'Hallo' : h >= 18 && h < 23 ? 'Guten Abend' : 'Hallo';
  });

  private poll = setInterval(() => this.loadInfo(), POLL_MS);
  private rotate = setInterval(() => this.autoRotate(), ROTATE_MS);

  constructor() {
    this.loadInfo();
    Promise.all([this.projectsApi.list(), this.storagesApi.list()])
      .then(([projects, storages]) => {
        // Offene Projekte zuerst (neueste vorn), fertige ans Ende
        const sorted = [...projects].sort((a, b) => Number(this.done(a)) - Number(this.done(b)) || b.createdAt.localeCompare(a.createdAt));
        this.projects.set(sorted);
        this.storages.set(storages);
      })
      .catch((err) => this.error.set(errorMessage(err)))
      .finally(() => this.loaded.set(true));
    this.packApi.info().then((p) => this.pack.set(p)).catch(() => undefined);
    this.api.rankings().then((r) => this.rankings.set(r.enabled ? r.categories : [])).catch(() => undefined);
  }

  ngOnDestroy() {
    clearInterval(this.poll);
    clearInterval(this.rotate);
  }

  private loadInfo() {
    this.api.info().then((i) => this.info.set(i)).catch((err) => this.error.set(errorMessage(err)));
  }

  protected look(key: string) {
    return CATEGORY_LOOK[key] ?? { icon: 'trophy' as IconName, color: '#5fe35c' };
  }

  protected isMe(name: string) {
    return name.toLowerCase() === this.auth.me()?.minecraftName?.toLowerCase();
  }

  protected done(p: ProjectSummary) {
    return p.required > 0 && p.placed >= p.required;
  }

  protected ratio(part: number, total: number) {
    return total > 0 ? Math.min(1, part / total) : 0;
  }

  protected format(value: number, unit: string) {
    const digits = unit === 'km' || unit === 'Std.' ? (value < 10 ? 1 : 0) : 0;
    return `${value.toLocaleString('de-DE', { maximumFractionDigits: digits, minimumFractionDigits: digits })} ${unit}`;
  }

  protected when(iso: string) {
    const d = new Date(iso);
    const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === new Date().toDateString()) return `heute ${time} Uhr`;
    if (d.toDateString() === new Date(Date.now() + 86_400_000).toDateString()) return `morgen ${time} Uhr`;
    return `${d.toLocaleDateString('de-DE', { weekday: 'short' })} ${time} Uhr`;
  }

  async copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = Object.assign(document.createElement('textarea'), { value: text });
      area.style.cssText = 'position:fixed;opacity:0';
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 2000);
  }

  /* ───────── Reihen und Karussell ───────── */

  protected scrollProjects(dir: 1 | -1) {
    const rail = this.projectRail()?.nativeElement;
    rail?.scrollBy({ left: dir * rail.clientWidth * 0.9, behavior: this.motion() });
  }

  /** Breite einer Karte inklusive Abstand */
  private cardWidth(rail: HTMLElement) {
    const first = rail.firstElementChild as HTMLElement | null;
    const gap = parseFloat(getComputedStyle(rail).columnGap) || 0;
    return first ? first.offsetWidth + gap : rail.clientWidth;
  }

  protected goTo(index: number) {
    const rail = this.rankRail()?.nativeElement;
    if (!rail) return;
    const last = this.pages().length - 1;
    const target = index > last ? 0 : index < 0 ? last : index;
    // Während des Scrollens zeigen die Punkte schon das Ziel (nicht die Zwischenstände)
    this.scrollingTo = target;
    this.page.set(target);
    rail.scrollTo({ left: target * this.cardWidth(rail), behavior: this.motion() });
  }

  private scrollingTo: number | null = null;

  protected onRankScrollEnd() {
    this.scrollingTo = null;
    this.onRankScroll();
  }

  protected step(dir: 1 | -1) {
    this.goTo(this.page() + dir);
  }

  protected onRankScroll() {
    const rail = this.rankRail()?.nativeElement;
    if (!rail) return;
    const width = this.cardWidth(rail);
    this.perView.set(Math.max(1, Math.round(rail.clientWidth / width)));
    if (this.scrollingTo === null) this.page.set(Math.round(rail.scrollLeft / width));
  }

  /** Weiterdrehen nur, wenn niemand hinsieht/bedient und keine reduzierte Bewegung gewünscht ist */
  private autoRotate() {
    if (this.paused() || document.hidden || this.motion() === 'auto') return;
    const rail = this.rankRail()?.nativeElement;
    if (rail) this.perView.set(Math.max(1, Math.round(rail.clientWidth / this.cardWidth(rail))));
    this.step(1);
  }

  private motion(): ScrollBehavior {
    return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  }
}
