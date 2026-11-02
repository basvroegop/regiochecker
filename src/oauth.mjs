// Inloggen voor AI-apps op de MCP-server (src/mcp.mjs), met OAuth 2.1 zoals de
// MCP-specificatie het vraagt. De Regiochecker is zelf de autorisatieserver:
//   GET  /.well-known/oauth-protected-resource[/mcp]  wie geeft de tokens (RFC 9728)
//   GET  /.well-known/oauth-authorization-server      hoe (RFC 8414)
//   POST /oauth/register   een app meldt zich aan (RFC 7591). Open, want claude.ai
//                          en Claude Code doen dat zelf; een app kan daarmee nog
//                          niets zonder toestemming van een gebruiker.
//   GET  /oauth/authorize  achter Authelia: wie inlogt, ziet een toestemmingsscherm
//   POST /oauth/authorize  toestaan of weigeren; terug naar de app met een code
//   POST /oauth/token      code (met PKCE) of vernieuwtoken → tokens
//   POST /oauth/revoke     een app ontkoppelt zichzelf (RFC 7009)
//
// Alles behalve /oauth/authorize is publiek: Traefik stuurt die paden langs
// Authelia heen (docker-compose.yml) en haalt daar de Remote-*-koppen weg. Dit
// bestand kijkt daarom alleen bij /oauth/authorize naar wie er is ingelogd.
//
// Tokens staan alleen als SHA-256 in de database (regiochecker.sqlite). Een
// toegangstoken geldt een uur. Het vernieuwtoken wordt bij elk gebruik
// vervangen; een koppeling die 90 dagen niet is gebruikt, verloopt.

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { html } from './html.mjs';
import { wachtwoordAan } from './inloggen.mjs';

export const SCOPE = 'zoeken';
const TOEGANG_MS = 3600_000;
const VERNIEUW_MS = 90 * 86400_000;
const CODE_MS = 5 * 60_000;
const VERZOEK_MS = 30 * 60_000;
// Een vernieuwtoken dat binnen deze tijd nog eens komt, is waarschijnlijk een
// tweede poging van de app zelf (netwerkfout); later is het een gestolen token.
const HERGEBRUIK_MS = 60_000;
const METHODES = ['none', 'client_secret_post', 'client_secret_basic'];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS oauth_app (
    id TEXT PRIMARY KEY,
    naam TEXT NOT NULL,
    redirects TEXT NOT NULL,
    geheim TEXT,
    methode TEXT NOT NULL,
    aangemaakt TEXT NOT NULL,
    gekoppeld TEXT
  );
  CREATE TABLE IF NOT EXISTS oauth_koppeling (
    id TEXT PRIMARY KEY,
    app TEXT NOT NULL,
    gebruiker TEXT NOT NULL,
    scope TEXT NOT NULL,
    aangemaakt TEXT NOT NULL,
    gebruikt TEXT,
    ingetrokken TEXT
  );
  CREATE INDEX IF NOT EXISTS oauth_koppeling_gebruiker ON oauth_koppeling(gebruiker);
  -- soort: 'toegang' of 'vernieuw'; vervangen: wanneer een vernieuwtoken is gebruikt.
  CREATE TABLE IF NOT EXISTS oauth_token (
    hash TEXT PRIMARY KEY,
    koppeling TEXT NOT NULL,
    soort TEXT NOT NULL,
    verloopt TEXT NOT NULL,
    vervangen TEXT
  );
  CREATE INDEX IF NOT EXISTS oauth_token_koppeling ON oauth_token(koppeling);
`;

const willekeurig = (n = 32) => randomBytes(n).toString('base64url');
const hash = (t) => createHash('sha256').update(String(t)).digest('hex');
const iso = (ms) => new Date(ms).toISOString();
const gelijk = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export class OAuthFout extends Error {
  // `terug`: het adres van de app als de fout daarheen mag (anders een foutpagina).
  constructor(code, beschrijving, { status = 400, terug = null, state = null } = {}) {
    super(beschrijving);
    Object.assign(this, { code, status, terug, state });
  }
}

// Het adres van de site, ook de "issuer"; lokaal (zonder instelling) dat van het verzoek.
export function basisUrl(req) {
  const ingesteld = process.env.REGIOCHECKER_SITE_URL;
  if (ingesteld) return ingesteld.replace(/\/+$/, '');
  return `http://${req?.headers?.host || 'localhost'}`;
}

