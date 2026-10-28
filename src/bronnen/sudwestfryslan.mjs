// sudwestfryslan.nl (WordPress). De standaard-feed /feed/ is leeg, want het
// nieuws is een eigen berichttype; daarom lezen we de nieuwspagina zelf.
//
// Ingekomen stukken: elke week een pdf "Lijst ingekomen stukken Raad week NN"
// met een tabel Datum / Indiener / Titel. We lezen de nieuwste twee lijsten, dan
// valt er niets weg als een lijst een paar dagen later verschijnt.
//
// Woo: een tabel per jaar met "Datum besluit" en "Onderwerp". De documenten zelf
// staan niet online; die vraag je op via het formulier op dezelfde pagina.

import { createHash } from 'node:crypto';
import { haalTekst, haalBuffer } from '../ophalen.mjs';
import { pdfNaarTekst } from '../pdf.mjs';
import { platteTekst, absoluut } from '../html.mjs';
import { leesDatum } from '../datum.mjs';

const vingerafdruk = (...delen) => createHash('sha1').update(delen.join('|')).digest('hex').slice(0, 16);

// Beide lijsten hebben geen eigen id, dus de sleutel komt uit de inhoud. Twee
// regels met precies dezelfde inhoud (komt voor: twee Woo-besluiten over
// rijksmonumenten op één dag) krijgen een volgnummer, zodat ze apart tellen.
function metSleutels(items, inhoud) {
  const geteld = new Map();
  return items.map((item) => {
    const basis = inhoud(item).join('|');
    const n = geteld.get(basis) || 0;
    geteld.set(basis, n + 1);
    return { sleutel: vingerafdruk(basis, ...(n ? [n] : [])), ...item };
  });
}

export function leesNieuws(pagina, basis) {
  const items = [];
  for (const [, artikel] of String(pagina).matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)) {
    const a = artikel.match(/<h2>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const url = absoluut(a[1], basis);
    items.push({
      sleutel: url,
      titel: platteTekst(a[2]),
      url,
      datum: leesDatum(artikel.match(/<time datetime="([^"]+)"/)?.[1]),
    });
  }
  return items;
}

export function leesWoo(pagina, basis) {
  const items = [];
  for (const [, rij] of String(pagina).matchAll(/<tr class="row-\d+">([\s\S]*?)<\/tr>/g)) {
    const cellen = [...rij.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((c) => platteTekst(c[1]));
    if (cellen.length < 2 || !cellen[1]) continue;
    items.push({ titel: cellen[1], url: basis, datum: leesDatum(cellen[0]), ruweDatum: cellen[0] });
  }
  return metSleutels(items, (i) => [i.ruweDatum, i.titel]).map(({ ruweDatum, ...i }) => i);
}

export function leesLijstLinks(pagina, basis) {
  const links = [];
  for (const [, href] of String(pagina).matchAll(/href="([^"]*Lijst-ingekomen-stukken[^"]*\.pdf)"/gi)) {
    const url = absoluut(href, basis);
    if (url && !links.includes(url)) links.push(url);
  }
  return links;
}

// Tekst uit `pdftotext -layout`. De kolomgrenzen halen we uit de kopregel
// "Datum  Indiener  Titel"; elk tekststuk (gescheiden door twee of meer spaties)
// hoort bij de kolom waar het begint. Een regel die met een datum begint opent een
// nieuw stuk, de regels eronder vullen indiener en titel aan.
export function leesLijstTekst(tekst, pdfUrl) {
  const regels = String(tekst).split('\n');
  let kolommen = null;
  let huidig = null;
  const stukken = [];

  const sluitAf = () => {
    if (huidig?.titel.length) stukken.push(huidig);
    huidig = null;
  };

  for (const regel of regels) {
    if (/^\s*Datum\s{2,}Indiener\s{2,}Titel\s*$/.test(regel)) {
      kolommen = [regel.indexOf('Datum'), regel.indexOf('Indiener'), regel.indexOf('Titel')];
      continue;
    }
    if (!kolommen || !regel.trim()) continue;
    const delen = [[], [], []];
    for (const m of regel.matchAll(/\S+(?: \S+)*/g)) {
      let k = 0;
      for (let i = 0; i < kolommen.length; i++) if (m.index >= kolommen[i] - 3) k = i;
      delen[k].push(m[0]);
    }
    const datum = delen[0].length ? leesDatum(delen[0].join(' ')) : null;
    if (datum) {
      sluitAf();
      huidig = { datum, indiener: [], titel: [] };
    } else if (!huidig || delen[0].length) {
      // Paginanummers en andere tekst buiten de tabel.
      continue;
    }
    huidig.indiener.push(...delen[1]);
    huidig.titel.push(...delen[2]);
  }
  sluitAf();

  return stukken.map((s) => {
    const titel = s.titel.join(' ').replace(/\s+/g, ' ').trim();
    const afzender = s.indiener.join(' ').replace(/\s+/g, ' ').trim() || null;
    return { titel, url: pdfUrl, datum: s.datum, afzender };
  });
}

export async function haalNieuws(bron) {
  return leesNieuws(await haalTekst(bron.url), bron.url);
}

export async function haalWoo(bron) {
  return leesWoo(await haalTekst(bron.url), bron.url);
}

export async function haalIngekomen(bron) {
  const links = leesLijstLinks(await haalTekst(bron.url), bron.url).slice(0, bron.aantalLijsten || 2);
  if (!links.length) throw new Error('Geen pdf-lijsten met ingekomen stukken gevonden op de pagina');
  const items = [];
  for (const link of links) {
    items.push(...leesLijstTekst(await pdfNaarTekst(await haalBuffer(link), { layout: true }), link));
  }
  return metSleutels(items, (i) => [i.datum, i.afzender, i.titel]);
}
