// Aktualisiert Lagerbestände und Baufortschritt – per Klick oder automatisch im Hintergrund.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { Rcon } from './rcon.ts';
import { readBlocks } from './litematic.ts';
import { checkProgress } from './progress.ts';
import { scanStorage } from './storage.ts';
import {
  SCHEMATIC_DIR, allStorageIds, getPlacement, getStorageArea, projectIdsWithPlacement,
  saveProgress, saveScan, saveScanError,
} from './db.ts';

export interface RefreshReport {
  trigger: 'auto' | 'manual';
  startedAt: string;
  ms: number;
  storages: Array<{ id: number; name: string; ms: number; containers?: number; error?: string }>;
  projects: Array<{ id: number; ms: number; placed?: number; error?: string }>;
  error?: string;
}

export const INTERVAL_MINUTES = Number(process.env.REFRESH_MINUTES ?? 5);

let chain: Promise<unknown> = Promise.resolve();
let running = false;
let lastReport: RefreshReport | undefined;

export function refreshStatus() {
  return { intervalMinutes: INTERVAL_MINUTES, running, lastRun: lastReport ?? null };
}

const message = (err: unknown) =>
  (err as NodeJS.ErrnoException).code === 'ECONNREFUSED'
    ? 'Minecraft-Server nicht erreichbar (läuft der Container, ist RCON auf Port 25575 freigegeben?).'
    : (err as Error).message;

/** Läufe werden nacheinander ausgeführt, nie parallel (eine RCON-Verbindung zur Zeit). */
export function refresh(scope: { storageIds: number[]; projectIds: number[] }, trigger: RefreshReport['trigger'], log: FastifyBaseLogger) {
  const run = chain.then(() => runRefresh(scope, trigger, log));
  chain = run.catch(() => undefined);
  return run;
}

async function runRefresh(scope: { storageIds: number[]; projectIds: number[] }, trigger: RefreshReport['trigger'], log: FastifyBaseLogger) {
  running = true;
  const start = Date.now();
  const report: RefreshReport = { trigger, startedAt: new Date(start).toISOString(), ms: 0, storages: [], projects: [] };
  const rcon = new Rcon();
  try {
    await rcon.connect();

    for (const id of scope.storageIds) {
      const area = getStorageArea(id);
      if (!area) continue;
      const t = Date.now();
      try {
        const result = await scanStorage(rcon, area);
        saveScan(id, result, Date.now() - t);
        report.storages.push({ id, name: area.name, ms: Date.now() - t, containers: result.containers.length });
      } catch (err) {
        saveScanError(id, message(err));
        report.storages.push({ id, name: area.name, ms: Date.now() - t, error: message(err) });
      }
    }

    for (const id of scope.projectIds) {
      const placement = getPlacement(id);
      if (!placement) continue;
      const t = Date.now();
      try {
        const blocks = await readBlocks(await readFile(join(SCHEMATIC_DIR, `${id}.litematic`)));
        const result = await checkProgress(rcon, blocks, placement);
        saveProgress(id, result);
        report.projects.push({ id, ms: Date.now() - t, placed: result.placed });
      } catch (err) {
        report.projects.push({ id, ms: Date.now() - t, error: message(err) });
      }
    }
  } catch (err) {
    report.error = message(err);
  } finally {
    rcon.close();
    running = false;
    report.ms = Date.now() - start;
    lastReport = report;
    log.info(report, 'Aktualisierung abgeschlossen');
  }
  return report;
}

export function startScheduler(log: FastifyBaseLogger) {
  if (!(INTERVAL_MINUTES > 0)) return;
  setInterval(() => {
    if (running) return; // Vorheriger Lauf dauert noch – diesen auslassen
    refresh({ storageIds: allStorageIds(), projectIds: projectIdsWithPlacement() }, 'auto', log).catch(() => undefined);
  }, INTERVAL_MINUTES * 60_000).unref();
  log.info(`Automatische Aktualisierung alle ${INTERVAL_MINUTES} Minuten`);
}
