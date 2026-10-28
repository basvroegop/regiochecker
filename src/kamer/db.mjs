// De kamerstukken in SQLite (data/kamerstukken.sqlite), met een FTS5-index op
// titel, onderwerp en volledige tekst. Zoeken negeert hoofdletters en accenten
// (remove_diacritics), net als de termen in src/kamer/termen.mjs.
//
// node:sqlite zit in Node 22 en nieuwer; we laden het pas bij het openen, zodat
// de rest van de Regiochecker ook zonder draait (en te testen is).
//
// Tabel stukken:   metadata van de Tweede Kamer, plus `binnen` (wanneer wij de
//                  tekst geïndexeerd hebben) en de tekststatus.
// Tabel stuk_fts:  titel, onderwerp en tekst; rowid = stukken.nr.
// Tabel staat:     sleutel/waarde, onder meer het synchronisatiepunt.

import { ftsVoorTermen, vindTermen } from './termen.mjs';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS stukken (
    nr INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    nummer TEXT,
    soort TEXT,
    titel TEXT,
    onderwerp TEXT,
    datum TEXT,
    vergaderjaar TEXT,
    dossier TEXT,
    dossiertitel TEXT,
    zaak TEXT,
    afzender TEXT,
    contenttype TEXT,
    gewijzigd TEXT,
    binnen TEXT,
    tekststatus TEXT,
    tekstfout TEXT,
    pogingen INTEGER NOT NULL DEFAULT 0,
    lengte INTEGER
  );
  CREATE INDEX IF NOT EXISTS stukken_datum ON stukken(datum);
  CREATE INDEX IF NOT EXISTS stukken_binnen ON stukken(binnen);
  CREATE INDEX IF NOT EXISTS stukken_wachtrij ON stukken(tekststatus, pogingen);
  CREATE VIRTUAL TABLE IF NOT EXISTS stuk_fts USING fts5(
    titel, onderwerp, tekst,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TABLE IF NOT EXISTS staat (sleutel TEXT PRIMARY KEY, waarde TEXT);
`;

export async function openKamerDb(pad) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(pad);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  return new KamerDb(db);
}

// Link naar het stuk op tweedekamer.nl: de detailpagina als er een zaak bij
// hoort, anders de download (bijlagen hebben geen eigen pagina).
export function stukUrl(s) {
  if (s.zaak && s.nummer) return `https://www.tweedekamer.nl/kamerstukken/detail?id=${encodeURIComponent(s.zaak)}&did=${encodeURIComponent(s.nummer)}`;
  return `https://www.tweedekamer.nl/downloads/document?id=${encodeURIComponent(s.id)}`;
}

export const downloadUrl = (s) => `https://www.tweedekamer.nl/downloads/document?id=${encodeURIComponent(s.id)}`;

// Stukken die we pas binnenhalen als ze al oud zijn (de eerste keer inhalen,
// of een document dat de Kamer later publiceert) tellen niet als nieuw voor
// meldingen: ouder dan twee weken vóór het begin van de periode valt af.
export const minDatum = (sinds) => new Date(Date.parse(sinds) - 14 * 86400000).toISOString().slice(0, 10);

// Markeringen in fragmenten: tekens die nooit in een kamerstuk staan, zodat de
// webUI eerst kan ontsnappen en daarna markeren.
export const MARK_BEGIN = '\u0001';
export const MARK_EIND = '\u0002';

class KamerDb {
  constructor(db) {
    this.db = db;
  }

  staat(sleutel) {
    return this.db.prepare('SELECT waarde FROM staat WHERE sleutel = ?').get(sleutel)?.waarde ?? null;
  }

  zetStaat(sleutel, waarde) {
    this.db.prepare('INSERT INTO staat (sleutel, waarde) VALUES (?, ?) ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde').run(sleutel, waarde);
  }

