import { Component, computed, inject, signal } from '@angular/core';
import { KeyValuePipe } from '@angular/common';
import { AuditEntry, AuthService, GameBan, Me, ROLE_LABELS, Role, WebsiteBan } from './auth';
import { errorMessage, formatDate } from './projects.service';
import { AdminNav } from './admin-nav';
import { Icon } from './icon';
import { ConsoleService, Operator } from './admin-console';

@Component({
  selector: 'app-admin',
  imports: [KeyValuePipe, AdminNav, Icon],
  template: `
    <app-admin-nav />

    @if (pendingCount()) {
      <p class="warn">{{ pendingCount() }} Konto/Konten warten auf Freischaltung.</p>
    }
    @if (error()) {
      <p class="error">{{ error() }}</p>
    }
    @if (notice()) {
      <p class="ok">{{ notice() }}</p>
    }

    <table class="materials users">
      <thead>
        <tr><th>Benutzer</th><th>Minecraft</th><th class="toggle-col" title="Operator-Rechte im Spiel">OP</th><th>Rolle</th><th>Letzter Login</th><th class="num">Aktionen</th></tr>
      </thead>
      <tbody>
        @for (u of users(); track u.id) {
          <tr [class.covered]="u.role === 'pending'">
            <td>
              <div class="item-cell">
                @if (u.avatarUrl) { <img class="avatar" [src]="u.avatarUrl" alt="" /> }
                @else { <span class="avatar">{{ u.displayName[0] }}</span> }
                <div><strong>{{ u.displayName }}</strong><div class="hint mono">&#64;{{ u.username }}</div></div>
              </div>
            </td>
            <td>
              @if (u.minecraftName) {
                <span class="mono">{{ u.minecraftName }}</span>
                @if (u.whitelistError) {
                  <div class="error small with-icon" [title]="u.whitelistError"><app-icon name="alert-triangle" [size]="14" />{{ u.whitelistError }}
                    <button class="link" (click)="retry(u)" [disabled]="busy()">erneut</button>
                  </div>
                } @else if (u.whitelisted) {
                  <div class="ok small with-icon"><app-icon name="check" [size]="14" />Whitelist</div>
                }
              } @else {
                <span class="hint">–</span>
              }
            </td>
            <td class="toggle-col">
              @if (u.minecraftName) {
                <label class="switch" [title]="isOp(u.minecraftName) ? 'OP-Rechte entziehen' : 'OP-Rechte vergeben'">
                  <input type="checkbox" [checked]="isOp(u.minecraftName)" [disabled]="busy() || opsUnavailable()"
                         [attr.aria-label]="'OP für ' + u.minecraftName" (change)="setOp(u.minecraftName!, $any($event.target).checked, $any($event.target))" />
                  <span></span>
                </label>
              } @else {
                <span class="hint" title="Kein Minecraft-Name im Profil">–</span>
              }
            </td>
            <td>
              @if (u.isOwner) {
                <span class="role with-icon" data-role="owner"><app-icon name="crown-filled" [size]="14" />Inhaber</span>
              } @else {
                <select [value]="u.role" (change)="setRole(u, $any($event.target).value)" [disabled]="busy()">
                  @for (r of roles | keyvalue: keep; track r.key) {
                    <option [value]="r.key" [selected]="u.role === r.key">{{ r.value }}</option>
                  }
                </select>
              }
            </td>
            <td class="hint">{{ u.lastLoginAt ? date(u.lastLoginAt) : '–' }}</td>
            <td class="num">
              @if (!u.isOwner && u.id !== auth.me()?.id) {
                <div class="row-actions">
                  <button class="secondary compact" (click)="remove(u)" [disabled]="busy()" title="Konto entfernen – Anmeldung danach wieder möglich">Löschen</button>
                  <button class="danger compact" (click)="ban(u)" [disabled]="busy()" title="Dauerhaft sperren – auch im Spiel">Bannen</button>
                </div>
              }
            </td>
          </tr>
        }
      </tbody>
    </table>

    <section class="card">
      <div class="project-head">
        <h3>Operatoren ohne Website-Konto</h3>
        <span class="hint">{{ otherOps().length }} Einträge</span>
      </div>
      <p class="hint small-text">OP-Rechte für Spieler, die kein Konto auf der Website haben. Für alle anderen in der Tabelle oben schalten.</p>
      @if (otherOps().length) {
        <ul class="ban-list">
          @for (o of otherOps(); track o.name) {
            <li>
              <div><strong class="mono">{{ o.name }}</strong><div class="hint">Level {{ o.level }}</div></div>
              <button class="secondary compact" (click)="setOp(o.name, false)" [disabled]="busy()">Entziehen</button>
            </li>
          }
        </ul>
      }
      <form class="chat-form" (submit)="addOp($event, opName)">
        <input #opName type="text" maxlength="16" placeholder="Minecraft-Name" aria-label="Minecraft-Name für OP-Rechte" autocomplete="off" />
        <button type="submit" [disabled]="busy() || opsUnavailable()">OP vergeben</button>
      </form>
    </section>

    <section class="card">
      <div class="project-head">
        <h3>Bannliste</h3>
        <span class="hint">{{ bans().length + gameOnly().length }} Einträge</span>
      </div>
      @if (!bans().length && !gameOnly().length) {
        <p class="hint">Niemand ist gebannt.</p>
      } @else {
        <ul class="ban-list">
          @for (b of bans(); track b.id) {
            <li>
              <div>
                <strong>{{ b.displayName }}</strong>
                @if (b.minecraftName) { <span class="sep" aria-hidden="true"></span><span class="mono">{{ b.minecraftName }}</span> }
                <div class="hint">
                  Website{{ b.inGame ? ' + Spiel' : '' }}<span class="sep" aria-hidden="true"></span>{{ date(b.createdAt) }}@if (b.bannedBy) { <span class="sep" aria-hidden="true"></span>von {{ b.bannedBy }} }
                  @if (b.reason) { <span class="sep" aria-hidden="true"></span>„{{ b.reason }}“ }
                </div>
              </div>
              <button class="secondary compact" (click)="unban(b)" [disabled]="busy()">Aufheben</button>
            </li>
          }
          @for (g of gameOnly(); track g.name) {
            <li>
              <div>
                <strong class="mono">{{ g.name }}</strong>
                <div class="hint">nur im Spiel<span class="sep" aria-hidden="true"></span>{{ g.source }}@if (g.reason) { <span class="sep" aria-hidden="true"></span>„{{ g.reason }}“ }</div>
              </div>
              <button class="secondary compact" (click)="pardon(g)" [disabled]="busy()">Aufheben</button>
            </li>
          }
        </ul>
      }
    </section>

    <details class="card" (toggle)="loadAudit()">
      <summary>Protokoll</summary>
      <ul class="audit">
        @for (a of audit(); track a.id) {
          <li>
            <span class="hint mono">{{ date(a.createdAt) }}</span>
            <strong>{{ a.user ?? 'System' }}</strong>
            <span>{{ a.action }}</span>
            @if (a.detail) { <span class="hint">{{ a.detail }}</span> }
          </li>
        } @empty {
          <li class="hint">Noch keine Einträge.</li>
        }
      </ul>
    </details>
  `,
})
export class Admin {
  protected auth = inject(AuthService);
  protected roles = ROLE_LABELS;
  protected keep = () => 0;
  protected date = formatDate;

