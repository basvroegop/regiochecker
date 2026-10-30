// Een kamerstuk met treffers, als HTML (mail) en als platte tekst. Gebruikt door
// de wekelijkse regiomail en door de meldingsmails op termen. De opmaak komt
// uit src/mailstijl.mjs (`s`: de kleuren van de ontvanger).

import { kort } from '../html.mjs';
import { korteDatum } from '../datum.mjs';
import { stukUrl } from './db.mjs';
import { itemRij } from '../mailstijl.mjs';

export function kenmerkenStuk(s) {
  return [s.soort, s.dossier && `dossier ${s.dossier}`, s.afzender].filter(Boolean).join(' · ');
}

export const stukTitel = (s) => (s.titel && s.onderwerp && !s.onderwerp.includes(s.titel) ? `${s.titel}: ${s.onderwerp}` : (s.onderwerp || s.titel || s.nummer));

// Als rij in een lijst van de weekmail: het sleutelwoord als label, en het
// fragment in een klein blok.
export function trefferHtml({ stuk, gevonden }, s) {
  return itemRij({
    soort: 'Kamerstuk',
    datum: korteDatum(stuk.datum),
    labels: [...new Set(gevonden.map((g) => g.term))],
    titel: kort(stukTitel(stuk), 200),
    url: stukUrl(stuk),
    kenmerken: kenmerkenStuk(stuk),
    fragmenten: gevonden.slice(0, 2).map((g) => ({ fragment: g.fragment, bij: g.aantal > 1 ? `(${g.aantal}× ${g.term})` : '' })),
  }, s);
}

export function trefferTekst({ stuk, gevonden }) {
  return [
    `* ${korteDatum(stuk.datum) || 'z.d.'}  ${stukTitel(stuk)}`,
    `  ${kenmerkenStuk(stuk)}`,
    `  Gevonden: ${gevonden.map((g) => g.term).join(', ')}`,
    ...gevonden.slice(0, 2).map((g) => `  "${kort(g.fragment.tekst, 300)}"`),
    `  ${stukUrl(stuk)}`,
  ].join('\n');
}
