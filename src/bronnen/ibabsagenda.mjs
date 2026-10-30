// Ingekomen stukken die alleen in een iBabs-agenda staan, voor gemeenten zonder
// overzicht "Ingekomen stukken" onder /Reports (zie src/bronnen/ibabs.mjs).
// Twee vormen:
//   per agendapunt  een eigen vergadersoort "Lijst ingekomen stukken" bij elke
//                   raad; elk agendapunt is een brief, met de pdf als bijlage
//                   (Borger-Odoorn). De lijst groeit tot de vergadering.
//   per bijlage     één agendapunt "Lijst van Ingekomen Stukken" in de
//                   raadsvergadering (`punt`); elke bijlage is een brief, en
//                   "05-02 - Bijl.1 - …" hoort bij de brief erboven (Schiermonnikoog)
//
// `agendatype` is de id uit de kalender (classNames "agendatype-<id>"). We lezen
// de vergaderingen van de afgelopen twee maanden en de komende anderhalve; iBabs
// vraagt in robots.txt vijf seconden tussen verzoeken.

import { haalTekst, haalJson } from '../ophalen.mjs';
import { platteTekst } from '../html.mjs';
import { leesDatum, lokaleDatum } from '../datum.mjs';

const TERUG_DAGEN = 60;
const VOORUIT_DAGEN = 45;
const DAG_MS = 86400000;

const pauze = () => Number(process.env.IBABS_WACHT_MS ?? 5000);
const wacht = (ms) => new Promise((klaar) => setTimeout(klaar, ms));
const tekst = (html) => platteTekst(html).replace(/\s+/g, ' ').trim();

export function leesKalender(json, agendatype) {
  return (Array.isArray(json) ? json : [])
    .filter((e) => (e.classNames || []).includes(`agendatype-${agendatype}`) && /^\/Agenda\/Index\/[0-9a-f-]{36}$/i.test(e.url || ''))
    .map((e) => ({ id: e.url.split('/').pop(), datum: String(e.start || '').slice(0, 10), titel: e.title || '' }))
    .sort((a, b) => a.datum.localeCompare(b.datum));
}

// De agendapunten op /Agenda/Index/<id>, met hun bijlagen. Een punt zonder
// uitklapblok ("Ter kennisname", "Ter afhandeling van het college") is een kopje.
export function leesAgendapunten(html) {
  const pagina = String(html);
  const begin = [...pagina.matchAll(/<div class="panel panel-default agenda-item" id="([0-9a-f-]{36})"/gi)];
  return begin.map((m, i) => {
    const blok = pagina.slice(m.index, begin[i + 1]?.index ?? pagina.length);
    const bijlagen = [...blok.matchAll(/<a\b[^>]*href="(\/Agenda\/Document\/[^"]+)"[^>]*\bdata-document-id="([0-9a-f-]{36})"[^>]*>([\s\S]*?)<\/a>/gi)]
      .map((a) => ({ id: a[2], pad: a[1].replace(/&amp;/g, '&'), naam: tekst(a[3].replace(/<span class="badge[^"]*">[\s\S]*?<\/span>/gi, '')) }));
    return {
      id: m[1],
      nummer: tekst(/<div class="panel-id">([\s\S]*?)<\/div>/i.exec(blok)?.[1] || ''),
      titel: tekst(/<span class="panel-title-label"\s*>([\s\S]*?)<\/span>/i.exec(blok)?.[1] || ''),
      kopje: !/aria-controls="collapse-/i.test(blok),
      bijlagen,
    };
  });
}

// "20260910 e-mail Stichting Kico …" → 2026-09-10; "Besluitenlijst B&W - 25-08-2026" → 2026-08-25.
function datumInNaam(naam) {
  const m = /^(\d{4})(\d{2})(\d{2})\s/.exec(naam);
  if (m) return leesDatum(`${m[1]}-${m[2]}-${m[3]}`);
  const d = /\b(\d{1,2}-\d{1,2}-\d{4})\b/.exec(naam);
  return d ? leesDatum(d[1]) : null;
}

const meer = (n) => (n > 1 ? `Met ${n - 1} ${n === 2 ? 'bijlage' : 'bijlagen'}.` : null);

// Een stuk per agendapunt; het kopje erboven is het advies.
function perPunt(punten, basis) {
  let advies = null;
  const uit = [];
  for (const p of punten) {
    if (p.kopje) {
      advies = p.titel || null;
      continue;
    }
    const [eerste] = p.bijlagen;
    if (!p.titel || !eerste) continue;
    uit.push({
      sleutel: p.id,
      titel: p.titel.slice(0, 300),
      url: `${basis}${eerste.pad}`,
      datum: datumInNaam(eerste.naam),
      document: `${basis}/Document/View/${eerste.id}`,
      advies,
      tekst: meer(p.bijlagen.length),
    });
  }
  return uit;
}

// Een stuk per bijlage van het agendapunt `punt`, zonder het overzicht zelf;
// "Bijl." hoort bij de brief ervoor.
const NUMMER = /^(B&W\s*)?\d{1,2}\s*(-\s*\d{1,2})?\s*-\s*/i;
function perBijlage(punten, basis, punt) {
  const p = punten.find((x) => x.titel.toLowerCase().includes(punt.toLowerCase()));
  if (!p) return [];
  const uit = [];
  for (const b of p.bijlagen) {
    const naam = b.naam.replace(NUMMER, '');
    if (/^overzicht\b/i.test(b.naam)) continue;
    if (/^bijl(age)?\b/i.test(naam) && uit.length) {
      uit.at(-1).aantal++;
      continue;
    }
    const college = /^B&W\b/i.test(b.naam);
    uit.push({
      sleutel: b.id,
      titel: naam.slice(0, 300),
      url: `${basis}${b.pad}`,
      datum: datumInNaam(naam),
      document: `${basis}/Document/View/${b.id}`,
      afzender: college ? 'College van B&W' : (/^([^-]{2,60}?)\s+-\s+/.exec(naam)?.[1] || null),
      aantal: 1,
    });
  }
  return uit.map(({ aantal, ...s }) => ({ ...s, tekst: meer(aantal) }));
}

export function leesIbabsAgenda(html, basis, { punt = null } = {}) {
  const punten = leesAgendapunten(html);
  return punt ? perBijlage(punten, basis, punt) : perPunt(punten, basis);
}

export async function haalIbabsAgenda(bron, { nu = new Date() } = {}) {
  const basis = bron.basis.replace(/\/$/, '');
  const van = lokaleDatum(new Date(+nu - TERUG_DAGEN * DAG_MS));
  const tot = lokaleDatum(new Date(+nu + VOORUIT_DAGEN * DAG_MS));
  const kalender = await haalJson(`${basis}/Calendar/GetAgendasForCalendar?start=${van}T00:00:00&end=${tot}T00:00:00`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  const agendas = leesKalender(kalender, bron.agendatype);
  if (!agendas.length) throw new Error(`Geen vergaderingen van soort ${bron.agendatype} tussen ${van} en ${tot}. Is de agenda veranderd?`);
  const uit = [];
  for (const a of agendas) {
    await wacht(pauze());
    uit.push(...leesIbabsAgenda(await haalTekst(`${basis}/Agenda/Index/${a.id}`), basis, bron));
  }
  return uit;
}
