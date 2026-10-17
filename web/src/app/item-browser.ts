import { Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { CreativeTab, CreativeTabs, ItemIcon, ItemLanguageSwitch, ItemLibrary } from './items';

@Component({
  selector: 'app-item-browser',
  imports: [ItemIcon, ItemLanguageSwitch, CreativeTabs, DecimalPipe],
  template: `
    <header class="page-head">
      <span class="eyebrow">Nachschlagewerk</span>
      <h1>Item-Bibliothek</h1>
      <p class="hint">Alle {{ library.items().length | number }} Items aus Minecraft.</p>
    </header>

    <section class="browser">

      @if (library.loaded() && !library.items().length) {
        <p class="warn">
          Die Bibliothek ist noch nicht erzeugt. Im Ordner <code>api</code> einmal <code>npm run items</code> ausführen.
        </p>
      } @else {
        <div class="toolbar">
          <div class="toolbar-group">
            <input type="search" placeholder="Name oder ID suchen …" (input)="query.set($any($event.target).value)" />
            <app-item-lang />
          </div>
          <span class="hint">{{ filtered().length | number }} Treffer</span>
        </div>
        <app-creative-tabs [counts]="counts()" [(value)]="tab" />

        <ul class="item-grid">
          @for (i of visible(); track i.id) {
            <li>
              <button class="item-tile" (click)="copy(i.id)" [title]="'minecraft:' + i.id">
                <app-item-icon [item]="i.id" [size]="48" />
                <span class="item-name">{{ library.name(i.id) }}</span>
                <span class="hint mono">{{ copied() === i.id ? 'kopiert' : i.id }}</span>
              </button>
            </li>
          }
        </ul>
        @if (filtered().length > visible().length) {
          <button class="secondary more" (click)="limit.set(limit() + 240)">Weitere anzeigen</button>
        }
      }
    </section>
  `,
})
export class ItemBrowser {
  protected library = inject(ItemLibrary);
  query = signal('');
  tab = signal<CreativeTab | 'all'>('all');
  limit = signal(240);
  copied = signal('');

  /** Treffer der Suche (vor dem Tab-Filter) – daraus die Zahlen an den Tabs */
  private matching = computed(() => {
    const q = this.query();
    return this.library.items().filter((i) => i.id !== 'air' && this.library.matches(i.id, q));
  });
  counts = computed(() => this.library.tabCounts(this.matching().map((i) => i.id)));

  /** Alphabetisch in der gewählten Sprache; Suche findet beide Sprachen */
  filtered = computed(() => {
    const lang = this.library.language();
    const tab = this.tab();
    return this.matching()
      .filter((i) => tab === 'all' || this.library.tab(i.id) === tab)
      .map((i) => ({ item: i, name: this.library.name(i.id) }))
      .sort((a, b) => a.name.localeCompare(b.name, lang))
      .map((x) => x.item);
  });
  visible = computed(() => this.filtered().slice(0, this.limit()));

  async copy(id: string) {
    try {
      await navigator.clipboard.writeText(`minecraft:${id}`);
      this.copied.set(id);
      setTimeout(() => this.copied() === id && this.copied.set(''), 1500);
    } catch {
      // Zwischenablage nicht verfügbar – ID steht ja sichtbar da
    }
  }
}
