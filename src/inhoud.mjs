// De inhoud achter elke link: de tekst van het nieuwsbericht, de brief of het
// raadsstuk (pdf), het Woo-besluit. Twee vormen:
//   het document   het hele stuk met zijn opmaak (koppen, alinea's, opsommingen,
//                  bijlagen), voor "Uit het document" in het leespaneel; in
//                  regiochecker.sqlite (src/feeddb.mjs)
//   item.inhoud    de eerste 6000 tekens daarvan als platte tekst, voor de
//                  samenvatting door het taalmodel; met alleen titels zou het
//                  moeten gokken
//
// Na elke verzamelronde halen we het document op van nieuwe berichten van de
// afgelopen twee weken (drie pogingen per bericht), en van berichten tot twee
// maanden oud die nog geen document hebben. Opent iemand een ouder stuk, dan
// haalt het leespaneel het document alsnog op (documentOpVraag). Na vijf weken
// gaat item.inhoud er weer af; de samenvatting is wekelijks, en zo blijft
// data/items.json klein.
//
// Per soort bron een eigen route, want de link zelf is niet altijd het stuk:
//   iBabs        pagina met bijlagen; de pdf staat op /Document/View/<id>
//   Notubiz      het hoofddocument via api.notubiz.nl (het portaal blokkeert ons)
//   GPP-Woo      documenten via /api/v2/documenten; het besluit eerst
//   de rest      de pagina zelf: pdf, of HTML (plus de pdf-bijlagen)
// Bronnen met `inhoud: false` (src/regios.mjs) slaan we over: daar staat
// alleen een onderwerp online.

import { alleBronnen } from './register.mjs';
import { haalTekst, haalBestand, haalJson } from './ophalen.mjs';
import { hoofdHtml, absoluut, kort, platteTekst } from './html.mjs';
import { pdfNaarTekst, isPdf } from './pdf.mjs';
import { htmlBlokken, tekstBlokken, platVan, begrens, tekens, MAX_DOCUMENT } from './document.mjs';

export const MAX_INHOUD = 6000;
// Het hele stuk, maar geen boekwerk van duizend pagina's.
const PDF_PAGINAS = 150;
const BIJLAGEN = 5;
const RECENT_DAGEN = 14;
const DOCUMENT_DAGEN = 60;
const BEWAREN_DAGEN = 35;
const POGINGEN = 3;
const PER_RONDE = 80;
const GELIJKTIJDIG = 3;
const DAG_MS = 86400000;

async function pdfDeel(url) {
  const { buffer, type } = await haalBestand(url);
  if (!isPdf(buffer)) throw new Error(`${url} is geen pdf (${type || 'onbekend type'})`);
  return pdfBufferDeel(buffer);
}

async function pdfBufferDeel(buffer) {
  const tekst = await pdfNaarTekst(buffer, { paginas: PDF_PAGINAS });
  // pdftotext sluit elke pagina af met een form feed.
  return { blokken: tekstBlokken(tekst), volledig: (tekst.match(/\f/g) || []).length < PDF_PAGINAS };
}

// Delen samen tot één document: { blokken, volledig }. Vanaf het tweede deel
// staat de naam ervoor (een bijlage).
function samen(delen, { meer = false } = {}) {
  const blokken = [];
  let volledig = !meer;
  delen.forEach((d, i) => {
    if (!d?.blokken.length) return;
    if (blokken.length) blokken.push(['d', d.naam || `Bijlage ${i}`]);
    blokken.push(...d.blokken);
    if (d.volledig === false) volledig = false;
  });
  const b = begrens(blokken);
  return { blokken: b.blokken, volledig: volledig && b.volledig };
}

// pdf-bijlagen ophalen zolang er ruimte is; een bijlage die niet lukt, slaan we over.
async function bijlagen(links) {
  const uit = [];
  let n = 0;
  for (const { url, naam } of links.slice(0, BIJLAGEN)) {
    if (n >= MAX_DOCUMENT) break;
    try {
      const deel = { ...(await pdfDeel(url)), naam };
      n += tekens(deel.blokken);
      uit.push(deel);
    } catch {
      // volgende bijlage
    }
  }
  return uit;
}

