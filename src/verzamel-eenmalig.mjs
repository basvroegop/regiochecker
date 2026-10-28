// Proefronde vanaf de commandoregel: laat per bron zien wat hij oplevert.
//   npm run verzamel
// Werkt op een kopie van data/, zodat hij nooit botst met de draaiende dienst
// (die houdt alles in het geheugen en zou wijzigingen van buitenaf overschrijven).
// Echt verzamelen doet de dienst zelf, of de knop "Nu controleren" in de webUI.

import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Opslag } from './opslag.mjs';
import { verzamelAlles } from './verzamel.mjs';

const hier = path.dirname(fileURLToPath(import.meta.url));
const echt = process.env.REGIOCHECKER_DATA || path.join(hier, '..', 'data');
const kopie = mkdtempSync(path.join(tmpdir(), 'regiochecker-proef-'));

try {
  if (existsSync(echt)) cpSync(echt, kopie, { recursive: true });
  const opslag = new Opslag(kopie);
  for (const r of await verzamelAlles(opslag)) {
    const s = opslag.status.bronnen[r.bron];
    console.log(r.ok
      ? `ok    ${r.bron.padEnd(36)} ${String(r.aantal).padStart(4)} items, ${r.nieuw} nieuw${s.nulmeting ? ' (nulmeting)' : ''}`
      : `FOUT  ${r.bron.padEnd(36)} ${r.fout}`);
  }
  console.log('\nProefronde op een kopie; er is niets opgeslagen.');
} finally {
  rmSync(kopie, { recursive: true, force: true });
}
