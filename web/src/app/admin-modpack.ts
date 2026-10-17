import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { AdminNav } from './admin-backups';
import { errorMessage, formatDate } from './projects.service';
import { KIND_LABELS, ModpackService, megabytes, type PackHit, type PackKind, type PackManage, type PackMode, type PackRow } from './modpack';
import { Icon } from './icon';

type Filter = 'all' | 'in' | 'out';
type SortKey = 'title' | 'kind' | 'version' | 'mode';

const SORT_STORAGE = 'neo.modpackSort';
const MODE_ORDER: Record<PackMode, number> = { required: 0, optional: 1, excluded: 2 };
const KIND_ORDER: Record<PackKind, number> = { mod: 0, resourcepack: 1, shader: 2 };

const SUGGESTIONS: Record<PackKind, string[]> = {
  mod: ['Sodium', 'Litematica', 'Mod Menu', 'Xaero', 'EMI', 'Iris', 'AppleSkin', 'Jade'],
  resourcepack: ['Faithful', 'Fresh Animations', 'Better Leaves'],
  shader: ['Complementary', 'BSL', 'Bliss'],
};

@Component({
  selector: 'app-admin-modpack',
  imports: [AdminNav, DecimalPipe, RouterLink, Icon],
  template: `
    <header class="page-head">
      <span class="eyebrow">Admin</span>
      <h1>Modpack</h1>
      <p class="hint">Was Spieler installieren: nötige Server-Mods und eigene Extras.</p>
    </header>

    <app-admin-nav />

    @if (error()) { <p class="error">{{ error() }}</p> }
    @if (notice()) { <p class="ok">{{ notice() }}</p> }

    @if (data(); as d) {
      <section class="card stats">
        <div>
          <strong>{{ d.version }}</strong>
          <span class="hint">Pack-Version<span class="sep" aria-hidden="true"></span>{{ date(d.updatedAt) }}</span>
        </div>
        <div>
          <strong>{{ d.minecraft }}</strong>
          <span class="hint">Minecraft<span class="sep" aria-hidden="true"></span>Fabric {{ d.loader }}</span>
        </div>
        <div>
          <strong>{{ d.counts.required }}<small> + {{ d.counts.optional }}</small></strong>
          <span class="hint">Pflicht + optional</span>
        </div>
        <div>
          <strong>{{ size(d.size) }} MB</strong>
          <span class="hint">Download beim Spieler</span>
        </div>
      </section>

      @if (d.problems.length) {
        <section class="card warn-card">
          <strong>Achtung</strong>
          @for (p of d.problems; track $index) { <p class="warn small-text">{{ p }}</p> }
        </section>
      }
      @if (d.pendingServerChanges) {
        <p class="hint">
          Unter <a routerLink="/admin/mods">Mods</a> sind Server-Änderungen geplant. Sie kommen erst nach „Übernehmen“ ins Pack,
          damit es immer zum laufenden Server passt.
        </p>
      }

      <section class="mat-panel">
        <header class="mat-toolbar">
          <div class="segmented" role="group" aria-label="Filtern">
            @for (f of filters(); track f.key) {
              <button type="button" [class.active]="filter() === f.key" [attr.aria-pressed]="filter() === f.key" (click)="filter.set(f.key)">
                {{ f.label }} <span class="seg-count">{{ f.count }}</span>
              </button>
            }
          </div>
          <div class="mat-toolbar-right">
            <a class="button-link" href="/api/modpack/download" download>Download testen</a>
            <a class="button-link" routerLink="/modpack">Spieler-Seite</a>
            <button type="button" class="compact with-icon" (click)="openSearch()"><app-icon name="plus" [size]="14" [stroke]="2.5" />Hinzufügen</button>
          </div>
        </header>

        <div class="mat-scroll">
          <table class="mat-table mod-table pack-table">
            <thead>
              <tr>
                @for (c of columns; track c.key) {
                  <th [attr.aria-sort]="sort().key === c.key ? (sort().dir === 1 ? 'ascending' : 'descending') : 'none'">
                    <button type="button" class="th-sort" [class.active]="sort().key === c.key" (click)="sortBy(c.key)">
                      {{ c.label }}
                      <app-icon class="sort-arrow" [name]="sort().key === c.key ? (sort().dir === 1 ? 'chevron-up' : 'chevron-down') : 'selector'" [size]="13" />
                    </button>
                  </th>
                }
                <th class="actions-col"><span class="sr-only">Aktionen</span></th>
              </tr>
            </thead>
            <tbody>
              @for (r of visible(); track r.projectId) {
                <tr [class.off]="r.mode === 'excluded'">
                  <td>
                    <div class="item-cell">
                      @if (r.icon) { <img class="mod-icon" [src]="r.icon" alt="" loading="lazy" /> }
                      @else { <span class="mod-icon placeholder">?</span> }
                      <div class="item-text">
                        <a class="mod-title" [href]="r.url" target="_blank" rel="noopener noreferrer">{{ r.title }}</a>
                        <span class="mod-desc">{{ r.description }}</span>
                        @if (r.note) { <span class="mod-note with-icon"><app-icon name="note" [size]="14" />{{ r.note }}</span> }
                        @if (r.reason || r.auto) {
                          <span class="mod-deps"><span>{{ r.reason ?? 'automatisch als Abhängigkeit' }}</span></span>
                        }
                      </div>
                    </div>
                  </td>
                  <td>
                    <div class="kind-cell">
                      <span class="kind-tag" [attr.data-kind]="r.kind">{{ kind(r.kind) }}</span>
                      <span class="source-tag" [attr.data-source]="r.source">{{ r.source === 'server' ? 'Vom Server' : 'Nur Spieler' }}</span>
                    </div>
                  </td>
                  <td>
                    <div class="version-cell">
                      <span class="mono version">{{ r.versionNumber }}</span>
                      @if (r.update) {
                        <button type="button" class="update-btn" (click)="update(r)" [disabled]="busy()" [title]="'Auf ' + r.update.number + ' aktualisieren'">
                          <app-icon name="arrow-up" [size]="13" />{{ r.update.number }}
                        </button>
                      }
                    </div>
                  </td>
                  <td>
                    @if (r.locked) {
                      <span class="pill" [attr.data-state]="r.mode === 'required' ? 'covered' : 'off'"
                            [title]="r.mode === 'required' ? 'Spieler brauchen den Mod, um auf den Server zu kommen.' : 'Läuft nur auf dem Server.'">
                        <i></i>@if (r.mode === 'required') { Pflicht<span class="sep" aria-hidden="true"></span>nötig } @else { Nur Server }
                      </span>
                    } @else {
                      <div class="segmented small" role="group" [attr.aria-label]="r.title + ' im Pack'">
                        @for (m of modes; track m.key) {
                          <button type="button" [class.active]="current(r) === m.key" [attr.aria-pressed]="current(r) === m.key"
                                  (click)="setMode(r, m.key)" [disabled]="busy()" [attr.data-mode]="m.key">{{ m.label }}</button>
                        }
                      </div>
                      @if (r.reason && current(r) !== r.mode) {
                        <span class="hint tiny">wirkt als {{ r.mode === 'required' ? 'Pflicht' : 'optional' }}</span>
                      }
                    }
                  </td>
                  <td class="actions-col">
                    @if (r.source === 'client') {
                      <div class="row-actions">
                        <button type="button" class="icon-btn" (click)="editNote(r)" [disabled]="busy()" title="Notiz"><app-icon name="pencil" /></button>
                        <button type="button" class="icon-btn danger" (click)="remove(r)" [disabled]="busy()" title="Aus dem Pack entfernen"><app-icon name="x" [size]="16" /></button>
                      </div>
                    }
                  </td>
                </tr>
              } @empty {
                <tr class="empty"><td colspan="5">Nichts in dieser Ansicht.</td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    } @else if (!error()) {
      <p class="hint">Lade …</p>
    }

    <dialog #searchDialog class="glass-dialog" (click)="backdropClose($event)">
      <div class="dialog-body">
        <header class="project-head">
          <div>
            <h2>Zum Modpack hinzufügen</h2>
            <p class="hint">Von Modrinth, passend zu Minecraft {{ data()?.minecraft }}. Was der Mod braucht, kommt automatisch mit.</p>
          </div>
          <button type="button" class="icon-btn" (click)="searchDialog.close()" title="Schließen"><app-icon name="x" [size]="18" /></button>
        </header>
        <div class="search-head">
          <div class="segmented" role="group" aria-label="Art">
            @for (k of kinds; track k.key) {
              <button type="button" [class.active]="searchKind() === k.key" (click)="setKind(k.key, searchInput.value)">{{ k.label }}</button>
            }
          </div>
          <input #searchInput type="search" [placeholder]="'Suchen, z. B. ' + suggestions().slice(0, 3).join(', ') + ' …'"
                 (input)="onSearch(searchInput.value)" aria-label="Suchen" />
          <div class="chips suggestion-chips">
            @for (s of suggestions(); track s) {
              <button type="button" class="chip-btn" (click)="searchInput.value = s; onSearch(s, 0)">{{ s }}</button>
            }
          </div>
        </div>
        @if (searchError()) { <p class="error small">{{ searchError() }}</p> }
        <ul class="search-results" [class.loading]="searching()">
          @for (h of hits(); track h.projectId) {
            <li>
              @if (h.icon) { <img class="mod-icon" [src]="h.icon" alt="" loading="lazy" /> }
              @else { <span class="mod-icon placeholder">?</span> }
              <div class="item-text">
                <a class="mod-title" [href]="h.url" target="_blank" rel="noopener noreferrer">{{ h.title }}</a>
                <span class="mod-desc">{{ h.description }}</span>
                <span class="mod-deps"><span class="with-icon"><app-icon name="download" [size]="13" /><b>{{ h.downloads | number }}</b></span></span>
              </div>
              @if (h.inList || added().has(h.projectId)) {
                <span class="pill" data-state="covered"><i></i>Im Pack</span>
              } @else {
                <div class="add-buttons">
                  <button type="button" class="compact" (click)="add(h, 'required')" [disabled]="adding() === h.projectId">Pflicht</button>
                  <button type="button" class="secondary compact" (click)="add(h, 'optional')" [disabled]="adding() === h.projectId">Optional</button>
                </div>
              }
            </li>
          } @empty {
            @if (!searching()) { <li class="empty hint">Nichts gefunden.</li> }
          }
        </ul>
        @if (hits().length < searchTotal()) {
          <button type="button" class="secondary compact more" (click)="more()" [disabled]="searching()">Mehr laden</button>
        }
      </div>
    </dialog>
  `,
})
export class AdminModpack {
  private api = inject(ModpackService);
  protected data = signal<PackManage | undefined>(undefined);
  protected error = signal('');
  protected notice = signal('');
  protected busy = signal(false);
  protected filter = signal<Filter>('all');

