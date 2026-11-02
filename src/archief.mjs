// Het archief van de gemeenten: alle ingekomen stukken en Woo-publicaties die de platforms nog
// aanbieden, ook van vóór de eerste ronde van een bron (de feed kent alleen
// wat sindsdien binnenkwam). In een eigen database (data/archief.sqlite), met
// de tekst van elk stuk, doorzoekbaar via Zoeken en te lezen in het
// leespaneel. Niet in de feed, de meldingen of de weekmail: dat blijft over
// wat nieuw binnenkomt.
//
// Welke bronnen: ingekomen stukken en Woo-publicaties, op elk platform zo ver
// terug als het gaat (zie LIJSTEN): iBabs het hele overzicht, Notubiz de hele
// module, iBabs-agenda's jaar voor jaar, de Woo-platforms pagina voor pagina.
// Nieuws niet: RSS gaat niet terug. Per bron eerst de lijst,
// daarna per stuk het document, nieuwste eerst, zoals Inhoud achter de links
// (documentVoor in src/inhoud.mjs). iBabs vraagt vijf seconden tussen
// verzoeken (robots.txt): per portaal wachten we na elk stuk vijf seconden per
// opgehaald bestand, met een paar portalen tegelijk. De lijsten eens per week
// opnieuw, voor wat er bij kwam.
//
// Schijfbewaking zoals bij het kamerarchief (src/kamer/archief.mjs): stoppen
// onder ARCHIEF_MIN_VRIJ_GB vrij (standaard 40) of boven ARCHIEF_MAX_GB
// (standaard 20). Uit met ARCHIEF=uit.

import { statSync } from 'node:fs';
import { alleBronnen } from './register.mjs';
import { documentVoor } from './inhoud.mjs';
import { platVan } from './document.mjs';
import { haalIbabsAlles } from './bronnen/ibabs.mjs';
import { haalNotubizAlles } from './bronnen/notubiz.mjs';
import { haalIbabsAgendaAlles } from './bronnen/ibabsagenda.mjs';
import { haalIngekomenAlles } from './bronnen/sudwestfryslan.mjs';
import { haalBwBesluitenAlles } from './bronnen/groningen.mjs';
import { haalGppWooAlles } from './bronnen/gppwoo.mjs';
import { haalHtmlLijst } from './bronnen/htmllijst.mjs';
import * as woo from './bronnen/woo.mjs';
import { TYPES } from './bronnen/index.mjs';
import { schijfVrij } from './kamer/archief.mjs';

const GB = 1024 ** 3;
const UUR = 3600_000;
const WEEK = 7 * 24 * UUR;
const minVrij = () => Number(process.env.ARCHIEF_MIN_VRIJ_GB) || 40;
const maxGrootte = () => Number(process.env.ARCHIEF_MAX_GB) || 20;
// Na elk opgehaald bestand per portaal (iBabs: Crawl-delay 5).
const beleefd = () => Number(process.env.ARCHIEF_PAUZE_MS ?? 5000);
const PORTALEN = 4;
const PER_PORTAAL = 10;
const POGINGEN = 3;
const MAX_INHOUD = 200_000;

