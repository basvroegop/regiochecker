// Het register van regio's en bronnen, in twee lagen:
//  - ingebouwd (src/regios.mjs): de gemeenten met hun bronnen, in code, omdat
//    vrijwel elke gemeente een eigen lezer nodig heeft;
//  - via de webUI door een beheerder toegevoegd (data/regios.json en
//    data/bronnen.json): nieuwe regio's, sleutelwoorden per regio, en bronnen
//    met een standaardlezer (RSS, iBabs, Woo-platform) of audio en video
//    (raadsvergaderingen, YouTube, podcasts; verwerkt in src/audio/).
//
// Elke bron heeft een bereik: 'regio' (alles gaat naar die ene regio) of
// 'landelijk' (een stuk gaat naar elke regio waarvan een sleutelwoord erin
// voorkomt). De Tweede Kamer is de ingebouwde landelijke bron. Per regio kan
// een landelijke bron uit staan (landelijkUit).

import { REGIOS, ingebouwdeBronnen, AUDIOSOORTEN } from './regios.mjs';
import { TYPES } from './bronnen/index.mjs';

export const TWEEDE_KAMER = {
  id: 'tweede-kamer',
  naam: 'Tweede Kamer · Kamerstukken',
  label: 'Gegevensmagazijn OData · volledige tekst',
  soort: 'kamerstuk',
  bereik: 'landelijk',
  type: 'tweede-kamer',
  url: 'https://www.tweedekamer.nl/kamerstukken',
  ingebouwd: true,
};

export const isAudioBron = (b) => AUDIOSOORTEN.includes(b?.soort);

export function alleRegios(opslag) {
  const lijst = [
    ...REGIOS.map((r) => ({ id: r.id, naam: r.naam, site: r.site, eigen: false })),
    ...Object.entries(opslag.regios)
      .filter(([, r]) => r.eigen)
      .map(([id, r]) => ({ id, naam: r.naam, site: r.site || null, eigen: true })),
  ];
  return lijst
    .map((r) => {
      const extra = opslag.regios[r.id] || {};
      return { ...r, sleutelwoorden: extra.sleutelwoorden || [], landelijkUit: extra.landelijkUit || [] };
    })
    .sort((a, b) => a.naam.localeCompare(b.naam, 'nl'));
}

export const regioOpId = (opslag, id) => alleRegios(opslag).find((r) => r.id === id) || null;

export function alleBronnen(opslag) {
  return [...ingebouwdeBronnen(), TWEEDE_KAMER, ...opslag.bronnen];
}

export const bronOpId = (opslag, id) => alleBronnen(opslag).find((b) => b.id === id) || null;

export const bronnenVanRegio = (opslag, regioId) => alleBronnen(opslag).filter((b) => b.bereik === 'regio' && b.regio === regioId);

export const landelijkeBronnen = (opslag) => alleBronnen(opslag).filter((b) => b.bereik === 'landelijk');

// De bronnen die de verzamelronde afgaat: alles met een lezer in
// src/bronnen/. De Tweede Kamer en audio hebben een eigen ronde.
export const teVerzamelen = (opslag) => alleBronnen(opslag).filter((b) => TYPES[b.type]);

export const geldtVoor = (regio, bronId) => !(regio.landelijkUit || []).includes(bronId);

export const actieveTermen = (regio) => (regio.sleutelwoorden || []).filter((s) => s.actief !== false).map((s) => s.term);

// Voor een landelijke bron: per regio de sleutelwoorden die gelden. Alleen
// regio's met minstens één sleutelwoord. `regioIds` beperkt tot die regio's.
export function termenPerRegio(opslag, bronId, regioIds = null) {
  return alleRegios(opslag)
    .filter((r) => (!regioIds || regioIds.includes(r.id)) && geldtVoor(r, bronId))
    .map((r) => ({ regio: r, termen: actieveTermen(r) }))
    .filter((r) => r.termen.length);
}

// Een id voor een nieuwe regio of bron: kleine letters, zonder accenten.
export function maakId(naam, bestaand) {
  const basis = String(naam).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';
  let id = basis;
  for (let n = 2; bestaand.has(id); n++) id = `${basis}-${n}`;
  return id;
}
