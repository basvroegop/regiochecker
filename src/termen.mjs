// Termen herkennen in stukken: sleutelwoorden van regio's (plaatsnamen,
// gebieden) en zoektermen van meldingen. Hoofdletters en accenten tellen niet
// ("Fryslân" = "fryslan"), en alleen hele woorden tellen: "Haren" vindt de
// plaats, niet "haren" binnen "tegenhoudharen". Een term van meer woorden
// ("De Peinder Mieden") moet als geheel voorkomen; aanhalingstekens mogen,
// maar zijn niet nodig.
//
// Uitzondering: met `hoofdletters` moet elke hoofdletter van de term ook in de
// tekst een hoofdletter zijn. Zo vindt het sleutelwoord "Assen" in kamerstukken
// de stad (ook ASSEN in een kop), maar niet "assen" van een auto. Kleine
// letters mogen allebei: "in Witteveen" vindt ook "In Witteveen" aan het begin
// van een zin. Een lidwoord ("Het Hogeland"), accenten en een webadres
// (dvhn.nl/regio/groningen/…) tellen ook dan niet.
//
// Bij kamerstukken zoekt SQLite (FTS5) eerst de kandidaten; daarna controleren
// we hier per stuk met een reguliere expressie en halen we de zin rond de
// treffer op. Bij transcripten (audio) zoeken we per segment, met de tijd.

// Kleine letters, zonder accenten, en even lang als het origineel, zodat een
// positie in de genormaliseerde tekst ook een positie in het origineel is.
export function normaliseer(tekst) {
  let uit = '';
  for (let i = 0; i < tekst.length; i++) {
    const code = tekst.charCodeAt(i);
    // Gewone letters snel; alleen bij andere tekens de dure omweg.
    if (code < 128) uit += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : tekst[i];
    else uit += tekst[i].toLowerCase().normalize('NFD')[0] || tekst[i];
  }
  return uit;
}

const WOORD = '\\p{L}\\p{N}';

export function patroon(term) {
  const delen = normaliseer(term.trim()).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!delen.length) return null;
  const tussen = `[^${WOORD}]+`;
  const kern = delen.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(tussen);
  return new RegExp(`(?<![${WOORD}])${kern}(?![${WOORD}])`, 'gu');
}

