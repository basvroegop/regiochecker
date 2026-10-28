// Waar is een bedrijf gevestigd? Voor ransomwareslachtoffers, die op een
// lekwebsite alleen met naam en soms website staan. Overgenomen uit de checker
// (/opt/checker/backend/services/locator.py), met twee verbeteringen: een
// postcode gaat via de PDOK Locatieserver naar woonplaats en gemeente (de
// checker kwam niet verder dan de provincie), en een treffer op naam moet ook
// echt op de naam lijken.
//
// Van sterk naar zwak bewijs:
//   1. een postcode die al bekend is (de checker vond er een)
//   2. een plaats in de beschrijving ("headquartered in Rotterdam")
//   3. OpenStreetMap (Nominatim) op de bedrijfsnaam, en met een sleutel
//      ook OpenCorporates (KvK-gegevens; zonder sleutel weigert die)
//   4. de eigen website: een postcode op de contactpagina of homepage (live,
//      anders via het Internet Archive), of de paginatitel als nieuwe zoeknaam
// Wijzen de kandidaten naar verschillende gemeenten, dan is de vestiging
// onzeker en gaat het stuk naar geen enkele regio.

import { haalTekst } from './ophalen.mjs';
import { platteTekst, ontsnap, absoluut } from './html.mjs';
import { plaatsenIn, gemeente as gemeenteOpNaam } from './geo.mjs';

const UA = 'Regiochecker/1.0 (regionale journalistiek; https://github.com/basvroegop/regiochecker)';
const NOMINATIM = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const PDOK = process.env.PDOK_LOCATIESERVER || 'https://api.pdok.nl/bzk/locatieserver/search/v3_1';
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));

// Nominatim: hooguit één verzoek per seconde (gebruiksvoorwaarden).
let volgendeNominatim = 0;
async function nominatimBeurt() {
  const wacht = volgendeNominatim - Date.now();
  volgendeNominatim = Math.max(Date.now(), volgendeNominatim) + Number(process.env.NOMINATIM_WACHT_MS ?? 1100);
  if (wacht > 0) await slaap(wacht);
}

const json = async (url) => JSON.parse(await haalTekst(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }));

