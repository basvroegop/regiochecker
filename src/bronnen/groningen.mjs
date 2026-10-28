// gemeente.groningen.nl, pagina "B&W besluiten": elke week de besluitenlijst van
// het college plus de stukken die daarbij horen (beantwoording van raadsvragen,
// memo's en voortgangsbrieven aan de raad). Dat zijn grotendeels de collegebrieven
// die ook op de lijst ingekomen stukken van de raad komen; die lijst zelf staat op
// gemeenteraad.groningen.nl achter een botcontrole (Anubis).
//
// We lezen alleen de sectie "Meest recente besluiten". Onder "Eerdere
// besluitenlijsten" komen dezelfde lijsten een week later nog eens terug, onder
// een andere link; die zouden dan opnieuw als nieuw tellen.

import { haalTekst } from '../ophalen.mjs';
import { platteTekst, absoluut } from '../html.mjs';
import { leesDatum } from '../datum.mjs';

export function leesBwBesluiten(pagina, basis) {
  const b = String(pagina);
  const kop = b.search(/<h2[^>]*>\s*Meest recente besluiten\s*<\/h2>/i);
  if (kop < 0) throw new Error('Sectie "Meest recente besluiten" niet gevonden: is de pagina veranderd?');
  const sectie = b.slice(kop, b.indexOf('</section>', kop));

  const items = [];
  for (const [, href, inhoud] of sectie.matchAll(/<a\b[^>]*href="(\/file\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const bestand = platteTekst(inhoud.match(/<span class="filename">([\s\S]*?)<\/span>/)?.[1] || inhoud);
    // "26-10-06 4. Beantw vragen over … .pdf" → datum 2026-10-06, titel "Beantwoording vragen over …"
    const m = bestand.match(/^(\d{2})-(\d{2})-(\d{2})\s+(?:\d+[a-z]?\.\s*)?(.*?)(?:\.pdf)?$/i);
    const titel = (m ? m[4] : bestand.replace(/\.pdf$/i, '')).replace(/^Beantw\b\.?/, 'Beantwoording').trim();
    if (!titel) continue;
    const url = absoluut(href, basis);
    items.push({
      sleutel: href,
      titel,
      url,
      datum: m ? leesDatum(`20${m[1]}-${m[2]}-${m[3]}`) : null,
      soortStuk: /^Besluitenlijst/i.test(titel) ? 'Besluitenlijst B&W' : 'Bij B&W-besluit',
    });
  }
  return items;
}

export async function haalBwBesluiten(bron) {
  return leesBwBesluiten(await haalTekst(bron.url), bron.url);
}
