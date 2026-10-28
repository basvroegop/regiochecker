// De dienst: webUI + API, en de klok die de bronnen afgaat en de mails verstuurt.
//
//   REGIOCHECKER_DATA      map voor de JSON-bestanden (standaard ./data)
//   REGIOCHECKER_AUTH_KOP  koptekst met de ingelogde gebruiker, die Traefik na
//                          het inloggen via Authelia meestuurt (Remote-User; zie
//                          docker-compose.yml). Is hij ingesteld, dan weigert de
//                          API elk verzoek zonder die koptekst; zo kan iets dat de
//                          inlogmuur omzeilt (van binnen het Docker-netwerk) niets.
//   REGIOCHECKER_SITE_URL  adres van de webUI, voor de link onderaan de mail
//   ANTHROPIC_API_KEY      Claude-sleutel; mag ook in de webUI worden ingevuld
//   REGIOCHECKER_TAILNET_PROXY  HTTP-proxy van de Tailscale-container, voor
//                          Ollama op een machine in het tailnet (src/ollama.mjs)
//   PORT                   standaard 3000

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Opslag } from './opslag.mjs';
import { REGIOS, SOORTEN } from './regios.mjs';
import { verzamelAlles } from './verzamel.mjs';
import { stelMailSamen, mailOntvanger, mailronde, herkansMislukte, verstuur } from './mail.mjs';
import { moetMailen, volgendMoment } from './planning.mjs';
import { samenvattingAanbieder } from './samenvatting.mjs';
import { ollamaInfo } from './ollama.mjs';
import { openKamerDb } from './kamer/db.mjs';
import { kamerApi } from './kamer/api.mjs';
import { kamerRonde } from './kamer/ronde.mjs';

const hier = path.dirname(fileURLToPath(import.meta.url));
const PUBLIEK = path.join(hier, '..', 'public');
const opslag = new Opslag(process.env.REGIOCHECKER_DATA || path.join(hier, '..', 'data'));
const AUTH_KOP = (process.env.REGIOCHECKER_AUTH_KOP || '').toLowerCase();
const POORT = Number(process.env.PORT) || 3000;
const KAMER_INTERVAL_MS = 30 * 60000;

// De kamerstukken (src/kamer/). Lukt het openen niet (te oude Node, kapot
// bestand), dan draait de rest gewoon door, zonder kamerstukken.
let kdb = null;
try {
  kdb = await openKamerDb(path.join(opslag.map, 'kamerstukken.sqlite'));
  opslag.kamer = kdb;
} catch (fout) {
  console.error('Kamerstukken niet beschikbaar:', fout.message);
}

async function kamerTik() {
  if (!kdb) return;
  const r = await kamerRonde(opslag, kdb);
  if (r.ok) {
    const verstuurd = r.meldingen.filter((m) => m.verstuurd).length;
    console.log(`Kamerronde: ${r.metadata.nieuw} nieuw, ${r.teksten.gelukt} teksten (${r.teksten.over} te gaan)${verstuurd ? `, ${verstuurd} meldingen` : ''}`);
  } else {
    console.error('Kamerronde mislukt:', r.fout);
  }
}

// ---------- planning ----------

let tikBezig = false;
async function tik() {
  if (tikBezig) return;
  tikBezig = true;
  try {
    const interval = Math.max(15, Number(opslag.instellingen.controleIntervalMinuten) || 60) * 60000;
    const vorige = Date.parse(opslag.status.laatsteVerzamelronde || 0);
    if (moetMailen(new Date(), opslag.instellingen, opslag.status)) {
      // Vlak voor het mailen altijd een verse ronde, tenzij die net is gedaan,
      // zodat de mail echt alles bevat tot het moment van versturen.
      if (Date.now() - vorige > 10 * 60000) await verzamelAlles(opslag);
      const resultaten = await mailronde(opslag, new Date());
      console.log(`Mailronde: ${resultaten.filter((r) => r.verstuurd).length} verstuurd, ${resultaten.filter((r) => r.fout).length} mislukt`);
    } else if (Date.now() - vorige >= interval) {
      const resultaten = await verzamelAlles(opslag);
      console.log(`Verzamelronde: ${resultaten.reduce((n, r) => n + (r.nieuw || 0), 0)} nieuw, ${resultaten.filter((r) => !r.ok).length} bronnen mislukt`);
    }
    await herkansMislukte(opslag, new Date());
  } catch (fout) {
    console.error('Fout in de planner:', fout);
    opslag.log({ soort: 'fout', tekst: `Planner: ${fout.message}` });
  } finally {
    tikBezig = false;
  }
}

