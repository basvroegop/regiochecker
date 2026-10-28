// Raadsvergaderingen als bron. Iedere gemeente publiceert haar vergaderingen
// via een ander platform; elk platform heeft hier een adapter met dezelfde drie
// taken: een geplakte URL herkennen, het archief uitlezen, en bij één
// vergadering de opname opzoeken. Overgenomen uit audioscraper (oktober 2026).
//
//   Company Webcast      channel.royalcast.com / channel.companywebcast.com
//   Notubiz              <gemeente>.raadsinformatie.nl (api.notubiz.nl + HLS-stream);
//                        <gemeente>.notubiz.nl verwijst naar hetzelfde archief
//   iBabs                <gemeente>.bestuurlijkeinformatie.nl met opnames in babscast;
//                        toont zo'n portaal Company Webcast, dan wordt het dat archief
//   GemeenteOplossingen  eigen gemeentedomein, herkend aan de open-data-API /api/v2/
//
// Een andere pagina (de raadspagina van een gemeentesite) mag ook: daarin
// zoeken we een link naar een van deze platforms.
//
// GemeenteOplossingen (Groningen) zet de vergaderpagina achter Anubis, een
// proof-of-work-poort. De agenda komt uit de open API; alleen het opzoeken van
// de bestandsnaam van de opname gaat langs de poort: één pagina per vergadering,
// met een eerlijke user-agent, de Crawl-delay uit de robots.txt van het portaal,
// en de verkregen cookie hergebruikt per portaal. Dat langs de poort gaan is een
// uitdrukkelijke keuze van de opdrachtgever (zie README, "Raadsvergaderingen").

import { createHash } from 'node:crypto';
import { haalJsonOpenbaar, haalTekstOpenbaar, UA } from './ophalen.mjs';
import { ontsnap, platteTekst } from '../html.mjs';

export const PLATFORMS = { companywebcast: 'Company Webcast', notubiz: 'Notubiz', ibabs: 'iBabs', gemeenteoplossingen: 'GemeenteOplossingen' };
const COMPANY_WEBCAST = new Set(['channel.royalcast.com', 'channel.companywebcast.com']);
const NOTUBIZ_PORTAAL = /\.raadsinformatie\.nl$/;
const NOTUBIZ_DOMEIN = /^([a-z0-9-]+)\.notubiz\.nl$/;
const IBABS_PORTAAL = /^[a-z0-9-]+\.bestuurlijkeinformatie\.nl$/;
const PAGINA = 100;
const MAX_PAGINAS = 40;
export const ARCHIEF_HULP = 'Gebruik het vergaderarchief van één gemeente, bijvoorbeeld https://hoogeveen.raadsinformatie.nl/, https://heerenveen.bestuurlijkeinformatie.nl/, https://gemeenteraad.groningen.nl/ of https://channel.royalcast.com/gemeenteopsterland/#!/archived';

const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
const twee = (n) => String(n).padStart(2, '0');
const jjjjmmdd = (d) => `${d.getFullYear()}${twee(d.getMonth() + 1)}${twee(d.getDate())}`;
const sqlTijd = (d) => `${d.getUTCFullYear()}-${twee(d.getUTCMonth() + 1)}-${twee(d.getUTCDate())} ${twee(d.getUTCHours())}:${twee(d.getUTCMinutes())}:${twee(d.getUTCSeconds())}`;

// "2026-10-23 19:30:00" in Nederlandse tijd → Date.
function lokaal(datum, tijd = '00:00:00') {
  const [j, m, d] = String(datum).split('-').map(Number);
  const [u, mi, s] = String(tijd).split(':').map(Number);
  if (!j || !m || !d) return null;
  const uit = new Date(j, m - 1, d, u || 0, mi || 0, s || 0);
  return Number.isFinite(uit.getTime()) ? uit : null;
}

const item = (velden, start) => ({
  ...velden,
  vorm: 'vergadering',
  gepubliceerd: start ? jjjjmmdd(start) : null,
  gepubliceerdOp: start ? start.getTime() / 1000 : null,
  _sort: start ? start.getTime() : 0,
});

// Is dit een vergaderarchief? Geeft { kind, url } of null. Met scope
// 'meetings' (de beheerder koos "raadsvergadering") gooit het bij een onbekend
// platform. `doorverwezen`: het adres kwam uit een gemeentepagina; niet verder zoeken.
export async function herken(url, scope = 'auto', { doorverwezen = false } = {}) {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  if (COMPANY_WEBCAST.has(host)) {
    const klant = u.pathname.split('/').filter(Boolean)[0];
    if (!klant || !/^[a-z0-9][a-z0-9_-]{1,60}$/i.test(klant)) throw new Error(ARCHIEF_HULP);
    return { kind: 'companywebcast', url: `https://${host}/${klant}/` };
  }
  // Een Notubiz-portaal is één gemeente: elke pagina erbinnen hoort bij hetzelfde archief.
  if (NOTUBIZ_PORTAAL.test(host)) return { kind: 'notubiz', url: `${u.protocol}//${u.host}/` };
  if (NOTUBIZ_DOMEIN.test(host)) return notubizDomein(host);
  if (IBABS_PORTAAL.test(host)) return ibabsHerken(u);
  const portaal = await goPortaal(`${u.protocol}//${u.host}/`);
  if (portaal) return { kind: 'gemeenteoplossingen', url: portaal };
  if (!doorverwezen) {
    const elders = await platformOpPagina(u.href);
    if (elders) return herken(elders, scope, { doorverwezen: true });
  }
  if (scope === 'meetings') throw new Error(`Dit vergaderplatform wordt nog niet ondersteund. ${ARCHIEF_HULP}`);
  return null;
}

