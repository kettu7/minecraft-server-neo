// Baut die Item-Bibliothek aus dem Minecraft-Client (.jar): ein Bild pro Item + items.json.
//
// Aufruf:  npm run items            (Jar aus ../.cache, Ausgabe nach ../web/public/items)
//          node scripts/build-items.ts <client.jar> <ausgabe-ordner>
//
// Flache Items (Äpfel, Werkzeuge …) werden aus ihrer Textur übernommen, Blöcke wie im Inventar
// isometrisch gerendert (eigener kleiner Software-Renderer, keine nativen Abhängigkeiten).
// Die Bilder sind Mojang-Assets: nur lokal erzeugen, nicht ins Repo/öffentlich verteilen.
import Zip from 'adm-zip';
import { creativeTab } from './creative-tabs.ts';
import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SIZE = 64; // Ausgabegröße in Pixeln
const SS = 2; // Supersampling für glatte Kanten bei Blöcken

/* ───────────────────────── Eingabe ───────────────────────── */

const cacheDir = join(import.meta.dirname, '..', '..', '.cache');
const jarPath = process.argv[2]
  ?? join(cacheDir, readdirSync(cacheDir).filter((f) => /^minecraft-client-.*\.jar$/.test(f)).sort().at(-1) ?? 'fehlt.jar');
const outDir = process.argv[3] ?? join(import.meta.dirname, '..', '..', 'web', 'public', 'items');

const zip = new Zip(jarPath);
const ASSETS = 'assets/minecraft/';

type Json = any; // Minecraft-JSON ist sehr variabel; hier bewusst locker typisiert

function readJson(path: string): Json | undefined {
  const entry = zip.getEntry(ASSETS + path);
  return entry ? JSON.parse(entry.getData().toString('utf8')) : undefined;
}

/** "minecraft:block/stone" / "block/stone" → "block/stone" */
const resourcePath = (ref: string) => ref.replace(/^minecraft:/, '');

interface Texture { w: number; h: number; data: Buffer }
const textureCache = new Map<string, Texture | null>();

function readTexture(ref: string): Texture | null {
  const path = `textures/${resourcePath(ref)}.png`;
  if (!textureCache.has(path)) {
    const entry = zip.getEntry(ASSETS + path);
    if (!entry) textureCache.set(path, null);
    else {
      const png = PNG.sync.read(entry.getData());
      // Animierte Texturen sind senkrechte Streifen: nur das erste Bild verwenden
      const h = png.height > png.width && png.height % png.width === 0 ? png.width : png.height;
      textureCache.set(path, { w: png.width, h, data: png.data.subarray(0, png.width * h * 4) });
    }
  }
  return textureCache.get(path)!;
}

/* ───────────────────────── Modelle ───────────────────────── */

type Rgb = [number, number, number];

interface Face { texture: string; uv?: number[]; rotation?: number; tintindex?: number }
interface Element { from: number[]; to: number[]; faces: Record<string, Face> }

interface ResolvedModel {
  textures: Record<string, string>;
  elements?: Element[];
  gui?: { rotation?: number[]; translation?: number[]; scale?: number[] };
  kind: 'generated' | 'elements' | 'entity' | 'none';
}

function loadModel(ref: string): ResolvedModel {
  const textures: Record<string, string> = {};
  let elements: Element[] | undefined;
  let gui: ResolvedModel['gui'];
  let kind: ResolvedModel['kind'] = 'none';

  for (let current: string | undefined = ref, depth = 0; current && depth < 20; depth++) {
    const path = resourcePath(current);
    if (path === 'builtin/generated') { kind = 'generated'; break; }
    if (path === 'builtin/entity') { kind = 'entity'; break; }
    const model = readJson(`models/${path}.json`);
    if (!model) break;
    for (const [k, v] of Object.entries(model.textures ?? {})) {
      // Neuere Modelle: Texturen auch als Objekt {"sprite": "...", ...}
      const ref = typeof v === 'string' ? v : (v as Json)?.sprite;
      if (!(k in textures) && typeof ref === 'string') textures[k] = ref;
    }
    elements ??= model.elements;
    gui ??= model.display?.gui;
    current = model.parent;
  }
  if (kind === 'none' && elements) kind = 'elements';
  return { textures, elements, gui, kind };
}

