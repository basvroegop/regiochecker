// De verwerking van audio en video, overgenomen uit audioscraper:
//   1. Bronnen controleren (elk uur): nieuwe afleveringen in de wachtrij. De
//      eerste keer alleen de laatste paar (instelbaar); de rest van de oude
//      catalogus telt als gezien.
//   2. De wachtrij, één aflevering tegelijk (er is één gedeelde GPU):
//      downloaden → transcriberen met stemherkenning → namen zoeken.
//      De bronnen gaan in de volgorde die de beheerder bepaalt; een bron wordt
//      helemaal afgemaakt voordat de volgende begint. Binnen een bron gaat een
//      transcript altijd vóór het zoeken naar namen, en het nieuwste eerst.
//      Namen zoeken wacht als de GPU bezet is (Plaud, Storyteller), zodat
//      Whisper niet op Ollama hoeft te wachten.
//   3. Telefoonnummers duiden met de worker, alleen als er verder niets te doen is.
//
// Een transcript wordt meteen bewaard; een fout daarna kost dus nooit een
// nieuwe transcriptie. Na een herstart gaat de wachtrij verder waar hij was.
// Tijdelijke storingen (worker of netwerk weg) blijven herkansen met een
// oplopende wachttijd; echte fouten drie keer, daarna "mislukt" met een knop
// om het opnieuw te proberen.

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { worker } from './worker.mjs';
import { ontdek } from './catalogus.mjs';
import { mediaVoor } from './vergaderingen.mjs';
import { downloadAudio, gooiAudioWeg, audioDuur, knipAudio } from './ophalen.mjs';
import { delen, splits, plaatsNamen } from './namen.mjs';
import { vindNummers, nummerlijst, contextVenster, namenInBuurt, controleerDuiding } from './telefoon.mjs';

const BRON_INTERVAL_MS = 60 * 60_000;
const DAG_MS = 86400_000;

export const isAudio = (b) => b?.type === 'audio' && b.audio;

// Een lange opname gaat in delen naar de worker. Een vergadering van ruim drie
// uur in één keer liet de worker crashen (een harde stop in CTranslate2,
// oktober 2026); in delen blijft elke GPU-taak kort, en komen Plaud en
// Storyteller tussendoor aan de beurt. Elk deel wordt meteen bewaard: na een
// storing gaat het verder bij het volgende deel. De delen overlappen een paar
// seconden, zodat er bij de knip geen woorden wegvallen.
const deelSeconden = () => Number(process.env.AUDIO_DEEL_S) || 45 * 60;
const OVERLAP_S = 4;

// De delen weer tot één transcript, met tijden vanaf het begin van de opname.
// Wat in de overlap al in het vorige deel stond, gaat eruit. Een stem zonder
// profiel ("SPEAKER_00") geldt alleen binnen zijn deel, dus die krijgt per
// deel een eigen nummer; een stemprofiel (speaker_id) geldt overal.
export function voegDelenSamen(delen) {
  const segments = [];
  let eind = 0;
  delen.forEach((d, i) => {
    for (const s of d.segments || []) {
      const start = Number(s.start || 0) + d.start;
      const stop = Number(s.end || 0) + d.start;
      if (i && start < eind - 0.25) continue;
      const lokaal = /^SPEAKER_(\d+)$/.exec(s.speaker || '');
      segments.push({ ...s, start, end: stop, ...(lokaal ? { speaker: `SPEAKER_${i * 100 + Number(lokaal[1])}` } : {}) });
      eind = Math.max(eind, stop);
    }
  });
  const talen = delen.map((d) => d.language).filter(Boolean);
  const taal = talen.sort((a, b) => talen.filter((t) => t === b).length - talen.filter((t) => t === a).length)[0] || null;
  return {
    text: segments.map((s) => String(s.text || '').trim()).filter(Boolean).join(' '),
    segments,
    language: taal,
    diarization_error: delen.map((d) => d.diarization_error).find(Boolean) || null,
  };
}