export const mcpAdres = (basis) => `${basis}/mcp`;

// De `resource` van RFC 8707: de MCP-server, eventueel met een slash erachter.
function geldigeResource(resource, basis) {
  const r = String(resource).replace(/\/+$/, '');
  return r === mcpAdres(basis) || r === basis;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const VERBODEN_SCHEMA = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'about:', 'blob:', 'ftp:', 'ws:', 'wss:']);

// Waarheen mag een app de gebruiker terugsturen? https, http op de eigen
// computer (Claude Code), of een eigen schema van een desktop-app (RFC 8252).
function geldigeTerugkeer(adres) {
  if (typeof adres !== 'string' || adres.length > 500) return false;
  let u;
  try {
    u = new URL(adres);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === 'https:') return Boolean(u.hostname);
  if (u.protocol === 'http:') return LOOPBACK.has(u.hostname);
  return !VERBODEN_SCHEMA.has(u.protocol);
}

// Precies het geregistreerde adres; alleen de poort van een loopback-adres
// mag anders zijn, die kiest een desktop-app pas bij het inloggen (RFC 8252 §7.3).
function zelfdeTerugkeer(geregistreerd, gevraagd) {
  if (geregistreerd === gevraagd) return true;
  let a, b;
  try {
    a = new URL(geregistreerd);
    b = new URL(gevraagd);
  } catch {
    return false;
  }
  return a.protocol === 'http:' && b.protocol === 'http:' && LOOPBACK.has(a.hostname)
    && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}

function terugAdres(adres, velden) {
  const u = new URL(adres);
  for (const [k, v] of Object.entries(velden)) if (v !== null && v !== undefined) u.searchParams.set(k, v);
  return u.href;
}

// Wat de gebruiker op het toestemmingsscherm ziet als bestemming.
export function bestemming(adres) {
  try {
    const u = new URL(adres);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.host : `${u.protocol}//${u.host}`;
  } catch {
    return adres;
  }
}

export class OAuth {
  // bestaat(id): is de gebruiker er nog? Een verwijderde gebruiker verliest zo
  // meteen al zijn koppelingen.
  constructor(db, { bestaat = () => true, klok = () => Date.now() } = {}) {
    db.exec(SCHEMA);
    this.db = db;
    this.bestaat = bestaat;
    this.klok = klok;
    this.verzoeken = new Map();
    this.codes = new Map();
    this.aanmeldingen = new Map();
    this.gebruiktGezet = new Map();
  }

  // ---------- apps (RFC 7591) ----------

