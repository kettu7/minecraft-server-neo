// Discord-Login (OAuth2 Authorization Code), Sitzungs-Cookie und Zugriffsregeln für die API.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  MINECRAFT_NAME, ROLES, SESSION_DAYS, addBan, audit, countAdmins, getBan, isBanned, listBans, removeBan, createSession, deleteSession, deleteUser, getUser,
  listAudit, listUsers, minecraftNameTaken, purgeExpiredSessions, setMinecraftName, setRole, upsertDiscordUser,
  userForSession, type Role, type User,
} from './users.ts';
import { desiredWhitelistName, syncWhitelist } from './whitelist.ts';
import { banInGame, cleanReason, pardonInGame, serverBans } from './moderation.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

const DISCORD = 'https://discord.com/api/v10';
const SESSION_COOKIE = 'neo_session';
const STATE_COOKIE = 'neo_oauth_state';

const config = () => ({
  clientId: process.env.DISCORD_CLIENT_ID ?? '',
  clientSecret: process.env.DISCORD_CLIENT_SECRET ?? '',
  guildId: process.env.DISCORD_GUILD_ID ?? '',
  publicUrl: (process.env.PUBLIC_URL ?? 'http://localhost:4200').replace(/\/$/, ''),
});
const redirectUri = () => `${config().publicUrl}/api/auth/discord/callback`;
const secureCookies = () => config().publicUrl.startsWith('https://');

/** Routen, die ohne Anmeldung erreichbar sind */
const PUBLIC_ROUTES = ['/api/health', '/api/auth/'];
/** Routen, die auch wartende (noch nicht freigeschaltete) Benutzer nutzen dürfen */
const PENDING_ROUTES = ['/api/me', '/api/auth/'];

export function publicUser(u: User) {
  return {
    id: u.id,
    discordId: u.discordId,
    username: u.username,
    displayName: u.displayName,
    avatarUrl: u.avatar ? `https://cdn.discordapp.com/avatars/${u.discordId}/${u.avatar}.png?size=64` : null,
    role: u.role,
    isOwner: u.isOwner,
    minecraftName: u.minecraftName,
    whitelisted: u.whitelistedName !== null && u.whitelistedName === desiredWhitelistName(u.role, u.minecraftName),
    whitelistError: u.whitelistError,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  };
}

export function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (req.user?.role !== 'admin') {
    reply.code(403).send({ error: 'Nur für Admins.' });
    return false;
  }
  return true;
}

