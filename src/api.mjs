// De API achter de webUI. Elk verzoek komt van een ingelogde gebruiker
// (src/gebruikers.mjs); de routes onder /api/beheer en de instellingen zijn
// alleen voor admins.
//
//   GET  /api/ik                     wie ben ik, welke regio's, bewaard-teller
//   PUT  /api/ik                     eigen regio's en weekmail
//   GET  /api/feed                   ?groep=&regio=&ongelezen=1&dagen=
//   GET  /api/feed/bewaard           bewaarde stukken
//   GET  /api/zoek?q=                zoeken in alle bronnen
//   GET  /api/stuk?id=               één stuk voor het leespaneel
//   PUT  /api/stuk                   { id, gelezen?, bewaard?, notitie? }
//   …    /api/meldingen[/id]         directe meldingen van deze gebruiker
//   …    /api/audio/…                audio en video (src/audio/api.mjs)
//   GET  /api/ingezonden/{map}/{bestand}   foto of video van een inzending (src/telegram.mjs)
//   …    /api/beheer/…               src/beheer.mjs

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { isBeheerder, werkGebruikerBij, voorClient } from './gebruikers.mjs';
import { alleRegios, alleBronnen } from './register.mjs';
import { zichtbareGroepen, ENKELVOUD } from './regios.mjs';
import { maakKader, bouwFeed, bewaardeFeed, zoekFeed, detail, momentopname, meldingTreffers } from './feed.mjs';
import { controleerMelding, BRONNEN } from './meldingen.mjs';
import { zoekvraagTekst } from './termen.mjs';
import { beheerApi } from './beheer.mjs';
import { rondKoppelingAf, debatVideo, naarVideoTijd } from './gehoord.mjs';
import { videoVoor } from './audio/vergaderingen.mjs';
import { kamerApi } from './kamer/api.mjs';
import { publiekeInstellingen, werkInstellingenBij } from './instellingen.mjs';
import { ollamaInfo } from './ollama.mjs';
import { audioApi, stuurBestand } from './audio/api.mjs';
import { worker as audioWorker } from './audio/worker.mjs';
import { verstuur } from './mail.mjs';
import { volgendeWeekmail } from './planning.mjs';
import { documentOpVraag } from './inhoud.mjs';
import { accountsAan } from './accounts.mjs';

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i;
const MEDIATYPE = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
const DAG_MS = 86400000;

function meldingVoorClient(k, gebruiker, m) {
  const regio = k.regioMap.get(m.bereik);
  return {
    ...m,
    zoekvraag: zoekvraagTekst(m.termen),
    bereikNaam: m.bereik === 'overal' ? 'Overal' : m.bereik === 'mijn' ? 'Mijn regio\'s' : regio?.naam || m.bereik,
    bronnenNaam: BRONNEN[m.bronnen] || BRONNEN.alle,
    aantal30: meldingTreffers(k, gebruiker, m, { sinds: new Date(Date.now() - 30 * DAG_MS).toISOString() }).length,
  };
}