// Hoe goed lijken twee namen op elkaar (Dice op letterparen, 0 tot 1)?
const paren = (s) => {
  const t = ` ${String(s).toLowerCase().replace(/\b(b\.?v\.?|n\.?v\.?|holding|groep|group|nederland|the netherlands)\b/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  const uit = new Map();
  for (let i = 0; i < t.length - 1; i++) uit.set(t.slice(i, i + 2), (uit.get(t.slice(i, i + 2)) || 0) + 1);
  return uit;
};
export function lijkt(a, b) {
  const x = paren(a);
  const y = paren(b);
  let samen = 0;
  for (const [k, n] of x) samen += Math.min(n, y.get(k) || 0);
  const totaal = [...x.values()].reduce((s, n) => s + n, 0) + [...y.values()].reduce((s, n) => s + n, 0);
  return totaal ? (2 * samen) / totaal : 0;
}

const DOMEIN = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:nl|com|org|eu|net|io|be|de|uk|fr|info|biz|co))\/?$/i;
export const domeinVan = (tekst) => DOMEIN.exec(String(tekst || '').trim())?.[1]?.toLowerCase() || null;
// "van-dijk-bouw.nl" → "van dijk bouw"
const zoeknaamVanDomein = (d) => d.replace(/\.[a-z]+$/i, '').replace(/[-_.]+/g, ' ').trim();

// Een postcode (1234 AB) naar woonplaats, gemeente en provincie.
export async function postcodeOpzoeken(postcode) {
  const pc = String(postcode || '').toUpperCase().replace(/\s+/g, '');
  if (!/^[1-9]\d{3}[A-Z]{2}$/.test(pc)) return null;
  const d = await json(`${PDOK}/free?q=${pc}&fq=type:postcode&rows=1`);
  const doc = d?.response?.docs?.[0];
  if (!doc?.gemeentenaam) return null;
  const punt = /POINT\(([\d.]+) ([\d.]+)\)/.exec(doc.centroide_ll || '');
  return {
    postcode: `${pc.slice(0, 4)} ${pc.slice(4)}`, plaats: doc.woonplaatsnaam || null, gemeente: doc.gemeentenaam, provincie: doc.provincienaam || null,
    ...(punt ? { lat: Number(punt[2]), lon: Number(punt[1]) } : {}),
  };
}

// Kandidaten van OpenStreetMap op naam; alleen treffers die op de naam lijken.
async function opNaam(naam) {
  await nominatimBeurt();
  let lijst;
  try {
    lijst = await json(`${NOMINATIM}/search?${new URLSearchParams({ q: naam, countrycodes: 'nl', addressdetails: '1', namedetails: '1', format: 'json', limit: '5' })}`);
  } catch {
    return [];
  }
  const uit = [];
  for (const h of Array.isArray(lijst) ? lijst : []) {
    const a = h.address || {};
    const hitNaam = h.namedetails?.name || h.name || String(h.display_name || '').split(',')[0];
    const score = lijkt(naam, hitNaam);
    if (score < 0.6) continue;
    const plaats = a.city || a.town || a.village || a.hamlet || null;
    const gemeente = a.municipality || (plaats && gemeenteVanPlaats(plaats)) || null;
    if (!gemeente) continue;
    uit.push({ plaats, gemeente, provincie: a.state || null, postcode: a.postcode || null, lat: Number(h.lat), lon: Number(h.lon), bron: 'OpenStreetMap', zeker: Math.round(score * 70) / 100, naam: hitNaam });
  }
  return uit;
}

async function opencorporates(naam) {
  const sleutel = process.env.OPENCORPORATES_API_KEY;
  if (!sleutel) return [];
  try {
    const d = await json(`https://api.opencorporates.com/v0.4/companies/search?${new URLSearchParams({ q: naam, jurisdiction_code: 'nl', per_page: '10', api_token: sleutel })}`);
    const uit = [];
    for (const { company: c } of d?.results?.companies || []) {
      if (lijkt(naam, c?.name) < 0.6) continue;
      const pc = await postcodeOpzoeken(c.registered_address?.postal_code);
      if (pc) uit.push({ ...pc, bron: 'OpenCorporates', zeker: 0.8, naam: c.name });
    }
    return uit;
  } catch {
    return [];
  }
}

// De gemeente van een woonplaats, als die eenduidig is.
function gemeenteVanPlaats(plaats) {
  const hier = plaatsenIn(`in ${plaats}`);
  return hier.length === 1 && hier[0].gemeenten.length === 1 ? hier[0].gemeenten[0] : null;
}

// De homepage, of anders de laatste versie in het Internet Archive.
async function pagina(url) {
  try {
    return await haalTekst(url, { headers: { 'User-Agent': UA } });
  } catch {
    try {
      const d = await json(`https://archive.org/wayback/available?url=${encodeURIComponent(new URL(url).hostname)}`);
      const kopie = d?.archived_snapshots?.closest?.url;
      return kopie ? await haalTekst(kopie.replace(/^http:/, 'https:'), { headers: { 'User-Agent': UA } }) : null;
    } catch {
      return null;
    }
  }
}

const POSTCODE = /\b([1-9]\d{3})\s?(?!SA|SD|SS)([A-Z]{2})\b/g;
const CONTACT = /contact|over-ons|over ons|about|locatie|adres|bereikbaar|route/i;