// Een gemeentepagina die naar haar vergaderarchief linkt: het eerste platform
// in deze volgorde (een eigen videokanaal gaat voor een documentportaal).
const VERWIJZINGEN = [
  /https?:\/\/channel\.(?:royalcast|companywebcast)\.com\/[a-z0-9][a-z0-9_-]{1,60}\b/i,
  /https?:\/\/[a-z0-9-]+\.raadsinformatie\.nl\b/i,
  /https?:\/\/(?!(?:www|api|media)\.)[a-z0-9-]+\.notubiz\.nl\b/i,
  /https?:\/\/[a-z0-9-]+\.bestuurlijkeinformatie\.nl\b/i,
];

async function platformOpPagina(url) {
  let pagina;
  try {
    pagina = await haalTekstOpenbaar(url, { tijd: 20_000 });
  } catch {
    return null;
  }
  for (const patroon of VERWIJZINGEN) {
    const gevonden = patroon.exec(pagina)?.[0];
    if (gevonden) return gevonden;
  }
  return null;
}

// `proef`: alleen een eerste indruk (bij "Controleer" in Beheer); een platform
// dat per vergadering een pagina moet lezen, stopt dan na een paar treffers.
export function ontdek(bron, { proef = false } = {}) {
  if (bron.audio.kind === 'notubiz') return notubizOntdek(bron);
  if (bron.audio.kind === 'ibabs') return ibabsOntdek(bron, { proef });
  if (bron.audio.kind === 'gemeenteoplossingen') return goOntdek(bron);
  return webcastOntdek(bron);
}

// Het actuele media-adres van één vergadering: { adres, velden, stream }.
// Elk platform bouwt die link per bezoek opnieuw, dus niet bewaren.
// `velden.platform` is wat het platform zelf over de opname weet, met tijden
// in seconden vanaf het begin van de opname:
//   agenda    [{ titel, start, eind }]          Company Webcast, Notubiz, babscast
//   sprekers  [{ naam, rol, momenten: [[start, eind], …] }]   Company Webcast, Notubiz
export async function mediaVoor(af) {
  try {
    const media = af.extern.startsWith('ntb:') ? await notubizMedia(af)
      : af.extern.startsWith('go:') ? await goMedia(af)
        : af.extern.startsWith('ibabs:') ? await ibabsMedia(af)
          : await webcastMedia(af);
    if (media.velden?.platform) media.velden.platform.versie = PLATFORM_VERSIE;
    return media;
  } catch (fout) {
    // Vlak na een vergadering staat de opname er vaak nog niet: dan later
    // nog eens kijken (src/audio/verwerking.mjs), zonder dat als mislukte poging te tellen.
    const moment = Date.parse(af.gepubliceerd || '');
    if (fout.geenOpname && Number.isFinite(moment) && Date.now() - moment < OPNAME_WACHT_DAGEN * 86400_000) {
      fout.later = OPNAME_OPNIEUW_S;
      fout.message = `${fout.message} Misschien komt die nog: nieuwe poging over ${OPNAME_OPNIEUW_S / 3600} uur.`;
    }
    throw fout;
  }
}

// Gaat omhoog als er meer uit een platform komt dan eerst (2: de sprekers van
// Notubiz); opnames die al klaar waren, krijgen dat dan alsnog (src/audio/verwerking.mjs).
export const PLATFORM_VERSIE = 2;
// Platforms die sprekers kunnen geven. Notubiz vult de spreekmomenten vaak pas
// dagen na de vergadering in.
export const PLATFORM_MET_SPREKERS = ['cwc:', 'ntb:'];

// Alleen agenda en sprekers, voor een opname die al binnen is. Geeft
// { agenda, sprekers } (leeg als het platform niets weet), of null bij een fout.
export async function platformVoor(af) {
  if (af.vorm !== 'vergadering') return null;
  try {
    return (await mediaVoor(af)).velden?.platform || { agenda: [], sprekers: [], versie: PLATFORM_VERSIE };
  } catch {
    return null;
  }
}

const OPNAME_WACHT_DAGEN = 3;
const OPNAME_OPNIEUW_S = 3 * 3600;
const geenOpname = (tekst) => Object.assign(new Error(tekst), { geenOpname: true });

// ---------- Company Webcast ----------

