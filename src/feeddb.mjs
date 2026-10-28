// Per gebruiker per stuk: gelezen, bewaard en een notitie (alleen voor die
// gebruiker zichtbaar). In SQLite (data/regiochecker.sqlite), omdat dit met
// elke klik groeit; de rest van de toestand past in de JSON-bestanden van
// src/opslag.mjs. Het audioarchief staat in dezelfde database (src/audio/db.mjs),
// net als het hele document achter elk item (voor het leespaneel).
//
// Een stuk-id is per soort bron:
//   i:<sleutel>   een item uit items.json (gemeentelijke of landelijke bron)
//   k:<id>        een kamerstuk (id van de Tweede Kamer)
//   a:<id>        een aflevering met transcript (audio en video)
//
// Bij bewaren slaan we een momentopname van het stuk op (titel, regio, soort),
// zodat een bewaard stuk blijft staan, ook als de bron het al lang niet meer toont.

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS gebruiker_item (
    gebruiker TEXT NOT NULL,
    item TEXT NOT NULL,
    gelezen TEXT,
    bewaard TEXT,
    notitie TEXT,
    momentopname TEXT,
    gewijzigd TEXT NOT NULL,
    PRIMARY KEY (gebruiker, item)
  );
  CREATE INDEX IF NOT EXISTS gebruiker_bewaard ON gebruiker_item(gebruiker, bewaard);
  -- Het hele document achter een item (src/inhoud.mjs), als blokken in JSON
  -- (src/document.mjs); een lege lijst als er niets te halen viel.
  CREATE TABLE IF NOT EXISTS document (
    item TEXT PRIMARY KEY,
    blokken TEXT NOT NULL,
    volledig INTEGER NOT NULL,
    opgehaald TEXT NOT NULL
  );
`;

export async function openFeedDb(pad) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(pad);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  return new FeedDb(db);
}

const json = (t, leeg) => {
  try { return t ? JSON.parse(t) : leeg; } catch { return leeg; }
};

class FeedDb {
  constructor(db) {
    this.db = db;
  }

  // ---------- documenten ----------

  document(sleutel) {
    const r = this.db.prepare('SELECT blokken, volledig FROM document WHERE item = ?').get(sleutel);
    return r ? { blokken: json(r.blokken, []), volledig: Boolean(r.volledig) } : null;
  }

  heeftDocument(sleutel) {
    return Boolean(this.db.prepare('SELECT 1 FROM document WHERE item = ?').get(sleutel));
  }

  zetDocument(sleutel, { blokken, volledig }, nu = new Date()) {
    this.db.prepare(`INSERT INTO document (item, blokken, volledig, opgehaald) VALUES (?, ?, ?, ?)
      ON CONFLICT(item) DO UPDATE SET blokken = excluded.blokken, volledig = excluded.volledig, opgehaald = excluded.opgehaald`)
      .run(sleutel, JSON.stringify(blokken || []), volledig === false ? 0 : 1, nu.toISOString());
  }

  // Documenten van items die niet meer bestaan, weg.
  ruimDocumentenOp(bestaand) {
    const weg = this.db.prepare('SELECT item FROM document').all().map((r) => r.item).filter((s) => !bestaand.has(s));
    const verwijder = this.db.prepare('DELETE FROM document WHERE item = ?');
    for (const s of weg) verwijder.run(s);
    return weg.length;
  }

  // ---------- gelezen, bewaard, notitie ----------

  // Status van een reeks stukken voor één gebruiker: Map id → { gelezen, bewaard, notitie }.
  statussen(gebruiker) {
    const uit = new Map();
    for (const r of this.db.prepare('SELECT item, gelezen, bewaard, notitie FROM gebruiker_item WHERE gebruiker = ?').all(gebruiker)) {
      uit.set(r.item, { gelezen: r.gelezen, bewaard: r.bewaard, notitie: r.notitie || '' });
    }
    return uit;
  }

  status(gebruiker, item) {
    const r = this.db.prepare('SELECT gelezen, bewaard, notitie FROM gebruiker_item WHERE gebruiker = ? AND item = ?').get(gebruiker, item);
    return { gelezen: r?.gelezen || null, bewaard: r?.bewaard || null, notitie: r?.notitie || '' };
  }

  // wijziging: { gelezen?: bool, bewaard?: bool, notitie?: string, momentopname?: object }
  zet(gebruiker, item, wijziging, nu = new Date()) {
    const oud = this.status(gebruiker, item);
    const tijd = nu.toISOString();
    const nieuw = {
      gelezen: wijziging.gelezen === undefined ? oud.gelezen : (wijziging.gelezen ? oud.gelezen || tijd : null),
      bewaard: wijziging.bewaard === undefined ? oud.bewaard : (wijziging.bewaard ? oud.bewaard || tijd : null),
      notitie: wijziging.notitie === undefined ? oud.notitie : String(wijziging.notitie).slice(0, 5000),
    };
    this.db.prepare(`INSERT INTO gebruiker_item (gebruiker, item, gelezen, bewaard, notitie, momentopname, gewijzigd)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(gebruiker, item) DO UPDATE SET gelezen = excluded.gelezen, bewaard = excluded.bewaard,
        notitie = excluded.notitie, momentopname = COALESCE(excluded.momentopname, momentopname), gewijzigd = excluded.gewijzigd`)
      .run(gebruiker, item, nieuw.gelezen, nieuw.bewaard, nieuw.notitie, wijziging.momentopname ? JSON.stringify(wijziging.momentopname) : null, tijd);
    return nieuw;
  }

  bewaarde(gebruiker) {
    return this.db.prepare('SELECT item, gelezen, bewaard, notitie, momentopname FROM gebruiker_item WHERE gebruiker = ? AND bewaard IS NOT NULL ORDER BY bewaard DESC')
      .all(gebruiker)
      .map((r) => ({ item: r.item, gelezen: r.gelezen, bewaard: r.bewaard, notitie: r.notitie || '', momentopname: json(r.momentopname, null) }));
  }

  aantalBewaard(gebruiker) {
    return this.db.prepare('SELECT count(*) n FROM gebruiker_item WHERE gebruiker = ? AND bewaard IS NOT NULL').get(gebruiker).n;
  }

  vergeetGebruiker(gebruiker) {
    this.db.prepare('DELETE FROM gebruiker_item WHERE gebruiker = ?').run(gebruiker);
  }

  sluit() {
    this.db.close();
  }
}
