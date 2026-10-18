import { Component, Injectable, inject, output, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from './projects.service';
import { Icon } from './icon';

@Injectable({ providedIn: 'root' })
export class WorldService {
  private http = inject(HttpClient);
  get() { return firstValueFrom(this.http.get<{ name: string; running: boolean }>('/api/server/world')); }
  rename(name: string) { return firstValueFrom(this.http.post<{ name: string }>('/api/server/world/name', { name })); }
  create(name: string, seed: string) {
    return firstValueFrom(this.http.post<{ name: string; archive: string }>('/api/server/new-world', { name, seed }));
  }
}

/** Ganz unten auf der Serverseite: aktuelle Welt benennen und eine komplett neue Welt erzeugen */
@Component({
  selector: 'app-new-world',
  imports: [Icon],
  template: `
    <div class="world-head">
      <div>
        <h3>Welt</h3>
        @if (renaming()) {
          <form class="world-rename" (submit)="rename($event, nameInput)">
            <input #nameInput type="text" maxlength="40" [value]="name()" aria-label="Name der aktuellen Welt" />
            <button type="submit" class="compact" [disabled]="busy()">Speichern</button>
            <button type="button" class="ghost-button" (click)="renaming.set(false)">Abbrechen</button>
          </form>
        } @else {
          <p class="world-current">
            Aktuelle Welt: <strong>{{ name() || '…' }}</strong>
            <button type="button" class="icon-btn" (click)="renaming.set(true)" title="Umbenennen" aria-label="Aktuelle Welt umbenennen"><app-icon name="pencil" [size]="14" /></button>
          </p>
        }
        <p class="hint small-text">Der Name steht in jedem Backup und hilft, Archive später zuzuordnen.</p>
      </div>
      @if (!open()) {
        <button type="button" class="danger with-icon" (click)="open.set(true)" [disabled]="busy()">
          <app-icon name="world" [size]="15" />Neue Welt erzeugen
        </button>
      }
    </div>

    <div class="create-reveal" [class.open]="open()" [attr.inert]="open() ? null : ''">
      <div class="create-inner">
        <form class="new-world-form" (submit)="create($event, newName, seed)">
          <ul class="new-world-steps">
            <li><app-icon name="pin" [size]="15" />Die Welt „{{ name() }}“ wird als angepinntes Backup <b>Welt archiviert</b> gesichert.</li>
            <li><app-icon name="alert-triangle" [size]="15" />Danach wird sie ersetzt. Spieler werden 10 Sekunden vorher gewarnt und getrennt.</li>
            <li><app-icon name="info-circle" [size]="15" />Lager und Projekt-Standorte zeigen noch auf die alte Welt, Ranglisten beginnen bei 0.</li>
          </ul>
          <label>
            Name der neuen Welt
            <input #newName type="text" maxlength="40" required placeholder="z. B. Neo 2" />
          </label>
          <label>
            <span>Seed <span class="hint">(optional)</span></span>
            <input #seed type="text" maxlength="64" placeholder="leer = zufällig" autocomplete="off" />
          </label>
          <div class="wide form-footer">
            <button type="button" class="ghost-button" (click)="open.set(false)" [disabled]="busy()">Abbrechen</button>
            <button type="submit" class="danger with-icon" [disabled]="busy()">
              <app-icon name="world" [size]="15" />{{ busy() ? 'Welt wird erzeugt …' : 'Welt jetzt erzeugen' }}
            </button>
          </div>
          @if (busy()) { <p class="hint small-text wide">Archiv-Backup, Neustart und Erzeugen dauern meist 1–3 Minuten. Seite bitte offen lassen.</p> }
        </form>
      </div>
    </div>

    @if (error()) { <p class="error small">{{ error() }}</p> }
    @if (notice()) { <p class="ok">{{ notice() }}</p> }
  `,
  host: { '(document:keydown.escape)': '!busy() && open.set(false)' },
})
export class NewWorld {
  private api = inject(WorldService);
  /** nach dem Erzeugen: Seite lädt Status und Backups neu */
  readonly created = output<void>();
  protected name = signal('');
  protected open = signal(false);
  protected renaming = signal(false);
  protected busy = signal(false);
  protected error = signal('');
  protected notice = signal('');

  constructor() {
    this.api.get().then((w) => {
      this.name.set(w.name);
      this.busy.set(w.running);
    }).catch(() => undefined);
  }

  async rename(event: Event, input: HTMLInputElement) {
    event.preventDefault();
    this.error.set('');
    try {
      this.name.set((await this.api.rename(input.value)).name);
      this.renaming.set(false);
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  async create(event: Event, nameInput: HTMLInputElement, seedInput: HTMLInputElement) {
    event.preventDefault();
    const name = nameInput.value.trim();
    const seed = seedInput.value.trim();
    if (!name) return nameInput.focus();
    if (!confirm(`Neue Welt „${name}“ erzeugen?\n\nDie Welt „${this.name()}“ wird vorher als angepinntes Backup gesichert und danach ersetzt. Alle Spieler werden getrennt.`)) return;
    if (prompt('Zur Bestätigung bitte NEUE WELT eingeben:')?.trim().toUpperCase() !== 'NEUE WELT') return;
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      const res = await this.api.create(name, seed);
      this.name.set(res.name);
      this.open.set(false);
      nameInput.value = '';
      seedInput.value = '';
      this.notice.set(`Neue Welt „${res.name}“ wird erzeugt – in etwa einer Minute ist der Server wieder da. Die alte Welt liegt im Backup ${res.archive} (angepinnt).`);
      this.created.emit();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
