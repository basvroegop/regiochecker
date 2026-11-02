// Inloggen met één gedeeld wachtwoord, zonder Authelia (op verzoek van de
// opdrachtgever, 2 november 2026: "gewoon een simpel wachtwoord", alleen het
// wachtwoord, geen naam). Iedereen die het kent, is dezelfde gebruiker: de
// beheerder (src/dienst.mjs, gedeeldeGebruiker).
//
//   REGIOCHECKER_WACHTWOORD  het wachtwoord als scrypt-hash, scrypt:<zout>:<hash>;
//                            maak hem met `node src/inloggen.mjs hash`. Alleen in
//                            .env, nooit in de (openbare) repo. Geen $ in de hash:
//                            docker compose vult $… in een env-bestand in.
//
// Na inloggen een ondertekend sessiekoekje van 30 dagen; wie de site gebruikt,
// blijft ingelogd. Het geheim voor de handtekening staat in data/sessiegeheim
// (gemaakt bij de eerste start). Een nieuw wachtwoord maakt alle sessies
// ongeldig: de hash zit in de handtekening.

import { randomBytes, scrypt as scryptCb, scryptSync, createHmac, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { html } from './html.mjs';

const scrypt = promisify(scryptCb);
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 ** 2 };
export const KOEKJE = 'rc_sessie';
const SESSIE_MS = 30 * 86400_000;
// Een sessie die minder dan dit nog geldt, krijgt bij gebruik weer 30 dagen.
const VERLENG_MS = 15 * 86400_000;
// Mislukte pogingen: per adres 10 per kwartier, en over alle adressen samen 200
// per uur, zodat het wachtwoord niet te raden is.
const PER_ADRES = 10;
const ADRES_MS = 15 * 60_000;
const ALLES = 200;
const ALLES_MS = 3600_000;

export const wachtwoordAan = () => Boolean(process.env.REGIOCHECKER_WACHTWOORD);

export function maakHash(wachtwoord) {
  const zout = randomBytes(16);
  const hash = scryptSync(String(wachtwoord), zout, 32, SCRYPT);
  return `scrypt:${zout.toString('base64url')}:${hash.toString('base64url')}`;
}

export async function klopt(wachtwoord, opgeslagen = process.env.REGIOCHECKER_WACHTWOORD) {
  const [soort, zout, hash] = String(opgeslagen || '').split(':');
  if (soort !== 'scrypt' || !zout || !hash) return false;
  const verwacht = Buffer.from(hash, 'base64url');
  const gekregen = await scrypt(String(wachtwoord ?? '').slice(0, 1000), Buffer.from(zout, 'base64url'), verwacht.length, SCRYPT);
  return gekregen.length === verwacht.length && timingSafeEqual(gekregen, verwacht);
}

// Het geheim voor de handtekening: één keer gemaakt, in de datamap.
export function sessieGeheim(map) {
  const pad = path.join(map, 'sessiegeheim');
  if (!existsSync(pad)) writeFileSync(pad, randomBytes(32).toString('base64url'), { mode: 0o600 });
  return readFileSync(pad, 'utf8').trim();
}

export class Sessies {
  constructor(geheim, { klok = () => Date.now() } = {}) {
    this.geheim = geheim;
    this.klok = klok;
  }

  teken(verloopt) {
    return createHmac('sha256', this.geheim).update(`${verloopt}|${process.env.REGIOCHECKER_WACHTWOORD || ''}`).digest('base64url');
  }

  maak(duur = SESSIE_MS) {
    const verloopt = this.klok() + duur;
    return `${verloopt}.${this.teken(verloopt)}`;
  }

  // { geldig, verlengen } voor de waarde van het koekje.
  bekijk(waarde) {
    const [tijd, handtekening] = String(waarde || '').split('.');
    const verloopt = Number(tijd);
    if (!Number.isFinite(verloopt) || !handtekening || verloopt < this.klok()) return { geldig: false };
    const a = Buffer.from(handtekening);
    const b = Buffer.from(this.teken(verloopt));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { geldig: false };
    return { geldig: true, verlengen: verloopt - this.klok() < VERLENG_MS };
  }
}

export function leesKoekje(req, naam = KOEKJE) {
  for (const deel of String(req.headers.cookie || '').split(';')) {
    const i = deel.indexOf('=');
    if (i > 0 && deel.slice(0, i).trim() === naam) return deel.slice(i + 1).trim();
  }
  return null;
}

