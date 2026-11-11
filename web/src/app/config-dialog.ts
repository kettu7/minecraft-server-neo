import { Component, ElementRef, Injectable, computed, inject, output, signal, viewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from './projects.service';
import { Icon } from './icon';

export interface ConfigFile {
  path: string;
  size: number;
  modified: number;
  mod: { projectId: string; title: string } | null;
}

interface HistoryItem { id: number; by: string; createdAt: string; size: number }
interface LoadedFile { path: string; content: string; modified: number; size: number; history: HistoryItem[] }

@Injectable({ providedIn: 'root' })
export class ConfigService {
  private http = inject(HttpClient);
  async list() { return (await firstValueFrom(this.http.get<{ files: ConfigFile[] }>('/api/configs'))).files; }
  read(path: string) { return firstValueFrom(this.http.get<LoadedFile>('/api/configs/file', { params: { path } })); }
  save(path: string, content: string, modified: number) {
    return firstValueFrom(this.http.put<{ ok: true; unchanged?: boolean; modified: number; history: HistoryItem[] }>('/api/configs/file', { path, content, modified }));
  }
  version(id: number) { return firstValueFrom(this.http.get<{ content: string }>(`/api/configs/history/${id}`)); }
  restart() { return firstValueFrom(this.http.post('/api/server/restart', {})); }
}

/**
 * Config-Dateien der Mods bearbeiten. Eine Datei öffnet gleich im Editor, mehrere zeigen links die Liste.
 * Gespeichert wird erst per Knopf: Die Seite prüft das Format, sichert den alten Stand und schreibt über neo-control.
 */
@Component({
  selector: 'app-config-dialog',
  imports: [Icon],
  template: `
    <dialog #dialog class="glass-dialog config-dialog" (click)="backdropClose($event)" (cancel)="onCancel($event)" (close)="reset()">
      <div class="dialog-body">
        <header class="project-head">
          <div>
            <h2>{{ title() }}</h2>
            <p class="hint">Mods lesen ihre Einstellungen beim Start – Änderungen wirken nach dem nächsten Neustart.</p>
          </div>
          <button type="button" class="icon-btn" (click)="close()" title="Schließen" aria-label="Schließen"><app-icon name="x" [size]="18" /></button>
        </header>

        <div class="config-layout" [class.single]="files().length < 2">
          @if (files().length > 1) {
            <nav class="config-files" aria-label="Dateien">
              @for (f of files(); track f.path) {
                <button type="button" [class.active]="f.path === current()" [attr.aria-current]="f.path === current() ? 'true' : null" (click)="select(f.path)">
                  <span class="mono">{{ f.path }}</span>
                  @if (showMods() && f.mod) { <small>{{ f.mod.title }}</small> }
                </button>
              }
            </nav>
          }

          <div class="config-editor">
            @if (current(); as path) {
              <div class="config-bar">
                <span class="mono">{{ path }}</span>
                @if (history().length) {
                  <select aria-label="Früheren Stand laden" (change)="loadVersion($any($event.target))" [disabled]="busy()">
                    <option value="">Früheren Stand laden …</option>
                    @for (h of history(); track h.id) {
                      <option [value]="h.id">{{ when(h.createdAt) }}<ng-container> – {{ h.by }}</ng-container></option>
                    }
                  </select>
                }
              </div>
              <textarea #editor class="config-text" spellcheck="false" wrap="off" autocomplete="off" autocapitalize="off"
                        [value]="text()" (input)="text.set(editor.value)" [disabled]="loading()"
                        (keydown.control.s)="saveByKey($event)" (keydown.meta.s)="saveByKey($event)"
                        aria-label="Inhalt der Datei"></textarea>

              @if (problem()) { <p class="error small config-msg">{{ problem() }}</p> }
              @else if (error()) { <p class="error small config-msg">{{ error() }}</p> }

              @if (saved() && !dirty()) {
                <p class="config-saved">
                  <span class="with-icon"><app-icon name="circle-check" [size]="16" />Gespeichert. Gilt ab dem nächsten Start.</span>
                  <button type="button" class="secondary compact with-icon" (click)="restart()" [disabled]="restarting()">
                    <app-icon name="rotate" [size]="14" />{{ restarting() ? 'Startet neu …' : 'Jetzt neu starten' }}
                  </button>
                </p>
              }

              <div class="form-footer config-footer">
                <button type="button" class="text-button with-icon" (click)="revert()" [disabled]="!dirty() || busy()">
                  <app-icon name="history" [size]="15" />Änderungen verwerfen
                </button>
                <button type="button" (click)="save()" [disabled]="!dirty() || busy() || !!problem() || loading()">
                  {{ busy() ? 'Speichert …' : 'Speichern' }}
                </button>
              </div>
            } @else {
              <p class="hint">Keine Dateien gefunden.</p>
            }
          </div>
        </div>
      </div>
    </dialog>
  `,
})
export class ConfigDialog {
  private api = inject(ConfigService);
  private dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  /** nach dem Speichern, damit die Liste ihre Zähler neu laden kann */
  changed = output<void>();

  protected files = signal<ConfigFile[]>([]);
  protected title = signal('Konfiguration');
  protected showMods = signal(false);
  protected current = signal('');
  protected original = signal('');
  protected text = signal('');
  protected modified = signal(0);
  protected history = signal<HistoryItem[]>([]);
  protected loading = signal(false);
  protected busy = signal(false);
  protected error = signal('');
  protected saved = signal(false);
  protected restarting = signal(false);

  protected dirty = computed(() => this.text() !== this.original());
  /** JSON lässt sich schon beim Tippen prüfen; die anderen Formate prüft der Server beim Speichern */
  protected problem = computed(() => {
    if (!this.current().toLowerCase().endsWith('.json') || !this.dirty()) return '';
    try {
      JSON.parse(this.text());
      return '';
    } catch (err) {
      return `Kein gültiges JSON: ${(err as Error).message}`;
    }
  });

  /** files = alle anzeigbaren Dateien, withMods = Namen der zugehörigen Mods in der Liste zeigen */
  async open(files: ConfigFile[], title: string, withMods = false) {
    this.files.set(files);
    this.title.set(title);
    this.showMods.set(withMods);
    this.saved.set(false);
    const el = this.dialog().nativeElement;
    if (!el.open) el.showModal();
    if (files[0]) await this.load(files[0].path);
  }

  private async load(path: string) {
    this.current.set(path);
    this.loading.set(true);
    this.error.set('');
    this.saved.set(false);
    try {
      const file = await this.api.read(path);
      this.original.set(file.content);
      this.text.set(file.content);
      this.modified.set(file.modified);
      this.history.set(file.history);
    } catch (err) {
      this.original.set('');
      this.text.set('');
      this.history.set([]);
      this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected select(path: string) {
    if (path === this.current() || !this.confirmDiscard()) return;
    return this.load(path);
  }

  private confirmDiscard() {
    return !this.dirty() || confirm('Es gibt ungespeicherte Änderungen. Verwerfen?');
  }

  protected revert() {
    this.text.set(this.original());
    this.error.set('');
  }

  protected async loadVersion(select: HTMLSelectElement) {
    const id = Number(select.value);
    select.value = '';
    if (!id || !this.confirmDiscard()) return;
    try {
      this.text.set((await this.api.version(id)).content);
      this.error.set('');
      this.saved.set(false);
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  protected saveByKey(event: Event) {
    event.preventDefault();
    if (this.dirty() && !this.busy() && !this.problem()) void this.save();
  }

  protected async save() {
    this.busy.set(true);
    this.error.set('');
    try {
      const res = await this.api.save(this.current(), this.text(), this.modified());
      this.original.set(this.text());
      this.modified.set(res.modified);
      this.history.set(res.history);
      this.saved.set(true);
      this.changed.emit();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected async restart() {
    if (!confirm('Server jetzt neu starten? Alle Spieler werden getrennt.')) return;
    this.restarting.set(true);
    try {
      await this.api.restart();
      this.saved.set(false);
      this.close(true);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.restarting.set(false);
    }
  }

  close(force = false) {
    if (force || this.confirmDiscard()) this.dialog().nativeElement.close();
  }

  /** Esc: bei ungespeicherten Änderungen erst nachfragen */
  protected onCancel(event: Event) {
    if (this.dirty() && !confirm('Es gibt ungespeicherte Änderungen. Verwerfen?')) event.preventDefault();
  }

  protected backdropClose(event: MouseEvent) {
    if (event.target === this.dialog().nativeElement) this.close();
  }

  protected reset() {
    this.text.set('');
    this.original.set('');
    this.error.set('');
  }

  protected when(iso: string) {
    return new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'))
      .toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
}
