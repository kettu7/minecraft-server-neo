import { Component, Injectable, computed, inject, input, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Icon } from './icon';

export interface PerfSample {
  t: string;
  tps: number | null;
  mspt: number | null;
  p95: number | null;
  cpu: number | null;
  memory: number | null;
  players: number | null;
  state: 'normal' | 'frozen' | 'sprinting' | 'stepping' | null;
}

export interface Performance { intervalSeconds: number; cpus: number; memoryLimit: number | null; samples: PerfSample[] }

@Injectable({ providedIn: 'root' })
export class PerformanceService {
  private http = inject(HttpClient);
  get() { return firstValueFrom(this.http.get<Performance>('/api/server/performance')); }
}

const W = 240;
const H = 48;

/** Kleiner Verlauf (eine Reihe, feste y-Achse ab 0) mit Fadenkreuz und Tooltip beim Überfahren */
@Component({
  selector: 'app-sparkline',
  template: `
    <div class="spark" (pointermove)="hover($event)" (pointerleave)="active.set(-1)">
      <svg [attr.viewBox]="'0 0 ' + w + ' ' + h" preserveAspectRatio="none" role="img" [attr.aria-label]="summary()">
        <line class="spark-base" x1="0" [attr.y1]="h - 1" [attr.x2]="w" [attr.y2]="h - 1" />
        @if (area()) { <path class="spark-area" [attr.d]="area()" /> }
        @if (line()) { <path class="spark-line" [attr.d]="line()" /> }
        @if (active() >= 0 && point(active()); as p) {
          <line class="spark-cross" [attr.x1]="p.x" y1="0" [attr.x2]="p.x" [attr.y2]="h" />
        }
      </svg>
      @if (active() >= 0 && point(active()); as p) {
        <span class="spark-dot" [style.left.%]="(p.x / w) * 100" [style.top.%]="(p.y / h) * 100"></span>
        <span class="spark-tip" [style.left.%]="(p.x / w) * 100" [class.flip]="p.x > w * 0.7">
          <b>{{ format()(values()[active()]!) }}</b>{{ time(times()[active()]) }}
        </span>
      }
    </div>
  `,
})
export class Sparkline {
  values = input.required<Array<number | null>>();
  times = input.required<string[]>();
  /** Obergrenze der y-Achse (mindestens; wächst mit den Daten) */
  max = input.required<number>();
  format = input.required<(v: number) => string>();
  label = input('');

  protected w = W;
  protected h = H;
  protected active = signal(-1);

  private top = computed(() => Math.max(this.max(), ...this.values().filter((v): v is number => v !== null)) || 1);
  protected point = (i: number) => {
    const v = this.values()[i];
    if (v === null || v === undefined) return null;
    const n = Math.max(1, this.values().length - 1);
    return { x: (i / n) * W, y: H - 2 - (v / this.top()) * (H - 6) };
  };

  /** Linie mit Lücken, wo keine Messung vorliegt (Server aus) */
  protected line = computed(() => {
    let d = '';
    let pen = false;
    this.values().forEach((_, i) => {
      const p = this.point(i);
      if (!p) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      pen = true;
    });
    return d;
  });
  protected area = computed(() => {
    const parts: string[] = [];
    let seg: Array<{ x: number; y: number }> = [];
    const flush = () => {
      if (seg.length > 1) parts.push(`M${seg[0].x},${H - 1}` + seg.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('') + `L${seg.at(-1)!.x},${H - 1}Z`);
      seg = [];
    };
    this.values().forEach((_, i) => {
      const p = this.point(i);
      if (p) seg.push(p);
      else flush();
    });
    flush();
    return parts.join('');
  });
  protected summary = computed(() => {
    const v = this.values().filter((x): x is number => x !== null);
    if (!v.length) return `${this.label()}: noch keine Messwerte`;
    const f = this.format();
    return `${this.label()}: zuletzt ${f(v.at(-1)!)}, niedrigster Wert ${f(Math.min(...v))}, höchster ${f(Math.max(...v))}`;
  });

  hover(e: PointerEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const n = this.values().length;
    if (!n) return;
    const i = Math.round(((e.clientX - r.left) / r.width) * (n - 1));
    // nächste Messung mit Wert suchen (Lücken überspringen)
    for (let d = 0; d < n; d++) {
      for (const j of [i - d, i + d]) {
        if (j >= 0 && j < n && this.values()[j] !== null) return this.active.set(j);
      }
    }
    this.active.set(-1);
  }

  protected time(iso: string) {
    return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }
}

const POLL_MS = 15_000;
const num = (v: number, digits = 1) => v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const gb = (bytes: number) => `${num(bytes / 1024 ** 3)} GB`;

