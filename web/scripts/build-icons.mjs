// Übernimmt die benötigten Tabler Icons (https://tabler.io/icons, MIT) in src/app/icons.generated.ts.
// Neues Icon: Namen unten ergänzen und `npm run icons` ausführen. "filled:" = gefüllte Variante.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ICONS = [
  'alert-triangle', 'arrow-left', 'arrow-right', 'arrow-up', 'box', 'check', 'chevron-down', 'chevron-up', 'circle-check',
  'circle-dashed', 'circle-half-2', 'clipboard', 'confetti', 'copy', 'download', 'external-link', 'file', 'file-download',
  'hammer', 'info-circle', 'map-2', 'map-pin', 'note', 'pencil', 'photo', 'pin', 'plus', 'refresh', 'rotate', 'flip-vertical', 'selector',
  'stack-2', 'trash', 'upload', 'world', 'x', 'player-play', 'player-stop', 'settings', 'message-circle', 'database', 'users',
  'filled:circle-check', 'filled:crown', 'filled:pinned',
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = join(root, 'node_modules', '@tabler', 'icons', 'icons');
const entries = ICONS.map((spec) => {
  const [variant, name] = spec.includes(':') ? spec.split(':') : ['outline', spec];
  const svg = readFileSync(join(base, variant, `${name}.svg`), 'utf8');
  // Nur die Pfade, ohne den unsichtbaren Rahmen-Pfad
  const body = [...svg.matchAll(/<(path|circle|rect|line|polyline|polygon|ellipse)\b[^>]*\/>/g)]
    .map((m) => m[0].replace(/\s+/g, ' '))
    .filter((el) => !el.includes('stroke="none"'))
    .join('');
  const key = variant === 'filled' ? `${name}-filled` : name;
  return `  '${key}': { filled: ${variant === 'filled'}, body: '${body.replace(/'/g, "\\'")}' },`;
});

writeFileSync(
  join(root, 'src', 'app', 'icons.generated.ts'),
  `// Automatisch erzeugt mit \`npm run icons\` aus Tabler Icons (MIT, https://tabler.io/icons) – nicht von Hand ändern.\n` +
    `export const ICONS = {\n${entries.join('\n')}\n} as const;\n\nexport type IconName = keyof typeof ICONS;\n`,
);
console.log(`${entries.length} Icons geschrieben.`);
