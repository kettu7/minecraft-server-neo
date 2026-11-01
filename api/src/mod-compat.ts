// Verträglichkeit vor dem Übernehmen: Jede Fabric-Mod nennt in ihrer fabric.mod.json, welche Versionen
// anderer Mods sie braucht ("depends") oder nicht verträgt ("breaks"). Modrinth kennt diese Bereiche nicht –
// deshalb liest die API die Datei aus der Mod selbst (einmal je Version, danach gemerkt) und prüft den
// geplanten Stand, bevor der Server neu startet. Beispiel: Seamless Crafting 2.1.1 verlangt Fabric API 0.161.x.
import AdmZip from 'adm-zip';
import { getState, setState } from './mod-manager.ts';
import { downloadFile, primaryFile, versionsById } from './modrinth.ts';

type Predicate = string | string[];

export interface FabricMeta {
  /** die Mod selbst und alle mitgelieferten (z. B. die Module der Fabric API) */
  mods: Array<{ id: string; version: string; provides: string[] }>;
  depends: Record<string, Predicate>;
  breaks: Record<string, Predicate>;
  /** client = läuft auf dem Server gar nicht */
  environment: string;
}

/* ───────────────────────── Versionen (Fabric-Regeln) ───────────────────────── */

interface Version { nums: number[]; pre: string[] | null }