const tijdelijkeFout = (fout) => {
  if (fout?.tijdelijk) return true;
  const tekst = `${fout?.code || ''} ${fout?.cause?.code || ''} ${fout?.message || ''}`;
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|UND_ERR|TimeoutError|HTTP 5\d\d|HTTP (408|409|425|429)|niet bereikbaar|duurde te lang/i.test(tekst);
};

// "SPEAKER_03" van een stem zonder profiel wordt "Spreker 1, 2, …" op volgorde van opkomst.
export function schoonSegmenten(segmenten) {
  const lokaal = new Map();
  return segmenten.map((s) => {
    let spreker = s.speaker;
    if (spreker && /^SPEAKER_\d+$/.test(spreker)) {
      if (!lokaal.has(spreker)) lokaal.set(spreker, `Spreker ${lokaal.size + 1}`);
      spreker = lokaal.get(spreker);
    }
    return {
      start: s.start, end: s.end, text: String(s.text || '').trim(),
      ...(spreker ? { speaker: spreker } : {}),
      ...(s.speaker_id ? { speaker_id: s.speaker_id } : {}),
    };
  });
}

export class Verwerking {
  // ctx: { opslag, adb }; `bijBeschikbaar(af)`: er is een nieuw transcript.
  constructor({ opslag, adb }, { bijBeschikbaar } = {}) {
    this.opslag = opslag;
    this.adb = adb;
    this.bijBeschikbaar = bijBeschikbaar;
    this.loopt = false;
    this.wekkers = new Set();
    this.bezigMet = null;
    for (const v of nummerlijst()) adb.zetVerificatie(v.nummer, v);
  }

  get map() {
    return this.opslag.map;
  }

  bronnen() {
    return this.opslag.bronnen.filter(isAudio);
  }

  // De volgorde van de wachtrij: laag getal eerst, bij gelijk de nieuwste bron.
  bronVolgorde() {
    return this.bronnen()
      .slice()
      .sort((a, b) => (a.audio.prioriteit ?? 0) - (b.audio.prioriteit ?? 0) || String(b.aangemaakt || '').localeCompare(String(a.aangemaakt || '')));
  }

  zetVolgorde(ids) {
    const huidig = this.bronVolgorde().map((b) => b.id);
    const gekozen = [...new Set(ids)].filter((id) => huidig.includes(id));
    const volgorde = [...gekozen, ...huidig.filter((id) => !gekozen.includes(id))];
    for (const b of this.bronnen()) b.audio.prioriteit = volgorde.indexOf(b.id);
    this.opslag.bewaar('bronnen');
    this.wek();
    return volgorde;
  }

  w() {
    return worker(this.opslag.instellingen);
  }

  // ---------- bronnen controleren ----------

