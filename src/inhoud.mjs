// De inhoud achter elke link: de tekst van het nieuwsbericht, de brief of het
// raadsstuk (pdf), het Woo-besluit. Daar maakt het taalmodel de samenvatting
// van; met alleen titels zou het moeten gokken.
//
// Na elke verzamelronde halen we de inhoud op van nieuwe berichten van de
// afgelopen twee weken die nog geen inhoud hebben (drie pogingen per bericht).
// Na vijf weken gaat de inhoud er weer af; de samenvatting is wekelijks, en zo
// blijft data/items.json klein.
//
// Per soort bron een eigen route, want de link zelf is niet altijd het stuk:
//   iBabs        pagina met bijlagen; de pdf staat op /Document/View/<id>
//   Notubiz      het hoofddocument via api.notubiz.nl (het portaal blokkeert ons)
//   GPP-Woo      documenten via /api/v2/documenten; het besluit eerst
//   de rest      de pagina zelf: pdf, of HTML (plus de eerste pdf-bijlagen)
// Bronnen met `inhoud: false` in src/regios.mjs slaan we over: daar staat
// alleen een onderwerp online.

import { alleBronnen } from './regios.mjs';
import { haalTekst, haalBestand, haalJson } from './ophalen.mjs';
import { hoofdtekst, absoluut, kort } from './html.mjs';
import { pdfNaarTekst, isPdf } from './pdf.mjs';

export const MAX_INHOUD = 6000;
const PDF_PAGINAS = 8;
const BIJLAGEN = 2;
const RECENT_DAGEN = 14;
const BEWAREN_DAGEN = 35;
const POGINGEN = 3;
const PER_RONDE = 80;
const GELIJKTIJDIG = 3;
const DAG_MS = 86400000;

const schoon = (t) => String(t || '').replace(/\s+/g, ' ').trim();

async function pdfTekst(url) {
  const { buffer, type } = await haalBestand(url);
  if (!isPdf(buffer)) throw new Error(`${url} is geen pdf (${type || 'onbekend type'})`);
  return schoon(await pdfNaarTekst(buffer, { paginas: PDF_PAGINAS }));
}

// Voeg bijlagen toe zolang er ruimte is; een bijlage die niet lukt, slaan we over.
async function metBijlagen(tekst, links) {
  let uit = tekst;
  for (const link of links.slice(0, BIJLAGEN)) {
    if (uit.length >= MAX_INHOUD) break;
    try {
      const bijlage = await pdfTekst(link);
      if (bijlage) uit = uit ? `${uit} || ${bijlage}` : bijlage;
    } catch {
      // volgende bijlage
    }
  }
  return uit;
}

