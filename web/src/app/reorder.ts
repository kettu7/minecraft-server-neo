import { DestroyRef, Directive, ElementRef, inject, input, output } from '@angular/core';

/** So lange muss man auf eine Kachel drücken, bis sie sich verschieben lässt (0,5 s) */
const HOLD_MS = 500;
/** Bewegt sich der Finger/die Maus vorher weiter, ist es Scrollen oder Klicken – kein Verschieben */
const MOVE_TOLERANCE = 8;

/**
 * Kacheln per langem Drücken (0,5 s) und Ziehen umsortieren – mit Maus und Touch.
 * Container: [appReorder]="ids" (reorder)="Vorschau" (reorderEnd)="Speichern"; Kacheln: [attr.data-reorder-id]="id".
 * Während des Ziehens sortiert der Container live um; Esc bricht ab und stellt die alte Reihenfolge wieder her.
 */
@Directive({
  selector: '[appReorder]',
  host: {
    '(pointerdown)': 'onDown($event)',
    '(window:pointermove)': 'onMove($event)',
    '(window:pointerup)': 'onUp()',
    '(window:pointercancel)': 'cancel()',
    '(window:keydown.escape)': 'cancel()',
    '(contextmenu)': 'onContextMenu($event)',
    '(dragstart)': '$event.preventDefault()',
  },
})
export class Reorder {
  readonly ids = input.required<number[]>({ alias: 'appReorder' });
  /** neue Reihenfolge während des Ziehens */
  readonly reorder = output<number[]>();
  /** endgültige Reihenfolge nach dem Loslassen (nur bei Änderung) */
  readonly reorderEnd = output<number[]>();

  private host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private pending: { id: number; el: HTMLElement; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private drag: { id: number; el: HTMLElement; grabX: number; grabY: number; original: number[]; order: number[] } | null = null;
  private suppressClick = false;

  constructor() {
    // Während des Ziehens darf die Seite auf Touchgeräten nicht scrollen
    const block = (e: TouchEvent) => this.drag && e.cancelable && e.preventDefault();
    document.addEventListener('touchmove', block, { passive: false });
    inject(DestroyRef).onDestroy(() => document.removeEventListener('touchmove', block));
    // Klick direkt nach dem Loslassen abfangen, bevor der Link (routerLink) ihn bekommt
    this.host.addEventListener('click', (e) => this.onClick(e), true);
  }

  onDown(e: PointerEvent) {
    if (e.button !== 0 || this.drag) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-reorder-id]');
    if (!el || !this.host.contains(el)) return;
    const id = Number(el.dataset['reorderId']);
    this.clearPending();
    el.classList.add('reorder-arming');
    this.pending = { id, el, x: e.clientX, y: e.clientY, timer: setTimeout(() => this.start(e.clientX, e.clientY), HOLD_MS) };
  }

  private start(x: number, y: number) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    p.el.classList.remove('reorder-arming');
    const rect = p.el.getBoundingClientRect();
    this.drag = { id: p.id, el: p.el, grabX: x - rect.left, grabY: y - rect.top, original: [...this.ids()], order: [...this.ids()] };
    p.el.classList.add('reorder-dragging');
    this.host.classList.add('reorder-active');
    navigator.vibrate?.(15);
    this.follow(x, y);
  }

  onMove(e: PointerEvent) {
    if (this.pending && Math.hypot(e.clientX - this.pending.x, e.clientY - this.pending.y) > MOVE_TOLERANCE) this.clearPending();
    if (!this.drag) return;
    e.preventDefault();
    this.follow(e.clientX, e.clientY);

    // Ziel: Kachel unter dem Zeiger, aber nur im inneren Bereich – verhindert Hin- und Herspringen
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-reorder-id]');
    if (!under || under === this.drag.el || !this.host.contains(under)) return;
    const r = under.getBoundingClientRect();
    const inner = e.clientX > r.left + r.width * 0.2 && e.clientX < r.right - r.width * 0.2
      && e.clientY > r.top + r.height * 0.15 && e.clientY < r.bottom - r.height * 0.15;
    if (!inner) return;
    const target = Number(under.dataset['reorderId']);
    const order = this.drag.order.filter((id) => id !== this.drag!.id);
    const from = this.drag.order.indexOf(this.drag.id);
    const to = this.drag.order.indexOf(target);
    order.splice(to, 0, this.drag.id);
    if (from === to) return;
    this.drag.order = order;
    this.reorder.emit(order);
    // Nach dem Umsortieren steht die Kachel woanders – Position im nächsten Frame nachführen
    requestAnimationFrame(() => this.drag && this.follow(e.clientX, e.clientY));
  }

  /** Kachel klebt am Zeiger: Verschiebung relativ zu ihrem (neuen) Platz im Raster */
  private follow(x: number, y: number) {
    const el = this.drag!.el;
    el.style.transform = '';
    const rect = el.getBoundingClientRect();
    el.style.transform = `translate(${x - this.drag!.grabX - rect.left}px, ${y - this.drag!.grabY - rect.top}px) scale(1.03)`;
  }

  onUp() {
    this.clearPending();
    if (!this.drag) return;
    const { order, original } = this.drag;
    this.finish();
    this.suppressClick = true; // der Klick nach dem Loslassen soll die Kachel nicht öffnen
    setTimeout(() => (this.suppressClick = false), 0);
    if (order.join() !== original.join()) this.reorderEnd.emit(order);
  }

  cancel() {
    this.clearPending();
    if (!this.drag) return;
    const { original } = this.drag;
    this.finish();
    this.reorder.emit(original);
  }

  private finish() {
    const el = this.drag!.el;
    this.drag = null;
    this.host.classList.remove('reorder-active');
    el.classList.remove('reorder-dragging');
    el.classList.add('reorder-dropping');
    el.style.transform = '';
    setTimeout(() => el.classList.remove('reorder-dropping'), 220);
  }

  private clearPending() {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.el.classList.remove('reorder-arming');
    this.pending = null;
  }

  onContextMenu(e: Event) {
    // Langes Drücken öffnet auf Handys sonst das Kontextmenü
    if (this.pending || this.drag) e.preventDefault();
  }

  private onClick(e: Event) {
    if (!this.suppressClick) return;
    e.preventDefault();
    e.stopPropagation();
  }
}
