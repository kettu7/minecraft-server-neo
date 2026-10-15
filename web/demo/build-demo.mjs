// Offline-Demo der Website als EINE HTML-Datei: Momentaufnahme aller Daten von der laufenden Website holen,
// mit dem fertigen Build (dist/), Schriften, Item-Bildern, Mod-Icons und Downloads zusammenpacken.
//
//   1. npx ng build                    (in web/)
//   2. NEO_SESSION=<Sitzungs-Token> node demo/build-demo.mjs
//      optional: NEO_URL (Standard http://localhost:4200), demo/map.png als Standbild der Karte
//
// Ergebnis: demo/out/Neo-Demo.html – per Doppelklick offline im Browser öffnen.
// Achtung: enthält echte Daten (Namen, Protokoll) – nicht einchecken, nur bewusst weitergeben.
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist', 'web', 'browser');
const ITEMS = join(ROOT, 'public', 'items');
const OUT_DIR = join(ROOT, 'demo', 'out');
const BASE = process.env.NEO_URL ?? 'http://localhost:4200';
const SESSION = process.env.NEO_SESSION ?? '';
if (!SESSION) throw new Error('NEO_SESSION fehlt (Sitzungs-Token eines Admins).');

const headers = { Cookie: `neo_session=${SESSION}` };
const responses = {};
const assets = {};
const downloads = {};

const key = (path) => {
  const u = new URL(path, 'http://neo.local');
  const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  return `GET ${u.pathname}${params.length ? `?${new URLSearchParams(params)}` : ''}`;
};

async function get(path) {
  const res = await fetch(BASE + path, { headers });
  if (!res.ok) {
    console.warn(`  ! ${path}: HTTP ${res.status}`);
    return undefined;
  }
  const body = await res.json();
  responses[key(path)] = body;
  return body;
}

async function binary(url, withSession = true) {
  const res = await fetch(url.startsWith('http') ? url : BASE + url, { headers: withSession ? headers : {} });
  if (!res.ok) return undefined;
  return { type: res.headers.get('content-type') ?? 'application/octet-stream', data: Buffer.from(await res.arrayBuffer()), res };
}

const dataUri = (type, data) => `data:${type};base64,${data.toString('base64')}`;

/* ───── 1. Daten ───── */

console.log('Daten holen …');
await get('/api/me');
await get('/api/status');
await get('/api/auth/config');
const projects = (await get('/api/projects')) ?? [];
for (const p of projects) await get(`/api/projects/${p.id}`);
const storages = (await get('/api/storages')) ?? [];
for (const s of storages) await get(`/api/storages/${s.id}`);
await get('/api/users');
await get('/api/bans');
await get('/api/audit');
await get('/api/server');
await get('/api/backups');
const mods = await get('/api/mods');
for (const v of [...(mods?.minecraft?.newerReleases ?? []), ...(mods?.minecraft?.snapshots ?? [])]) {
  await get(`/api/mods/upgrade?version=${encodeURIComponent(v.version)}`);
}
for (const q of ['', 'graves', 'ledger', 'voice chat', 'performance']) await get(`/api/mods/search?q=${encodeURIComponent(q)}`);
await get('/api/modpack');
await get('/api/modpack/manage');
const packSearches = {
  mod: ['', 'Sodium', 'Litematica', 'Mod Menu', 'Xaero', 'EMI', 'Iris', 'AppleSkin', 'Jade'],
  resourcepack: ['', 'Faithful', 'Fresh Animations'],
  shader: ['', 'Complementary', 'BSL'],
};
for (const [kind, queries] of Object.entries(packSearches)) {
  for (const q of queries) await get(`/api/modpack/search?kind=${kind}&q=${encodeURIComponent(q)}`);
}
responses[key('/items/items.json')] = JSON.parse(await readFile(join(ITEMS, 'items.json'), 'utf8'));

/* ───── 2. Bilder ───── */