// De tekst van een link: van het eind van de openingstag tot </a>.
const linktekst = (pagina, m) => {
  const na = pagina.slice(m.index + m[0].length, m.index + m[0].length + 500);
  const eind = na.search(/<\/a>/i);
  return eind >= 0 ? platteTekst(na.slice(0, eind)) : '';
};
const bestandsnaam = (url) => {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch { return ''; }
};

// pdf-links binnen het hoofdgedeelte van een pagina (niet uit menu's of
// voettekst), met de linktekst als naam.
export function pdfBijlagen(pagina, basis) {
  let stuk = String(pagina);
  const start = stuk.search(/<main\b|role=["']main["']/i);
  if (start >= 0) stuk = stuk.slice(start);
  const uit = [];
  for (const m of stuk.matchAll(/<a\b[^>]*href="([^"]+\.pdf(?:\?[^"]*)?)"[^>]*>/gi)) {
    const url = absoluut(m[1], basis);
    if (url && !uit.some((b) => b.url === url)) uit.push({ url, naam: linktekst(stuk, m) || bestandsnaam(url) || 'Bijlage' });
  }
  return uit;
}

export const pdfLinks = (pagina, basis) => pdfBijlagen(pagina, basis).map((b) => b.url);

async function algemeen(url) {
  const { buffer, type, url: eind } = await haalBestand(url);
  if (isPdf(buffer)) return samen([await pdfBufferDeel(buffer)]);
  if (!/html|xml|text/i.test(type)) throw new Error(`onbekend type ${type}`);
  const pagina = buffer.toString('utf8');
  const links = pdfBijlagen(pagina, eind);
  return samen([{ blokken: htmlBlokken(hoofdHtml(pagina)) }, ...await bijlagen(links)], { meer: links.length > BIJLAGEN });
}

// iBabs: de bijlagen staan op de pagina van het stuk als
// /Reports/Document/<item>?documentId=<id>; die pagina is een viewer, de pdf
// zelf staat op /Document/View/<id>. De eerste bijlage is meestal de brief.
export function ibabsBijlagen(pagina, basis) {
  const uit = [];
  const tekst = String(pagina);
  for (const m of tekst.matchAll(/<a\b[^>]*href="\/Reports\/Document\/[^"?]+\?documentId=([0-9a-f-]{36})"[^>]*>/gi)) {
    const id = m[1];
    if (!uit.some((b) => b.id === id)) uit.push({ id, url: `${basis}/Document/View/${id}`, naam: linktekst(tekst, m) || 'Document' });
  }
  return uit;
}

export const ibabsDocumenten = (pagina, basis) => ibabsBijlagen(pagina, basis).map((b) => b.url);

async function ibabs(item) {
  const basis = new URL(item.url).origin;
  const pagina = await haalTekst(item.url);
  const docs = ibabsBijlagen(pagina, basis);
  const pdfs = docs.length ? samen(await bijlagen(docs), { meer: docs.length > BIJLAGEN }) : null;
  // Zonder (leesbare) pdf, zoals een gescande nieuwsbrief: de gegevens van de pagina zelf.
  return pdfs?.blokken.length ? pdfs : samen([{ blokken: htmlBlokken(hoofdHtml(pagina)) }]);
}

async function notubiz(item) {
  if (!item.document) return null;
  return samen([await pdfDeel(item.document)]);
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
  const links = volgorde.map((d) => ({ url: `${basis}/api/v2/documenten/${d.uuid}/download`, naam: String(d.officieleTitel || d.bestandsnaam).trim() }));
  return samen([{ blokken: tekstBlokken(publicatie.omschrijving || '') }, ...await bijlagen(links)], { meer: links.length > BIJLAGEN });
}

// Het hele stuk: { blokken, volledig }, of null als de bron geen inhoud heeft.
export async function documentVoor(item, bron) {
  if (bron?.inhoud === false) return null;
  if (bron?.type === 'ibabs') return ibabs(item);
  if (bron?.type === 'notubiz-ingekomen') return notubiz(item);
  if (bron?.type === 'gpp-woo') return gppWoo(item, bron);
  return algemeen(item.url);
}

const inhoudVan = (doc) => (doc ? kort(platVan(doc.blokken), MAX_INHOUD) : '');

// Geeft het stuk zelf 404 of 410, dan heeft de bron het weggehaald. Dat is voor
// een journalist ook nieuws: het item blijft staan, met de tekst van eerder.
const isWeg = (fout) => /gaf HTTP (404|410)$/.test(String(fout?.message || ''));
function markeerWeg(item, fout, nu = new Date()) {
  if (isWeg(fout)) item.verdwenen ||= nu.toISOString();
}

export async function inhoudVoor(item, bron) {
  if (bron?.inhoud === false) return null;
  return inhoudVan(await documentVoor(item, bron));
}

// Het document van één item voor het leespaneel: uit de database, of nu
// ophalen (en bewaren). Twee keer tegelijk openen haalt het één keer op.
const bezig = new Map();
export function documentOpVraag(opslag, sleutel, { nu = new Date() } = {}) {
  const item = opslag.items[sleutel];
  if (!item) return null;
  const bestaand = opslag.feeddb?.document(sleutel);
  if (bestaand) return bestaand;
  if (bezig.has(sleutel)) return bezig.get(sleutel);
  const bron = alleBronnen(opslag).find((b) => b.id === item.bron);
  if (!bron || bron.inhoud === false) return null;
  const klus = documentVoor(item, bron)
    .then((doc) => {
      const uit = doc || { blokken: [], volledig: true };
      opslag.feeddb?.zetDocument(sleutel, uit);
      if (item.verdwenen) {
        delete item.verdwenen;
        opslag.bewaar('items');
      }
      return uit;
    }, (fout) => {
      if (isWeg(fout) && !item.verdwenen) {
        markeerWeg(item, fout, nu);
        opslag.bewaar('items');
      }
      throw fout;
    })
    .finally(() => bezig.delete(sleutel));
  bezig.set(sleutel, klus);
  return klus;
}

// Na een verzamelronde: documenten en inhoud ophalen voor recente berichten,
// en oude inhoud opruimen. Geeft het aantal gevulde en mislukte berichten.
export async function vulInhoud(opslag, { nu = new Date(), voortgang } = {}) {
  const fdb = opslag.feeddb;
  const bronnen = new Map(alleBronnen(opslag).map((b) => [b.id, b]));
  const recent = new Date(nu - RECENT_DAGEN * DAG_MS).toISOString();
  const documentGrens = new Date(nu - DOCUMENT_DAGEN * DAG_MS).toISOString();
  const oud = new Date(nu - BEWAREN_DAGEN * DAG_MS).toISOString();

  for (const item of Object.values(opslag.items)) {
    if (item.inhoud && item.eersteGezien < oud) delete item.inhoud;
  }
  fdb?.ruimDocumentenOp(new Set(Object.keys(opslag.items)));

  const zonderDocument = (sleutel, item) => fdb && item.eersteGezien > documentGrens && !fdb.heeftDocument(sleutel);
  const wachtrij = Object.entries(opslag.items)
    .filter(([sleutel, i]) => !i.basislijn && (i.inhoudPogingen || 0) < POGINGEN && bronnen.get(i.bron) && bronnen.get(i.bron).inhoud !== false
      && ((i.eersteGezien > recent && i.inhoud === undefined) || zonderDocument(sleutel, i)))
    .sort((a, b) => b[1].eersteGezien.localeCompare(a[1].eersteGezien))
    .slice(0, PER_RONDE);

  let gevuld = 0;
  let mislukt = 0;
  const totaal = wachtrij.length;
  await Promise.all(Array.from({ length: GELIJKTIJDIG }, async () => {
    while (wachtrij.length) {
      const [sleutel, item] = wachtrij.shift();
      try {
        const doc = await documentVoor(item, bronnen.get(item.bron));
        fdb?.zetDocument(sleutel, doc || { blokken: [], volledig: true });
        if (item.eersteGezien > oud) item.inhoud = inhoudVan(doc);
        delete item.inhoudFout;
        delete item.verdwenen;
        gevuld++;
      } catch (fout) {
        item.inhoudPogingen = (item.inhoudPogingen || 0) + 1;
        item.inhoudFout = fout.message;
        markeerWeg(item, fout, nu);
        mislukt++;
      }
      voortgang?.({ stap: gevuld + mislukt, totaal, tekst: `inhoud ophalen: ${gevuld + mislukt} van ${totaal}` });
    }
  }));
  return { gevuld, mislukt };
}