export async function api(req, res, url, ctx) {
  const { opslag, kdb, fdb, adb, verwerking, gebruiker, stuur, leesJson, Fout, taken } = ctx;
  const route = `${req.method} ${url.pathname}`;
  const deel = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const z = url.searchParams;
  const beheerder = isBeheerder(gebruiker);
  const alleenBeheer = () => { if (!beheerder) throw new Fout(403, 'Alleen voor beheerders'); };
  const k = () => maakKader({ opslag, kdb, fdb, adb });

  // ---------- ik ----------
  if (route === 'GET /api/ik') {
    const nu = new Date();
    return stuur({
      gebruiker: voorClient(gebruiker),
      beheerder,
      regios: alleRegios(opslag).map((r) => ({ id: r.id, naam: r.naam })),
      groepen: zichtbareGroepen(alleBronnen(opslag)),
      soorten: ENKELVOUD,
      bewaard: fdb ? fdb.aantalBewaard(gebruiker.id) : 0,
      volgendeWeekmail: volgendeWeekmail(nu, gebruiker)?.toISOString() || null,
      laatsteVerzamelronde: opslag.status.laatsteVerzamelronde,
      audio: Boolean(adb),
      // Maakt Uitnodigen ook het Authelia-account aan (src/accounts.mjs)?
      autheliaAccounts: beheerder && accountsAan(),
    });
  }
  if (route === 'PUT /api/ik') {
    const invoer = await leesJson(req);
    const toegestaan = {};
    for (const veld of ['naam', 'regios', 'weekmail']) if (invoer[veld] !== undefined) toegestaan[veld] = invoer[veld];
    werkGebruikerBij(opslag, gebruiker, toegestaan, { regioIds: alleRegios(opslag).map((r) => r.id) });
    opslag.bewaar('gebruikers');
    return stuur({ gebruiker: voorClient(gebruiker), volgendeWeekmail: volgendeWeekmail(new Date(), gebruiker)?.toISOString() || null });
  }

  // ---------- feed en stukken ----------
  const filters = { groep: z.get('groep') || '', regio: z.get('regio') || '', ongelezen: z.get('ongelezen') === '1', dagen: Number(z.get('dagen')) || undefined };
  if (route === 'GET /api/feed') return stuur(bouwFeed(k(), gebruiker, filters));
  if (route === 'GET /api/feed/bewaard') {
    if (!fdb) throw new Fout(503, 'Bewaren is niet beschikbaar (database ontbreekt)');
    return stuur(bewaardeFeed(k(), gebruiker, filters));
  }
  if (route === 'GET /api/zoek') return stuur(zoekFeed(k(), gebruiker, String(z.get('q') || '').slice(0, 300)));
  if (route === 'GET /api/stuk') {
    const d = detail(k(), gebruiker, String(z.get('id') || ''));
    if (!d) throw new Fout(404, 'Dit stuk bestaat niet (meer)');
    return stuur(d);
  }
  // De video van een Kamerdebat (Debat Direct). De tijden in het transcript
  // staan dan op de klok van de video (`tijdbasis`); een debat van vóór die
  // regel wordt hier één keer omgezet. `nul`: de kloktijd van 0:00 in het
  // transcript, waarmee de speler een tijd in de video vindt (src/gehoord.mjs).
  if (route === 'GET /api/stuk/video') {
    const af = adb?.aflevering(String(z.get('id') || '').replace(/^a:/, ''));
    // Een raadsvergadering: de video van het platform, op dezelfde tijden als het transcript.
    if (af?.vorm === 'vergadering') {
      try {
        return stuur({ video: await videoVoor(af), nul: null });
      } catch (fout) {
        return stuur({ video: null, nul: null, fout: fout.message });
      }
    }
    if (!af || af.vorm !== 'gehoord') throw new Fout(404, 'Deze aflevering heeft geen video');
    const antwoord = (p) => ({ video: p.video, nul: p.tijdbasis === 'video' ? p.video.begin : p.klokBegin, klokBegin: p.klokBegin });
    const p = af.platform || {};
    if (p.video !== undefined && p.klokBegin && (p.video === null || p.tijdbasis === 'video')) return stuur(antwoord(p));
    let r;
    try {
      r = await debatVideo(opslag, af);
    } catch (fout) {
      // Tijdelijk niet te bereiken: niets bewaren, de volgende keer opnieuw.
      return stuur({ video: null, nul: p.klokBegin || null, fout: fout.message });
    }
    const nieuw = { agenda: [], sprekers: [], ...p, debat: r.debat, klokBegin: r.klokBegin, video: r.video, tijdbasis: r.video ? 'video' : 'gehoord' };
    const segmenten = r.video && p.tijdbasis !== 'video' ? naarVideoTijd(af.segmenten, r.klokBegin, r.video.begin) : null;
    adb.werkBij(af.id, { platform: nieuw, ...(segmenten ? { segmenten, duur: segmenten.at(-1)?.end ?? af.duur } : {}) });
    return stuur({ ...antwoord(nieuw), omgezet: Boolean(segmenten) });
  }
  if (route === 'GET /api/stuk/document') {
    const id = String(z.get('id') || '');
    if (!id.startsWith('i:') || !opslag.items[id.slice(2)]) throw new Fout(404, 'Dit stuk bestaat niet (meer)');
    let document;
    try {
      document = await documentOpVraag(opslag, id.slice(2));
    } catch (fout) {
      // Weggehaald bij de bron: geen fout, maar dat feit.
      const weg = opslag.items[id.slice(2)]?.verdwenen;
      if (weg) return stuur({ document: null, verdwenen: weg });
      throw new Fout(502, `Het document kon niet worden opgehaald: ${fout.message}`);
    }
    if (!document) throw new Fout(404, 'Van deze bron wordt geen document opgehaald');
    return stuur({ document });
  }
  if (route === 'PUT /api/stuk') {
    if (!fdb) throw new Fout(503, 'Bewaren is niet beschikbaar (database ontbreekt)');
    const invoer = await leesJson(req);
    const id = String(invoer.id || '');
    if (!/^[ika]:./.test(id)) throw new Fout(400, 'Ongeldig stuk');
    const wijziging = {};
    for (const veld of ['gelezen', 'bewaard']) if (invoer[veld] !== undefined) wijziging[veld] = Boolean(invoer[veld]);
    if (invoer.notitie !== undefined) wijziging.notitie = String(invoer.notitie);
    // Bij bewaren een momentopname, zodat het stuk in Bewaard blijft staan.
    if (wijziging.bewaard) wijziging.momentopname = momentopname(k(), gebruiker, id);
    const status = fdb.zet(gebruiker.id, id, wijziging);
    return stuur({ status, bewaard: fdb.aantalBewaard(gebruiker.id) });
  }

  // ---------- meldingen ----------
  const regioIds = () => alleRegios(opslag).map((r) => r.id);
  if (route === 'GET /api/meldingen') {
    const kader = k();
    return stuur(opslag.meldingen.filter((m) => m.gebruiker === gebruiker.id).map((m) => meldingVoorClient(kader, gebruiker, m)));
  }
  if (route === 'POST /api/meldingen') {
    if (!gebruiker.email) throw new Fout(400, 'Er staat nog geen e-mailadres bij je account; vraag een beheerder');
    const m = {
      id: randomUUID(),
      gebruiker: gebruiker.id,
      ...controleerMelding(await leesJson(req), null, { regioIds: regioIds() }),
      aangemaakt: new Date().toISOString(),
      laatsteMelding: null,
    };
    opslag.meldingen.push(m);
    opslag.bewaar('meldingen');
    return stuur(meldingVoorClient(k(), gebruiker, m), 201);
  }
  if (deel[1] === 'meldingen' && deel[2]) {
    const m = opslag.meldingen.find((x) => x.id === deel[2] && x.gebruiker === gebruiker.id);
    if (!m) throw new Fout(404, 'Melding niet gevonden');
    if (req.method === 'PUT') {
      Object.assign(m, controleerMelding(await leesJson(req), m, { regioIds: regioIds() }));
      opslag.bewaar('meldingen');
      return stuur(meldingVoorClient(k(), gebruiker, m));
    }
    if (req.method === 'DELETE') {
      opslag.meldingen = opslag.meldingen.filter((x) => x.id !== m.id);
      opslag.bewaar('meldingen');
      return stuur({ ok: true });
    }
  }

  // ---------- audio en video ----------
  if (deel[1] === 'audio') return audioApi(req, res, url, ctx, k);

  // ---------- foto's en video's van inzendingen (src/telegram.mjs) ----------
  if (req.method === 'GET' && deel[1] === 'ingezonden' && deel.length === 4) {
    const [, , map, bestand] = deel;
    if (!/^[a-f0-9]{32}$/.test(map) || !/^\w[\w.-]*$/.test(bestand)) throw new Fout(400, 'Ongeldig pad');
    const pad = path.join(opslag.map, 'ingezonden', map, bestand);
    if (!existsSync(pad)) throw new Fout(404, 'Niet gevonden');
    // Alleen beeld en video; al het andere als download, nooit als pagina.
    return stuurBestand(req, res, pad, MEDIATYPE[path.extname(bestand).slice(1).toLowerCase()] || 'application/octet-stream');
  }

  // ---------- kamerstukken (status en zoeken) ----------
  if (url.pathname.startsWith('/api/kamer/')) {
    await kamerApi(req, res, url, { opslag, kdb, stuur, Fout });
    return;
  }

  // ---------- taken (voorbeeldmail, versturen, rondes) ----------
  if (req.method === 'POST' && deel[1] === 'taken' && deel[2]) {
    const invoer = await leesJson(req);
    if (deel[2] !== 'voorbeeld' || (invoer.gebruiker && invoer.gebruiker !== gebruiker.id)) alleenBeheer();
    return stuur(taken.start(deel[2], { ...invoer, gebruiker: invoer.gebruiker || gebruiker.id }), 202);
  }
  if (req.method === 'GET' && deel[1] === 'taken' && deel[2]) return stuur(taken.status(deel[2]));

  // ---------- alleen beheer ----------
  alleenBeheer();
  // Terug van het inloggen bij gehoord.de (src/gehoord.mjs): de browser van de
  // beheerder komt hier met een code; daarna terug naar Instellingen.
  if (route === 'GET /api/beheer/gehoord/terug') {
    let uitkomst = 'gekoppeld';
    try {
      await rondKoppelingAf(opslag, { code: z.get('code'), state: z.get('state'), fout: z.get('error') });
    } catch (fout) {
      uitkomst = fout.message;
    }
    res.writeHead(302, { Location: `/#/beheer/instellingen?gehoord=${encodeURIComponent(uitkomst)}` });
    return res.end();
  }
  if (deel[1] === 'beheer') return beheerApi(req, url, { opslag, kdb, fdb, adb, verwerking, telegram: ctx.telegram, gebruiker, stuur, leesJson, Fout });
  if (route === 'GET /api/logboek') return stuur(opslag.logboek.slice(0, 200));
  if (route === 'GET /api/instellingen') return stuur(publiekeInstellingen(opslag));
  if (route === 'PUT /api/instellingen') {
    werkInstellingenBij(opslag, await leesJson(req));
    return stuur(publiekeInstellingen(opslag));
  }
  // Verbinding testen met de URL uit het formulier (nog niet bewaard).
  if (route === 'POST /api/ollama/test') {
    const { url: adres } = await leesJson(req);
    try {
      return stuur(await ollamaInfo(adres || opslag.instellingen.ollama.url));
    } catch (fout) {
      throw new Fout(502, fout.message);
    }
  }
  // De Whisper-worker testen met het adres uit het formulier (nog niet bewaard).
  if (route === 'POST /api/worker/test') {
    const invoer = await leesJson(req);
    const w = audioWorker({ audio: { ...opslag.instellingen.audio, ...invoer, workerToken: invoer.workerToken || opslag.instellingen.audio.workerToken } });
    if (!w) throw new Fout(400, 'Vul het adres van de worker in');
    const g = await w.gezond();
    // Het token controleren met een verzoek dat inloggen vraagt.
    let token = null;
    if (w.heeftToken) {
      try { await w.sprekers(); token = true; } catch (fout) { token = /token/.test(fout.message) ? false : null; }
    }
    return stuur({ ok: g.status === 'ok', model: g.model || null, gpu: g.device || null, stemmen: Boolean(g.diarization_available), token, viaTailnet: w.tailnet });
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
  throw new Fout(404, 'Onbekende route');
}