/** "#side" über die Textur-Variablen auflösen */
function resolveTexture(textures: Record<string, string>, input: unknown): string | undefined {
  let ref = input && typeof input === 'object' ? (input as Json).sprite : input;
  if (typeof ref !== 'string') return undefined;
  for (let i = 0; ref.startsWith('#') && i < 10; i++) {
    const next: string | undefined = textures[ref.slice(1)];
    if (next === undefined) return undefined;
    ref = next;
  }
  return ref.startsWith('#') ? undefined : ref;
}

/* ───────────────────────── Item-Definitionen ───────────────────────── */

interface ItemModel { model?: string; tints: Rgb[]; special?: Json; base?: string }

function argbToRgb(v: number): Rgb {
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function tintColor(t: Json): Rgb {
  if (t.type === 'minecraft:constant') return argbToRgb(t.value);
  if (t.type === 'minecraft:grass') return [0x91, 0xbd, 0x59]; // Gras bei Temperatur 0.5 / Niederschlag 1.0
  if (typeof t.default === 'number') return argbToRgb(t.default);
  return [255, 255, 255];
}

/** Wählt aus verschachtelten Definitionen (select, condition …) die Standard-Variante. */
function resolveDefinition(node: Json): ItemModel | undefined {
  if (!node) return undefined;
  switch (node.type) {
    case 'minecraft:model':
      return { model: node.model, tints: (node.tints ?? []).map(tintColor) };
    case 'minecraft:special':
      return { special: node.model, base: node.base, tints: [] };
    case 'minecraft:condition':
      return resolveDefinition(node.on_false);
    case 'minecraft:select':
      return resolveDefinition(node.fallback ?? node.cases?.[0]?.model);
    case 'minecraft:range_dispatch':
      return resolveDefinition(node.fallback ?? node.entries?.[0]?.model);
    case 'minecraft:composite':
      return resolveDefinition(node.models?.[0]);
    case 'minecraft:bundle/selected_item':
      return { model: 'minecraft:item/bundle', tints: [] };
    default:
      return undefined;
  }
}

/* ───────────────────────── Rendering ───────────────────────── */

class Canvas {
  readonly size: number;
  readonly data: Buffer;
  readonly depth: Float32Array;
  constructor(size: number) {
    this.size = size;
    this.data = Buffer.alloc(size * size * 4);
    this.depth = new Float32Array(size * size).fill(-Infinity);
  }

  blend(x: number, y: number, z: number, [r, g, b, a]: number[]) {
    const i = y * this.size + x;
    if (z < this.depth[i]) return;
    const o = i * 4;
    if (a >= 250) {
      this.data.set([r, g, b, 255], o);
      this.depth[i] = z;
    } else {
      // halbtransparent (Glas, Eis): über das Vorhandene legen
      const k = a / 255;
      this.data[o] = r * k + this.data[o] * (1 - k);
      this.data[o + 1] = g * k + this.data[o + 1] * (1 - k);
      this.data[o + 2] = b * k + this.data[o + 2] * (1 - k);
      this.data[o + 3] = Math.max(this.data[o + 3], a);
    }
  }

  /** Verkleinert per Box-Filter (Supersampling). */
  downsample(factor: number): Buffer {
    const n = this.size / factor;
    const out = Buffer.alloc(n * n * 4);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let dy = 0; dy < factor; dy++)
          for (let dx = 0; dx < factor; dx++) {
            const o = ((y * factor + dy) * this.size + x * factor + dx) * 4;
            const al = this.data[o + 3];
            r += this.data[o] * al; g += this.data[o + 1] * al; b += this.data[o + 2] * al; a += al;
          }
        const o = (y * n + x) * 4;
        if (a) out.set([r / a, g / a, b / a, a / (factor * factor)], o);
      }
    return out;
  }
}

