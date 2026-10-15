import { Component, computed, inject, input, signal } from '@angular/core';
import { AuthService } from './auth';

const ERRORS: Record<string, string> = {
  gesperrt: 'Dieses Discord-Konto ist gesperrt.',
  'kein-mitglied': 'Zugang nur für Mitglieder unseres Discord-Servers.',
  abgebrochen: 'Die Anmeldung wurde in Discord abgebrochen.',
  ungueltig: 'Die Anmeldung ist abgelaufen oder ungültig. Bitte noch einmal versuchen.',
  discord: 'Discord hat die Anmeldung abgelehnt. Bitte später erneut versuchen.',
  'nicht-eingerichtet': 'Der Discord-Login ist noch nicht eingerichtet (Client-Secret fehlt in der .env).',
};

@Component({
  selector: 'app-login',
  template: `
    <section class="login card">
      <span class="eyebrow">Minecraft Server Neo</span>
      <h1>Willkommen!</h1>
      <p class="hint">
        Melde dich mit deinem Discord-Konto an. Wir erhalten nur deinen Discord-Namen und dein Profilbild –
        keine E-Mail und kein Passwort.
      </p>

      @if (message()) {
        <p class="error">{{ message() }}</p>
      }
      @if (configured() === false) {
        <p class="warn">{{ errors['nicht-eingerichtet'] }}</p>
      }

      <a class="discord-button" href="/api/auth/discord/login" [class.disabled]="configured() === false">
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.6 1.3a18.3 18.3 0 0 0-5.6 0L8.6 3a19.7 19.7 0 0 0-4.9 1.5C.5 9.1-.3 13.7.1 18.2a19.9 19.9 0 0 0 6 3l1.3-2.1c-.7-.3-1.4-.6-2-1l.5-.4a14.2 14.2 0 0 0 12.2 0l.5.4c-.6.4-1.3.7-2 1l1.3 2.1a19.8 19.8 0 0 0 6-3c.5-5.2-.8-9.8-3.6-13.8ZM8 15.4c-1.2 0-2.2-1.1-2.2-2.4S6.8 10.6 8 10.6s2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z" />
        </svg>
        Mit Discord anmelden
      </a>

      <p class="hint small">
        Neue Konten werden von einem Admin freigeschaltet.
      </p>
    </section>
  `,
})
export class Login {
  private auth = inject(AuthService);
  /** ?fehler=… aus der Weiterleitung nach dem Login */
  fehler = input<string>();
  protected errors = ERRORS;
  protected message = computed(() => (this.fehler() ? ERRORS[this.fehler()!] ?? 'Anmeldung fehlgeschlagen.' : ''));
  protected configured = signal<boolean | undefined>(undefined);

  constructor() {
    this.auth.loginConfigured().then((c) => this.configured.set(c.configured)).catch(() => undefined);
  }
}