// ---------- API ----------

class Fout extends Error {
  constructor(status, bericht) { super(bericht); this.status = status; }
}

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i;
const REGIO_IDS = new Set(REGIOS.map((r) => r.id));

function publiekeInstellingen() {
  const { smtp, claude, ...rest } = opslag.instellingen;
  return {
    ...rest,
    smtp: { host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user, from: smtp.from, heeftWachtwoord: Boolean(smtp.pass) },
    claude: {
      model: claude.model,
      heeftSleutel: Boolean(claude.apiKey || process.env.ANTHROPIC_API_KEY),
      sleutelUitOmgeving: !claude.apiKey && Boolean(process.env.ANTHROPIC_API_KEY),
    },
    // ollama (url, model, maxContext) bevat geen geheimen en gaat via ...rest mee.
    tailnetProxy: Boolean(process.env.REGIOCHECKER_TAILNET_PROXY),
    samenvatting: samenvattingAanbieder(opslag),
  };
}

function overzicht() {
  const week = new Date(Date.now() - 7 * 86400000).toISOString();
  const items = Object.values(opslag.items);
  return {
    regios: REGIOS.map((r) => ({
      id: r.id,
      naam: r.naam,
      site: r.site,
      bronnen: r.bronnen.map((b) => ({
        id: b.id,
        soort: b.soort,
        soortNaam: SOORTEN[b.soort],
        label: b.label,
        url: b.url,
        ontbreekt: b.type === 'ontbreekt',
        vervangend: Boolean(b.vervangend),
        toelichting: b.toelichting || null,
        status: opslag.status.bronnen[b.id] || null,
        nieuwDezeWeek: items.filter((i) => i.bron === b.id && !i.basislijn && i.eersteGezien > week).length,
      })),
    })),
    ontvangers: opslag.ontvangers,
    instellingen: publiekeInstellingen(),
    status: {
      laatsteVerzamelronde: opslag.status.laatsteVerzamelronde,
      laatsteMailronde: opslag.status.laatsteMailronde,
      volgendeMail: volgendMoment(new Date(), opslag.instellingen)?.toISOString() || null,
      kamer: kdb ? { ...kdb.status(), ronde: opslag.status.kamer || null } : null,
    },
  };
}

function itemsLijst(zoek) {
  const dagen = Math.min(60, Math.max(1, Number(zoek.get('dagen')) || 7));
  const grens = new Date(Date.now() - dagen * 86400000).toISOString();
  const regio = zoek.get('regio');
  return Object.values(opslag.items)
    .filter((i) => !i.basislijn && i.eersteGezien > grens && (!regio || i.regio === regio))
    .sort((a, b) => b.eersteGezien.localeCompare(a.eersteGezien))
    .slice(0, 500)
    .map(({ tekst, ...rest }) => ({ ...rest, heeftTekst: Boolean(tekst) }));
}

function controleerOntvanger(invoer, bestaand = {}) {
  const naam = String(invoer.naam ?? bestaand.naam ?? '').trim().slice(0, 100);
  const email = String(invoer.email ?? bestaand.email ?? '').trim().toLowerCase();
  if (!EMAIL.test(email)) throw new Fout(400, `"${email}" is geen geldig e-mailadres`);
  const regios = Array.isArray(invoer.regios) ? invoer.regios : (bestaand.regios || []);
  const onbekend = regios.filter((r) => !REGIO_IDS.has(r));
  if (onbekend.length) throw new Fout(400, `Onbekende regio: ${onbekend.join(', ')}`);
  const dubbel = opslag.ontvangers.find((o) => o.email === email && o.id !== bestaand.id);
  if (dubbel) throw new Fout(400, `${email} staat er al in; vink bij die ontvanger de extra regio aan`);
  return {
    naam,
    email,
    regios: REGIOS.map((r) => r.id).filter((id) => regios.includes(id)),
    actief: invoer.actief ?? bestaand.actief ?? true,
  };
}

