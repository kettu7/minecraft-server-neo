import { Component, Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DecimalPipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from './projects.service';
import { Icon } from './icon';

export interface Backup {
  id: string;
  createdAt: string;
  kind: 'auto' | 'manual' | 'import';
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
          <span class="hint">nächstes {{ s.nextRunAt ? time(s.nextRunAt) : '–' }}</span>
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

    <div class="toolbar">
      <span class="hint with-icon"><app-icon name="pin" [size]="14" />Angepinnte Backups werden nicht automatisch gelöscht.</span>
      <button (click)="create()" [disabled]="busy() || status()?.running">{{ creating() ? 'Sichere …' : 'Jetzt sichern' }}</button>
    </div>

    @if (error()) {
      <p class="error">{{ error() }}</p>
    }

    <table class="materials">
      <thead>
        <tr><th>Zeitpunkt</th><th>Art</th><th class="num">Größe</th><th class="num">Dauer</th><th class="num">Aktionen</th></tr>
      </thead>
      <tbody>
        @for (b of backups(); track b.id) {
          <tr [class.covered]="b.pinned">
            <td>
              <strong>{{ date(b.createdAt) }}</strong>
              @if (b.pinned) { <app-icon class="pin-mark" name="pinned-filled" [size]="14" label="angepinnt" /> }
              <div class="hint mono">{{ b.id }}</div>
            </td>
            <td>
              <span class="status" [class.ok]="b.kind === 'manual'" [class.done]="b.kind === 'auto'" [class.import]="b.kind === 'import'">
                {{ b.kind === 'import' ? 'Umzugspaket' : b.kind === 'manual' ? 'manuell' : 'automatisch' }}
              </span>
              @if (b.by) { <div class="hint">von {{ b.by }}</div> }
            </td>
            <td class="num">{{ size(b.totalBytes) }}</td>
            <td class="num hint">{{ b.durationMs / 1000 | number: '1.1-1' }} s</td>
            <td class="num">
              <div class="row-actions">
                <a class="button-link" [href]="'/api/backups/' + b.id + '/download'" download>Download</a>
                <button class="secondary compact" (click)="restore(b)" [disabled]="busy()" title="Welt auf diesen Stand zurücksetzen">Zurückspielen</button>
                <button class="secondary compact" (click)="togglePin(b)" [disabled]="busy()">{{ b.pinned ? 'Lösen' : 'Anpinnen' }}</button>
                <button class="danger compact" (click)="remove(b)" [disabled]="busy()">Löschen</button>
              </div>
            </td>
          </tr>
        } @empty {
          <tr><td colspan="5" class="hint">Noch keine Backups.</td></tr>
        }
      </tbody>
    </table>

    @if (notice()) {
      <p class="ok">{{ notice() }}</p>
    }
    <p class="hint">
      <strong>Zurückspielen</strong> setzt nur die <em>Welt</em> zurück. Whitelist, OPs, Bans und die Website-Daten
      (Projekte, Lager, Konten) bleiben auf dem aktuellen Stand. Vorher wird automatisch ein angepinntes
      Sicherheits-Backup erstellt – das Zurückspielen lässt sich damit selbst wieder rückgängig machen.
    </p>
  `,
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

  togglePin(b: Backup) {
    this.run(() => this.api.pin(b.id, !b.pinned));
  }

  remove(b: Backup) {
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