  protected modes: Array<{ key: PackMode; label: string }> = [
    { key: 'required', label: 'Pflicht' },
    { key: 'optional', label: 'Optional' },
    { key: 'excluded', label: 'Aus' },
  ];
  protected kinds: Array<{ key: PackKind; label: string }> = [
    { key: 'mod', label: 'Mods' },
    { key: 'resourcepack', label: 'Ressourcenpakete' },
    { key: 'shader', label: 'Shader' },
  ];

  protected searchKind = signal<PackKind>('mod');
  protected hits = signal<PackHit[]>([]);
  protected searchTotal = signal(0);
  protected searching = signal(false);
  protected searchError = signal('');
  protected adding = signal('');
  protected added = signal(new Set<string>());
  private query = '';
  private searchTimer?: ReturnType<typeof setTimeout>;
  private searchDialog = viewChild.required<ElementRef<HTMLDialogElement>>('searchDialog');
  private searchInput = viewChild.required<ElementRef<HTMLInputElement>>('searchInput');

  protected suggestions = computed(() => SUGGESTIONS[this.searchKind()]);
  protected filters = computed(() => {
    const rows = this.data()?.rows ?? [];
    return [
      { key: 'all' as const, label: 'Alle', count: rows.length },
      { key: 'in' as const, label: 'Im Pack', count: rows.filter((r) => r.mode !== 'excluded').length },
      { key: 'out' as const, label: 'Nicht im Pack', count: rows.filter((r) => r.mode === 'excluded').length },
    ];
  });
  protected columns: Array<{ key: SortKey; label: string }> = [
    { key: 'title', label: 'Inhalt' },
    { key: 'kind', label: 'Art' },
    { key: 'version', label: 'Version' },
    { key: 'mode', label: 'Im Pack' },
  ];
  protected sort = signal<{ key: SortKey; dir: 1 | -1 }>(readSort());