const WEBCAST_CODE = /^[A-Za-z0-9_-]{1,40}\/[A-Za-z0-9_-]{1,40}$/;
const moment = (waarde) => {
  const m = /\/Date\((-?\d+)/.exec(String(waarde || ''));
  return m ? new Date(Number(m[1])) : null;
};
const klantNaam = (it) => String(it.customerName || '').trim().replace(/\s+webcasts?$/i, '');

function webcastItem(host, it) {
  const code = String(it.code || '').trim();
  if (!WEBCAST_CODE.test(code)) return null;
  const soort = (it.tags || []).map(String).find((t) => t.toLowerCase().startsWith('type:'))?.split(':').slice(1).join(':').trim();
  return item({
    extern: `cwc:${code}`,
    url: `https://${host}/${code.split('/')[0]}/#!/${code}`,
    titel: String(it.title || '').trim() || 'Vergadering',
    auteur: soort || klantNaam(it),
  }, moment(it.scheduledStart));
}

async function webcastOntdek(bron) {
  const u = new URL(bron.url);
  const host = u.hostname.toLowerCase();
  const klant = u.pathname.split('/').filter(Boolean)[0];
  if (!COMPANY_WEBCAST.has(host) || !klant) throw new Error(ARCHIEF_HULP);
  // Een vaste, ruime omvang van de catalogus: een wisselende omvang zou oudere
  // vergaderingen bij een volgende controle alsnog als nieuw in de wachtrij zetten.
  const limiet = Number(bron.audio.eersteImport ?? 3);
  const max = limiet ? Math.max(PAGINA, limiet) : 0;
  const items = [];
  let titel = '';
  for (let p = 0; p < MAX_PAGINAS; p++) {
    const data = await haalJsonOpenbaar(`https://${host}/portal/api/1.0/${klant}/portalwebcasts/?${new URLSearchParams({ pageNumber: p, pageSize: PAGINA, status: 'indexed', ordering: 'startDesc' })}`);
    const lijst = data.List || [];
    for (const it of lijst) {
      const gevonden = webcastItem(host, it);
      if (gevonden) items.push(gevonden);
      titel ||= klantNaam(it);
    }
    if (!lijst.length || !data.HasNextPage || (max && items.length >= max)) break;
  }
  if (!items.length) throw new Error('Geen afgeronde vergaderingen gevonden in dit archief.');
  return { titel: titel || klant, items: items.sort((a, b) => b._sort - a._sort) };
}

async function webcastMedia(af) {
  const host = new URL(af.url).hostname.toLowerCase();
  const code = af.extern.slice(4);
  if (!COMPANY_WEBCAST.has(host) || !WEBCAST_CODE.test(code)) throw new Error('Deze vergadering heeft geen herkenbare bronverwijzing meer.');
  const klant = code.split('/')[0];
  const d = await haalJsonOpenbaar(`https://${host}/portal/api/1.0/${klant}/webcasts/${code}?method=GET&key=`);
  const bijlagen = (d.attachments || []).filter((a) => a.location);
  // Liever de audio; anders de video, waar ffmpeg het geluid uit haalt.
  const gekozen = bijlagen.find((a) => String(a.contentType || '').startsWith('audio/')) || bijlagen.find((a) => a.contentType === 'video/mp4');
  if (!gekozen) throw geenOpname('Deze vergadering biedt geen downloadbare opname aan.');
  const begin = moment(d.actualStart);
  const eind = moment(d.actualEnd);
  const velden = { platform: webcastPlatform(d, begin) };
  if (String(d.title || '').trim()) velden.titel = d.title.trim();
  if (begin && eind && eind > begin) velden.duur = (eind - begin) / 1000;
  return { adres: gekozen.location, velden, stream: false };
}

// Agendapunten (topics) en sprekers met hun spreekmomenten. Company Webcast
// geeft kloktijden; de opname begint bij actualStart.
export function webcastPlatform(d, begin = moment(d.actualStart)) {
  if (!begin) return { agenda: [], sprekers: [] };
  const sec = (waarde) => {
    const t = moment(waarde);
    return t ? Math.max(0, Math.round((t - begin) / 100) / 10) : null;
  };
  const agenda = (d.topics || []).map((t) => {
    const ev = (t.events || []).find((e) => e.start);
    return { titel: String(t.title || '').trim(), start: ev ? sec(ev.start) : null, eind: ev ? sec(ev.end) : null };
  }).filter((t) => t.titel && t.start !== null).sort((a, b) => a.start - b.start);
  const sprekers = (d.speakers || []).map((s) => ({
    naam: [s.name?.title, s.name?.first, s.name?.middle, s.name?.last].map((x) => String(x || '').trim()).filter(Boolean).join(' '),
    rol: String(s.role || s.category || '').trim() || null,
    momenten: (s.events || []).map((e) => [sec(e.start), sec(e.end)]).filter(([a, b]) => a !== null && b !== null && b > a),
  })).filter((s) => s.naam && s.momenten.length);
  return { agenda, sprekers };
}

// ---------- Notubiz ----------

const NOTUBIZ_API = process.env.NOTUBIZ_API || 'https://api.notubiz.nl';
const NOTUBIZ_VERSIE = '1.10.8';
const NOTUBIZ_MEDIA = /\.notubiz\.nl$/;
const NOTUBIZ_CODE = /^\d{1,9}\/\d{1,12}$/;
const ORGANISATIE = /organisation[-_]id["']?\s*[:=]\s*["']?(\d{1,9})/;
// De speler zet zijn bronnen als losse blokken in de paginabron: de opname staat in media_files.
const MEDIA_BLOK = /media_file\s*=\s*\{([^{}]*)\};\s*media_files\[/g;
const MEDIA_VELD = /\b(pubpoint|streamname)\s*:\s*"([^"]*)"/g;
const SPELER_TITEL = /\btitle\s*:\s*"([^"]+)"/;
const NOTUBIZ_JAREN = 20;
const NOTUBIZ_RECENT = 400;
const NOTUBIZ_MARGE_UUR = 12;

const notubiz = (pad, query = {}) => haalJsonOpenbaar(`${NOTUBIZ_API}/${pad}?${new URLSearchParams({ format: 'json', version: NOTUBIZ_VERSIE, ...query })}`);
const notubizAttribuut = (it, id = 1) => String((it.attributes || []).find((a) => a.id === id)?.value || '').trim();
const notubizStart = (it) => {
  const s = String(((it.plannings || [])[0] || {}).start_date || '');
  const [datum, tijd] = s.split(' ');
  return lokaal(datum, tijd);
};

async function notubizEvents(org, van, tot) {
  const uit = [];
  for (let p = 1; p <= MAX_PAGINAS; p++) {
    const data = await notubiz('events', { organisation_id: org, per_page: 200, page: p, date_from: sqlTijd(van), date_to: sqlTijd(tot) });
    uit.push(...(data.events || []));
    if (!data.pagination?.has_more_pages) break;
  }
  return uit;
}

const notubizItem = (portaal, org, vergadering, titel, auteur, start) => item({
  extern: `ntb:${org}/${vergadering}`,
  url: `${portaal}vergadering/${vergadering}`,
  titel: titel || 'Vergadering',
  auteur,
}, start);

async function notubizItems(portaal, org, gremia, ev) {
  // Niet openbaar of niet uitgezonden: dan is er ook geen opname.
  if (ev.permission_group !== 'public' || !ev.live || ev.canceled || ev.inactive) return [];
  const titel = notubizAttribuut(ev);
  const auteur = gremia.get(ev.gremium?.id) || '';
  const start = notubizStart(ev);
  if (ev.type !== 'assembly') return [notubizItem(portaal, org, ev.id, titel, auteur, start)];
  // Een raadsavond is een omslag om de zalen waarin tegelijk wordt vergaderd;
  // elke zaal heeft een eigen opname. De naam van een zaal volgt bij het downloaden.
  const zalen = (await notubiz(`events/assemblies/${ev.id}`)).assembly?.meetings || [];
  return zalen.map((z, n) => notubizItem(portaal, org, z.id, zalen.length === 1 ? titel : `${titel} · deel ${n + 1}`, auteur, notubizStart(z) || start));
}

