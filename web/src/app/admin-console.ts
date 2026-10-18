import { Component, ElementRef, Injectable, computed, inject, signal, viewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from './projects.service';
import { Icon } from './icon';
import { GAMERULES, GAMERULE_GROUPS, GameruleGroup } from './gamerules';

export interface Operator { name: string; level: number }

export interface Gamerule { id: string; value: boolean | number; type: 'boolean' | 'integer' }

@Injectable({ providedIn: 'root' })
export class ConsoleService {
  private http = inject(HttpClient);
  logs() { return firstValueFrom(this.http.get<{ logs: string }>('/api/server/console')); }
  command(command: string) { return firstValueFrom(this.http.post<{ command: string; answer: string }>('/api/server/command', { command })); }
  maxPlayers() { return firstValueFrom(this.http.get<{ configured: number | null; active: number | null }>('/api/server/max-players')); }
  setMaxPlayers(value: number) { return firstValueFrom(this.http.post<{ configured: number }>('/api/server/max-players', { value })); }
  gamerules() { return firstValueFrom(this.http.get<{ rules: Gamerule[] }>('/api/server/gamerules')); }
  ops() { return firstValueFrom(this.http.get<{ ops: Operator[] }>('/api/server/ops')); }
  setOp(name: string, op: boolean) { return firstValueFrom(this.http.post<{ ops: Operator[] }>('/api/server/ops', { name, op })); }
  setGamerule(id: string, value: boolean | number) { return firstValueFrom(this.http.post<{ id: string; value: boolean | number }>('/api/server/gamerules', { id, value })); }
}

const LOG_POLL_MS = 2_000;
const HISTORY_KEY = 'neo.consoleHistory';
const HISTORY_MAX = 30;

/** Live-Log des Servers und Befehlszeile (RCON) – nur sichtbar, solange das Akkordeon offen ist */
@Component({
  selector: 'app-console-panel',
  imports: [Icon],
  template: `
    <div class="console-log" #log (scroll)="onScroll()" role="log" aria-live="off" aria-label="Server-Log">
      @for (l of lines(); track $index) {
        <div class="console-line" [attr.data-level]="l.level">{{ l.text }}</div>
      } @empty {
        <div class="console-line" data-level="info">{{ error() ? '' : 'Lade …' }}</div>
      }
    </div>
    @if (!follow()) {
      <button type="button" class="console-jump compact secondary with-icon" (click)="toBottom()"><app-icon name="arrow-down" [size]="14" />Zum neuesten Eintrag</button>
    }

    @if (answers().length) {
      <ul class="console-answers">
        @for (a of answers(); track $index) {
          <li><span class="mono">/{{ a.command }}</span><span>{{ a.answer || 'Ausgeführt (keine Rückmeldung).' }}</span></li>
        }
      </ul>
    }

    <form class="console-form" (submit)="send($event)">
      <span class="console-prompt" aria-hidden="true">/</span>
      <input #cmd type="text" maxlength="500" placeholder="Befehl eingeben, z. B. time set day" autocomplete="off" spellcheck="false"
             aria-label="Befehl" (keydown.arrowup)="history(-1, $event)" (keydown.arrowdown)="history(1, $event)" />
      <button type="submit" [disabled]="busy()">Ausführen</button>
    </form>
    @if (error()) { <p class="error small">{{ error() }}</p> }
    <p class="hint small-text">Befehle laufen mit vollen Rechten und werden im Protokoll gespeichert. IP-Adressen sind im Log ausgeblendet.</p>
  `,
})
export class ConsolePanel {
  private api = inject(ConsoleService);
  private logEl = viewChild.required<ElementRef<HTMLElement>>('log');
  private cmdEl = viewChild.required<ElementRef<HTMLInputElement>>('cmd');

  protected lines = signal<Array<{ text: string; level: 'info' | 'warn' | 'error' }>>([]);
  protected answers = signal<Array<{ command: string; answer: string }>>([]);
  protected busy = signal(false);
  protected error = signal('');
  /** am unteren Rand „kleben“, solange niemand hochgescrollt hat */
  protected follow = signal(true);
  private past: string[] = readHistory();
  private cursor = -1;
  private timer = setInterval(() => this.load(), LOG_POLL_MS);

  constructor() {
    this.load();
  }

  ngOnDestroy() {
    clearInterval(this.timer);
  }

  private async load() {
    try {
      const { logs } = await this.api.logs();
      this.lines.set(logs.split('\n').filter((l) => l.trim()).map((text) => ({
        text,
        level: /\b(ERROR|FATAL|SEVERE)\b|Exception/.test(text) ? 'error' : /\bWARN(ING)?\b/.test(text) ? 'warn' : 'info',
      })));
      if (this.error().startsWith('Log:')) this.error.set('');
      if (this.follow()) requestAnimationFrame(() => this.toBottom());
    } catch (err) {
      this.error.set(`Log: ${errorMessage(err)}`);
    }
  }

  protected onScroll() {
    const el = this.logEl().nativeElement;
    this.follow.set(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  }

  protected toBottom() {
    const el = this.logEl().nativeElement;
    el.scrollTop = el.scrollHeight;
    this.follow.set(true);
  }

  async send(event: Event) {
    event.preventDefault();
    const input = this.cmdEl().nativeElement;
    const command = input.value.trim().replace(/^\//, '');
    if (!command) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const res = await this.api.command(command);
      this.answers.update((a) => [...a, res].slice(-5));
      this.remember(command);
      input.value = '';
      setTimeout(() => this.load(), 400);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
      input.focus();
    }
  }

  /** ↑/↓ blättert durch die letzten Befehle (im Browser gemerkt) */
  history(step: -1 | 1, event: Event) {
    if (!this.past.length) return;
    event.preventDefault();
    this.cursor = this.cursor === -1 ? (step === -1 ? this.past.length - 1 : -1) : this.cursor + step;
    if (this.cursor < -1) this.cursor = -1;
    if (this.cursor >= this.past.length) this.cursor = -1;
    this.cmdEl().nativeElement.value = this.cursor === -1 ? '' : this.past[this.cursor];
  }

  private remember(command: string) {
    this.past = [...this.past.filter((c) => c !== command), command].slice(-HISTORY_MAX);
    this.cursor = -1;
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(this.past)); } catch { /* nur für diese Sitzung */ }
  }
}

