// De dienst: webUI + API, en de klok die de bronnen afgaat en de mails verstuurt.
//
//   REGIOCHECKER_DATA      map voor de data (standaard ./data)
//   REGIOCHECKER_AUTH_KOP  koptekst met de ingelogde gebruiker, die Traefik na
//                          het inloggen via Authelia meestuurt (Remote-User; zie
//                          docker-compose.yml). Is hij ingesteld, dan weigert de
//                          API elk verzoek zonder die koptekst; zo kan iets dat de
//                          inlogmuur omzeilt (van binnen het Docker-netwerk) niets.
//                          Remote-Email en Remote-Name gebruiken we om iemand bij
//                          de eerste keer inloggen aan een uitnodiging te koppelen.
//                          Zonder deze instelling (alleen voor lokaal testen) is
//                          iedereen de gebruiker "lokaal".
//   REGIOCHECKER_SITE_URL  adres van de webUI, voor de links in de mails
//   ANTHROPIC_API_KEY      Claude-sleutel; mag ook in de webUI worden ingevuld
//   REGIOCHECKER_TAILNET_PROXY  HTTP-proxy van de Tailscale-container, voor
//                          Ollama en de Whisper-worker in het tailnet (src/tailnet.mjs)
//   WORKER_URL, WORKER_TOKEN  adres en token van de Whisper-worker voor audio en
//                          video; mogen ook in de webUI worden ingevuld
//   PORT                   standaard 3000

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Opslag } from './opslag.mjs';
import { verzamelAlles } from './verzamel.mjs';
import { stelMailSamen, mailGebruiker, mailronde, teMailen, allemaalMetWeekmail, herkansMislukte } from './mail.mjs';
import { verwerkMeldingen } from './meldingen.mjs';
import { verwerkKanalen } from './kanalen.mjs';
import { herken } from './gebruikers.mjs';
import { openKamerDb } from './kamer/db.mjs';
import { kamerRonde } from './kamer/ronde.mjs';
import { openFeedDb } from './feeddb.mjs';
import { AudioDb } from './audio/db.mjs';
import { Verwerking, isAudio } from './audio/verwerking.mjs';
import { deelLocatieIn } from './audio/namen.mjs';
import { api } from './api.mjs';

const hier = path.dirname(fileURLToPath(import.meta.url));
const PUBLIEK = path.join(hier, '..', 'public');
const opslag = new Opslag(process.env.REGIOCHECKER_DATA || path.join(hier, '..', 'data'));
const AUTH_KOP = (process.env.REGIOCHECKER_AUTH_KOP || '').toLowerCase();
const POORT = Number(process.env.PORT) || 3000;
const KAMER_INTERVAL_MS = 30 * 60000;

// De databases. Lukt het openen niet (te oude Node, kapot bestand), dan draait
// de rest gewoon door, zonder kamerstukken of zonder gelezen/bewaard en audio.
let kdb = null;
try {
  kdb = await openKamerDb(path.join(opslag.map, 'kamerstukken.sqlite'));
  opslag.kamer = kdb;
} catch (fout) {
  console.error('Kamerstukken niet beschikbaar:', fout.message);
}
let fdb = null;
let adb = null;
try {
  fdb = await openFeedDb(path.join(opslag.map, 'regiochecker.sqlite'));
  opslag.feeddb = fdb;
  adb = new AudioDb(fdb.db);
  opslag.audiodb = adb;
} catch (fout) {
  console.error('Gelezen/bewaard en audio niet beschikbaar:', fout.message);
}

// Na elke ronde: de meldingen per mail, en wat er naar de Teams-kanalen moet.
async function meldingen() {
  try {
    const r = await verwerkMeldingen(ctx);
    const verstuurd = r.filter((m) => m.verstuurd).length;
    if (verstuurd) console.log(`Meldingen: ${verstuurd} verstuurd`);
  } catch (fout) {
    console.error('Meldingen mislukt:', fout);
  }
  try {
    const r = await verwerkKanalen(ctx);
    const stukken = r.reduce((n, c) => n + (c.verstuurd || 0), 0);
    if (stukken) console.log(`Teams: ${stukken} stukken naar ${r.filter((c) => c.verstuurd).length} kanalen`);
  } catch (fout) {
    console.error('Teams mislukt:', fout);
  }
}

async function kamerTik() {
  if (!kdb) return;
  const r = await kamerRonde(opslag, kdb);
  if (r.ok) {
    console.log(`Kamerronde: ${r.metadata.nieuw} nieuw, ${r.teksten.gelukt} teksten (${r.teksten.over} te gaan)`);
    await meldingen();
  } else {
    console.error('Kamerronde mislukt:', r.fout);
  }
}

