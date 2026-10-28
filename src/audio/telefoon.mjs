// Telefoonnummers in transcripten: geschreven ("06-12345678") en uitgesproken
// ("nul zes één twee …", alleen met een aanwijzing als "bel" of "nummer" in de
// buurt, anders is het gewoon een opsomming). IBAN's tellen niet mee.
//
// Wie er achter een nummer zit, komt uit drie bronnen:
//   - een vaste lijst openbaar gecontroleerde bedrijfsnummers (nummerlijst.json);
//   - een handmatige koppeling door een journalist (bevestigd of afgewezen);
//   - een duiding door het taalmodel van de worker op basis van de context in
//     het transcript (alleen een suggestie, met letterlijk bewijs).
// Audioscraper zocht daarnaast via zoekmachines naar bedrijfspagina's; dat doet
// de Regiochecker niet (zoekmachines staan zulk automatisch zoeken niet toe).

import { readFileSync } from 'node:fs';
import { netgebied } from './netnummers.mjs';

const WOORDEN = { nul: '0', een: '1', één: '1', twee: '2', drie: '3', vier: '4', vijf: '5', zes: '6', zeven: '7', acht: '8', negen: '9' };
const WOORD = /(?<![\p{L}\p{N}_])(?:nul|een|één|twee|drie|vier|vijf|zes|zeven|acht|negen)(?![\p{L}\p{N}_])/giu;
const CIJFERS = /(?<![\p{L}\p{N}_])(?:\+31[\s().-]*|0031[\s().-]*|0)(?:[\s().-]*\d){7,11}(?![\p{L}\p{N}_])/gu;
const IBAN = /(?<![\p{L}\p{N}_])NL[\s.,:-]*\d{2}[\s.,:-]*[A-Z]{4}(?:[\s.,:-]*\d){10}(?![\p{L}\p{N}_])/giu;
export const SCANVERSIE = 5;

export function normaliseerNummer(ruw) {
  let cijfers = String(ruw).replace(/\D/g, '');
  const compact = String(ruw).replace(/\s+/g, '');
  if (compact.startsWith('+31')) cijfers = `0${cijfers.slice(2)}`;
  else if (compact.startsWith('0031')) cijfers = `0${cijfers.slice(4)}`;
  if (!cijfers.startsWith('0')) return '';
  if (cijfers.startsWith('06') || cijfers.startsWith('088')) return cijfers.length === 10 ? cijfers : '';
  if (/^(0800|0900|0906|0909)/.test(cijfers)) return cijfers.length >= 8 && cijfers.length <= 11 ? cijfers : '';
  if (cijfers.length !== 10 || !netgebied(cijfers)) return '';
  return cijfers;
}

export function categorie(n) {
  if (n.startsWith('06')) return 'Mobiel nummer';
  if (n.startsWith('0800')) return 'Gratis servicenummer';
  if (/^(0900|0906|0909)/.test(n)) return 'Betaald servicenummer';
  if (n.startsWith('088')) return 'Bedrijfsnummer';
  return 'Telefoonnummer';
}

