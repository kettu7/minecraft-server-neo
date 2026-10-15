import { Component, HostListener, inject, input, output, signal } from '@angular/core';
import { ProjectsService, errorMessage, imageFromTransfer } from './projects.service';

/**
 * Projektbild auf der Detailseite: hochladen, aus der Zwischenablage einfügen (Strg+V oder Knopf),
 * per Ziehen & Ablegen setzen, entfernen. Wird im Browser verkleinert, bevor es hochgeladen wird.
 */
@Component({
  selector: 'app-project-image',
  template: `
    <section class="card project-image" [class.dragging]="dragging()" (dragover)="onDragOver($event)"
             (dragleave)="dragging.set(false)" (drop)="onDrop($event)">
      @if (image()) {
        <a [href]="image()" target="_blank" rel="noopener" class="project-image-view" title="In voller Größe öffnen">
          <img [src]="image()" alt="Bild des Bauprojekts" />
        </a>
      } @else {
        <div class="project-image-empty">
          <span class="drop-icon">🖼️</span>
          <strong>Noch kein Bild</strong>
          <span class="hint">Screenshot im Spiel mit <kbd>F2</kbd>, dann hier <kbd>Strg</kbd>+<kbd>V</kbd> – oder Datei hierher ziehen.</span>
        </div>
      }

      <div class="project-image-actions">
        <label class="button-link">
          {{ image() ? 'Ersetzen' : 'Bild hochladen' }}
          <input type="file" accept="image/png,image/jpeg,image/webp" hidden (change)="onFile($event)" [disabled]="busy()" />
        </label>
        <button type="button" class="secondary compact" (click)="pasteFromClipboard()" [disabled]="busy()">Aus Zwischenablage</button>
        @if (image()) {
          <button type="button" class="danger compact" (click)="remove()" [disabled]="busy()">Entfernen</button>
        }
        @if (busy()) { <span class="hint">Lade hoch …</span> }
      </div>
      @if (error()) {
        <p class="error small">{{ error() }}</p>
      }
      @if (dragging()) {
        <div class="drop-overlay">Bild hier ablegen</div>
      }
    </section>
  `,
})
export class ProjectImage {
  private api = inject(ProjectsService);
  projectId = input.required<number>();
  image = input<string | null>(null);
  /** Nach dem Ändern: Projekt neu laden */
  changed = output<void>();

  protected busy = signal(false);
  protected error = signal('');
  protected dragging = signal(false);

  /** Strg+V irgendwo auf der Projektseite – außer beim Tippen in Eingabefeldern */
  @HostListener('window:paste', ['$event'])
  onPaste(event: ClipboardEvent) {
    // Ziel kann ein Element oder das Fenster selbst sein
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, [contenteditable]')) return;
    const file = imageFromTransfer(event.clipboardData);
    if (!file) return;
    event.preventDefault();
    this.upload(file);
  }

  onDragOver(event: DragEvent) {
    if (![...(event.dataTransfer?.items ?? [])].some((i) => i.type.startsWith('image/'))) return;
    event.preventDefault();
    this.dragging.set(true);
  }

  onDrop(event: DragEvent) {
    event.preventDefault();
    this.dragging.set(false);
    const file = imageFromTransfer(event.dataTransfer);
    if (file) this.upload(file);
  }

  onFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) this.upload(file);
  }

  async pasteFromClipboard() {
    this.error.set('');
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) return this.upload(await item.getType(type));
      }
      this.error.set('In der Zwischenablage ist kein Bild.');
    } catch {
      this.error.set('Der Browser erlaubt den Zugriff nicht – einfach Strg+V auf dieser Seite drücken.');
    }
  }

  async remove() {
    if (!confirm('Bild entfernen?')) return;
    await this.run(() => this.api.deleteImage(this.projectId()));
  }

  private upload(file: Blob) {
    if (file.size > 30 * 1024 * 1024) {
      this.error.set('Das Bild ist sehr groß (über 30 MB).');
      return;
    }
    return this.run(() => this.api.uploadImage(this.projectId(), file));
  }

  private async run(action: () => Promise<unknown>) {
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
      this.changed.emit();
    } catch (err) {
      this.error.set(err instanceof DOMException ? 'Das Bild konnte nicht gelesen werden.' : errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
