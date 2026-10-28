// Het audio- en videoarchief in SQLite (data/regiochecker.sqlite, naast de
// gelezen/bewaard-gegevens van src/feeddb.mjs). Tot oktober 2026 was dit de
// aparte dienst audioscraper; nu doet de Regiochecker het zelf.
//
// Tabellen:
//   afleveringen        elke ontdekte aflevering met zijn plek in de wachtrij,
//                       het transcript (segmenten met tijd en spreker) en de
//                       gevonden namen (entiteiten)
//   audio_gezien        per bron alles wat ooit in de catalogus stond, zodat de
//                       oude catalogus bij de eerste import niet in de wachtrij komt
//   telefoon_*          telefoonnummers uit transcripten, bevestigde bedrijven,
//                       handmatige koppelingen en de analyse door de worker
//   audio_staat         sleutel/waarde, onder meer "verwerking gepauzeerd"
//
// Statussen van een aflevering:
//   wacht → downloaden → transcriberen → getranscribeerd → analyseren → klaar
// en mislukt na drie echte fouten (tijdelijke storingen blijven herkansen).

import { randomUUID } from 'node:crypto';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS afleveringen (
    id TEXT PRIMARY KEY,
    bron TEXT NOT NULL,
    extern TEXT NOT NULL,
    soort TEXT NOT NULL,
    vorm TEXT NOT NULL,
    titel TEXT NOT NULL,
    url TEXT NOT NULL,
    media_url TEXT,
    auteur TEXT,
    gepubliceerd TEXT,
    gepubliceerd_op REAL,
    duur REAL,
    afbeelding TEXT,
    status TEXT NOT NULL DEFAULT 'wacht',
    stap TEXT,
    pogingen INTEGER NOT NULL DEFAULT 0,
    opnieuw_op REAL NOT NULL DEFAULT 0,
    fout TEXT,
    audio_pad TEXT,
    transcript TEXT,
    segmenten TEXT,
    taal TEXT,
    entiteiten TEXT,
    entiteit_delen TEXT,
    transcript_delen TEXT,
    samenvatting TEXT,
    sprekers_gevraagd INTEGER NOT NULL DEFAULT 0,
    spreker_fout TEXT,
    nulmeting INTEGER NOT NULL DEFAULT 0,
    eerst_gezien TEXT,
    aangemaakt REAL NOT NULL,
    bijgewerkt REAL NOT NULL,
    UNIQUE (bron, extern)
  );
  CREATE INDEX IF NOT EXISTS afleveringen_wachtrij ON afleveringen(status, opnieuw_op);
  CREATE INDEX IF NOT EXISTS afleveringen_gezien ON afleveringen(eerst_gezien);
  CREATE INDEX IF NOT EXISTS afleveringen_bron ON afleveringen(bron);
  CREATE TABLE IF NOT EXISTS audio_gezien (bron TEXT NOT NULL, extern TEXT NOT NULL, PRIMARY KEY (bron, extern));
  CREATE TABLE IF NOT EXISTS telefoon_vermeldingen (
    nummer TEXT NOT NULL, aflevering TEXT NOT NULL, segment INTEGER NOT NULL, start REAL NOT NULL DEFAULT 0,
    ruw TEXT NOT NULL, weergave TEXT NOT NULL, categorie TEXT NOT NULL, context TEXT NOT NULL,
    PRIMARY KEY (nummer, aflevering, segment)
  );
  CREATE INDEX IF NOT EXISTS telefoon_nummer ON telefoon_vermeldingen(nummer);
  CREATE TABLE IF NOT EXISTS telefoon_verificaties (
    nummer TEXT PRIMARY KEY, bedrijf TEXT NOT NULL, kvk TEXT, locatie TEXT,
    bron_url TEXT NOT NULL, bron_label TEXT NOT NULL, gecontroleerd REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS telefoon_koppelingen (
    nummer TEXT PRIMARY KEY, staat TEXT NOT NULL, soort TEXT, relatie TEXT, label TEXT, omschrijving TEXT,
    zekerheid INTEGER, bewijs TEXT, aflevering TEXT, segment INTEGER, bron TEXT NOT NULL DEFAULT 'handmatig', beoordeeld REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS telefoon_context (
    nummer TEXT NOT NULL, aflevering TEXT NOT NULL, segment INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'wacht', pogingen INTEGER NOT NULL DEFAULT 0, opnieuw_op REAL NOT NULL DEFAULT 0,
    soort TEXT, relatie TEXT, label TEXT, omschrijving TEXT, zekerheid INTEGER, bewijs TEXT, model TEXT,
    geanalyseerd REAL, fout TEXT,
    PRIMARY KEY (nummer, aflevering, segment)
  );
  CREATE TABLE IF NOT EXISTS audio_staat (sleutel TEXT PRIMARY KEY, waarde TEXT);
`;

export const STATUSSEN = ['wacht', 'downloaden', 'transcriberen', 'getranscribeerd', 'analyseren', 'klaar', 'mislukt'];
export const BEZIG = ['downloaden', 'transcriberen', 'analyseren'];

const json = (t, leeg) => {
  try { return t ? JSON.parse(t) : leeg; } catch { return leeg; }
};

export const nieuwId = () => randomUUID().replaceAll('-', '');

// Een rij uit de database in de vorm die de rest van de Regiochecker gebruikt.
// `licht`: zonder transcript en segmenten (voor lijsten).
function aflevering(r, { licht = false } = {}) {
  if (!r) return null;
  return {
    id: r.id,
    bron: r.bron,
    extern: r.extern,
    soort: r.soort,
    vorm: r.vorm,
    titel: r.titel,
    url: r.url,
    mediaUrl: r.media_url,
    auteur: r.auteur,
    gepubliceerd: r.gepubliceerd_op ? new Date(r.gepubliceerd_op * 1000).toISOString() : null,
    gepubliceerdTekst: r.gepubliceerd,
    duur: r.duur,
    afbeelding: r.afbeelding,
    status: r.status,
    stap: r.stap,
    pogingen: r.pogingen,
    opnieuwOp: r.opnieuw_op,
    fout: r.fout,
    audio: Boolean(r.audio_pad),
    audioPad: r.audio_pad,
    taal: r.taal,
    sprekersGevraagd: Boolean(r.sprekers_gevraagd),
    sprekerFout: r.spreker_fout,
    nulmeting: Boolean(r.nulmeting),
    eersteGezien: r.eerst_gezien,
    aangemaakt: r.aangemaakt,
    bijgewerkt: r.bijgewerkt,
    heeftTranscript: r.transcript !== undefined ? Boolean(r.transcript) : Boolean(r.heeft_transcript),
    ...(licht ? {} : {
      transcript: r.transcript,
      segmenten: json(r.segmenten, []),
      entiteiten: json(r.entiteiten, null),
      entiteitDelen: json(r.entiteit_delen, []),
      transcriptDelen: json(r.transcript_delen, []),
      samenvatting: json(r.samenvatting, null),
    }),
  };
}

const LICHT = `id, bron, extern, soort, vorm, titel, url, media_url, auteur, gepubliceerd, gepubliceerd_op, duur, afbeelding,
  status, stap, pogingen, opnieuw_op, fout, audio_pad, taal, sprekers_gevraagd, spreker_fout, nulmeting, eerst_gezien,
  aangemaakt, bijgewerkt, transcript IS NOT NULL AS heeft_transcript`;

const VELDEN = {
  titel: 'titel', url: 'url', mediaUrl: 'media_url', auteur: 'auteur', gepubliceerdTekst: 'gepubliceerd', gepubliceerdOp: 'gepubliceerd_op',
  duur: 'duur', afbeelding: 'afbeelding', status: 'status', stap: 'stap', pogingen: 'pogingen', opnieuwOp: 'opnieuw_op', fout: 'fout',
  audioPad: 'audio_pad', transcript: 'transcript', segmenten: 'segmenten', taal: 'taal', entiteiten: 'entiteiten', entiteitDelen: 'entiteit_delen', transcriptDelen: 'transcript_delen', samenvatting: 'samenvatting',
  sprekersGevraagd: 'sprekers_gevraagd', sprekerFout: 'spreker_fout', eersteGezien: 'eerst_gezien', nulmeting: 'nulmeting',
};
const ALS_JSON = new Set(['segmenten', 'entiteiten', 'entiteitDelen', 'transcriptDelen', 'samenvatting']);

export class AudioDb {
  constructor(db) {
    this.db = db;
    // Een korte tussenversie (oktober 2026) haalde afleveringen uit een losse
    // audioscraper, met een andere tabel; die gaat weg.
    const kolommen = db.prepare("SELECT name FROM pragma_table_info('afleveringen')").all().map((r) => r.name);
    if (kolommen.length && !kolommen.includes('extern')) db.exec('DROP TABLE afleveringen');
    db.exec(SCHEMA);
    // Later bijgekomen kolommen.
    const nu = db.prepare("SELECT name FROM pragma_table_info('afleveringen')").all().map((r) => r.name);
    if (!nu.includes('transcript_delen')) db.exec('ALTER TABLE afleveringen ADD COLUMN transcript_delen TEXT');
    if (!nu.includes('samenvatting')) db.exec('ALTER TABLE afleveringen ADD COLUMN samenvatting TEXT');
    // Na een herstart: wat bezig was, gaat terug in de wachtrij.
    db.prepare("UPDATE afleveringen SET status = CASE WHEN transcript IS NULL OR sprekers_gevraagd = 1 THEN 'wacht' ELSE 'getranscribeerd' END, stap = 'Hervatten na herstart' WHERE status IN ('downloaden', 'transcriberen', 'analyseren')").run();
    db.prepare("UPDATE telefoon_context SET status = 'wacht' WHERE status = 'bezig'").run();
  }

  // ---------- staat ----------

  staat(sleutel) {
    return this.db.prepare('SELECT waarde FROM audio_staat WHERE sleutel = ?').get(sleutel)?.waarde ?? null;
  }

  zetStaat(sleutel, waarde) {
    this.db.prepare('INSERT INTO audio_staat (sleutel, waarde) VALUES (?, ?) ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde').run(sleutel, String(waarde));
  }

  gepauzeerd() {
    return this.staat('gepauzeerd') === '1';
  }

  // ---------- afleveringen ----------

  aflevering(id) {
    return aflevering(this.db.prepare('SELECT * FROM afleveringen WHERE id = ?').get(id));
  }

  // Een nieuwe aflevering uit een catalogus; bestaat hij al, dan niets.
  voegToe(bron, item, { nulmeting = false, nu = Date.now() / 1000 } = {}) {
    const id = item.id || nieuwId();
    const r = this.db.prepare(`INSERT OR IGNORE INTO afleveringen (id, bron, extern, soort, vorm, titel, url, media_url, auteur, gepubliceerd, gepubliceerd_op, duur, afbeelding, nulmeting, aangemaakt, bijgewerkt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, bron.id, item.extern, bron.soort, item.vorm, item.titel || 'Aflevering', item.url, item.mediaUrl || null, item.auteur || null,
        item.gepubliceerd || null, item.gepubliceerdOp ?? null, item.duur ?? null, item.afbeelding || null, nulmeting ? 1 : 0, nu, nu);
    return r.changes > 0;
  }

  bestaand(bron, extern) {
    return aflevering(this.db.prepare(`SELECT ${LICHT} FROM afleveringen WHERE bron = ? AND extern = ?`).get(bron, extern), { licht: true });
  }

  werkBij(id, velden) {
    const delen = [];
    const waarden = [];
    for (const [sleutel, waarde] of Object.entries(velden)) {
      const kolom = VELDEN[sleutel];
      if (!kolom) throw new Error(`Onbekend veld ${sleutel}`);
      delen.push(`${kolom} = ?`);
      waarden.push(ALS_JSON.has(sleutel) && waarde !== null ? JSON.stringify(waarde) : typeof waarde === 'boolean' ? Number(waarde) : waarde ?? null);
    }
    delen.push('bijgewerkt = ?');
    waarden.push(Date.now() / 1000);
    this.db.prepare(`UPDATE afleveringen SET ${delen.join(', ')} WHERE id = ?`).run(...waarden, id);
  }

  gezien(bron) {
    return new Set(this.db.prepare('SELECT extern FROM audio_gezien WHERE bron = ?').all(bron).map((r) => r.extern));
  }

  markeerGezien(bron, externen) {
    const zet = this.db.prepare('INSERT OR IGNORE INTO audio_gezien (bron, extern) VALUES (?, ?)');
    for (const e of externen) zet.run(bron, e);
  }

  // Kandidaten voor de wachtrij, zonder transcript (licht). De volgorde
  // bepaalt src/audio/verwerking.mjs, want die hangt van de bronnen af.
  wachtrij(nu = Date.now() / 1000) {
    // Een samenvatting ontbreekt nog, of mislukte minder dan drie keer.
    const zonderSamenvatting = "(samenvatting IS NULL OR (json_extract(samenvatting, '$.tekst') IS NULL AND COALESCE(json_extract(samenvatting, '$.pogingen'), 0) < 3))";
    return this.db.prepare(`SELECT id, bron, status, transcript IS NULL AS zonder_transcript, sprekers_gevraagd, entiteiten IS NULL AS zonder_entiteiten,
        ${zonderSamenvatting} AS zonder_samenvatting, transcript_delen IS NOT NULL AS met_delen,
        segmenten LIKE '%speaker_id%' AS met_stemmen, COALESCE(gepubliceerd_op, aangemaakt) AS moment, opnieuw_op
      FROM afleveringen WHERE status IN ('wacht', 'getranscribeerd', 'downloaden', 'transcriberen', 'analyseren')
        OR (status = 'klaar' AND transcript IS NOT NULL AND ${zonderSamenvatting})`).all()
      .map((r) => ({ ...r, klaarVoor: r.opnieuw_op <= nu }));
  }

  // Voor de beheerpagina: wat er nu gebeurt, en per bron de tellingen.
  bezig() {
    return this.db.prepare(`SELECT ${LICHT} FROM afleveringen WHERE status IN ('downloaden', 'transcriberen', 'analyseren') ORDER BY bijgewerkt DESC`).all().map((r) => aflevering(r, { licht: true }));
  }

  lijst({ bron, status, ids, limiet = 200, zonder } = {}) {
    const waar = [];
    const waarden = [];
    if (bron) { waar.push('bron = ?'); waarden.push(bron); }
    if (status) { waar.push(`status IN (${status.map(() => '?').join(', ')})`); waarden.push(...status); }
    if (ids) { waar.push(`id IN (${ids.map(() => '?').join(', ') || "''"})`); waarden.push(...ids); }
    if (zonder) waar.push(zonder);
    return this.db.prepare(`SELECT ${LICHT} FROM afleveringen ${waar.length ? `WHERE ${waar.join(' AND ')}` : ''}
      ORDER BY COALESCE(gepubliceerd_op, aangemaakt) DESC LIMIT ?`).all(...waarden, limiet).map((r) => aflevering(r, { licht: true }));
  }

  tellingen() {
    const uit = {};
    for (const r of this.db.prepare('SELECT bron, status, count(*) n FROM afleveringen GROUP BY bron, status').all()) {
      const t = uit[r.bron] ||= { totaal: 0, klaar: 0, bezig: 0, mislukt: 0, transcripten: 0 };
      t.totaal += r.n;
      if (r.status === 'klaar') t.klaar += r.n;
      else if (r.status === 'mislukt') t.mislukt += r.n;
      else t.bezig += r.n;
    }
    for (const r of this.db.prepare('SELECT bron, count(*) n FROM afleveringen WHERE transcript IS NOT NULL GROUP BY bron').all()) {
      if (uit[r.bron]) uit[r.bron].transcripten = r.n;
    }
    return uit;
  }

  // Met transcript, voor feed, mail, zoeken en het archief.
  metTranscriptSinds(sinds, tot = '9999') {
    return this.db.prepare(`SELECT * FROM afleveringen WHERE transcript IS NOT NULL AND eerst_gezien > ? AND eerst_gezien <= ? ORDER BY eerst_gezien DESC`)
      .all(sinds, tot).map((r) => aflevering(r));
  }

  // Alle afleveringen met transcript, in delen, om het hele archief te doorzoeken.
  *alleMetTranscript(bron = null) {
    const stap = this.db.prepare(`SELECT * FROM afleveringen WHERE transcript IS NOT NULL ${bron ? 'AND bron = ?' : ''} AND rowid > ? ORDER BY rowid LIMIT 200`);
    const rowid = this.db.prepare('SELECT rowid FROM afleveringen WHERE id = ?');
    let laatste = 0;
    for (;;) {
      const rijen = bron ? stap.all(bron, laatste) : stap.all(laatste);
      if (!rijen.length) return;
      for (const r of rijen) yield aflevering(r);
      laatste = rowid.get(rijen.at(-1).id).rowid;
    }
  }

  aantalSinds(bron, sinds) {
    return this.db.prepare('SELECT count(*) n FROM afleveringen WHERE bron = ? AND eerst_gezien > ?').get(bron, sinds).n;
  }

  heeftSpreker(profiel) {
    return Boolean(this.db.prepare('SELECT 1 FROM afleveringen WHERE segmenten LIKE ? LIMIT 1').get(`%"speaker_id":"${profiel}"%`));
  }

  // Een naam geldt voor alle beurten van die stem, in alle afleveringen.
  hernoemSpreker(profiel, naam) {
    let aantal = 0;
    for (const r of this.db.prepare('SELECT id, segmenten FROM afleveringen WHERE segmenten LIKE ?').all(`%"speaker_id":"${profiel}"%`)) {
      const segmenten = json(r.segmenten, []);
      let gewijzigd = false;
      for (const s of segmenten) {
        if (s.speaker_id === profiel && s.speaker !== naam) {
          s.speaker = naam;
          gewijzigd = true;
        }
      }
      if (gewijzigd) {
        this.db.prepare('UPDATE afleveringen SET segmenten = ?, bijgewerkt = ? WHERE id = ?').run(JSON.stringify(segmenten), Date.now() / 1000, r.id);
        aantal++;
      }
    }
    return aantal;
  }

  // Alle segmenten met een stem, voor het overzicht van stemmen.
  *metStemmen() {
    for (const r of this.db.prepare("SELECT id, bron, titel, segmenten, entiteiten FROM afleveringen WHERE segmenten LIKE '%speaker_id%'").iterate()) {
      yield { id: r.id, bron: r.bron, titel: r.titel, segmenten: json(r.segmenten, []), entiteiten: json(r.entiteiten, null) };
    }
  }

  verwijderBron(bron) {
    const ids = this.db.prepare('SELECT id, audio_pad FROM afleveringen WHERE bron = ?').all(bron);
    for (const tabel of ['telefoon_vermeldingen', 'telefoon_context']) {
      this.db.prepare(`DELETE FROM ${tabel} WHERE aflevering IN (SELECT id FROM afleveringen WHERE bron = ?)`).run(bron);
    }
    this.db.prepare('DELETE FROM afleveringen WHERE bron = ?').run(bron);
    this.db.prepare('DELETE FROM audio_gezien WHERE bron = ?').run(bron);
    return ids;
  }

  // ---------- telefoonnummers ----------

  vervangVermeldingen(aflevering, vermeldingen) {
    this.db.prepare('DELETE FROM telefoon_context WHERE aflevering = ?').run(aflevering);
    this.db.prepare('DELETE FROM telefoon_vermeldingen WHERE aflevering = ?').run(aflevering);
    const zet = this.db.prepare('INSERT OR IGNORE INTO telefoon_vermeldingen (nummer, aflevering, segment, start, ruw, weergave, categorie, context) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const v of vermeldingen) zet.run(v.nummer, aflevering, v.segment, v.start, v.ruw, v.weergave, v.categorie, v.context);
  }

  zetVerificatie(nummer, v) {
    this.db.prepare(`INSERT INTO telefoon_verificaties (nummer, bedrijf, kvk, locatie, bron_url, bron_label, gecontroleerd) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(nummer) DO UPDATE SET bedrijf = excluded.bedrijf, kvk = excluded.kvk, locatie = excluded.locatie, bron_url = excluded.bron_url,
        bron_label = excluded.bron_label, gecontroleerd = excluded.gecontroleerd WHERE excluded.gecontroleerd >= telefoon_verificaties.gecontroleerd`)
      .run(nummer, v.bedrijf, v.kvk ?? null, v.locatie ?? null, v.bronUrl, v.bronLabel, v.gecontroleerd);
  }

  sluit() {
    this.db.close();
  }
}
