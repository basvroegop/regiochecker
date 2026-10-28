// Waar ligt iets? Voor landelijke bronnen die zelf een plek meegeven: een
// aardbeving (coördinaat), een weerwaarschuwing (provincie), of een tekst met
// plaatsnamen ("gevestigd in Drachten", "de raad van de gemeente Opsterland").
// Een regio heet naar een gemeente; via src/geo/nl.json (gemeentegrenzen van
// het Kadaster en de woonplaatsen van het CBS, zie scripts/maak-geo.mjs) weten
// we welke plekken daarin liggen.

import { readFileSync } from 'node:fs';

let data = null;
let perNaam = null;
let plaatsen = null;
function laad() {
  if (data) return data;
  data = JSON.parse(readFileSync(new URL('./geo/nl.json', import.meta.url), 'utf8'));
  perNaam = new Map(Object.entries(data.gemeenten).map(([naam, g]) => [sleutel(naam), { naam, ...g }]));
  // Plaatsnamen, en ook de namen van de gemeenten zelf ("gemeente Opsterland").
  plaatsen = new Map(Object.entries(data.woonplaatsen));
  for (const naam of Object.keys(data.gemeenten)) {
    const kaal = naam.replace(/\s*\(.*\)$/, '');
    plaatsen.set(kaal, [...new Set([...(plaatsen.get(kaal) || []), naam])]);
  }
  return data;
}

const sleutel = (naam) => String(naam || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// De KNMI zegt Friesland, het Kadaster Fryslân.
const PROVINCIE = { friesland: 'Fryslân', fryslan: 'Fryslân' };
export const provincieNaam = (naam) => PROVINCIE[sleutel(naam)] || String(naam || '').trim();

// De gemeente met deze naam (een regio heet zo), of null.
export function gemeente(naam) {
  laad();
  return perNaam.get(sleutel(naam)) || null;
}

// Punt in veelhoek (even-oneven), met gaten.
function inRing([x, y], ring) {
  let binnen = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) binnen = !binnen;
  }
  return binnen;
}

const inGemeente = (punt, g) => g.vlakken.some(([buiten, ...gaten]) => inRing(punt, buiten) && !gaten.some((gat) => inRing(punt, gat)));

// Afstand in km van een punt { lat, lon } tot een gemeente: 0 als het erin ligt.
export function afstandKm({ lat, lon }, g) {
  const punt = [lon, lat];
  if (inGemeente(punt, g)) return 0;
  // Plat genoeg voor Nederland: lengtegraden korter maken met cos(breedte).
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  const ky = 110.57;
  let kleinst = Infinity;
  for (const vlak of g.vlakken) {
    for (const ring of vlak) {
      for (let i = 1; i < ring.length; i++) {
        const ax = (ring[i - 1][0] - lon) * kx;
        const ay = (ring[i - 1][1] - lat) * ky;
        const bx = (ring[i][0] - lon) * kx;
        const by = (ring[i][1] - lat) * ky;
        const dx = bx - ax;
        const dy = by - ay;
        const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
        kleinst = Math.min(kleinst, Math.hypot(ax + t * dx, ay + t * dy));
      }
    }
  }
  return kleinst;
}

// Een plaatsnaam telt alleen met een woord ervoor dat op een plek wijst ("in
// Sneek", "gemeente Ooststellingwerf", "based in Joure", "burgemeester en
// wethouders van Opsterland"). Zonder die eis ging "treinverkeer tussen
// Groningen en Amsterdam" naar de regio Groningen. Plaatsnamen die ook gewone
// woorden of achternamen zijn ("Een", "Best", "Vries") tellen nooit.
const STOP = new Set(['Een', 'Heel', 'Best', 'Born', 'Echt', 'Mill', 'Hall', 'Well', 'Enter', 'Ens', 'Amen', 'Boer', 'Broek', 'Hoek', 'Heide',
  'Horn', 'Hoorn', 'Made', 'Lent', 'Loon', 'Neer', 'Nes', 'Leek', 'Spier', 'Waal', 'Wier', 'Veen', 'Lies', 'Linde', 'Erica', 'Joppe', 'Grave',
  'Goes', 'Hem', 'Hee', 'Ie', 'Ane', 'Vries', 'Horst', 'Graft', 'Haren', 'Buren', 'Laren', 'Hulst', 'Delft', 'Leur', 'Riel', 'Rien', 'Ried',
  'Reek', 'Elim', 'Eys', 'Est', 'Erp', 'Erm', 'Ell', 'Yde', 'Rha', 'Bant', 'Baak', 'Beers', 'Bears', 'Thorn', 'Stein', 'Lith', 'Linne',
  'Heino', 'Doorn', 'Dorst', 'Esch', 'Gees', 'Groet', 'Kaag', 'Nisse', 'Olst', 'Rijs', 'Sluis', 'Spui', 'Tuil', 'Winde', 'Zegge', 'Zuna']);
const AANWIJZERS = new Set(['in', 'te', 'uit', 'bij', 'nabij', 'rond', 'naar', 'vanuit', 'gemeente', 'dorp', 'stad', 'regio', 'omgeving', 'near', 'from', 'based', 'located', 'of']);
const TUSSEN = new Set(['a/d', 'aan', 'de', 'den', 'der', 'op', 'bij', 'ter', 'en']);
const hoofdletter = (w) => /^\p{Lu}/u.test(w);

// Welke plaatsen staan in deze tekst, en in welke gemeenten liggen ze?
// Geeft [{ plaats, gemeenten }].
export function plaatsenIn(tekst) {
  laad();
  const woorden = [...String(tekst || '').matchAll(/[\p{L}\p{N}'’/.-]+/gu)].map((m) => m[0].replace(/^[.'’-]+|[.,'’-]+$/g, ''));
  const uit = new Map();
  for (let i = 0; i < woorden.length; i++) {
    if (!hoofdletter(woorden[i])) continue;
    // Langste plaatsnaam eerst: "Ten Boer" voor "Boer", "Nij Beets" voor "Beets".
    for (let n = 4; n >= 1; n--) {
      const deel = woorden.slice(i, i + n);
      if (deel.length < n || !hoofdletter(deel.at(-1)) || deel.slice(1, -1).some((w) => !hoofdletter(w) && !TUSSEN.has(w))) continue;
      const naam = deel.join(' ');
      const gemeenten = plaatsen.get(naam);
      if (!gemeenten || STOP.has(naam)) continue;
      const ervoor = (woorden[i - 1] || '').toLowerCase();
      const ervoor2 = (woorden[i - 2] || '').toLowerCase();
      const aangewezen = AANWIJZERS.has(ervoor) || (ervoor === 'van' && ['wethouders', 'raad', 'college', 'staten'].includes(ervoor2));
      if (!aangewezen) continue;
      uit.set(naam, gemeenten);
      i += n - 1;
      break;
    }
  }
  return [...uit].map(([plaats, gemeenten]) => ({ plaats, gemeenten }));
}
