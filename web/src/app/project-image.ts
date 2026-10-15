import { Component, ElementRef, HostListener, inject, input, output, signal, viewChild } from '@angular/core';
import { ProjectsService, errorMessage, imageFromTransfer } from './projects.service';
import { NgTemplateOutlet } from '@angular/common';
import { Icon } from './icon';

/**
 * Projektbild auf der Detailseite: hochladen, aus der Zwischenablage einfügen (Strg+V oder Knopf),
 * per Ziehen & Ablegen setzen, entfernen. Wird im Browser verkleinert, bevor es hochgeladen wird.
 * Ohne Bild zeigt der Platzhalter die Aktionen, mit Bild ein Stift-Knopf, der ein Overlay öffnet.
 */
@Component({
  selector: 'app-project-image',
  imports: [Icon, NgTemplateOutlet],
  template: `
    <section class="card media-card" [class.dragging]="dragging()" [class.has-image]="!!image()" (dragover)="onDragOver($event)"
             (dragleave)="dragging.set(false)" (drop)="onDrop($event)">
      @if (image()) {
        <button type="button" class="media-view" (click)="openLightbox()" title="Groß anzeigen" aria-label="Bild groß anzeigen">
          <img [src]="image()" alt="Bild des Bauprojekts" />
        </button>
        <button type="button" class="media-fab" (click)="menuOpen.set(true)" [attr.aria-expanded]="menuOpen()"
                aria-label="Bild bearbeiten" title="Bild bearbeiten">
          <app-icon name="pencil" [size]="16" />
        </button>
        @if (menuOpen()) {
          <div class="media-overlay" (click)="closeMenu()">
            <div class="media-menu" role="menu" (click)="$event.stopPropagation()">
              <ng-container *ngTemplateOutlet="actions" />
              <button type="button" class="ghost-button with-icon" (click)="closeMenu()">
                <app-icon name="x" [size]="15" />Abbrechen
              </button>
            </div>
          </div>
        }
      } @else {
        <div class="media-empty">
          <span class="media-empty-icon"><app-icon name="photo" [size]="28" [stroke]="1.5" /></span>
          <strong>Noch kein Bild</strong>
          <span class="hint">Datei hierher ziehen oder mit <kbd>Strg</kbd>+<kbd>V</kbd> einfügen.</span>
          <div class="media-empty-actions">
            <ng-container *ngTemplateOutlet="actions" />
          </div>
        </div>
      }

      <ng-template #actions>
        <label class="button-link with-icon" [class.disabled]="busy()">
          <app-icon name="upload" [size]="15" />{{ image() ? 'Ersetzen' : 'Bild hochladen' }}
          <input type="file" accept="image/png,image/jpeg,image/webp" hidden (change)="onFile($event)" [disabled]="busy()" />
        </label>
        <button type="button" class="secondary with-icon" (click)="pasteFromClipboard()" [disabled]="busy()">
          <app-icon name="clipboard" [size]="15" />Aus Zwischenablage
        </button>
        @if (image()) {
          <button type="button" class="danger with-icon" (click)="remove()" [disabled]="busy()">
            <app-icon name="trash" [size]="15" />Entfernen
          </button>
        }
      </ng-template>

      @if (busy()) {
        <div class="media-busy"><span class="spinner"></span>Lade hoch …</div>
      }
      @if (error()) {
        <p class="error small media-error">{{ error() }}</p>
      }
      @if (dragging()) {
        <div class="drop-overlay">Bild hier ablegen</div>
      }
    </section>

    <!-- Großansicht -->
    <dialog #lightbox class="lightbox" (click)="lightbox.close()" aria-label="Bild des Bauprojekts">
      @if (image()) { <img [src]="image()" alt="Bild des Bauprojekts" (click)="$event.stopPropagation()" /> }
      <button type="button" class="lightbox-close" (click)="lightbox.close()" aria-label="Schließen">
        <app-icon name="x" [size]="20" />
      </button>
    </dialog>
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
  protected menuOpen = signal(false);
  private lightbox = viewChild<ElementRef<HTMLDialogElement>>('lightbox');

  openLightbox() {
    this.lightbox()?.nativeElement.showModal();
  }

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

  @HostListener('document:keydown.escape')
  closeMenu() {
    if (!this.busy()) this.menuOpen.set(false);
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
      this.menuOpen.set(false);
      this.changed.emit();
    } catch (err) {
      this.error.set(err instanceof DOMException ? 'Das Bild konnte nicht gelesen werden.' : errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
