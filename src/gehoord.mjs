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
