// gehoord.de/beraadslagingen: live transcripties van de debatten in de Tweede
// en Eerste Kamer, met tijd, spreker en fractie; gratis na registratie. Te
// lezen via hun MCP-server (https://gehoord.de/api/mcp, src/mcp.mjs).
//
// Inloggen gaat met OAuth: dynamische registratie van de Regiochecker als
// client, dan de autorisatiecode met PKCE. Een beheerder koppelt eenmalig het
// account (Beheer › Instellingen › Kamerdebatten): de browser gaat naar
// gehoord.de, de beheerder logt daar zelf in, en komt terug op
// /api/beheer/gehoord/terug. Het wachtwoord ziet de Regiochecker nooit; die
// bewaart alleen de tokens (data/instellingen.json, `gehoord`) en vernieuwt het
// toegangstoken zelf met het verversingstoken. De tokens gaan nooit naar de browser.

import { createHash, randomBytes } from 'node:crypto';
import { fetch } from 'undici';
import { controleerUrl, openbaarDispatcher } from './netwerk.mjs';
import { McpKlant } from './mcp.mjs';
import { haalJson } from './ophalen.mjs';

const basis = () => (process.env.GEHOORD_URL || 'https://gehoord.de').replace(/\/$/, '');
const mcpAdres = () => `${basis()}/api/mcp`;
const SCOPE = 'transcripts:read';
const WACHT_MS = 15 * 60_000; // zo lang mag het inloggen bij gehoord.de duren
const MARGE_S = 120; // een toegangstoken dat bijna verloopt, vernieuwen we vast

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const wachtend = new Map(); // state → { verifier, terug, tijd }

export class GehoordFout extends Error {}

