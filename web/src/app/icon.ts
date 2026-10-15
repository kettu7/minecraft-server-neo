import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { ICONS, type IconName } from './icons.generated';

/** Flaches Icon (Tabler). Farbe = Textfarbe, Größe in px. Dekorativ, außer es gibt ein label. */
@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'icon',
    '[attr.role]': "label() ? 'img' : null",
    '[attr.aria-label]': 'label() || null',
    '[attr.aria-hidden]': "label() ? null : 'true'",
  },
  template: `
    <svg viewBox="0 0 24 24" [attr.width]="size()" [attr.height]="size()"
         [attr.fill]="icon().filled ? 'currentColor' : 'none'" [attr.stroke]="icon().filled ? 'none' : 'currentColor'"
         [attr.stroke-width]="stroke()" stroke-linecap="round" stroke-linejoin="round" [innerHTML]="svg()"></svg>
  `,
})
export class Icon {
  private sanitizer = inject(DomSanitizer);
  name = input.required<IconName>();
  size = input(16);
  stroke = input(2);
  label = input('');

  protected icon = computed(() => ICONS[this.name()]);
  // Inhalt stammt aus der mitgelieferten Icon-Datei, nicht aus Nutzereingaben
  protected svg = computed(() => this.sanitizer.bypassSecurityTrustHtml(this.icon().body));
}