  async synchroniseer(bron) {
    const status = this.opslag.status.bronnen;
    const vorige = status[bron.id] || {};
    status[bron.id] = { ...vorige, bezig: true };
    try {
      const { titel, items } = await ontdek(bron, { map: this.map });
      const gezien = this.adb.gezien(bron.id);
      const vers = items.filter((i) => !gezien.has(i.extern));
      const eersteKeer = !bron.audio.geinitialiseerd;
      const limiet = Number(bron.audio.eersteImport ?? 3);
      const gekozen = eersteKeer && limiet ? vers.slice(0, limiet) : vers;
      let nieuw = 0;
      for (const i of gekozen) {
        // De eerste import is een nulmeting: die afleveringen staan in de feed
        // op hun eigen datum, niet als "nieuw vandaag". Een losse video niet.
        if (this.adb.voegToe(bron, i, { nulmeting: eersteKeer && bron.audio.kind !== 'video' })) nieuw++;
      }
      // Datum en afbeelding aanvullen bij afleveringen die die nog niet hadden.
      for (const i of items) {
        const bestaand = this.adb.bestaand(bron.id, i.extern);
        if (!bestaand) continue;
        const velden = {};
        if (i.gepubliceerdOp && !bestaand.gepubliceerd) Object.assign(velden, { gepubliceerdTekst: i.gepubliceerd, gepubliceerdOp: i.gepubliceerdOp });
        if (i.afbeelding && !bestaand.afbeelding) velden.afbeelding = i.afbeelding;
        if (Object.keys(velden).length) this.adb.werkBij(bestaand.id, velden);
      }
      this.adb.markeerGezien(bron.id, items.map((i) => i.extern));
      bron.audio.geinitialiseerd = true;
      if (titel) bron.audio.titel = titel;
      this.opslag.bewaar('bronnen');
      status[bron.id] = { ok: true, fout: null, laatsteRonde: new Date().toISOString(), laatsteSucces: new Date().toISOString(), aantal: items.length, nieuw, nulmeting: eersteKeer, bezig: false };
      this.wek();
      return { ok: true, nieuw, aantal: items.length };
    } catch (fout) {
      status[bron.id] = { ...vorige, ok: false, fout: fout.message.slice(0, 1500), laatsteRonde: new Date().toISOString(), bezig: false };
      if (vorige.ok !== false) this.opslag.log({ soort: 'bronfout', tekst: `${bron.naam}: ${fout.message}` });
      return { ok: false, fout: fout.message };
    } finally {
      this.opslag.bewaar('status');
    }
  }

  async controleerBronnen(nu = Date.now()) {
    if (this.adb.gepauzeerd()) return;
    for (const bron of this.bronVolgorde()) {
      if (bron.audio.actief === false) continue;
      // Een losse video heeft na de eerste keer niets meer te controleren.
      if (bron.audio.kind === 'video' && bron.audio.geinitialiseerd) continue;
      const laatste = Date.parse(this.opslag.status.bronnen[bron.id]?.laatsteRonde || 0);
      if (nu - laatste < BRON_INTERVAL_MS) continue;
      await this.synchroniseer(bron);
      if (this.adb.gepauzeerd()) return;
    }
  }

  // ---------- de wachtrij ----------

  volgende(nu = Date.now() / 1000) {
    const volgorde = new Map(this.bronVolgorde().map((b, i) => [b.id, i]));
    const rijen = this.adb.wachtrij(nu).filter((r) => volgorde.has(r.bron));
    const transcriptWerk = new Set(rijen.filter((r) => r.zonder_transcript || r.sprekers_gevraagd).map((r) => r.bron));
    const kandidaten = rijen.filter((r) => ['wacht', 'getranscribeerd'].includes(r.status) && r.klaarVoor
      && ((r.zonder_transcript || r.sprekers_gevraagd) || (r.zonder_entiteiten && !transcriptWerk.has(r.bron))));
    const transcriptEerst = (r) => (r.zonder_transcript || r.sprekers_gevraagd ? 0 : 1);
    kandidaten.sort((a, b) => volgorde.get(a.bron) - volgorde.get(b.bron)
      || transcriptEerst(a) - transcriptEerst(b)
      || Number(b.met_stemmen) - Number(a.met_stemmen)
      || b.moment - a.moment);
    return kandidaten;
  }

  // Eén stap: de volgende aflevering een fase verder. Geeft true als er werk was.
  async verwerkEen() {
    if (this.adb.gepauzeerd()) return false;
    const w = this.w();
    if (!w || !w.heeftToken) return false;
    const volgende = this.volgende()[0];
    if (!volgende) return false;
    const af = this.adb.aflevering(volgende.id);
    this.bezigMet = af.id;
    try {
      await this.verwerk(af, w);
    } catch (fout) {
      this.mislukt(af, fout);
    } finally {
      this.bezigMet = null;
    }
    return true;
  }

