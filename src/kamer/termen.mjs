// Termen herkennen in kamerstukken: plaatsnamen, gebieden, onderwerpen.
// Hoofdletters en accenten tellen niet ("Fryslân" = "fryslan"), en alleen hele
// woorden tellen: "Haren" vindt de plaats, niet "haren" binnen "tegenhoudharen".
// Een term van meer woorden ("De Peinder Mieden") moet als geheel voorkomen.
//
// Eerst zoekt SQLite (FTS5) de kandidaten, daarna controleren we hier per stuk
// met een reguliere expressie en halen we de zin rond de treffer op.

// Kleine letters, zonder accenten, en even lang als het origineel, zodat een
// positie in de genormaliseerde tekst ook een positie in het origineel is.
export function normaliseer(tekst) {
  let uit = '';
  for (let i = 0; i < tekst.length; i++) {
    const t = tekst[i].toLowerCase().normalize('NFD')[0] || tekst[i];
    uit += t;
  }
  return uit;
}

const WOORD = '\\p{L}\\p{N}';

function patroon(term) {
  const delen = normaliseer(term.trim()).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!delen.length) return null;
  const tussen = `[^${WOORD}]+`;
  const kern = delen.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(tussen);
  return new RegExp(`(?<![${WOORD}])${kern}(?![${WOORD}])`, 'gu');
}

// Lijst van termen schoonmaken: spaties weg, dubbele eruit, lege weg.
export function schoneTermen(invoer) {
  const lijst = Array.isArray(invoer) ? invoer : String(invoer || '').split(/[\n,;]+/);
  const gezien = new Set();
  const uit = [];
  for (const ruw of lijst) {
    const term = String(ruw).replace(/\s+/g, ' ').trim();
    const sleutel = normaliseer(term);
    if (term.length < 2 || term.length > 100 || gezien.has(sleutel) || !patroon(term)) continue;
    gezien.add(sleutel);
    uit.push(term);
  }
  return uit;
}

// FTS5-zoekvraag die elk van de termen als woordgroep zoekt.
export function ftsVoorTermen(termen) {
  const groepen = termen
    .map((t) => normaliseer(t).split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' '))
    .filter(Boolean)
    .map((t) => `"${t}"`);
  return groepen.join(' OR ');
}

function fragment(tekst, positie, lengte, ruimte = 160) {
  let begin = Math.max(0, positie - ruimte);
  let eind = Math.min(tekst.length, positie + lengte + ruimte);
  // Naar woordgrenzen, en binnen dezelfde alinea blijven als het kan.
  const alineaBegin = tekst.lastIndexOf('\n', positie);
  if (alineaBegin >= begin) begin = alineaBegin + 1;
  else while (begin > 0 && /\S/.test(tekst[begin - 1])) begin--;
  const alineaEind = tekst.indexOf('\n', positie + lengte);
  if (alineaEind !== -1 && alineaEind <= eind) eind = alineaEind;
  else while (eind < tekst.length && /\S/.test(tekst[eind])) eind++;
  const stuk = tekst.slice(begin, eind).replace(/\s+/g, ' ').trim();
  return {
    tekst: `${begin > 0 ? '…' : ''}${stuk}${eind < tekst.length ? '…' : ''}`,
    // Waar de treffer in het fragment staat, voor markering in mail en webUI.
    treffer: tekst.slice(positie, positie + lengte),
  };
}

// Welke van de termen komen in de tekst voor? Per term het eerste fragment en
// het aantal keer dat hij voorkomt.
export function vindTermen(tekst, termen) {
  const norm = normaliseer(tekst);
  const treffers = [];
  for (const term of termen) {
    const re = patroon(term);
    if (!re) continue;
    const gevonden = [...norm.matchAll(re)];
    if (!gevonden.length) continue;
    treffers.push({ term, aantal: gevonden.length, fragment: fragment(tekst, gevonden[0].index, gevonden[0][0].length) });
  }
  return treffers;
}
