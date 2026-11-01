// Het archief van de Tweede Kamer: alle stukken van vóór KAMERSTUKKEN_VANAF,
// terug tot het begin van het Gegevensmagazijn (medio 2008; ruim 600.000
// stukken, ongeveer 16 GB). In een eigen database (data/kamerarchief.sqlite):
// de feed, de meldingen en de weekmail kijken alleen naar de gewone database,
// die zo klein en snel blijft; zoeken en lezen gaan over beide
// (KamerDb.koppelArchief in db.mjs).
//
// Het archief vult zich op de achtergrond: eerst alle metadata, dan de teksten,
// nieuwste eerst, in porties met een korte pauze ertussen (we zijn niet de enige
// gebruiker van het Gegevensmagazijn). Daarna eens per dag de wijzigingen.
//
// Schijfbewaking: het stopt vanzelf als er minder dan KAMERARCHIEF_MIN_VRIJ_GB
// (standaard 40) vrij is op de schijf, of als het archief groter wordt dan
// KAMERARCHIEF_MAX_GB (standaard 40), en kijkt dan elk uur opnieuw. Helemaal
// uit met KAMERARCHIEF=uit.

import { statfsSync, statSync } from 'node:fs';
import { synchroniseer, haalTeksten, telBijDeKamer, vanaf } from './ophalen.mjs';

const GB = 1024 ** 3;
const minVrij = () => Number(process.env.KAMERARCHIEF_MIN_VRIJ_GB) || 40;
const maxGrootte = () => Number(process.env.KAMERARCHIEF_MAX_GB) || 40;
// Het archief begint bij het oudste stuk dat er is; verder beperken kan.
const archiefVanaf = () => process.env.KAMERARCHIEF_VANAF || null;
const PORTIE = 150;
const pauze = () => Number(process.env.KAMERARCHIEF_PAUZE_MS ?? 2000);
const UUR = 3600_000;
const DAG = 24 * UUR;

export function schijfVrij(map) {
  const s = statfsSync(map);
  return s.bavail * s.bsize;
}

function grootte(pad) {
  let n = 0;
  for (const deel of ['', '-wal']) {
    try { n += statSync(`${pad}${deel}`).size; } catch { /* bestaat (nog) niet */ }
  }
  return n;
}

export class KamerArchief {
  // `db`: de KamerDb van het archief (eigen verbinding, om te schrijven).
  constructor(db, { map, pad, opslag = null }) {
    this.db = db;
    this.map = map;
    this.pad = pad;
    this.opslag = opslag;
    this.toestand = { bezig: 'wacht' };
  }

  // Reden om te stoppen, of null.
  grens() {
    const vrij = schijfVrij(this.map);
    if (vrij < minVrij() * GB) return `minder dan ${minVrij()} GB vrij op de schijf (${(vrij / GB).toFixed(1)} GB)`;
    const groot = grootte(this.pad);
    if (groot > maxGrootte() * GB) return `het archief is groter dan ${maxGrootte()} GB (${(groot / GB).toFixed(1)} GB)`;
    return null;
  }

  // Eén stap; geeft terug hoe lang te wachten tot de volgende.
  async stap(nu = Date.now()) {
    const stop = this.grens();
    if (stop) {
      if (this.toestand.gestopt !== stop) this.opslag?.log({ soort: 'bronfout', tekst: `Kamerarchief gestopt: ${stop}` });
      this.toestand = { bezig: 'gestopt', gestopt: stop, tijd: new Date(nu).toISOString() };
      return UUR;
    }
    const bereik = { onder: archiefVanaf(), boven: vanaf() };
    // Eens per dag: hoeveel stukken er in totaal zijn, en de wijzigingen.
    if (nu - Number(this.db.staat('geteld') || 0) > DAG) {
      try {
        this.db.zetStaat('verwacht', String(await telBijDeKamer(bereik) || ''));
      } catch { /* dan volgende keer */ }
      this.db.zetStaat('geteld', String(nu));
      this.db.zetStaat('metadataKlaar', '');
    }
    if (this.db.staat('metadataKlaar') !== '1') {
      const r = await synchroniseer(this.db, bereik);
      if (r.klaar) this.db.zetStaat('metadataKlaar', '1');
      this.toestand = { bezig: 'metadata', tijd: new Date(nu).toISOString() };
      return pauze();
    }
    const t = await haalTeksten(this.db, { max: PORTIE });
    this.toestand = { bezig: t.gelukt + t.mislukt ? 'teksten' : 'bij', tijd: new Date(nu).toISOString() };
    // Alles binnen: morgen weer kijken naar wijzigingen.
    return t.gelukt + t.mislukt ? pauze() : Math.max(UUR, DAG - (nu - Number(this.db.staat('geteld') || 0)));
  }

  start() {
    if (this.lopend) return;
    this.lopend = true;
    const volgende = async () => {
      let wacht;
      try {
        wacht = await this.stap();
      } catch (fout) {
        // Het Gegevensmagazijn even weg: over een kwartier opnieuw, niet elke keer in het logboek.
        if (this.toestand.fout !== fout.message) this.opslag?.log({ soort: 'bronfout', tekst: `Kamerarchief: ${fout.message}` });
        this.toestand = { bezig: 'fout', fout: fout.message, tijd: new Date().toISOString() };
        wacht = UUR / 4;
      }
      if (this.lopend) this.wekker = setTimeout(volgende, wacht);
    };
    volgende();
  }

  stop() {
    this.lopend = false;
    clearTimeout(this.wekker);
  }

  status() {
    const s = this.db.status();
    return {
      ...this.toestand,
      totaal: s.totaal,
      metTekst: (s.metTekst || 0) + (s.zonderTekst || 0),
      wachtrij: s.wachtrij || 0,
      oudste: s.oudste,
      nieuwste: s.nieuwste,
      verwacht: Number(this.db.staat('verwacht')) || null,
      grootte: grootte(this.pad),
      vrij: schijfVrij(this.map),
      minVrij: minVrij() * GB,
      maxGrootte: maxGrootte() * GB,
    };
  }
}
