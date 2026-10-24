import { Component, ElementRef, Injectable, computed, effect, inject, signal, viewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth';
import { Icon } from './icon';
import type { IconName } from './icons.generated';

export type NotificationKind = 'info' | 'modpack' | 'restart' | 'event' | 'trophy' | 'backup' | 'world' | 'project' | 'warning';

export interface AppNotification {
  id: number;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string | null;
  actionLabel: string | null;
  audience: 'all' | 'admin';
  createdAt: string;
  read: boolean;
}

const POLL_MS = 60_000;
/** im zugeklappten Stapel sichtbare Karten (vorne + dahinter) */
const STACK = 3;

export const KIND_ICONS: Record<NotificationKind, IconName> = {
  info: 'info-circle', modpack: 'package', restart: 'rotate', event: 'confetti', trophy: 'trophy',
  backup: 'database', world: 'world', project: 'hammer', warning: 'alert-triangle',
};

/** „gerade eben“, „vor 5 Min.“, „vor 3 Std.“, „gestern“, „vor 4 Tagen“, sonst Datum */
export function timeAgo(iso: string, now = Date.now()) {
  const min = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h} Std.`;
  const d = Math.round(h / 24);
  if (d === 1) return 'gestern';
  if (d < 7) return `vor ${d} Tagen`;
  return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Benachrichtigungen für Toasts und Glocke – ein gemeinsamer Stand für die ganze App */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  readonly items = signal<AppNotification[]>([]);
  readonly unread = computed(() => this.items().filter((n) => !n.read));
  private timer?: ReturnType<typeof setInterval>;

  constructor() {
    // Nur für freigeschaltete Mitglieder laden, danach jede Minute nachsehen
    effect(() => {
      clearInterval(this.timer);
      if (!this.auth.isMember()) return this.items.set([]);
      this.load();
      this.timer = setInterval(() => this.load(), POLL_MS);
    });
  }

  async load() {
    try {
      this.items.set((await firstValueFrom(this.http.get<{ items: AppNotification[] }>('/api/notifications'))).items);
    } catch { /* Kopfleiste soll nie an Meldungen scheitern */ }
  }

  /** Schließen: lokal sofort, dann auf dem Server merken */
  read(id: number) {
    this.items.update((list) => list.map((n) => (n.id === id ? { ...n, read: true } : n)));
    firstValueFrom(this.http.post(`/api/notifications/${id}/read`, {})).catch(() => undefined);
  }

  readAll() {
    if (!this.unread().length) return;
    this.items.update((list) => list.map((n) => ({ ...n, read: true })));
    firstValueFrom(this.http.post('/api/notifications/read-all', {})).catch(() => undefined);
  }
}

/**
 * Toasts oben rechts: ungelesene Meldungen als Stapel – vorne die neueste, dahinter bis zu zwei weitere
 * halbtransparent. Maus darüber, Fokus oder „Alle anzeigen“ fächert den Stapel auf. ✕ schließt endgültig.
 */
@Component({
  selector: 'app-toasts',
  imports: [Icon],
  template: `
    @if (toasts().length) {
      <section class="toast-stack" [class.expanded]="expanded()" aria-label="Neue Benachrichtigungen" aria-live="polite"
               (mouseenter)="hover.set(true)" (mouseleave)="hover.set(false)" (focusin)="focus.set(true)" (focusout)="onFocusOut($event)">
        <div class="toast-list">
          @for (n of shown(); track n.id; let i = $index) {
            <article class="toast" [class.behind]="!expanded() && i > 0" [class.leaving]="leaving() === n.id" [class.entering]="entering().has(n.id)"
                     [style.--i]="i" [attr.data-kind]="n.kind" [attr.aria-hidden]="!expanded() && i > 0 ? 'true' : null">
              <span class="toast-icon"><app-icon [name]="icon(n)" [size]="18" /></span>
              <div class="toast-text">
                <div class="toast-head">
                  <strong>{{ n.title }}</strong>
                  <span class="toast-time">{{ ago(n.createdAt) }}</span>
                </div>
                @if (n.body) { <p>{{ n.body }}</p> }
                @if (n.link) {
                  <div class="toast-actions">
                    <button type="button" class="compact" (click)="open(n)" [tabindex]="!expanded() && i > 0 ? -1 : 0">{{ n.actionLabel ?? 'Ansehen' }}</button>
                  </div>
                }
              </div>
              <button type="button" class="toast-close" (click)="close(n)" [tabindex]="!expanded() && i > 0 ? -1 : 0"
                      [attr.aria-label]="'„' + n.title + '“ schließen'" title="Schließen">
                <app-icon name="x" [size]="15" />
              </button>
            </article>
          }
        </div>
        @if (toasts().length > 1) {
          <div class="toast-footer">
            @if (!expanded()) {
              <button type="button" class="link" (click)="pinned.set(true)">Alle anzeigen ({{ toasts().length }})</button>
            } @else if (pinned()) {
              <button type="button" class="link" (click)="pinned.set(false)">Zuklappen</button>
            }
            <button type="button" class="link" (click)="closeAll()">Alle schließen</button>
          </div>
        }
      </section>
    }
  `,
})
export class Toasts {
  private api = inject(NotificationService);
  private router = inject(Router);
  protected hover = signal(false);
  protected focus = signal(false);
  /** per Klick aufgeklappt (Handy, Tastatur) */
  protected pinned = signal(false);
  protected leaving = signal<number | null>(null);
  protected expanded = computed(() => this.hover() || this.focus() || this.pinned());
  protected toasts = this.api.unread;
  /** Zugeklappt nur die vorderen Karten, aufgeklappt alle (die Liste scrollt bei Bedarf) */
  protected shown = computed(() => (this.expanded() ? this.toasts() : this.toasts().slice(0, STACK)));
  /** neu hinzugekommene Meldungen gleiten herein – jede nur einmal */
  protected entering = signal(new Set<number>());
  private seen = new Set<number>();

  constructor() {
    effect(() => {
      const fresh = this.toasts().map((n) => n.id).filter((id) => !this.seen.has(id));
      if (!fresh.length) return;
      for (const id of fresh) this.seen.add(id);
      this.entering.update((s) => new Set([...s, ...fresh]));
      setTimeout(() => this.entering.update((s) => new Set([...s].filter((id) => !fresh.includes(id)))), 1200);
    });
  }

  protected icon = (n: AppNotification) => KIND_ICONS[n.kind] ?? 'info-circle';
  protected ago = (iso: string) => timeAgo(iso);

  close(n: AppNotification) {
    this.leaving.set(n.id);
    setTimeout(() => {
      this.api.read(n.id);
      this.leaving.set(null);
      if (this.toasts().length <= 1) this.pinned.set(false);
    }, 220);
  }

  closeAll() {
    this.api.readAll();
    this.pinned.set(false);
  }

  open(n: AppNotification) {
    this.api.read(n.id);
    if (n.link) this.router.navigateByUrl(n.link);
  }

  protected onFocusOut(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (!next || !(event.currentTarget as HTMLElement).contains(next)) this.focus.set(false);
  }
}

/** Glocke neben dem Profilbild: blauer Punkt bei Ungelesenem, Klick zeigt alle Meldungen der letzten Zeit */
@Component({
  selector: 'app-bell',
  imports: [Icon],
  template: `
    <button type="button" class="bell" (click)="toggle($event)" aria-haspopup="dialog" [attr.aria-expanded]="open()"
            [attr.aria-label]="api.unread().length ? 'Benachrichtigungen, ' + api.unread().length + ' neu' : 'Benachrichtigungen'"
            title="Benachrichtigungen">
      <app-icon name="bell" [size]="19" />
      @if (api.unread().length) { <span class="bell-dot" aria-hidden="true"></span> }
    </button>

    <div #panel popover class="notif-panel" role="dialog" aria-label="Benachrichtigungen"
         [style.top.px]="pos().top" [style.left.px]="pos().left" (toggle)="onToggle($any($event).newState === 'open')">
      <header>
        <strong>Benachrichtigungen</strong>
        @if (fresh().size) { <span class="notif-count">{{ fresh().size }} neu</span> }
      </header>
      <ul>
        @for (n of api.items(); track n.id) {
          <li [class.fresh]="fresh().has(n.id)" [attr.data-kind]="n.kind">
            <span class="toast-icon"><app-icon [name]="icon(n)" [size]="16" /></span>
            <div class="notif-text">
              <div class="toast-head"><strong>{{ n.title }}</strong><span class="toast-time">{{ ago(n.createdAt) }}</span></div>
              @if (n.body) { <p>{{ n.body }}</p> }
              @if (n.link) { <button type="button" class="link" (click)="go(n)">{{ n.actionLabel ?? 'Ansehen' }}</button> }
            </div>
          </li>
        } @empty {
          <li class="notif-empty hint">Keine Benachrichtigungen.</li>
        }
      </ul>
    </div>
  `,
})
export class Bell {
  protected api = inject(NotificationService);
  private router = inject(Router);
  private panel = viewChild.required<ElementRef<HTMLElement>>('panel');
  protected open = signal(false);
  protected pos = signal({ top: 0, left: 0 });
  /** beim Öffnen ungelesen – bleiben hervorgehoben, solange das Panel offen ist */
  protected fresh = signal(new Set<number>());

  protected icon = (n: AppNotification) => KIND_ICONS[n.kind] ?? 'info-circle';
  protected ago = (iso: string) => timeAgo(iso);

  toggle(event: MouseEvent) {
    const el = this.panel().nativeElement;
    if (this.open()) return el.hidePopover();
    const r = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const width = Math.min(352, innerWidth - 16);
    this.pos.set({ top: r.bottom + 10, left: Math.max(8, Math.min(r.right - width + 40, innerWidth - width - 8)) });
    el.showPopover();
  }

  protected onToggle(isOpen: boolean) {
    this.open.set(isOpen);
    if (isOpen) {
      // Öffnen = gelesen: Punkt und Toasts verschwinden, die Liste zeigt sie noch als neu
      this.fresh.set(new Set(this.api.unread().map((n) => n.id)));
      this.api.readAll();
    } else {
      this.fresh.set(new Set());
    }
  }

  go(n: AppNotification) {
    this.panel().nativeElement.hidePopover();
    if (n.link) this.router.navigateByUrl(n.link);
  }
}
