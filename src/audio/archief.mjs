// Het archief van audio en video doorzoeken: namen over alle afleveringen
// heen (met de plekken waar ze vallen), stemmen, telefoonnummers, en een
// transcript als tekstbestand. Overgenomen uit het dashboard van audioscraper.

import { SOORTEN, deelLocatieIn, inGebied } from './namen.mjs';
import { netgebied } from './netnummers.mjs';
import { SOORTEN as NUMMERSOORTEN, RELATIES } from './telefoon.mjs';
import { tijdcode } from '../vergadering.mjs';

const json = (t, leeg) => {
  try { return t ? JSON.parse(t) : leeg; } catch { return leeg; }
};

function* namenPerAflevering(adb, bron) {
  const sql = `SELECT id, bron, titel, url, soort, gepubliceerd_op, entiteiten, segmenten FROM afleveringen WHERE entiteiten IS NOT NULL ${bron ? 'AND bron = ?' : ''}`;
  for (const r of (bron ? adb.db.prepare(sql).iterate(bron) : adb.db.prepare(sql).iterate())) yield r;
}

// Alle namen, gesorteerd op in hoeveel afleveringen ze vallen.
export function namenOverzicht(adb, { q = '', soort = '', gebied = '', bron = '', limiet = 150, offset = 0 } = {}) {
  const zoek = q.trim().toLowerCase();
  const samen = new Map();
  for (const r of namenPerAflevering(adb, bron)) {
    for (const e of json(r.entiteiten, [])) {
      if (zoek && !String(e.name).toLowerCase().includes(zoek)) continue;
      if (soort && e.type !== soort) continue;
      const sleutel = `${String(e.name).toLowerCase()}|${e.type}`;
      const n = samen.get(sleutel) || { naam: e.name, soort: e.type, aantal: 0, afleveringen: 0 };
      n.aantal += e.count || 0;
      n.afleveringen++;
      samen.set(sleutel, n);
    }
  }
  const uit = [];
  for (const n of samen.values()) {
    const geografie = n.soort === 'location' ? deelLocatieIn(n.naam) : null;
    if (gebied && (n.soort !== 'location' || !inGebied(geografie, gebied))) continue;
    uit.push({ ...n, soortNaam: SOORTEN[n.soort] || 'Overig', ...(geografie ? { geografie } : {}) });
  }
  uit.sort((a, b) => b.afleveringen - a.afleveringen || b.aantal - a.aantal || a.naam.localeCompare(b.naam, 'nl'));
  return { totaal: uit.length, namen: uit.slice(Math.max(0, offset), Math.max(0, offset) + limiet) };
}

// Waar valt een naam? Per aflevering en per alinea (een vermelding kan over
// twee segmenten lopen), met de tijd.
export function vermeldingen(adb, { naam, soort = '', bron = '' }) {
  const doel = String(naam || '').trim().toLowerCase();
  if (!doel) return { naam: '', soort, vermeldingen: [] };
  const groepen = new Map();
  let echteNaam = naam;
  let echteSoort = soort;
  for (const r of namenPerAflevering(adb, bron)) {
    const segmenten = json(r.segmenten, []);
    for (const e of json(r.entiteiten, [])) {
      if (String(e.name).toLowerCase() !== doel || (soort && e.type !== soort)) continue;
      echteNaam = e.name;
      echteSoort = e.type;
      for (const o of e.occurrences || []) {
        const indexen = [...new Set((o.spans || [o]).map((s) => s.segment).filter((i) => Number.isInteger(i)))].sort((a, b) => a - b);
        if (!indexen.length || indexen.some((i) => i >= segmenten.length)) continue;
        const sleutel = `${r.id}|${indexen.join(',')}`;
        const v = groepen.get(sleutel) || {
          aflevering: r.id, titel: r.titel, url: r.url, soort: r.soort,
          gepubliceerd: r.gepubliceerd_op ? new Date(r.gepubliceerd_op * 1000).toISOString() : null,
          segment: indexen[0], start: o.start ?? segmenten[indexen[0]].start ?? 0,
          tekst: indexen.map((i) => segmenten[i].text || '').join(' ').trim(), aantal: 0,
        };
        v.aantal++;
        v.start = Math.min(v.start, o.start ?? v.start);
        groepen.set(sleutel, v);
      }
    }
  }
  const lijst = [...groepen.values()].sort((a, b) => String(b.gepubliceerd || '').localeCompare(String(a.gepubliceerd || '')) || a.start - b.start);
  return { naam: echteNaam, soort: echteSoort, soortNaam: SOORTEN[echteSoort] || 'Overig', vermeldingen: lijst };
}