function werkInstellingenBij(invoer) {
  const i = opslag.instellingen;
  const vorigSchema = `${i.mailTijd} ${i.mailDagen}`;
  if (invoer.mailTijd !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(invoer.mailTijd)) throw new Fout(400, 'Tijd moet de vorm UU:MM hebben, bijvoorbeeld 07:00');
    i.mailTijd = invoer.mailTijd;
  }
  if (invoer.mailDagen !== undefined) {
    if (!Array.isArray(invoer.mailDagen) || invoer.mailDagen.some((d) => ![1, 2, 3, 4, 5, 6, 7].includes(d))) throw new Fout(400, 'Ongeldige maildagen');
    i.mailDagen = [...new Set(invoer.mailDagen)].sort();
  }
  // Een nieuw schema geldt vanaf nu; een moment dat daardoor "in het verleden"
  // valt, wordt niet alsnog verstuurd (zie planning.mjs).
  if (`${i.mailTijd} ${i.mailDagen}` !== vorigSchema) {
    opslag.status.planningVanaf = new Date().toISOString();
    opslag.bewaar('status');
  }
  if (invoer.mailBijNiets !== undefined) i.mailBijNiets = Boolean(invoer.mailBijNiets);
  if (invoer.controleIntervalMinuten !== undefined) {
    const n = Number(invoer.controleIntervalMinuten);
    if (!(n >= 15 && n <= 1440)) throw new Fout(400, 'Controle-interval moet tussen 15 en 1440 minuten liggen');
    i.controleIntervalMinuten = n;
  }
  if (invoer.smtp) {
    const s = invoer.smtp;
    for (const veld of ['host', 'user', 'from']) if (s[veld] !== undefined) i.smtp[veld] = String(s[veld]).trim();
    if (s.port !== undefined) i.smtp.port = Number(s.port) || 587;
    if (s.secure !== undefined) i.smtp.secure = Boolean(s.secure);
    // Een leeg wachtwoordveld betekent "niet wijzigen"; wissen gaat expliciet.
    if (s.pass) i.smtp.pass = String(s.pass);
    if (s.wisWachtwoord) i.smtp.pass = '';
  }
  if (invoer.claude) {
    if (invoer.claude.apiKey) i.claude.apiKey = String(invoer.claude.apiKey).trim();
    if (invoer.claude.wisSleutel) i.claude.apiKey = '';
    if (invoer.claude.model) i.claude.model = String(invoer.claude.model).trim();
  }
  if (invoer.samenvattingVia !== undefined) {
    if (!['claude', 'ollama', 'uit'].includes(invoer.samenvattingVia)) throw new Fout(400, 'Kies Claude, Ollama of uit');
    i.samenvattingVia = invoer.samenvattingVia;
  }
  if (invoer.ollama) {
    const o = invoer.ollama;
    if (o.url !== undefined) {
      const url = String(o.url).trim().replace(/\/+$/, '');
      if (url && !/^https?:\/\/[^/\s]+$/.test(url)) throw new Fout(400, 'Ollama-URL moet de vorm http://machine:11434 hebben, zonder pad');
      i.ollama.url = url;
    }
    if (o.model !== undefined) i.ollama.model = String(o.model).trim();
    if (o.maxContext !== undefined) {
      const n = Number(o.maxContext);
      if (!(n >= 4096 && n <= 262144)) throw new Fout(400, 'Contextvenster moet tussen 4096 en 262144 tokens liggen');
      i.ollama.maxContext = n;
    }
  }
  opslag.bewaar('instellingen');
}

// ---------- taken ----------

const taken = new Map();
const TAAK_BEWAREN_MS = 3600000;

