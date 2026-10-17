import { Component, Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AdminNav } from './admin-nav';
import { BackupsPanel } from './admin-backups';
import { errorMessage } from './projects.service';
import { Icon } from './icon';

export interface ServerInfo {
  controlAvailable: boolean;
  container:
    | { running: boolean; status: string; health: string | null; startedAt: string; memory: { usage: number; limit: number } | null }
    | { error: string };
  players: { online: number; max: number; names: string[] } | null;
  /** Minecraft-Name → Anzeigename des Website-Kontos */
  accounts: Record<string, string>;
  whitelist: { enabled: boolean | null; names: string[] };
  address: { host: string; ip: string | null };
}

@Injectable({ providedIn: 'root' })
export class ServerService {
  private http = inject(HttpClient);
  info() { return firstValueFrom(this.http.get<ServerInfo>('/api/server')); }
  whitelist(enabled: boolean) { return firstValueFrom(this.http.post('/api/server/whitelist', { enabled })); }
  kick(name: string, reason: string) { return firstValueFrom(this.http.post('/api/server/kick', { name, reason })); }
  ban(name: string, reason: string) { return firstValueFrom(this.http.post('/api/server/ban', { name, reason })); }
  say(message: string) { return firstValueFrom(this.http.post('/api/server/say', { message })); }
  restart() { return firstValueFrom(this.http.post('/api/server/restart', {})); }
  stop() { return firstValueFrom(this.http.post('/api/server/stop', {})); }
  start() { return firstValueFrom(this.http.post('/api/server/start', {})); }
}

const POLL_MS = 5_000;

