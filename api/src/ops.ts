// OP-Verwaltung: wer im Spiel Operator-Rechte hat. Liste aus ops.json, Änderungen über RCON (/op, /deop).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from './auth.ts';
import { audit, MINECRAFT_NAME } from './users.ts';
import { rcon, wait } from './server-admin.ts';

const MC_DATA_DIR = process.env.MC_DATA_DIR ?? '';

export interface Operator { name: string; level: number }

export async function readOps(): Promise<Operator[]> {
  if (!MC_DATA_DIR) return [];
  const raw = await readFile(join(MC_DATA_DIR, 'ops.json'), 'utf8').catch(() => '[]');
  try {
    return (JSON.parse(raw) as Array<{ name: string; level?: number }>)
      .filter((o) => typeof o.name === 'string')
      .map((o) => ({ name: o.name, level: o.level ?? 4 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Antwort von /op bzw. /deop: geklappt, schon so, oder Fehler */
export function opResult(answer: string): 'ok' | 'unchanged' | 'error' {
  if (/^Made .* a server operator|^Made .* no longer a server operator/i.test(answer.trim())) return 'ok';
  if (/Nothing changed/i.test(answer)) return 'unchanged';
  return 'error';
}

export async function registerOps(app: FastifyInstance) {
  app.get('/api/server/ops', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { ops: await readOps() };
  });

  app.post<{ Body: { name?: string; op?: boolean } }>('/api/server/ops', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const name = req.body?.name ?? '';
    const op = req.body?.op === true;
    if (!MINECRAFT_NAME.test(name)) return reply.code(400).send({ error: 'Ungültiger Spielername.' });
    let answer: string;
    try {
      [answer] = await rcon(`${op ? 'op' : 'deop'} ${name}`);
    } catch (err) {
      return reply.code(502).send({ error: `Server nicht erreichbar: ${(err as Error).message}` });
    }
    if (opResult(answer) === 'error') return reply.code(400).send({ error: answer || 'Nicht geändert.' });
    audit(req.user!.id, op ? 'op vergeben' : 'op entzogen', name);
    await wait(0.3); // ops.json wird direkt danach geschrieben
    return { ops: await readOps() };
  });
}