  // Geeft het samengevoegde antwoord van de worker, of null als de verwerking
  // intussen gepauzeerd is (de delen die klaar zijn, blijven bewaard).
  async transcribeerInDelen(af, pad, lengte, w, werk) {
    const deel = deelSeconden();
    // Het laatste deel neemt de rest mee, zodat er geen staartje van een paar seconden overblijft.
    const n = Math.max(1, Math.ceil(lengte / deel - 0.25));
    let klaar = this.adb.aflevering(af.id).transcriptDelen || [];
    // Een tussenstand geldt alleen bij dezelfde indeling.
    if (klaar.some((d, i) => d.start !== i * deel)) klaar = [];
    const wat = af.sprekersGevraagd ? 'Stemmen herkennen' : 'Transcriberen met Whisper';
    for (let i = klaar.length; i < n; i++) {
      if (this.adb.gepauzeerd()) {
        werk({ status: 'wacht', stap: `Gepauzeerd · ${i} van ${n} delen klaar` });
        return null;
      }
      werk({ status: 'transcriberen', stap: `${wat} · deel ${i + 1} van ${n}` });
      const start = i * deel;
      const deelPad = path.join(path.dirname(pad), `deel-${i + 1}.mp3`);
      try {
        await knipAudio(pad, deelPad, start, i === n - 1 ? lengte - start + 1 : Math.min(deel + OVERLAP_S, lengte - start));
        const r = await w.transcribeer(deelPad, `${af.id}-${i + 1}`);
        klaar.push({ start, text: String(r.text || ''), segments: r.segments || [], language: r.language || null, diarization_error: r.diarization_error || null });
      } finally {
        await rm(deelPad, { force: true });
      }
      werk({ transcriptDelen: klaar });
    }
    return voegDelenSamen(klaar);
  }

  bewaarAudio(af) {
    const keuze = this.opslag.instellingen.audio?.bewaarAudio || 'vergaderingen';
    return keuze === 'alles' || (keuze === 'vergaderingen' && af.soort === 'raadsvergadering');
  }