function meestePostcode(html) {
  const tel = new Map();
  for (const m of platteTekst(html).matchAll(POSTCODE)) tel.set(`${m[1]}${m[2]}`, (tel.get(`${m[1]}${m[2]}`) || 0) + 1);
  return [...tel].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

// De website: eerst de contactpagina, dan de homepage op een postcode; anders
// de paginatitel als nieuwe zoeknaam.
async function viaWebsite(domein, naam) {
  const basis = `https://${domein}/`;
  const html = await pagina(basis);
  if (!html) return [];
  const link = [...html.matchAll(/<a\b[^>]*href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi)].find(([, href, tekst]) => CONTACT.test(href) || CONTACT.test(platteTekst(tekst)));
  const contact = link ? absoluut(ontsnap(link[1]), basis) : null;
  for (const [bron, bladzijde] of [['contactpagina', contact && new URL(contact).hostname.endsWith(domein) ? await pagina(contact) : null], ['homepage', html]]) {
    const pc = bladzijde && meestePostcode(bladzijde);
    const gevonden = pc && await postcodeOpzoeken(pc);
    if (gevonden) return [{ ...gevonden, bron: `postcode op de ${bron} van ${domein}`, zeker: 0.75 }];
  }
  const titel = platteTekst(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').replace(/\s*[|\-–•·:]\s.*$/, '').trim();
  if (titel.length >= 3 && !/^(home|welkom|homepage|404|error)$/i.test(titel) && titel.toLowerCase() !== naam.toLowerCase()) {
    return (await opNaam(titel)).map((k) => ({ ...k, bron: `OpenStreetMap op de titel van ${domein}` }));
  }
  return [];
}

// Eén gemeente uit de kandidaten, of null als ze het niet eens zijn.
function kies(kandidaten) {
  const gemeenten = [...new Set(kandidaten.map((k) => k.gemeente))];
  if (gemeenten.length !== 1) return null;
  return kandidaten.sort((a, b) => b.zeker - a.zeker)[0];
}

// { plaats, gemeente, provincie, postcode, lat, lon, bron, zeker } of
// { onzeker: true, kandidaten } of null. `hint`: wat de checker al vond.
export async function vindVestiging({ naam, website, beschrijving, hint = {} }) {
  const schoon = String(naam || '').trim();
  const domein = domeinVan(website) || domeinVan(schoon);
  const zoeknaam = domeinVan(schoon) ? zoeknaamVanDomein(domeinVan(schoon)) : schoon;
  // De officiële gemeentenaam. OpenStreetMap zegt soms "De Friese Meren" waar het
  // Kadaster "De Fryske Marren" zegt; dan via de postcode bij PDOK navragen.
  const officieel = async (k) => {
    if (!k || gemeenteOpNaam(k.gemeente)) return k && { ...k, gemeente: gemeenteOpNaam(k.gemeente).naam };
    const pc = k.postcode && await postcodeOpzoeken(k.postcode).catch(() => null);
    return pc ? { ...k, gemeente: pc.gemeente, plaats: k.plaats || pc.plaats } : k;
  };
  const normaal = (k) => k && { ...k, gemeente: gemeenteOpNaam(k.gemeente)?.naam || k.gemeente };

  // 1. Een postcode van eerder.
  if (hint.postcode) {
    const pc = await postcodeOpzoeken(hint.postcode).catch(() => null);
    if (pc) return normaal({ ...pc, bron: `postcode (${hint.bron || 'eerder gevonden'})`, zeker: 0.8 });
  }
  // 2. De beschrijving noemt de plaats.
  const inTekst = plaatsenIn(beschrijving).filter((p) => p.gemeenten.length === 1);
  const uitTekst = [...new Set(inTekst.map((p) => p.gemeenten[0]))];
  if (uitTekst.length === 1) return normaal({ plaats: inTekst[0].plaats, gemeente: uitTekst[0], provincie: gemeenteOpNaam(uitTekst[0])?.provincie || null, bron: 'de beschrijving', zeker: 0.7 });
  // 3. Op naam.
  let kandidaten = [];
  if (zoeknaam.length >= 3 && !/\*|\?{2,}/.test(zoeknaam)) {
    kandidaten = await Promise.all([...await opencorporates(zoeknaam), ...await opNaam(zoeknaam)].map(officieel));
    const gekozen = kies(kandidaten);
    if (gekozen) return gekozen;
  }
  // 4. De eigen website.
  if (domein) {
    const site = await Promise.all((await viaWebsite(domein, zoeknaam).catch(() => [])).map(officieel));
    // Bevestigt de website een van de kandidaten op naam, of wijst hij zelf iets aan?
    const bevestigd = kies(kandidaten.filter((k) => site.some((s) => s.gemeente === k.gemeente))) || kies(site);
    if (bevestigd) return bevestigd;
  }
  // 5. Wat de checker als plaats vond.
  if (hint.plaats) {
    const g = gemeenteVanPlaats(hint.plaats);
    if (g) return normaal({ plaats: hint.plaats, gemeente: g, provincie: gemeenteOpNaam(g)?.provincie || null, bron: `${hint.bron || 'eerder'} (plaats)`, zeker: 0.4 });
  }
  return kandidaten.length ? { onzeker: true, kandidaten: kandidaten.slice(0, 5) } : null;
}
