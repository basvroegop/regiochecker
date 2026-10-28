// Landelijke signalen die de checker (/opt/checker) al volgde, overgenomen in
// de Regiochecker (oktober 2026). Elk stuk heeft een plek, waarmee het naar
// de juiste regio gaat (src/feed.mjs, met src/geo.mjs):
//   aardbevingen        KNMI, openbare FDSN-webdienst, met coördinaat
//   weerwaarschuwingen  KNMI, RSS per provincie; alleen code oranje en rood
//   Raad van State      uitspraken van de Afdeling bestuursrechtspraak; de
//                       samenvatting noemt de gemeente en plaats
//   ransomware          nieuwe slachtoffers (ransomlook.io, en met een
//                       sleutel ransomware.live Pro); de beschrijving noemt
//                       vaak de vestigingsplaats
// Niet overgenomen: files (NDW) en NS-storingen (te vluchtig voor een
// nieuwsfeed; NS vraagt bovendien een sleutel), en de 112-inzendingen via
// Telegram (geen bron om op te halen, maar een bot).

import { createHash } from 'node:crypto';
import { haalTekst, haalJson } from '../ophalen.mjs';
import { ontsnap, platteTekst, absoluut } from '../html.mjs';
import { provincieNaam } from '../geo.mjs';

const kortHash = (t) => createHash('sha1').update(String(t)).digest('hex').slice(0, 10);
const getal = (n, cijfers = 1) => Number(n).toLocaleString('nl-NL', { minimumFractionDigits: cijfers, maximumFractionDigits: cijfers });
const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

// ---------- aardbevingen ----------

// FDSN-tekst: EventID|Time|Latitude|Longitude|Depth/km|…|MagType|Magnitude|MagAuthor|EventLocationName|EventType
export function leesAardbevingen(tekst, { minMagnitude = 1 } = {}) {
  const uit = [];
  for (const regel of String(tekst).split('\n')) {
    if (!regel.trim() || regel.startsWith('#')) continue;
    const v = regel.split('|');
    const [id, tijd, lat, lon, diepte] = v;
    const magnitude = Number(v[10]);
    if (!id || !Number.isFinite(magnitude) || magnitude < minMagnitude) continue;
    const plaats = String(v[12] || '').trim() || 'onbekende plek';
    const soort = /induced|triggered/i.test(v[13] || '') ? 'geïnduceerd (door gaswinning of -opslag)' : 'natuurlijk (tektonisch)';
    const moment = new Date(`${tijd}${/Z$/.test(tijd) ? '' : 'Z'}`);
    uit.push({
      sleutel: id,
      titel: `Aardbeving van ${getal(magnitude)} bij ${plaats}`,
      url: `https://www.knmi.nl/nederland-nu/seismologie/aardbevingen/${encodeURIComponent(id)}`,
      datum: Number.isFinite(moment.getTime()) ? moment.toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }) : null,
      tekst: `Kracht ${getal(magnitude)} (${v[9] || 'M'}) op ${getal(Number(diepte))} km diepte, ${soort}. ${Number.isFinite(moment.getTime()) ? moment.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', dateStyle: 'long', timeStyle: 'short' }) : ''}. Bron: KNMI.`,
      plek: { lat: Number(lat), lon: Number(lon), naam: plaats },
    });
  }
  return uit;
}

export async function haalAardbevingen(bron, { nu = new Date() } = {}) {
  const vanaf = new Date(nu - (bron.dagen ?? 60) * 86400000).toISOString().slice(0, 10);
  return leesAardbevingen(await haalTekst(`${bron.url}?starttime=${vanaf}&orderby=time&format=text`), { minMagnitude: bron.minMagnitude });
}

// ---------- weerwaarschuwingen ----------

const CODES = ['geel', 'oranje', 'rood'];

