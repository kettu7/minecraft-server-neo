import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DecimalPipe, PercentPipe } from '@angular/common';
import { ItemIcon } from './items';
import { ProjectsService, ProjectSummary, errorMessage } from './projects.service';

@Component({
  selector: 'app-project-list',
  imports: [RouterLink, DecimalPipe, PercentPipe, ItemIcon],
  template: `
    <header class="page-head">
      <span class="eyebrow">Minecraft Server Neo</span>
      <h1>Bauprojekte</h1>
      <p class="hint">
        Blaupausen hochladen, Material im Lager sammeln und den Baufortschritt live verfolgen –
        alles direkt aus eurer Welt gespiegelt.
      </p>
    </header>

    <section>
      @if (loading()) {
        <p class="hint">Lade …</p>
      } @else if (!projects().length) {
        <p class="hint">Noch keine Projekte. Lade unten die erste Schematic hoch.</p>
      } @else {
        <ul class="projects">
          @for (p of projects(); track p.id) {
            <li>
              <a class="card project with-thumb" [routerLink]="['/projekte', p.id]">
                <div class="project-thumb">
                  @if (p.image) {
                    <img [src]="p.image + '&size=thumb'" alt="" loading="lazy" />
                  } @else {
                    <app-item-icon item="crafting_table" [size]="40" />
                  }
                </div>
                <div class="project-body">
                <div class="project-head">
                  <strong>{{ p.name }}</strong>
                  <span class="badge">{{ ratio(p.placed, p.required) | percent }}</span>
                </div>
                <p class="hint">
                  {{ p.sizeX }}×{{ p.sizeY }}×{{ p.sizeZ }} · {{ p.required | number }} Items
                  @if (p.description) { · {{ p.description }} }
                </p>
                <div class="mini-progress">
                  <span class="hint">Im Lager</span>
                  <div class="bar"><div [style.width.%]="ratio(p.covered, p.open) * 100"></div></div>
                  <span class="hint">{{ ratio(p.covered, p.open) | percent }}</span>
                  <span class="hint">Verbaut</span>
                  <div class="bar built"><div [style.width.%]="ratio(p.placed, p.required) * 100"></div></div>
                  <span class="hint">{{ ratio(p.placed, p.required) | percent }}</span>
                </div>
                </div>
              </a>
            </li>
          }
        </ul>
      }
    </section>

    <section class="card">
      <span class="eyebrow">Neu</span>
      <h2>Bauprojekt anlegen</h2>
      <p class="hint">
        Im Spiel mit Litematica speichern (<kbd>M</kbd> → Area Editor → Save Schematic) und die
        <code>.litematic</code>-Datei hier hochladen.
      </p>
      <form class="upload" (submit)="create($event, nameInput, descInput, fileInput)">
        <label>
          Name
          <input #nameInput type="text" placeholder="z. B. Starterhaus (sonst Name aus der Datei)" maxlength="80" />
        </label>
        <label>
          Beschreibung
          <input #descInput type="text" placeholder="optional, z. B. Koordinaten" maxlength="200" />
        </label>
        <label>
          Schematic
          <input #fileInput type="file" accept=".litematic" required />
        </label>
        <button type="submit" [disabled]="busy()">{{ busy() ? 'Wird gelesen …' : 'Materialliste erstellen' }}</button>
      </form>
      @if (error()) {
        <p class="error">{{ error() }}</p>
      }
    </section>
  `,
})
export class ProjectList {
  private api = inject(ProjectsService);
  private router = inject(Router);

  projects = signal<ProjectSummary[]>([]);
  loading = signal(true);
  busy = signal(false);
  error = signal('');

  constructor() {
    this.load();
  }

  async load() {
    try {
      this.projects.set(await this.api.list());
      this.error.set('');
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  ratio(part: number, total: number) {
    return total ? Math.min(1, part / total) : 1;
  }

  async create(event: Event, name: HTMLInputElement, desc: HTMLInputElement, file: HTMLInputElement) {
    event.preventDefault();
    const f = file.files?.[0];
    if (!f) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const project = await this.api.create(name.value, desc.value, f);
      this.router.navigate(['/projekte', project.id]);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
