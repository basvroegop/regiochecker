// API voor audio en video (vanuit src/api.mjs):
//   GET  /api/audio/bronnen                       de audiobronnen, voor filters
//   GET  /api/audio/archief?q=&bron=&status=      alle afleveringen, ook in de wachtrij
//   GET  /api/audio/afleveringen/{id}/audio       de bewaarde mp3, met Range (doorspoelen)
//   GET  /api/audio/afleveringen/{id}/transcript.txt
//   POST /api/audio/afleveringen/{id}/sprekers    stemherkenning (opnieuw) laten doen
//   POST /api/audio/afleveringen/{id}/opnieuw     een mislukte aflevering opnieuw (beheer)
//   GET  /api/audio/sprekers/{profiel}/fragment   kort fragment van een stem (van de worker)
//   PUT  /api/audio/sprekers/{profiel}            { naam }: geldt voor die stem overal
//   GET  /api/audio/stemmen?bron=
//   GET  /api/audio/namen?q=&soort=&gebied=&bron=&limiet=&offset=
//   GET  /api/audio/namen/vermeldingen?naam=&soort=&bron=
//   GET  /api/audio/telefoonnummers?bron=
//   PUT  /api/audio/telefoonnummers/{nummer}      handmatige beoordeling

import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { worker } from './worker.mjs';
import { isAudio } from './verwerking.mjs';
import { namenOverzicht, vermeldingen, stemmen, telefoonnummers, zetKoppeling, transcriptTekst } from './archief.mjs';
import { GEBIEDEN, SOORTEN as NAAMSOORTEN } from './namen.mjs';
import { maakZoeker } from '../termen.mjs';
import { ENKELVOUD } from '../regios.mjs';
import { isBeheerder } from '../gebruikers.mjs';
import { routeerAflevering } from '../feed.mjs';

const ID = /^[0-9a-f]{32}$/;