async function notubizOntdek(bron) {
  const portaal = bron.url;
  if (!NOTUBIZ_PORTAAL.test(new URL(portaal).hostname)) throw new Error(ARCHIEF_HULP);
  // De organisatie staat op het portaal; daarna onthouden, want het portaal zit
  // sinds 28 oktober 2026 achter een Cloudflare-controle (de API niet).
  const org = bron.audio.organisatie || ORGANISATIE.exec(await haalTekstOpenbaar(portaal))?.[1];
  if (!org) throw new Error('Dit raadsinformatieportaal noemt geen Notubiz-organisatie.');
  bron.audio.organisatie = org;
  const gremia = new Map(((await notubiz(`organisations/${org}/gremia`)).gremia || []).map((g) => [g.id, String(g.title || '').trim()]));
  const limiet = Number(bron.audio.eersteImport ?? 3);
  const max = limiet ? Math.max(PAGINA, limiet) : 0;
  const nu = new Date();
  // De agenda kondigt een uitzending vooraf aan: pas twaalf uur na de start meetellen.
  const rand = new Date(nu - NOTUBIZ_MARGE_UUR * 3600_000);
  const vensters = bron.audio.geinitialiseerd
    // Een vervolgcontrole kijkt alleen de laatste maanden na; dat valt binnen de eerste import.
    ? [[new Date(nu - NOTUBIZ_RECENT * 86400_000), nu]]
    : Array.from({ length: NOTUBIZ_JAREN }, (_, i) => {
      const jaar = nu.getUTCFullYear() - i;
      return [new Date(Date.UTC(jaar, 0, 1)), new Date(Date.UTC(jaar, 11, 31, 23, 59, 59))];
    });
  const items = [];
  for (const [van, tot] of vensters) {
    const eind = tot < rand ? tot : rand;
    if (van >= eind) continue;
    for (const ev of await notubizEvents(org, van, eind)) items.push(...await notubizItems(portaal, org, gremia, ev));
    // De eerste import dekt minstens het venster van een vervolgcontrole: anders
    // komen oudere vergaderingen daarbij alsnog als nieuw binnen.
    if (max && items.length >= max && (bron.audio.geinitialiseerd || van <= nu - NOTUBIZ_RECENT * 86400_000)) break;
  }
  if (!items.length) throw new Error('Geen uitgezonden vergaderingen gevonden in dit archief.');
  const titel = String((await notubiz(`organisations/${org}`)).organisation?.name || '').trim();
  return { titel: titel || new URL(portaal).hostname, items: items.sort((a, b) => b._sort - a._sort) };
}

// <gemeente>.notubiz.nl is een nieuwere voorkant van hetzelfde archief. Die zit
// achter een botcontrole; het raadsinformatieportaal van de gemeente niet.
async function notubizDomein(host) {
  const gemeente = NOTUBIZ_DOMEIN.exec(host)[1];
  const portaal = `https://${gemeente}.raadsinformatie.nl/`;
  let org = null;
  try {
    org = ORGANISATIE.exec(await haalTekstOpenbaar(portaal, { tijd: 20_000 }))?.[1];
  } catch { /* geen portaal onder die naam */ }
  if (!org) throw new Error(`Bij ${host} hoort geen bereikbaar raadsinformatieportaal (${gemeente}.raadsinformatie.nl). ${ARCHIEF_HULP}`);
  return { kind: 'notubiz', url: portaal };
}

// De opname volgens de API (/media?event_id=…): een streamer en een streamnaam,
// zoals rtmp://wowza1.notubiz.nl/nbvod/_definst_ en Gemeente/bestanden/Raad.mp4.
export function notubizApiStream(data) {
  for (const m of data?.media || []) {
    if (!m.streamer || !m.stream_name) continue;
    const stream = `${m.streamer.replace(/^rtmps?:\/\//, 'https://')}/${m.stream_name.split('/').map(encodeURIComponent).join('/')}/playlist.m3u8`;
    if (!NOTUBIZ_MEDIA.test(new URL(stream).hostname.toLowerCase())) throw new Error('Deze vergadering verwijst naar een onbekende mediaserver.');
    return stream;
  }
  return null;
}

export function notubizStream(pagina) {
  for (const [, blok] of String(pagina).matchAll(MEDIA_BLOK)) {
    const velden = Object.fromEntries([...blok.matchAll(MEDIA_VELD)].map((m) => [m[1], m[2]]));
    if (!velden.pubpoint || !velden.streamname) continue;
    const stream = `${velden.pubpoint.replace(/^rtmps?:\/\//, 'https://')}/${velden.streamname}/playlist.m3u8`;
    if (!NOTUBIZ_MEDIA.test(new URL(stream).hostname.toLowerCase())) throw new Error('Deze vergadering verwijst naar een onbekende mediaserver.');
    return stream;
  }
  throw geenOpname('Deze vergadering biedt geen opname aan.');
}