/** Leistung: TPS, Tick-Zeit, CPU, RAM – aktueller Wert groß, Verlauf der letzten 2 Stunden darunter */
@Component({
  selector: 'app-performance-panel',
  imports: [Sparkline, Icon],
  template: `
    @if (data(); as d) {
      <div class="perf-tiles">
        <div class="perf-tile">
          <span class="perf-label">TPS</span>
          <strong>{{ last()?.tps !== null && last()?.tps !== undefined ? fmtTps(last()!.tps!) : '–' }}</strong>
          @if (tpsState(); as s) {
            <span class="perf-status" [attr.data-state]="s.state"><app-icon [name]="s.icon" [size]="14" />{{ s.label }}</span>
          }
          <app-sparkline label="TPS" [values]="series('tps')" [times]="times()" [max]="20" [format]="fmtTps" />
        </div>
        <div class="perf-tile">
          <span class="perf-label">Zeit pro Tick</span>
          <strong>{{ last()?.mspt !== null && last()?.mspt !== undefined ? fmtMs(last()!.mspt!) : '–' }}</strong>
          <span class="perf-sub">@if (last()?.p95 !== null && last()?.p95 !== undefined) { P95 {{ fmtMs(last()!.p95!) }}<span class="sep" aria-hidden="true"></span> }Grenze 50 ms</span>
          <app-sparkline label="Zeit pro Tick" [values]="series('mspt')" [times]="times()" [max]="50" [format]="fmtMs" />
        </div>
        <div class="perf-tile">
          <span class="perf-label">CPU</span>
          <strong>{{ last()?.cpu !== null && last()?.cpu !== undefined ? fmtPct(last()!.cpu!) : '–' }}</strong>
          <span class="perf-sub">von {{ d.cpus }} Kernen</span>
          <app-sparkline label="CPU" [values]="series('cpu')" [times]="times()" [max]="100" [format]="fmtPct" />
        </div>
        <div class="perf-tile">
          <span class="perf-label">Arbeitsspeicher</span>
          <strong>{{ last()?.memory ? fmtGb(last()!.memory!) : '–' }}</strong>
          <span class="perf-sub">{{ d.memoryLimit ? 'von ' + fmtGb(d.memoryLimit) : '' }}</span>
          <app-sparkline label="Arbeitsspeicher" [values]="series('memory')" [times]="times()" [max]="d.memoryLimit ?? 1" [format]="fmtGb" />
        </div>
      </div>
      <p class="hint small-text perf-note">
        {{ range() }}<span class="sep" aria-hidden="true"></span>Messung alle {{ d.intervalSeconds }} s
        @if (last()?.players === 0) { <span class="sep" aria-hidden="true"></span>Ohne Spieler pausiert der Server, die Werte ruhen dann. }
      </p>
    } @else {
      <p class="hint">{{ error() || 'Lade …' }}</p>
    }
  `,
})
export class PerformancePanel {
  private api = inject(PerformanceService);
  protected data = signal<Performance | undefined>(undefined);
  protected error = signal('');
  private timer = setInterval(() => this.load(), POLL_MS);

  protected last = computed(() => this.data()?.samples.at(-1));
  protected times = computed(() => this.data()?.samples.map((s) => s.t) ?? []);
  protected series = (key: 'tps' | 'mspt' | 'cpu' | 'memory') => this.data()?.samples.map((s) => s[key]) ?? [];
  protected range = computed(() => {
    const s = this.data()?.samples ?? [];
    if (s.length < 2) return 'Verlauf beginnt gerade';
    const from = new Date(s[0].t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    return Date.now() - new Date(s[0].t).getTime() > 110 * 60_000 ? 'Letzte 2 Stunden' : `Verlauf seit ${from} Uhr`;
  });

  /** Status mit Icon und Text – nie nur Farbe */
  protected tpsState = computed(() => {
    const s = this.last();
    if (!s || s.tps === null) return null;
    if (s.state === 'frozen') return { state: 'warn', icon: 'alert-triangle' as const, label: 'Eingefroren' };
    if (s.tps >= 19.5) return { state: 'good', icon: 'circle-check' as const, label: 'Läuft flüssig' };
    if (s.tps >= 15) return { state: 'warn', icon: 'alert-triangle' as const, label: 'Leicht verzögert' };
    return { state: 'bad', icon: 'alert-triangle' as const, label: 'Ruckelt' };
  });

  protected fmtTps = (v: number) => `${num(v)} TPS`;
  protected fmtMs = (v: number) => `${num(v)} ms`;
  protected fmtPct = (v: number) => `${num(v, v < 10 ? 1 : 0)} %`;
  protected fmtGb = (v: number) => gb(v);

  constructor() {
    this.load();
  }

  ngOnDestroy() {
    clearInterval(this.timer);
  }

  private async load() {
    try {
      this.data.set(await this.api.get());
      this.error.set('');
    } catch {
      this.error.set('Leistungsdaten nicht verfügbar.');
    }
  }
}