  protected visible = computed(() => {
    const rows = this.data()?.rows ?? [];
    const f = this.filter();
    const filtered = f === 'all' ? rows : rows.filter((r) => (f === 'in') === (r.mode !== 'excluded'));
    const { key, dir } = this.sort();
    const byTitle = (a: PackRow, b: PackRow) => a.title.localeCompare(b.title, 'de');
    const compare: Record<SortKey, (a: PackRow, b: PackRow) => number> = {
      title: byTitle,
      kind: (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.source.localeCompare(b.source),
      version: (a, b) => a.versionNumber.localeCompare(b.versionNumber, 'de', { numeric: true }),
      // Sortiert nach der Einstellung, nicht nach der Wirkung – so springt nichts, wenn eine Abhängigkeit nachzieht
      mode: (a, b) => MODE_ORDER[this.current(a)] - MODE_ORDER[this.current(b)],
    };
    return [...filtered].sort((a, b) => compare[key](a, b) * dir || byTitle(a, b));
  });

  sortBy(key: SortKey) {
    const cur = this.sort();
    const next = { key, dir: (cur.key === key ? -cur.dir : 1) as 1 | -1 };
    this.sort.set(next);
    try { localStorage.setItem(SORT_STORAGE, JSON.stringify(next)); } catch { /* egal */ }
  }

  constructor() {
    this.load();
  }

  ngOnDestroy() {
    clearTimeout(this.searchTimer);
  }

  async load() {
    try {
      this.data.set(await this.api.manage());
      this.error.set('');
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  /** Eingestellter Modus (Server-Mods: "auto" = Aus) */
  current(r: PackRow): PackMode {
    return r.setting === 'auto' ? 'excluded' : r.setting;
  }

  setMode(r: PackRow, mode: PackMode) {
    if (this.current(r) === mode) return;
    const action = r.source === 'server'
      ? () => this.api.setServerMode(r.projectId, mode === 'excluded' ? 'auto' : mode)
      : () => this.api.updateItem(r.projectId, { mode });
    return this.run(action, '');
  }

  update(r: PackRow) {
    return this.run(() => this.api.updateItem(r.projectId, { versionId: r.update!.id }), `${r.title} aktualisiert auf ${r.update!.number}.`);
  }

  editNote(r: PackRow) {
    const note = prompt(`Notiz zu ${r.title}:`, r.note);
    if (note === null) return;
    return this.run(() => this.api.updateItem(r.projectId, { note }), note.trim() ? 'Notiz gespeichert.' : 'Notiz entfernt.');
  }

  remove(r: PackRow) {
    if (!confirm(`${r.title} aus dem Modpack entfernen?`)) return;
    return this.run(() => this.api.removeItem(r.projectId), `${r.title} entfernt.`);
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
    this.added.set(new Set());
    this.searchDialog().nativeElement.showModal();
    this.searchInput().nativeElement.focus();
    if (!this.hits().length) this.search('');
  }

  backdropClose(event: MouseEvent) {
    if (event.target === this.searchDialog().nativeElement) this.searchDialog().nativeElement.close();
  }

  setKind(kind: PackKind, query: string) {
    this.searchKind.set(kind);
    this.search(query.trim());
  }

  onSearch(value: string, delay = 350) {
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.search(value.trim()), delay);
  }

  private async search(q: string, offset = 0) {
    this.query = q;
    const kind = this.searchKind();
    this.searching.set(true);
    this.searchError.set('');
    try {
      const res = await this.api.search(q, kind, offset);
      if (q !== this.query || kind !== this.searchKind()) return;
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

  async add(h: PackHit, mode: 'required' | 'optional') {
    this.adding.set(h.projectId);
    this.searchError.set('');
    try {
      const res = await this.api.add(h.projectId, this.searchKind(), mode);
      const ids = new Set(this.added());
      res.added.forEach((a) => ids.add(a.projectId));
      this.added.set(ids);
      const deps = res.added.filter((a) => a.auto).map((a) => a.title);
      this.flash(`${h.title} ist im Pack${deps.length ? ` (inkl. ${deps.join(', ')})` : ''}.`);
      await this.load();
    } catch (err) {
      this.searchError.set(errorMessage(err));
    } finally {
      this.adding.set('');
    }
  }

  kind(k: PackKind) { return KIND_LABELS[k]; }
  size(bytes: number) { return megabytes(bytes); }
  date(iso: string) { return formatDate(iso); }
}

function readSort(): { key: SortKey; dir: 1 | -1 } {
  try {
    const v = JSON.parse(localStorage.getItem(SORT_STORAGE) ?? '');
    if (['title', 'kind', 'version', 'mode'].includes(v?.key) && (v.dir === 1 || v.dir === -1)) return v;
  } catch { /* Standard */ }
  return { key: 'title', dir: 1 };
}