// De RSS geeft per provincie de huidige toestand. Een stuk per provincie, code
// en tekst: dezelfde waarschuwing komt dus één keer, een nieuwe tekst opnieuw.
export function leesWaarschuwingen(xml, { minCode = 'oranje', nu = new Date() } = {}) {
  const drempel = CODES.indexOf(minCode);
  const uit = [];
  for (const [, item] of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const titel = ontsnap(/<title>([\s\S]*?)<\/title>/.exec(item)?.[1] || '').trim();
    const provincie = /^Waarschuwingen\s+(.+)$/i.exec(titel)?.[1];
    if (!provincie) continue;
    const beschrijving = platteTekst(ontsnap(/<description>([\s\S]*?)<\/description>/.exec(item)?.[1] || '').replace(/<a\b[\s\S]*?<\/a>/gi, ' '));
    const code = /code\s+(geel|oranje|rood)/i.exec(beschrijving)?.[1]?.toLowerCase();
    if (!code || CODES.indexOf(code) < drempel) continue;
    const wat = beschrijving.replace(/^code\s+\w+\.?\s*/i, '').trim();
    const link = absoluut(ontsnap(/<link>([\s\S]*?)<\/link>/.exec(item)?.[1] || '').trim(), 'https://www.knmi.nl/') || 'https://www.knmi.nl/nederland-nu/weer/waarschuwingen';
    const datum = nu.toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    uit.push({
      sleutel: `${provincie}|${code}|${datum}|${kortHash(wat)}`,
      titel: `Code ${code} voor ${provincie}${wat ? `: ${wat.split(/(?<=\.)\s/)[0].replace(/\.$/, '')}` : ''}`,
      url: link,
      datum,
      tekst: `Code ${code}. ${wat}`,
      provincies: [provincieNaam(provincie)],
    });
  }
  return uit;
}

export async function haalWaarschuwingen(bron) {
  return leesWaarschuwingen(await haalTekst(bron.url), { minCode: bron.minCode });
}

// ---------- Raad van State ----------

function rvsDatum(tekst) {
  const m = /(\d{1,2})\s+([a-z]+)\s+(\d{4})/i.exec(String(tekst));
  const maand = m ? MAANDEN.indexOf(m[2].toLowerCase()) : -1;
  return maand >= 0 ? `${m[3]}-${String(maand + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

// De zoekpagina: per uitspraak zaaknummer, samenvatting, ECLI, datum en trefwoorden
// ("Voorlopige voorziening", "RO - Fryslân").
export function leesUitspraken(pagina) {
  const uit = [];
  for (const blok of String(pagina).split(/(?=<div class="grid-blok[^"]*\brol-entry\b)/).slice(1)) {
    const link = /<h2><a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/.exec(blok);
    const ecli = /ECLI:NL:RVS:\d{4}:\d+/.exec(blok)?.[0];
    if (!link || !ecli) continue;
    const samenvatting = platteTekst(/<div class="summary">([\s\S]*?)<\/div>/.exec(blok)?.[1] || '');
    const trefwoorden = [.../<ul class="trefwoorden">([\s\S]*?)<\/ul>/.exec(blok)?.[1].matchAll(/<li>([^<]+)/g) || []].map((m) => ontsnap(m[1]).trim()).filter(Boolean);
    const zaak = ontsnap(link[2]).trim();
    uit.push({
      sleutel: ecli,
      titel: `Raad van State${trefwoorden[0] ? ` (${trefwoorden[0].toLowerCase()})` : ''}: ${onderwerp(samenvatting) || zaak}`,
      url: absoluut(link[1], 'https://www.raadvanstate.nl/'),
      datum: rvsDatum(/Datum uitspraak[\s\S]*?<dd>([^<]+)/.exec(blok)?.[1]),
      tekst: [samenvatting, trefwoorden.length ? `Trefwoorden: ${trefwoorden.join(', ')}.` : '', `Zaak ${zaak}, ${ecli}.`].filter(Boolean).join(' '),
      soortStuk: trefwoorden[0] || null,
    });
  }
  return uit;
}

// Waar gaat de uitspraak over? Meestal een besluit van een gemeente of
// provincie; anders het begin van de samenvatting.
function onderwerp(samenvatting) {
  const wie = /\b(gemeente|provincie|waterschap)\s+(\p{Lu}[\p{L}'-]*(?:[\s-]\p{Lu}[\p{L}'-]*){0,2})/u.exec(samenvatting)
    || /\b(?:college van (?:burgemeester en wethouders|gedeputeerde staten) van|raad van)\s+(\p{Lu}[\p{L}'-]*(?:[\s-]\p{Lu}[\p{L}'-]*){0,2})/u.exec(samenvatting);
  if (wie) return wie.length === 3 ? `besluit van de ${wie[1]} ${wie[2]}` : `besluit van ${wie[1]}`;
  const eerste = samenvatting.split(/(?<=\.)\s+(?=\p{Lu})/u)[0] || '';
  return eerste.length > 120 ? `${eerste.slice(0, 117).replace(/\s+\S*$/, '')}…` : eerste;
}

export async function haalUitspraken(bron) {
  return leesUitspraken(await haalTekst(bron.url));
}

// ---------- ransomware ----------

// "Dutch" zegt niets: dat staat ook bij Vlaamse slachtoffers.
const NL = /\b(netherlands|nederland)\b/i;
const isNl = (website, beschrijving) => /\.nl(\/|$)/i.test(String(website || '').trim()) || NL.test(String(beschrijving || ''));

// "Ransomware-aanval: B-accountants (everest)": het slachtoffer voorop, de groep die het claimt erachter.
export const ransomwareTitel = (slachtoffer, groep) => `Ransomware-aanval: ${slachtoffer}${groep ? ` (${groep})` : ''}`;

export function ransomwareStuk({ naam, groep, beschrijving, website, ontdekt }) {
  const schoon = String(naam || '').trim() || 'Onbekend slachtoffer';
  const moment = ontdekt ? new Date(String(ontdekt).replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1') + (/[Z+]/.test(String(ontdekt).slice(10)) ? '' : 'Z')) : null;
  return {
    sleutel: `${schoon.toLowerCase()}|${String(groep || '').toLowerCase()}`,
    titel: ransomwareTitel(schoon, groep),
    url: groep ? `https://www.ransomlook.io/group/${encodeURIComponent(groep)}` : 'https://www.ransomlook.io/recent',
    datum: moment && Number.isFinite(moment.getTime()) ? moment.toISOString().slice(0, 10) : null,
    tekst: [beschrijving, website ? `Website: ${website}.` : '', `Geclaimd door ${groep || 'een onbekende groep'} op een lekwebsite; nog niet bevestigd door het slachtoffer.`].filter(Boolean).join(' '),
    afzender: groep || null,
    // Voor het opzoeken van de vestiging (src/locatie.mjs).
    slachtoffer: { naam: schoon, website: website || null, beschrijving: beschrijving || null },
  };
}

