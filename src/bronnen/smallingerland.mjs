// smallingerland.nl draait op Roxit Rx.Front en heeft geen RSS-feed.
//
// Nieuws: /Nieuwsarchief is dezelfde lijst als "Meer nieuws" op de homepage,
// elk bericht een <li> met een <h2><a> en een <span class="objectinfo"> met de datum.
//
// Woo: de pagina "Woo-verzoek indienen" linkt naar een subpagina per openbaar
// gemaakt verzoek. Datums staan er niet bij; een nieuwe link is een nieuwe publicatie.

import { haalTekst } from '../ophalen.mjs';
import { platteTekst, absoluut } from '../html.mjs';
import { leesDatum } from '../datum.mjs';

export function leesNieuws(pagina, basis) {
  const items = [];
  for (const [, li] of String(pagina).matchAll(/<li id="objectlink[^"]*"[^>]*>([\s\S]*?)<\/li>/g)) {
    const a = li.match(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const url = absoluut(a[1], basis);
    items.push({
      sleutel: url,
      titel: platteTekst(a[2]),
      url,
      datum: leesDatum(platteTekst(li.match(/<span class="objectinfo">([\s\S]*?)<\/span>/)?.[1])),
    });
  }
  return items;
}

const WOO_PAD = '/Onderwerpen/Klacht_en_bezwaar/Verzoek_informatie_Wet_open_overheid_Woo/';

export function leesWoo(pagina, basis) {
  const gezien = new Set();
  const items = [];
  for (const [, href, inhoud] of String(pagina).matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const url = absoluut(href, basis);
    if (!url || !new URL(url).pathname.startsWith(WOO_PAD) || gezien.has(url)) continue;
    gezien.add(url);
    items.push({ sleutel: url, titel: platteTekst(inhoud), url, datum: null });
  }
  return items;
}

export async function haalNieuws(bron) {
  return leesNieuws(await haalTekst(bron.url), bron.url);
}

export async function haalWoo(bron) {
  return leesWoo(await haalTekst(bron.url), bron.url);
}
