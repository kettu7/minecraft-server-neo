import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Icon } from './icon';
import { Status, StoragesService } from './projects.service';
import { AuthService } from './auth';
import { isDemo } from './demo';
import { Bell, Toasts } from './notifications';
import { packUpdated } from './modpack';

const STATUS_POLL_MS = 15_000;

@Component({
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon, Bell, Toasts],
  selector: 'app-root',
  template: `
    <header class="topbar">
      <a routerLink="/" class="logo" aria-label="Neo – Startseite">
        <!-- Eigenes Logo: isometrischer Block -->
        <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
          <path d="M16 2 29 9.5 16 17 3 9.5Z" fill="#7cf279" />
          <path d="M3 9.5 16 17v13L3 22.5Z" fill="#2fb836" />
          <path d="M29 9.5 16 17v13l13-7.5Z" fill="#1c7a22" />
          <path d="M16 17v13M3 9.5 16 17l13-7.5" stroke="#08210a" stroke-opacity=".35" fill="none" />
        </svg>
        <strong>Neo</strong>
      </a>

      @if (auth.isMember()) {
        <nav>
          <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Dashboard</a>
          <a routerLink="/projekte" routerLinkActive="active">Bauprojekte</a>
          <a routerLink="/lager" routerLinkActive="active">Lager</a>
          <a routerLink="/karte" routerLinkActive="active">Karte</a>
          <button type="button" class="nav-more" [class.active]="moreActive()" (click)="toggleMore($event)"
                  aria-haspopup="menu" [attr.aria-expanded]="moreOpen()">
            Mehr<app-icon name="chevron-down" [size]="14" />
          </button>
          @if (auth.isAdmin()) {
            <a routerLink="/admin" routerLinkActive="active">Admin</a>
          }
        </nav>

      }

      <span class="spacer"></span>
      @if (demo) {
        <span class="demo-badge" title="Stand der Momentaufnahme – Änderungen sind nicht möglich">Offline-Demo</span>
      }
      @if (auth.isMember()) {
        @if (status(); as s) {
          <span class="server-status" [attr.data-state]="s.server.state" [title]="syncHint(s)">
            <span class="dot"></span>
            @switch (s.server.state) {
              @case ('online') {
                <span class="status-word">Online<span class="sep" aria-hidden="true"></span></span>{{ s.server.online }} Spieler
              }
              @case ('starting') { Server startet … }
              @default { Server offline }
            }
          </span>
        }
      }
      @if (auth.isMember() && !demo) { <app-bell /> }
      @if (auth.me(); as me) {
        <a routerLink="/profil" class="user-chip" routerLinkActive="active" [title]="'Profil von ' + me.displayName">
          @if (me.avatarUrl) {
            <img class="avatar" [src]="me.avatarUrl" alt="" />
          } @else {
            <span class="avatar">{{ me.displayName[0] }}</span>
          }
          <span>{{ me.displayName }}</span>
        </a>
      }
    </header>
    <!-- „Mehr“-Menü im Top-Layer, damit die (auf dem Handy scrollbare) Navigation es nicht abschneidet -->
    <div #more popover class="row-menu nav-menu" role="menu" [style.top.px]="morePos().top" [style.left.px]="morePos().left"
         (toggle)="moreOpen.set($any($event).newState === 'open')">
      <a role="menuitem" routerLink="/items" routerLinkActive="active" (click)="closeMore()"><app-icon name="stack-2" [size]="16" />Items</a>
      <a role="menuitem" routerLink="/modpack" routerLinkActive="active" (click)="closeMore()">
        <app-icon name="package" [size]="16" />Modpack
        @if (packLabel(); as l) { <span class="updated-label" [class.fresh]="l.fresh" [title]="l.title">{{ l.text }}</span> }
      </a>
    </div>
    <main>
      <router-outlet />
    </main>
    @if (auth.isMember() && !demo) { <app-toasts /> }
  `,
})
export class App {
  protected demo = isDemo;
  protected auth = inject(AuthService);
  private api = inject(StoragesService);
  protected status = signal<Status | undefined>(undefined);
  private timer?: ReturnType<typeof setInterval>;
  private router = inject(Router);
  private more = viewChild.required<ElementRef<HTMLElement>>('more');
  protected moreOpen = signal(false);
  protected morePos = signal({ top: 0, left: 0 });
  protected moreActive = signal(false);
  protected packLabel = computed(() => packUpdated(this.status()?.modpackUpdatedAt));

  /** Menü unter dem „Mehr“-Button öffnen */
  protected toggleMore(event: MouseEvent) {
    const el = this.more().nativeElement;
    if (this.moreOpen()) return el.hidePopover();
    const r = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.morePos.set({ top: r.bottom + 8, left: Math.min(r.left, innerWidth - 260) });
    el.showPopover();
  }

  protected closeMore() {
    this.more().nativeElement.hidePopover();
  }

  constructor() {
    // „Mehr“ hervorheben, wenn eine Seite daraus offen ist
    this.router.events.subscribe((e) => {
      if (e instanceof NavigationEnd) this.moreActive.set(/^\/(items|modpack)(\/|$|\?)/.test(e.urlAfterRedirects));
    });
    // Server-Status nur für freigeschaltete Mitglieder abfragen
    effect(() => {
      clearInterval(this.timer);
      if (!this.auth.isMember()) return;
      const load = () => this.api.status().then((s) => this.status.set(s)).catch(() => this.status.set(undefined));
      load();
      this.timer = setInterval(load, STATUS_POLL_MS);
    });
  }

  /** Tooltip: Stand der Lager-/Projekt-Aktualisierung */
  protected syncHint(s: Status) {
    if (s.running) return 'Lager und Projekte werden gerade aktualisiert';
    if (s.lastRun?.error) return `Aktualisierung fehlgeschlagen: ${s.lastRun.error}`;
    const last = s.lastRun ? `zuletzt ${this.time(s.lastRun.startedAt)}, ` : '';
    return `Lager und Projekte: ${last}alle ${s.intervalMinutes} Min.`;
  }

  protected time(iso: string) {
    return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }
}