export function weergave(n) {
  if (n.startsWith('06') && n.length === 10) return `${n.slice(0, 2)} ${n.slice(2, 6)} ${n.slice(6)}`;
  if (n.startsWith('088') && n.length === 10) return `${n.slice(0, 3)} ${n.slice(3, 7)} ${n.slice(7)}`;
  if (n.length === 10) return `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  return n;
}

export function vindNummers(segmenten) {
  const uit = [];
  const geheel = segmenten.map((s) => s.text || '').join(' ');
  const ibans = [...geheel.matchAll(IBAN)].map((m) => [m.index, m.index + m[0].length]);
  let positie = 0;
  segmenten.forEach((segment, index) => {
    const tekst = segment.text || '';
    const offset = positie;
    positie += tekst.length + 1;
    const kandidaten = [...tekst.matchAll(CIJFERS)].map((m) => [m.index, m.index + m[0].length, m[0]]);
    // Uitgesproken cijfers: reeksen woorden met hooguit vier tekens ertussen.
    const reeksen = [];
    let reeks = [];
    for (const w of tekst.matchAll(WOORD)) {
      if (reeks.length && w.index - (reeks.at(-1).index + reeks.at(-1)[0].length) > 4) {
        reeksen.push(reeks);
        reeks = [];
      }
      reeks.push(w);
    }
    if (reeks.length) reeksen.push(reeks);
    for (const r of reeksen) {
      if (r.length < 8 || r.length > 11) continue;
      const begin = r[0].index;
      const eind = r.at(-1).index + r.at(-1)[0].length;
      const omgeving = tekst.slice(Math.max(0, begin - 80), Math.min(tekst.length, eind + 80)).toLowerCase();
      if (/nummer|telefoon|bel|bereikbaar/.test(omgeving)) kandidaten.push([begin, eind, tekst.slice(begin, eind)]);
    }
    const gezien = new Set();
    for (const [begin, eind, ruw] of kandidaten) {
      if (ibans.some(([b, e]) => offset + begin < e && offset + eind > b)) continue;
      const nummer = normaliseerNummer(/\d/.test(ruw) ? ruw : [...ruw.matchAll(WOORD)].map((w) => WOORDEN[w[0].toLowerCase()]).join(''));
      if (!nummer || gezien.has(nummer)) continue;
      gezien.add(nummer);
      uit.push({
        nummer, segment: index, start: Number(segment.start) || 0, ruw,
        weergave: weergave(nummer), categorie: categorie(nummer),
        context: tekst.slice(Math.max(0, begin - 105), Math.min(tekst.length, eind + 145)).replace(/\s+/g, ' ').trim(),
      });
    }
  });
  return uit;
}

// De vaste lijst openbaar gecontroleerde bedrijfsnummers.
export function nummerlijst() {
  const lijst = JSON.parse(readFileSync(new URL('./nummerlijst.json', import.meta.url), 'utf8'));
  return Object.entries(lijst).map(([nummer, v]) => ({
    nummer, bedrijf: v.company, kvk: v.kvk_number, locatie: v.location, bronUrl: v.source_url, bronLabel: v.source_label, gecontroleerd: v.verified,
  }));
}

// ---------- duiding door de worker ----------

export const SOORTEN = new Set(['person', 'organization', 'service', 'private_contact', 'own_number', 'invalid', 'unknown']);
export const RELATIES = new Set(['called_target', 'submitted_target', 'caller_own_number', 'third_party_reference', 'invalid_number', 'unclear']);

const tijd = (s) => {
  const t = Math.max(0, Math.floor(Number(s) || 0));
  const u = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  return `${u ? `${String(u).padStart(2, '0')}:` : ''}${String(m).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

// Een begrensd venster rond het segment met het nummer; het nummer zelf wordt
// gemaskeerd, zodat het model het niet kan "herkennen" maar moet afleiden.
export function contextVenster(segmenten, doel, ruw = '', { voor = 8, na = 12, max = 5000 } = {}) {
  if (doel < 0 || doel >= segmenten.length) throw new Error('Transcriptsegment voor nummeranalyse bestaat niet meer.');
  const eerste = Math.max(0, doel - voor);
  const laatste = Math.min(segmenten.length, doel + na + 1);
  const regels = [];
  for (let i = eerste; i < laatste; i++) {
    const s = segmenten[i];
    let tekst = String(s.text || '').replace(/\s+/g, ' ').trim();
    let merk = 'CONTEXT';
    if (i === doel) {
      if (ruw) tekst = tekst.replace(new RegExp(ruw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '[DOELNUMMER]');
      if (!tekst.includes('[DOELNUMMER]')) tekst = `[DOELNUMMER] ${tekst}`;
      merk = 'DOELSEGMENT';
    }
    regels.push(`[${merk} ${i} · ${tijd(s.start)}${s.speaker ? ` · ${s.speaker}` : ''}] ${tekst}`);
  }
  let geheel = regels.join('\n');
  if (geheel.length > max) {
    const plek = geheel.indexOf('[DOELSEGMENT');
    let begin = Math.max(0, plek - Math.floor(max / 2));
    const eind = Math.min(geheel.length, begin + max);
    begin = Math.max(0, eind - max);
    geheel = geheel.slice(begin, eind);
  }
  return { tekst: geheel, eerste, laatste };
}

export function namenInBuurt(entiteiten, eerste, laatste) {
  const uit = [];
  const gezien = new Set();
  for (const e of entiteiten || []) {
    const raakt = (e.occurrences || []).some((o) => (o.spans || [o]).some((s) => s.segment >= eerste && s.segment < laatste));
    const sleutel = `${String(e.name).toLowerCase()}|${e.type}`;
    if (raakt && e.name && !gezien.has(sleutel)) {
      uit.push({ name: e.name, type: e.type });
      gezien.add(sleutel);
    }
  }
  return uit.slice(0, 80);
}

// Het antwoord van de worker controleren: bekende soorten, en bewijs en naam
// moeten letterlijk in de tekst staan. Anders is het geen bruikbare duiding.
export function controleerDuiding(r, tekst) {
  if (!r || typeof r !== 'object') throw new Error('Worker gaf geen geldige nummeranalyse terug.');
  const soort = String(r.subject_type || '');
  const relatie = String(r.relation || '');
  const label = String(r.label || '').split(/\s+/).join(' ').trim().replace(/^[ .,;:-]+|[ .,;:-]+$/g, '').slice(0, 160);
  const omschrijving = String(r.description || '').split(/\s+/).join(' ').trim().slice(0, 300);
  const bewijs = String(r.evidence || '').split(/\s+/).join(' ').trim().slice(0, 600);
  const zekerheid = Math.max(0, Math.min(100, Math.round(Number(r.confidence))));
  if (!Number.isFinite(zekerheid)) throw new Error('Worker gaf geen geldige betrouwbaarheid terug.');
  if (!SOORTEN.has(soort) || !RELATIES.has(relatie)) throw new Error('Worker gaf een onbekende nummerclassificatie terug.');
  const plat = tekst.split(/\s+/).join(' ').toLowerCase();
  if (bewijs && !plat.includes(bewijs.toLowerCase())) throw new Error('Bewijsfragment staat niet letterlijk in het transcript.');
  if (label && !new RegExp(`(?<![\\p{L}\\p{N}_])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'iu').test(tekst)) {
    throw new Error('Voorgestelde naam staat niet letterlijk in het transcript.');
  }
  if ((soort === 'person' || soort === 'organization') && !label) throw new Error('Een persoons- of organisatiekandidaat mist een letterlijke naam.');
  return { soort, relatie, label, omschrijving, zekerheid, bewijs, model: String(r.model || '').slice(0, 160) || null };
}
