import { Component, Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AdminNav } from './admin-backups';
import { errorMessage } from './projects.service';

export interface ServerInfo {
  controlAvailable: boolean;
  container:
    | { running: boolean; status: string; health: string | null; startedAt: string; memory: { usage: number; limit: number } | null }
    | { error: string };
  players: { online: number; max: number; names: string[] } | null;
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
}

const POLL_MS = 5_000;

@Component({
  selector: 'app-admin-server',
  imports: [AdminNav],
  template: `
    <header class="page-head">
      <span class="eyebrow">Admin</span>
      <h1>Server</h1>
      <p class="hint">Status, Spieler, Whitelist und Ansagen. Aktionen wirken sofort im Spiel.</p>
    </header>

    <app-admin-nav />

    @if (error()) {
      <p class="error">{{ error() }}</p>
    }
    @if (notice()) {
      <p class="ok">{{ notice() }}</p>
    }

    @if (info(); as i) {
      <section class="card stats">
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
        <div>
          <strong>{{ i.whitelist.enabled === null ? '–' : i.whitelist.enabled ? 'an' : 'aus' }}</strong>
          <span class="hint">Whitelist · {{ i.whitelist.names.length }} Namen</span>
        </div>
      </section>

      <section class="card connect">
        <div>
          <h3>Verbinden</h3>
          <p class="hint">Im Spiel unter Mehrspieler → Server hinzufügen eintragen. Klappt die Adresse nicht, die IP nehmen.</p>
        </div>
        <div class="connect-rows">
          <div class="connect-row">
            <span class="hint">Adresse</span>
            <code class="connect-value">{{ i.address.host }}</code>
            <button type="button" class="secondary compact" (click)="copy(i.address.host)">{{ copied() === i.address.host ? 'Kopiert ✓' : 'Kopieren' }}</button>
          </div>
          @if (i.address.ip && i.address.ip !== i.address.host) {
            <div class="connect-row">
              <span class="hint">IP</span>
              <code class="connect-value">{{ i.address.ip }}</code>
              <button type="button" class="secondary compact" (click)="copy(i.address.ip)">{{ copied() === i.address.ip ? 'Kopiert ✓' : 'Kopieren' }}</button>
            </div>
          }
        </div>
      </section>

      <label class="card toggle">
        <input type="checkbox" [checked]="i.whitelist.enabled" (change)="toggleWhitelist(!i.whitelist.enabled)" [disabled]="busy() || i.whitelist.enabled === null" />
        <span>
          <strong>Whitelist aktiv</strong>
          <span class="hint">
            Nur freigeschaltete Spieler (mit Minecraft-Namen im Profil) dürfen rein. Wer nicht auf der Liste steht,
            wird beim Einschalten sofort gekickt.
            @if (i.whitelist.names.length) { Auf der Liste: {{ i.whitelist.names.join(', ') }}. }
          </span>
        </span>
      </label>

      <section class="card">
        <div class="project-head">
          <h3>Spieler online</h3>
          <span class="hint">{{ i.players?.online ?? 0 }} Spieler</span>
        </div>
        @if (!i.players?.names?.length) {
          <p class="hint">Gerade ist niemand online.</p>
        } @else {
          <ul class="ban-list">
            @for (name of i.players!.names; track name) {
              <li>
                <div class="item-cell">
                  <span class="avatar">{{ name[0] }}</span>
                  <strong class="mono">{{ name }}</strong>
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
        <h3>Ansage an alle</h3>
        <form class="mc-form" (submit)="say($event, msg)">
          <label>
            Nachricht (erscheint im Chat als <span class="ok">[Neo]</span> …)
            <input #msg type="text" maxlength="200" placeholder="z. B. Heute Abend um 20 Uhr Bauabend am Starterhaus!" />
          </label>
          <button type="submit" [disabled]="busy()">Senden</button>
        </form>
      </section>

      <section class="card danger-zone">
        <div>
          <h3>Server neu starten</h3>
          <p class="hint">Spieler werden {{ 10 }} Sekunden vorher im Chat gewarnt. Dauert etwa eine Minute.</p>
        </div>
        <button class="danger" (click)="restart()" [disabled]="busy() || !i.controlAvailable">
          {{ restarting() ? 'Startet neu …' : 'Neu starten' }}
        </button>
      </section>
    } @else if (!error()) {
      <p class="hint">Lade …</p>
    }
  `,
})
export class AdminServer {
  private api = inject(ServerService);
  protected info = signal<ServerInfo | undefined>(undefined);
  protected busy = signal(false);
  protected restarting = signal(false);
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
    const reason = prompt(`${name} im Spiel bannen?\n\nHat die Person ein Website-Konto, besser unter „Benutzer & Bans“ bannen – dann ist auch die Anmeldung gesperrt.\n\nGrund (optional):`, '');
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
    }, 'Ansage gesendet.');
  }

  async restart() {
    if (!confirm('Server jetzt neu starten? Alle Spieler werden getrennt.')) return;
    this.restarting.set(true);
    await this.run(() => this.api.restart(), 'Neustart ausgelöst – der Server ist in etwa einer Minute wieder da.');
    this.restarting.set(false);
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
