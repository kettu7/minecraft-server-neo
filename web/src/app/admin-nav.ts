import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

/** Gemeinsamer Kopf und Unternavigation aller Admin-Seiten */
@Component({
  selector: 'app-admin-nav',
  imports: [RouterLink, RouterLinkActive],
  template: `
    <header class="page-head">
      <span class="eyebrow">Verwaltung</span>
      <h1>Admin Panel</h1>
      <p class="hint">Nutzer, Rollen und Mods.</p>
    </header>
    <div class="subnav-row">
      <nav class="subnav">
        <a routerLink="/admin" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Server</a>
        <a routerLink="/admin/benutzer" routerLinkActive="active">Benutzer</a>
        <a routerLink="/admin/mods" routerLinkActive="active">Servermods</a>
        <a routerLink="/admin/modpack" routerLinkActive="active">Clientmods</a>
      </nav>
      <!-- Seitenaktionen (z. B. Neu starten / Server stoppen) in derselben Zeile wie das Menü -->
      <ng-content select="[navActions]" />
    </div>
  `,
  styles: `:host { display: contents; }`,
})
export class AdminNav {}