export async function registerAuth(app: FastifyInstance) {
  purgeExpiredSessions();

  // Zugriffsprüfung für die gesamte API
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    req.user = userForSession(req.cookies[SESSION_COOKIE]);
    if (PUBLIC_ROUTES.some((p) => req.url.startsWith(p))) return;
    if (!req.user) return reply.code(401).send({ error: 'Bitte anmelden.' });
    if (req.user.role === 'pending' && !PENDING_ROUTES.some((p) => req.url.startsWith(p))) {
      return reply.code(403).send({ error: 'Dein Konto wartet noch auf Freischaltung.' });
    }
  });

  /* ───────────── Discord-Login ───────────── */

  app.get('/api/auth/config', async () => ({ configured: !!(config().clientId && config().clientSecret) }));

  app.get('/api/auth/discord/login', async (_req, reply) => {
    const { clientId, clientSecret, guildId } = config();
    if (!clientId || !clientSecret) return reply.redirect('/login?fehler=nicht-eingerichtet');
    const state = randomBytes(24).toString('base64url');
    reply.setCookie(STATE_COOKIE, state, { path: '/api/auth', httpOnly: true, sameSite: 'lax', secure: secureCookies(), maxAge: 600 });
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri(),
      // identify: ID, Name, Avatar (keine E-Mail). guilds.members.read: nur Mitgliedschaft im eigenen Server prüfen
      scope: guildId ? 'identify guilds.members.read' : 'identify',
      state,
      prompt: 'none',
    });
    return reply.redirect(`https://discord.com/oauth2/authorize?${params}`);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/api/auth/discord/callback', async (req, reply) => {
    const fail = (reason: string) => reply.clearCookie(STATE_COOKIE, { path: '/api/auth' }).redirect(`/login?fehler=${reason}`);
    const { code, state, error } = req.query;
    if (error) return fail('abgebrochen');

    const expected = req.cookies[STATE_COOKIE] ?? '';
    if (!code || !state || state.length !== expected.length || !timingSafeEqual(Buffer.from(state), Buffer.from(expected))) {
      return fail('ungueltig');
    }

    try {
      const { clientId, clientSecret, guildId } = config();
      const tokenRes = await fetch(`${DISCORD}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code, redirect_uri: redirectUri(), client_id: clientId, client_secret: clientSecret,
        }),
      });
      if (!tokenRes.ok) {
        req.log.warn({ status: tokenRes.status, body: await tokenRes.text() }, 'Discord-Token abgelehnt');
        return fail('discord');
      }
      const { access_token: accessToken } = await tokenRes.json() as { access_token: string };
      const auth = { Authorization: `Bearer ${accessToken}` };

      const me = await (await fetch(`${DISCORD}/users/@me`, { headers: auth })).json() as
        { id: string; username: string; global_name?: string | null; avatar?: string | null };
      if (!me?.id) return fail('discord');

      if (guildId) {
        const member = await fetch(`${DISCORD}/users/@me/guilds/${guildId}/member`, { headers: auth });
        if (!member.ok) {
          req.log.info({ discordId: me.id }, 'Login abgelehnt: kein Mitglied des Discord-Servers');
          return fail('kein-mitglied');
        }
      }

      if (isBanned(me.id)) {
        req.log.info({ discordId: me.id }, 'Login abgelehnt: gebannt');
        return fail('gesperrt');
      }

      const user = upsertDiscordUser({ id: me.id, username: me.username, displayName: me.global_name || me.username, avatar: me.avatar ?? null });
      audit(user.id, 'angemeldet');
      reply.setCookie(SESSION_COOKIE, createSession(user.id), {
        path: '/', httpOnly: true, sameSite: 'lax', secure: secureCookies(), maxAge: SESSION_DAYS * 86400,
      });
      return reply.clearCookie(STATE_COOKIE, { path: '/api/auth' }).redirect(user.role === 'pending' ? '/warten' : '/');
    } catch (err) {
      req.log.error(err, 'Discord-Login fehlgeschlagen');
      return fail('discord');
    }
  });

  // Für nginx (auth_request): Darf diese Sitzung die Karte sehen? Nur freigeschaltete Mitglieder.
  app.get('/api/auth/check', async (req, reply) => {
    const ok = req.user?.role === 'player' || req.user?.role === 'admin';
    return reply.code(ok ? 204 : 401).send();
  });

  app.post('/api/auth/logout', async (req, reply) => {
    deleteSession(req.cookies[SESSION_COOKIE]);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ ok: true });
  });

  /* ───────────── Eigenes Profil ───────────── */

  app.get('/api/me', async (req) => publicUser(req.user!));

  app.put<{ Body: { minecraftName?: string | null } }>('/api/me', async (req, reply) => {
    const raw = req.body?.minecraftName?.trim() || null;
    if (raw && !MINECRAFT_NAME.test(raw)) return reply.code(400).send({ error: 'Minecraft-Namen haben 3–16 Zeichen: Buchstaben, Ziffern, Unterstrich.' });
    if (raw && minecraftNameTaken(raw, req.user!.id)) return reply.code(409).send({ error: 'Dieser Minecraft-Name gehört schon zu einem anderen Konto.' });
    setMinecraftName(req.user!.id, raw);
    audit(req.user!.id, 'minecraft-name', raw ?? '(entfernt)');
    await syncWhitelist(req.user!.id, req.user!.id);
    return publicUser(getUser(req.user!.id)!);
  });

  /* ───────────── Benutzerverwaltung (Admin) ───────────── */

  app.get('/api/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return listUsers().map(publicUser);
  });

  app.patch<{ Params: { id: string }; Body: { role?: Role } }>('/api/users/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const target = getUser(Number(req.params.id));
    if (!target) return reply.code(404).send({ error: 'Benutzer nicht gefunden.' });
    if (target.isOwner) return reply.code(403).send({ error: 'Die Rolle des Inhabers kann nicht geändert werden.' });
    const role = req.body?.role;
    if (!role || !ROLES.includes(role)) return reply.code(400).send({ error: 'Unbekannte Rolle.' });
    if (target.role === 'admin' && role !== 'admin' && countAdmins() <= 1) {
      return reply.code(409).send({ error: 'Es muss mindestens einen Admin geben.' });
    }
    setRole(target.id, role);
    audit(req.user!.id, 'rolle geändert', `${target.displayName}: ${target.role} → ${role}`);
    await syncWhitelist(target.id, req.user!.id);
    return publicUser(getUser(target.id)!);
  });

  app.delete<{ Params: { id: string } }>('/api/users/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const target = getUser(Number(req.params.id));
    if (!target) return reply.code(404).send({ error: 'Benutzer nicht gefunden.' });
    if (target.isOwner) return reply.code(403).send({ error: 'Der Inhaber kann nicht gelöscht werden.' });
    if (target.id === req.user!.id) return reply.code(409).send({ error: 'Du kannst dich nicht selbst löschen.' });
    // Vor dem Löschen von der Whitelist nehmen
    setRole(target.id, 'pending');
    await syncWhitelist(target.id, req.user!.id);
    deleteUser(target.id);
    audit(req.user!.id, 'benutzer gelöscht', target.displayName);
    return reply.code(204).send();
  });

  // Whitelist-Abgleich für einen Benutzer erneut versuchen (z. B. wenn der Server offline war)
  app.post<{ Params: { id: string } }>('/api/users/:id/whitelist-sync', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    if (!getUser(id)) return reply.code(404).send({ error: 'Benutzer nicht gefunden.' });
    await syncWhitelist(id, req.user!.id);
    return publicUser(getUser(id)!);
  });

  /* ───────────── Bans (Admin) ───────────── */

  // Bannt ein Konto dauerhaft: Discord-ID gesperrt, Konto entfernt, im Spiel gebannt und von der Whitelist genommen
  app.post<{ Params: { id: string }; Body: { reason?: string } }>('/api/users/:id/ban', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const target = getUser(Number(req.params.id));
    if (!target) return reply.code(404).send({ error: 'Benutzer nicht gefunden.' });
    if (target.isOwner) return reply.code(403).send({ error: 'Der Inhaber kann nicht gebannt werden.' });
    if (target.id === req.user!.id) return reply.code(409).send({ error: 'Du kannst dich nicht selbst bannen.' });

    const reason = cleanReason(req.body?.reason ?? '');
    addBan(target, reason, req.user!.displayName);
    setRole(target.id, 'pending');
    await syncWhitelist(target.id, req.user!.id);
    const gameError = target.minecraftName ? await banInGame(target.minecraftName, reason) : undefined;
    deleteUser(target.id); // beendet auch alle Sitzungen
    audit(req.user!.id, 'gebannt', `${target.displayName}${target.minecraftName ? ` (${target.minecraftName})` : ''}${reason ? `: ${reason}` : ''}`);
    return { ok: true, gameError: gameError ?? null };
  });

  // Website-Bans + Bans, die direkt im Spiel vergeben wurden
  app.get('/api/bans', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const bans = listBans();
    const known = new Set(bans.map((b) => b.minecraftName?.toLowerCase()).filter(Boolean));
    const inGame = await serverBans();
    return {
      bans: bans.map((b) => ({ ...b, inGame: !!b.minecraftName && inGame.some((s) => s.name.toLowerCase() === b.minecraftName!.toLowerCase()) })),
      gameOnly: inGame.filter((s) => !known.has(s.name.toLowerCase())),
    };
  });

  // Website-Ban aufheben (Discord-Konto darf sich wieder anmelden, im Spiel entbannt)
  app.delete<{ Params: { id: string } }>('/api/bans/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const ban = getBan(Number(req.params.id));
    if (!ban) return reply.code(404).send({ error: 'Ban nicht gefunden.' });
    const gameError = ban.minecraftName ? await pardonInGame(ban.minecraftName) : undefined;
    removeBan(ban.id);
    audit(req.user!.id, 'ban aufgehoben', `${ban.displayName}${ban.minecraftName ? ` (${ban.minecraftName})` : ''}`);
    return { ok: true, gameError: gameError ?? null };
  });

  // Ban aufheben, der nur im Spiel existiert
  app.post<{ Params: { name: string } }>('/api/bans/game/:name/pardon', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const name = req.params.name;
    if (!MINECRAFT_NAME.test(name)) return reply.code(400).send({ error: 'Ungültiger Name.' });
    const gameError = await pardonInGame(name);
    if (gameError) return reply.code(502).send({ error: gameError });
    audit(req.user!.id, 'ban aufgehoben (spiel)', name);
    return { ok: true };
  });

  app.get('/api/audit', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return listAudit();
  });
}
