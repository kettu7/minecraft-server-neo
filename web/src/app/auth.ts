import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, firstValueFrom, throwError } from 'rxjs';

export type Role = 'pending' | 'player' | 'admin';

export const ROLE_LABELS: Record<Role, string> = {
  pending: 'Wartend',
  player: 'Spieler',
  admin: 'Admin',
};

export interface Me {
  id: number;
  discordId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  role: Role;
  /** Inhaber: geschützt vor Herabstufen, Löschen und Bannen */
  isOwner: boolean;
  minecraftName: string | null;
  whitelisted: boolean;
  whitelistError: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface WebsiteBan {
  id: number;
  discordId: string;
  displayName: string;
  minecraftName: string | null;
  reason: string;
  bannedBy: string | null;
  createdAt: string;
  /** Spielername ist auch im Spiel gebannt */
  inGame: boolean;
}

export interface GameBan {
  name: string;
  reason: string;
  source: string;
  created: string;
}

export interface AuditEntry {
  id: number;
  action: string;
  detail: string;
  createdAt: string;
  user: string | null;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  /** undefined = noch nicht geladen, null = nicht angemeldet */
  readonly me = signal<Me | null | undefined>(undefined);
  readonly isAdmin = computed(() => this.me()?.role === 'admin');
  readonly isMember = computed(() => this.me()?.role === 'player' || this.me()?.role === 'admin');

  async load(): Promise<Me | null> {
    try {
      this.me.set(await firstValueFrom(this.http.get<Me>('/api/me')));
    } catch {
      this.me.set(null);
    }
    return this.me()!;
  }

  async logout() {
    await firstValueFrom(this.http.post('/api/auth/logout', {})).catch(() => undefined);
    this.me.set(null);
  }

  async setMinecraftName(minecraftName: string | null) {
    this.me.set(await firstValueFrom(this.http.put<Me>('/api/me', { minecraftName })));
  }

  loginConfigured() {
    return firstValueFrom(this.http.get<{ configured: boolean }>('/api/auth/config'));
  }

  /* Admin */
  users() {
    return firstValueFrom(this.http.get<Me[]>('/api/users'));
  }

  setRole(id: number, role: Role) {
    return firstValueFrom(this.http.patch<Me>(`/api/users/${id}`, { role }));
  }

  syncWhitelist(id: number) {
    return firstValueFrom(this.http.post<Me>(`/api/users/${id}/whitelist-sync`, {}));
  }

  deleteUser(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/users/${id}`));
  }

  ban(id: number, reason: string) {
    return firstValueFrom(this.http.post<{ ok: true; gameError: string | null }>(`/api/users/${id}/ban`, { reason }));
  }

  bans() {
    return firstValueFrom(this.http.get<{ bans: WebsiteBan[]; gameOnly: GameBan[] }>('/api/bans'));
  }

  unban(id: number) {
    return firstValueFrom(this.http.delete<{ ok: true; gameError: string | null }>(`/api/bans/${id}`));
  }

  pardonGame(name: string) {
    return firstValueFrom(this.http.post<{ ok: true }>(`/api/bans/game/${encodeURIComponent(name)}/pardon`, {}));
  }

  audit() {
    return firstValueFrom(this.http.get<AuditEntry[]>('/api/audit'));
  }
}

/** Abgelaufene Sitzung: zur Anmeldung schicken */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const router = inject(Router);
  const auth = inject(AuthService);
  return next(req).pipe(
    catchError((err: HttpErrorResponse) => {
      if (err.status === 401 && !req.url.endsWith('/api/me')) {
        auth.me.set(null);
        router.navigate(['/login']);
      }
      return throwError(() => err);
    }),
  );
};

async function current() {
  const auth = inject(AuthService);
  return auth.me() === undefined ? auth.load() : auth.me()!;
}

/** Nur freigeschaltete Mitglieder (Spieler, Admin) */
export const memberGuard: CanActivateFn = async () => {
  const router = inject(Router);
  const me = await current();
  if (!me) return router.parseUrl('/login');
  if (me.role === 'pending') return router.parseUrl('/warten');
  return true;
};

export const adminGuard: CanActivateFn = async () => {
  const router = inject(Router);
  const me = await current();
  if (!me) return router.parseUrl('/login');
  return me.role === 'admin' ? true : router.parseUrl('/');
};

/** Angemeldet, egal welche Rolle (Profil, Warteseite) */
export const loggedInGuard: CanActivateFn = async () => {
  const router = inject(Router);
  return (await current()) ? true : router.parseUrl('/login');
};

/** Login-Seite nur für Abgemeldete */
export const guestGuard: CanActivateFn = async () => {
  const router = inject(Router);
  const me = await current();
  if (!me) return true;
  return router.parseUrl(me.role === 'pending' ? '/warten' : '/');
};
