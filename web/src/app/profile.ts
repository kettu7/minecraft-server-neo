import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService, ROLE_LABELS } from './auth';
import { errorMessage } from './projects.service';
import { Icon } from './icon';

/**
 * Eigenes Profil: Minecraft-Name für die Whitelist.
 * Auch die Warteseite für noch nicht freigeschaltete Konten (Route /warten).
 */
@Component({
  selector: 'app-profile',
  imports: [Icon],
  template: `
    @if (auth.me(); as me) {
      <header class="page-head">
        <span class="eyebrow">{{ pending() ? 'Fast geschafft' : 'Dein Konto' }}</span>
        <h1>{{ pending() ? 'Warte auf Freischaltung' : 'Profil' }}</h1>
        @if (pending()) {
          <p class="hint">Ein Admin schaltet dich frei. Trag schon mal deinen Minecraft-Namen ein.</p>
        }
      </header>

      <section class="card profile">
        <div class="profile-head">
          @if (me.avatarUrl) {
            <img class="avatar big" [src]="me.avatarUrl" alt="" />
          } @else {
            <span class="avatar big">{{ me.displayName[0] }}</span>
          }
          <div>
            <strong>{{ me.displayName }}</strong>
            <span class="hint">&#64;{{ me.username }} · <span class="role with-icon" [attr.data-role]="me.isOwner ? 'owner' : me.role">@if (me.isOwner) { <app-icon name="crown-filled" [size]="14" />Inhaber } @else { {{ roles[me.role] }} }</span></span>
          </div>
        </div>

        <form class="mc-form" (submit)="save($event, name)">
          <label>
            Minecraft-Name
            <input #name type="text" maxlength="16" placeholder="z. B. Steve" [value]="me.minecraftName ?? ''" />
          </label>
          <button type="submit" [disabled]="busy()">{{ busy() ? 'Speichere …' : 'Speichern' }}</button>
        </form>

        @if (error()) {
          <p class="error">{{ error() }}</p>
        } @else if (me.whitelistError) {
          <p class="error">Whitelist: {{ me.whitelistError }}</p>
        } @else if (me.whitelisted) {
          <p class="ok with-icon"><app-icon name="circle-check" [size]="16" />{{ me.minecraftName }} steht auf der Whitelist.</p>
        } @else if (me.minecraftName && pending()) {
          <p class="hint">Wird nach der Freischaltung auf die Whitelist gesetzt.</p>
        }
      </section>

      <button class="secondary logout" (click)="logout()">Abmelden</button>
    }
  `,
})
export class Profile {
  protected auth = inject(AuthService);
  private router = inject(Router);
  protected roles = ROLE_LABELS;
  protected busy = signal(false);
  protected error = signal('');
  protected pending = computed(() => this.auth.me()?.role === 'pending');

  async save(event: Event, input: HTMLInputElement) {
    event.preventDefault();
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.setMinecraftName(input.value.trim() || null);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  async logout() {
    await this.auth.logout();
    this.router.navigate(['/login']);
  }
}
