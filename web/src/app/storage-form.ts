import { Component, computed, input, output, signal } from '@angular/core';
import { DecimalPipe, KeyValuePipe } from '@angular/common';
import { DIMENSION_LABELS, Dimension, StorageInput } from './projects.service';

const MAX_POSITIONS = 20_000;

@Component({
  selector: 'app-storage-form',
  imports: [DecimalPipe, KeyValuePipe],
  template: `
    <form class="storage-form" (submit)="submit($event, form)" (input)="recalc(form)" #form>
      <label class="wide">Name <input name="name" type="text" required maxlength="60" placeholder="z. B. Hauptlager" [value]="initial()?.name ?? ''" /></label>
      <label>X (Mitte) <input name="x" type="number" step="1" required [value]="initial()?.x ?? ''" /></label>
      <label>Y (Mitte) <input name="y" type="number" step="1" required [value]="initial()?.y ?? ''" /></label>
      <label>Z (Mitte) <input name="z" type="number" step="1" required [value]="initial()?.z ?? ''" /></label>
      <label>Radius (X/Z) <input name="radius" type="number" min="0" max="32" step="1" required [value]="initial()?.radius ?? 8" /></label>
      <label>Höhe (± Y) <input name="height" type="number" min="0" max="16" step="1" required [value]="initial()?.height ?? 3" /></label>
      <label>Dimension
        <select name="dimension">
          @for (o of dimensions | keyvalue: keep; track o.key) {
            <option [value]="o.key" [selected]="(initial()?.dimension ?? 'minecraft:overworld') === o.key">{{ o.value }}</option>
          }
        </select>
      </label>
      <label class="wide switch-row">
        <span class="switch">
          <input name="includeShulkers" type="checkbox" [checked]="initial()?.includeShulkers ?? true" />
          <span></span>
        </span>
        <span class="switch-text">
          <strong>Shulkerkisten einrechnen</strong>
          <span class="hint">Abgestellt und in Kisten. Aus, z. B. für ein privates Shulker-Lager.</span>
        </span>
      </label>
      <div class="wide actions">
        <span class="scan-estimate" [class.error]="positions() > max">
          <strong>{{ positions() | number }}</strong> Positionen · Scan ca. {{ seconds() }} s
          @if (positions() > max) { – zu groß (max. {{ max | number }}) }
        </span>
        <button type="submit" [disabled]="busy() || positions() > max">{{ busy() ? 'Scanne …' : submitLabel() }}</button>
      </div>
    </form>
  `,
})
export class StorageForm {
  initial = input<StorageInput | null>(null);
  submitLabel = input('Speichern');
  busy = input(false);
  saved = output<StorageInput>();

  readonly dimensions = DIMENSION_LABELS;
  readonly max = MAX_POSITIONS;
  keep = () => 0;

  private size = signal({ radius: 8, height: 3 });
  positions = computed(() => (2 * this.size().radius + 1) ** 2 * (2 * this.size().height + 1));
  /** Gemessen: etwa 1 ms pro Position */
  seconds = computed(() => Math.max(1, Math.round(this.positions() / 1000)));

  ngOnInit() {
    const i = this.initial();
    if (i) this.size.set({ radius: i.radius, height: i.height });
  }

  recalc(form: HTMLFormElement) {
    const d = new FormData(form);
    this.size.set({ radius: Number(d.get('radius')) || 0, height: Number(d.get('height')) || 0 });
  }

  submit(event: Event, form: HTMLFormElement) {
    event.preventDefault();
    const d = new FormData(form);
    this.saved.emit({
      name: String(d.get('name')),
      x: Number(d.get('x')), y: Number(d.get('y')), z: Number(d.get('z')),
      radius: Number(d.get('radius')), height: Number(d.get('height')),
      dimension: d.get('dimension') as Dimension,
      includeShulkers: d.get('includeShulkers') === 'on',
    });
  }
}
