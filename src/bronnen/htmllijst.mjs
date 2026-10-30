// Een lijst op een gewone webpagina: nieuwsberichten van een gemeente zonder
// RSS-feed (Leeuwarden, De Fryske Marren, Tynaarlo …), of de Woo-besluiten op
// een gemeentepagina. Eén lezer voor allemaal, ingesteld per bron:
//
//   link      reguliere expressie op het pad van de link naar een stuk
//             ("^/actualiteiten/[^/]+$", "\\.pdf$")
//   inKop     alleen links in een kop (<h2><a …>), voor sites waar de
//             berichten geen eigen map in het pad hebben (Coevorden)
//   vanaf     alleen de pagina na deze tekst (het begin van de lijst)
//   zonderDatum  de pagina noemt geen datums bij de stukken (wat er staat,
//             hoort bij de kop: "Agenda raadsvergadering 3 november")
//   tot       alleen de pagina tot deze tekst (het eind van de lijst)
//   extern    de links mogen naar een ander domein (pdf's op een cdn); `link`
//             geldt dan voor het hele adres
//   via       eerst naar deze pagina's (`viaAantal`, de eerste twee): een
//             overzicht dat per jaar een eigen pagina heeft ("woo-verzoeken-2026")
//   perKop    één stuk per kop van dit niveau ("h4"), met de eerste link
//             eronder: een uitklapblok per Woo-verzoek met de pdf's (Meppel)
//
// De kop is de linktekst, of een kop in de link; "Lees meer" telt niet. De
// datum staat ergens in het blok van het stuk: tussen de vorige en de volgende
// link. Gezocht wordt naar <time datetime>, "27 okt 2026", "28-10-2026" en een
// Unix-tijd; de datum die het dichtst bij de link staat, wint. Een pagina
// zonder datums (Westerveld) krijgt de datum waarop de Regiochecker het stuk
// voor het eerst zag (`datumBijEersteZicht` in src/verzamel.mjs).

import { haalTekst } from '../ophalen.mjs';
import { platteTekst, ontsnap } from '../html.mjs';
import { leesDatum, lokaleDatum } from '../datum.mjs';

const GENERIEK = /^(lees (verder|meer)|meer( informatie( over (dit|deze) [\w-]+)?)?|bekijk|download|webpagina|klik hier|>+|»|→)$/i;
const MAAND = '(?:januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december|jan|feb|mrt|apr|jun|jul|aug|sept?|okt|nov|dec)\\.?';
const DATUMS = [
  /<time\b[^>]*\bdatetime="([^"]+)"/gi,
  new RegExp(`\\b(\\d{1,2}\\s+${MAAND}\\s+\\d{4})\\b`, 'gi'),
  /\b(\d{1,2}-\d{1,2}-\d{4})\b/g,
  /\b(\d{1,2}\.\d{1,2}\.\d{4})\b/g,
];

// "23 oktober 2026 De vraag naar woningen …": de datum hoort niet bij de samenvatting.
const DATUM_VOORAAN = new RegExp(`^(\\d{1,2}\\s+${MAAND}(\\s+\\d{4})?|\\d{1,2}[-.]\\d{1,2}[-.]\\d{4})\\s*[-–|·]?\\s*`, 'i');

function datumUit(waarde) {
  if (/^\d{9,10}$/.test(waarde)) return lokaleDatum(new Date(Number(waarde) * 1000));
  if (/^\d{4}-\d{2}-\d{2}T/.test(waarde)) {
    const ms = Date.parse(waarde.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    return Number.isFinite(ms) ? lokaleDatum(new Date(ms)) : null;
  }
  return leesDatum(waarde.replace(/(\d{1,2})\s+([a-z]+)\.\s/i, '$1 $2 '));
}

// "Meer over 'Scrooge Live keert terug'" → "Scrooge Live keert terug";
// "Woo-besluit Rijksmonumenten (PDF, 518,5 kB )" → "Woo-besluit Rijksmonumenten".
const schoneKop = (t) => t.replace(/^(meer over|lees meer over|lees verder over)\s*/i, '')
  .replace(/\s*\((opent in (een )?nieuw (tabblad|venster)|pdf[^)]*|externe link)\)\s*$/i, '')
  .replace(/\s+(Link is extern|externe link)$/i, '')
  .replace(/^['‘"“](.*)['’"”]$/, '$1').trim();

function kopVan(anker, attributen) {
  const inKop = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(anker)?.[1];
  const kandidaten = [
    inKop && platteTekst(inKop),
    platteTekst(anker.replace(/<span[^>]*>\s*\d{1,2}[-.]\d{1,2}[-.]\d{4}\s*<\/span>/g, '')),
    /\btitle="([^"]+)"/.exec(attributen)?.[1],
    /\baria-label="([^"]+)"/.exec(attributen)?.[1],
  ].map((t) => schoneKop(ontsnap(t || '').replace(/\s+/g, ' ').trim())).filter((t) => t && !GENERIEK.test(t));
  return kandidaten[0] || null;
}

