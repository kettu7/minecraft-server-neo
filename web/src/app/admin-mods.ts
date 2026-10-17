import { Component, ElementRef, Injectable, computed, inject, signal, viewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DecimalPipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { AdminNav } from './admin-nav';
import { errorMessage, formatDate } from './projects.service';
import { Icon } from './icon';

export type Side = 'required' | 'optional' | 'unsupported' | 'unknown';
interface VersionRef { id: string; number: string; type: string; published: string }

export type ModState = 'active' | 'new' | 'enabling' | 'disabling' | 'disabled' | 'version' | 'missing';

export interface ManagedMod {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  icon: string | null;
  url: string;
  clientSide: Side;
  serverSide: Side;
  versionId: string;
  versionNumber: string;
  versionType: string;
  versionPublished: string;
  enabled: boolean;
  auto: boolean;
  note: string;
  addedBy: string | null;
  state: ModState;
  installed: { file: string; versionId: string; number: string } | null;
  update: VersionRef | null;
  requiresTitles: Array<{ id: string; title: string; ok: boolean }>;
  requiredBy: string[];
  orphan: boolean;
}

export interface ModChange {
  projectId: string;
  title: string;
  kind: 'add' | 'remove' | 'enable' | 'disable' | 'version';
  from?: string;
  to?: string;
}

export interface ApplyJob {
  running: boolean;
  step: string;
  by: string;
  startedAt: string;
  finishedAt?: string;
  ok?: boolean;
  error?: string;
  problems?: string[];
  backupId?: string;
  logs?: string;
}

interface GameVersion { version: string; type: 'release' | 'snapshot'; date: string }

export interface ModsOverview {
  minecraft: { version: string | null; newerReleases: GameVersion[]; snapshots: GameVersion[] };
  loader: { name: string; version: string | null; latest: string | null };
  managed: ManagedMod[];
  unmanaged: Array<{ file: string; size: number }>;
  pending: ModChange[];
  dependencyProblems: Array<{ mod: string; needs: string }>;
  apply: ApplyJob | null;
  canApply: boolean;
  checkedAt: string;
}

export interface SearchHit {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  icon: string | null;
  url: string;
  downloads: number;
  clientSide: Side;
  serverSide: Side;
  updated: string;
  inList: boolean;
}

export interface UpgradeCheck {
  target: string;
  loaderAvailable: boolean;
  ready: number;
  total: number;
  mods: Array<{ file: string; title: string; icon: string | null; known: boolean; version: VersionRef | null }>;
  checkedAt: string;
}

@Injectable({ providedIn: 'root' })
export class ModsService {
  private http = inject(HttpClient);
  overview(refresh = false) {
    return firstValueFrom(this.http.get<ModsOverview>('/api/mods', { params: refresh ? { refresh: '1' } : {} }));
  }
  search(q: string, offset = 0) {
    return firstValueFrom(this.http.get<{ total: number; hits: SearchHit[] }>('/api/mods/search', { params: { q, offset } }));
  }
  add(projectId: string) {
    return firstValueFrom(this.http.post<{ added: Array<{ projectId: string; title: string; auto: boolean }> }>('/api/mods/manage', { projectId }));
  }
  update(projectId: string, body: { enabled?: boolean; cascade?: boolean; note?: string; versionId?: string }) {
    return firstValueFrom(this.http.patch<{ ok: true; changed: string[] }>(`/api/mods/manage/${projectId}`, body));
  }
  remove(projectId: string) {
    return firstValueFrom(this.http.delete(`/api/mods/manage/${projectId}`));
  }
  discard() {
    return firstValueFrom(this.http.post('/api/mods/discard', {}));
  }
  apply() {
    return firstValueFrom(this.http.post('/api/mods/apply', {}));
  }
  upgrade(version: string) {
    return firstValueFrom(this.http.get<UpgradeCheck>('/api/mods/upgrade', { params: { version } }));
  }
}

type Filter = 'all' | 'active' | 'disabled' | 'updates' | 'planned';

const STATE_LABELS: Record<ModState, { label: string; pill: string }> = {
  active: { label: 'Aktiv', pill: 'covered' },
  new: { label: 'Neu (geplant)', pill: 'planned' },
  enabling: { label: 'Wird aktiviert', pill: 'planned' },
  version: { label: 'Update geplant', pill: 'planned' },
  disabling: { label: 'Wird deaktiviert', pill: 'partial' },
  disabled: { label: 'Deaktiviert', pill: 'off' },
  missing: { label: 'Nicht installiert', pill: 'missing' },
};

const CHANGE_LABELS: Record<ModChange['kind'], string> = {
  add: 'Neu',
  remove: 'Entfernen',
  enable: 'Aktivieren',
  disable: 'Deaktivieren',
  version: 'Update',
};

@Component({
  selector: 'app-admin-mods',
  imports: [AdminNav, DecimalPipe, Icon],
  template: `
    <app-admin-nav />

    @if (error()) {
      <p class="error">{{ error() }}</p>
    }
    @if (notice()) {
      <p class="ok">{{ notice() }}</p>
    }

    @if (data(); as d) {
      <section class="card stats">
        <div>
          <strong>{{ d.minecraft.version ?? '–' }}</strong>
          <span class="hint">
            Minecraft<span class="sep" aria-hidden="true"></span>
            @if (d.minecraft.newerReleases.length) {
              <span class="warn-text">{{ d.minecraft.newerReleases[0].version }} verfügbar</span>
            } @else { neueste Version }
          </span>
        </div>
        <div>
          <strong>{{ d.loader.version ?? '–' }}</strong>
          <span class="hint">
            {{ d.loader.name }} Loader<span class="sep" aria-hidden="true"></span>
            @if (d.loader.latest && d.loader.latest !== d.loader.version) {
              <span class="warn-text">{{ d.loader.latest }} verfügbar</span>
            } @else { aktuell }
          </span>
        </div>
        <div>
          <strong>{{ activeCount() }}<small> / {{ d.managed.length }}</small></strong>
          <span class="hint">Mods aktiv</span>
        </div>
        <div>
          <strong [class.warn-text]="updates() > 0" [class.ok]="updates() === 0">
            {{ updates() === 0 ? 'Alles aktuell' : updates() + (updates() === 1 ? ' Update' : ' Updates') }}
          </strong>
          <span class="hint">geprüft {{ time(d.checkedAt) }}</span>
        </div>
      </section>

      <!-- Übernehmen: läuft gerade / Ergebnis / geplante Änderungen -->
      @if (d.apply?.running) {
        <section class="card apply-bar running" aria-live="polite">
          <span class="spinner" aria-hidden="true"></span>
          <div>
            <strong>Änderungen werden übernommen …</strong>
            <span class="hint">{{ d.apply!.step }}<span class="sep" aria-hidden="true"></span>gestartet von {{ d.apply!.by }} um {{ time(d.apply!.startedAt) }}. Dauert meist 1–2 Minuten.</span>
          </div>
        </section>
      } @else if (d.pending.length) {
        <section class="card apply-bar">
          <div class="apply-info">
            <strong>{{ d.pending.length }} {{ d.pending.length === 1 ? 'Änderung' : 'Änderungen' }} geplant</strong>
            <div class="change-chips">
              @for (c of d.pending; track c.projectId + c.kind) {
                <span class="change" [attr.data-kind]="c.kind">
                  <b>{{ changeLabel(c) }}</b> {{ c.title }}
                  @if (c.kind === 'version') { <span class="mono with-icon">{{ c.from }}<app-icon name="arrow-right" [size]="12" />{{ c.to }}</span> }
                </span>
              }
            </div>
            @if (d.dependencyProblems.length) {
              <p class="error small">
                Es fehlen benötigte Mods:
                @for (p of d.dependencyProblems; track $index; let last = $last) { {{ p.mod }} braucht {{ p.needs }}{{ last ? '' : '; ' }} }
              </p>
            }
          </div>
          <div class="apply-actions">
            <button type="button" class="secondary" (click)="discard()" [disabled]="busy()">Verwerfen</button>
            <button type="button" (click)="apply()" [disabled]="busy() || !d.canApply || d.dependencyProblems.length > 0">Übernehmen</button>
          </div>
        </section>
      }
      @if (!d.apply?.running && d.apply?.finishedAt && !dismissedResult()) {
        <section class="card apply-result" [class.failed]="!d.apply!.ok">
          <div class="project-head">
            <strong>
              <span class="with-icon"><app-icon [name]="d.apply!.ok ? 'circle-check' : 'alert-triangle'" [size]="18" />{{ d.apply!.ok ? 'Änderungen übernommen' : d.apply!.error ? 'Übernehmen fehlgeschlagen' : 'Übernommen, mit Hinweisen' }}</span>
            </strong>
            <button type="button" class="link" (click)="dismissedResult.set(true)">ausblenden</button>
          </div>
          <span class="hint">
            {{ d.apply!.by }}<span class="sep" aria-hidden="true"></span>{{ date(d.apply!.finishedAt!) }}
            @if (d.apply!.backupId) { <span class="sep" aria-hidden="true"></span>Backup vorher: {{ d.apply!.backupId }} }
          </span>
          @if (d.apply!.error) { <p class="error small">{{ d.apply!.error }}</p> }
          @for (p of d.apply!.problems ?? []; track $index) { <p class="warn small-text">{{ p }}</p> }
          @if (d.apply!.logs) {
            <details class="logs">
              <summary>Server-Log anzeigen</summary>
              <pre>{{ d.apply!.logs }}</pre>
            </details>
          }
        </section>
      }

      <section class="mat-panel">
        <header class="mat-toolbar">
          <div class="segmented" role="group" aria-label="Mods filtern">
            @for (f of filters(); track f.key) {
              <button type="button" [class.active]="filter() === f.key" [attr.aria-pressed]="filter() === f.key" (click)="filter.set(f.key)">
                {{ f.label }} <span class="seg-count">{{ f.count }}</span>
              </button>
            }
          </div>
          <div class="mat-toolbar-right">
            <button type="button" class="secondary compact" (click)="load(true)" [disabled]="loading()">
              {{ loading() ? 'Prüfe …' : 'Jetzt prüfen' }}
            </button>
            <button type="button" class="compact with-icon" (click)="openSearch()" [disabled]="running()"><app-icon name="plus" [size]="14" [stroke]="2.5" />Mod hinzufügen</button>
          </div>
        </header>

        <div class="mat-scroll">
          <table class="mat-table mod-table">
            <thead>
              <tr>
                <th>Mod</th>
                <th>Version</th>
                <th>Läuft auf</th>
                <th class="status-col">Status</th>
                <th class="toggle-col">Aktiv</th>
                <th class="actions-col"><span class="sr-only">Aktionen</span></th>
              </tr>
            </thead>
            <tbody>
              @for (m of visible(); track m.projectId) {
                <tr [attr.data-state]="m.state" [class.off]="!m.enabled">
                  <td>
                    <div class="item-cell">
                      @if (m.icon) {
                        <img class="mod-icon" [src]="m.icon" alt="" loading="lazy" />
                      } @else {
                        <span class="mod-icon placeholder">?</span>
                      }
                      <div class="item-text">
                        <a class="mod-title" [href]="m.url" target="_blank" rel="noopener noreferrer">{{ m.title }}</a>
                        <span class="mod-desc">{{ m.description }}</span>
                        @if (m.note) { <span class="mod-note with-icon"><app-icon name="note" [size]="14" />{{ m.note }}</span> }
                        @if (m.requiresTitles.length || m.requiredBy.length || m.auto) {
                          <span class="mod-deps">
                            @if (m.requiresTitles.length) {
                              <span>braucht
                                @for (r of m.requiresTitles; track r.id; let last = $last) {
                                  <b [class.missing-dep]="!r.ok" [title]="r.ok ? '' : 'fehlt oder deaktiviert'">{{ r.title }}</b>{{ last ? '' : ', ' }}
                                }
                              </span>
                            }
                            @if (m.requiredBy.length) {
                              <span>gebraucht von <b>{{ m.requiredBy.join(', ') }}</b></span>
                            }
                            @if (m.orphan) {
                              <span class="orphan">wird nicht mehr gebraucht</span>
                            } @else if (m.auto) {
                              <span>automatisch als Abhängigkeit</span>
                            }
                          </span>
                        }
                      </div>
                    </div>
                  </td>
                  <td>
                    <div class="version-cell">
                      <span class="mono version" [title]="m.installed?.file ?? ''">{{ m.versionNumber }}</span>
                      @if (m.update && m.update.id !== m.versionId) {
                        <button type="button" class="update-btn" (click)="updateMod(m)" [disabled]="busy() || running()"
                                [title]="'Auf ' + m.update.number + ' aktualisieren (veröffentlicht ' + date(m.update.published) + ')'">
                          <app-icon name="arrow-up" [size]="13" />{{ m.update.number }}
                        </button>
                      }
                    </div>
                  </td>
                  <td>
                    <span class="side" [attr.data-side]="side(m)" [title]="sideHint(m)">{{ sideLabel(m) }}</span>
                  </td>
                  <td class="status-col">
                    <span class="pill" [attr.data-state]="stateInfo(m).pill"><i></i>{{ stateInfo(m).label }}</span>
                  </td>
                  <td class="toggle-col">
                    <label class="switch" [title]="m.enabled ? 'Deaktivieren' : 'Aktivieren'">
                      <input type="checkbox" [checked]="m.enabled" (change)="toggle(m, $event)" [disabled]="busy() || running()"
                             [attr.aria-label]="m.title + (m.enabled ? ' deaktivieren' : ' aktivieren')" />
                      <span></span>
                    </label>
                  </td>
                  <td class="actions-col">
                    <div class="row-actions">
                      <button type="button" class="icon-btn" (click)="editNote(m)" [disabled]="busy() || running()" title="Notiz"><app-icon name="pencil" /></button>
                      <button type="button" class="icon-btn danger" (click)="remove(m)" [disabled]="busy() || running()" title="Aus der Liste entfernen"><app-icon name="x" [size]="16" /></button>
                    </div>
                  </td>
                </tr>
              } @empty {
                <tr class="empty"><td colspan="6">Keine Mods in dieser Ansicht.</td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>

      @if (d.unmanaged.length) {
        <section class="card">
          <h3>Weitere Dateien im mods-Ordner</h3>
          <p class="hint">
            Diese Dateien stehen nicht in der Liste (von Hand hinzugefügt oder unbekannt). Sie werden geladen,
            aber nicht von der Website verwaltet.
          </p>
          <ul class="file-list">
            @for (f of d.unmanaged; track f.file) {
              <li><span class="mono">{{ f.file }}</span> <span class="hint">{{ f.size / 1024 / 1024 | number: '1.1-1' }} MB</span></li>
            }
          </ul>
        </section>
      }

      <section class="card upgrade">
        <div>
          <h3>Upgrade-Check</h3>
          <p class="hint">Laufen die installierten Mods schon auf einer neueren Minecraft-Version? Prüft nur – geändert wird nichts.</p>
        </div>

        @if (targets().length) {
          <div class="upgrade-form">
            <select #target aria-label="Ziel-Version">
              @for (v of targets(); track v.version) {
                <option [value]="v.version">{{ v.version }}{{ v.type === 'snapshot' ? ' (Vorschau)' : '' }}</option>
              }
            </select>
            <label class="inline-check">
              <input type="checkbox" [checked]="showSnapshots()" (change)="showSnapshots.set(!showSnapshots())" />
              Snapshots zeigen
            </label>
            <button type="button" (click)="checkUpgrade(target.value)" [disabled]="checking()">
              {{ checking() ? 'Prüfe …' : 'Prüfen' }}
            </button>
          </div>
        } @else {
          <p class="ok-note">
            <span class="dot-inline" data-state="online"></span>
            {{ d.minecraft.version }} ist die neueste Minecraft-Version.
            @if (d.minecraft.snapshots.length) {
              <button type="button" class="link" (click)="showSnapshots.set(true)">Snapshots ({{ d.minecraft.snapshots.length }}) zum Vorausschauen einblenden</button>
            }
          </p>
        }

        @if (upgradeError()) {
          <p class="error">{{ upgradeError() }}</p>
        }

        @if (upgrade(); as u) {
          <div class="upgrade-result">
            <div class="upgrade-summary">
              <strong [class.ok]="u.ready === u.total && u.loaderAvailable" [class.warn-text]="u.ready < u.total || !u.loaderAvailable">
                {{ u.ready }} von {{ u.total }} Mods bereit für {{ u.target }}
              </strong>
              <div class="seg-bar"><span class="stock" [style.width.%]="u.total ? (u.ready / u.total) * 100 : 0"></span></div>
              <span class="hint">
                Fabric Loader {{ u.loaderAvailable ? 'verfügbar' : 'noch nicht verfügbar' }}
                @if (u.ready === u.total && u.loaderAvailable) { <span class="sep" aria-hidden="true"></span>Umstieg wäre möglich }
              </span>
            </div>
            <ul class="upgrade-list">
              @for (m of u.mods; track m.file) {
                <li [class.blocked]="!m.version">
                  @if (m.icon) { <img class="mod-icon small" [src]="m.icon" alt="" /> }
                  @else { <span class="mod-icon small placeholder">?</span> }
                  <span class="title">{{ m.title }}</span>
                  @if (m.version) {
                    <span class="pill" data-state="covered"><i></i>{{ m.version.number }}</span>
                  } @else {
                    <span class="pill" data-state="missing"><i></i>{{ m.known ? 'noch nicht' : 'unbekannt' }}</span>
                  }
                </li>
              }
            </ul>
          </div>
        }
      </section>
    } @else if (!error()) {
      <p class="hint">Frage Modrinth …</p>
    }

    <!-- Mod hinzufügen: Suche bei Modrinth -->
    <dialog #searchDialog class="glass-dialog" (close)="searchOpen.set(false)" (click)="backdropClose($event)">
      <div class="dialog-body">
        <header class="project-head">
          <div>
            <h2>Mod hinzufügen</h2>
            <p class="hint">Fabric-Mods von Modrinth für Minecraft {{ data()?.minecraft?.version }}, die auf dem Server laufen.</p>
          </div>
          <button type="button" class="icon-btn" (click)="searchDialog.close()" title="Schließen"><app-icon name="x" [size]="18" /></button>
        </header>
        <input #searchInput type="search" placeholder="z. B. Graves, Ledger, Voice Chat …" (input)="onSearch(searchInput.value)"
               aria-label="Mods suchen" />
        @if (searchError()) { <p class="error small">{{ searchError() }}</p> }
        <ul class="search-results" [class.loading]="searching()">
          @for (h of hits(); track h.projectId) {
            <li>
              @if (h.icon) { <img class="mod-icon" [src]="h.icon" alt="" loading="lazy" /> }
              @else { <span class="mod-icon placeholder">?</span> }
              <div class="item-text">
                <a class="mod-title" [href]="h.url" target="_blank" rel="noopener noreferrer">{{ h.title }}</a>
                <span class="mod-desc">{{ h.description }}</span>
                <span class="mod-deps">
                  <span class="with-icon"><app-icon name="download" [size]="13" /><b>{{ h.downloads | number }}</b></span>
                  <span class="side" [attr.data-side]="sideOf(h.clientSide, h.serverSide)">{{ sideLabelOf(h.clientSide, h.serverSide) }}</span>
                </span>
              </div>
              @if (h.inList || added().has(h.projectId)) {
                <span class="pill" data-state="covered"><i></i>In der Liste</span>
              } @else {
                <button type="button" class="compact" (click)="add(h)" [disabled]="adding() === h.projectId">
                  {{ adding() === h.projectId ? '…' : 'Hinzufügen' }}
                </button>
              }
            </li>
          } @empty {
            @if (!searching()) { <li class="empty hint">Keine passenden Mods gefunden.</li> }
          }
        </ul>
        @if (hits().length < searchTotal()) {
          <button type="button" class="secondary compact more" (click)="more()" [disabled]="searching()">Mehr laden</button>
        }
      </div>
    </dialog>
  `,
})
export class AdminMods {
  private api = inject(ModsService);
  protected data = signal<ModsOverview | undefined>(undefined);
  protected error = signal('');
  protected notice = signal('');
  protected loading = signal(false);
  protected busy = signal(false);
  protected filter = signal<Filter>('all');
  protected dismissedResult = signal(false);

  protected showSnapshots = signal(false);
  protected upgrade = signal<UpgradeCheck | undefined>(undefined);
  protected upgradeError = signal('');
  protected checking = signal(false);

  protected searchOpen = signal(false);
  protected hits = signal<SearchHit[]>([]);
  protected searchTotal = signal(0);
  protected searching = signal(false);
  protected searchError = signal('');
  protected adding = signal('');
  protected added = signal(new Set<string>());
  private query = '';
  private searchTimer?: ReturnType<typeof setTimeout>;
  private searchDialog = viewChild.required<ElementRef<HTMLDialogElement>>('searchDialog');
  private searchInput = viewChild.required<ElementRef<HTMLInputElement>>('searchInput');

  private poll?: ReturnType<typeof setInterval>;

  protected running = computed(() => !!this.data()?.apply?.running);
  protected activeCount = computed(() => this.data()?.managed.filter((m) => m.enabled).length ?? 0);
  protected updates = computed(() => this.data()?.managed.filter((m) => m.enabled && m.update).length ?? 0);
  protected filters = computed(() => {
    const mods = this.data()?.managed ?? [];
    const count = (f: Filter) => mods.filter((m) => this.matches(m, f)).length;
    return [
      { key: 'all' as const, label: 'Alle', count: mods.length },
      { key: 'active' as const, label: 'Aktiv', count: count('active') },
      { key: 'disabled' as const, label: 'Deaktiviert', count: count('disabled') },
      { key: 'updates' as const, label: 'Updates', count: count('updates') },
      { key: 'planned' as const, label: 'Geplant', count: count('planned') },
    ];
  });
  protected visible = computed(() => (this.data()?.managed ?? []).filter((m) => this.matches(m, this.filter())));
  protected targets = computed(() => {
    const mc = this.data()?.minecraft;
    if (!mc) return [];
    return this.showSnapshots() ? [...mc.newerReleases, ...mc.snapshots] : mc.newerReleases;
  });

  constructor() {
    this.load();
  }

  ngOnDestroy() {
    clearInterval(this.poll);
    clearTimeout(this.searchTimer);
  }

  private matches(m: ManagedMod, f: Filter) {
    switch (f) {
      case 'active': return m.enabled;
      case 'disabled': return !m.enabled;
      case 'updates': return m.enabled && !!m.update;
      case 'planned': return !['active', 'disabled', 'missing'].includes(m.state);
      default: return true;
    }
  }

  async load(refresh = false) {
    this.loading.set(true);
    try {
      const d = await this.api.overview(refresh);
      const wasRunning = this.running();
      this.data.set(d);
      this.error.set('');
      if (wasRunning && !d.apply?.running) this.dismissedResult.set(false);
      // Während "Übernehmen" läuft, alle 2 Sekunden nachsehen
      if (d.apply?.running && !this.poll) this.poll = setInterval(() => this.load(), 2000);
      if (!d.apply?.running && this.poll) {
        clearInterval(this.poll);
        this.poll = undefined;
      }
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  /* ───── Liste bearbeiten ───── */

  async toggle(m: ManagedMod, event: Event) {
    const input = event.target as HTMLInputElement;
    const enabled = input.checked;
    try {
      this.busy.set(true);
      const res = await this.api.update(m.projectId, { enabled });
      this.flash(enabled ? `${res.changed.join(', ')} ${res.changed.length > 1 ? 'werden' : 'wird'} aktiviert – noch „Übernehmen“ klicken.`
        : `${m.title} wird deaktiviert – noch „Übernehmen“ klicken.`);
    } catch (err) {
      const dependents = (err as { error?: { dependents?: string[] } }).error?.dependents;
      if (dependents?.length && confirm(`${dependents.join(', ')} ${dependents.length === 1 ? 'braucht' : 'brauchen'} ${m.title}.\n\nAlle zusammen deaktivieren?`)) {
        try {
          const res = await this.api.update(m.projectId, { enabled: false, cascade: true });
          this.flash(`${res.changed.join(', ')} werden deaktiviert – noch „Übernehmen“ klicken.`);
        } catch (err2) {
          this.error.set(errorMessage(err2));
        }
      } else if (!dependents?.length) {
        this.error.set(errorMessage(err));
      }
    } finally {
      input.checked = m.enabled;
      await this.load();
      this.busy.set(false);
    }
  }

  updateMod(m: ManagedMod) {
    return this.run(() => this.api.update(m.projectId, { versionId: m.update!.id }), `${m.title} wird auf ${m.update!.number} aktualisiert – noch „Übernehmen“ klicken.`);
  }

  editNote(m: ManagedMod) {
    const note = prompt(`Notiz zu ${m.title} (z. B. warum deaktiviert):`, m.note);
    if (note === null) return;
    return this.run(() => this.api.update(m.projectId, { note }), note.trim() ? 'Notiz gespeichert.' : 'Notiz entfernt.');
  }

  remove(m: ManagedMod) {
    if (!confirm(`${m.title} aus der Liste entfernen?\n\nDie Einstellungen (Configs) bleiben auf dem Server liegen. Zum Testen reicht oft auch „Deaktivieren“.`)) return;
    return this.run(() => this.api.remove(m.projectId), `${m.title} wird entfernt – noch „Übernehmen“ klicken.`);
  }

  discard() {
    if (!confirm('Alle geplanten Änderungen verwerfen?')) return;
    return this.run(() => this.api.discard(), 'Geplante Änderungen verworfen.');
  }

  async apply() {
    const n = this.data()?.pending.length ?? 0;
    if (!confirm(`${n} ${n === 1 ? 'Änderung' : 'Änderungen'} übernehmen?\n\n1. Backup wird erstellt\n2. Spieler werden 10 Sekunden vorher gewarnt\n3. Server startet neu und lädt die Mods\n\nDauert meist 1–2 Minuten.`)) return;
    await this.run(() => this.api.apply(), '');
    this.dismissedResult.set(false);
  }

  private async run(action: () => Promise<unknown>, success: string) {
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
      if (success) this.flash(success);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      await this.load();
      this.busy.set(false);
    }
  }

  private flash(message: string) {
    this.notice.set(message);
    setTimeout(() => this.notice() === message && this.notice.set(''), 6000);
  }

  /* ───── Suche ───── */

  openSearch() {
    this.searchOpen.set(true);
    this.added.set(new Set());
    this.searchDialog().nativeElement.showModal();
    this.searchInput().nativeElement.focus();
    if (!this.hits().length) this.search('');
  }

  backdropClose(event: MouseEvent) {
    if (event.target === this.searchDialog().nativeElement) this.searchDialog().nativeElement.close();
  }

  onSearch(value: string) {
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.search(value.trim()), 350);
  }

  private async search(q: string, offset = 0) {
    this.query = q;
    this.searching.set(true);
    this.searchError.set('');
    try {
      const res = await this.api.search(q, offset);
      if (q !== this.query) return;
      this.hits.set(offset ? [...this.hits(), ...res.hits] : res.hits);
      this.searchTotal.set(res.total);
    } catch (err) {
      this.searchError.set(errorMessage(err));
    } finally {
      this.searching.set(false);
    }
  }

  more() {
    return this.search(this.query, this.hits().length);
  }

  async add(h: SearchHit) {
    this.adding.set(h.projectId);
    this.searchError.set('');
    try {
      const res = await this.api.add(h.projectId);
      const ids = new Set(this.added());
      res.added.forEach((a) => ids.add(a.projectId));
      this.added.set(ids);
      const deps = res.added.filter((a) => a.auto).map((a) => a.title);
      this.flash(`${h.title} geplant${deps.length ? ` (inkl. ${deps.join(', ')})` : ''} – noch „Übernehmen“ klicken.`);
      await this.load();
    } catch (err) {
      this.searchError.set(errorMessage(err));
    } finally {
      this.adding.set('');
    }
  }

  /* ───── Upgrade-Check ───── */

  async checkUpgrade(version: string) {
    if (!version) return;
    this.checking.set(true);
    this.upgradeError.set('');
    try {
      this.upgrade.set(await this.api.upgrade(version));
    } catch (err) {
      this.upgradeError.set(errorMessage(err));
    } finally {
      this.checking.set(false);
    }
  }

  /* ───── Anzeige ───── */

  stateInfo(m: ManagedMod) {
    return STATE_LABELS[m.state];
  }

  changeLabel(c: ModChange) {
    return CHANGE_LABELS[c.kind];
  }

  sideOf(client: Side, server: Side): 'server' | 'both' | 'client-optional' {
    if (client === 'required' && server !== 'unsupported') return 'both';
    if (client === 'unsupported') return 'server';
    return 'client-optional';
  }
  sideLabelOf(client: Side, server: Side) {
    return { server: 'Nur Server', both: 'Server + Spieler', 'client-optional': 'Server (Spieler optional)' }[this.sideOf(client, server)];
  }
  side(m: ManagedMod) {
    return this.sideOf(m.clientSide, m.serverSide);
  }
  sideLabel(m: ManagedMod) {
    return this.sideLabelOf(m.clientSide, m.serverSide);
  }
  sideHint(m: ManagedMod) {
    return {
      server: 'Läuft nur auf dem Server – Spieler brauchen nichts.',
      both: 'Spieler müssen den Mod auch installieren (kommt ins Modpack).',
      'client-optional': 'Läuft auf dem Server. Spieler können ihn zusätzlich installieren, müssen aber nicht.',
    }[this.side(m)];
  }

  time(iso: string) {
    return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }
  date(iso: string) {
    return formatDate(iso);
  }
}
