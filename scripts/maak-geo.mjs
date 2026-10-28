// Maakt src/geo/nl.json: de gemeenten van Nederland (grens, vereenvoudigd tot
// zo'n 100 meter, en provincie) en alle woonplaatsen met hun gemeente. Eén keer
// per jaar opnieuw draaien, als gemeenten zijn samengegaan:
//
//   node scripts/maak-geo.mjs
//
// Bronnen (open data, CC BY 4.0):
//   gemeentegrenzen  Kadaster, Bestuurlijke Gebieden (PDOK)
//   woonplaatsen     CBS, Woonplaatsen in Nederland (tabel 86312NED, 2026)

import { writeFileSync } from 'node:fs';

const PDOK = 'https://service.pdok.nl/kadaster/bestuurlijkegebieden/wfs/v1_0';
const CBS = 'https://opendata.cbs.nl/ODataApi/odata/86312NED';
const TOLERANTIE = 0.001; // graden; ongeveer 70 tot 110 meter

async function json(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Regiochecker/1.0 (geo)' }, signal: AbortSignal.timeout(300_000) });
  if (!r.ok) throw new Error(`${url} gaf HTTP ${r.status}`);
  return r.json();
}

// Douglas-Peucker op één ring. Een ring is gesloten (eerste punt = laatste),
// dus eerst splitsen bij het punt dat het verst van het begin ligt.
function vereenvoudig(ring, tol) {
  if (ring.length < 5) return ring;
  let ver = 1;
  for (let i = 1; i < ring.length - 1; i++) {
    if (Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]) > Math.hypot(ring[ver][0] - ring[0][0], ring[ver][1] - ring[0][1])) ver = i;
  }
  const uit = [...lijn(ring.slice(0, ver + 1), tol), ...lijn(ring.slice(ver), tol).slice(1)];
  return uit.length >= 4 ? uit : ring;
}

function lijn(ring, tol) {
  if (ring.length < 3) return ring;
  const houd = new Uint8Array(ring.length);
  houd[0] = 1;
  houd[ring.length - 1] = 1;
  const stapel = [[0, ring.length - 1]];
  while (stapel.length) {
    const [a, b] = stapel.pop();
    const [x1, y1] = ring[a];
    const [x2, y2] = ring[b];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1e-12;
    let verst = -1;
    let index = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * ring[i][0] - dx * ring[i][1] + x2 * y1 - y2 * x1) / len;
      if (d > verst) { verst = d; index = i; }
    }
    if (verst > tol) {
      houd[index] = 1;
      stapel.push([a, index], [index, b]);
    }
  }
  return ring.filter((_, i) => houd[i]);
}

const rond = (p) => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];

const gemeenten = {};
for (let start = 0; ; start += 200) {
  const d = await json(`${PDOK}?service=WFS&version=2.0.0&request=GetFeature&typeNames=bestuurlijkegebieden:Gemeentegebied&outputFormat=application/json&srsName=EPSG:4326&count=200&startIndex=${start}`);
  for (const f of d.features) {
    const p = f.properties;
    const vlakken = (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates)
      .map((ringen) => ringen.map((r) => vereenvoudig(r, TOLERANTIE).map(rond)));
    const alle = vlakken.flat(2);
    const bbox = [Math.min(...alle.map((q) => q[0])), Math.min(...alle.map((q) => q[1])), Math.max(...alle.map((q) => q[0])), Math.max(...alle.map((q) => q[1]))];
    gemeenten[p.naam] = { code: `GM${p.code}`, provincie: p.ligtInProvincieNaam, bbox, vlakken };
  }
  if (d.features.length < 200) break;
}

// Het CBS schrijft "Bergen (L.)", PDOK "Bergen (L)": koppelen zonder punten.
const zonderPunt = (naam) => naam.replace(/\./g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const pdokNaam = new Map(Object.keys(gemeenten).map((g) => [zonderPunt(g), g]));
const namen = new Map((await json(`${CBS}/Woonplaatsen?$format=json`)).value.map((w) => [w.Key.trim(), w.Title.trim()]));
const woonplaatsen = {};
let volgende = `${CBS}/TypedDataSet?$format=json`;
while (volgende) {
  const d = await json(volgende);
  for (const r of d.value) {
    const plaats = namen.get(String(r.Woonplaatsen).trim());
    const cbs = String(r.Naam_2 || '').trim();
    const gemeente = pdokNaam.get(zonderPunt(cbs)) || pdokNaam.get(zonderPunt(cbs.replace(/\s*\(.*\)$/, ''))) || cbs;
    if (!plaats || !gemeente) continue;
    // BAG onderscheidt dubbele namen met een toevoeging ("Haren Gn",
    // "Hengelo (Gld)"); in een tekst staat gewoon "Haren". Beide opnemen.
    const kaal = plaats.replace(/\s(?:\([A-Za-z.]{1,5}\)|[A-Z][a-z]?|[A-Z]{2,3})$/, '');
    for (const naam of new Set([plaats, kaal])) woonplaatsen[naam] = [...new Set([...(woonplaatsen[naam] || []), gemeente])];
  }
  volgende = d['odata.nextLink'] || null;
}

const zonderGrens = [...new Set(Object.values(woonplaatsen).flat())].filter((g) => !gemeenten[g]);
if (zonderGrens.length) console.warn('Gemeenten uit het CBS zonder grens bij PDOK:', zonderGrens.join(', '));
writeFileSync(new URL('../src/geo/nl.json', import.meta.url), JSON.stringify({ bron: 'Kadaster Bestuurlijke Gebieden (PDOK) en CBS Woonplaatsen in Nederland 2026, CC BY 4.0', gemaakt: new Date().toISOString().slice(0, 10), gemeenten, woonplaatsen }));
console.log(`${Object.keys(gemeenten).length} gemeenten, ${Object.keys(woonplaatsen).length} woonplaatsen`);