console.log('Bilder einbetten …');
for (const file of await readdir(ITEMS)) {
  if (file.endsWith('.png')) assets[`/items/${file}`] = dataUri('image/png', await readFile(join(ITEMS, file)));
}
// Alle Bild-Adressen aus den Antworten: Projektbilder (+ Vorschau), Mod-Icons, Avatare
const urls = new Set();
JSON.stringify(responses, (_k, v) => {
  if (typeof v === 'string' && (/^\/api\/(projects\/\d+\/image|mods\/icons\/)/.test(v) || v.startsWith('https://cdn.discordapp.com/'))) urls.add(v);
  return v;
});
for (const url of [...urls]) if (url.includes('/image?')) urls.add(`${url}&size=thumb`);
for (const url of urls) {
  const file = await binary(url, !url.startsWith('http'));
  if (file) assets[url] = dataUri(file.type, file.data);
  else console.warn(`  ! Bild fehlt: ${url}`);
}
const mapFile = join(ROOT, 'demo', 'map.png');
if (existsSync(mapFile)) assets['demo:map'] = dataUri('image/png', await readFile(mapFile));
else console.warn('  ! demo/map.png fehlt – Karte bleibt leer');

/* ───── 3. Downloads ───── */

console.log('Downloads einbetten …');
const fileName = (res, fallback) => /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallback;
const pack = await binary('/api/modpack/download');
if (pack) downloads['/api/modpack/download'] = { name: fileName(pack.res, 'Neo.mrpack'), type: pack.type, base64: pack.data.toString('base64') };
for (const p of projects) {
  const path = `/api/projects/${p.id}/schematic`;
  const f = await binary(path);
  if (f) downloads[path] = { name: fileName(f.res, `${p.name}.litematic`), type: f.type, base64: f.data.toString('base64') };
}

/* ───── 4. Eine HTML-Datei bauen ───── */

console.log('Datei bauen …');
let html = await readFile(join(DIST, 'index.html'), 'utf8');
const files = await readdir(DIST);
const css = files.find((f) => /^styles-.*\.css$/.test(f));
const js = files.find((f) => /^main-.*\.js$/.test(f));
if (!css || !js) throw new Error('Build fehlt – erst "npx ng build" ausführen.');

let styles = await readFile(join(DIST, css), 'utf8');
for (const [, ref] of styles.matchAll(/url\("?\.\/(media\/[^")]+)"?\)/g)) {
  styles = styles.replaceAll(ref, dataUri('font/woff2', await readFile(join(DIST, ref))).slice(0));
}
styles = styles.replaceAll('url("./data:', 'url("data:').replaceAll('url(./data:', 'url(data:');

const script = (await readFile(join(DIST, js), 'utf8')).replaceAll('</script', '<\\/script');
const snapshot = { createdAt: new Date().toISOString(), responses, assets, downloads };
const data = JSON.stringify(snapshot).replaceAll('</', '<\\/');
const favicon = existsSync(join(DIST, 'favicon.svg')) ? dataUri('image/svg+xml', await readFile(join(DIST, 'favicon.svg'))) : '';

html = html
  .replace('<base href="/">', '')
  .replace('<title>Neo · Minecraft</title>', '<title>Neo · Offline-Demo</title>')
  .replace(/<link rel="icon"[^>]*>/, favicon ? `<link rel="icon" href="${favicon}">` : '')
  .replace(/<link rel="stylesheet"[^>]*>(<noscript>.*?<\/noscript>)?/, () => `<style>${styles}</style>`)
  .replace(/<script src="main-[^"]+" type="module"><\/script>/, () =>
    `<script>window.__NEO_DEMO__ = ${data};</script>\n<script type="module">${script}</script>`);

await mkdir(OUT_DIR, { recursive: true });
const out = join(OUT_DIR, 'Neo-Demo.html');
await writeFile(out, html);
const mb = (Buffer.byteLength(html) / 1024 / 1024).toFixed(1);
console.log(`Fertig: ${out} (${mb} MB, ${Object.keys(responses).length} Antworten, ${Object.keys(assets).length} Bilder, ${Object.keys(downloads).length} Downloads)`);