// Welke bronnen een archief hebben, en hoe hun hele lijst op te halen. Een
// lezer die zijn hele lijst al op één pagina toont (de eigen Woo-pagina's),
// gebruikt gewoon de gewone lezer.
const rustig = () => Math.min(beleefd(), 1500);
const LIJSTEN = {
  ibabs: (bron, wacht) => haalIbabsAlles(bron, { pauze: beleefd(), wacht }),
  'notubiz-ingekomen': (bron, wacht) => haalNotubizAlles(bron, { pauze: Math.min(beleefd(), 1000), wacht }),
  'ibabs-agenda': (bron, wacht) => haalIbabsAgendaAlles(bron, { pauze: beleefd(), wacht }),
  'swf-ingekomen': (bron, wacht) => haalIngekomenAlles(bron, { pauze: rustig(), wacht }),
  'groningen-bw-besluiten': (bron) => haalBwBesluitenAlles(bron),
  'gpp-woo': (bron, wacht) => haalGppWooAlles(bron, { pauze: rustig(), wacht }),
  edataloket: (bron, wacht) => woo.haalEdataloketAlles(bron, { pauze: rustig(), wacht }),
  divault: (bron, wacht) => woo.haalDivaultAlles(bron, { pauze: rustig(), wacht }),
  publicaties: (bron, wacht) => woo.haalPublicatiesAlles(bron, { pauze: rustig(), wacht }),
  stack: (bron, wacht) => woo.haalStackAlles(bron, { pauze: rustig(), wacht }),
  djuma: (bron, wacht) => woo.haalDjumaAlles(bron, { pauze: rustig(), wacht }),
  mozard: (bron, wacht) => woo.haalMozardAlles(bron, { pauze: rustig(), wacht }),
  recentjson: (bron, wacht) => woo.haalRecentJsonAlles(bron, { pauze: rustig(), wacht }),
  'html-lijst': (bron) => haalHtmlLijst({ ...bron, viaAantal: 1000 }),
  'smallingerland-woo': (bron) => TYPES['smallingerland-woo'](bron),
  'swf-woo': (bron) => TYPES['swf-woo'](bron),
};
export const heeftArchief = (bron) => ['ingekomen', 'woo'].includes(bron.soort) && Boolean(LIJSTEN[bron.type]);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS stukken (
    nr INTEGER PRIMARY KEY,
    sleutel TEXT UNIQUE NOT NULL,
    bron TEXT NOT NULL,
    regio TEXT,
    soort TEXT,
    titel TEXT,
    url TEXT,
    datum TEXT,
    afzender TEXT,
    soort_stuk TEXT,
    advies TEXT,
    tekst TEXT,
    document_url TEXT,
    gezien TEXT,
    status TEXT,
    pogingen INTEGER NOT NULL DEFAULT 0,
    fout TEXT,
    blokken TEXT,
    volledig INTEGER
  );
  CREATE INDEX IF NOT EXISTS stukken_wachtrij ON stukken(status, pogingen, datum);
  CREATE INDEX IF NOT EXISTS stukken_bron ON stukken(bron);
  CREATE VIRTUAL TABLE IF NOT EXISTS stuk_fts USING fts5(titel, tekst, inhoud, tokenize = 'unicode61 remove_diacritics 2');
  CREATE TABLE IF NOT EXISTS lijsten (bron TEXT PRIMARY KEY, tijd TEXT, aantal INTEGER, fout TEXT);
