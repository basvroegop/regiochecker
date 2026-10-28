// Namen in transcripten (entiteiten): personen, organisaties, locaties,
// producten/werken, evenementen en overige. De worker vindt ze met een lokaal
// taalmodel, per deel van het transcript; hier zoeken we elke naam letterlijk
// terug in het transcript, met de plekken (segment en tijd) waar hij valt.
// Locaties krijgen een indeling (provincie, land, werelddeel) uit een vaste
// index op basis van GeoNames en Unicode CLDR (locaties.json), zonder geocoder.

import { readFileSync } from 'node:fs';

export const SOORTEN = { person: 'Persoon', organization: 'Organisatie', location: 'Locatie', product: 'Product of werk', event: 'Evenement', other: 'Overig' };

// Overlappende delen van het transcript voor de worker; de overlap zorgt dat
// een naam op de grens van twee delen toch gevonden wordt.
export function delen(tekst, grootte = 6500, overlap = 350) {
  const uit = [];
  let begin = 0;
  while (begin < tekst.length) {
    let eind = Math.min(begin + grootte, tekst.length);
    if (eind < tekst.length) {
      // Net als in audioscraper: de laatste spatie in de tweede helft van het deel.
      const grens = tekst.lastIndexOf(' ', eind - 1);
      if (grens >= begin + Math.floor(grootte / 2) && grens > begin) eind = grens;
    }
    uit.push(tekst.slice(begin, eind));
    if (eind === tekst.length) break;
    begin = Math.max(begin + 1, eind - overlap);
  }
  return uit;
}

// Kleinere stukken zonder overlap, voor als de worker een deel niet aankan.
export function splits(tekst, doel = 1600) {
  const uit = [];
  let begin = 0;
  while (begin < tekst.length) {
    let eind = Math.min(tekst.length, begin + doel);
    if (eind < tekst.length) {
      const grens = tekst.lastIndexOf(' ', eind - 1);
      if (grens >= begin + Math.floor(doel / 2) && grens > begin) eind = grens;
    }
    uit.push(tekst.slice(begin, eind));
    begin = eind;
  }
  return uit.filter((d) => d.trim());
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Elke kandidaat letterlijk terugzoeken in één doorlopende tijdlijn, zodat een
// naam die over twee segmenten valt toch één keer telt.
export function plaatsNamen(kandidaten, segmenten) {
  const starts = [];
  let positie = 0;
  for (const s of segmenten) {
    starts.push(positie);
    positie += (s.text || '').length + 1;
  }
  const tekst = segmenten.map((s) => s.text || '').join(' ');
  const zoekSegment = (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  const namen = new Map();
  for (const k of kandidaten) {
    if (!k || typeof k !== 'object') continue;
    const naam = String(k.name || '').trim();
    const soort = k.type || 'other';
    if (!naam || naam.length > 200 || !SOORTEN[soort]) continue;
    const sleutel = naam.toLowerCase();
    if (namen.has(sleutel)) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escape(naam)}(?![\\p{L}\\p{N}_])`, 'giu');
    const plekken = [];
    for (const m of tekst.matchAll(re)) {
      const i = zoekSegment(m.index);
      const spans = [];
      for (let j = i; j < segmenten.length && starts[j] < m.index + m[0].length; j++) {
        spans.push({ segment: j, offset: Math.max(0, m.index - starts[j]), end_offset: Math.min((segmenten[j].text || '').length, m.index + m[0].length - starts[j]) });
      }
      plekken.push({ ...spans[0], start: segmenten[i].start ?? 0, spans });
    }
    if (plekken.length) namen.set(sleutel, { name: naam, type: soort, count: plekken.length, occurrences: plekken });
  }
  return [...namen.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'nl'));
}

// ---------- locaties ----------

const WERELDDELEN = { EU: 'Europa', AF: 'Afrika', AS: 'Azië', NA: 'Noord-Amerika', SA: 'Zuid-Amerika', OC: 'Oceanië', AN: 'Antarctica' };
const NOORDEN = new Set(['Groningen', 'Friesland', 'Drenthe']);
let index = null;
const geheugen = new Map();

const sleutel = (s) => String(s).toLowerCase().split(/\s+/).join(' ').replace(/^[ .,:;()[\]]+|[ .,:;()[\]]+$/g, '');

export function deelLocatieIn(naam) {
  if (geheugen.has(naam)) return geheugen.get(naam);
  index ||= JSON.parse(readFileSync(new URL('./locaties.json', import.meta.url), 'utf8'));
  let treffer = index.places[sleutel(naam)];
  if (!treffer) {
    // Soms staat er "gemeente" voor of een wijk achter: alleen een duidelijke
    // woordgroep binnen de naam gebruiken, en de langste bekende plaats.
    const woorden = sleutel(naam).replace(/^(?:de |het )?(?:gemeente |provincie )/, '').replaceAll('-', ' ').split(' ');
    const kandidaten = [];
    for (let grootte = Math.min(4, woorden.length); grootte > 0 && !kandidaten.length; grootte--) {
      for (let b = 0; b + grootte <= woorden.length; b++) {
        const deel = woorden.slice(b, b + grootte).join(' ');
        const gevonden = index.places[deel];
        if (gevonden && (grootte > 1 || deel.length >= 5)) kandidaten.push([grootte, deel.length, gevonden]);
      }
    }
    treffer = kandidaten.sort((a, b) => b[0] - a[0] || b[1] - a[1])[0]?.[2];
  }
  let uit = null;
  if (treffer) {
    const [werelddeel, land, provincie] = treffer;
    uit = {
      werelddeelCode: werelddeel, werelddeel: WERELDDELEN[werelddeel] || werelddeel,
      landCode: land, land: index.countries[land]?.name || '', provincie: provincie || '',
      noorden: NOORDEN.has(provincie),
    };
  }
  if (geheugen.size > 20000) geheugen.clear();
  geheugen.set(naam, uit);
  return uit;
}

export const GEBIEDEN = {
  nl: 'Nederland', noorden: 'Noord-Nederland', Groningen: 'Provincie Groningen', Friesland: 'Provincie Friesland', Drenthe: 'Provincie Drenthe',
  europa: 'Europa', 'buiten-europa': 'Buiten Europa', onbekend: 'Niet ingedeeld',
};

export function inGebied(g, gebied) {
  if (!gebied) return true;
  if (!g) return gebied === 'onbekend';
  if (gebied === 'nl') return g.landCode === 'NL';
  if (gebied === 'noorden') return g.noorden;
  if (NOORDEN.has(gebied)) return g.provincie === gebied;
  if (gebied === 'europa') return g.werelddeelCode === 'EU';
  if (gebied === 'buiten-europa') return g.werelddeelCode !== 'EU';
  return false;
}