  async verwerk(af, w) {
    const werk = (velden) => this.adb.werkBij(af.id, velden);
    if (!af.transcript || af.sprekersGevraagd) {
      let pad = af.audioPad;
      if (!pad || !existsSync(pad)) {
        werk({ status: 'downloaden', stap: 'Audio downloaden', fout: null });
        pad = await downloadAudio(af, {
          map: this.map,
          vergadering: mediaVoor,
          metadata: (m) => {
            const velden = {};
            if (m.titel) velden.titel = m.titel;
            if (m.auteur) velden.auteur = m.auteur;
            if (m.duur) velden.duur = m.duur;
            if (m.gepubliceerd && /^\d{8}$/.test(m.gepubliceerd) && !af.gepubliceerd) {
              Object.assign(velden, { gepubliceerdTekst: m.gepubliceerd, gepubliceerdOp: Date.UTC(+m.gepubliceerd.slice(0, 4), +m.gepubliceerd.slice(4, 6) - 1, +m.gepubliceerd.slice(6, 8)) / 1000 });
            }
            if (Object.keys(velden).length) werk(velden);
          },
        });
        werk({ audioPad: pad });
      }
      if (this.adb.gepauzeerd()) {
        werk({ status: 'wacht', stap: 'Gepauzeerd · audio klaar' });
        return;
      }
      const lengte = (await audioDuur(pad)) || af.duur || null;
      let r;
      if (lengte && lengte > deelSeconden() * 1.25) {
        r = await this.transcribeerInDelen(af, pad, lengte, w, werk);
        if (!r) return;
        r.duration = lengte;
      } else {
        werk({ status: 'transcriberen', stap: af.sprekersGevraagd ? 'Stemmen herkennen · Whisper en stemherkenning' : 'Transcriberen met Whisper · wacht zo nodig op de gedeelde GPU' });
        r = await w.transcribeer(pad, af.id);
      }
      const tekst = String(r.text || '').trim();
      if (!tekst) throw new Error('Whisper heeft geen gesproken tekst gevonden.');
      const segmenten = schoonSegmenten(r.segments?.length ? r.segments : [{ start: 0, end: r.duration || 0, text: tekst }]);
      const verder = this.adb.aflevering(af.id);
      werk({
        transcript: tekst, segmenten, taal: r.language || null, duur: r.duration ?? verder.duur, sprekerFout: r.diarization_error || null,
        sprekersGevraagd: false, entiteiten: null, entiteitDelen: null, transcriptDelen: null, pogingen: 0,
        // De eerste import (nulmeting) op de eigen datum, de rest op nu.
        eersteGezien: verder.eersteGezien || (verder.nulmeting && verder.gepubliceerd ? verder.gepubliceerd : new Date().toISOString()),
      });
      this.scanNummers(af.id, segmenten);
      if (!this.bewaarAudio(af)) {
        await gooiAudioWeg(this.map, pad);
        werk({ audioPad: null });
      }
      werk({ status: 'getranscribeerd', stap: 'Transcript klaar · namen volgen', fout: null });
      this.bijBeschikbaar?.(this.adb.aflevering(af.id));
      return;
    }

    // Namen zoeken, deel voor deel, met tussentijds bewaren.
    const stukken = delen(af.transcript);
    const klaar = af.entiteitDelen || [];
    werk({ status: 'analyseren', fout: null });
    for (let i = klaar.length; i < stukken.length; i++) {
      if (this.adb.gepauzeerd()) {
        werk({ status: 'getranscribeerd', stap: 'Namen zoeken gepauzeerd' });
        return;
      }
      if (await w.gpuBezig()) {
        werk({ status: 'getranscribeerd', stap: 'Namen wachten op de gedeelde GPU', opnieuwOp: Date.now() / 1000 + 30 });
        return;
      }
      werk({ stap: `Namen zoeken · deel ${i + 1} van ${stukken.length}` });
      klaar.push(await this.vraagNamen(w, stukken[i]));
      werk({ entiteitDelen: klaar });
    }
    werk({ entiteiten: plaatsNamen(klaar.flat(), af.segmenten), status: 'klaar', stap: 'Klaar', fout: null, pogingen: 0 });
  }

  // Lukt een deel niet (een 500 van de worker: het model kreeg er geen geldige
  // JSON uit), dan in kleinere stukken opnieuw.
  async vraagNamen(w, tekst, opgesplitst = false) {
    try {
      const r = await w.entiteiten(tekst);
      if (!Array.isArray(r.entities)) throw new Error('Worker gaf geen geldige lijst van namen terug.');
      return r.entities;
    } catch (fout) {
      if (fout.httpStatus !== 500 || tekst.length <= 900) throw fout;
      const stukken = splits(tekst, opgesplitst ? 800 : 1600);
      if (stukken.length < 2) throw fout;
      const uit = [];
      const gezien = new Set();
      for (const stuk of stukken) {
        let namen;
        try {
          namen = await this.vraagNamen(w, stuk, true);
        } catch (binnen) {
          const f = new Error('Namen zoeken bleef mislukken na het opsplitsen van een tekstdeel.');
          f.tijdelijk = true;
          f.cause = binnen;
          throw f;
        }
        for (const n of namen) {
          const sleutel = `${String(n.name || '').toLowerCase()}|${n.type}`;
          if (!gezien.has(sleutel)) {
            gezien.add(sleutel);
            uit.push(n);
          }
        }
      }
      return uit;
    }
  }