@Component({
  selector: 'app-admin-server',
  imports: [AdminNav, BackupsPanel, Icon],
  template: `
    <app-admin-nav />

    @if (error()) {
      <p class="error">{{ error() }}</p>
    }
    @if (notice()) {
      <p class="ok">{{ notice() }}</p>
    }

    @if (info(); as i) {
      <!-- Status, Steuerung und Verbindungsdaten -->
      <section class="card server-panel">
        <header class="panel-head">
          <h3>Status</h3>
          <div class="head-actions">
            @if (state() === 'offline') {
              <button type="button" class="with-icon" (click)="start()" [disabled]="busy() || !i.controlAvailable">
                <app-icon name="player-play" [size]="15" />{{ action() === 'start' ? 'Startet …' : 'Server starten' }}
              </button>
            } @else {
              <button type="button" class="warning with-icon" (click)="restart()" [disabled]="busy() || !i.controlAvailable">
                <app-icon name="rotate" [size]="15" />{{ action() === 'restart' ? 'Startet neu …' : 'Neu starten' }}
              </button>
              <button type="button" class="danger with-icon" (click)="stop()" [disabled]="busy() || !i.controlAvailable">
                <app-icon name="player-stop" [size]="15" />{{ action() === 'stop' ? 'Stoppt …' : 'Server stoppen' }}
              </button>
            }
          </div>
        </header>

        <div class="stats inset">
          <div>
            <strong [class.ok]="state() === 'online'" [class.error]="state() === 'offline'">
              <span class="dot-inline" [attr.data-state]="state()"></span>{{ stateLabel() }}
            </strong>
            <span class="hint">{{ uptime() }}</span>
          </div>
          <div>
            <strong>{{ i.players ? i.players.online + ' / ' + i.players.max : '–' }}</strong>
            <span class="hint">Spieler online</span>
          </div>
          <div>
            <strong>{{ memory() }}</strong>
            <span class="hint">Arbeitsspeicher</span>
          </div>
        </div>

        <div class="connect-fields">
          @for (f of connectFields(i); track f.label) {
            <div class="copy-field">
              <span class="copy-label">{{ f.label }}</span>
              <div class="copy-input">
                <code>{{ f.value }}</code>
                <button type="button" class="icon-btn framed" (click)="copy(f.value)"
                        [title]="copied() === f.value ? 'Kopiert' : f.label + ' kopieren'" [attr.aria-label]="f.label + ' kopieren'">
                  <app-icon [name]="copied() === f.value ? 'check' : 'copy'" [size]="16" />
                </button>
              </div>
            </div>
          }
        </div>
        <p class="hint small-text">Im Spiel unter Mehrspieler → Server hinzufügen eintragen.</p>
      </section>

      <section class="card">
        <div class="project-head">
          <h3>Spieler online</h3>
          <span class="hint">{{ i.players?.online ?? 0 }} Spieler</span>
        </div>
        @if (!i.players?.names?.length) {
          <p class="hint">Gerade ist niemand online.</p>
        } @else {
          <ul class="ban-list player-list">
            @for (name of i.players!.names; track name) {
              <li>
                <div class="item-cell">
                  <span class="mc-head" aria-hidden="true">
                    <span class="mc-head-letter">{{ name[0] }}</span>
                    <span class="mc-head-skin" [style.background-image]="'url(/api/server/skins/' + name + ')'"></span>
                  </span>
                  <span class="player-name">
                    <strong class="mono">{{ name }}</strong>
                    @if (i.accounts[name]) { <span class="player-account">{{ i.accounts[name] }}</span> }
                  </span>
                </div>
                <div class="row-actions">
                  <button class="secondary compact" (click)="kick(name)" [disabled]="busy()">Kicken</button>
                  <button class="danger compact" (click)="ban(name)" [disabled]="busy()">Bannen</button>
                </div>
              </li>
            }
          </ul>
        }
      </section>

      <section class="card">
        <h3>Admin-Chat</h3>
        <p class="hint small-text">Erscheint im Spiel-Chat als <span class="ok">[Neo]</span>.</p>
        <form class="chat-form" (submit)="say($event, msg)">
          <input #msg type="text" maxlength="200" placeholder="Text eingeben …" aria-label="Nachricht" />
          <button type="submit" [disabled]="busy()">Senden</button>
        </form>
      </section>

      <section class="card settings">
        <h3>Einstellungen</h3>
        <label class="switch-row setting">
          <span class="switch">
            <input type="checkbox" [checked]="i.whitelist.enabled" (change)="toggleWhitelist(!i.whitelist.enabled)"
                   [disabled]="busy() || i.whitelist.enabled === null" />
            <span></span>
          </span>
          <span class="switch-text">
            <strong>Whitelist</strong>
            <span class="hint">Nur freigeschaltete Spieler dürfen rein<span class="sep" aria-hidden="true"></span>{{ i.whitelist.names.length }} auf der Liste</span>
          </span>
        </label>
      </section>

      <details class="card" (toggle)="backupsOpen.set($any($event.target).open)">
        <summary>Backups</summary>
        @if (backupsOpen()) { <app-backups-panel /> }
      </details>
    } @else if (!error()) {
      <p class="hint">Lade …</p>
    }
  `,
})
export class AdminServer {
  private api = inject(ServerService);
  protected info = signal<ServerInfo | undefined>(undefined);
  protected busy = signal(false);
  /** laufende Server-Aktion für die Button-Beschriftung */
  protected action = signal<'' | 'restart' | 'stop' | 'start'>('');
  protected backupsOpen = signal(false);
  protected error = signal('');
  protected notice = signal('');
  protected copied = signal('');
  private timer = setInterval(() => !this.busy() && this.load(), POLL_MS);