/** „0.165.0+26.3“ → [0, 165, 0]; Build-Angaben hinter „+“ zählen nicht. null = keine Versionsnummer im üblichen Format */
export function parseVersion(text: string): Version | null {
  const [core, ...pre] = text.trim().split('+')[0].split('-');
  if (!/^\d+(\.\d+)*$/.test(core)) return null;
  return { nums: core.split('.').map(Number), pre: pre.length ? pre.join('-').split('.') : null };
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
    const d = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  // Vorabversionen (1.0.0-beta) liegen vor der fertigen Version
  if (!a.pre || !b.pre) return a.pre ? -1 : b.pre ? 1 : 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return Math.sign(Number(x) - Number(y));
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Eine Bedingung wie „>=0.161.0“, „~1.2“, „^3.0.0“, „0.161.x“, „*“. null = nicht auswertbar */
function term(version: string, t: string): boolean | null {
  if (!t || t === '*') return true;
  const [, op = '', value] = /^(>=|<=|>|<|=|~|\^)?(.*)$/.exec(t)!;
  // Platzhalter: 0.161.x – die Teile davor müssen gleich sein
  if (!op && /(^|\.)[xX*](\.|$)/.test(value)) {
    const fixed = value.split('.').slice(0, value.split('.').findIndex((p) => /^[xX*]$/.test(p)));
    const v = parseVersion(version);
    return v && fixed.every((p) => /^\d+$/.test(p)) ? fixed.every((p, i) => (v.nums[i] ?? 0) === Number(p)) : null;
  }
  const v = parseVersion(version), w = parseVersion(value);
  if (!v || !w) return op === '' || op === '=' ? version === value : null;
  const c = compareVersions(v, w);
  switch (op) {
    case '>=': return c >= 0;
    case '<=': return c <= 0;
    case '>': return c > 0;
    case '<': return c < 0;
    // ~1.2.3: gleiche Haupt- und Nebenversion, ^1.2.3: gleiche Hauptversion – jeweils ab 1.2.3
    case '~': return c >= 0 && v.nums[0] === w.nums[0] && (v.nums[1] ?? 0) === (w.nums[1] ?? 0);
    case '^': return c >= 0 && v.nums[0] === w.nums[0];
    default: return c === 0;
  }
}

/** Erfüllt version die Bedingung? Mehrere Einträge (Liste) = einer reicht; Leerzeichen = alle müssen passen */
export function satisfies(version: string, predicate: Predicate): boolean | null {
  const alternatives = (Array.isArray(predicate) ? predicate : [predicate]).map((p) => {
    const results = p.trim().split(/\s+/).map((t) => term(version, t));
    if (results.includes(false)) return false;
    return results.includes(null) ? null : true;
  });
  if (alternatives.includes(true)) return true;
  return alternatives.includes(null) ? null : false;
}

/** Lesbar: [">=0.161.0 <0.162.0"] → „>=0.161.0 <0.162.0“ */
const pretty = (p: Predicate) => (Array.isArray(p) ? p.join(' oder ') : p);

/* ───────────────────────── fabric.mod.json lesen ───────────────────────── */

export function readFabricMeta(jar: Buffer): FabricMeta | null {
  const zip = new AdmZip(jar);
  const entry = zip.getEntry('fabric.mod.json');
  if (!entry) return null;
  // Manche Mods schreiben Steuerzeichen (Tabs, Zeilenumbrüche) in Texte – JSON erlaubt das nicht
  const json = JSON.parse(entry.getData().toString('utf8').replace(/[\u0000-\u001f]+/g, ' ')) as {
    id: string; version: string; provides?: string[]; depends?: Record<string, Predicate>; breaks?: Record<string, Predicate>;
    environment?: string; jars?: Array<{ file: string }>;
  };
  const mods = [{ id: json.id, version: json.version, provides: json.provides ?? [] }];
  for (const nested of json.jars ?? []) {
    const data = zip.getEntry(nested.file)?.getData();
    const inner = data ? safeMeta(data) : null;
    if (inner) mods.push(...inner.mods);
  }
  return { mods, depends: json.depends ?? {}, breaks: json.breaks ?? {}, environment: json.environment ?? '*' };
}

function safeMeta(jar: Buffer) {
  try {
    return readFabricMeta(jar);
  } catch {
    return null;
  }
}

const loading = new Set<string>();

/** Je Modrinth-Version einmal herunterladen und lesen, danach aus dem Speicher (download = false: nur Gemerktes) */
async function metaFor(versionIds: string[], download: boolean): Promise<Map<string, FabricMeta | null>> {
  const result = new Map<string, FabricMeta | null>();
  const missing: string[] = [];
  for (const id of versionIds) {
    const known = getState<{ meta: FabricMeta | null }>(`fabric_meta|${id}`);
    if (known) result.set(id, known.meta);
    else missing.push(id);
  }
  if (!missing.length) return result;
  if (!download) {
    // Im Hintergrund nachladen (jede Version nur einmal gleichzeitig); die nächste Abfrage kennt sie dann
    const fresh = missing.filter((id) => !loading.has(id));
    fresh.forEach((id) => loading.add(id));
    if (fresh.length) void metaFor(fresh, true).catch(() => undefined).finally(() => fresh.forEach((id) => loading.delete(id)));
    return result;
  }
  for (const v of await versionsById(missing)) {
    const file = primaryFile(v);
    if (!file) continue;
    const meta = safeMeta(await downloadFile(file.url));
    setState(`fabric_meta|${v.id}`, { meta });
    result.set(v.id, meta);
  }
  return result;
}

/* ───────────────────────── Prüfen ───────────────────────── */

const NAMES: Record<string, string> = { minecraft: 'Minecraft', fabricloader: 'Fabric Loader', 'fabric-api': 'Fabric API' };

/**
 * Prüft die Mods untereinander und gegen Minecraft/Fabric Loader. Liefert verständliche Probleme.
 * Fehlende Mods meldet missingDependencies (Modrinth); hier geht es um falsche Versionen.
 */
export function findConflicts(
  mods: Array<{ title: string; meta: FabricMeta | null }>,
  env: { minecraft: string | null; loader: string | null },
): string[] {
  const provided = new Map<string, { version: string; title: string }>();
  if (env.minecraft) provided.set('minecraft', { version: env.minecraft, title: 'Minecraft' });
  if (env.loader) provided.set('fabricloader', { version: env.loader, title: 'Fabric Loader' });
  for (const m of mods) {
    for (const [i, inner] of (m.meta?.mods ?? []).entries()) {
      // Mitgelieferte Module heißen wie die Mod, die sie mitbringt (Fabric API statt fabric-api-base)
      const title = i === 0 ? m.title : NAMES[inner.id] ?? inner.id;
      for (const id of [inner.id, ...inner.provides]) if (!provided.has(id)) provided.set(id, { version: inner.version, title });
    }
  }

  const problems: string[] = [];
  for (const m of mods) {
    if (!m.meta || m.meta.environment === 'client') continue;
    for (const [id, predicate] of Object.entries(m.meta.depends)) {
      const dep = provided.get(id);
      if (!dep || satisfies(dep.version, predicate) !== false) continue;
      problems.push(`${m.title} braucht ${dep.title} ${pretty(predicate)}, geplant ist ${dep.version}.`);
    }
    for (const [id, predicate] of Object.entries(m.meta.breaks)) {
      const dep = provided.get(id);
      if (dep && satisfies(dep.version, predicate) === true) {
        problems.push(`${m.title} verträgt sich nicht mit ${dep.title} ${dep.version}.`);
      }
    }
  }
  return problems;
}

/**
 * Geplanten Stand prüfen. Ist Modrinth nicht erreichbar, wird nicht blockiert (wie bisher).
 * download = false (Übersicht): nur bereits gelesene Mods prüfen, fehlende im Hintergrund holen –
 * der erste Download aller Mods dauert sonst ein paar Sekunden.
 */
export async function checkCompatibility(
  mods: Array<{ title: string; versionId: string; enabled: boolean }>,
  env: { minecraft: string | null; loader: string | null },
  download = true,
): Promise<string[]> {
  const active = mods.filter((m) => m.enabled);
  const metas = await metaFor(active.map((m) => m.versionId), download).catch(() => new Map<string, FabricMeta | null>());
  return findConflicts(active.map((m) => ({ title: m.title, meta: metas.get(m.versionId) ?? null })), env);
}