  mislukt(af, fout) {
    const huidig = this.adb.aflevering(af.id);
    if (!huidig) return;
    const pogingen = huidig.pogingen + 1;
    const tijdelijk = tijdelijkeFout(fout);
    let wacht;
    let status;
    let stap;
    if (fout?.later) {
      // De opname van een recente vergadering staat er nog niet: geen mislukte poging.
      wacht = fout.later;
      status = huidig.transcript ? 'getranscribeerd' : 'wacht';
      stap = `Opname nog niet beschikbaar · nieuwe poging over ${Math.round(wacht / 3600)} uur`;
      this.adb.werkBij(af.id, { status, stap, opnieuwOp: Date.now() / 1000 + wacht, fout: null });
      return;
    }
    if (tijdelijk) {
      wacht = Math.min(1800, 60 * 2 ** Math.min(pogingen - 1, 5));
      status = huidig.transcript ? 'getranscribeerd' : 'wacht';
      stap = `Tijdelijke storing · nieuwe poging over ${Math.max(1, Math.round(wacht / 60))} min`;
    } else {
      wacht = 60 * pogingen;
      const nogEens = pogingen < 3;
      status = nogEens ? (huidig.transcript ? 'getranscribeerd' : 'wacht') : 'mislukt';
      stap = nogEens ? `Nieuwe poging over ${pogingen} min` : 'Verwerking mislukt';
    }
    this.adb.werkBij(af.id, {
      status, stap, pogingen, opnieuwOp: Date.now() / 1000 + wacht,
      fout: String(fout?.message || fout).replace(/https?:\/\/\S+/g, '[URL]').slice(0, 1800),
    });
    if (status === 'mislukt') this.opslag.log({ soort: 'audiofout', tekst: `${af.titel}: ${fout?.message || fout}` });
  }

  opnieuw(id) {
    const af = this.adb.aflevering(id);
    if (!af) return false;
    this.adb.werkBij(id, { status: af.transcript ? 'getranscribeerd' : 'wacht', stap: 'Opnieuw in de wachtrij', fout: null, pogingen: 0, opnieuwOp: 0 });
    this.wek();
    return true;
  }

  // Stemherkenning (opnieuw) laten doen: het transcript wordt opnieuw gemaakt.
  vraagSprekers(id) {
    const af = this.adb.aflevering(id);
    if (!af?.transcript) throw new Error('Wacht eerst tot het transcript klaar is.');
    if (['downloaden', 'transcriberen', 'analyseren'].includes(af.status)) throw new Error('Deze aflevering wordt al verwerkt.');
    this.adb.werkBij(id, { sprekersGevraagd: true, status: 'wacht', stap: 'Stemherkenning in de wachtrij', fout: null, pogingen: 0, opnieuwOp: 0 });
    this.wek();
  }

  // ---------- telefoonnummers ----------

  scanNummers(id, segmenten) {
    this.adb.vervangVermeldingen(id, vindNummers(segmenten));
  }