// Eén stuk per kop: de kop is de titel, de eerste passende link eronder het adres.
function perKopLijst(tekst, pagina, { link, perKop, extern, zonderDatum }) {
  const patroon = new RegExp(link, 'i');
  const basis = new URL(pagina);
  const delen = [...tekst.matchAll(new RegExp(`<${perKop}\\b[^>]*>([\\s\\S]*?)<\\/${perKop}>`, 'gi'))];
  return delen.map((m, i) => {
    const kop = schoneKop(platteTekst(m[1]));
    const blok = tekst.slice(m.index + m[0].length, delen[i + 1]?.index ?? tekst.length);
    let url = null;
    for (const a of blok.matchAll(/<a\b[^>]*\bhref="([^"#]+)"/gi)) {
      try {
        const u = new URL(ontsnap(a[1]).trim(), basis);
        u.searchParams.delete('cb');
        if (extern ? patroon.test(decodeURIComponent(u.href)) : (u.hostname === basis.hostname && patroon.test(decodeURIComponent(u.pathname)))) { url = u.href; break; }
      } catch { /* volgende */ }
    }
    if (!kop || !url) return null;
    const aantal = [...blok.matchAll(/<a\b[^>]*\bhref=/gi)].length;
    return { sleutel: kop.toLowerCase(), titel: kop.slice(0, 300), url, datum: zonderDatum ? null : DATUMS.slice(1).map((re) => new RegExp(re.source, 'i').exec(platteTekst(blok))?.[1]).map((d) => d && datumUit(d)).find(Boolean) || null, tekst: aantal > 1 ? `${aantal} documenten.` : null };
  }).filter(Boolean);
}

export function leesHtmlLijst(html, pagina, { link, inKop = false, vanaf = null, tot = null, zonderDatum = false, extern = false, perKop = null } = {}) {
  let tekst = String(html);
  if (vanaf) {
    const i = tekst.indexOf(vanaf);
    if (i >= 0) tekst = tekst.slice(i);
  }
  if (tot) {
    const i = tekst.indexOf(tot);
    if (i > 0) tekst = tekst.slice(0, i);
  }
  if (perKop) return perKopLijst(tekst, pagina, { link, perKop, extern, zonderDatum });
  const patroon = new RegExp(link, 'i');
  const basis = new URL(pagina);
  const ankers = [];
  for (const m of tekst.matchAll(/<a\b([^>]*)\bhref="([^"#]+)"([^>]*)>([\s\S]*?)<\/a>/gi)) {
    let url;
    try {
      url = new URL(ontsnap(m[2]).trim(), basis);
    } catch {
      continue;
    }
    if (extern ? !patroon.test(decodeURIComponent(url.href)) : (url.hostname !== basis.hostname || !patroon.test(decodeURIComponent(url.pathname)))) continue;
    // Alleen links in een kop: kijk of er vlak voor de link een kop opent die nog niet dicht is.
    if (inKop && !/<h[1-6][^>]*>\s*$/i.test(tekst.slice(Math.max(0, m.index - 200), m.index))) continue;
    url.hash = '';
    // Een cachebuster ("?cb=…", Terschelling) verandert per bezoek; dan zou elk stuk steeds nieuw zijn.
    url.searchParams.delete('cb');
    // Een link om een heel blok (<a><h3>kop</h3><p>beschrijving</p></a>, Westerveld): de tekst na de kop.
    const kopInLink = /<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/i.exec(m[4]);
    const beschrijving = kopInLink ? platteTekst(m[4].slice(kopInLink.index + kopInLink[0].length)).replace(/\s+/g, ' ').trim() : '';
    ankers.push({ url: url.href, begin: m.index, eind: m.index + m[0].length, kop: kopVan(m[4], `${m[1]} ${m[3]}`), beschrijving });
  }
  // Per stuk de eerste en laatste link; het blok van een stuk loopt van de vorige tot de volgende.
  const stukken = [];
  const perUrl = new Map();
  for (const a of ankers) {
    let s = perUrl.get(a.url);
    if (!s) {
      s = { url: a.url, begin: a.begin, eind: a.eind, kop: a.kop, beschrijving: a.beschrijving, eersteEind: a.eind, laatsteBegin: null };
      perUrl.set(a.url, s);
      stukken.push(s);
    } else {
      s.eind = a.eind;
      s.laatsteBegin = a.begin;
      if (!s.kop && a.kop) s.kop = a.kop;
      if (!s.beschrijving && a.beschrijving) s.beschrijving = a.beschrijving;
    }
  }
  // Geen bruikbare linktekst ("Meer informatie over dit woo-verzoek"): de kop vlak voor de link.
  for (const [i, s] of stukken.entries()) {
    if (s.kop) continue;
    const ervoor = tekst.slice(i ? stukken[i - 1].eind : Math.max(0, s.begin - 1500), s.begin);
    const koppen = [...ervoor.matchAll(/<h[2-5][^>]*>([\s\S]*?)<\/h[2-5]>/gi)];
    if (koppen.length) s.kop = platteTekst(koppen.at(-1)[1]) || null;
  }
  // Elke datum hoort bij de link die er het dichtst bij staat (ervoor of erna);
  // per stuk telt de dichtstbijzijnde. Zo pakt een stuk zonder leesbare datum
  // niet de datum die net achter de link van het vorige stuk staat.
  const datums = new Map();
  if (!zonderDatum && stukken.length) {
    const afstand = (s, plek) => (plek < s.begin ? s.begin - plek : plek > s.eind ? plek - s.eind : 0);
    const van = Math.max(0, stukken[0].begin - 600);
    const deel = tekst.slice(van, stukken.at(-1).eind + 600);
    for (const re of DATUMS) {
      for (const m of deel.matchAll(re)) {
        const d = datumUit(m[1]);
        if (!d) continue;
        let beste = 0;
        stukken.forEach((s, i) => { if (afstand(s, van + m.index) < afstand(stukken[beste], van + m.index)) beste = i; });
        const a = afstand(stukken[beste], van + m.index);
        if (!datums.has(beste) || a < datums.get(beste).afstand) datums.set(beste, { datum: d, afstand: a });
      }
    }
  }
  return stukken.map((s, i) => {
    if (!s.kop) return null;
    const van = i ? stukken[i - 1].eind : Math.max(0, s.begin - 600);
    const tot = i + 1 < stukken.length ? stukken[i + 1].begin : s.eind + 600;
    const blok = tekst.slice(van, tot);
    const midden = s.begin - van;
    let datum = datums.get(i)?.datum ?? null;
    // Een datum in losse stukjes ("<span>23</span> <span>okt</span> <span>2026</span>"):
    // dan in de platte tekst na de link, en anders ervoor.
    if (!datum && !zonderDatum) {
      for (const deel of [blok.slice(midden), blok.slice(0, midden)]) {
        const plat = platteTekst(deel);
        for (const re of DATUMS.slice(1)) {
          const m = new RegExp(re.source, 'i').exec(plat);
          const d = m && datumUit(m[1]);
          if (d) { datum = d; break; }
        }
        if (datum) break;
      }
    }
    // De beschrijving: in de link na de kop, tussen de kop en "Meer over …", of na de link.
    const plat = (html) => platteTekst(html).replace(/\s+/g, ' ').trim();
    const tussen = s.laatsteBegin && s.laatsteBegin - s.eersteEind < 2000 ? plat(tekst.slice(s.eersteEind, s.laatsteBegin).replace(/<a\b[\s\S]*?<\/a>/gi, ' ')) : '';
    const samenvatting = ([s.beschrijving, tussen].find((t) => t && t.length >= 40) || plat(tekst.slice(s.eind, tot))).replace(DATUM_VOORAAN, '');
    return {
      sleutel: s.url,
      titel: s.kop.slice(0, 300),
      url: s.url,
      datum,
      tekst: samenvatting && !GENERIEK.test(samenvatting) ? samenvatting.slice(0, 400) : null,
    };
  }).filter(Boolean);
}

export async function haalHtmlLijst(bron) {
  const html = await haalTekst(bron.url);
  if (!bron.via) return leesHtmlLijst(html, bron.url, bron);
  // Eerst de pagina's per jaar (de nieuwste eerst op het overzicht).
  const paginas = [...new Set(leesHtmlLijst(html, bron.url, { link: bron.via }).map((s) => s.url))].slice(0, bron.viaAantal || 2);
  if (!paginas.length) throw new Error('Geen pagina\'s per jaar gevonden op het overzicht. Is de site veranderd?');
  const uit = [];
  for (const p of paginas) uit.push(...leesHtmlLijst(await haalTekst(p), p, bron));
  return uit;
}
