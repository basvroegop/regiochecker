// Bekendmakingen van de provincie Fryslân (fryslan.frl). Elke zaterdag een
// pagina (/24-oktober-2026), met een index per jaar (/bekendmakingen-2026).
// Een pagina heeft twee delen:
//   - stukken van de provincie zelf, elk in een eigen alinea-blok met een h2
//     ("Vastgoed – bekendmaking 24-10-2026", "Brug Warns afgesloten …");
//   - sinds eind mei 2026 een uitklapblok (<details>) per gemeente ("Gemeente
//     Smallingerland", "Gemeente Leeuwarden en Tytsjerksteradiel"), of per
//     onderwerp ("Provincie Fryslân", "Diverse Natura 2000-gebieden"), met
//     daarin een of meer bekendmakingen, elk onder een h2.
// Een stuk uit een gemeenteblok krijgt de gemeente mee (`gemeenten`); bij een
// gemeente die een regio is, wordt het een stuk van die regio (src/verzamel.mjs,
// `perGemeente`). De rest is landelijk en gaat via sleutelwoorden.
//
// Eerste keer: alle zaterdagen sinds `vanaf` (januari 2026; daarvoor bestaan
// de pagina's niet). Daarna de nieuwste weken uit de index.

import { createHash } from 'node:crypto';
import { haalTekst } from '../ophalen.mjs';
import { ontsnap } from '../html.mjs';
import { gemeente } from '../geo.mjs';

