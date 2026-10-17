import { Component, Injectable, computed, inject, input, model, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';

export interface LibraryItem {
  id: string;
  /** Englischer Name (wie im Spiel) */
  name: string;
  /** Übersetzungen, z. B. { de: 'Truhe' } */
  names?: Record<string, string>;
  /** false: kein Bild verfügbar (z. B. Banner, Köpfe) → Platzhalter */
  icon: boolean;
  /** flat = Textur, block = gerendert, special = Kiste/Shulker */
  kind: string;
}

/** Tabs wie im Creative-Inventar (Zuordnung: /creative-tabs.json, erzeugt mit `npm run items`) */
export const CREATIVE_TABS = [
  { key: 'building', label: 'Baublöcke', icon: 'bricks' },
  { key: 'colored', label: 'Farbige Blöcke', icon: 'cyan_wool' },
  { key: 'natural', label: 'Natur', icon: 'grass_block' },
  { key: 'functional', label: 'Funktional', icon: 'crafting_table' },
  { key: 'redstone', label: 'Redstone', icon: 'redstone' },
  { key: 'tools', label: 'Werkzeuge', icon: 'diamond_pickaxe' },
  { key: 'combat', label: 'Kampf', icon: 'golden_sword' },
  { key: 'food', label: 'Essen & Tränke', icon: 'golden_apple' },
  { key: 'ingredients', label: 'Zutaten', icon: 'iron_ingot' },
  { key: 'spawn_eggs', label: 'Spawn-Eier', icon: 'pig_spawn_egg' },
] as const;
export type CreativeTab = (typeof CREATIVE_TABS)[number]['key'];

export const ITEM_LANGUAGES = { de: 'DE', en: 'EN' } as const;
export type ItemLanguage = keyof typeof ITEM_LANGUAGES;
const LANG_KEY = 'neo.itemLanguage';

/**
 * Item-Bibliothek aus /items/items.json (erzeugt mit `npm run items` in api/).
 * Fehlt sie, funktionieren Seiten weiter – nur ohne Bilder.
 * Die Sprache der Item-Namen ist unabhängig von der Seite umschaltbar und wird im Browser gemerkt.
 */
@Injectable({ providedIn: 'root' })
export class ItemLibrary {
  private http = inject(HttpClient);
  readonly items = signal<LibraryItem[]>([]);
  readonly loaded = signal(false);
  readonly languages = signal<ItemLanguage[]>(['en']);
  readonly language = signal<ItemLanguage>(readLanguage());
  readonly byId = computed(() => new Map(this.items().map((i) => [i.id, i])));
  private tabs = signal(new Map<string, CreativeTab>());
  /** true, sobald die Creative-Zuordnung da ist (sonst werden keine Tabs angezeigt) */
  readonly hasTabs = computed(() => this.tabs().size > 0);

  constructor() {
    this.http.get<{ items: LibraryItem[]; languages?: ItemLanguage[] }>('/items/items.json').subscribe({
      next: (lib) => {
        this.items.set(lib.items);
        this.languages.set(lib.languages ?? ['en']);
        this.loaded.set(true);
      },
      error: () => this.loaded.set(true),
    });
    this.http.get<Record<CreativeTab, string[]>>('/creative-tabs.json').subscribe({
      next: (groups) => this.tabs.set(new Map(Object.entries(groups).flatMap(([tab, ids]) => ids.map((id) => [id, tab as CreativeTab])))),
      error: () => undefined,
    });
  }

  /** Creative-Tab eines Items; unbekannte (z. B. Mod-Items) landen bei den Baublöcken */
  tab(id: string): CreativeTab {
    return this.tabs().get(id.replace(/^minecraft:/, '')) ?? 'building';
  }

  /** Anzahl je Tab für eine Liste von Item-IDs */
  tabCounts(ids: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const id of ids) counts[this.tab(id)] = (counts[this.tab(id)] ?? 0) + 1;
    return counts;
  }

  setLanguage(lang: ItemLanguage) {
    this.language.set(lang);
    try { localStorage.setItem(LANG_KEY, lang); } catch { /* ohne Speicher eben nur für diese Sitzung */ }
  }

  /** Name in der gewählten Sprache (Signal-abhängig: Vorlagen aktualisieren sich beim Umschalten) */
  name(id: string): string {
    const item = this.byId().get(id);
    if (!item) return prettify(id);
    const lang = this.language();
    return (lang !== 'en' && item.names?.[lang]) || item.name;
  }

  /** Suche trifft ID, englischen und übersetzten Namen – unabhängig von der gewählten Sprache */
  matches(id: string, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const item = this.byId().get(id);
    const haystack = [id, item?.name, ...Object.values(item?.names ?? {})].filter(Boolean).join('\n').toLowerCase();
    return haystack.includes(q) || id.includes(q.replace(/ /g, '_').replace(/^minecraft:/, ''));
  }

  hasIcon(id: string): boolean {
    return this.byId().get(id)?.icon ?? false;
  }
}

