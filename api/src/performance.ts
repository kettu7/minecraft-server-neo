// Leistungsanzeige: alle 15 s eine Messung (Tick-Zeit über „/tick query“, CPU und RAM vom Steuerdienst, Spieler).
// Verlauf der letzten 2 Stunden nur im Arbeitsspeicher – nach einem Neustart der API beginnt er neu.
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from './auth.ts';
import { control, parsePlayerList, rcon } from './server-admin.ts';

const SAMPLE_MS = 15_000;
const KEEP = (2 * 60 * 60 * 1000) / SAMPLE_MS;

export interface Sample {
  t: string;
  /** Ticks pro Sekunde (max. Ziel-Tickrate, meist 20) */
  tps: number | null;
  /** durchschnittliche Zeit pro Tick in ms */
  mspt: number | null;
  /** 95 % der Ticks waren schneller als dieser Wert */
  p95: number | null;
  /** CPU-Auslastung in % der ganzen Maschine */
  cpu: number | null;
  /** belegter Arbeitsspeicher in Bytes */
  memory: number | null;
  players: number | null;
  /** normal, eingefroren, beschleunigt – oder null, wenn der Server nicht antwortet */
  state: 'normal' | 'frozen' | 'sprinting' | 'stepping' | null;
}

/** Antwort von „/tick query“ auslesen */
export function parseTickQuery(answer: string) {
  const text = answer.replace(/§[0-9a-fk-orx]|\u001b\[[0-9;]*m/gi, '');
  const num = (re: RegExp) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  const target = num(/Target tick rate: ([\d.]+)/i) ?? 20;
  const mspt = num(/Average time per tick: ([\d.]+)\s*ms/i);
  const state = /frozen/i.test(text) ? 'frozen' : /sprint/i.test(text) ? 'sprinting' : /step/i.test(text) ? 'stepping' : 'normal';
  return {
    target,
    mspt,
    p95: num(/P95: ([\d.]+)\s*ms/i),
    // Ein Tick darf 1000/target ms dauern; braucht er länger, sinkt die Tickrate
    tps: mspt === null ? null : Math.round(Math.min(target, 1000 / Math.max(mspt, 0.001)) * 10) / 10,
    state: state as Sample['state'],
  };
}

/** CPU-% aus zwei Zählerständen (Docker-Statistik); null, wenn nicht berechenbar */
export function cpuPercent(prev: { total: number; system: number } | null, next: { total: number; system: number; cpus: number } | null) {
  if (!prev || !next) return null;
  const busy = next.total - prev.total;
  const all = next.system - prev.system;
  if (busy < 0 || all <= 0) return null;
  // system_cpu_usage zählt alle Kerne zusammen → Anteil an der ganzen Maschine
  return Math.round((busy / all) * 100 * 10) / 10;
}

const samples: Sample[] = [];
let lastCpu: { total: number; system: number } | null = null;
let cpus = 1;
let memoryLimit: number | null = null;

async function sample() {
  const status = (await control('GET', '/status', 10_000).catch(() => null)) as
    | { running: boolean; memory: { usage: number; limit: number } | null; cpu: { total: number; system: number; cpus: number } | null }
    | null;
  const running = !!status?.running;
  const [tick, list] = running ? await rcon('tick query', 'list').catch(() => [null, null]) : [null, null];
  const t = tick ? parseTickQuery(tick) : null;
  const cpu = running ? cpuPercent(lastCpu, status?.cpu ?? null) : null;
  lastCpu = status?.cpu ?? null;
  if (status?.cpu) cpus = status.cpu.cpus;
  if (status?.memory) memoryLimit = status.memory.limit;
  samples.push({
    t: new Date().toISOString(),
    tps: t?.tps ?? null,
    mspt: t?.mspt ?? null,
    p95: t?.p95 ?? null,
    cpu,
    memory: running ? status?.memory?.usage ?? null : null,
    players: list ? parsePlayerList(list).online : null,
    state: t?.state ?? null,
  });
  if (samples.length > KEEP) samples.splice(0, samples.length - KEEP);
}

export async function registerPerformance(app: FastifyInstance) {
  app.get('/api/server/performance', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { intervalSeconds: SAMPLE_MS / 1000, cpus, memoryLimit, samples };
  });

  if (process.env.CONTROL_URL) {
    sample().catch(() => undefined);
    setInterval(() => sample().catch(() => undefined), SAMPLE_MS).unref();
  }
}