const SOORTEN_TAAK = {
  // Voorbeeld van de mail. Met dagen=N de berichten van de afgelopen N dagen in
  // plaats van "sinds de vorige mail"; samenvatting alleen als daarom gevraagd.
  voorbeeld: (invoer, voortgang) => {
    const o = zoekOntvanger(invoer.ontvanger);
    const dagen = Number(invoer.dagen) || 0;
    return stelMailSamen(opslag, o, {
      sinds: dagen ? new Date(Date.now() - dagen * 86400000).toISOString() : undefined,
      samenvatting: Boolean(invoer.samenvatting),
      voortgang,
    }).then((mail) => ({ onderwerp: mail.onderwerp, html: mail.html }));
  },
  verstuur: async (invoer, voortgang) => {
    const o = zoekOntvanger(invoer.ontvanger);
    try {
      return await mailOntvanger(opslag, o, { forceer: true, voortgang });
    } catch (fout) {
      opslag.log({ soort: 'mailfout', aan: o.email, tekst: fout.message });
      throw new Error(`Versturen mislukt: ${fout.message}`);
    }
  },
  mailronde: (invoer, voortgang) => mailronde(opslag, new Date(), voortgang),
  verzamel: (invoer, voortgang) => verzamelAlles(opslag, voortgang),
  kamer: async (invoer, voortgang) => {
    if (!kdb) throw new Error('De kamerstukkendatabase is niet beschikbaar');
    const r = await kamerRonde(opslag, kdb, voortgang);
    if (!r.ok) throw new Error(r.fout);
    return r;
  },
};

function startTaak(soort, invoer) {
  const werk = SOORTEN_TAAK[soort];
  if (!werk) throw new Fout(404, `Onbekende taak "${soort}"`);
  // Fouten in de invoer (onbekende ontvanger) meteen melden, niet pas bij het opvragen.
  if (soort === 'voorbeeld' || soort === 'verstuur') zoekOntvanger(invoer.ontvanger);
  for (const [id, t] of taken) {
    if (t.status !== 'bezig' && Date.now() - Date.parse(t.begin) > TAAK_BEWAREN_MS) taken.delete(id);
  }
  const taak = { id: randomUUID(), soort, status: 'bezig', voortgang: null, begin: new Date().toISOString(), resultaat: null, fout: null };
  taken.set(taak.id, taak);
  Promise.resolve()
    .then(() => werk(invoer, (v) => { taak.voortgang = v; }))
    .then((resultaat) => Object.assign(taak, { status: 'klaar', resultaat }))
    .catch((fout) => Object.assign(taak, { status: 'fout', fout: fout.message }));
  return taak;
}

const publiekeTaak = ({ id, soort, status, voortgang, begin, resultaat, fout }) => ({ id, soort, status, voortgang, begin, resultaat, fout });

function zoekOntvanger(id) {
  const o = opslag.ontvangers.find((x) => x.id === id);
  if (!o) throw new Fout(404, 'Ontvanger niet gevonden');
  return o;
}