// Stemmen: de profielen van de worker, met hoeveel er in ons archief van te
// horen is en welke namen er tijdens die beurten vallen.
export function stemmen(adb, profielen = [], { bron = '' } = {}) {
  const perProfiel = new Map(profielen.map((p) => [p.profile_id, p]));
  const stemmen = new Map();
  for (const af of adb.metStemmen()) {
    if (bron && af.bron !== bron) continue;
    const vanSegment = new Map();
    af.segmenten.forEach((s, i) => {
      if (!s.speaker_id) return;
      vanSegment.set(i, s.speaker_id);
      const st = stemmen.get(s.speaker_id) || { profiel: s.speaker_id, opgeslagenNaam: s.speaker || 'Onbekende stem', beurten: 0, seconden: 0, afleveringen: new Set(), eerste: null, namen: new Map() };
      st.beurten++;
      st.seconden += Math.max(0, (Number(s.end) || 0) - (Number(s.start) || 0));
      st.afleveringen.add(af.id);
      st.eerste ||= { aflevering: af.id, titel: af.titel, start: s.start };
      stemmen.set(s.speaker_id, st);
    });
    for (const e of af.entiteiten || []) {
      for (const o of e.occurrences || []) {
        for (const id of new Set((o.spans || [o]).map((s) => vanSegment.get(s.segment)).filter(Boolean))) {
          const n = stemmen.get(id).namen;
          const k = `${e.name}|${e.type}`;
          n.set(k, { naam: e.name, soort: e.type, aantal: (n.get(k)?.aantal || 0) + 1 });
        }
      }
    }
  }
  return [...stemmen.values()].map((st) => {
    const p = perProfiel.get(st.profiel) || {};
    return {
      profiel: st.profiel,
      naam: p.name || '',
      weergave: p.display_name || st.opgeslagenNaam,
      fragment: p.sample_available !== false,
      beurten: st.beurten,
      seconden: Math.round(st.seconden),
      afleveringen: st.afleveringen.size,
      eerste: st.eerste,
      namen: [...st.namen.values()].sort((a, b) => b.aantal - a.aantal || a.naam.localeCompare(b.naam, 'nl')).slice(0, 12),
    };
  }).sort((a, b) => Number(!a.naam) - Number(!b.naam) || b.beurten - a.beurten || a.weergave.localeCompare(b.weergave, 'nl'));
}

// Telefoonnummers met hun vermeldingen, bevestigd bedrijf, handmatige
// beoordeling en de duiding door de worker.
export function telefoonnummers(adb, { bron = '' } = {}) {
  const db = adb.db;
  const rijen = db.prepare(`SELECT v.*, a.titel, a.url, a.soort, a.bron, a.gepubliceerd_op, b.bedrijf, b.kvk, b.locatie, b.bron_url, b.bron_label, b.gecontroleerd
    FROM telefoon_vermeldingen v JOIN afleveringen a ON a.id = v.aflevering
    LEFT JOIN telefoon_verificaties b ON b.nummer = v.nummer
    ${bron ? 'WHERE a.bron = ?' : ''} ORDER BY v.nummer, a.gepubliceerd_op DESC, v.segment`).all(...(bron ? [bron] : []));
  const koppelingen = new Map(db.prepare('SELECT * FROM telefoon_koppelingen').all().map((k) => [k.nummer, k]));
  const duidingen = new Map();
  for (const d of db.prepare("SELECT * FROM telefoon_context WHERE status = 'klaar' ORDER BY zekerheid DESC, geanalyseerd DESC").all()) {
    if (!duidingen.has(d.nummer)) duidingen.set(d.nummer, []);
    duidingen.get(d.nummer).push({ aflevering: d.aflevering, segment: d.segment, soort: d.soort, relatie: d.relatie, label: d.label, omschrijving: d.omschrijving, zekerheid: d.zekerheid, bewijs: d.bewijs });
  }
  const bezig = new Set(db.prepare("SELECT DISTINCT nummer FROM telefoon_context WHERE status IN ('wacht', 'bezig')").all().map((r) => r.nummer));
  const nummers = new Map();
  for (const r of rijen) {
    const n = nummers.get(r.nummer) || {
      nummer: r.nummer, weergave: r.weergave, categorie: r.categorie,
      bedrijf: r.bedrijf ? { naam: r.bedrijf, kvk: r.kvk, locatie: r.locatie, bronUrl: r.bron_url, bronLabel: r.bron_label, gecontroleerd: r.gecontroleerd } : null,
      gebied: r.bedrijf ? null : netgebied(r.nummer),
      koppeling: koppelingen.get(r.nummer) || null,
      duidingen: duidingen.get(r.nummer) || [],
      duidingBezig: bezig.has(r.nummer),
      afleveringen: [],
      vermeldingen: 0,
    };
    let af = n.afleveringen.find((x) => x.id === r.aflevering);
    if (!af) {
      af = { id: r.aflevering, titel: r.titel, url: r.url, soort: r.soort, gepubliceerd: r.gepubliceerd_op ? new Date(r.gepubliceerd_op * 1000).toISOString() : null, vermeldingen: [] };
      n.afleveringen.push(af);
    }
    af.vermeldingen.push({ segment: r.segment, start: r.start, tijd: tijdcode(r.start), context: r.context, ruw: r.ruw });
    n.vermeldingen++;
    nummers.set(r.nummer, n);
  }
  return [...nummers.values()].sort((a, b) => Number(!a.bedrijf) - Number(!b.bedrijf)
    || Number(a.koppeling?.staat !== 'bevestigd') - Number(b.koppeling?.staat !== 'bevestigd')
    || b.vermeldingen - a.vermeldingen || a.nummer.localeCompare(b.nummer));
}