  registreer(invoer, ip = '') {
    const nu = this.klok();
    const tijden = (this.aanmeldingen.get(ip) || []).filter((t) => nu - t < 3600_000);
    if (tijden.length >= 20) throw new OAuthFout('invalid_client_metadata', 'Te veel aanmeldingen; probeer het over een uur opnieuw', { status: 429 });
    this.aanmeldingen.set(ip, [...tijden, nu]);
    this.ruimOp();
    if (this.db.prepare('SELECT count(*) n FROM oauth_app').get().n >= 2000) {
      throw new OAuthFout('invalid_client_metadata', 'Te veel apps aangemeld', { status: 429 });
    }
    if (!invoer || typeof invoer !== 'object') throw new OAuthFout('invalid_client_metadata', 'Verwacht een JSON-object');
    const redirects = invoer.redirect_uris;
    if (!Array.isArray(redirects) || !redirects.length || redirects.length > 10 || !redirects.every(geldigeTerugkeer)) {
      throw new OAuthFout('invalid_redirect_uri', 'redirect_uris: https-adressen, http://localhost of een eigen schema van de app');
    }
    // Zonder methode: client_secret_basic, zo zegt RFC 7591 het.
    const methode = invoer.token_endpoint_auth_method || 'client_secret_basic';
    if (!METHODES.includes(methode)) throw new OAuthFout('invalid_client_metadata', `token_endpoint_auth_method: een van ${METHODES.join(', ')}`);
    const grants = invoer.grant_types || ['authorization_code'];
    if (!Array.isArray(grants) || grants.some((g) => !['authorization_code', 'refresh_token'].includes(g))) {
      throw new OAuthFout('invalid_client_metadata', 'grant_types: authorization_code en refresh_token');
    }
    const types = invoer.response_types || ['code'];
    if (!Array.isArray(types) || types.some((t) => t !== 'code')) throw new OAuthFout('invalid_client_metadata', 'response_types: alleen code');
    const naam = String(invoer.client_name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || 'Onbekende app';
    const id = `rca_${willekeurig(18)}`;
    const geheim = methode === 'none' ? null : willekeurig(32);
    this.db.prepare('INSERT INTO oauth_app (id, naam, redirects, geheim, methode, aangemaakt) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, naam, JSON.stringify(redirects), geheim && hash(geheim), methode, iso(nu));
    return {
      client_id: id,
      client_name: naam,
      redirect_uris: redirects,
      grant_types: grants,
      response_types: ['code'],
      token_endpoint_auth_method: methode,
      client_id_issued_at: Math.floor(nu / 1000),
      scope: SCOPE,
      ...(geheim ? { client_secret: geheim, client_secret_expires_at: 0 } : {}),
    };
  }

  app(id) {
    const r = this.db.prepare('SELECT * FROM oauth_app WHERE id = ?').get(String(id || ''));
    return r ? { ...r, redirects: JSON.parse(r.redirects) } : null;
  }

  // ---------- toestemming ----------

  // GET /oauth/authorize van een ingelogde gebruiker. Geeft het verzoek voor het
  // toestemmingsscherm. Bij een onbekende app of een vreemd terugkeeradres gaat
  // de fout níet terug naar de app (dat adres is niet te vertrouwen).
  begin(p, gebruiker, basis) {
    this.ruimVerzoekenOp();
    const app = this.app(p.get('client_id'));
    if (!app) throw new OAuthFout('invalid_client', 'Deze app is niet (meer) aangemeld. Koppel opnieuw vanuit de app.');
    const gevraagd = p.get('redirect_uri') || (app.redirects.length === 1 ? app.redirects[0] : null);
    if (!gevraagd || !app.redirects.some((r) => zelfdeTerugkeer(r, gevraagd))) {
      throw new OAuthFout('invalid_request', 'Het terugkeeradres hoort niet bij deze app.');
    }
    const state = p.get('state');
    const fout = (code, tekst) => new OAuthFout(code, tekst, { terug: gevraagd, state });
    if (p.get('response_type') !== 'code') throw fout('unsupported_response_type', 'Alleen response_type=code');
    const uitdaging = p.get('code_challenge') || '';
    if (p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(uitdaging)) throw fout('invalid_request', 'PKCE met S256 is verplicht');
    const resource = p.get('resource');
    if (resource && !geldigeResource(resource, basis)) throw fout('invalid_target', 'Onbekende resource');
    if (state && state.length > 2000) throw fout('invalid_request', 'state is te lang');
    // Er is één bevoegdheid (zoeken en lezen); een andere gevraagde scope negeren we.
    const verzoek = {
      id: willekeurig(24), app: app.id, appNaam: app.naam, gebruiker: gebruiker.id, terug: gevraagd, state,
      uitdaging, verloopt: this.klok() + VERZOEK_MS,
    };
    this.verzoeken.set(verzoek.id, verzoek);
    return verzoek;
  }

  // POST /oauth/authorize: toestaan of weigeren; het adres terug naar de app.
  // Het verzoek-id (alleen te zien op het scherm van deze gebruiker) is
  // tegelijk de bescherming tegen een formulier van een andere site.
  besluit(id, gebruiker, akkoord, basis) {
    this.ruimVerzoekenOp();
    const v = this.verzoeken.get(String(id || ''));
    if (!v || v.gebruiker !== gebruiker.id) throw new OAuthFout('invalid_request', 'Dit verzoek is verlopen. Begin opnieuw vanuit de app.');
    this.verzoeken.delete(v.id);
    if (!akkoord) return { adres: terugAdres(v.terug, { error: 'access_denied', error_description: 'Geweigerd door de gebruiker', state: v.state, iss: basis }), verzoek: v };
    const code = willekeurig(32);
    this.codes.set(hash(code), { ...v, verloopt: this.klok() + CODE_MS, gebruikt: false, koppeling: null });
    return { adres: terugAdres(v.terug, { code, state: v.state, iss: basis }), verzoek: v };
  }

  ruimVerzoekenOp() {
    const nu = this.klok();
    for (const [id, v] of this.verzoeken) if (v.verloopt < nu) this.verzoeken.delete(id);
    for (const [h, c] of this.codes) if (c.verloopt < nu - CODE_MS) this.codes.delete(h);
  }

  // ---------- tokens ----------

  // POST /oauth/token. `p`: de velden van het formulier; `kop`: Authorization.
  token(p, kop, basis) {
    const app = this.authenticeer(p, kop);
    const grant = p.get('grant_type');
    if (grant === 'authorization_code') return this.wisselCode(app, p, basis);
    if (grant === 'refresh_token') return this.vernieuw(app, p);
    throw new OAuthFout('unsupported_grant_type', 'Alleen authorization_code en refresh_token');
  }

  authenticeer(p, kop) {
    let id = p.get('client_id');
    let geheim = p.get('client_secret');
    const basic = /^Basic\s+(\S+)$/i.exec(kop || '');
    if (basic) {
      const tekst = Buffer.from(basic[1], 'base64').toString('utf8');
      const i = tekst.indexOf(':');
      try {
        id = decodeURIComponent(tekst.slice(0, i < 0 ? undefined : i));
        geheim = i < 0 ? '' : decodeURIComponent(tekst.slice(i + 1));
      } catch {
        throw new OAuthFout('invalid_client', 'Ongeldige Basic-kop', { status: 401 });
      }
    }
    const app = this.app(id);
    if (!app) throw new OAuthFout('invalid_client', 'Onbekende app', { status: 401 });
    if (app.geheim && !(geheim && gelijk(hash(geheim), app.geheim))) throw new OAuthFout('invalid_client', 'Verkeerd of ontbrekend client_secret', { status: 401 });
    return app;
  }

  wisselCode(app, p, basis) {
    const sleutel = hash(p.get('code') || '');
    const c = this.codes.get(sleutel);
    if (!c || c.verloopt < this.klok() || c.app !== app.id) throw new OAuthFout('invalid_grant', 'Ongeldige of verlopen code');
    if (c.gebruikt) {
      // Dezelfde code nog eens: misschien onderschept. Wat ermee is uitgegeven, vervalt.
      if (c.koppeling) this.trekIn(c.gebruiker, c.koppeling);
      throw new OAuthFout('invalid_grant', 'Deze code is al gebruikt');
    }
    const terug = p.get('redirect_uri');
    if (terug && terug !== c.terug) throw new OAuthFout('invalid_grant', 'redirect_uri klopt niet');
    const verifier = p.get('code_verifier') || '';
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || createHash('sha256').update(verifier).digest('base64url') !== c.uitdaging) {
      this.codes.delete(sleutel);
      throw new OAuthFout('invalid_grant', 'code_verifier klopt niet');
    }
    const resource = p.get('resource');
    if (resource && !geldigeResource(resource, basis)) throw new OAuthFout('invalid_target', 'Onbekende resource');
    if (!this.bestaat(c.gebruiker)) throw new OAuthFout('invalid_grant', 'Deze gebruiker bestaat niet meer');
    c.gebruikt = true;
    c.koppeling = willekeurig(12);
    const nu = iso(this.klok());
    this.db.prepare('INSERT INTO oauth_koppeling (id, app, gebruiker, scope, aangemaakt) VALUES (?, ?, ?, ?, ?)').run(c.koppeling, app.id, c.gebruiker, SCOPE, nu);
    this.db.prepare('UPDATE oauth_app SET gekoppeld = ? WHERE id = ?').run(nu, app.id);
    return this.geefTokens(c.koppeling);
  }

  vernieuw(app, p) {
    const t = this.db.prepare(`SELECT t.*, k.app, k.gebruiker, k.ingetrokken FROM oauth_token t
      JOIN oauth_koppeling k ON k.id = t.koppeling WHERE t.hash = ? AND t.soort = 'vernieuw'`).get(hash(p.get('refresh_token') || ''));
    const nu = this.klok();
    if (!t || t.app !== app.id || t.ingetrokken || t.verloopt < iso(nu) || !this.bestaat(t.gebruiker)) {
      throw new OAuthFout('invalid_grant', 'Ongeldig of verlopen vernieuwtoken');
    }
    if (t.vervangen) {
      if (Date.parse(t.vervangen) < nu - HERGEBRUIK_MS) this.trekIn(t.gebruiker, t.koppeling);
      throw new OAuthFout('invalid_grant', 'Dit vernieuwtoken is al gebruikt');
    }
    this.db.prepare('UPDATE oauth_token SET vervangen = ? WHERE hash = ?').run(iso(nu), t.hash);
    return this.geefTokens(t.koppeling);
  }

  geefTokens(koppeling) {
    const nu = this.klok();
    const toegang = `rct_${willekeurig(32)}`;
    const vernieuw = `rcv_${willekeurig(32)}`;
    const zet = this.db.prepare('INSERT INTO oauth_token (hash, koppeling, soort, verloopt) VALUES (?, ?, ?, ?)');
    zet.run(hash(toegang), koppeling, 'toegang', iso(nu + TOEGANG_MS));
    zet.run(hash(vernieuw), koppeling, 'vernieuw', iso(nu + VERNIEUW_MS));
    return { access_token: toegang, token_type: 'Bearer', expires_in: TOEGANG_MS / 1000, refresh_token: vernieuw, scope: SCOPE };
  }

  // Het toegangstoken van een MCP-verzoek: { gebruiker, koppeling, app } of null.
  controleer(token) {
    if (!/^rct_[A-Za-z0-9_-]{43}$/.test(token || '')) return null;
    const t = this.db.prepare(`SELECT t.verloopt, k.id koppeling, k.gebruiker, k.ingetrokken, a.naam app FROM oauth_token t
      JOIN oauth_koppeling k ON k.id = t.koppeling JOIN oauth_app a ON a.id = k.app
      WHERE t.hash = ? AND t.soort = 'toegang'`).get(hash(token));
    const nu = this.klok();
    if (!t || t.ingetrokken || t.verloopt < iso(nu) || !this.bestaat(t.gebruiker)) return null;
    // "Laatst gebruikt" hooguit eens per minuut wegschrijven.
    if (!(nu - (this.gebruiktGezet.get(t.koppeling) || 0) < 60_000)) {
      this.gebruiktGezet.set(t.koppeling, nu);
      this.db.prepare('UPDATE oauth_koppeling SET gebruikt = ? WHERE id = ?').run(iso(nu), t.koppeling);
    }
    return { gebruiker: t.gebruiker, koppeling: t.koppeling, app: t.app };
  }

  // POST /oauth/revoke: de app trekt zijn eigen koppeling in (RFC 7009). Altijd
  // "gelukt", ook bij een onbekend token.
  trekTokenIn(p, kop) {
    const app = this.authenticeer(p, kop);
    const t = this.db.prepare(`SELECT k.id, k.gebruiker, k.app FROM oauth_token t JOIN oauth_koppeling k ON k.id = t.koppeling
      WHERE t.hash = ?`).get(hash(p.get('token') || ''));
    if (t && t.app === app.id) this.trekIn(t.gebruiker, t.id);
  }

  // ---------- koppelingen van een gebruiker ----------

  koppelingen(gebruikerId) {
    return this.db.prepare(`SELECT k.id, a.naam app, a.redirects, k.aangemaakt, k.gebruikt FROM oauth_koppeling k
      JOIN oauth_app a ON a.id = k.app
      WHERE k.gebruiker = ? AND k.ingetrokken IS NULL
        AND EXISTS (SELECT 1 FROM oauth_token t WHERE t.koppeling = k.id AND t.soort = 'vernieuw' AND t.vervangen IS NULL AND t.verloopt > ?)
      ORDER BY k.aangemaakt DESC`).all(gebruikerId, iso(this.klok()))
      .map(({ redirects, ...k }) => ({ ...k, bestemming: bestemming(JSON.parse(redirects)[0]) }));
  }

  // Alleen de eigen koppeling: van een ander verandert er niets.
  trekIn(gebruikerId, id) {
    const r = this.db.prepare('UPDATE oauth_koppeling SET ingetrokken = ? WHERE id = ? AND gebruiker = ? AND ingetrokken IS NULL')
      .run(iso(this.klok()), String(id), gebruikerId);
    if (!r.changes) return false;
    this.db.prepare('DELETE FROM oauth_token WHERE koppeling = ?').run(String(id));
    return true;
  }

  // Verlopen tokens, lege koppelingen, en apps die zich aanmeldden maar nooit
  // (of een half jaar niet) zijn gekoppeld.
  ruimOp() {
    const nu = this.klok();
    this.db.prepare('DELETE FROM oauth_token WHERE verloopt < ?').run(iso(nu));
    this.db.prepare('DELETE FROM oauth_koppeling WHERE id NOT IN (SELECT koppeling FROM oauth_token)').run();
    this.db.prepare(`DELETE FROM oauth_app WHERE id NOT IN (SELECT app FROM oauth_koppeling)
      AND ((gekoppeld IS NULL AND aangemaakt < ?) OR gekoppeld < ?)`).run(iso(nu - 86400_000), iso(nu - 180 * 86400_000));
  }
}

// ---------- HTTP ----------

const PUBLIEK = new Set([
  '/.well-known/oauth-authorization-server',
  '/.well-known/openid-configuration',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/oauth/register',
  '/oauth/token',
  '/oauth/revoke',
]);

export const isOAuthPad = (pad) => PUBLIEK.has(pad) || pad === '/oauth/authorize';

// Andere sites (een MCP-app in de browser) mogen deze paden aanroepen: er gaat
// geen cookie mee, alleen een token.
export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};