async function verzoek(url, { methode = 'GET', json, formulier } = {}) {
  controleerUrl(url);
  const koppen = { Accept: 'application/json', 'User-Agent': 'Regiochecker/1.0 (+https://github.com/basvroegop/regiochecker)' };
  let body;
  if (json) {
    koppen['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (formulier) {
    koppen['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(formulier).toString();
  }
  let antwoord;
  try {
    antwoord = await fetch(url, { method: methode, headers: koppen, body, dispatcher: openbaarDispatcher, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  } catch (fout) {
    throw new GehoordFout(`gehoord.de niet bereikbaar: ${fout.cause?.code || fout.message}`);
  }
  const tekst = await antwoord.text();
  let data = null;
  try { data = tekst ? JSON.parse(tekst) : null; } catch { /* geen JSON */ }
  if (!antwoord.ok) {
    // Alleen de foutcode en -omschrijving van de server, nooit wat we stuurden.
    const reden = [data?.error, data?.error_description].filter(Boolean).join(': ');
    throw Object.assign(new GehoordFout(`gehoord.de gaf HTTP ${antwoord.status}${reden ? ` (${String(reden).slice(0, 200)})` : ''}`), { status: antwoord.status, code: data?.error });
  }
  return data;
}

let metadataCache = null;
async function metadata() {
  if (metadataCache && Date.now() - metadataCache.tijd < 86400_000) return metadataCache.data;
  const data = await verzoek(`${basis()}/.well-known/oauth-authorization-server`);
  if (!data?.authorization_endpoint || !data?.token_endpoint) throw new GehoordFout('gehoord.de geeft geen OAuth-gegevens meer. Is de koppeling veranderd?');
  metadataCache = { tijd: Date.now(), data };
  return data;
}

const instelling = (opslag) => (opslag.instellingen.gehoord ||= {});

// Wat de browser mag zien: gekoppeld of niet, sinds wanneer, de laatste fout.
export function gehoordStatus(opslag) {
  const g = opslag.instellingen.gehoord || {};
  return { gekoppeld: Boolean(g.verversToken), sinds: g.gekoppeld || null, fout: g.fout || null };
}

// Stap 1: het adres waar de beheerder bij gehoord.de inlogt. `terug` is het
// adres van /api/beheer/gehoord/terug op de eigen site.
export async function koppelAdres(opslag, terug) {
  const m = await metadata();
  const g = instelling(opslag);
  // Eén keer registreren per terugkeeradres.
  if (!g.clientId || g.terug !== terug) {
    if (!m.registration_endpoint) throw new GehoordFout('gehoord.de laat geen nieuwe koppelingen registreren.');
    const r = await verzoek(m.registration_endpoint, {
      methode: 'POST',
      json: { client_name: 'Regiochecker', redirect_uris: [terug], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: SCOPE },
    });
    if (!r?.client_id) throw new GehoordFout('gehoord.de gaf geen client-id bij het registreren.');
    Object.assign(g, { clientId: r.client_id, terug });
    opslag.bewaar('instellingen');
  }
  for (const [s, w] of wachtend) if (Date.now() - w.tijd > WACHT_MS) wachtend.delete(s);
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  wachtend.set(state, { verifier, terug, tijd: Date.now() });
  const adres = new URL(m.authorization_endpoint);
  adres.search = new URLSearchParams({
    response_type: 'code', client_id: g.clientId, redirect_uri: terug, scope: SCOPE, state,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    resource: mcpAdres(),
  }).toString();
  return adres.href;
}

function bewaarTokens(opslag, t) {
  const g = instelling(opslag);
  if (!t?.access_token) throw new GehoordFout('gehoord.de gaf geen toegangstoken.');
  g.toegangToken = t.access_token;
  if (t.refresh_token) g.verversToken = t.refresh_token;
  g.verloopt = Math.floor(Date.now() / 1000) + (Number(t.expires_in) || 3600);
  g.fout = null;
  opslag.bewaar('instellingen');
}

// Stap 2: terug van gehoord.de met een code (of een weigering).
export async function rondKoppelingAf(opslag, { code, state, fout }) {
  const w = state && wachtend.get(state);
  if (state) wachtend.delete(state);
  if (fout) throw new GehoordFout(fout === 'access_denied' ? 'Koppeling geweigerd bij gehoord.de.' : `gehoord.de: ${String(fout).slice(0, 100)}`);
  if (!w || Date.now() - w.tijd > WACHT_MS) throw new GehoordFout('Deze koppelpoging is verlopen of onbekend; begin opnieuw.');
  if (!code) throw new GehoordFout('gehoord.de stuurde geen code terug.');
  const m = await metadata();
  const g = instelling(opslag);
  const t = await verzoek(m.token_endpoint, {
    methode: 'POST',
    formulier: { grant_type: 'authorization_code', code, redirect_uri: w.terug, client_id: g.clientId, code_verifier: w.verifier, resource: mcpAdres() },
  });
  bewaarTokens(opslag, t);
  g.gekoppeld = new Date().toISOString();
  opslag.bewaar('instellingen');
}

// Een geldig toegangstoken; vernieuwt het zo nodig. Weigert gehoord.de het
// verversingstoken, dan is de koppeling weg en moet een beheerder opnieuw koppelen.
let vernieuwen = null;
export async function toegang(opslag) {
  const g = opslag.instellingen.gehoord || {};
  if (!g.verversToken) throw new GehoordFout('Nog niet gekoppeld met gehoord.de (Beheer › Instellingen › Kamerdebatten).');
  if (g.toegangToken && g.verloopt - MARGE_S > Date.now() / 1000) return g.toegangToken;
  vernieuwen ||= (async () => {
    const m = await metadata();
    try {
      bewaarTokens(opslag, await verzoek(m.token_endpoint, {
        methode: 'POST',
        formulier: { grant_type: 'refresh_token', refresh_token: g.verversToken, client_id: g.clientId, resource: mcpAdres() },
      }));
    } catch (fout) {
      if (fout.code === 'invalid_grant' || fout.status === 400 || fout.status === 401) {
        Object.assign(instelling(opslag), { toegangToken: null, verversToken: null, fout: 'De koppeling met gehoord.de is verlopen of ingetrokken; koppel opnieuw.' });
        opslag.bewaar('instellingen');
      }
      throw fout;
    }
  })().finally(() => { vernieuwen = null; });
  await vernieuwen;
  return opslag.instellingen.gehoord.toegangToken;
}

export async function ontkoppel(opslag) {
  const g = opslag.instellingen.gehoord || {};
  if (g.verversToken) {
    try {
      const m = await metadata();
      if (m.revocation_endpoint) await verzoek(m.revocation_endpoint, { methode: 'POST', formulier: { token: g.verversToken, token_type_hint: 'refresh_token', client_id: g.clientId } });
    } catch { /* lokaal weggooien gaat altijd door */ }
  }
  Object.assign(instelling(opslag), { toegangToken: null, verversToken: null, verloopt: null, gekoppeld: null, fout: null });
  opslag.bewaar('instellingen');
}

// Een sessie met de MCP-server; `werk(klant)` doet het eigenlijke werk.
export async function metGehoord(opslag, werk) {
  const klant = new McpKlant(mcpAdres(), { token: () => toegang(opslag) });
  await klant.open();
  try {
    return await werk(klant);
  } finally {
    await klant.sluit();
  }
}

// Voor Beheer: wat de server aanbiedt (naam, omschrijving, invoer).
export async function gehoordTools(opslag) {
  return metGehoord(opslag, async (klant) => ({
    server: klant.server,
    instructies: klant.instructies,
    tools: (await klant.tools()).map((t) => ({ naam: t.name, titel: t.title || null, omschrijving: t.description || '', invoer: t.inputSchema || null })),
  }));
}

// ---------- de debatten als bron ----------
//
// Een debat is in de Regiochecker een aflevering in het audioarchief (soort
// kamerdebat, vorm gehoord): het transcript komt kant-en-klaar van gehoord.de,
// zonder downloaden of Whisper. Een landelijke bron, dus een debat gaat naar een
// regio als een sleutelwoord valt, met het tijdstip (src/feed.mjs). De tools
// geven tekst, geen JSON; die lezen we hier.

const MIN_FRAGMENTEN = 2; // "Regeling van werkzaamheden · 1 fragmenten": niets te lezen
const PAGINA = 50;
const TRANSCRIPT_TEKENS = 100_000;
const MAX_TRANSCRIPT_PAGINAS = 40;
const twee = (n) => String(n).padStart(2, '0');

// "- #307215 · 29-10-2026 19:01 · Titel · Plenaire zaal, Tweede Kamer · afgelopen · 483 fragmenten"
const DEBAT = /^- #(\d+) · (\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}) · (.+) · ([^·\n]+) · ([^·\n]+) · (\d+) fragment(?:en)?\s*$/gm;

export function leesDebatten(tekst) {
  const debatten = [...String(tekst).matchAll(DEBAT)].map((m) => ({
    id: Number(m[1]),
    // Nederlandse tijd; de dienst draait met TZ=Europe/Amsterdam.
    begin: new Date(+m[4], +m[3] - 1, +m[2], +m[5], +m[6]),
    titel: m[7].trim(),
    plek: m[8].trim(),
    status: m[9].trim(),
    fragmenten: Number(m[10]),
  }));
  const volgende = /\boffset=(\d+)/.exec(String(tekst).split('\n').slice(-3).join('\n'))?.[1];
  return { debatten, volgende: volgende ? Number(volgende) : null };
}

const debatItem = (d) => ({
  extern: `gh:${d.id}`,
  vorm: 'gehoord',
  url: `${basis()}/beraadslagingen/${d.id}`,
  titel: d.titel,
  auteur: d.plek,
  gepubliceerd: `${d.begin.getFullYear()}${twee(d.begin.getMonth() + 1)}${twee(d.begin.getDate())}`,
  gepubliceerdOp: d.begin.getTime() / 1000,
  _sort: d.begin.getTime(),
});

// De catalogus: afgelopen debatten, nieuwste eerst. Een vervolgcontrole leest de
// nieuwste honderd, een eerste import alles (zo'n 1100 eind oktober 2026).
export async function gehoordOntdek(bron, { opslag, proef = false } = {}) {
  const paginas = proef ? 1 : bron.audio.geinitialiseerd ? 2 : 100;
  return metGehoord(opslag, async (klant) => {
    const items = [];
    let offset = 0;
    for (let p = 0; p < paginas; p++) {
      const { tekst } = await klant.roep('search_debates', { status: 'ended', limit: PAGINA, offset });
      const { debatten, volgende } = leesDebatten(tekst);
      items.push(...debatten.filter((d) => d.fragmenten >= MIN_FRAGMENTEN).map(debatItem));
      if (volgende === null || !debatten.length) break;
      offset = volgende;
    }
    return { titel: 'gehoord.de/beraadslagingen', items, deels: proef };
  });
}

// "[16:00:09] Chris Jansen (PVV) — https://gehoord.de/beraadslagingen/307214?segment=239523"
const FRAGMENT = /^\[(\d{2}):(\d{2}):(\d{2})\] (.+?) — (https?:\/\/\S+?[?&]segment=(\d+))\s*$/gm;
const VERVOLG = /^— Vervolg: .*?\boffset=(\d+)/m;

// Eén pagina van get_transcript: de fragmenten, en de offset van de volgende pagina.
export function leesTranscript(tekst) {
  const t = String(tekst);
  const eind = VERVOLG.exec(t);
  const inhoud = eind ? t.slice(0, eind.index) : t;
  const koppen = [...inhoud.matchAll(FRAGMENT)];
  const fragmenten = koppen.map((m, i) => ({
    seconde: +m[1] * 3600 + +m[2] * 60 + +m[3],
    spreker: /^onbekende spreker$/i.test(m[4].trim()) ? null : m[4].trim(),
    fragment: Number(m[6]),
    tekst: inhoud.slice(m.index + m[0].length, koppen[i + 1]?.index ?? inhoud.length).replace(/\s+/g, ' ').trim(),
  })).filter((f) => f.tekst);
  return { fragmenten, volgende: eind ? Number(eind[1]) : null };
}

// Van fragmenten met een kloktijd naar segmenten vanaf het begin van het debat,
// zoals een transcript van Whisper (start, end, text, speaker), met het
// fragment-id voor de link naar die plek op gehoord.de.
export function debatSegmenten(fragmenten) {
  let dag = 0;
  let vorige = null;
  const absoluut = fragmenten.map((f) => {
    // Een debat dat na middernacht doorgaat.
    if (vorige !== null && f.seconde + dag < vorige - 6 * 3600) dag += 86400;
    vorige = f.seconde + dag;
    return vorige;
  });
  const begin = absoluut[0] ?? 0;
  return fragmenten.map((f, i) => {
    const start = absoluut[i] - begin;
    const volgende = i + 1 < fragmenten.length ? absoluut[i + 1] - begin : start + Math.max(5, Math.round(f.tekst.length / 15));
    return { start, end: Math.max(start + 1, volgende), text: f.tekst, ...(f.spreker ? { speaker: f.spreker } : {}), fragment: f.fragment };
  });
}

// get_debate: "Soort: Plenair debat", "Bron: https://debatdirect…", en onder
// "## Let op" waarschuwingen over de tekst (Eerste Kamer zonder hoofdletters,
// een samengevatte ondertiteling).
export function leesDebat(tekst) {
  const t = String(tekst);
  const regel = (naam) => new RegExp(`^${naam}: (.+)$`, 'm').exec(t)?.[1]?.trim() || null;
  const blok = (kop) => {
    const m = new RegExp(`^## ${kop}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(t);
    return m ? [...m[1].matchAll(/^- (.+)$/gm)].map((x) => x[1].trim()) : [];
  };
  return { soort: regel('Soort'), bron: regel('Bron'), letOp: blok('Let op'), sprekers: blok('Sprekers') };
}

// Het hele transcript van één debat (alle pagina's): { segmenten, tekst, duur, debat }.
export async function gehoordDebat(opslag, af) {
  const id = /^gh:(\d+)$/.exec(af.extern || '')?.[1];
  if (!id) throw new GehoordFout('Dit debat heeft geen herkenbaar nummer van gehoord.de.');
  return metGehoord(opslag, async (klant) => {
    const debat = leesDebat((await klant.roep('get_debate', { debate_id: Number(id) })).tekst);
    const fragmenten = [];
    let offset = 0;
    for (let p = 0; p < MAX_TRANSCRIPT_PAGINAS; p++) {
      const { tekst } = await klant.roep('get_transcript', { debate_id: Number(id), offset, max_chars: TRANSCRIPT_TEKENS });
      const pagina = leesTranscript(tekst);
      fragmenten.push(...pagina.fragmenten);
      if (pagina.volgende === null || pagina.volgende <= offset) break;
      offset = pagina.volgende;
    }
    if (!fragmenten.length) throw new GehoordFout('gehoord.de heeft (nog) geen tekst bij dit debat.');
    const segmenten = debatSegmenten(fragmenten);
    return { segmenten, tekst: segmenten.map((s) => s.text).join(' '), duur: segmenten.at(-1).end, debat, klokBegin: klokVan(af, fragmenten[0].seconde) };
  });
}

// ---------- de video van het debat (Debat Direct) ----------
//
// De Tweede Kamer zendt elk debat uit via Debat Direct. gehoord.de noemt bij
// een debat de pagina daar ("Bron: https://debatdirect.tweedekamer.nl/<datum>/
// <categorie>/<zaal>/<debat>"); de openbare API van Debat Direct geeft bij het
// debat de HLS-stream van die zaal op die dag, die je met start en eind (de
// tijden van het debat) tot het debat beperkt, net als hun eigen speler. De
// stream heeft kloktijden (EXT-X-PROGRAM-DATE-TIME), en de fragmenten van
// gehoord.de ook: zo opent een tijd in het transcript de video op die plek. Een
// debat van de Eerste Kamer heeft geen Debat Direct; dan blijven de tijden naar
// gehoord.de wijzen.

const DEBAT_DIRECT = () => process.env.DEBAT_DIRECT_API || 'https://cdn.debatdirect.tweedekamer.nl/api';
const DD_PAGINA = /^https:\/\/debatdirect\.tweedekamer\.nl\/(\d{4}-\d{2}-\d{2})\/[^/]+\/[^/]+\/([^/?#]+)/;

// De kloktijd van het eerste fragment: de dag van het debat (een fragment ruim
// voor de geplande aanvang hoort bij de volgende dag, na middernacht).
export function klokVan(af, seconde) {
  const gepland = new Date(af.gepubliceerd || (af.gepubliceerdOp ? af.gepubliceerdOp * 1000 : Date.now()));
  const dag = new Date(gepland.getFullYear(), gepland.getMonth(), gepland.getDate());
  const geplandSeconde = gepland.getHours() * 3600 + gepland.getMinutes() * 60;
  const extra = seconde < geplandSeconde - 6 * 3600 ? 86400 : 0;
  return new Date(+dag + (seconde + extra) * 1000).toISOString();
}

// "2026-10-29T19:01:26+0100" → ISO; Date.parse wil een dubbele punt in de zone.
const ddTijd = (t) => (t ? new Date(Date.parse(String(t).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))).toISOString() : null);

// Wat het leespaneel nodig heeft: { hls, begin, klokBegin, poster, pagina } of null.
export async function debatVideo(opslag, af) {
  let { debat, klokBegin } = af.platform || {};
  // Een debat van vóór deze functie: de gegevens eenmalig ophalen bij gehoord.de.
  if (!debat || !klokBegin) {
    const id = Number(/^gh:(\d+)$/.exec(af.extern || '')?.[1]);
    ({ debat, klokBegin } = await metGehoord(opslag, async (klant) => {
      const d = leesDebat((await klant.roep('get_debate', { debate_id: id })).tekst);
      const [eerste] = leesTranscript((await klant.roep('get_transcript', { debate_id: id, max_chars: 5000 })).tekst).fragmenten;
      return { debat: d, klokBegin: eerste ? klokVan(af, eerste.seconde) : null };
    }));
  }
  const m = DD_PAGINA.exec(debat?.bron || '');
  if (!m || !klokBegin) return { debat, klokBegin, video: null };
  const agenda = await haalJson(`${DEBAT_DIRECT()}/agenda/${m[1]}`);
  const gevonden = (agenda.debates || []).find((d) => d.slug === m[2]);
  if (!gevonden) return { debat, klokBegin, video: null };
  const info = await haalJson(`${DEBAT_DIRECT()}/debates/${encodeURIComponent(gevonden.id)}`);
  const v = info.video || {};
  const bron = info.endedAt ? v.catchup?.vodUrl || v.vodUrl : v.url;
  if (!bron || !info.startedAt) return { debat, klokBegin, video: null };
  // Zoals de speler van Debat Direct: de stream van de zaal, beperkt tot het debat.
  const hls = new URL(bron);
  hls.searchParams.set('start', info.startedAt);
  if (info.endedAt) hls.searchParams.set('end', info.endedAt);
  return {
    debat,
    klokBegin,
    video: { hls: hls.href, begin: ddTijd(info.startedAt), poster: v.imageUrl || null, pagina: debat.bron },
  };
}