export async function stuurBestand(req, res, pad, type) {
  const { size } = await stat(pad);
  const bereik = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let begin = 0;
  let eind = size - 1;
  let status = 200;
  if (bereik && (bereik[1] || bereik[2])) {
    begin = bereik[1] ? Number(bereik[1]) : Math.max(0, size - Number(bereik[2]));
    eind = bereik[1] && bereik[2] ? Math.min(Number(bereik[2]), size - 1) : size - 1;
    if (begin > eind || begin >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    status = 206;
  }
  res.writeHead(status, {
    'Content-Type': type, 'Content-Length': eind - begin + 1, 'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    ...(status === 206 ? { 'Content-Range': `bytes ${begin}-${eind}/${size}` } : {}),
  });
  try {
    await pipeline(createReadStream(pad, { start: begin, end: eind }), res);
  } catch {
    // De browser haakte af (doorspoelen in de speler); niets aan de hand.
  }
  return undefined;
}

function regelVoorArchief(k, a, statussen, volg, zoekTerm) {
  const bron = k.bronnen.get(a.bron) || {};
  const regios = bron.bereik === 'landelijk'
    ? (a.heeftTranscript ? routeerAflevering(k, k.adb.aflevering(a.id)).map((r) => r.regio) : [])
    : [bron.regio].filter(Boolean);
  const regioId = regios.find((r) => volg.has(r)) || regios[0];
  const st = statussen.get(`a:${a.id}`);
  const tijd = a.eersteGezien || a.gepubliceerd || new Date(a.aangemaakt * 1000).toISOString();
  return {
    id: `a:${a.id}`, soort: a.soort, groep: 'audio', soortNaam: ENKELVOUD[a.soort] || a.soort, titel: a.titel,
    regios, regioNaam: regioId ? k.regioMap.get(regioId)?.naam || regioId : bron.bereik === 'landelijk' ? 'Landelijk' : '',
    bronNaam: bron.naam || a.bron, tijd, tijdBekend: Boolean(a.eersteGezien) && !a.nulmeting, datum: (a.gepubliceerd || '').slice(0, 10) || null,
    status: a.status, stap: a.stap, duur: a.duur,
    match: zoekTerm ? { term: zoekTerm, zoek: true } : null,
    gelezen: Boolean(st?.gelezen), bewaard: Boolean(st?.bewaard), notitie: Boolean(st?.notitie),
  };
}

export async function audioApi(req, res, url, ctx, kader) {
  const { opslag, adb, fdb, verwerking, gebruiker, stuur, leesJson, Fout } = ctx;
  if (!adb) throw new Fout(503, 'De database voor audio is niet beschikbaar');
  const deel = url.pathname.split('/').filter(Boolean); // ['api', 'audio', ...]
  const z = url.searchParams;
  const route = `${req.method} /${deel.slice(2).join('/')}`;
  const bron = z.get('bron') || '';

  if (route === 'GET /bronnen') {
    return stuur(opslag.bronnen.filter(isAudio).map((b) => ({ id: b.id, naam: b.naam, soort: b.soort, soortNaam: ENKELVOUD[b.soort] })));
  }

  if (route === 'GET /archief') {
    const k = kader();
    const q = String(z.get('q') || '').slice(0, 200).trim();
    const status = z.get('status');
    const groepen = { klaar: ['klaar', 'getranscribeerd', 'analyseren'], bezig: ['wacht', 'downloaden', 'transcriberen'], mislukt: ['mislukt'] };
    let lijst = adb.lijst({ bron: bron || undefined, status: groepen[status], limiet: q ? 5000 : 400 });
    let term = null;
    if (q) {
      const zoeker = maakZoeker(q);
      const gevonden = [];
      for (const a of lijst) {
        const volledig = a.heeftTranscript ? adb.aflevering(a.id) : null;
        const t = zoeker && (zoeker(a.titel) || (volledig && zoeker(volledig.transcript)));
        if (t) gevonden.push(a);
        term ||= t?.term;
        if (gevonden.length >= 300) break;
      }
      lijst = gevonden;
    }
    const statussen = fdb ? fdb.statussen(gebruiker.id) : new Map();
    const volg = new Set(gebruiker.regios);
    return stuur({ items: lijst.map((a) => regelVoorArchief(k, a, statussen, volg, q ? term || q : null)) });
  }

  const [, , soort, id, actie] = deel;

  if (soort === 'afleveringen') {
    if (!ID.test(id || '')) throw new Fout(400, 'Ongeldig id');
    const af = adb.aflevering(id);
    if (!af) throw new Fout(404, 'Aflevering niet gevonden');
    if (req.method === 'GET' && actie === 'audio') {
      if (!af.audioPad || !existsSync(af.audioPad)) throw new Fout(404, 'De audio van deze aflevering is niet (meer) bewaard');
      return stuurBestand(req, res, af.audioPad, 'audio/mpeg');
    }
    if (req.method === 'GET' && actie === 'transcript.txt') {
      if (!af.transcript) throw new Fout(404, 'Er is nog geen transcript');
      const naam = `transcript-${af.titel.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || id.slice(0, 8)}.txt`;
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${naam}"`, 'Cache-Control': 'private, no-store' });
      return res.end(transcriptTekst(af));
    }
    if (req.method === 'POST' && actie === 'sprekers') {
      try {
        verwerking.vraagSprekers(id);
      } catch (fout) {
        throw new Fout(409, fout.message);
      }
      return stuur({ ok: true });
    }
    if (req.method === 'POST' && actie === 'opnieuw') {
      if (!isBeheerder(gebruiker)) throw new Fout(403, 'Alleen voor beheerders');
      verwerking.opnieuw(id);
      return stuur({ ok: true });
    }
  }

  if (soort === 'sprekers') {
    if (!ID.test(id || '')) throw new Fout(400, 'Ongeldig id');
    if (!adb.heeftSpreker(id)) throw new Fout(404, 'Stem niet gevonden');
    const w = worker(opslag.instellingen);
    if (!w) throw new Fout(503, 'De Whisper-worker is niet ingesteld');
    if (req.method === 'GET' && actie === 'fragment') {
      const stop = new AbortController();
      res.on('close', () => stop.abort());
      const antwoord = await w.fragment(id, stop.signal);
      if (!antwoord.ok) throw new Fout(antwoord.status === 404 ? 404 : 502, antwoord.status === 404 ? 'Geen luisterfragment van deze stem' : 'De worker gaf geen fragment');
      res.writeHead(200, { 'Content-Type': antwoord.headers.get('content-type') || 'audio/wav', 'Cache-Control': 'private, no-store' });
      try {
        await pipeline(Readable.fromWeb(antwoord.body), res);
      } catch { /* afgehaakt */ }
      return undefined;
    }
    if (req.method === 'PUT' && !actie) {
      const naam = String((await leesJson(req)).naam || '').trim().slice(0, 80);
      if (!naam) throw new Fout(400, 'Vul een naam in');
      const profiel = await w.noemSpreker(id, naam);
      const weergave = profiel.display_name || naam;
      const aantal = adb.hernoemSpreker(id, weergave);
      opslag.log({ soort: 'spreker', tekst: `${gebruiker.naam || gebruiker.login}: stem ${id.slice(0, 8)} heet nu "${weergave}" (${aantal} afleveringen)` });
      return stuur({ naam: weergave, afleveringen: aantal });
    }
  }

  if (route === 'GET /stemmen') {
    const w = worker(opslag.instellingen);
    let profielen = [];
    let fout = null;
    if (w?.heeftToken) {
      try { profielen = await w.sprekers(); } catch (f) { fout = f.message; }
    }
    return stuur({ stemmen: stemmen(adb, profielen, { bron }), fout });
  }

  if (route === 'GET /namen') {
    return stuur({
      ...namenOverzicht(adb, {
        q: z.get('q') || '', soort: z.get('soort') || '', gebied: z.get('gebied') || '', bron,
        limiet: Math.min(500, Number(z.get('limiet')) || 150), offset: Number(z.get('offset')) || 0,
      }),
      soorten: NAAMSOORTEN,
      gebieden: GEBIEDEN,
    });
  }
  if (route === 'GET /namen/vermeldingen') {
    return stuur(vermeldingen(adb, { naam: z.get('naam') || '', soort: z.get('soort') || '', bron }));
  }

  if (route === 'GET /telefoonnummers') return stuur(telefoonnummers(adb, { bron }));
  if (soort === 'telefoonnummers' && id && req.method === 'PUT') {
    if (!/^0\d{7,10}$/.test(id)) throw new Fout(400, 'Ongeldig nummer');
    try {
      return stuur({ koppeling: zetKoppeling(adb, id, await leesJson(req)) });
    } catch (fout) {
      throw new Fout(fout.status || 400, fout.message);
    }
  }

  throw new Fout(404, 'Onbekende route');
}