export function metadata(basis) {
  return {
    issuer: basis,
    authorization_endpoint: `${basis}/oauth/authorize`,
    token_endpoint: `${basis}/oauth/token`,
    registration_endpoint: `${basis}/oauth/register`,
    revocation_endpoint: `${basis}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: METHODES,
    revocation_endpoint_auth_methods_supported: METHODES,
    scopes_supported: [SCOPE],
    authorization_response_iss_parameter_supported: true,
  };
}

export function resourceMetadata(basis) {
  return {
    resource: mcpAdres(basis),
    authorization_servers: [basis],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Regiochecker',
  };
}

function stuurJson(res, status, data, kop = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Pragma: 'no-cache', ...CORS, ...kop });
  res.end(JSON.stringify(data));
}

export async function leesLijf(req, max = 64_000) {
  let ruw = '';
  for await (const stuk of req) {
    ruw += stuk;
    if (ruw.length > max) throw new OAuthFout('invalid_request', 'Verzoek te groot', { status: 413 });
  }
  return ruw;
}

// Velden van een formulier (zoals OAuth voorschrijft) of, coulant, van JSON.
async function leesVelden(req) {
  const ruw = await leesLijf(req);
  if (String(req.headers['content-type'] || '').startsWith('application/json')) {
    let data;
    try {
      data = JSON.parse(ruw || '{}');
    } catch {
      throw new OAuthFout('invalid_request', 'Ongeldige JSON');
    }
    return new URLSearchParams(Object.entries(data || {}).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)]));
  }
  return new URLSearchParams(ruw);
}

// Het toestemmingsscherm en foutpagina's: gewone HTML in de huisstijl, zonder
// scripts; een andere site mag ze niet in een frame tonen.
function pagina(res, status, titel, inhoud, kleur = 'lc') {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(`<!doctype html>
<html lang="nl" data-titel="${kleur}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${html(titel)} · Regiochecker</title>
  <link rel="stylesheet" href="/modernist.css">
  <link rel="stylesheet" href="/stijl.css">
</head>
<body class="toestemming">
  <main class="toestemming-vak">
    <p class="logo"><span class="logo-blok"></span><span class="logo-naam">Regiochecker</span></p>
    <h1>${html(titel)}</h1>
    ${inhoud}
  </main>
</body>
</html>`);
}

const kleurVan = (gebruiker) => (String(gebruiker?.titel || '').toLowerCase() === 'dvhn' ? 'dvhn' : 'lc');

function toestemmingHtml(v, gebruiker) {
  return `<p><strong>${html(v.appNaam)}</strong> vraagt toegang tot de Regiochecker, namens jou (${html(gebruiker.naam || gebruiker.login)}).</p>
    <ul class="toestemming-lijst">
      <li>De app kan zoeken in alles wat de Regiochecker heeft: stukken van gemeenten en hun archieven, Kamerstukken, signalen en de transcripten van vergaderingen, debatten, video's en podcasts. En die stukken lezen.</li>
      <li>Alleen lezen. De app kan niets wijzigen of versturen, en ziet je bewaarde stukken, notities en meldingen niet. Ingezonden tips blijven erbuiten.</li>
      <li>Wat de app vindt, gaat naar die app en het taalmodel erachter.</li>
    </ul>
    <p class="toestemming-klein">Na je keuze gaat je browser terug naar <code>${html(bestemming(v.terug))}</code>. Intrekken kan altijd: klik in de Regiochecker op je naam, dan Koppelingen.</p>
    <form method="post" action="/oauth/authorize">
      <input type="hidden" name="verzoek" value="${html(v.id)}">
      <div class="knoppenrij">
        <button class="knop inkt" name="besluit" value="toestaan">Toestaan</button>
        <button class="knop zacht" name="besluit" value="weigeren">Weigeren</button>
      </div>
    </form>`;
}

const foutHtml = (tekst) => `<p>${html(tekst)}</p><p class="toestemming-klein"><a href="/">Naar de Regiochecker</a></p>`;

// Alle paden van isOAuthPad. ctx: { oauth, opslag, wie } (wie: de gebruiker achter Authelia).
export async function oauthRoute(req, res, url, { oauth, opslag, wie }) {
  const basis = basisUrl(req);
  const pad = url.pathname;
  if (!oauth) return stuurJson(res, 503, { error: 'temporarily_unavailable', error_description: 'Koppelen is niet beschikbaar (database ontbreekt)' });
  try {
    if (pad === '/oauth/authorize') return await toestemming(req, res, url, { oauth, opslag, wie, basis });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }
    if (pad === '/.well-known/oauth-authorization-server' || pad === '/.well-known/openid-configuration') {
      if (req.method !== 'GET') throw new OAuthFout('invalid_request', 'Alleen GET', { status: 405 });
      return stuurJson(res, 200, metadata(basis), { 'Cache-Control': 'public, max-age=3600' });
    }
    if (pad.startsWith('/.well-known/oauth-protected-resource')) {
      if (req.method !== 'GET') throw new OAuthFout('invalid_request', 'Alleen GET', { status: 405 });
      return stuurJson(res, 200, resourceMetadata(basis), { 'Cache-Control': 'public, max-age=3600' });
    }
    if (req.method !== 'POST') throw new OAuthFout('invalid_request', 'Alleen POST', { status: 405 });
    if (pad === '/oauth/register') {
      let invoer;
      try {
        invoer = JSON.parse(await leesLijf(req) || 'null');
      } catch (fout) {
        if (fout instanceof OAuthFout) throw fout;
        throw new OAuthFout('invalid_client_metadata', 'Ongeldige JSON');
      }
      return stuurJson(res, 201, oauth.registreer(invoer, ipVan(req)));
    }
    if (pad === '/oauth/token') return stuurJson(res, 200, oauth.token(await leesVelden(req), req.headers.authorization, basis));
    if (pad === '/oauth/revoke') {
      oauth.trekTokenIn(await leesVelden(req), req.headers.authorization);
      return stuurJson(res, 200, {});
    }
    throw new OAuthFout('invalid_request', 'Onbekend pad', { status: 404 });
  } catch (fout) {
    if (!(fout instanceof OAuthFout)) throw fout;
    return stuurJson(res, fout.status, { error: fout.code, error_description: fout.message });
  }
}

async function toestemming(req, res, url, { oauth, opslag, wie, basis }) {
  const gebruiker = wie(req);
  // Met het gedeelde wachtwoord: eerst inloggen, daarna terug naar dit scherm.
  if (gebruiker === undefined && req.method === 'GET' && wachtwoordAan()) {
    res.writeHead(303, { Location: `/inloggen?terug=${encodeURIComponent(url.pathname + url.search)}`, 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (!gebruiker) {
    return pagina(res, gebruiker === undefined ? 401 : 403, 'Geen toegang', foutHtml(gebruiker === undefined
      ? 'Je bent niet ingelogd.'
      : 'Je bent ingelogd, maar hebt nog geen toegang tot de Regiochecker. Vraag een beheerder om je uit te nodigen.'));
  }
  const kleur = kleurVan(gebruiker);
  try {
    if (req.method === 'GET') {
      const v = oauth.begin(url.searchParams, gebruiker, basis);
      return pagina(res, 200, 'App koppelen', toestemmingHtml(v, gebruiker), kleur);
    }
    if (req.method === 'POST') {
      // Alleen een formulier van deze site zelf.
      const herkomst = req.headers.origin;
      if (herkomst && herkomst !== 'null' && herkomst !== new URL(basis).origin) throw new OAuthFout('invalid_request', 'Dit formulier komt niet van de Regiochecker.');
      const p = new URLSearchParams(await leesLijf(req, 4000));
      const akkoord = p.get('besluit') === 'toestaan';
      const { adres, verzoek } = oauth.besluit(p.get('verzoek'), gebruiker, akkoord, basis);
      if (akkoord) opslag?.log({ soort: 'koppeling', tekst: `${gebruiker.naam || gebruiker.login} gaf ${verzoek.appNaam} toegang (MCP)` });
      res.writeHead(303, { Location: adres, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return res.end();
    }
    throw new OAuthFout('invalid_request', 'Alleen GET en POST', { status: 405 });
  } catch (fout) {
    if (!(fout instanceof OAuthFout)) throw fout;
    // Een fout die de app moet horen (en mag horen): terug naar de app.
    if (fout.terug) {
      res.writeHead(303, { Location: terugAdres(fout.terug, { error: fout.code, error_description: fout.message, state: fout.state, iss: basis }) });
      return res.end();
    }
    return pagina(res, fout.status, 'Koppelen lukt niet', foutHtml(fout.message), kleur);
  }
}

// Het adres van de aanvrager, voor de limiet op aanmelden. Traefik zet X-Real-Ip
// (en overschrijft wat een buitenstaander zelf meestuurt).
function ipVan(req) {
  const kop = req.headers['x-real-ip'];
  return String(Array.isArray(kop) ? kop[0] : kop || req.socket?.remoteAddress || '');
}
