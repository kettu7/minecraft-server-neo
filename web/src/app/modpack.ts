import { Component, Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { errorMessage, formatDate } from './projects.service';

export type PackKind = 'mod' | 'resourcepack' | 'shader';
export type PackMode = 'required' | 'optional' | 'excluded';

export interface PackContent {
  projectId: string;
  title: string;
  description: string;
  icon: string | null;
  url: string;
  kind: PackKind;
  mode: 'required' | 'optional';
  versionNumber: string;
  fromServer: boolean;
}

export interface Modpack {
  name: string;
  version: string;
  updatedAt: string;
  minecraft: string;
  loader: string;
  size: number;
  contents: PackContent[];
  problems: string[];
}

export interface PackRow {
  projectId: string;
  title: string;
  description: string;
  icon: string | null;
  url: string;
  kind: PackKind;
  source: 'server' | 'client';
  clientSide: string;
  setting: 'auto' | PackMode;
  locked: boolean;
  mode: PackMode;
  reason: string | null;
  /** Mods im Pack, die diesen Eintrag brauchen */
  neededBy: string[];
  auto: boolean;
  note: string;
  versionNumber: string;
  update: { id: string; number: string } | null;
}

export interface PackManage {
  version: string;
  updatedAt: string;
  minecraft: string;
  loader: string;
  size: number;
  counts: { required: number; optional: number };
  rows: PackRow[];
  problems: string[];
  pendingServerChanges: boolean;
}

export interface PackHit {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  icon: string | null;
  url: string;
  downloads: number;
  clientSide: string;
  serverSide: string;
  inList: boolean;
}

@Injectable({ providedIn: 'root' })
export class ModpackService {
  private http = inject(HttpClient);
  info() { return firstValueFrom(this.http.get<Modpack>('/api/modpack')); }
  manage() { return firstValueFrom(this.http.get<PackManage>('/api/modpack/manage')); }
  search(q: string, kind: PackKind, offset = 0) {
    return firstValueFrom(this.http.get<{ total: number; hits: PackHit[] }>('/api/modpack/search', { params: { q, kind, offset } }));
  }
  add(projectId: string, kind: PackKind, mode: 'required' | 'optional') {
    return firstValueFrom(this.http.post<{ added: Array<{ projectId: string; title: string; auto: boolean }> }>('/api/modpack/items', { projectId, kind, mode }));
  }
  updateItem(projectId: string, body: { mode?: PackMode; note?: string; versionId?: string }) {
    return firstValueFrom(this.http.patch(`/api/modpack/items/${projectId}`, body));
  }
  removeItem(projectId: string) { return firstValueFrom(this.http.delete(`/api/modpack/items/${projectId}`)); }
  setServerMode(projectId: string, mode: 'auto' | PackMode) {
    return firstValueFrom(this.http.patch(`/api/modpack/server/${projectId}`, { mode }));
  }
}

export const KIND_LABELS: Record<PackKind, string> = { mod: 'Mod', resourcepack: 'Ressourcenpaket', shader: 'Shader' };
export const megabytes = (bytes: number) => (bytes / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 });

const SEEN_KEY = 'neo.modpackVersion';