function readHistory(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(saved) ? saved.filter((c) => typeof c === 'string').slice(-HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

const UNITS: Record<string, string> = {
  players_sleeping_percentage: '%', respawn_radius: 'Blöcke', fire_spread_radius_around_player: 'Blöcke',
  players_nether_portal_default_delay: 'Ticks', players_nether_portal_creative_delay: 'Ticks', max_snow_accumulation_height: 'Schichten',
};

/** Gamerules mit deutschen Namen, gruppiert und durchsuchbar; Änderungen gelten sofort */
@Component({
  selector: 'app-gamerules-panel',
  imports: [],
  template: `
    <div class="toolbar gamerule-toolbar">
      <input type="search" placeholder="Gamerule suchen …" (input)="query.set($any($event.target).value)" aria-label="Gamerule suchen" />
      <span class="hint">{{ changedCount() }} von {{ rules().length }} geändert</span>
    </div>
    @if (error()) { <p class="error small">{{ error() }}</p> }
    @if (!loaded()) {
      <p class="hint">Lade …</p>
    }
    @for (g of groups(); track g.name) {
      <section class="gamerule-group">
        <h4>{{ g.name }}</h4>
        <div class="gamerule-list">
          @if (g.name === 'Spieler' && maxPlayers(); as m) {
            <div class="gamerule" [class.changed]="m.configured !== m.active && m.active !== null">
              <div class="gamerule-text">
                <strong>Maximale Spielerzahl</strong>
                <span class="hint">Gilt ab dem nächsten Neustart.</span>
                <span class="gamerule-id mono">max-players
                  @if (m.configured !== m.active && m.active !== null) { <span class="sep" aria-hidden="true"></span>Aktuell {{ m.active }}, nach Neustart {{ m.configured }} }
                </span>
              </div>
              <label class="setting-field">
                <input type="number" min="1" max="500" step="1" [value]="m.configured" [disabled]="saving() === 'max-players'" aria-label="Maximale Spielerzahl"
                       (blur)="saveMaxPlayers($any($event.target))" (keydown.enter)="saveMaxPlayers($any($event.target))" />
                <span>Spieler</span>
              </label>
            </div>
          }
          @for (r of g.rules; track r.id) {
            <div class="gamerule" [class.changed]="isChanged(r)">
              <div class="gamerule-text">
                <strong>{{ label(r) }}</strong>
                @if (info(r)?.hint) { <span class="hint">{{ info(r)!.hint }}</span> }
                <span class="gamerule-id mono">{{ r.id }}@if (isChanged(r)) { <span class="sep" aria-hidden="true"></span>Standard: {{ shown(info(r)!.default) }} }</span>
              </div>
              @if (r.type === 'boolean') {
                <label class="switch" [title]="r.value ? 'Ausschalten' : 'Einschalten'">
                  <input type="checkbox" [checked]="r.value" [disabled]="saving() === r.id" [attr.aria-label]="label(r)"
                         (change)="save(r, $any($event.target).checked, $any($event.target))" />
                  <span></span>
                </label>
              } @else {
                <label class="setting-field">
                  <input type="number" step="1" [value]="r.value" [disabled]="saving() === r.id" [attr.aria-label]="label(r)"
                         (blur)="saveNumber(r, $any($event.target))" (keydown.enter)="saveNumber(r, $any($event.target))" />
                  @if (unit(r)) { <span>{{ unit(r) }}</span> }
                </label>
              }
            </div>
          }
        </div>
      </section>
    } @empty {
      @if (loaded()) { <p class="hint">Keine Gamerule gefunden.</p> }
    }
  `,
})
export class GamerulesPanel {
  private api = inject(ConsoleService);
  protected rules = signal<Gamerule[]>([]);
  protected loaded = signal(false);
  protected saving = signal('');
  protected error = signal('');
  protected query = signal('');
  protected maxPlayers = signal<{ configured: number | null; active: number | null } | undefined>(undefined);

  protected info = (r: Gamerule) => GAMERULES[r.id];
  protected label = (r: Gamerule) => GAMERULES[r.id]?.label ?? r.id;
  protected unit = (r: Gamerule) => UNITS[r.id] ?? '';
  protected isChanged = (r: Gamerule) => !!GAMERULES[r.id] && GAMERULES[r.id].default !== r.value;
  protected shown = (v: boolean | number) => (v === true ? 'an' : v === false ? 'aus' : v.toLocaleString('de-DE'));
  protected changedCount = computed(() => this.rules().filter((r) => this.isChanged(r)).length);

  protected groups = computed(() => {
    const q = this.query().trim().toLowerCase();
    const match = (r: Gamerule) => !q || r.id.includes(q.replace(/ /g, '_')) || this.label(r).toLowerCase().includes(q)
      || (GAMERULES[r.id]?.hint ?? '').toLowerCase().includes(q);
    const groupOf = (r: Gamerule): GameruleGroup => GAMERULES[r.id]?.group ?? 'Mods & Weitere';
    return GAMERULE_GROUPS
      .map((name) => ({ name, rules: this.rules().filter((r) => groupOf(r) === name && match(r)) }))
      .filter((g) => g.rules.length || (g.name === 'Spieler' && this.maxShown(q)));
  });

  /** Spielerzahl auch über die Suche findbar */
  private maxShown = (q: string) => !!this.maxPlayers() && (!q || 'maximale spielerzahl max-players spieler'.includes(q));

  constructor() {
    this.api.maxPlayers().then((m) => this.maxPlayers.set(m)).catch(() => undefined);
    this.api.gamerules()
      .then(({ rules }) => {
        // Reihenfolge innerhalb der Gruppen wie in der Beschreibungsliste, unbekannte alphabetisch
        const order = Object.keys(GAMERULES);
        const pos = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
        this.rules.set([...rules].sort((a, b) => pos(a.id) - pos(b.id) || a.id.localeCompare(b.id)));
      })
      .catch((err) => this.error.set(errorMessage(err)))
      .finally(() => this.loaded.set(true));
  }

  async save(r: Gamerule, value: boolean | number, el?: HTMLInputElement) {
    if (value === r.value) return;
    this.saving.set(r.id);
    this.error.set('');
    try {
      await this.api.setGamerule(r.id, value);
      this.rules.update((list) => list.map((x) => (x.id === r.id ? { ...x, value } : x)));
    } catch (err) {
      this.error.set(`${this.label(r)}: ${errorMessage(err)}`);
      // Schalter/Feld auf den alten Wert zurücksetzen
      if (el?.type === 'checkbox') el.checked = r.value as boolean;
      else if (el) el.value = String(r.value);
    } finally {
      this.saving.set('');
    }
  }

  async saveMaxPlayers(input: HTMLInputElement) {
    const m = this.maxPlayers();
    const value = Number(input.value);
    if (!m || value === m.configured) return;
    if (!Number.isInteger(value) || value < 1 || value > 500) {
      input.value = String(m.configured ?? '');
      return;
    }
    this.saving.set('max-players');
    this.error.set('');
    try {
      const { configured } = await this.api.setMaxPlayers(value);
      this.maxPlayers.set({ ...m, configured });
    } catch (err) {
      this.error.set(`Maximale Spielerzahl: ${errorMessage(err)}`);
      input.value = String(m.configured ?? '');
    } finally {
      this.saving.set('');
    }
  }

  saveNumber(r: Gamerule, input: HTMLInputElement) {
    const value = Number(input.value);
    if (!Number.isInteger(value)) {
      input.value = String(r.value);
      return;
    }
    this.save(r, value, input);
  }
}