async function notubizMedia(af) {
  const host = new URL(af.url).hostname.toLowerCase();
  const code = af.extern.slice(4);
  if (!NOTUBIZ_PORTAAL.test(host) || !NOTUBIZ_CODE.test(code)) throw new Error('Deze vergadering heeft geen herkenbare bronverwijzing meer.');
  const vergadering = code.split('/')[1];
  // De opname en de agenda uit de API. De vergaderpagina (wie wanneer sprak, de
  // volledige titel) zit sinds 28 oktober 2026 achter een Cloudflare-controle:
  // die alleen als hij lukt, en daar niet omheen.
  let pagina = null;
  try {
    pagina = await haalTekstOpenbaar(af.url);
  } catch { /* achter de controle */ }
  let stream = null;
  try {
    stream = notubizApiStream(await notubiz('media', { event_id: vergadering }));
  } catch (fout) {
    if (/onbekende mediaserver/.test(fout.message)) throw fout;
  }
  if (!stream && pagina) stream = notubizStream(pagina);
  if (!stream) throw geenOpname('Deze vergadering biedt geen opname aan.');
  // De speler kent de volledige naam van deze zaal of vergadering wél.
  const titel = pagina && SPELER_TITEL.exec(pagina.slice(Math.max(0, pagina.indexOf('createPlayer'))))?.[1]?.trim();
  const velden = titel ? { titel } : {};
  let agenda = [];
  try {
    agenda = notubizAgenda((await notubiz(`events/meetings/${vergadering}`)).meeting);
  } catch { /* zonder agenda gaat het ook */ }
  velden.platform = { agenda, sprekers: pagina ? notubizSprekers(pagina) : [] };
  // Een raadsopname is video van gigabytes: alleen het geluid van de stream halen.
  return { adres: stream, velden, stream: true };
}

// Agendapunten met hun tijd in de opname (start_offset in seconden), ook de
// punten onder een kopje. "4 Kapitaalgoederen Smallingerland 2027-2030".
export function notubizAgenda(vergadering) {
  const uit = [];
  const loop = (punten) => {
    for (const p of punten || []) {
      const titel = [p.type_data?.title_prefix, notubizAttribuut(p.type_data || {})].map((x) => String(x || '').trim()).filter(Boolean).join(' ');
      const start = Number.parseFloat(p.start_offset);
      const eind = Number.parseFloat(p.end_offset);
      if (titel && Number.isFinite(start)) uit.push({ titel, start, eind: Number.isFinite(eind) && eind > start ? eind : null });
      loop(p.agenda_items);
    }
  };
  loop(vergadering?.agenda_items);
  return uit.sort((a, b) => a.start - b.start);
}

// Wie wanneer sprak: de pagina zet onder elk agendapunt de spreekmomenten
// ("Nu aan het woord"), met tijden in seconden vanaf het begin van de opname:
//   <li class="speaker_index" data-speaker_id="164999" data-start_offset="14"
//       data-end_offset="88"> … spreker: Vries de, Jannewietske (burgemeester) …
// De API geeft die niet.
const SPREEKMOMENT = /<li\b[^>]*\bclass="speaker_index\b[^"]*"([^>]*)>([\s\S]*?)<\/li>/g;
const DATA_VELD = (naam) => new RegExp(`\\bdata-${naam}="([^"]*)"`);

export function notubizSprekers(pagina) {
  const sprekers = new Map();
  for (const [, attributen, inhoud] of String(pagina).matchAll(SPREEKMOMENT)) {
    const id = DATA_VELD('speaker_id').exec(attributen)?.[1];
    const start = Number.parseFloat(DATA_VELD('start_offset').exec(attributen)?.[1]);
    const eind = Number.parseFloat(DATA_VELD('end_offset').exec(attributen)?.[1]);
    const tekst = platteTekst(inhoud.replace(/<span class="item_time"[\s\S]*$/, '')).replace(/^spreker:\s*/i, '');
    const [, naam, rol] = /^(.*?)\s*(?:\(([^()]*)\))?$/.exec(tekst) || [];
    if (!id || !naam || !Number.isFinite(start) || !(eind > start)) continue;
    if (!sprekers.has(id)) sprekers.set(id, { naam: notubizNaam(naam), rol: rol?.trim() || null, momenten: [] });
    const { momenten } = sprekers.get(id);
    if (!momenten.some(([a, b]) => a === start && b === eind)) momenten.push([start, eind]);
  }
  for (const s of sprekers.values()) s.momenten.sort((a, b) => a[0] - b[0]);
  return [...sprekers.values()];
}

// Notubiz zet de achternaam voorop, met het tussenvoegsel nu eens achter de
// achternaam, dan weer achter de voornaam: "Vries de, Jannewietske",
// "Groot, Jelmer de". Allebei "voornaam tussenvoegsel achternaam".
const TUSSENVOEGSEL = /^(?:van|de|der|den|het|'t|te|ten|ter|in|op|aan|uit|la|le|du|d'|da|del|dos|von|vom|zu)$/;
export function notubizNaam(naam) {
  const delen = String(naam).split(',').map((d) => d.trim().split(/\s+/).filter(Boolean));
  if (delen.length !== 2 || !delen[0].length || !delen[1].length) return String(naam).trim();
  const [achter, voor] = delen;
  const tussen = (d) => {
    const uit = [];
    while (d.length > 1 && TUSSENVOEGSEL.test(d.at(-1))) uit.unshift(d.pop());
    return uit;
  };
  const voorTussen = tussen(voor);
  const achterTussen = tussen(achter);
  return [...voor, ...voorTussen, ...achterTussen, ...achter].join(' ');
}

// ---------- iBabs ----------
//
// Een iBabs-publieksportaal toont bij elke vergadering een spelerblok:
//   <div class="cwc" data-video-type="iBabsStream" data-video-url="https://player.babscast.com/<event>">
// of, bij gemeenten die Company Webcast gebruiken, data-video-type="Cwc" met
// data-video-id="<kanaal>/<code>". Het eerste wordt hier een iBabs-bron: de
// agenda komt uit de kalender van het portaal, de opname uit de openbare
// babscast-API (afgelopen uitzendingen hebben daar een HLS-afspeellijst).
// Het tweede wordt gewoon het Company Webcast-archief van die gemeente.
//
// Of een vergadering een opname heeft, staat alleen op haar eigen pagina. De
// portalen vragen 5 seconden tussen verzoeken (robots.txt); we onthouden dus
// wat we al zagen, en slaan agendasoorten over die nooit een speler tonen
// (zoals "Openbaarmaking collegevergadering").