/** Seite für Spieler: Modpack herunterladen und installieren */
@Component({
  selector: 'app-modpack',
  template: `
    <header class="page-head">
      <span class="eyebrow">Für Spieler</span>
      <h1>Modpack</h1>
      <p class="hint">Alle Mods für Neo in einem Paket.</p>
    </header>

    @if (error()) { <p class="error">{{ error() }}</p> }

    @if (pack(); as p) {
      <section class="card pack-hero">
        <div class="pack-badge" aria-hidden="true">
          <svg width="44" height="44" viewBox="0 0 32 32">
            <path d="M16 2 29 9.5 16 17 3 9.5Z" fill="#7cf279" />
            <path d="M3 9.5 16 17v13L3 22.5Z" fill="#2fb836" />
            <path d="M29 9.5 16 17v13l13-7.5Z" fill="#1c7a22" />
          </svg>
        </div>
        <div class="pack-hero-text">
          <span class="eyebrow">Version {{ p.version }}
            @if (isNew()) { <span class="new-badge">Neu für dich</span> }
          </span>
          <h2>{{ p.name }} Modpack</h2>
          <p class="hint">
            Minecraft {{ p.minecraft }}<span class="sep" aria-hidden="true"></span>Fabric {{ p.loader }}<span class="sep" aria-hidden="true"></span>{{ required().length }} Pflicht, {{ optional().length }} optional<span class="sep" aria-hidden="true"></span>{{ size(p.size) }} MB<span class="sep" aria-hidden="true"></span>aktualisiert {{ date(p.updatedAt) }}
          </p>
        </div>
        <a class="button-primary" href="/api/modpack/download" (click)="markSeen(p.version)" download>Herunterladen</a>
      </section>

      <section class="card">
        <h3>So installierst du es</h3>
        <ol class="steps">
          <li>
            <strong>Modrinth App installieren</strong>
            <span class="hint">Kostenlos unter <a href="https://modrinth.com/app" target="_blank" rel="noopener noreferrer">modrinth.com/app</a>. Mit deinem Microsoft-Konto anmelden.</span>
          </li>
          <li>
            <strong>Modpack herunterladen</strong>
            <span class="hint">Über den Knopf oben – du bekommst eine Datei <code>Neo-{{ p.version }}.mrpack</code>.</span>
          </li>
          <li>
            <strong>In der App importieren</strong>
            <span class="hint">Die Datei ins App-Fenster ziehen – oder links auf <b>+</b> („Instanz erstellen“) → „Aus Datei importieren“.</span>
          </li>
          <li>
            <strong>Spielen</strong>
            <span class="hint">Instanz „Neo“ starten. Optionale Inhalte kannst du in der Instanz unter „Inhalte“ ausschalten.</span>
          </li>
        </ol>
        <p class="hint small-print">
          Neue Version? Dann steht oben eine höhere Nummer. Einfach neu herunterladen und importieren –
          eigene Einstellungen oder Schematics bei Bedarf aus der alten Instanz kopieren.
        </p>
      </section>

      @for (group of groups(); track group.key) {
        @if (group.items.length) {
          <section class="card">
            <div class="project-head">
              <h3>{{ group.title }}</h3>
              <span class="hint">{{ group.items.length }}</span>
            </div>
            <p class="hint">{{ group.hint }}</p>
            <ul class="pack-grid">
              @for (c of group.items; track c.projectId) {
                <li>
                  @if (c.icon) { <img class="mod-icon" [src]="c.icon" alt="" loading="lazy" /> }
                  @else { <span class="mod-icon placeholder">?</span> }
                  <div class="item-text">
                    <a class="mod-title" [href]="c.url" target="_blank" rel="noopener noreferrer">{{ c.title }}</a>
                    <span class="mod-desc">{{ c.description }}</span>
                    <span class="mod-deps">
                      <span class="kind-tag" [attr.data-kind]="c.kind">{{ kind(c.kind) }}</span>
                      <span class="mono">{{ c.versionNumber }}</span>
                      @if (c.fromServer) { <span class="sep" aria-hidden="true"></span><span>auch auf dem Server</span> }
                    </span>
                  </div>
                </li>
              }
            </ul>
          </section>
        }
      }
    } @else if (!error()) {
      <p class="hint">Lade …</p>
    }
  `,
})
export class ModpackPage {
  private api = inject(ModpackService);
  protected pack = signal<Modpack | undefined>(undefined);
  protected error = signal('');
  private seen = signal(readSeen());

  protected required = computed(() => this.pack()?.contents.filter((c) => c.mode === 'required') ?? []);
  protected optional = computed(() => this.pack()?.contents.filter((c) => c.mode === 'optional') ?? []);
  protected isNew = computed(() => {
    const seen = this.seen();
    return !!seen && seen !== this.pack()?.version;
  });
  protected groups = computed(() => [
    { key: 'required', title: 'Pflicht', hint: 'Wird immer installiert – ohne diese Mods geht es nicht oder es fehlt Wichtiges.', items: this.required() },
    { key: 'optional', title: 'Optional', hint: 'Nette Extras. Kannst du in der Instanz ausschalten, z. B. Shader auf schwächeren PCs.', items: this.optional() },
  ]);

  constructor() {
    this.load();
  }

  private async load() {
    try {
      this.pack.set(await this.api.info());
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  markSeen(version: string) {
    try { localStorage.setItem(SEEN_KEY, version); } catch { /* egal */ }
    this.seen.set(version);
  }

  kind(k: PackKind) { return KIND_LABELS[k]; }
  size(bytes: number) { return megabytes(bytes); }
  date(iso: string) { return formatDate(iso); }
}

function readSeen(): string | null {
  try { return localStorage.getItem(SEEN_KEY); } catch { return null; }
}

/** „Aktualisiert 24.10.“ für Menü und Dashboard – in den ersten 7 Tagen hervorgehoben */
export function packUpdated(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return null;
  const d = new Date(iso);
  return {
    text: `Aktualisiert ${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}`,
    fresh: now - d.getTime() < 7 * 86400_000,
    title: `Modpack zuletzt geändert am ${d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}`,
  };
}
