// Eenmalig: het archief van de losse audioscraper overnemen (src/audio/importeer.mjs).
//
//   docker compose stop regiochecker
//   cp /pad/naar/audioscraper/data/audioscraper.sqlite3 data/
//   docker compose run --rm regiochecker node src/importeer-audioscraper.mjs /app/data/audioscraper.sqlite3
//   docker compose up -d regiochecker
//
// Met de dienst gestopt, omdat die de bronnenlijst in het geheugen houdt en
// anders bij de volgende wijziging over de import heen zou schrijven.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Opslag } from './opslag.mjs';
import { openFeedDb } from './feeddb.mjs';
import { AudioDb } from './audio/db.mjs';
import { importeerAudioscraper } from './audio/importeer.mjs';

const hier = path.dirname(fileURLToPath(import.meta.url));
const bestand = process.argv[2];
if (!bestand) {
  console.error('Gebruik: node src/importeer-audioscraper.mjs <pad naar audioscraper.sqlite3>');
  process.exit(1);
}
const opslag = new Opslag(process.env.REGIOCHECKER_DATA || path.join(hier, '..', 'data'));
const fdb = await openFeedDb(path.join(opslag.map, 'regiochecker.sqlite'));
const adb = new AudioDb(fdb.db);
const uit = await importeerAudioscraper({ opslag, adb }, bestand);
console.log(`Overgenomen: ${uit.bronnen} bronnen, ${uit.afleveringen} afleveringen, ${uit.nummers} telefoonvermeldingen, ${uit.beoordelingen} beoordelingen${uit.overgeslagen ? ` (${uit.overgeslagen} afleveringen zonder project overgeslagen)` : ''}.`);
for (const b of opslag.bronnen.filter((x) => x.geimporteerd === 'audioscraper')) {
  console.log(`  ${b.naam} — ${b.bereik === 'regio' ? `regio ${b.regio}` : 'landelijk'}`);
}
fdb.sluit();
