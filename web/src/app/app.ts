import { Component, effect, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Status, StoragesService } from './projects.service';
import { AuthService } from './auth';
import { isDemo } from './demo';

const STATUS_POLL_MS = 30_000;

@Component({
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
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
          <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Bauprojekte</a>
          <a routerLink="/lager" routerLinkActive="active">Lager</a>
          <a routerLink="/items" routerLinkActive="active">Items</a>
          <a routerLink="/karte" routerLinkActive="active">Karte</a>
          <a routerLink="/modpack" routerLinkActive="active">Modpack</a>
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
          <span class="sync" [title]="s.lastRun?.error ?? ''">
            <span class="dot" [class.busy]="s.running" [class.err]="!!s.lastRun?.error"></span>
            @if (s.running) {
              Aktualisiere …
            } @else if (s.lastRun?.error) {
              Server nicht erreichbar
            } @else if (s.lastRun) {
              Sync {{ time(s.lastRun.startedAt) }}<span class="sep" aria-hidden="true"></span>alle {{ s.intervalMinutes }} Min.
            } @else {
              Sync alle {{ s.intervalMinutes }} Min.
            }
          </span>
        }
      }
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
    <main>
      <router-outlet />
    </main>
  `,
})
export class App {
  protected demo = isDemo;
  protected auth = inject(AuthService);
  private api = inject(StoragesService);
  protected status = signal<Status | undefined>(undefined);
  private timer?: ReturnType<typeof setInterval>;

  constructor() {
    // Sync-Status nur für freigeschaltete Mitglieder abfragen
    effect(() => {
      clearInterval(this.timer);
      if (!this.auth.isMember()) return;
      const load = () => this.api.status().then((s) => this.status.set(s)).catch(() => this.status.set(undefined));
      load();
      this.timer = setInterval(load, STATUS_POLL_MS);
    });
  }

  protected time(iso: string) {
    return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }
}