const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const NIEUWSTE = 3;
const wacht = () => Number(process.env.PROVINCIE_WACHT_MS ?? 1000);
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
const kortHash = (t) => createHash('sha1').update(String(t)).digest('hex').slice(0, 12);
const plat = (html) => ontsnap(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const OVERSLAAN = /^(contactgegevens|heeft u nog vragen|hieronder vind u)/i;

// "24 oktober 2026" ↔ "/24-oktober-2026" ↔ "2026-10-24"
export const weekSlug = (d) => `${d.getUTCDate()}-${MAANDEN[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
export function datumVanSlug(slug) {
  const m = /(\d{1,2})-([a-z]+)-(\d{4})/.exec(slug || '');
  const maand = m ? MAANDEN.indexOf(m[2]) : -1;
  return maand < 0 ? null : `${m[3]}-${String(maand + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// "Gemeente Smallingerland", "Gemeentes Achtkarspelen", "Gemeente Leeuwarden en
// Tytsjerksteradiel" → de officiële namen; leeg bij een onderwerp.
export function gemeentenIn(kop) {
  const m = /^gemeentes?\s+(.+)$/i.exec(String(kop || '').trim());
  if (!m) return [];
  return m[1].split(/\s*,\s*|\s+en\s+/).map((n) => gemeente(n)?.naam).filter(Boolean);
}

// Regels van een stuk: alinea's en opsommingen, met de zinnen die de site over
// meerdere alinea's breekt ("… nieuwe watergangen en al" / "verbrede …") weer aan elkaar.
function regelsVan(html) {
  const regels = [];
  for (const [, tag, inhoud] of String(html).matchAll(/<(p|li|h[3-6])\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const tekst = plat(inhoud);
    if (!tekst) continue;
    const vorige = regels.at(-1);
    if (tag === 'p' && vorige && !vorige.kop && !/[.:;!?)]$/.test(vorige.tekst) && /^[a-z(]/.test(tekst)) vorige.tekst += ` ${tekst}`;
    else regels.push({ tekst: tag === 'li' ? `• ${tekst}` : tekst, kop: /^h/.test(tag) });
  }
  return regels;
}

const veld = (regels, naam) => regels.find((r) => r.tekst.toLowerCase().startsWith(`${naam}:`))?.tekst.slice(naam.length + 1).trim() || null;
const kort = (t, n) => (t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : t);

// De kop van een bekendmaking: wat voor stuk, waarover en waar.
//   "Aanvraag vergunning Omgevingswet: het uitvoeren van kadewerk (Troelstraweg te Idskenhuizen)"
//   "Kennisgeving omgevingsvergunning flora- en fauna-activiteit Omgevingswet: dakwerkzaamheden aan woningen in Workum"
//   "Kennisgeving – (Ontwerp) Wijzigingsvergunning Omgevingswet: Weinterp 20 te Wijnjewoude"
const zonderHoofdletter = (t) => t.charAt(0).toLowerCase() + t.slice(1);
const schoneLocatie = (l) => l && l.split(/\.\s|\s\(/)[0]
  .replace(/,?\s*kadastraal\b.*$/i, '').replace(/,?\s*gemeente\s+.*$/i, '').replace(/[.,;\s]+$/, '').trim();

export function bekendmakingTitel(soort, regels) {
  const schoon = soort.replace(/\.$/, '').trim();
  const eerste = regels.find((r) => !r.kop && !/^(beschikking|besluit) verstuurd/i.test(r.tekst))?.tekst || '';
  const betreft = veld(regels, 'betreft')?.replace(/\.$/, '');
  const behoeve = /ten behoeve van (?:ten behoeve van )?[‘'"]?(.+?)[’'"]?(?:\s*\(|\.(?:\s|$)|\s+afgewezen|$)/.exec(eerste)?.[1];
  const aan = /verleend aan:?\s*(.+?)\s*(?:\(|$)/.exec(eerste)?.[1]?.replace(/,?\s*\b\d{4}\s?[A-Z]{2}\b/, '').replace(/[.,\s]+$/, '');
  // Liefst tot het eerste haakje of de eerste komma na een redelijk stuk: "(ten behoeve van …" voegt in een kop weinig toe.
  const inkorten = (t) => kort(t.length > 90 ? t.replace(/^(.{40,90}?)\s*(?:[(,;]|\.\s).*$/, '$1') : t, 90);
  const onderwerp = betreft || behoeve ? inkorten(zonderHoofdletter(betreft || behoeve)) : aan ? kort(aan, 90) : null;
  const locatie = schoneLocatie(veld(regels, 'locatie'));
  // Een lange locatie: het straatdeel korter, de plaats houden ("Achter Folgeren 20 tot en met 40… te Drachten").
  const plek = (l) => {
    const m = l.length > 60 && /^(.*)\s(te|in)\s([^,]+)$/.exec(l);
    return m ? `${kort(m[1], 35)} ${m[2]} ${m[3]}` : kort(l, 60);
  };
  const waar = locatie && !(onderwerp || '').toLowerCase().includes(locatie.toLowerCase()) ? plek(locatie) : null;
  if (onderwerp) return `${schoon}: ${onderwerp}${waar ? ` (${waar})` : ''}`;
  return waar ? `${schoon}: ${waar}` : schoon;
}

function stuk({ datum, url, anker, kop, soort, html, gemeenten }) {
  const regels = regelsVan(html);
  const titel = soort ? bekendmakingTitel(soort, regels) : kop;
  const tekst = [kop !== titel ? kop : null, ...regels.map((r) => r.tekst)].filter(Boolean).join('\n\n');
  return {
    sleutel: `${datum}:${kortHash(`${kop}|${soort || ''}|${tekst.slice(0, 600)}`)}`,
    titel,
    url: anker ? `${url}#${anker}` : url,
    datum,
    tekst,
    afzender: 'Provincie Fryslân',
    soortStuk: soort ? soort.replace(/\.$/, '') : null,
    ...(gemeenten.length ? { gemeenten } : {}),
  };
}

// Alle stukken van één weekpagina.
export function leesWeek(html, url) {
  const datum = datumVanSlug(new URL(url).pathname) || null;
  const begin = html.indexOf('<h1');
  const eind = html.indexOf('</main>', begin);
  const inhoud = html.slice(begin, eind > 0 ? eind : undefined);
  const uit = [];
  // De alinea-blokken van de pagina; een blok met uitklapblokken is het gemeentedeel.
  for (const blok of inhoud.split(/<div style="--paragraph-background-color[^"]*"/).slice(1)) {
    const uitklap = [...blok.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/g)].map((m) => m[1]);
    if (!uitklap.length) {
      const h2 = /<h2\b(?:[^>]*\bid="([^"]*)")?[^>]*>([\s\S]*?)<\/h2>/.exec(blok);
      const kop = h2 && plat(h2[2]);
      if (!kop || OVERSLAAN.test(kop)) continue;
      uit.push(stuk({ datum, url, anker: h2[1], kop, soort: null, html: blok.slice(h2.index + h2[0].length), gemeenten: [] }));
      continue;
    }
    for (const d of uitklap) {
      const h3 = /<h3\b(?:[^>]*\bid="([^"]*)")?[^>]*>([\s\S]*?)<\/h3>/.exec(d);
      const kop = h3 && plat(h3[2]);
      if (!kop || OVERSLAAN.test(kop)) continue;
      const gemeenten = gemeentenIn(kop);
      const binnen = d.slice(d.indexOf('</summary>') + 10);
      const delen = binnen.split(/(?=<h2\b)/).filter((x) => /^<h2\b/.test(x));
      if (!delen.length) {
        uit.push(stuk({ datum, url, anker: h3[1], kop, soort: null, html: binnen, gemeenten }));
        continue;
      }
      for (const deel of delen) {
        const h2 = /<h2\b[^>]*>([\s\S]*?)<\/h2>/.exec(deel);
        uit.push(stuk({ datum, url, anker: h3[1], kop, soort: plat(h2[1]), html: deel.slice(h2[0].length), gemeenten }));
      }
    }
  }
  return uit;
}

// De weekpagina's in een jaarindex, nieuwste eerst.
export function wekenInIndex(html, basis) {
  const slugs = [...String(html).matchAll(/href="\/(\d{1,2}-[a-z]+-\d{4})"/g)].map((m) => m[1]);
  return [...new Set(slugs)].filter(datumVanSlug)
    .sort((a, b) => datumVanSlug(b).localeCompare(datumVanSlug(a)))
    .map((s) => new URL(`/${s}`, basis).href);
}

export async function haalBekendmakingen(bron, { eersteKeer = false, nu = new Date() } = {}) {
  const basis = bron.url;
  const weken = new Set();
  // De index van dit jaar (en in januari ook die van vorig jaar).
  for (const jaar of new Set([nu.getUTCFullYear(), new Date(nu - 21 * 86400000).getUTCFullYear()])) {
    try {
      const lijst = wekenInIndex(await haalTekst(new URL(`/bekendmakingen-${jaar}`, basis).href), basis);
      for (const w of eersteKeer ? lijst : lijst.slice(0, NIEUWSTE)) weken.add(w);
    } catch { /* nog geen index voor dit jaar */ }
  }
  // Ook de zaterdagen zelf: de index noemt alleen de laatste maanden.
  const zaterdag = new Date(Date.UTC(nu.getUTCFullYear(), nu.getUTCMonth(), nu.getUTCDate() - ((nu.getUTCDay() + 1) % 7)));
  const vanaf = eersteKeer ? new Date(`${bron.vanaf}T00:00:00Z`) : new Date(zaterdag - (NIEUWSTE - 1) * 7 * 86400000);
  // De pagina van komende zaterdag staat er soms al eerder.
  for (let d = new Date(+zaterdag + 7 * 86400000); d >= vanaf; d = new Date(d - 7 * 86400000)) weken.add(new URL(`/${weekSlug(d)}`, basis).href);

  const uit = [];
  let gelukt = 0;
  let pogingen = 0;
  for (const url of weken) {
    if (pogingen++) await slaap(wacht());
    let html;
    try {
      html = await haalTekst(url);
    } catch (fout) {
      if (/HTTP 404/.test(fout.message)) continue; // een week zonder pagina
      throw fout;
    }
    gelukt++;
    uit.push(...leesWeek(html, url));
  }
  if (!gelukt) throw new Error('Geen enkele weekpagina met bekendmakingen gevonden. Is de site veranderd?');
  return uit;
}