const ibabsWacht = () => Number(process.env.IBABS_WACHT_MS ?? 5000); // Crawl-delay uit robots.txt
const IBABS_MARGE_UUR = 12;
const IBABS_RECENT = 120; // dagen die een vervolgcontrole nakijkt
const IBABS_JAREN = 15;
const IBABS_VENSTER = 182; // dagen per kalenderverzoek
const IBABS_PROEF = 3;
const BABSCAST = process.env.BABSCAST_API || 'https://player.babscast.com';
const BABSCAST_MEDIA = /(^|\.)babscast\.com$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SPELERBLOK = /<div\b[^>]*\bclass="cwc"[^>]*>/i;
const ibabsBlokken = new Map(); // <host>/<agenda> → spelerblok of null (alleen van afgelopen vergaderingen)
const ibabsZonder = new Map(); // <host>/<agendasoort> → afgelopen vergaderingen zonder speler (Set)
const ibabsMet = new Set(); // <host>/<agendasoort> met minstens één speler
const ibabsSoorten = new Map(); // <host> → { tijd, namen: Map }
const beurten = new Map(); // host → tijdstip waarop het volgende verzoek mag

async function ibabsBeurt(host) {
  const wacht = (beurten.get(host) || 0) - Date.now();
  beurten.set(host, Math.max(Date.now(), beurten.get(host) || 0) + ibabsWacht());
  if (wacht > 0) await slaap(wacht);
}

const ibabsTekst = async (portaal, pad) => {
  await ibabsBeurt(new URL(portaal).host);
  return haalTekstOpenbaar(new URL(pad, portaal).href, { tijd: 30_000 });
};

const isoLokaal = (d) => `${d.getFullYear()}-${twee(d.getMonth() + 1)}-${twee(d.getDate())}T00:00:00`;

// De vergaderingen tussen twee momenten, nieuwste eerst: { id, titel, soort, start }.
async function ibabsKalender(portaal, van, tot) {
  const lijst = JSON.parse(await ibabsTekst(portaal, `/Calendar/GetAgendasForCalendar?${new URLSearchParams({ start: isoLokaal(van), end: isoLokaal(tot) })}`));
  return (Array.isArray(lijst) ? lijst : [])
    .filter((v) => UUID.test(String(v.id || '')))
    .map((v) => {
      const [datum, tijd] = String(v.start || '').split('T');
      return {
        id: v.id.toLowerCase(),
        titel: String(v.title || '').trim(),
        soort: /agendatype-(\d+)/.exec((v.classNames || []).join(' '))?.[1] || '',
        start: lokaal(datum, tijd),
      };
    })
    .filter((v) => v.start)
    .sort((a, b) => b.start - a.start);
}