// Een nummer handmatig beoordelen: bevestigen (met naam of omschrijving),
// afwijzen, of de beoordeling weghalen.
export function zetKoppeling(adb, nummer, invoer) {
  if (!adb.db.prepare('SELECT 1 FROM telefoon_vermeldingen WHERE nummer = ? LIMIT 1').get(nummer)) throw Object.assign(new Error('Telefoonnummer niet gevonden.'), { status: 404 });
  const staat = String(invoer.staat || '').toLowerCase();
  if (staat === 'wis') {
    adb.db.prepare('DELETE FROM telefoon_koppelingen WHERE nummer = ?').run(nummer);
    return null;
  }
  if (!['bevestigd', 'afgewezen'].includes(staat)) throw Object.assign(new Error('Onbekende beoordeling.'), { status: 400 });
  let velden = { soort: null, relatie: null, label: null, omschrijving: null, bewijs: null, aflevering: null, segment: null };
  if (staat === 'bevestigd') {
    const soort = String(invoer.soort || '').trim();
    const relatie = String(invoer.relatie || 'unclear').trim();
    const label = String(invoer.label || '').split(/\s+/).join(' ').trim().slice(0, 160);
    const omschrijving = String(invoer.omschrijving || '').split(/\s+/).join(' ').trim().slice(0, 300);
    if (!NUMMERSOORTEN.has(soort) || soort === 'unknown') throw Object.assign(new Error('Kies wat voor nummer het is.'), { status: 400 });
    if (!RELATIES.has(relatie)) throw Object.assign(new Error('Kies de relatie tot het nummer.'), { status: 400 });
    if (['person', 'organization'].includes(soort) && !label) throw Object.assign(new Error('Een persoon of organisatie heeft een naam nodig.'), { status: 400 });
    if (!label && !omschrijving) throw Object.assign(new Error('Vul een naam of korte omschrijving in.'), { status: 400 });
    velden = { ...velden, soort, relatie, label, omschrijving };
    if (invoer.aflevering && Number.isInteger(invoer.segment)) {
      const d = adb.db.prepare("SELECT bewijs FROM telefoon_context WHERE nummer = ? AND aflevering = ? AND segment = ? AND status = 'klaar'").get(nummer, invoer.aflevering, invoer.segment);
      if (d) Object.assign(velden, { bewijs: d.bewijs, aflevering: invoer.aflevering, segment: invoer.segment });
    }
  }
  adb.db.prepare(`INSERT INTO telefoon_koppelingen (nummer, staat, soort, relatie, label, omschrijving, zekerheid, bewijs, aflevering, segment, bron, beoordeeld)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'handmatig', ?) ON CONFLICT(nummer) DO UPDATE SET staat = excluded.staat, soort = excluded.soort,
    relatie = excluded.relatie, label = excluded.label, omschrijving = excluded.omschrijving, zekerheid = excluded.zekerheid, bewijs = excluded.bewijs,
    aflevering = excluded.aflevering, segment = excluded.segment, bron = excluded.bron, beoordeeld = excluded.beoordeeld`)
    .run(nummer, staat, velden.soort, velden.relatie, velden.label, velden.omschrijving, staat === 'bevestigd' ? 100 : null, velden.bewijs, velden.aflevering, velden.segment, Date.now() / 1000);
  return adb.db.prepare('SELECT * FROM telefoon_koppelingen WHERE nummer = ?').get(nummer);
}

// Het transcript als tekstbestand: titel, adres, namen, en per segment tijd en spreker.
export function transcriptTekst(af) {
  const namen = (af.entiteiten || []).map((e) => `${e.name} (${SOORTEN[e.type] || 'overig'}, ${e.count}×)`).join('\n');
  const regels = af.segmenten.some((s) => s.speaker)
    ? af.segmenten.map((s) => `[${tijdcode(s.start)}]${s.speaker ? ` ${s.speaker}:` : ''} ${s.text || ''}`).join('\n')
    : af.transcript;
  return `${af.titel}\n${af.url}\n\nGENOEMDE NAMEN\n${namen || '(nog niet bekend)'}\n\nVOLLEDIG TRANSCRIPT\n\n${regels}\n`;
}