function sample(tex: Texture, u: number, v: number): number[] {
  const x = Math.min(tex.w - 1, Math.max(0, Math.floor((u / 16) * tex.w)));
  const y = Math.min(tex.h - 1, Math.max(0, Math.floor((v / 16) * tex.h)));
  const o = (y * tex.w + x) * 4;
  return [tex.data[o], tex.data[o + 1], tex.data[o + 2], tex.data[o + 3]];
}

type Vec3 = [number, number, number];

/** Ecken einer Fläche (oben-links, oben-rechts, unten-rechts, unten-links von außen gesehen) */
function faceCorners(dir: string, [x1, y1, z1]: number[], [x2, y2, z2]: number[]): Vec3[] {
  switch (dir) {
    case 'north': return [[x2, y2, z1], [x1, y2, z1], [x1, y1, z1], [x2, y1, z1]];
    case 'south': return [[x1, y2, z2], [x2, y2, z2], [x2, y1, z2], [x1, y1, z2]];
    case 'west': return [[x1, y2, z1], [x1, y2, z2], [x1, y1, z2], [x1, y1, z1]];
    case 'east': return [[x2, y2, z2], [x2, y2, z1], [x2, y1, z1], [x2, y1, z2]];
    case 'up': return [[x1, y2, z1], [x2, y2, z1], [x2, y2, z2], [x1, y2, z2]];
    default: return [[x1, y1, z2], [x2, y1, z2], [x2, y1, z1], [x1, y1, z1]]; // down
  }
}

/** Standard-UV wie in Minecraft (FaceBakery), wenn die Fläche keine eigene angibt */
function defaultUv(dir: string, [x1, y1, z1]: number[], [x2, y2, z2]: number[]): number[] {
  switch (dir) {
    case 'north': return [16 - x2, 16 - y2, 16 - x1, 16 - y1];
    case 'south': return [x1, 16 - y2, x2, 16 - y1];
    case 'west': return [z1, 16 - y2, z2, 16 - y1];
    case 'east': return [16 - z2, 16 - y2, 16 - z1, 16 - y1];
    case 'up': return [x1, z1, x2, z2];
    default: return [x1, 16 - z2, x2, 16 - z1];
  }
}

/** Helligkeit je Richtung, wie die Inventar-Beleuchtung von Blöcken */
const SHADE: Record<string, number> = { up: 1, down: 0.5, north: 0.8, south: 0.8, east: 0.6, west: 0.6 };

function rotation(deg: number[] = [30, 225, 0]) {
  const [ax, ay, az] = deg.map((d) => (d * Math.PI) / 180);
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay), Math.cos(az), Math.sin(az)];
  // wie Minecraft: erst Z, dann Y, dann X
  return ([x, y, z]: Vec3): Vec3 => {
    [x, y] = [x * cz - y * sz, x * sz + y * cz];
    [x, z] = [x * cy + z * sy, -x * sy + z * cy];
    [y, z] = [y * cx - z * sx, y * sx + z * cx];
    return [x, y, z];
  };
}

