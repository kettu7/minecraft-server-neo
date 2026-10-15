import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DecimalPipe } from '@angular/common';
import { StorageForm } from './storage-form';
import { StorageInput, StorageSummary, StoragesService, errorMessage, formatDate, reportErrors } from './projects.service';

@Component({
  selector: 'app-storage-list',
  imports: [RouterLink, DecimalPipe, StorageForm],
  template: `
    <header class="page-head">
      <span class="eyebrow">Gespiegelt aus der Welt</span>
      <h1>Lager</h1>
      <p class="hint">Kisten, Fässer und Shulker aus der Welt.</p>
    </header>

    <section>
      @if (loading()) {
        <p class="hint">Lade …</p>
      } @else if (!storages().length) {
        <p class="hint">Noch keine Lager angelegt – unten kannst du das erste anlegen.</p>
      } @else {
        <ul class="projects">
          @for (s of storages(); track s.id) {
            <li>
              <a class="card project" [routerLink]="['/lager', s.id]">
                <div class="project-head">
                  <strong>{{ s.name }}</strong>
                  <span class="badge">{{ s.containerCount }} Behälter</span>
                </div>
                <p class="hint mono">{{ s.x }} / {{ s.y }} / {{ s.z }} · r {{ s.radius }} · ±{{ s.height }}</p>
                <small class="hint">
                  {{ s.itemCount | number }} Items · {{ s.itemTypes }} Sorten
                  @if (s.scannedAt) { · {{ date(s.scannedAt) }} }
                </small>
                @if (s.lastError) {
                  <p class="error small">{{ s.lastError }}</p>
                }
              </a>
            </li>
          }
        </ul>
      }
    </section>

    <section class="card">
      <span class="eyebrow">Neu</span>
      <h2>Lager anlegen</h2>
      <p class="hint">
        Mittelpunkt und Radius festlegen. Koordinaten siehst du im Spiel mit <kbd>F3</kbd>.
      </p>
      <app-storage-form submitLabel="Anlegen & scannen" [busy]="busy()" (saved)="create($event)" />
      @if (error()) {
        <p class="error">{{ error() }}</p>
      }
    </section>
  `,
})
export class StorageList {
  private api = inject(StoragesService);
  private router = inject(Router);

  storages = signal<StorageSummary[]>([]);
  loading = signal(true);
  busy = signal(false);
  error = signal('');
  date = formatDate;

  constructor() {
    this.api.list()
      .then((s) => this.storages.set(s))
      .catch((err) => this.error.set(errorMessage(err)))
      .finally(() => this.loading.set(false));
  }

  async create(input: StorageInput) {
    this.busy.set(true);
    this.error.set('');
    try {
      const { storage, report } = await this.api.create(input);
      const problem = report.error ?? reportErrors(report);
      // Bei Scan-Fehler bleibt man hier und sieht die Meldung; das Lager ist trotzdem angelegt
      if (problem) {
        this.error.set(`Lager angelegt, aber Scan fehlgeschlagen: ${problem}`);
        this.storages.set(await this.api.list());
      } else {
        this.router.navigate(['/lager', storage.id]);
      }
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
