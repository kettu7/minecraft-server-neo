// Setzt Item-Bilder zu einem Übersichtsbild zusammen (zum Prüfen des Renderers).
// Aufruf: node scripts/contact-sheet.ts <ausgabe.png> item1 item2 …
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [out, ...ids] = process.argv.slice(2);
const dir = join(import.meta.dirname, '..', '..', 'web', 'public', 'items');
const cell = 72, cols = 8, rows = Math.ceil(ids.length / cols);
const sheet = new PNG({ width: cols * cell, height: rows * cell });
sheet.data.fill(0);
for (let i = 0; i < sheet.data.length; i += 4) sheet.data.set([139, 139, 139, 255], i); // Inventar-Grau

ids.forEach((id, i) => {
  const file = join(dir, `${id}.png`);
  if (!existsSync(file)) return;
  const img = PNG.sync.read(readFileSync(file));
  const ox = (i % cols) * cell + 4, oy = Math.floor(i / cols) * cell + 4;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 4, d = ((oy + y) * sheet.width + ox + x) * 4, a = img.data[s + 3] / 255;
      for (let c = 0; c < 3; c++) sheet.data[d + c] = img.data[s + c] * a + sheet.data[d + c] * (1 - a);
    }
});
writeFileSync(out, PNG.sync.write(sheet));