async function leesJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    // Een formulier van een andere site kan geen JSON posten zonder dat de browser
    // eerst toestemming vraagt; dit is dus tegelijk de CSRF-bescherming.
    throw new Fout(415, 'Verwacht application/json');
  }
  let ruw = '';
  for await (const stuk of req) {
    ruw += stuk;
    if (ruw.length > 100_000) throw new Fout(413, 'Verzoek te groot');
  }
  try {
    return ruw ? JSON.parse(ruw) : {};
  } catch {
    throw new Fout(400, 'Ongeldige JSON');
  }
}

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const deel = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const stuur = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };

  if (route === 'GET /api/overzicht') return stuur(overzicht());
  if (route === 'GET /api/items') return stuur(itemsLijst(url.searchParams));
  if (route === 'GET /api/logboek') return stuur(opslag.logboek.slice(0, 200));
  if (url.pathname.startsWith('/api/kamer/')) {
    await kamerApi(req, res, url, { opslag, kdb, stuur, leesJson, Fout, EMAIL });
    return;
  }

  if (route === 'POST /api/ontvangers') {
    const o = { id: randomUUID(), ...controleerOntvanger(await leesJson(req)), aangemaakt: new Date().toISOString(), laatsteMail: null };
    opslag.ontvangers.push(o);
    opslag.bewaar('ontvangers');
    return stuur(o, 201);
  }
  if (deel[1] === 'ontvangers' && deel[2]) {
    const o = zoekOntvanger(deel[2]);
    if (req.method === 'PUT' && deel.length === 3) {
      Object.assign(o, controleerOntvanger(await leesJson(req), o));
      opslag.bewaar('ontvangers');
      return stuur(o);
    }
    if (req.method === 'DELETE' && deel.length === 3) {
      opslag.ontvangers = opslag.ontvangers.filter((x) => x.id !== o.id);
      opslag.bewaar('ontvangers');
      return stuur({ ok: true });
    }
  }

  if (route === 'PUT /api/instellingen') {
    werkInstellingenBij(await leesJson(req));
    return stuur(publiekeInstellingen());
  }
  // Verbinding met Ollama testen, met de URL uit het formulier (nog niet bewaard).
  if (route === 'POST /api/ollama/test') {
    const { url } = await leesJson(req);
    try {
      return stuur(await ollamaInfo(url || opslag.instellingen.ollama.url));
    } catch (fout) {
      throw new Fout(502, fout.message);
    }
  }
  if (route === 'POST /api/testmail') {
    const { aan } = await leesJson(req);
    if (!EMAIL.test(String(aan || ''))) throw new Fout(400, 'Vul een geldig e-mailadres in');
    try {
      await verstuur(opslag, {
        aan,
        onderwerp: 'Regiochecker: testmail',
        tekst: 'De SMTP-instellingen van de Regiochecker werken.',
        html: '<p style="font-family:Arial,sans-serif">De SMTP-instellingen van de Regiochecker werken.</p>',
      });
    } catch (fout) {
      throw new Fout(502, `Testmail mislukt: ${fout.message}`);
    }
    opslag.log({ soort: 'testmail', aan, tekst: 'Testmail verstuurd' });
    return stuur({ ok: true });
  }
  // Lange acties (samenvatting via Ollama, versturen, een verzamelronde) draaien
  // als taak op de achtergrond; de webUI vraagt de voortgang op. Een verzoek dat
  // zelf minuten duurt, breekt Cloudflare na 100 seconden af, terwijl de server
  // doorgaat: dan ziet de gebruiker een fout terwijl de mail wél vertrekt.
  if (req.method === 'POST' && deel[1] === 'taken' && deel[2]) {
    const invoer = await leesJson(req);
    return stuur(publiekeTaak(startTaak(deel[2], invoer)), 202);
  }
  if (req.method === 'GET' && deel[1] === 'taken' && deel[2]) {
    const taak = taken.get(deel[2]);
    if (!taak) throw new Fout(404, 'Taak niet gevonden (de dienst is misschien herstart)');
    return stuur(publiekeTaak(taak));
  }

  throw new Fout(404, 'Onbekende route');
}

// ---------- server ----------

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

async function statisch(res, pad) {
  const bestand = path.join(PUBLIEK, pad === '/' ? 'index.html' : pad);
  if (!bestand.startsWith(PUBLIEK + path.sep)) throw new Fout(404, 'Niet gevonden');
  let inhoud;
  try {
    inhoud = await readFile(bestand);
  } catch {
    throw new Fout(404, 'Niet gevonden');
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(bestand)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(inhoud);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/gezond') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (url.pathname.startsWith('/api/')) {
      if (AUTH_KOP && !req.headers[AUTH_KOP]) throw new Fout(401, 'Niet ingelogd');
      return await api(req, res, url);
    }
    if (req.method !== 'GET') throw new Fout(405, 'Methode niet toegestaan');
    return await statisch(res, url.pathname);
  } catch (fout) {
    const status = fout.status || 500;
    if (status === 500) console.error(fout);
    if (!res.headersSent) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ fout: status === 500 ? `Interne fout: ${fout.message}` : fout.message }));
    } else {
      res.end();
    }
  }
});

if (!opslag.status.planningVanaf) {
  opslag.status.planningVanaf = new Date().toISOString();
  opslag.bewaar('status');
}

server.listen(POORT, () => {
  console.log(`Regiochecker luistert op poort ${POORT}; data in ${opslag.map}`);
  if (!AUTH_KOP) console.warn('Let op: REGIOCHECKER_AUTH_KOP staat niet ingesteld, de API is zonder inlog bereikbaar.');
  setTimeout(tik, 5000);
  setInterval(tik, 60000);
  setTimeout(kamerTik, 30000);
  setInterval(kamerTik, KAMER_INTERVAL_MS);
});

// Alle schrijfacties zijn synchroon, dus stoppen kan op elk moment zonder half
// weggeschreven bestanden.
for (const signaal of ['SIGTERM', 'SIGINT']) process.on(signaal, () => process.exit(0));