function renderElements(model: ResolvedModel, tints: Rgb[]): Buffer | undefined {
  const n = SIZE * SS;
  const canvas = new Canvas(n);
  const rotate = rotation(model.gui?.rotation);
  const scale = (model.gui?.scale?.[0] ?? 0.625) * (n / 16);
  const [tx, ty] = model.gui?.translation ?? [0, 0, 0];
  let drawn = false;

  const project = (p: Vec3): Vec3 => {
    const [x, y, z] = rotate([p[0] - 8, p[1] - 8, p[2] - 8]);
    return [n / 2 + (x + tx) * scale, n / 2 - (y + ty) * scale, z];
  };

  for (const el of model.elements ?? []) {
    for (const [dir, face] of Object.entries(el.faces ?? {})) {
      const texRef = resolveTexture(model.textures, face.texture);
      const tex = texRef && readTexture(texRef);
      if (!tex) continue;
      const [u1, v1, u2, v2] = face.uv ?? defaultUv(dir, el.from, el.to);
      let uvs: number[][] = [[u1, v1], [u2, v1], [u2, v2], [u1, v2]];
      const steps = ((face.rotation ?? 0) / 90) % 4;
      if (steps) uvs = [...uvs.slice(4 - steps), ...uvs.slice(0, 4 - steps)];
      const tint = face.tintindex !== undefined ? tints[face.tintindex] : undefined;
      const shade = SHADE[dir] ?? 1;
      // Verdeckte Flächen sortiert der Tiefenpuffer aus
      const pts = faceCorners(dir, el.from, el.to).map(project);

      for (const tri of [[0, 1, 2], [0, 2, 3]]) {
        const [a, b, c] = tri.map((i) => pts[i]);
        const [ua, ub, uc] = tri.map((i) => uvs[i]);
        const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        if (Math.abs(area) < 1e-6) continue;
        const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
        const maxX = Math.min(n - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
        const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
        const maxY = Math.min(n - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
        for (let y = minY; y <= maxY; y++)
          for (let x = minX; x <= maxX; x++) {
            const px = x + 0.5, py = y + 0.5;
            const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
            const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
            const w2 = 1 - w0 - w1;
            if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
            const u = w0 * ua[0] + w1 * ub[0] + w2 * uc[0];
            const v = w0 * ua[1] + w1 * ub[1] + w2 * uc[1];
            const [r, g, bl, al] = sample(tex, u, v);
            if (al < 8) continue;
            const t = tint ?? [255, 255, 255];
            const z = w0 * a[2] + w1 * b[2] + w2 * c[2];
            canvas.blend(x, y, z, [(r * t[0] / 255) * shade, (g * t[1] / 255) * shade, (bl * t[2] / 255) * shade, al]);
            drawn = true;
          }
      }
    }
  }
  return drawn ? canvas.downsample(SS) : undefined;
}

/** Flaches Item: Ebenen (layer0, layer1 …) übereinanderlegen und pixelgenau vergrößern */
function renderGenerated(model: ResolvedModel, tints: Rgb[]): Buffer | undefined {
  const out = Buffer.alloc(SIZE * SIZE * 4);
  let drawn = false;
  for (let layer = 0; layer < 5; layer++) {
    const ref = resolveTexture(model.textures, `#layer${layer}`);
    const tex = ref && readTexture(ref);
    if (!tex) continue;
    const t = tints[layer] ?? [255, 255, 255];
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const [r, g, b, a] = sample(tex, (x + 0.5) / SIZE * 16, (y + 0.5) / SIZE * 16);
        if (a < 8) continue;
        const o = (y * SIZE + x) * 4;
        const k = a / 255;
        out[o] = (r * t[0] / 255) * k + out[o] * (1 - k);
        out[o + 1] = (g * t[1] / 255) * k + out[o + 1] * (1 - k);
        out[o + 2] = (b * t[2] / 255) * k + out[o + 2] * (1 - k);
        out[o + 3] = Math.max(out[o + 3], a);
        drawn = true;
      }
  }
  return drawn ? out : undefined;
}

/* ───────────────────────── Sonderfälle (Entity-Modelle) ───────────────────────── */

/**
 * Fläche eines Entity-Quaders (Minecraft-Layout ab Texturversatz u,v mit Maßen w,h,d) in 0..16-UV.
 * Kisten werden mit umgekehrter Y-Achse gezeichnet (flipY): Dann ist "oben" im Layout die Unterseite.
 */
function boxFaces(tex: string, size: number, u: number, v: number, w: number, h: number, d: number, flipY = false): Record<string, Face> {
  const s = (vals: number[]) => vals.map((x) => (x / size) * 16);
  const top = s([u + d + w, v + d, u + d, v]);
  const bottom = s([u + d + w, v, u + d + 2 * w, v + d]);
  return {
    up: { texture: tex, uv: flipY ? bottom : top },
    down: { texture: tex, uv: flipY ? top : bottom },
    north: { texture: tex, uv: s([u + d, v + d, u + d + w, v + d + h]) },
    south: { texture: tex, uv: s([u + 2 * d + w, v + d, u + 2 * d + 2 * w, v + d + h]) },
    west: { texture: tex, uv: s([u + d + w, v + d, u + 2 * d + w, v + d + h]) },
    east: { texture: tex, uv: s([u, v + d, u + d, v + d + h]) },
  };
}

/** Kisten und Shulkerkisten werden im Spiel als Entity gezeichnet – hier als Blockmodell nachgebaut */
function specialModel(special: Json): ResolvedModel | undefined {
  const gui = { rotation: [30, 45, 0], scale: [0.625, 0.625, 0.625] };
  if (special?.type === 'minecraft:chest') {
    const tex = `entity/chest/${resourcePath(special.texture)}`;
    return {
      kind: 'elements', gui, textures: { t: tex },
      elements: [
        { from: [1, 0, 1], to: [15, 10, 15], faces: boxFaces('#t', 64, 0, 19, 14, 10, 14, true) },
        { from: [1, 9, 1], to: [15, 14, 15], faces: boxFaces('#t', 64, 0, 0, 14, 5, 14, true) },
        { from: [7, 7, 0], to: [9, 11, 1], faces: boxFaces('#t', 64, 0, 0, 2, 4, 1, true) },
      ],
    };
  }
  if (special?.type === 'minecraft:shulker_box') {
    const tex = `entity/shulker/${resourcePath(special.texture)}`;
    return {
      kind: 'elements', gui, textures: { t: tex },
      elements: [
        { from: [0, 0, 0], to: [16, 8, 16], faces: boxFaces('#t', 64, 0, 28, 16, 8, 16) },
        { from: [0, 4, 0], to: [16, 16, 16], faces: boxFaces('#t', 64, 0, 0, 16, 12, 16) },
      ],
    };
  }
  return undefined;
}

/* ───────────────────────── Weitere Sprachen ───────────────────────── */

/** Zusätzliche Sprachen für Item-Namen (der Client enthält nur Englisch) */
const EXTRA_LANGS: Record<string, string> = { de: 'de_de' };

/**
 * Sprachdatei aus dem Cache oder – passend zur Version des Clients – von Mojangs offiziellem
 * Download-Server (Prüfsumme wird kontrolliert).
 */
async function loadLang(code: string): Promise<Record<string, string> | undefined> {
  const cached = join(cacheDir, 'lang', `${code}.json`);
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));
  const version = /minecraft-client-(.+)\.jar$/.exec(jarPath)?.[1];
  if (!version) return undefined;
  try {
    const manifest = await (await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).json() as Json;
    const entry = manifest.versions.find((v: Json) => v.id === version);
    const versionJson = await (await fetch(entry.url)).json() as Json;
    const index = await (await fetch(versionJson.assetIndex.url)).json() as Json;
    const { hash } = index.objects[`minecraft/lang/${code}.json`];
    const buf = Buffer.from(await (await fetch(`https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`)).arrayBuffer());
    if (createHash('sha1').update(buf).digest('hex') !== hash) throw new Error('Prüfsumme falsch');
    mkdirSync(join(cacheDir, 'lang'), { recursive: true });
    writeFileSync(cached, buf);
    return JSON.parse(buf.toString('utf8'));
  } catch (err) {
    console.warn(`Sprache ${code} nicht verfügbar: ${(err as Error).message}`);
    return undefined;
  }
}