`;

const MARK_BEGIN = '\u0001';
const MARK_EIND = '\u0002';
const host = (url) => { try { return new URL(url).host; } catch { return ''; } };

export async function openArchief(pad, opslag, opties = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(pad);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  return new Archief(db, { pad, opslag, ...opties });
}

export class Archief {
  constructor(db, { pad, opslag, map = null, wacht = (ms) => new Promise((klaar) => setTimeout(klaar, ms)) }) {
    this.db = db;
    this.pad = pad;
    this.opslag = opslag;
    this.map = map;
    this.wacht = wacht;
    this.toestand = { bezig: 'wacht' };
  }

  // ---------- vullen ----------

  bronnen() {
    return alleBronnen(this.opslag).filter(heeftArchief);
  }

  // De hele lijst van één bron erin; wat er al was, bijgewerkt.
  async lijst(bron, nu = new Date()) {
    let regels;
    try {
      regels = await LIJSTEN[bron.type](bron, this.wacht);
    } catch (fout) {
      this.db.prepare('INSERT INTO lijsten (bron, tijd, aantal, fout) VALUES (?, ?, NULL, ?) ON CONFLICT(bron) DO UPDATE SET tijd = excluded.tijd, fout = excluded.fout')
        .run(bron.id, nu.toISOString(), String(fout.message).slice(0, 300));
      throw fout;
    }
    const nieuw = this.db.prepare(`INSERT INTO stukken (sleutel, bron, regio, soort, titel, url, datum, afzender, soort_stuk, advies, tekst, document_url, gezien)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sleutel) DO UPDATE SET titel = excluded.titel, url = excluded.url, datum = excluded.datum, afzender = excluded.afzender,
        soort_stuk = excluded.soort_stuk, advies = excluded.advies, tekst = excluded.tekst, document_url = excluded.document_url`);
    this.db.exec('BEGIN');
    try {
      for (const r of regels) {
        nieuw.run(`${bron.id}:${r.sleutel}`, bron.id, bron.regio || null, bron.soort, r.titel, r.url, r.datum || null, r.afzender || null,
          r.soortStuk || null, r.advies || null, r.tekst || null, r.document || null, nu.toISOString());
      }
      this.db.exec('COMMIT');
    } catch (fout) {
      this.db.exec('ROLLBACK');
      throw fout;
    }
    this.db.prepare('INSERT INTO lijsten (bron, tijd, aantal, fout) VALUES (?, ?, ?, NULL) ON CONFLICT(bron) DO UPDATE SET tijd = excluded.tijd, aantal = excluded.aantal, fout = NULL')
      .run(bron.id, nu.toISOString(), regels.length);
    return regels.length;
  }

  // Het document van één stuk ophalen en doorzoekbaar maken. Geeft het aantal
  // opgehaalde bestanden (de pagina en de bijlagen), om daarna te wachten.
  async document(rij, bron) {
    try {
      const doc = await documentVoor(this.alsItem(rij), bron);
      this.zetDocument(rij.sleutel, doc || { blokken: [], volledig: true });
      return 1 + (doc?.blokken || []).filter(([soort]) => soort === 'd').length + (bron.type === 'ibabs' ? 1 : 0);
    } catch (fout) {
      this.db.prepare("UPDATE stukken SET pogingen = pogingen + 1, fout = ?, status = CASE WHEN pogingen + 1 >= ? THEN 'mislukt' ELSE status END WHERE nr = ?")
        .run(String(fout.message).slice(0, 300), POGINGEN, rij.nr);
      return 1;
    }
  }

  zetDocument(sleutel, doc) {
    const rij = this.db.prepare('SELECT nr, titel, tekst FROM stukken WHERE sleutel = ?').get(sleutel);
    if (!rij) return;
    this.db.prepare("UPDATE stukken SET status = 'ok', fout = NULL, blokken = ?, volledig = ? WHERE nr = ?").run(JSON.stringify(doc.blokken || []), doc.volledig ? 1 : 0, rij.nr);
    this.db.prepare('DELETE FROM stuk_fts WHERE rowid = ?').run(rij.nr);
    this.db.prepare('INSERT INTO stuk_fts (rowid, titel, tekst, inhoud) VALUES (?, ?, ?, ?)').run(rij.nr, rij.titel || '', rij.tekst || '', platVan(doc.blokken || []).slice(0, MAX_INHOUD));
  }

  // Reden om te stoppen, of null.
  grens() {
    const vrij = schijfVrij(this.map);
    if (vrij < minVrij() * GB) return `minder dan ${minVrij()} GB vrij op de schijf (${(vrij / GB).toFixed(1)} GB)`;
    if (this.grootte() > maxGrootte() * GB) return `het archief is groter dan ${maxGrootte()} GB`;
    return null;
  }

  grootte() {
    let n = 0;
    for (const deel of ['', '-wal']) {
      try { n += statSync(`${this.pad}${deel}`).size; } catch { /* nog niet */ }
    }
    return n;
  }

  // Eén stap: een lijst die aan de beurt is, anders een portie documenten.
  // Geeft terug hoe lang te wachten tot de volgende.
  async stap(nu = Date.now()) {
    const stop = this.grens();
    if (stop) {
      if (this.toestand.gestopt !== stop) this.opslag?.log({ soort: 'bronfout', tekst: `Archief gestopt: ${stop}` });
      this.toestand = { bezig: 'gestopt', gestopt: stop };
      return UUR;
    }
    const gelezen = new Map(this.db.prepare('SELECT bron, tijd FROM lijsten').all().map((r) => [r.bron, Date.parse(r.tijd)]));
    const aanDeBeurt = this.bronnen().find((b) => !(nu - (gelezen.get(b.id) || 0) < WEEK));
    if (aanDeBeurt) {
      this.toestand = { bezig: 'lijst', bron: aanDeBeurt.naam };
      try {
        await this.lijst(aanDeBeurt, new Date(nu));
      } catch (fout) {
        this.opslag?.log({ soort: 'bronfout', tekst: `Archief ${aanDeBeurt.naam}: ${fout.message}` });
      }
      return 0;
    }
    // Documenten: per portaal de nieuwste die nog ontbreken, een paar portalen tegelijk.
    const bronnen = new Map(this.bronnen().map((b) => [b.id, b]));
    const open = this.db.prepare(`SELECT nr, sleutel, bron, url, document_url, titel, datum FROM stukken
      WHERE status IS NULL AND pogingen < ? ORDER BY datum DESC LIMIT 2000`).all(POGINGEN).filter((r) => bronnen.has(r.bron));
    if (!open.length) {
      this.toestand = { bezig: 'bij' };
      return UUR;
    }
    const perPortaal = new Map();
    for (const r of open) {
      const h = host(r.url);
      if (!perPortaal.has(h)) perPortaal.set(h, []);
      if (perPortaal.get(h).length < PER_PORTAAL) perPortaal.get(h).push(r);
    }
    this.toestand = { bezig: 'documenten' };
    await Promise.all([...perPortaal.values()].slice(0, PORTALEN).map(async (rijen) => {
      for (const rij of rijen) {
        const bestanden = await this.document(rij, bronnen.get(rij.bron));
        await this.wacht(beleefd() * bestanden);
      }
    }));
    return 0;
  }

  start() {
    if (this.lopend) return;
    this.lopend = true;
    const volgende = async () => {
      let wacht;
      try {
        wacht = await this.stap();
      } catch (fout) {
        this.toestand = { bezig: 'fout', fout: fout.message };
        wacht = UUR / 4;
      }
      if (this.lopend) this.wekker = setTimeout(volgende, Math.max(wacht, 1000));
    };
    volgende();
  }

  stop() {
    this.lopend = false;
    clearTimeout(this.wekker);
  }

  // ---------- lezen en zoeken ----------

  // Een rij als item, zoals in opslag.items (archief: true).
  alsItem(r) {
    return {
      sleutel: r.sleutel, bron: r.bron, regio: r.regio, soort: r.soort, titel: r.titel, url: r.url, datum: r.datum,
      afzender: r.afzender, soortStuk: r.soort_stuk, advies: r.advies, tekst: r.tekst, document: r.document_url,
      eersteGezien: r.datum ? `${r.datum}T12:00:00.000Z` : r.gezien, basislijn: true, archief: true,
    };
  }

  item(sleutel) {
    const r = this.db.prepare('SELECT * FROM stukken WHERE sleutel = ?').get(sleutel);
    return r ? this.alsItem(r) : null;
  }

  // Het opgehaalde document ({ blokken, volledig }), of null.
  documentVan(sleutel) {
    const r = this.db.prepare("SELECT blokken, volledig FROM stukken WHERE sleutel = ? AND status = 'ok'").get(sleutel);
    if (!r) return null;
    try {
      return { blokken: JSON.parse(r.blokken || '[]'), volledig: Boolean(r.volledig) };
    } catch {
      return null;
    }
  }

  // Zoeken met FTS5-syntax (woorden, "zinnen", OR); klopt die niet, dan op de
  // losse woorden. Nieuwste eerst; het fragment alleen voor de getoonde regels.
  zoek(vraag, { max = 200 } = {}) {
    const probeer = (fts) => this.db.prepare(`WITH pagina AS (
        SELECT stuk_fts.rowid nr FROM stuk_fts JOIN stukken s ON s.nr = stuk_fts.rowid
        WHERE stuk_fts MATCH ? ORDER BY s.datum DESC, s.nr DESC LIMIT ?)
      SELECT s.*, snippet(stuk_fts, -1, '${MARK_BEGIN}', '${MARK_EIND}', '…', 24) fragment
      FROM pagina p JOIN stuk_fts ON stuk_fts.rowid = p.nr JOIN stukken s ON s.nr = p.nr
      WHERE stuk_fts MATCH ? ORDER BY s.datum DESC, s.nr DESC`).all(fts, max, fts);
    if (!String(vraag || '').trim()) return [];
    try {
      return probeer(vraag);
    } catch {
      const woorden = String(vraag).split(/[^\p{L}\p{N}]+/u).filter((w) => w && !['AND', 'OR', 'NOT', 'NEAR'].includes(w)).map((w) => `"${w}"`).join(' ');
      return woorden ? probeer(woorden) : [];
    }
  }

  status() {
    const r = this.db.prepare(`SELECT count(*) totaal, sum(status = 'ok') metTekst, sum(status IS NULL AND pogingen < ${POGINGEN}) wachtrij,
      sum(status = 'mislukt') mislukt, min(datum) oudste FROM stukken`).get();
    const lijsten = this.db.prepare('SELECT count(*) n, sum(fout IS NOT NULL) fouten FROM lijsten').get();
    return {
      ...this.toestand,
      totaal: r.totaal, metTekst: r.metTekst || 0, wachtrij: r.wachtrij || 0, mislukt: r.mislukt || 0, oudste: r.oudste,
      bronnen: this.bronnen().length, gelezen: lijsten.n, lijstFouten: lijsten.fouten || 0,
      grootte: this.grootte(), vrij: schijfVrij(this.map), minVrij: minVrij() * GB, maxGrootte: maxGrootte() * GB,
    };
  }
}