  protected users = signal<Me[]>([]);
  private server = inject(ConsoleService);
  protected ops = signal<Operator[]>([]);
  /** Server nicht erreichbar → OP-Schalter gesperrt */
  protected opsUnavailable = signal(false);
  protected isOp = (name: string | null) => !!name && this.ops().some((o) => o.name.toLowerCase() === name.toLowerCase());
  protected otherOps = computed(() => {
    const known = new Set(this.users().map((u) => u.minecraftName?.toLowerCase()).filter(Boolean));
    return this.ops().filter((o) => !known.has(o.name.toLowerCase()));
  });
  protected bans = signal<WebsiteBan[]>([]);
  protected gameOnly = signal<GameBan[]>([]);
  protected audit = signal<AuditEntry[]>([]);
  protected busy = signal(false);
  protected error = signal('');
  protected notice = signal('');
  protected pendingCount = computed(() => this.users().filter((u) => u.role === 'pending').length);

  constructor() {
    this.load();
  }

  private async load() {
    try {
      const [users, bans] = await Promise.all([this.auth.users(), this.auth.bans()]);
      this.users.set(users);
      this.bans.set(bans.bans);
      this.gameOnly.set(bans.gameOnly);
    } catch (err) {
      this.error.set(errorMessage(err));
    }
    try {
      this.ops.set((await this.server.ops()).ops);
      this.opsUnavailable.set(false);
    } catch {
      this.opsUnavailable.set(true);
    }
  }