/* ───────────────────────── Ablauf ───────────────────────── */

const lang = readJson('lang/en_us.json') as Record<string, string>;
const pretty = (id: string) => id.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const extraLangs: Record<string, Record<string, string>> = {};
for (const [short, code] of Object.entries(EXTRA_LANGS)) {
  const data = await loadLang(code);
  if (data) extraLangs[short] = data;
}

/* Item-Tags (data/minecraft/tags/item) inkl. verschachtelter Tags → id → Tag-Namen */
const rawTags = new Map<string, string[]>();
for (const entry of zip.getEntries()) {
  const m = /^data\/minecraft\/tags\/item\/(.+)\.json$/.exec(entry.entryName);
  if (m) rawTags.set(m[1], (JSON.parse(entry.getData().toString('utf8')).values ?? []).map((v: string | { id: string }) => (typeof v === 'string' ? v : v.id)));
}
const expand = (tag: string, seen = new Set<string>()): string[] => {
  if (seen.has(tag)) return [];
  seen.add(tag);
  return (rawTags.get(tag) ?? []).flatMap((v) => (v.startsWith('#') ? expand(v.slice(1).replace(/^minecraft:/, ''), seen) : [v.replace(/^minecraft:/, '')]));
};
const tagsOf = new Map<string, Set<string>>();
for (const tag of rawTags.keys()) for (const id of expand(tag)) (tagsOf.get(id) ?? tagsOf.set(id, new Set()).get(id)!).add(tag);

