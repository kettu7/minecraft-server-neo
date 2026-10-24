import { Component, ElementRef, Injectable, computed, inject, signal, viewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DecimalPipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from './projects.service';
import { Icon } from './icon';

export interface Backup {
  id: string;
  createdAt: string;
  /** archive = letzter Stand einer Welt vor „Neue Welt erzeugen“; import = frühere Umzugspakete (wie manuell) */
  kind: 'auto' | 'manual' | 'archive' | 'import';
  /** Name der Welt zum Zeitpunkt des Backups */
  world?: string;
  by: string | null;
  durationMs: number;
  pinned: boolean;
  worldBytes: number;
  totalBytes: number;
}

export interface BackupStatus {
  running: boolean;
  lastRun: { at: string; ok: boolean; error?: string; id?: string } | null;
  nextRunAt: string | null;
  intervalMinutes: number;
  /** stündlich nur, wenn seit dem letzten Backup jemand gespielt hat */
  onlyWithPlayers: boolean;
  keepHours: number;
  keepDays: number;
}

@Injectable({ providedIn: 'root' })
export class BackupsService {
  private http = inject(HttpClient);
  list() {
    return firstValueFrom(this.http.get<{ backups: Backup[]; status: BackupStatus }>('/api/backups'));
  }
  create() {
    return firstValueFrom(this.http.post<Backup>('/api/backups', {}));
  }
  pin(id: string, pinned: boolean) {
    return firstValueFrom(this.http.patch(`/api/backups/${id}`, { pinned }));
  }
  delete(id: string) {
    return firstValueFrom(this.http.delete(`/api/backups/${id}`));
  }
  restore(id: string) {
    return firstValueFrom(this.http.post<{ ok: true; safetyBackup: string }>(`/api/backups/${id}/restore`, {}));
  }
}

const POLL_MS = 15_000;

@Component({
  selector: 'app-backups-panel',
  imports: [DecimalPipe, Icon],
  template: `
    @if (status(); as s) {
      <section class="stats inset">
        <div>
          <strong>{{ backups().length }}</strong>
          <span class="hint">Backups<span class="sep" aria-hidden="true"></span>{{ size(totalBytes()) }}</span>
        </div>
        <div>
          <strong>alle {{ s.intervalMinutes }} Min.</strong>
          <span class="hint">
            @if (s.onlyWithPlayers) { bei Spielern<span class="sep" aria-hidden="true"></span>frühestens {{ s.nextRunAt ? time(s.nextRunAt) : '–' }} }
            @else { nächstes {{ s.nextRunAt ? time(s.nextRunAt) : '–' }} }
          </span>
        </div>
        <div>
          <strong>{{ s.keepHours }} h + {{ s.keepDays }} Tage</strong>
          <span class="hint">stündlich, danach 1 pro Tag</span>
        </div>
        <div>
          <strong [class.error]="s.lastRun && !s.lastRun.ok">{{ s.running ? 'läuft …' : s.lastRun ? (s.lastRun.ok ? 'OK' : 'Fehler') : '–' }}</strong>
          <span class="hint">letzter Lauf {{ s.lastRun ? time(s.lastRun.at) : '–' }}</span>
        </div>
      </section>
      @if (s.lastRun && !s.lastRun.ok) {
        <p class="error">Letztes Backup fehlgeschlagen: {{ s.lastRun.error }}</p>
      }
    }

    @if (error()) { <p class="error">{{ error() }}</p> }
    @if (notice()) { <p class="ok">{{ notice() }}</p> }

    <section class="mat-panel flat">
      <header class="mat-toolbar">
        <div class="segmented" role="group" aria-label="Backups filtern">
          @for (f of filters(); track f.key) {
            <button type="button" [class.active]="filter() === f.key" [attr.aria-pressed]="filter() === f.key" (click)="filter.set(f.key)">
              {{ f.label }} <span class="seg-count">{{ f.count }}</span>
            </button>
          }
        </div>
        <button type="button" class="compact with-icon" (click)="create()" [disabled]="busy() || status()?.running">
          <app-icon name="plus" [size]="14" [stroke]="2.5" />{{ creating() ? 'Sichere …' : 'Jetzt sichern' }}
        </button>
      </header>

      @if (selected().size) {
        <div class="bulk-bar" role="toolbar" aria-label="Ausgewählte Backups">
          <strong>{{ selected().size }} ausgewählt</strong>
          <span class="hint">{{ size(selectedBytes()) }}</span>
          <div class="bulk-actions">
            <a class="button-link compact with-icon" [href]="bundleUrl()" download (click)="afterDownload()">
              <app-icon name="download" [size]="15" />Herunterladen
            </a>
            @if (selectedList().some((b) => !b.pinned)) {
              <button type="button" class="secondary compact with-icon" (click)="pinSelected(true)" [disabled]="busy()">
                <app-icon name="pin" [size]="15" />Anpinnen
              </button>
            }
            @if (selectedList().some((b) => b.pinned)) {
              <button type="button" class="secondary compact with-icon" (click)="pinSelected(false)" [disabled]="busy()">
                <app-icon name="pinned-off" [size]="15" />Pin lösen
              </button>
            }
            <button type="button" class="danger compact with-icon" (click)="removeSelected()" [disabled]="busy()">
              <app-icon name="trash" [size]="15" />Löschen
            </button>
            <button type="button" class="icon-btn" (click)="clearSelection()" title="Auswahl aufheben" aria-label="Auswahl aufheben">
              <app-icon name="x" [size]="16" />
            </button>
          </div>
        </div>
      }

      <div class="mat-scroll">
        <table class="mat-table backup-table">
          <thead>
            <tr>
              <th class="check-col">
                <input type="checkbox" [checked]="allVisibleSelected()" [indeterminate]="someVisibleSelected()"
                       (change)="toggleAll($any($event.target).checked)" [disabled]="!visible().length" aria-label="Alle sichtbaren auswählen" />
              </th>
              <th>Backup</th>
              <th>Welt</th>
              <th class="status-col">Art</th>
              <th class="num">Größe</th>
              <th class="num">Dauer</th>
              <th class="actions-col"><span class="sr-only">Aktionen</span></th>
            </tr>
          </thead>
          <tbody>
            @for (b of visible(); track b.id) {
              <tr [class.pinned]="b.pinned" [class.selected]="selected().has(b.id)">
                <td class="check-col">
                  <input type="checkbox" [checked]="selected().has(b.id)" (change)="toggle(b.id)" [attr.aria-label]="'Backup vom ' + date(b.createdAt) + ' auswählen'" />
                </td>
                <td>
                  <div class="item-text">
                    <strong class="with-icon">
                      {{ date(b.createdAt) }}
                      @if (b.pinned) { <app-icon class="pin-mark" name="pinned-filled" [size]="14" label="angepinnt" /> }
                    </strong>
                    <span class="backup-sub">
                      <span class="mono">{{ b.id }}</span>
                      @if (b.by) { <span class="sep" aria-hidden="true"></span>{{ b.by }} }
                    </span>
                  </div>
                </td>
                <td class="backup-world">{{ b.world ?? '–' }}</td>
                <td class="status-col">
                  <span class="pill" [attr.data-state]="b.kind === 'archive' ? 'done' : isManual(b) ? 'covered' : 'off'"><i></i>{{ kindLabel(b) }}</span>
                </td>
                <td class="num">{{ size(b.totalBytes) }}</td>
                <td class="num zero">{{ b.durationMs / 1000 | number: '1.1-1' }} s</td>
                <td class="actions-col">
                  <div class="row-actions">
                    <a class="icon-btn" [href]="'/api/backups/' + b.id + '/download'" download title="Herunterladen" aria-label="Herunterladen">
                      <app-icon name="download" [size]="16" />
                    </a>
                    <button type="button" class="icon-btn" (click)="openMenu(b, $event)" [disabled]="busy()"
                            title="Weitere Aktionen" aria-label="Weitere Aktionen" aria-haspopup="menu"
                            [attr.aria-expanded]="menuFor()?.id === b.id">
                      <app-icon name="dots" [size]="16" />
                    </button>
                  </div>
                </td>
              </tr>
            } @empty {
              <tr class="empty"><td colspan="7">{{ backups().length ? 'Keine Backups in dieser Ansicht.' : 'Noch keine Backups.' }}</td></tr>
            }
          </tbody>
        </table>
      </div>
    </section>
    <p class="hint small-text with-icon"><app-icon name="pin" [size]="14" />Angepinnte Backups werden nicht automatisch gelöscht.</p>

    <!-- Aktionsmenü: liegt im Top-Layer, damit die Tabelle es nicht abschneidet -->
    <div #menu popover class="row-menu" role="menu" [style.top.px]="menuPos().top" [style.left.px]="menuPos().left"
         (toggle)="$any($event).newState === 'closed' && menuFor.set(undefined)">
      @if (menuFor(); as b) {
        <button type="button" role="menuitem" class="with-icon" (click)="togglePin(b)">
          <app-icon [name]="b.pinned ? 'pinned-off' : 'pin'" [size]="16" />{{ b.pinned ? 'Pin lösen' : 'Anpinnen' }}
        </button>
        <button type="button" role="menuitem" class="with-icon" (click)="restore(b)">
          <app-icon name="history" [size]="16" />Welt zurückspielen
        </button>
        <hr />
        <button type="button" role="menuitem" class="with-icon danger-item" (click)="remove(b)">
          <app-icon name="trash" [size]="16" />Löschen
        </button>
      }
    </div>
  `,
  // Menü hängt fest am Bildschirm – beim Scrollen schließen statt wegdriften
  host: { "(window:scroll)": "menuFor() && closeMenu()" },
})
/** Backups – eingebettet als Akkordeon im Admin-Panel (Server) */
export class BackupsPanel {
  private api = inject(BackupsService);
  protected backups = signal<Backup[]>([]);
  protected status = signal<BackupStatus | undefined>(undefined);
  protected busy = signal(false);
  protected creating = signal(false);
  protected error = signal('');
  protected notice = signal('');
  protected filter = signal<'all' | 'pinned' | 'auto' | 'manual' | 'archive'>('all');
  protected filters = computed(() => {
    const b = this.backups();
    return [
      { key: 'all' as const, label: 'Alle', count: b.length },
      { key: 'pinned' as const, label: 'Angepinnt', count: b.filter((x) => x.pinned).length },
      { key: 'auto' as const, label: 'Automatisch', count: b.filter((x) => x.kind === 'auto').length },
      { key: 'manual' as const, label: 'Manuell', count: b.filter((x) => this.isManual(x)).length },
      { key: 'archive' as const, label: 'Archiviert', count: b.filter((x) => x.kind === 'archive').length },
    ];
  });
  protected visible = computed(() => {
    const f = this.filter();
    return this.backups().filter((b) => f === 'all' || (f === 'pinned' ? b.pinned : f === 'manual' ? this.isManual(b) : b.kind === f));
  });
  /* ───── Mehrfachauswahl ───── */
  protected selected = signal(new Set<string>());
  protected selectedList = computed(() => this.backups().filter((b) => this.selected().has(b.id)));
  protected selectedBytes = computed(() => this.selectedList().reduce((a, b) => a + b.totalBytes, 0));
  protected allVisibleSelected = computed(() => this.visible().length > 0 && this.visible().every((b) => this.selected().has(b.id)));
  protected someVisibleSelected = computed(() => !this.allVisibleSelected() && this.visible().some((b) => this.selected().has(b.id)));
  protected bundleUrl = computed(() => '/api/backups/download?ids=' + this.selectedList().map((b) => b.id).join(','));

  toggle(id: string) {
    const next = new Set(this.selected());
    if (!next.delete(id)) next.add(id);
    this.selected.set(next);
  }

  /** Kopf-Checkbox: alle sichtbaren (gefilterten) an- bzw. abwählen */
  toggleAll(on: boolean) {
    const next = new Set(this.selected());
    for (const b of this.visible()) on ? next.add(b.id) : next.delete(b.id);
    this.selected.set(next);
  }

  clearSelection() {
    this.selected.set(new Set());
  }

  afterDownload() {
    const n = this.selected().size;
    this.notice.set(`Download von ${n} ${n === 1 ? "Backup" : "Backups"} gestartet – eine .tar-Datei mit je einem Welt-Archiv.`);
  }

  pinSelected(pinned: boolean) {
    const targets = this.selectedList().filter((b) => b.pinned !== pinned);
    this.run(async () => {
      for (const b of targets) await this.api.pin(b.id, pinned);
      this.notice.set(`${targets.length} ${targets.length === 1 ? 'Backup' : 'Backups'} ${pinned ? 'angepinnt' : 'gelöst'}.`);
    });
  }

  removeSelected() {
    const list = this.selectedList();
    const pinned = list.filter((b) => b.pinned).length;
    if (!confirm(`${list.length} ${list.length === 1 ? 'Backup' : 'Backups'} endgültig löschen?${pinned ? `

Darunter ${pinned} angepinnte.` : ''}`)) return;
    this.run(async () => {
      for (const b of list) await this.api.delete(b.id);
      this.clearSelection();
      this.notice.set(`${list.length} ${list.length === 1 ? 'Backup' : 'Backups'} gelöscht.`);
    });
  }

  protected menuFor = signal<Backup | undefined>(undefined);
  protected menuPos = signal({ top: 0, left: 0 });
  private menu = viewChild.required<ElementRef<HTMLElement>>('menu');
  private timer = setInterval(() => !this.busy() && this.load(), POLL_MS);

  constructor() {
    this.load();
  }

  ngOnDestroy() {
    clearInterval(this.timer);
  }

  protected totalBytes() {
    return this.backups().reduce((a, b) => a + b.totalBytes, 0);
  }

  private async load() {
    try {
      const { backups, status } = await this.api.list();
      this.backups.set(backups);
      this.status.set(status);
      const ids = new Set(backups.map((b) => b.id));
      if ([...this.selected()].some((id) => !ids.has(id))) this.selected.set(new Set([...this.selected()].filter((id) => ids.has(id))));
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  async create() {
    this.creating.set(true);
    await this.run(() => this.api.create());
    this.creating.set(false);
  }

  async restore(b: Backup) {
    this.closeMenu();
    const when = this.date(b.createdAt);
    if (!confirm(`Welt auf den Stand vom ${when} zurücksetzen?

Alles, was danach in der Welt gebaut wurde, ist dann weg. Der Server startet neu, Spieler werden 10 Sekunden vorher gewarnt.

Vorher wird automatisch ein Sicherheits-Backup erstellt.`)) return;
    if (prompt('Zur Bestätigung bitte ZURÜCK eingeben:') !== 'ZURÜCK') return;
    this.notice.set('');
    await this.run(async () => {
      const { safetyBackup } = await this.api.restore(b.id);
      this.notice.set(`Welt auf ${when} zurückgesetzt. Der Server startet gerade neu. Sicherheits-Backup: ${safetyBackup} (angepinnt).`);
    });
  }

  /** frühere Umzugspakete zählen wie manuelle Backups */
  protected isManual = (b: Backup) => b.kind === 'manual' || b.kind === 'import';

  protected kindLabel(b: Backup) {
    return b.kind === 'archive' ? 'Welt archiviert' : this.isManual(b) ? 'Manuell' : 'Automatisch';
  }

  /** Menü rechtsbündig unter dem Punkte-Button öffnen; bei Platzmangel darüber */
  openMenu(b: Backup, event: MouseEvent) {
    const el = this.menu().nativeElement;
    if (this.menuFor()?.id === b.id) return el.hidePopover();
    const r = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const width = 240, height = 150;
    const top = r.bottom + 6 + height > innerHeight ? r.top - 6 - height : r.bottom + 6;
    this.menuPos.set({ top, left: Math.max(8, r.right - width) });
    this.menuFor.set(b);
    el.showPopover();
  }

  protected closeMenu() {
    this.menu().nativeElement.hidePopover();
  }

  togglePin(b: Backup) {
    this.closeMenu();
    this.run(() => this.api.pin(b.id, !b.pinned));
  }

  remove(b: Backup) {
    this.closeMenu();
    if (!confirm(`Backup vom ${this.date(b.createdAt)} endgültig löschen?`)) return;
    this.run(() => this.api.delete(b.id));
  }

  private async run(action: () => Promise<unknown>) {
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      await this.load();
      this.busy.set(false);
    }
  }

  protected date(iso: string) {
    return new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  }

  protected time(iso: string) {
    return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }

  protected size(bytes: number) {
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
    return `${(bytes / 1024 ** 3).toLocaleString('de-DE', { maximumFractionDigits: 2 })} GB`;
  }
}