  // Metadata erin of bijwerken. Is het document daarna gewijzigd (nieuwe versie),
  // dan halen we de tekst opnieuw op.
  bewaarStuk(s) {
    const oud = this.db.prepare('SELECT nr, gewijzigd FROM stukken WHERE id = ?').get(s.id);
    if (!oud) {
      this.db.prepare(`INSERT INTO stukken (id, nummer, soort, titel, onderwerp, datum, vergaderjaar, dossier, dossiertitel, zaak, afzender, contenttype, gewijzigd)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(s.id, s.nummer, s.soort, s.titel, s.onderwerp, s.datum, s.vergaderjaar, s.dossier, s.dossiertitel, s.zaak, s.afzender, s.contenttype, s.gewijzigd);
      return 'nieuw';
    }
    const andereVersie = oud.gewijzigd !== s.gewijzigd;
    this.db.prepare(`UPDATE stukken SET nummer = ?, soort = ?, titel = ?, onderwerp = ?, datum = ?, vergaderjaar = ?, dossier = ?, dossiertitel = ?, zaak = ?, afzender = ?, contenttype = ?, gewijzigd = ?
      ${andereVersie ? ', tekststatus = NULL, pogingen = 0' : ''} WHERE nr = ?`)
      .run(s.nummer, s.soort, s.titel, s.onderwerp, s.datum, s.vergaderjaar, s.dossier, s.dossiertitel, s.zaak, s.afzender, s.contenttype, s.gewijzigd, oud.nr);
    return 'bijgewerkt';
  }

  verwijderStuk(id) {
    const oud = this.db.prepare('SELECT nr FROM stukken WHERE id = ?').get(id);
    if (!oud) return false;
    this.db.prepare('DELETE FROM stuk_fts WHERE rowid = ?').run(oud.nr);
    this.db.prepare('DELETE FROM stukken WHERE nr = ?').run(oud.nr);
    return true;
  }

  // Stukken zonder tekst, nieuwste eerst.
  wachtrij(max, maxPogingen) {
    return this.db.prepare(`SELECT * FROM stukken WHERE tekststatus IS NULL AND pogingen < ? ORDER BY datum DESC LIMIT ?`).all(maxPogingen, max);
  }

  // tekst === null: geen leesbaar formaat; dan alleen titel en onderwerp indexeren.
  bewaarTekst(nr, tekst, nu = new Date()) {
    const s = this.db.prepare('SELECT titel, onderwerp, binnen FROM stukken WHERE nr = ?').get(nr);
    this.db.prepare('DELETE FROM stuk_fts WHERE rowid = ?').run(nr);
    this.db.prepare('INSERT INTO stuk_fts (rowid, titel, onderwerp, tekst) VALUES (?, ?, ?, ?)').run(nr, s.titel || '', s.onderwerp || '', tekst || '');
    this.db.prepare('UPDATE stukken SET tekststatus = ?, tekstfout = NULL, lengte = ?, binnen = COALESCE(binnen, ?) WHERE nr = ?')
      .run(tekst === null ? 'geen' : 'ok', tekst ? tekst.length : 0, nu.toISOString(), nr);
  }

  tekstMislukt(nr, fout) {
    this.db.prepare('UPDATE stukken SET pogingen = pogingen + 1, tekstfout = ? WHERE nr = ?').run(String(fout).slice(0, 500), nr);
  }

  tekst(nr) {
    return this.db.prepare('SELECT tekst FROM stuk_fts WHERE rowid = ?').get(nr)?.tekst ?? '';
  }

  status() {
    const r = this.db.prepare(`SELECT count(*) totaal,
        sum(tekststatus = 'ok') metTekst, sum(tekststatus = 'geen') zonderTekst,
        sum(tekststatus IS NULL AND pogingen < 3) wachtrij, sum(tekststatus IS NULL AND pogingen >= 3) mislukt,
        min(datum) oudste, max(datum) nieuwste, max(binnen) laatstBinnen
      FROM stukken`).get();
    return { ...r, laatsteSync: this.staat('laatsteSync'), synchronisatiepunt: this.staat('synchronisatiepunt') };
  }

  soorten() {
    return this.db.prepare('SELECT soort, count(*) aantal FROM stukken GROUP BY soort ORDER BY aantal DESC').all();
  }

  // De zoekmachine. `vraag` is FTS5-syntax (woorden, "zinnen", OR, NOT, voorvoegsel*);
  // klopt de syntax niet, dan zoeken we op de losse woorden.
  zoek({ vraag = '', soort, van, tot, sorteer = 'relevantie', pagina = 1, perPagina = 20 }) {
    const filters = [];
    const waarden = [];
    if (soort) { filters.push('s.soort = ?'); waarden.push(soort); }
    if (van) { filters.push('s.datum >= ?'); waarden.push(van); }
    if (tot) { filters.push('s.datum <= ?'); waarden.push(tot); }
    const offset = (Math.max(1, pagina) - 1) * perPagina;

    if (!vraag.trim()) {
      const waar = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const totaal = this.db.prepare(`SELECT count(*) n FROM stukken s ${waar}`).get(...waarden).n;
      const rijen = this.db.prepare(`SELECT s.*, '' fragment FROM stukken s ${waar} ORDER BY s.datum DESC, s.nr DESC LIMIT ? OFFSET ?`)
        .all(...waarden, perPagina, offset);
      return { totaal, rijen };
    }

    const probeer = (fts) => {
      const waar = ['stuk_fts MATCH ?', ...filters].join(' AND ');
      const totaal = this.db.prepare(`SELECT count(*) n FROM stuk_fts JOIN stukken s ON s.nr = stuk_fts.rowid WHERE ${waar}`).get(fts, ...waarden).n;
      const volgorde = sorteer === 'datum' ? 's.datum DESC, s.nr DESC' : 'bm25(stuk_fts, 10.0, 5.0, 1.0), s.datum DESC';
      const rijen = this.db.prepare(`SELECT s.*, snippet(stuk_fts, -1, '${MARK_BEGIN}', '${MARK_EIND}', '…', 30) fragment
        FROM stuk_fts JOIN stukken s ON s.nr = stuk_fts.rowid WHERE ${waar} ORDER BY ${volgorde} LIMIT ? OFFSET ?`)
        .all(fts, ...waarden, perPagina, offset);
      return { totaal, rijen };
    };
    try {
      return { ...probeer(vraag), vraag };
    } catch {
      const woorden = vraag.split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w && !['AND', 'OR', 'NOT', 'NEAR'].includes(w))
        .map((w) => `"${w}"`).join(' ');
      if (!woorden) return { totaal: 0, rijen: [], vraag };
      return { ...probeer(woorden), vraag: woorden, aangepast: true };
    }
  }

  // Stukken die sinds `sinds` binnenkwamen en een van de termen bevatten, met
  // per stuk de gevonden termen en een fragment. `minDatum` houdt stukken buiten
  // die we pas laat binnenhaalden maar al oud zijn (de eerste keer inhalen).
  treffers(termen, { sinds, tot = new Date().toISOString(), minDatum, max = 100 }) {
    const fts = ftsVoorTermen(termen);
    if (!fts) return [];
    const rijen = this.db.prepare(`SELECT s.* FROM stuk_fts JOIN stukken s ON s.nr = stuk_fts.rowid
      WHERE stuk_fts MATCH ? AND s.binnen > ? AND s.binnen <= ? AND s.datum >= ?
      ORDER BY s.datum DESC, s.nr DESC LIMIT ?`).all(fts, sinds, tot, minDatum || '0000', max);
    const uit = [];
    for (const stuk of rijen) {
      // FTS vindt kandidaten; de exacte controle (hele woorden) doen we hier.
      const gevonden = vindTermen(`${stuk.titel || ''}\n${stuk.onderwerp || ''}\n${this.tekst(stuk.nr)}`, termen);
      if (gevonden.length) uit.push({ stuk, gevonden });
    }
    return uit;
  }

  // Hoe vaak komt elke term voor in stukken van de afgelopen `dagen`? Voor de
  // termenpagina, om te zien of een term te veel (of niets) oplevert.
  telTermen(termen, dagen = 30) {
    const vanaf = new Date(Date.now() - dagen * 86400000).toISOString().slice(0, 10);
    return termen.map((term) => {
      const fts = ftsVoorTermen([term]);
      if (!fts) return { term, aantal: 0 };
      const n = this.db.prepare('SELECT count(*) n FROM stuk_fts JOIN stukken s ON s.nr = stuk_fts.rowid WHERE stuk_fts MATCH ? AND s.datum >= ?').get(fts, vanaf).n;
      return { term, aantal: n };
    });
  }

  sluit() {
    this.db.close();
  }
}