// Audio en video: de verwerking loopt zelf (src/audio/verwerking.mjs). Een
// nieuw transcript kan een melding opleveren; even wachten, want na een
// archief vol oude afleveringen komen er vaak meer tegelijk.
let meldingWekker = null;
const verwerking = adb ? new Verwerking({ opslag, adb }, {
  bijBeschikbaar: () => {
    clearTimeout(meldingWekker);
    meldingWekker = setTimeout(meldingen, 60_000);
  },
}) : null;
const ctx = { opslag, kdb, fdb, adb, verwerking };

// ---------- planning ----------

let tikBezig = false;
async function tik() {
  if (tikBezig) return;
  tikBezig = true;
  try {
    const interval = Math.max(15, Number(opslag.instellingen.controleIntervalMinuten) || 60) * 60000;
    const vorige = Date.parse(opslag.status.laatsteVerzamelronde || 0);
    const nu = new Date();
    const weekmails = teMailen(opslag, nu);
    let verzameld = false;
    // Vlak voor een weekmail altijd een verse ronde, tenzij die net is gedaan,
    // zodat de mail echt alles bevat tot het moment van versturen.
    if ((weekmails.length && Date.now() - vorige > 10 * 60000) || Date.now() - vorige >= interval) {
      const resultaten = await verzamelAlles(opslag);
      verzameld = true;
      console.log(`Verzamelronde: ${resultaten.reduce((n, r) => n + (r.nieuw || 0), 0)} nieuw, ${resultaten.filter((r) => !r.ok).length} bronnen mislukt`);
    }
    if (weekmails.length) {
      const resultaten = await mailronde(opslag, new Date(), undefined, weekmails);
      console.log(`Weekmails: ${resultaten.filter((r) => r.verstuurd).length} verstuurd, ${resultaten.filter((r) => r.fout).length} mislukt`);
    }
    if (verzameld) await meldingen();
    await herkansMislukte(opslag, new Date());
  } catch (fout) {
    console.error('Fout in de planner:', fout);
    opslag.log({ soort: 'fout', tekst: `Planner: ${fout.message}` });
  } finally {
    tikBezig = false;
  }
}

// ---------- taken ----------
// Lange acties (samenvatting via Ollama, versturen, een verzamelronde) draaien
// als taak op de achtergrond; de webUI vraagt de voortgang op. Een verzoek dat
// zelf minuten duurt, breekt Cloudflare na 100 seconden af, terwijl de server
// doorgaat: dan ziet de gebruiker een fout terwijl de mail wél vertrekt.

class Fout extends Error {
  constructor(status, bericht) { super(bericht); this.status = status; }
}

const takenLijst = new Map();
const TAAK_BEWAREN_MS = 3600000;

function zoekGebruiker(id) {
  const g = opslag.gebruikers.find((x) => x.id === id);
  if (!g) throw new Fout(404, 'Gebruiker niet gevonden');
  return g;
}

const SOORTEN_TAAK = {
  // Voorbeeld van de weekmail. Met dagen=N de stukken van de afgelopen N dagen
  // in plaats van "sinds de vorige mail"; samenvatting alleen als daarom gevraagd.
  voorbeeld: (invoer, voortgang) => {
    const g = zoekGebruiker(invoer.gebruiker);
    const dagen = Number(invoer.dagen) || 0;
    return stelMailSamen(opslag, g, {
      sinds: dagen ? new Date(Date.now() - dagen * 86400000).toISOString() : undefined,
      samenvatting: Boolean(invoer.samenvatting),
      voortgang,
    }).then((mail) => ({ onderwerp: mail.onderwerp, html: mail.html }));
  },
  verstuur: async (invoer, voortgang) => {
    const g = zoekGebruiker(invoer.gebruiker);
    if (!g.email) throw new Error('Deze gebruiker heeft geen e-mailadres');
    try {
      return await mailGebruiker(opslag, g, { forceer: true, voortgang });
    } catch (fout) {
      opslag.log({ soort: 'mailfout', aan: g.email, tekst: fout.message });
      throw new Error(`Versturen mislukt: ${fout.message}`);
    }
  },
  mailronde: (invoer, voortgang) => mailronde(opslag, new Date(), voortgang, allemaalMetWeekmail(opslag)),
  // "Nu controleren": alle websites, en alle audiobronnen op nieuwe afleveringen.
  verzamel: async (invoer, voortgang) => {
    const resultaten = await verzamelAlles(opslag, voortgang);
    if (verwerking) {
      const audio = opslag.bronnen.filter((b) => isAudio(b) && b.audio.actief !== false);
      for (const [n, b] of audio.entries()) {
        voortgang?.({ stap: n + 1, totaal: audio.length, tekst: `audio: ${b.naam}` });
        resultaten.push({ bron: b.id, ...(await verwerking.synchroniseer(b)) });
      }
    }
    await meldingen();
    return resultaten;
  },
  kamer: async (invoer, voortgang) => {
    if (!kdb) throw new Error('De kamerstukkendatabase is niet beschikbaar');
    const r = await kamerRonde(opslag, kdb, voortgang);
    if (!r.ok) throw new Error(r.fout);
    await meldingen();
    return r;
  },
};