// pdf-links binnen het hoofdgedeelte van een pagina (niet uit menu's of voettekst).
export function pdfLinks(pagina, basis) {
  let stuk = String(pagina);
  const start = stuk.search(/<main\b|role=["']main["']/i);
  if (start >= 0) stuk = stuk.slice(start);
  const links = [];
  for (const [, href] of stuk.matchAll(/<a\b[^>]*href="([^"]+\.pdf(?:\?[^"]*)?)"/gi)) {
    const url = absoluut(href, basis);
    if (url && !links.includes(url)) links.push(url);
  }
  return links;
}

async function algemeen(url) {
  const { buffer, type, url: eind } = await haalBestand(url);
  if (isPdf(buffer)) return schoon(await pdfNaarTekst(buffer, { paginas: PDF_PAGINAS }));
  if (!/html|xml|text/i.test(type)) throw new Error(`onbekend type ${type}`);
  const pagina = buffer.toString('utf8');
  return metBijlagen(hoofdtekst(pagina, MAX_INHOUD), pdfLinks(pagina, eind));
}

// iBabs: de bijlagen staan op de pagina van het stuk als
// /Reports/Document/<item>?documentId=<id>; die pagina is een viewer, de pdf
// zelf staat op /Document/View/<id>. De eerste bijlage is meestal de brief.
export function ibabsDocumenten(pagina, basis) {
  const ids = [];
  for (const [, id] of String(pagina).matchAll(/href="\/Reports\/Document\/[^"?]+\?documentId=([0-9a-f-]{36})"/gi)) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.map((id) => `${basis}/Document/View/${id}`);
}

async function ibabs(item) {
  const basis = new URL(item.url).origin;
  const pagina = await haalTekst(item.url);
  const docs = ibabsDocumenten(pagina, basis);
  return docs.length ? metBijlagen('', docs) : hoofdtekst(pagina, MAX_INHOUD);
}

async function notubiz(item) {
  if (!item.document) return '';
  return pdfTekst(item.document);
}

async function gppWoo(item, bron) {
  const basis = bron.basis.replace(/\/$/, '');
  const uuid = new URL(item.url).pathname.split('/').pop();
  const publicatie = await haalJson(`${basis}/api/v2/publicaties/${uuid}`);
  const documenten = (await haalJson(`${basis}/api/v2/documenten?publicatie=${uuid}`)).results || [];
  const naam = (d) => `${d.officieleTitel || ''} ${d.bestandsnaam || ''}`;
  const volgorde = documenten
    .filter((d) => /\.pdf$/i.test(d.bestandsnaam || ''))
    .sort((a, b) => Number(/besluit/i.test(naam(b))) - Number(/besluit/i.test(naam(a))));
  return metBijlagen(schoon(publicatie.omschrijving), volgorde.map((d) => `${basis}/api/v2/documenten/${d.uuid}/download`));
}

export async function inhoudVoor(item, bron) {
  if (bron?.inhoud === false) return null;
  let tekst;
  if (bron?.type === 'ibabs') tekst = await ibabs(item);
  else if (bron?.type === 'notubiz-ingekomen') tekst = await notubiz(item);
  else if (bron?.type === 'gpp-woo') tekst = await gppWoo(item, bron);
  else tekst = await algemeen(item.url);
  return kort(schoon(tekst), MAX_INHOUD);
}

// Na een verzamelronde: inhoud ophalen voor recente berichten zonder inhoud,
// en oude inhoud opruimen. Geeft het aantal gevulde en mislukte berichten.
export async function vulInhoud(opslag, { nu = new Date(), voortgang } = {}) {
  const bronnen = new Map(alleBronnen().map((b) => [b.id, b]));
  const recent = new Date(nu - RECENT_DAGEN * DAG_MS).toISOString();
  const oud = new Date(nu - BEWAREN_DAGEN * DAG_MS).toISOString();

  for (const item of Object.values(opslag.items)) {
    if (item.inhoud && item.eersteGezien < oud) delete item.inhoud;
  }

  const wachtrij = Object.values(opslag.items)
    .filter((i) => !i.basislijn && i.eersteGezien > recent && i.inhoud === undefined
      && (i.inhoudPogingen || 0) < POGINGEN && bronnen.get(i.bron) && bronnen.get(i.bron).inhoud !== false)
    .sort((a, b) => b.eersteGezien.localeCompare(a.eersteGezien))
    .slice(0, PER_RONDE);

  let gevuld = 0;
  let mislukt = 0;
  const totaal = wachtrij.length;
  await Promise.all(Array.from({ length: GELIJKTIJDIG }, async () => {
    while (wachtrij.length) {
      const item = wachtrij.shift();
      try {
        item.inhoud = (await inhoudVoor(item, bronnen.get(item.bron))) || '';
        delete item.inhoudFout;
        gevuld++;
      } catch (fout) {
        item.inhoudPogingen = (item.inhoudPogingen || 0) + 1;
        item.inhoudFout = fout.message;
        mislukt++;
      }
      voortgang?.({ stap: gevuld + mislukt, totaal, tekst: `inhoud ophalen: ${gevuld + mislukt} van ${totaal}` });
    }
  }));
  return { gevuld, mislukt };
}
