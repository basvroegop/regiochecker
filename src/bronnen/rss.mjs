// RSS-feeds: Heerenveen (WordPress) en Opsterland, Ooststellingwerf en
// Weststellingwerf (SIM/Cuatro, /rss/content-list). Beide zijn gewone RSS 2.0.

import { haalTekst } from '../ophalen.mjs';
import { platteTekst, absoluut, kort, ontsnap } from '../html.mjs';
import { leesDatum } from '../datum.mjs';

function veld(blok, naam) {
  const m = blok.match(new RegExp(`<${naam}\\b[^>]*>([\\s\\S]*?)</${naam}>`, 'i'));
  if (!m) return '';
  return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim();
}

export function leesRss(xml, basis) {
  const items = [];
  for (const [, blok] of String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const link = absoluut(ontsnap(veld(blok, 'link')), basis);
    if (!link) continue;
    // WordPress zet onder elke beschrijving "Het bericht X verscheen eerst op Y".
    const beschrijving = (veld(blok, 'content:encoded') || veld(blok, 'description'))
      .replace(/<p>\s*Het bericht\b[\s\S]*?verscheen eerst op[\s\S]*?<\/p>/i, '');
    items.push({
      sleutel: ontsnap(veld(blok, 'guid')) || link,
      titel: platteTekst(veld(blok, 'title')),
      url: link,
      datum: leesDatum(veld(blok, 'pubDate')),
      tekst: kort(platteTekst(beschrijving), 1500) || null,
    });
  }
  return items;
}

export async function haalRss(bron) {
  return leesRss(await haalTekst(bron.url), bron.url);
}