  protected container = computed(() => {
    const c = this.info()?.container;
    return c && 'running' in c ? c : undefined;
  });
  protected state = computed(() => {
    const c = this.container();
    if (!c) return this.info()?.players ? 'online' : 'unknown';
    if (!c.running) return 'offline';
    return c.health === 'healthy' ? 'online' : 'starting';
  });
  protected stateLabel = computed(() => ({ online: 'Online', offline: 'Gestoppt', starting: 'Startet …', unknown: 'Unbekannt' })[this.state()]);
  protected uptime = computed(() => {
    const c = this.container();
    if (!c?.running) return c ? 'Container gestoppt' : 'Steuerdienst nicht erreichbar';
    const minutes = Math.floor((Date.now() - new Date(c.startedAt).getTime()) / 60_000);
    return minutes < 60 ? `läuft seit ${minutes} Min.` : `läuft seit ${Math.floor(minutes / 60)} Std. ${minutes % 60} Min.`;
  });
  protected memory = computed(() => {
    const m = this.container()?.memory;
    return m ? `${(m.usage / 1024 ** 3).toLocaleString('de-DE', { maximumFractionDigits: 1 })} GB` : '–';
  });

  constructor() {
    this.load();
  }

  ngOnDestroy() {
    clearInterval(this.timer);
  }

  private async load() {
    try {
      this.info.set(await this.api.info());
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  protected connectFields(i: ServerInfo) {
    const fields = [{ label: 'Adresse', value: i.address.host }];
    if (i.address.ip && i.address.ip !== i.address.host) fields.push({ label: 'IP', value: i.address.ip });
    return fields;
  }

  async copy(text: string) {
    const done = () => {
      this.copied.set(text);
      setTimeout(() => this.copied() === text && this.copied.set(''), 2000);
    };
    try {
      await navigator.clipboard.writeText(text);
      return done();
    } catch {
      // Ersatzweg für Browser ohne Zwischenablage-Rechte
      const area = Object.assign(document.createElement('textarea'), { value: text });
      area.style.cssText = 'position:fixed;opacity:0';
      document.body.append(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      if (ok) return done();
      this.error.set('Kopieren nicht möglich – bitte von Hand markieren.');
    }
  }

  toggleWhitelist(enabled: boolean) {
    if (enabled && !confirm('Whitelist einschalten? Spieler, die nicht auf der Liste stehen, werden sofort gekickt.')) {
      this.load();
      return;
    }
    this.run(() => this.api.whitelist(enabled), enabled ? 'Whitelist ist an.' : 'Whitelist ist aus.');
  }

  kick(name: string) {
    const reason = prompt(`${name} kicken? Grund (optional):`, '');
    if (reason === null) return;
    this.run(() => this.api.kick(name, reason), `${name} wurde gekickt.`);
  }

  ban(name: string) {
    const reason = prompt(`${name} im Spiel bannen?\n\nHat die Person ein Website-Konto, besser unter „Benutzer“ bannen – dann ist auch die Anmeldung gesperrt.\n\nGrund (optional):`, '');
    if (reason === null) return;
    this.run(() => this.api.ban(name, reason), `${name} wurde im Spiel gebannt.`);
  }

  say(event: Event, input: HTMLInputElement) {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    this.run(async () => {
      await this.api.say(message);
      input.value = '';
    }, 'Nachricht gesendet.');
  }

  async restart() {
    if (!confirm('Server jetzt neu starten? Alle Spieler werden getrennt.')) return;
    await this.serverAction('restart', () => this.api.restart(), 'Neustart ausgelöst – der Server ist in etwa einer Minute wieder da.');
  }

  async stop() {
    if (!confirm('Server stoppen? Alle Spieler werden getrennt, und er bleibt aus, bis du ihn wieder startest.')) return;
    await this.serverAction('stop', () => this.api.stop(), 'Server gestoppt.');
  }

  async start() {
    await this.serverAction('start', () => this.api.start(), 'Server startet – in etwa einer Minute ist er erreichbar.');
  }

  private async serverAction(kind: 'restart' | 'stop' | 'start', request: () => Promise<unknown>, success: string) {
    this.action.set(kind);
    await this.run(request, success);
    this.action.set('');
  }

  private async run(action: () => Promise<unknown>, success: string) {
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      await action();
      this.notice.set(success);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      await this.load();
      this.busy.set(false);
    }
  }
}