const publiekeTaak = ({ id, soort, status, voortgang, begin, resultaat, fout }) => ({ id, soort, status, voortgang, begin, resultaat, fout });

const taken = {
  start(soort, invoer) {
    const werk = SOORTEN_TAAK[soort];
    if (!werk) throw new Fout(404, `Onbekende taak "${soort}"`);
    // Fouten in de invoer (onbekende gebruiker) meteen melden, niet pas bij het opvragen.
    if (soort === 'voorbeeld' || soort === 'verstuur') zoekGebruiker(invoer.gebruiker);
    for (const [id, t] of takenLijst) {
      if (t.status !== 'bezig' && Date.now() - Date.parse(t.begin) > TAAK_BEWAREN_MS) takenLijst.delete(id);
    }
    const taak = { id: randomUUID(), soort, status: 'bezig', voortgang: null, begin: new Date().toISOString(), resultaat: null, fout: null };
    takenLijst.set(taak.id, taak);
    Promise.resolve()
      .then(() => werk(invoer, (v) => { taak.voortgang = v; }))
      .then((resultaat) => Object.assign(taak, { status: 'klaar', resultaat }))
      .catch((fout) => Object.assign(taak, { status: 'fout', fout: fout.message }));
    return publiekeTaak(taak);
  },
  status(id) {
    const taak = takenLijst.get(id);
    if (!taak) throw new Fout(404, 'Taak niet gevonden (de dienst is misschien herstart)');
    return publiekeTaak(taak);
  },
};

// ---------- server ----------

async function leesJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    // Een formulier van een andere site kan geen JSON posten zonder dat de browser
    // eerst toestemming vraagt; dit is dus tegelijk de CSRF-bescherming.
    throw new Fout(415, 'Verwacht application/json');
  }
  let ruw = '';
  for await (const stuk of req) {
    ruw += stuk;
    if (ruw.length > 200_000) throw new Fout(413, 'Verzoek te groot');
  }
  try {
    return ruw ? JSON.parse(ruw) : {};
  } catch {
    throw new Fout(400, 'Ongeldige JSON');
  }
}

// Wie is dit? Achter Authelia uit de koppen; zonder (lokaal) de gebruiker "lokaal".
function wie(req) {
  if (!AUTH_KOP) return herken(opslag, { login: 'lokaal', naam: 'Lokaal' });
  const kop = (naam) => {
    const waarde = req.headers[naam];
    return Array.isArray(waarde) ? waarde[0] : waarde;
  };
  if (!kop(AUTH_KOP)) return undefined;
  return herken(opslag, { login: kop(AUTH_KOP), email: kop('remote-email'), naam: kop('remote-name') });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

async function statisch(req, res, pad) {
  const bestand = path.join(PUBLIEK, pad === '/' ? 'index.html' : pad);
  if (!bestand.startsWith(PUBLIEK + path.sep)) throw new Fout(404, 'Niet gevonden');
  let inhoud;
  try {
    inhoud = await readFile(bestand);
  } catch {
    throw new Fout(404, 'Niet gevonden');
  }
  // De huisstijl hangt af van de titel van wie er inlogt (LC of DVHN); dat
  // zetten we hier al op <html>, zodat de pagina meteen in de goede kleur staat.
  if (bestand.endsWith('index.html')) {
    let titel = 'lc';
    try { titel = (wie(req)?.titel || 'LC').toLowerCase(); } catch { /* standaard LC */ }
    inhoud = inhoud.toString('utf8').replace('<html lang="nl">', `<html lang="nl" data-titel="${titel === 'dvhn' ? 'dvhn' : 'lc'}">`);
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
  const stuur = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  try {
    if (url.pathname === '/gezond') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (url.pathname.startsWith('/api/')) {
      const gebruiker = wie(req);
      if (gebruiker === undefined) throw new Fout(401, 'Niet ingelogd');
      if (!gebruiker) throw new Fout(403, 'Je bent ingelogd, maar hebt nog geen toegang tot de Regiochecker. Vraag een beheerder om je uit te nodigen.');
      return await api(req, res, url, { ...ctx, gebruiker, stuur, leesJson, Fout, taken });
    }
    if (req.method !== 'GET') throw new Fout(405, 'Methode niet toegestaan');
    return await statisch(req, res, url.pathname);
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
  verwerking?.start();
  // De locatie-index (11 MB) alvast inlezen, zodat Audio-archief › Namen meteen opent.
  setTimeout(() => deelLocatieIn('Drachten'), 20_000);
});

// Alle schrijfacties zijn synchroon, dus stoppen kan op elk moment zonder half
// weggeschreven bestanden.
for (const signaal of ['SIGTERM', 'SIGINT']) process.on(signaal, () => process.exit(0));