// Secure alleen achter https (lokaal testen gaat over http).
const veilig = () => /^https:/.test(process.env.REGIOCHECKER_SITE_URL || '');
export const zetKoekje = (waarde) => `${KOEKJE}=${waarde}; Path=/; Max-Age=${SESSIE_MS / 1000}; HttpOnly; SameSite=Lax${veilig() ? '; Secure' : ''}`;
export const wisKoekje = () => `${KOEKJE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${veilig() ? '; Secure' : ''}`;

export class Pogingen {
  constructor({ klok = () => Date.now() } = {}) {
    this.klok = klok;
    this.perAdres = new Map();
    this.alles = [];
  }

  geblokkeerd(adres) {
    const nu = this.klok();
    this.alles = this.alles.filter((t) => nu - t < ALLES_MS);
    const eigen = (this.perAdres.get(adres) || []).filter((t) => nu - t < ADRES_MS);
    this.perAdres.set(adres, eigen);
    return eigen.length >= PER_ADRES || this.alles.length >= ALLES;
  }

  mislukt(adres) {
    const nu = this.klok();
    this.perAdres.set(adres, [...(this.perAdres.get(adres) || []), nu]);
    this.alles.push(nu);
    if (this.perAdres.size > 10_000) this.perAdres.clear();
  }

  gelukt(adres) {
    this.perAdres.delete(adres);
  }
}

// Alleen een pad op deze site als bestemming na inloggen, geen ander domein.
export function veiligTerug(terug) {
  const t = String(terug || '');
  return /^\/(?![/\\])[^\s\\]*$/.test(t) && !t.startsWith('/inloggen') ? t : '/';
}

// Het adres van de aanvrager. Traefik zet X-Real-Ip (en overschrijft wat een
// buitenstaander zelf meestuurt).
export function adresVan(req) {
  const kop = req.headers['x-real-ip'];
  return String(Array.isArray(kop) ? kop[0] : kop || req.socket?.remoteAddress || '');
}

function pagina(res, status, { fout = null, terug = '/' } = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(`<!doctype html>
<html lang="nl" data-titel="lc">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Inloggen · Regiochecker</title>
  <link rel="stylesheet" href="/modernist.css">
  <link rel="stylesheet" href="/stijl.css">
</head>
<body class="toestemming">
  <main class="toestemming-vak">
    <p class="logo"><span class="logo-blok"></span><span class="logo-naam">Regiochecker</span></p>
    <h1>Inloggen</h1>
    <form method="post" action="/inloggen" class="inlogformulier">
      <input type="hidden" name="terug" value="${html(terug)}">
      <label class="veld"><span>Wachtwoord</span><input class="invoer" type="password" name="wachtwoord" autocomplete="current-password" autofocus required></label>
      ${fout ? `<p class="statusregel fout">${html(fout)}</p>` : ''}
      <div class="knoppenrij"><button class="knop inkt">Inloggen</button></div>
    </form>
  </main>
</body>
</html>`);
}

async function leesFormulier(req) {
  let ruw = '';
  for await (const stuk of req) {
    ruw += stuk;
    if (ruw.length > 4000) break;
  }
  return new URLSearchParams(ruw);
}

// GET/POST /inloggen en POST /uitloggen. ctx: { sessies, pogingen }.
export async function inlogRoute(req, res, url, { sessies, pogingen }) {
  if (url.pathname === '/uitloggen') {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end();
    }
    res.writeHead(303, { Location: '/inloggen', 'Set-Cookie': wisKoekje(), 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (req.method === 'GET') return pagina(res, 200, { terug: veiligTerug(url.searchParams.get('terug')) });
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'GET, POST' });
    return res.end();
  }
  const p = await leesFormulier(req);
  const terug = veiligTerug(p.get('terug'));
  const adres = adresVan(req);
  if (pogingen.geblokkeerd(adres)) return pagina(res, 429, { fout: 'Te veel pogingen. Probeer het over een kwartier opnieuw.', terug });
  if (!(await klopt(p.get('wachtwoord')))) {
    pogingen.mislukt(adres);
    return pagina(res, 401, { fout: 'Dat wachtwoord klopt niet.', terug });
  }
  pogingen.gelukt(adres);
  res.writeHead(303, { Location: terug, 'Set-Cookie': zetKoekje(sessies.maak()), 'Cache-Control': 'no-store' });
  return res.end();
}

// `node src/inloggen.mjs hash`: vraagt het wachtwoord en geeft de regel voor .env.
if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href && process.argv[2] === 'hash') {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const wachtwoord = await rl.question('Wachtwoord: ');
  rl.close();
  console.log(`REGIOCHECKER_WACHTWOORD=${maakHash(wachtwoord)}`);
}
