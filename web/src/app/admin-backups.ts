import { Component, Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpEventType } from '@angular/common/http';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { DecimalPipe } from '@angular/common';
import { firstValueFrom, lastValueFrom, tap } from 'rxjs';
import { errorMessage } from './projects.service';

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
  restoreAll(id: string) {
    return firstValueFrom(this.http.post<{ ok: true; safetyBackup: string }>(`/api/backups/${id}/restore-all`, {}));
  }
  /** Umzugspaket hochladen; onProgress bekommt den Anteil 0–1 */
  upload(file: File, onProgress: (share: number) => void) {
    return lastValueFrom(
      this.http
        .put<{ ok: true; id: string }>('/api/backups/import', file, {
          headers: { 'Content-Type': 'application/x-tar' },
          reportProgress: true,
          observe: 'events',
        })
        .pipe(tap((e) => e.type === HttpEventType.UploadProgress && e.total && onProgress(e.loaded / e.total))),
    );
  }
}

/** Unternavigation des Admin-Bereichs */
@Component({
  selector: 'app-admin-nav',
  imports: [RouterLink, RouterLinkActive],
  template: `
    <nav class="subnav">
      <a routerLink="/admin" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Benutzer & Bans</a>
      <a routerLink="/admin/server" routerLinkActive="active">Server</a>
      <a routerLink="/admin/mods" routerLinkActive="active">Mods</a>
      <a routerLink="/admin/modpack" routerLinkActive="active">Modpack</a>
      <a routerLink="/admin/backups" routerLinkActive="active">Backups</a>
    </nav>
  `,
})
export class AdminNav {}

const POLL_MS = 15_000;

@Component({
  selector: 'app-admin-backups',
  imports: [AdminNav, DecimalPipe],
  template: `
    <header class="page-head">
      <span class="eyebrow">Admin</span>
      <h1>Backups</h1>
      <p class="hint">
        Gesichert werden Welt, Server-Einstellungen (Whitelist, OPs, Bans, Mod-Configs) und die Website-Daten.
        Die Karte wird nicht gesichert, sie lässt sich neu berechnen.
      </p>
    </header>

    <app-admin-nav />

    @if (status(); as s) {
      <section class="card stats">
        <div>
          <strong>{{ backups().length }}</strong>
          <span class="hint">Backups · {{ size(totalBytes()) }}</span>
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

    <section class="card migrate">
      <div>
        <h3>Umzug</h3>
        <p class="hint">
          Auf dem alten Server bei einem Backup <strong>„Umzugspaket“</strong> herunterladen (Welt, Website-Daten,
          Blaupausen, Bilder und Item-Bibliothek in einer Datei), hier hochladen und dann <strong>„Alles übernehmen“</strong>.
        </p>
      </div>
      <label class="button-link upload-btn" [class.disabled]="busy()">
        {{ uploading() ? 'Lädt hoch … ' + uploadPct() + ' %' : 'Umzugspaket hochladen' }}
        <input type="file" accept=".tar" hidden (change)="upload($event)" [disabled]="busy()" />
      </label>
      @if (uploading()) {
        <div class="bar"><div [style.width.%]="uploadPct()"></div></div>
      }
    </section>

    <div class="toolbar">
      <span class="hint">📌 Angepinnte Backups werden nie automatisch gelöscht – z. B. vor großen Umbauten.</span>
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
              @if (b.pinned) { <span title="angepinnt"> 📌</span> }
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
                <a class="button-link" [href]="'/api/backups/' + b.id + '/package'" download title="Alles in einer Datei – für den Umzug auf einen anderen Server">Umzugspaket</a>
                <a class="button-link" [href]="'/api/backups/' + b.id + '/download'" download title="Nur die Welt">Welt</a>
                <button class="danger compact" (click)="restoreAll(b)" [disabled]="busy()" title="Welt und Website-Daten komplett durch diesen Stand ersetzen">Alles übernehmen</button>
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
export class AdminBackups {
  private api = inject(BackupsService);
  protected backups = signal<Backup[]>([]);
  protected status = signal<BackupStatus | undefined>(undefined);
  protected busy = signal(false);
  protected creating = signal(false);
  protected error = signal('');
  protected notice = signal('');
  protected uploading = signal(false);
  protected uploadPct = signal(0);
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

  async upload(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.uploading.set(true);
    this.uploadPct.set(0);
    this.notice.set('');
    await this.run(async () => {
      await this.api.upload(file, (share) => this.uploadPct.set(Math.round(share * 100)));
      this.notice.set(`Umzugspaket „${file.name}“ hochgeladen – es steht jetzt in der Liste. Mit „Alles übernehmen“ einspielen.`);
    });
    this.uploading.set(false);
  }

  async restoreAll(b: Backup) {
    const when = this.date(b.createdAt);
    if (!confirm(`ALLES durch den Stand vom ${when} ersetzen?

• Welt, OPs, Whitelist, Bans und Mod-Einstellungen
• Website: Konten, Projekte, Lager, Mods, Modpack, Blaupausen, Bilder
• Item-Bibliothek

Der aktuelle Stand geht dabei verloren (vorher wird automatisch ein Sicherheits-Backup erstellt).
Server und Website starten neu, danach musst du dich neu anmelden.`)) return;
    if (prompt('Zur Bestätigung bitte UMZUG eingeben:') !== 'UMZUG') return;
    this.notice.set('');
    await this.run(async () => {
      const { safetyBackup } = await this.api.restoreAll(b.id);
      this.notice.set(`Übernahme läuft: Server und Website starten neu. In etwa einer halben Minute geht es zur Anmeldung. Sicherheits-Backup: ${safetyBackup}.`);
      setTimeout(() => location.assign('/login'), 30_000);
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