const AANHALING = /^["'“”‘’„]+|["'“”‘’„]+$/g;

// Lijst van termen schoonmaken: spaties en aanhalingstekens eromheen weg,
// dubbele eruit, lege weg.
export function schoneTermen(invoer) {
  const lijst = Array.isArray(invoer) ? invoer : String(invoer || '').split(/[\n,;]+/);
  const gezien = new Set();
  const uit = [];
  for (const ruw of lijst) {
    const term = String(ruw).replace(/\s+/g, ' ').trim().replace(AANHALING, '').trim();
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

const LETTER = /[\p{L}\p{N}]/u;
const letters = (tekst) => [...tekst].filter((t) => LETTER.test(t));
const isHoofdletter = (t) => t !== t.toLowerCase();

// Een lidwoord vooraan een naam schrijft niet iedereen met een hoofdletter
// ("de gemeente het Hogeland"): daar telt de hoofdletter niet.
const LIDWOORDEN = new Set(['de', 'het', 'den', 'der']);

// Staat er een hoofdletter in de tekst waar de term er een heeft? `gevonden`
// is het stuk tekst dat het patroon van de term vond (of het fragment dat
// SQLite markeerde); de letters lopen dan één op één gelijk.
export function hoofdlettersKloppen(term, gevonden) {
  const a = [...String(term).matchAll(/[\p{L}\p{N}]+/gu)]
    .flatMap(([woord]) => [...(LIDWOORDEN.has(woord.toLowerCase()) ? woord.toLowerCase() : woord)]);
  const b = letters(String(gevonden || ''));
  return a.length === b.length && a.every((t, i) => !isHoofdletter(t) || isHoofdletter(b[i]));
}

// Een webadres heeft geen hoofdletters: dvhn.nl/regio/groningen/… in
// Kamervragen gaat wel over Groningen. Dan telt de hoofdletter niet.
function inLink(tekst, positie) {
  let begin = positie;
  while (begin > 0 && !/\s/.test(tekst[begin - 1])) begin--;
  return /:\/\/|www\./i.test(tekst.slice(begin, positie));
}

// Welke van de termen komen in de tekst voor? Per term het eerste fragment en
// het aantal keer dat hij voorkomt.
export function vindTermen(tekst, termen, { hoofdletters = false } = {}) {
  const norm = normaliseer(tekst);
  const treffers = [];
  for (const term of termen) {
    const re = patroon(term);
    if (!re) continue;
    let gevonden = [...norm.matchAll(re)];
    // normaliseer() houdt de lengte gelijk: dezelfde plek in het origineel.
    if (hoofdletters) gevonden = gevonden.filter((m) => hoofdlettersKloppen(term, tekst.slice(m.index, m.index + m[0].length)) || inLink(tekst, m.index));
    if (!gevonden.length) continue;
    treffers.push({ term, aantal: gevonden.length, fragment: fragment(tekst, gevonden[0].index, gevonden[0][0].length) });
  }
  return treffers;
}

// Een zoekvraag van een melding: termen gescheiden door OR, komma of nieuwe
// regel, woordgroepen eventueel tussen aanhalingstekens:
//   "stikstof" OR natura2000, "De Peinder Mieden"
export function leesZoekvraag(tekst) {
  return schoneTermen(String(tekst || '').split(/\s+OR\s+|[\n,;|]+/));
}

// En terug, voor op het scherm: woordgroepen tussen aanhalingstekens.
export const toonTerm = (term) => (/\s/.test(term) ? `"${term}"` : term);
export const zoekvraagTekst = (termen) => termen.map(toonTerm).join(' OR ');

// Termen in een transcript: per term het aantal en de eerste treffers, met de
// tijd van het segment en de zin eromheen. `segmenten`: [{ start, text }].
export function vindInSegmenten(segmenten, termen, { maxPerTerm = 20 } = {}) {
  const patronen = termen.map((t) => [t, patroon(t)]).filter(([, re]) => re);
  const perTerm = new Map();
  segmenten.forEach((s, index) => {
    const tekst = String(s.text || '');
    if (!tekst) return;
    const norm = normaliseer(tekst);
    for (const [term, re] of patronen) {
      re.lastIndex = 0;
      const gevonden = [...norm.matchAll(re)];
      if (!gevonden.length) continue;
      const t = perTerm.get(term) || { term, aantal: 0, treffers: [] };
      t.aantal += gevonden.length;
      if (t.treffers.length < maxPerTerm) {
        t.treffers.push({ tijd: Number(s.start) || 0, segment: index, fragment: fragment(tekst, gevonden[0].index, gevonden[0][0].length, 120) });
      }
      perTerm.set(term, t);
    }
  });
  return termen.map((t) => perTerm.get(t)).filter(Boolean);
}

// Een vrije zoekvraag (de zoekbalk): delen gescheiden door OR; binnen een deel
// moeten alle woorden en "woordgroepen" voorkomen, als hele woorden. Geeft een
// functie die voor een tekst de eerste treffer geeft (term en fragment), of null.
export function maakZoeker(vraag) {
  const delen = String(vraag || '').split(/\s+OR\s+/).map((deel) => {
    const stukken = [...deel.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => (m[1] || m[2]).replace(AANHALING, ''));
    return stukken.map((t) => [t, patroon(t)]).filter(([, re]) => re);
  }).filter((d) => d.length);
  if (!delen.length) return null;
  return (tekst) => {
    const norm = normaliseer(String(tekst || ''));
    for (const deel of delen) {
      const gevonden = deel.map(([term, re]) => [term, norm.matchAll(re).next().value]);
      if (gevonden.every(([, m]) => m)) {
        const [term, m] = gevonden[0];
        return { term, fragment: fragment(tekst, m.index, m[0].length, 120) };
      }
    }
    return null;
  };
}