// ransomlook.io: de honderd nieuwste slachtoffers wereldwijd, zonder land;
// Nederlands is een .nl-website of een beschrijving die Nederland noemt.
export function leesRansomlook(lijst) {
  return (Array.isArray(lijst) ? lijst : [])
    .filter((v) => isNl(v.website || v.url, v.description))
    .map((v) => ransomwareStuk({ naam: v.post_title, groep: v.group_name, beschrijving: v.description, website: v.website || v.url, ontdekt: v.discovered }));
}

// ransomware.live Pro: per land, met sleutel (RANSOMWARE_LIVE_API_KEY).
export function leesRansomwareLive(data) {
  return (data?.victims || []).map((v) => ransomwareStuk({ naam: v.victim, groep: v.group, beschrijving: v.description, website: v.website, ontdekt: v.discovered }));
}

export async function haalRansomware(bron) {
  const stukken = leesRansomlook(await haalJson(bron.url));
  const sleutel = process.env.RANSOMWARE_LIVE_API_KEY;
  if (sleutel) {
    const pro = await fetchPro(sleutel);
    for (const s of pro) if (!stukken.some((x) => x.sleutel === s.sleutel)) stukken.push(s);
  }
  return stukken;
}

async function fetchPro(sleutel) {
  const { fetch } = await import('undici');
  const { openbaarDispatcher } = await import('../netwerk.mjs');
  const r = await fetch('https://api-pro.ransomware.live/victims/?country=NL', {
    headers: { 'X-API-Key': sleutel, 'User-Agent': 'Regiochecker/1.0' }, dispatcher: openbaarDispatcher, signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`ransomware.live Pro gaf HTTP ${r.status}`);
  return leesRansomwareLive(await r.json());
}
