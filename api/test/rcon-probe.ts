// Manueller Verbindungstest: node --env-file=../.env test/rcon-probe.ts [x y z]
// Ohne Koordinaten: Anmeldung + Spielerliste. Mit Koordinaten: Rohantwort von /data get block und Auswertung.
import { Rcon } from '../src/rcon.ts';
import { parseSnbt } from '../src/snbt.ts';
import { parseBlockData } from '../src/storage.ts';

const rcon = new Rcon();
await rcon.connect();
console.log('Anmeldung ok');
console.log('list →', await rcon.command('list'));

const [x, y, z] = process.argv.slice(2);
if (z !== undefined) {
  const answer = await rcon.command(`data get block ${x} ${y} ${z}`);
  console.log('Rohantwort →', answer);
  const start = answer.indexOf('{');
  if (start >= 0) console.log('SNBT →', JSON.stringify(parseSnbt(answer.slice(start))));
  console.log('Als Behälter →', JSON.stringify(parseBlockData(answer)));
}
rcon.close();
