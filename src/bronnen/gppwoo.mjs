// GPP-Woo ("Het Woo Burgerportaal"), het open-source publicatieplatform dat
// onder meer Groningen gebruikt (open.groningen.nl). Het portaal is een
// JavaScript-app die zoekt via POST /api/zoeken; dezelfde vraag stellen wij.
// Chronologisch, alleen publicaties (geen losse documenten), tien per pagina.

import { postJson } from '../ophalen.mjs';
import { platteTekst, kort } from '../html.mjs';
import { leesDatum } from '../datum.mjs';

const PAGINAS = 3;

export function leesGppWoo(json, basis) {
  return (json?.results || [])
    .filter((r) => r.type === 'publication' && r.record?.uuid)
    .map(({ record: p }) => ({
      sleutel: p.uuid,
      titel: platteTekst(p.officieleTitel || p.verkorteTitel),
      url: `${basis}/publicaties/${p.uuid}`,
      datum: leesDatum(p.gepubliceerdOp || p.registratiedatum),
      soortStuk: (p.informatieCategorieen || []).map((c) => c.naam).join(', ') || null,
      tekst: p.omschrijving ? kort(platteTekst(p.omschrijving), 1000) : null,
    }))
    .filter((i) => i.titel);
}

export async function haalGppWoo(bron) {
  const basis = bron.basis.replace(/\/$/, '');
  const items = [];
  for (let pagina = 1; pagina <= (bron.paginas || PAGINAS); pagina++) {
    const json = await postJson(`${basis}/api/zoeken`, { sort: 'chronological', page: pagina, resultTypes: ['publication'] });
    items.push(...leesGppWoo(json, basis));
    if (!json?.next) break;
  }
  return items;
}