  // Eén nummer laten duiden door de worker, als er niets anders te doen is.
  async duidEenNummer(nu = Date.now() / 1000) {
    if (this.adb.gepauzeerd() || this.volgende(nu).length) return false;
    const w = this.w();
    if (!w?.heeftToken || await w.gpuBezig()) return false;
    const db = this.adb.db;
    // Mobiele nummers zonder bedrijf en zonder beoordeling, uit afleveringen waarvan de namen bekend zijn.
    db.prepare(`INSERT OR IGNORE INTO telefoon_context (nummer, aflevering, segment, status)
      SELECT v.nummer, v.aflevering, v.segment, 'wacht' FROM telefoon_vermeldingen v
      JOIN afleveringen a ON a.id = v.aflevering
      LEFT JOIN telefoon_verificaties b ON b.nummer = v.nummer
      LEFT JOIN telefoon_koppelingen k ON k.nummer = v.nummer
      WHERE v.categorie = 'Mobiel nummer' AND b.nummer IS NULL AND k.nummer IS NULL AND a.entiteiten IS NOT NULL`).run();
    const rij = db.prepare(`SELECT c.*, v.ruw, a.segmenten, a.entiteiten FROM telefoon_context c
      JOIN telefoon_vermeldingen v ON v.nummer = c.nummer AND v.aflevering = c.aflevering AND v.segment = c.segment
      JOIN afleveringen a ON a.id = c.aflevering
      WHERE c.status IN ('wacht', 'fout') AND c.opnieuw_op <= ? ORDER BY c.pogingen, c.nummer LIMIT 1`).get(nu);
    if (!rij) return false;
    const sleutel = [rij.nummer, rij.aflevering, rij.segment];
    db.prepare("UPDATE telefoon_context SET status = 'bezig', pogingen = pogingen + 1, fout = NULL WHERE nummer = ? AND aflevering = ? AND segment = ?").run(...sleutel);
    try {
      const segmenten = JSON.parse(rij.segmenten || '[]');
      const { tekst, eerste, laatste } = contextVenster(segmenten, rij.segment, rij.ruw);
      const d = controleerDuiding(await w.telefoonContext(tekst, namenInBuurt(JSON.parse(rij.entiteiten || '[]'), eerste, laatste)), tekst);
      db.prepare(`UPDATE telefoon_context SET status = 'klaar', opnieuw_op = 0, soort = ?, relatie = ?, label = ?, omschrijving = ?, zekerheid = ?, bewijs = ?, model = ?, geanalyseerd = ?, fout = NULL
        WHERE nummer = ? AND aflevering = ? AND segment = ?`).run(d.soort, d.relatie, d.label, d.omschrijving, d.zekerheid, d.bewijs, d.model, Date.now() / 1000, ...sleutel);
    } catch (fout) {
      const wacht = Math.min(86400, 300 * 2 ** Math.min(rij.pogingen, 8));
      db.prepare("UPDATE telefoon_context SET status = 'fout', opnieuw_op = ?, fout = ? WHERE nummer = ? AND aflevering = ? AND segment = ?")
        .run(Date.now() / 1000 + wacht, `Duiding tijdelijk niet gelukt: ${String(fout.message).slice(0, 200)}`, ...sleutel);
    }
    return true;
  }

  // Bewaarde audio na een tijd opruimen (standaard een halfjaar).
  async ruimAudioOp(nu = Date.now()) {
    const dagen = Number(this.opslag.instellingen.audio?.bewaarDagen) || 180;
    const grens = new Date(nu - dagen * DAG_MS).toISOString();
    for (const r of this.adb.db.prepare("SELECT id, audio_pad FROM afleveringen WHERE audio_pad IS NOT NULL AND transcript IS NOT NULL AND eerst_gezien < ? AND status NOT IN ('downloaden', 'transcriberen')").all(grens)) {
      await gooiAudioWeg(this.map, r.audio_pad);
      this.adb.werkBij(r.id, { audioPad: null });
    }
  }

  // ---------- de lussen ----------

  wek() {
    for (const w of this.wekkers) w();
  }

  slaap(ms) {
    return new Promise((klaar) => {
      const wekker = () => {
        clearTimeout(t);
        this.wekkers.delete(wekker);
        klaar();
      };
      const t = setTimeout(wekker, ms);
      this.wekkers.add(wekker);
    });
  }

  start() {
    if (this.loopt) return;
    this.loopt = true;
    const lus = async (stap, rust, naam) => {
      while (this.loopt) {
        let werk = false;
        try {
          werk = await stap();
        } catch (fout) {
          console.error(`Audio (${naam}):`, fout);
        }
        if (!this.loopt) return;
        await this.slaap(werk ? 0 : rust);
      }
    };
    lus(() => this.verwerkEen(), 5000, 'wachtrij');
    lus(async () => { await this.controleerBronnen(); return false; }, 60_000, 'bronnen');
    lus(() => this.duidEenNummer(), 30_000, 'nummers');
    lus(async () => { await this.ruimAudioOp(); return false; }, 6 * 3600_000, 'opruimen');
  }

  stop() {
    this.loopt = false;
    this.wek();
  }
}