// De namen van de agendasoorten ("Commissie Leefomgeving"), uit de kalenderpagina.
async function ibabsSoortnamen(portaal) {
  const host = new URL(portaal).host;
  const bewaard = ibabsSoorten.get(host);
  if (bewaard && Date.now() - bewaard.tijd < 86400_000) return bewaard.namen;
  const namen = new Map();
  try {
    const pagina = await ibabsTekst(portaal, '/Calendar');
    for (const [, id, inhoud] of pagina.matchAll(/href="\/Calendar\/OpenCategory\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g)) {
      const naam = ontsnap(inhoud.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      if (naam && !namen.has(id)) namen.set(id, naam);
    }
  } catch { /* zonder namen gaat het ook */ }
  ibabsSoorten.set(host, { tijd: Date.now(), namen });
  return namen;
}

export function ibabsSpelerblok(pagina) {
  const blok = SPELERBLOK.exec(String(pagina))?.[0];
  if (!blok) return null;
  const attr = (naam) => ontsnap(new RegExp(`\\bdata-video-${naam}="([^"]*)"`, 'i').exec(blok)?.[1] || '').trim();
  const type = attr('type');
  if (type === 'Cwc') return WEBCAST_CODE.test(attr('id')) ? { type: 'companywebcast', code: attr('id') } : null;
  if (type === 'iBabsStream') {
    let adres;
    try { adres = new URL(attr('url')); } catch { return null; }
    const event = adres.pathname.split('/').filter(Boolean)[0] || '';
    return BABSCAST_MEDIA.test(adres.hostname) && UUID.test(event) ? { type: 'babscast', event: event.toLowerCase() } : null;
  }
  return null;
}

async function ibabsBlok(portaal, agenda, { afgelopen = true } = {}) {
  const sleutel = `${new URL(portaal).host}/${agenda}`;
  if (ibabsBlokken.has(sleutel)) return ibabsBlokken.get(sleutel);
  const blok = ibabsSpelerblok(await ibabsTekst(portaal, `/Agenda/Index/${agenda}`));
  // Een toekomstige vergadering kan haar speler nog krijgen.
  if (afgelopen) ibabsBlokken.set(sleutel, blok);
  return blok;
}

// Eén uitzending in babscast, of null als die niet openbaar is (een besloten
// sessie geeft 401 of 403). De API geeft ook een kortlevend toegangstoken voor
// de speler mee; dat gebruiken en bewaren we niet.
async function babscastEvent(event) {
  let d;
  try {
    d = await haalJsonOpenbaar(`${BABSCAST}/audience/v1/events/${event}`, { tijd: 30_000 });
  } catch (fout) {
    if (/HTTP (401|403|404)$/.test(fout.message)) return null;
    throw fout;
  }
  const m = d.EventMetadata || {};
  const tijd = (t) => {
    const ms = Date.parse(t || '');
    return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
  };
  return {
    status: String(d.EventStatus || ''),
    openbaar: d.IsPrivate !== true,
    titel: String(d.Title || '').trim(),
    gemeente: String(d.ClientName || '').trim(),
    begin: tijd(d.ActualStart),
    eind: tijd(d.ActualEnd),
    afspeellijst: String(m.PlayListUrl || ''),
    // De tijdlijn: agendapunten met hun tijd in de opname ("00:58:24.8650000").
    agenda: (d.TimelineEvents || []).filter((t) => t.EventType === 'Topic' && t.TextRepresentation).map((t) => ({
      titel: String(t.TextRepresentation).trim(), start: duurTijd(t.StartOffset), eind: duurTijd(t.EndOffset),
    })).filter((t) => t.start !== null).sort((a, b) => a.start - b.start),
  };
}

function duurTijd(tekst) {
  const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(String(tekst || ''));
  return m ? Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 10) / 10 : null;
}

// Raads- en commissievergaderingen eerst: die worden het vaakst uitgezonden.
const raadEerst = (lijst) => [...lijst].sort((a, b) => Number(!/raad|commissie/i.test(a.titel)) - Number(!/raad|commissie/i.test(b.titel)));

async function ibabsHerken(u) {
  const portaal = `https://${u.host.toLowerCase()}/`;
  const geplakt = /^\/Agenda\/Index\/([0-9a-f-]{36})/i.exec(u.pathname)?.[1];
  const rand = new Date(Date.now() - IBABS_MARGE_UUR * 3600_000);
  const recent = await ibabsKalender(portaal, new Date(rand - IBABS_RECENT * 86400_000), new Date(rand.getTime() + 86400_000));
  const kandidaten = [
    ...(geplakt && UUID.test(geplakt) ? [{ id: geplakt.toLowerCase(), start: null }] : []),
    ...raadEerst(recent.filter((v) => v.start < rand)),
  ];
  for (const v of kandidaten.slice(0, 6)) {
    const blok = await ibabsBlok(portaal, v.id, { afgelopen: Boolean(v.start) });
    if (blok?.type === 'companywebcast') return { kind: 'companywebcast', url: `https://channel.royalcast.com/${blok.code.split('/')[0]}/` };
    if (blok?.type === 'babscast') return { kind: 'ibabs', url: portaal };
  }
  throw new Error('Bij de recente vergaderingen in dit iBabs-portaal staat geen opname. Gebruikt de gemeente een ander videokanaal, plak dan dat adres.');
}

async function ibabsOntdek(bron, { proef = false } = {}) {
  const portaal = bron.url;
  const host = new URL(portaal).host;
  if (!IBABS_PORTAAL.test(new URL(portaal).hostname)) throw new Error(ARCHIEF_HULP);
  const limiet = Number(bron.audio.eersteImport ?? 3);
  const nu = Date.now();
  const rand = new Date(nu - IBABS_MARGE_UUR * 3600_000);
  const grens = new Date(nu - (bron.audio.geinitialiseerd ? IBABS_RECENT : IBABS_JAREN * 365) * 86400_000);
  const namen = proef ? new Map() : await ibabsSoortnamen(portaal);
  const items = [];
  const gehad = new Set();
  let gemeente = '';
  let leeg = 0;
  for (let tot = rand; tot > grens;) {
    const van = new Date(Math.max(grens, tot - IBABS_VENSTER * 86400_000));
    // De kalender rekent in hele dagen: een dag extra, en dubbele eruit.
    const lijst = (await ibabsKalender(portaal, van, new Date(tot.getTime() + 86400_000))).filter((v) => v.start < rand && !gehad.has(v.id));
    for (const v of proef ? raadEerst(lijst) : lijst) {
      gehad.add(v.id);
      const soort = `${host}/${v.soort}`;
      const zonder = ibabsZonder.get(soort) || new Set();
      // Een soort die drie keer geen speler had, slaan we over; de laatste maand blijven we kijken.
      if (!ibabsMet.has(soort) && zonder.size >= 3 && v.start < nu - 30 * 86400_000) continue;
      const blok = await ibabsBlok(portaal, v.id);
      if (blok?.type !== 'babscast') {
        if (!blok) ibabsZonder.set(soort, zonder.add(v.id));
        continue;
      }
      ibabsMet.add(soort);
      const ev = await babscastEvent(blok.event);
      // Nog niet gearchiveerd: de volgende controle ziet hem dan wel. Besloten: nooit.
      if (!ev || ev.status !== 'Archived' || !ev.openbaar || !ev.afspeellijst) continue;
      gemeente ||= ev.gemeente;
      items.push(item({
        extern: `ibabs:${host}/${v.id}`,
        url: `${portaal}Agenda/Index/${v.id}`,
        titel: ev.titel || v.titel || 'Vergadering',
        auteur: namen.get(v.soort) || '',
        duur: ev.begin && ev.eind && ev.eind > ev.begin ? (ev.eind - ev.begin) / 1000 : null,
      }, v.start));
      if (proef && items.length >= IBABS_PROEF) break;
    }
    if (proef && items.length >= IBABS_PROEF) break;
    leeg = lijst.length ? 0 : leeg + 1;
    // Twee lege halve jaren: verder terug heeft dit portaal niets.
    if (leeg >= 2) break;
    // De eerste import: genoeg gevonden, en minstens het venster van een vervolgcontrole gedekt.
    if (!bron.audio.geinitialiseerd && limiet && items.length >= limiet && nu - van >= IBABS_RECENT * 86400_000) break;
    tot = van;
  }
  if (!items.length) throw new Error('Geen uitgezonden vergaderingen gevonden in dit iBabs-portaal.');
  return { titel: gemeente ? `Gemeente ${gemeente}` : host, items: items.sort((a, b) => b._sort - a._sort), deels: proef };
}

async function ibabsMedia(af) {
  const u = new URL(af.url);
  const agenda = af.extern.slice(`ibabs:${u.host}/`.length);
  if (!af.extern.startsWith(`ibabs:${u.host}/`) || !IBABS_PORTAAL.test(u.hostname) || !UUID.test(agenda)) throw new Error('Deze vergadering heeft geen herkenbare bronverwijzing meer.');
  const blok = await ibabsBlok(`https://${u.host}/`, agenda);
  if (blok?.type !== 'babscast') throw geenOpname('Deze vergadering biedt geen opname aan.');
  const ev = await babscastEvent(blok.event);
  if (!ev || !ev.openbaar) throw new Error('Deze vergadering heeft geen openbare opname.');
  if (ev.status !== 'Archived' || !ev.afspeellijst) throw geenOpname('De opname van deze vergadering is nog niet beschikbaar.');
  const adres = new URL(ev.afspeellijst);
  if (adres.protocol !== 'https:' || !BABSCAST_MEDIA.test(adres.hostname)) throw new Error('Deze vergadering verwijst naar een onbekende mediaserver.');
  const velden = { platform: { agenda: ev.agenda, sprekers: [] } };
  if (ev.titel) velden.titel = ev.titel;
  if (ev.begin && ev.eind && ev.eind > ev.begin) velden.duur = (ev.eind - ev.begin) / 1000;
  // Video in HLS: alleen het geluid van de stream halen.
  return { adres: adres.href, velden, stream: true };
}

// ---------- GemeenteOplossingen ----------

const GO_MEDIA = /https:\/\/[a-z0-9.-]+\.gemeenteoplossingen\.nl\/[^"'\s]+\.mp3/;
const GO_MAX = 5000;
const GO_RECENT = 400;
const GO_MARGE_UUR = 12;
const GO_WACHT_MS = Number(process.env.GO_WACHT_MS ?? 2000); // Crawl-delay uit robots.txt
const ANUBIS = /<script id="anubis_challenge" type="application\/json">([\s\S]*?)<\/script>/;
const ANUBIS_PAS = '/.within.website/x/cmd/anubis/api/pass-challenge';
const ANUBIS_MAX = 1 << 24;
const koekjes = new Map();

const goApi = (portaal, pad, query = {}, tijd = 90_000) => {
  const q = new URLSearchParams(query).toString();
  return haalJsonOpenbaar(`${portaal.replace(/\/$/, '')}/api/v2/${pad}${q ? `?${q}` : ''}`, { tijd });
};

async function goPortaal(portaal) {
  try {
    const r = (await goApi(portaal, 'meetings', { limit: 1 }, 10_000)).result || {};
    return Array.isArray(r.meetings) ? portaal : null;
  } catch {
    return null;
  }
}

// De nonce waarvan de SHA-256 met `moeilijkheid` nullen (hexcijfers) begint.
export function anubisNonce(data, moeilijkheid) {
  const heel = Math.floor(moeilijkheid / 2);
  const half = moeilijkheid % 2;
  for (let nonce = 0; nonce < ANUBIS_MAX; nonce++) {
    const hash = createHash('sha256').update(data + nonce).digest();
    let ok = true;
    for (let i = 0; i < heel; i++) if (hash[i] !== 0) { ok = false; break; }
    if (ok && half && hash[heel] >> 4) ok = false;
    if (ok) return { antwoord: hash.toString('hex'), nonce };
  }
  throw new Error('De toegangspoort van dit portaal gaf een te zware opgave.');
}

async function goPagina(url) {
  let pagina = await haalTekstOpenbaar(url, { cookies: koekjes, ua: UA });
  const puzzel = ANUBIS.exec(pagina);
  if (puzzel) {
    const { challenge, rules } = JSON.parse(puzzel[1]);
    const begin = Date.now();
    const { antwoord, nonce } = anubisNonce(String(challenge.randomData), Number(rules.difficulty));
    const pas = new URL(ANUBIS_PAS, url);
    pas.search = new URLSearchParams({ id: challenge.id, response: antwoord, nonce, redir: url, elapsedTime: Date.now() - begin }).toString();
    pagina = await haalTekstOpenbaar(pas.href, { cookies: koekjes, ua: UA });
    if (ANUBIS.test(pagina)) throw new Error('De toegangspoort van dit portaal liet ons niet door.');
  }
  return pagina;
}

const goStart = (v) => lokaal(v.date, `${v.startTime || '00:00'}:00`);

function goItem(portaal, host, v) {
  const orgaan = String(v.dmu?.name || '').trim();
  return item({
    extern: `go:${host}/${v.id}`,
    url: portaal.replace(/\/$/, '') + String(v.url || ''),
    titel: String(v.meetingLabel || orgaan || 'Vergadering').trim(),
    auteur: orgaan,
  }, goStart(v));
}

async function goOntdek(bron) {
  const portaal = bron.url;
  const host = new URL(portaal).hostname.toLowerCase();
  const limiet = Number(bron.audio.eersteImport ?? 3);
  const max = limiet ? Math.max(PAGINA, limiet) : 0;
  const rand = new Date(Date.now() - GO_MARGE_UUR * 3600_000);
  const iso = (d) => `${d.getFullYear()}-${twee(d.getMonth() + 1)}-${twee(d.getDate())}`;
  const venster = { sort: 'date_desc', date_to: iso(rand) };
  if (bron.audio.geinitialiseerd) venster.date_from = iso(new Date(rand - GO_RECENT * 86400_000));
  const items = [];
  for (let offset = 0; items.length < GO_MAX;) {
    if (offset) await slaap(GO_WACHT_MS);
    const r = (await goApi(portaal, 'meetings', { offset, limit: 100, ...venster })).result || {};
    const lijst = r.meetings || [];
    // De API filtert op datum; een vergadering van later vandaag is nog niet geweest.
    items.push(...lijst.filter((v) => v.id && (goStart(v) || 0) < rand).map((v) => goItem(portaal, host, v)));
    offset += lijst.length;
    if (!lijst.length || offset >= Number(r.totalCount || 0) || (max && items.length >= max)) break;
  }
  if (!items.length) throw new Error('Geen afgeronde vergaderingen gevonden in dit archief.');
  return { titel: host, items: items.sort((a, b) => b._sort - a._sort) };
}

async function goMedia(af) {
  const host = new URL(af.url).hostname.toLowerCase();
  if (!af.extern.startsWith(`go:${host}/`)) throw new Error('Deze vergadering heeft geen herkenbare bronverwijzing meer.');
  const gevonden = GO_MEDIA.exec(await goPagina(af.url));
  // Niet iedere vergadering wordt uitgezonden; de agenda verraadt dat niet vooraf.
  if (!gevonden) throw geenOpname('Deze vergadering biedt geen downloadbare opname aan.');
  return { adres: gevonden[0], velden: {}, stream: false };
}
