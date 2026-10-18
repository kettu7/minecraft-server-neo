// Neue Welt erzeugen: aktuelle Welt als angepinntes Backup „Welt archiviert“ sichern, ankündigen,
// dann über den Steuerdienst Welt löschen, Seed setzen und neu starten. Danach gilt der neue Weltname.
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from './auth.ts';
import { audit } from './users.ts';
import { backupStatus, createBackup } from './backup.ts';
import { setState } from './mod-manager.ts';
import { control, rcon, tellraw, wait, WARNING_SECONDS } from './server-admin.ts';
import { cleanWorldName, currentWorldName, setWorldName } from './world-name.ts';

/** Seed: Zahl oder Wort, wie im Spiel; nur unkritische Zeichen (landet in server.properties) */
export const SEED = /^[\p{L}\p{N} _.\-]{0,64}$/u;

let running = false;

export async function registerNewWorld(app: FastifyInstance) {
  app.get('/api/server/world', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { name: currentWorldName(), running };
  });

  // Aktuelle Welt umbenennen (nur der Name auf der Website und in künftigen Backups)
  app.post<{ Body: { name?: string } }>('/api/server/world/name', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const name = cleanWorldName(req.body?.name);
    if (!name) return reply.code(400).send({ error: 'Bitte einen Namen eingeben.' });
    const before = currentWorldName();
    setWorldName(name);
    audit(req.user!.id, 'welt umbenannt', `${before} → ${name}`);
    return { name };
  });

  app.post<{ Body: { name?: string; seed?: string } }>('/api/server/new-world', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const name = cleanWorldName(req.body?.name);
    const seed = (req.body?.seed ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'Bitte einen Namen für die neue Welt eingeben.' });
    if (!SEED.test(seed)) return reply.code(400).send({ error: 'Seed: höchstens 64 Zeichen, nur Buchstaben, Ziffern, Leerzeichen, - _ .' });
    if (running) return reply.code(409).send({ error: 'Es wird bereits eine neue Welt erzeugt.' });

    running = true;
    const old = currentWorldName();
    try {
      // 1. Archiv der alten Welt – angepinnt, damit es nie automatisch gelöscht wird
      while (backupStatus().running) await wait(2);
      let archive;
      try {
        archive = await createBackup('archive', req.user!.displayName, req.log, { pinned: true });
      } catch (err) {
        return reply.code(502).send({ error: `Archiv-Backup fehlgeschlagen, nichts geändert: ${(err as Error).message}` });
      }

      // 2. Ankündigen, dann Welt ersetzen
      await rcon(tellraw(`In ${WARNING_SECONDS} Sekunden wird eine neue Welt erzeugt. Die aktuelle Welt ist gesichert.`)).catch(() => undefined);
      await wait(WARNING_SECONDS);
      try {
        await control('POST', `/new-world${seed ? `?id=${encodeURIComponent(seed)}` : ''}`, 300_000);
      } catch (err) {
        audit(req.user!.id, 'neue welt fehlgeschlagen', (err as Error).message);
        return reply.code(502).send({ error: `Neue Welt fehlgeschlagen: ${(err as Error).message}. Archiv: ${archive.id}` });
      }

      // 3. Neuer Name; Ranglisten-Nullpunkt gehört zur alten Welt
      setWorldName(name);
      setState('ranking_baseline', null);
      audit(req.user!.id, 'neue welt erzeugt', `${old} → ${name}${seed ? ` (Seed ${seed})` : ''}, Archiv ${archive.id}`);
      return { name, archive: archive.id };
    } finally {
      running = false;
    }
  });
}