function readLanguage(): ItemLanguage {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved && saved in ITEM_LANGUAGES) return saved as ItemLanguage;
  } catch { /* Speicher nicht verfügbar */ }
  return 'de';
}

/** Kleiner Umschalter DE | EN für Item-Namen – sitzt neben Suchfeldern und Filtern */
@Component({
  selector: 'app-item-lang',
  template: `
    @if (library.languages().length > 1) {
      <div class="lang-switch" role="group" aria-label="Sprache der Item-Namen" title="Sprache der Item-Namen">
        @for (l of library.languages(); track l) {
          <button type="button" [class.active]="library.language() === l" [attr.aria-pressed]="library.language() === l"
                  (click)="library.setLanguage(l)">{{ labels[l] }}</button>
        }
      </div>
    }
  `,
})
export class ItemLanguageSwitch {
  protected library = inject(ItemLibrary);
  protected labels = ITEM_LANGUAGES;
}

export function prettify(id: string): string {
  return id.replace(/^minecraft:/, '').split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

@Component({
  selector: 'app-item-icon',
  template: `
    @if (showImage()) {
      <img [src]="'/items/' + item() + '.png'" [alt]="''" [width]="size()" [height]="size()" loading="lazy"
           (error)="failed.set(true)" />
    } @else {
      <span class="item-placeholder" [style.width.px]="size()" [style.height.px]="size()">{{ initial() }}</span>
    }
  `,
  host: { class: 'item-icon', '[title]': 'library.name(item())' },
})
export class ItemIcon {
  protected library = inject(ItemLibrary);
  item = input.required<string>();
  size = input(32);
  protected failed = signal(false);

  protected showImage = computed(() => !this.failed() && this.library.hasIcon(this.item()));
  protected initial = computed(() => this.library.name(this.item())[0] ?? '?');
}

/** Tab-Leiste wie im Creative-Inventar: Item-Bild + Name + Anzahl; Tabs ohne Treffer werden ausgeblendet */
@Component({
  selector: 'app-creative-tabs',
  imports: [ItemIcon],
  template: `
    @if (library.hasTabs()) {
      <div class="creative-tabs" role="tablist" aria-label="Kategorien">
        <button type="button" role="tab" [class.active]="value() === 'all'" [attr.aria-selected]="value() === 'all'" (click)="value.set('all')">
          <app-item-icon item="chest" [size]="22" />Alle<span class="seg-count">{{ total() }}</span>
        </button>
        @for (t of visibleTabs(); track t.key) {
          <button type="button" role="tab" [class.active]="value() === t.key" [attr.aria-selected]="value() === t.key" (click)="value.set(t.key)">
            <app-item-icon [item]="t.icon" [size]="22" />{{ t.label }}<span class="seg-count">{{ counts()[t.key] }}</span>
          </button>
        }
      </div>
    }
  `,
})
export class CreativeTabs {
  protected library = inject(ItemLibrary);
  /** Anzahl je Tab (aus ItemLibrary.tabCounts) */
  counts = input.required<Record<string, number>>();
  value = model<CreativeTab | 'all'>('all');
  protected visibleTabs = computed(() => CREATIVE_TABS.filter((t) => (this.counts()[t.key] ?? 0) > 0));
  protected total = computed(() => Object.values(this.counts()).reduce((a, n) => a + n, 0));
}