  setOp(name: string, op: boolean, el?: HTMLInputElement) {
    const verb = op ? 'vergeben' : 'entzogen';
    if (!op && !confirm(`${name} die OP-Rechte entziehen?`)) {
      if (el) el.checked = true;
      return;
    }
    if (op && !confirm(`${name} OP-Rechte geben? Damit sind im Spiel alle Befehle erlaubt (z. B. /gamemode, /give, /stop).`)) {
      if (el) el.checked = false;
      return;
    }
    this.run(async () => {
      try {
        this.ops.set((await this.server.setOp(name, op)).ops);
      } catch (err) {
        if (el) el.checked = !op;
        throw err;
      }
      return `OP-Rechte für ${name} ${verb}.`;
    });
  }

  addOp(event: Event, input: HTMLInputElement) {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    this.setOp(name, true);
    input.value = '';
  }

  async loadAudit() {
    this.audit.set(await this.auth.audit().catch(() => []));
  }

  setRole(u: Me, role: Role) {
    this.run(async () => {
      await this.auth.setRole(u.id, role);
      if (u.id === this.auth.me()?.id) await this.auth.load();
    });
  }

  retry(u: Me) {
    this.run(() => this.auth.syncWhitelist(u.id));
  }

  remove(u: Me) {
    if (!confirm(`Konto von „${u.displayName}“ löschen?\n\nDer Minecraft-Name wird von der Whitelist entfernt. Die Person kann sich danach neu anmelden und wartet wieder auf Freischaltung.`)) return;
    this.run(async () => {
      await this.auth.deleteUser(u.id);
      return `${u.displayName} wurde gelöscht.`;
    });
  }

  ban(u: Me) {
    const reason = prompt(`„${u.displayName}“ dauerhaft bannen?\n\nDas Konto wird entfernt, die Discord-Anmeldung gesperrt${u.minecraftName ? ` und ${u.minecraftName} im Spiel gebannt` : ''}.\n\nGrund (optional):`, '');
    if (reason === null) return;
    this.run(async () => {
      const { gameError } = await this.auth.ban(u.id, reason);
      return gameError ? `${u.displayName} gebannt – im Spiel fehlgeschlagen: ${gameError}` : `${u.displayName} wurde gebannt.`;
    });
  }

  unban(b: WebsiteBan) {
    if (!confirm(`Ban von „${b.displayName}“ aufheben? Die Person kann sich danach wieder anmelden${b.minecraftName ? ` und ${b.minecraftName} wird im Spiel entbannt` : ''}.`)) return;
    this.run(async () => {
      const { gameError } = await this.auth.unban(b.id);
      return gameError ? `Ban aufgehoben – im Spiel fehlgeschlagen: ${gameError}` : `Ban von ${b.displayName} aufgehoben.`;
    });
  }

  pardon(g: GameBan) {
    if (!confirm(`Ban von „${g.name}“ im Spiel aufheben?`)) return;
    this.run(async () => {
      await this.auth.pardonGame(g.name);
      return `${g.name} ist im Spiel entbannt.`;
    });
  }

  private async run(action: () => Promise<unknown>) {
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      const message = await action();
      if (typeof message === 'string') this.notice.set(message);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      await this.load();
      this.busy.set(false);
    }
  }
}
