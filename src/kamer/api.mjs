// API voor de kamerstukken: zoeken, status, termen per regio en meldingen.
// Wordt aangeroepen vanuit src/dienst.mjs; geeft true als het verzoek hier hoort.

import { randomUUID } from 'node:crypto';
import { REGIOS } from '../regios.mjs';
import { schoneTermen } from './termen.mjs';
import { stukUrl, downloadUrl, minDatum } from './db.mjs';
import { vanaf } from './ophalen.mjs';
import { stelMeldingSamen } from './meldingen.mjs';

const REGIO_IDS = new Set(REGIOS.map((r) => r.id));
const FREQUENTIES = ['direct', 'dagelijks'];
const DATUM = /^\d{4}-\d{2}-\d{2}$/;

function stukVoorClient(s) {
  return {
    id: s.id, nummer: s.nummer, soort: s.soort, titel: s.titel, onderwerp: s.onderwerp, datum: s.datum,
    dossier: s.dossier, dossiertitel: s.dossiertitel, afzender: s.afzender,
    url: stukUrl(s), download: downloadUrl(s), fragment: s.fragment || '', tekststatus: s.tekststatus,
  };
}

function controleerMelding(invoer, bestaand, { EMAIL, Fout }) {
  const email = String(invoer.email ?? bestaand?.email ?? '').trim().toLowerCase();
  if (!EMAIL.test(email)) throw new Fout(400, `"${email}" is geen geldig e-mailadres`);
  const termen = schoneTermen(invoer.termen ?? bestaand?.termen ?? []);
  if (!termen.length) throw new Fout(400, 'Vul minstens één term in');
  const frequentie = invoer.frequentie ?? bestaand?.frequentie ?? 'direct';
  if (!FREQUENTIES.includes(frequentie)) throw new Fout(400, 'Kies direct of dagelijks');
  return {
    naam: String(invoer.naam ?? bestaand?.naam ?? '').trim().slice(0, 100),
    email,
    termen,
    frequentie,
    actief: Boolean(invoer.actief ?? bestaand?.actief ?? true),
  };
}

export async function kamerApi(req, res, url, { opslag, kdb, stuur, leesJson, Fout, EMAIL }) {
  const deel = url.pathname.split('/').filter(Boolean); // ['api', 'kamer', ...]
  if (deel[1] !== 'kamer') return false;
  if (!kdb) throw new Fout(503, 'De kamerstukkendatabase is niet beschikbaar');
  const route = `${req.method} /${deel.slice(2).join('/')}`;
  const z = url.searchParams;

  if (route === 'GET /status') {
    return stuur({ ...kdb.status(), vanaf: vanaf(), ronde: opslag.status.kamer || null, soorten: kdb.soorten() }), true;
  }

  if (route === 'GET /zoek') {
    const van = z.get('van') || '';
    const tot = z.get('tot') || '';
    if ((van && !DATUM.test(van)) || (tot && !DATUM.test(tot))) throw new Fout(400, 'Datum als JJJJ-MM-DD');
    const r = kdb.zoek({
      vraag: (z.get('q') || '').slice(0, 500),
      soort: z.get('soort') || '',
      van, tot,
      sorteer: z.get('sorteer') === 'datum' ? 'datum' : 'relevantie',
      pagina: Math.max(1, Number(z.get('pagina')) || 1),
      perPagina: 20,
    });
    return stuur({ totaal: r.totaal, vraag: r.vraag, aangepast: Boolean(r.aangepast), resultaten: r.rijen.map(stukVoorClient) }), true;
  }

  // Termen per regio, met per term hoe vaak hij de afgelopen 30 dagen voorkwam.
  if (route === 'GET /termen') {
    const tellingen = {};
    for (const r of REGIOS) tellingen[r.id] = kdb.telTermen(opslag.kamertermen[r.id] || []);
    return stuur({ regios: REGIOS.map((r) => ({ id: r.id, naam: r.naam, termen: opslag.kamertermen[r.id] || [], tellingen: tellingen[r.id] })) }), true;
  }
  if (req.method === 'PUT' && deel[2] === 'termen' && deel[3]) {
    if (!REGIO_IDS.has(deel[3])) throw new Fout(404, 'Onbekende regio');
    const { termen } = await leesJson(req);
    opslag.kamertermen[deel[3]] = schoneTermen(termen);
    opslag.bewaar('kamertermen');
    return stuur({ termen: opslag.kamertermen[deel[3]], tellingen: kdb.telTermen(opslag.kamertermen[deel[3]]) }), true;
  }
  // Losse proef: wat levert deze term op (aantal, laatste stukken)?
  if (route === 'GET /proef') {
    const termen = schoneTermen(z.get('termen') || '');
    const dagen = Math.min(365, Math.max(1, Number(z.get('dagen')) || 30));
    const sinds = new Date(Date.now() - dagen * 86400000).toISOString();
    const treffers = kdb.treffers(termen, { sinds: '0000', minDatum: sinds.slice(0, 10), max: 20 });
    return stuur({ termen, tellingen: kdb.telTermen(termen, dagen), stukken: treffers.map((t) => ({ ...stukVoorClient(t.stuk), gevonden: t.gevonden })) }), true;
  }

  if (route === 'GET /meldingen') return stuur(opslag.meldingen), true;
  if (route === 'POST /meldingen') {
    const m = { id: randomUUID(), ...controleerMelding(await leesJson(req), null, { EMAIL, Fout }), aangemaakt: new Date().toISOString(), laatsteMelding: null };
    opslag.meldingen.push(m);
    opslag.bewaar('meldingen');
    return stuur(m, 201), true;
  }
  if (deel[2] === 'meldingen' && deel[3]) {
    const m = opslag.meldingen.find((x) => x.id === deel[3]);
    if (!m) throw new Fout(404, 'Melding niet gevonden');
    if (req.method === 'PUT' && deel.length === 4) {
      Object.assign(m, controleerMelding(await leesJson(req), m, { EMAIL, Fout }));
      opslag.bewaar('meldingen');
      return stuur(m), true;
    }
    if (req.method === 'DELETE' && deel.length === 4) {
      opslag.meldingen = opslag.meldingen.filter((x) => x.id !== m.id);
      opslag.bewaar('meldingen');
      return stuur({ ok: true }), true;
    }
    // Voorbeeld: hoe zou de mail eruitzien met de stukken van de afgelopen week?
    if (req.method === 'GET' && deel[4] === 'voorbeeld') {
      const sinds = new Date(Date.now() - 7 * 86400000).toISOString();
      const treffers = kdb.treffers(m.termen, { sinds: '0000', minDatum: minDatum(sinds), max: 30 })
        .filter((t) => t.stuk.datum >= sinds.slice(0, 10));
      if (!treffers.length) return stuur({ onderwerp: 'Geen stukken in de afgelopen week', html: '<p style="font-family:Arial,sans-serif;padding:20px">De afgelopen week kwam geen kamerstuk binnen met deze termen.</p>' }), true;
      const mail = stelMeldingSamen(m, treffers);
      return stuur({ onderwerp: mail.onderwerp, html: mail.html }), true;
    }
  }
  throw new Fout(404, 'Onbekende route');
}
