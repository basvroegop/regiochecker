// De ransomwareslachtoffers die de checker (/opt/checker) al vond, in de
// Regiochecker. In twee stappen, zodat de dienst maar heel even stil staat:
//
//   node scripts/importeer-checker.mjs zoek <checker.db> <uit.json>
//       leest de checker (alleen lezen) en zoekt per slachtoffer de vestiging
//       op (src/locatie.mjs; met de postcode en plaats die de checker vond als
//       hint). Raakt de data van de Regiochecker niet aan.
//   node scripts/importeer-checker.mjs voeg-toe <uit.json> <data-map>
//       zet ze in data/items.json, met de datum van de checker. Alleen als de
//       dienst niet draait.

import { readFileSync, writeFileSync } from 'node:fs';
import { ransomwareStuk } from '../src/bronnen/signalen.mjs';
import { vindVestiging } from '../src/locatie.mjs';

const [stap, a, b] = process.argv.slice(2);
const iso = (t) => new Date(`${String(t).replace(' ', 'T').replace(/(\.\d{3})\d+$/, '$1')}Z`).toISOString();

if (stap === 'zoek') {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(a, { readOnly: true });
  const uit = [];
  const rijen = db.prepare("SELECT title, summary, occurred_at, payload FROM events WHERE module = 'ransomware' ORDER BY occurred_at").all();
  for (const [n, r] of rijen.entries()) {
    const p = JSON.parse(r.payload || '{}');
    const stuk = ransomwareStuk({ naam: r.title, groep: p.group_name, beschrijving: r.summary, website: p.website, ontdekt: r.occurred_at });
    const hint = { postcode: p.postcode || null, plaats: p.gemeente || null, bron: p.location_source ? `checker, ${p.location_source}` : 'checker' };
    let vestiging = null;
    try { vestiging = await vindVestiging({ ...stuk.slachtoffer, hint }); } catch { /* volgende */ }
    uit.push({ stuk, hint, vestiging, ontdekt: iso(r.occurred_at) });
    process.stdout.write(`\r${n + 1}/${rijen.length} ${vestiging && !vestiging.onzeker ? `${vestiging.gemeente}`.padEnd(30) : '-'.padEnd(30)}`);
  }
  writeFileSync(b, JSON.stringify(uit));
  console.log(`\n${uit.length} slachtoffers, ${uit.filter((x) => x.vestiging && !x.vestiging.onzeker).length} met vestiging`);
} else if (stap === 'voeg-toe') {
  const { Opslag } = await import('../src/opslag.mjs');
  const opslag = new Opslag(b);
  let n = 0;
  for (const { stuk, hint, vestiging, ontdekt } of JSON.parse(readFileSync(a, 'utf8'))) {
    const sleutel = `ransomware:${stuk.sleutel}`;
    if (opslag.items[sleutel]) continue;
    opslag.items[sleutel] = {
      sleutel, bron: 'ransomware', regio: null, soort: 'ransomware', titel: stuk.titel, url: stuk.url, datum: stuk.datum,
      tekst: stuk.tekst, afzender: stuk.afzender, slachtoffer: stuk.slachtoffer, vestigingHint: hint,
      ...(vestiging && !vestiging.onzeker ? { vestiging } : { vestigingPogingen: 2, ...(vestiging?.onzeker ? { vestigingKandidaten: vestiging.kandidaten.map((k) => `${k.plaats || k.gemeente} (${k.bron})`) } : {}) }),
      eersteGezien: ontdekt, laatstGezien: ontdekt, basislijn: false, overgenomenUit: 'checker',
    };
    n++;
  }
  opslag.bewaar('items');
  console.log(`${n} slachtoffers toegevoegd`);
} else {
  console.error('Gebruik: zoek <checker.db> <uit.json> | voeg-toe <uit.json> <data-map>');
  process.exit(1);
}