mkdirSync(outDir, { recursive: true });
const library: Array<{ id: string; name: string; names: Record<string, string>; icon: boolean; kind: string; tab: string }> = [];
const missing: string[] = [];

for (const entry of zip.getEntries()) {
  const m = /^assets\/minecraft\/items\/([a-z0-9_]+)\.json$/.exec(entry.entryName);
  if (!m) continue;
  const id = m[1];
  const def = resolveDefinition(JSON.parse(entry.getData().toString('utf8')).model);

  let image: Buffer | undefined;
  let kind = 'none';
  if (def?.special) {
    const model = specialModel(def.special);
    if (model) { image = renderElements(model, []); kind = 'special'; }
  } else if (def?.model) {
    const model = loadModel(def.model);
    if (model.kind === 'generated') { image = renderGenerated(model, def.tints); kind = 'flat'; }
    else if (model.kind === 'elements') { image = renderElements(model, def.tints); kind = 'block'; }
  }

  if (image) {
    const png = new PNG({ width: SIZE, height: SIZE });
    image.copy(png.data);
    writeFileSync(join(outDir, `${id}.png`), PNG.sync.write(png));
  } else {
    missing.push(id);
  }
  const names: Record<string, string> = {};
  for (const [short, data] of Object.entries(extraLangs)) {
    const translated = data[`item.minecraft.${id}`] ?? data[`block.minecraft.${id}`];
    if (translated) names[short] = translated;
  }
  library.push({
    id,
    name: lang[`item.minecraft.${id}`] ?? lang[`block.minecraft.${id}`] ?? pretty(id),
    names,
    icon: !!image,
    kind,
    tab: creativeTab(id, `block.minecraft.${id}` in lang, tagsOf.get(id) ?? new Set()),
  });
}

library.sort((a, b) => a.name.localeCompare(b.name));

// Creative-Tabs als eigene kleine Datei im Repo (nur IDs, keine Mojang-Assets) – kommt so mit jedem Deploy mit
const tabs: Record<string, string[]> = {};
for (const item of library) (tabs[item.tab] ??= []).push(item.id);
for (const ids of Object.values(tabs)) ids.sort();
writeFileSync(join(import.meta.dirname, '..', '..', 'web', 'public', 'creative-tabs.json'), JSON.stringify(tabs));
writeFileSync(join(outDir, 'items.json'), JSON.stringify({ source: jarPath.split(/[\\/]/).at(-1), languages: ['en', ...Object.keys(extraLangs)], items: library }));
console.log(`${library.length} Items, ${library.length - missing.length} mit Bild → ${outDir}`);
if (missing.length) console.log(`Ohne Bild (${missing.length}): ${missing.join(', ')}`);
