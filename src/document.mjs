// De tekst van een stuk als blokken, voor "Uit het document" in het leespaneel:
//   ['k', tekst]  een kop
//   ['p', tekst]  een alinea (mag regeleinden bevatten, zoals een adres)
//   ['l', tekst]  een opsommingspunt
//   ['d', naam]   het begin van een volgend document (een bijlage)
//
// HTML heeft zijn eigen structuur. Een pdf niet: pdftotext geeft regels zoals
// ze op de pagina staan, met lang niet altijd een witregel tussen alinea's.
// Een regel die duidelijk korter is dan de rest en een zin afsluit (of waarna
// een hoofdletter volgt), sluit daarom een alinea af. Is de "regel" veel langer
// dan een pdf-regel ooit is (Word, of een al platgeslagen tekst), dan is elke
// regel een alinea.

import { ontsnap } from './html.mjs';

export const MAX_DOCUMENT = 300_000;

const INLINE = /^(a|abbr|b|bdi|bdo|cite|code|data|dfn|em|font|i|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var|wbr)$/i;
const BLOK = /^(p|div|section|article|blockquote|ul|ol|dl|dt|dd|table|thead|tbody|tfoot|tr|figure|figcaption|address|pre|hr|main|header|footer|aside|nav|form|fieldset|details|summary)$/i;
const KOP = '\u0001K';
const PUNT = '\u0001L';

const regelSchoon = (r) => r.replace(/[ \t ]+/g, ' ').trim();

// Blokken uit (het hoofdgedeelte van) een HTML-pagina.
export function htmlBlokken(html) {
  const tekst = ontsnap(String(html ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (tag, naam) => {
      const sluit = tag[1] === '/';
      if (/^h[1-6]$/i.test(naam)) return sluit ? '\n\n' : `\n\n${KOP}`;
      if (/^li$/i.test(naam)) return sluit ? '\n\n' : `\n\n${PUNT}`;
      if (/^t[dh]$/i.test(naam)) return ' ';
      if (BLOK.test(naam)) return '\n\n';
      return INLINE.test(naam) ? '' : ' ';
    })
    .replace(/<[^>]*>/g, ' '));
  const blokken = [];
  let soort = null;
  for (const ruw of tekst.split(/\n[ \t ]*\n\s*/)) {
    let stuk = ruw;
    // Een <li> met een <p> erin: het teken staat dan in een eigen leeg blok.
    while (stuk.trimStart().startsWith(KOP) || stuk.trimStart().startsWith(PUNT)) {
      stuk = stuk.trimStart();
      soort = stuk.startsWith(KOP) ? 'k' : 'l';
      stuk = stuk.slice(2);
    }
    const inhoud = stuk.split('\n').map(regelSchoon).filter(Boolean).join('\n');
    if (!inhoud) continue;
    blokken.push([soort || 'p', soort === 'k' ? inhoud.replace(/\n/g, ' ') : inhoud]);
    soort = null;
  }
  return blokken;
}

const OPSOMMING = /^[•▪●◦‣∙·■□➢➤►✓\-–—*]\s+(.+)$/;
const NUMMER = /^(\(?\d{1,3}[.)]|\(?[a-z][.)]|[ivx]{1,4}[.)])\s+\S/i;
const PAGINANUMMER = /^(\d{1,4}|(pagina|blad|bladnr\.?|page)\s*\d+(\s*(van|\/|of)\s*\d+)?|\d+\s*\/\s*\d+|-\s*\d+\s*-)$/i;
const ZINSEINDE = /[.!?:;]["'”’)\]]*$/;
const LOS_TEKEN = /^([•▪●◦‣∙·■□➢➤►✓\-–—*]|\(?\d{1,2}[.)]|\(?[a-z][.)])$/i;
const DATUM = /\b\d{1,2} (januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december) \d{4}\b/i;
const BRIEFKOP = /^(datum|ons kenmerk|uw kenmerk|kenmerk|bladnr|pagina|onderwerp|telefoon|e-?mail|internet|postbus|bijlagen?|behandeld door|verzonden)\b/i;
const NIEUW_BEGIN = /^[\p{Lu}\d•▪●◦‣∙·■□➢➤►✓(“"'‘\-–—*]/u;

// Blokken uit platte tekst: een pdf, een docx, of een al platgeslagen tekst.
export function tekstBlokken(tekst) {
  const regels = String(tekst ?? '').replace(/\r\n?/g, '\n').replace(/\f/g, '\n\n').split('\n').map(regelSchoon);
  const lengtes = regels.filter(Boolean).map((r) => r.length).sort((a, b) => a - b);
  const breedte = lengtes.length ? lengtes[Math.floor((lengtes.length - 1) * 0.9)] : 0;
  const alineaPerRegel = breedte > 140;
  const blokken = [];
  let huidig = null;
  // Een opsommingsteken of nummer op een eigen regel hoort bij de regel erna.
  let los = null;
  const sluit = () => {
    if (huidig) blokken.push([huidig.soort, huidig.delen.join(' '), huidig.delen.length]);
    huidig = null;
  };
  for (let i = 0; i < regels.length; i++) {
    const r = regels[i];
    if (!r) { sluit(); continue; }
    // Alleen als er meteen tekst volgt: een los streepje in de kop van een brief betekent "geen".
    if (LOS_TEKEN.test(r) && regels[i + 1]) {
      sluit();
      // Twee losse tekens na elkaar (pdftotext zet een kolom nummers apart): niets weggooien.
      if (los) blokken.push(['p', los, 1]);
      los = /^\(?[\da-z]/i.test(r) ? r : '•';
      continue;
    }
    if (PAGINANUMMER.test(r)) { sluit(); continue; }
    const punt = OPSOMMING.exec(r);
    if (los) {
      sluit();
      huidig = los === '•' ? { soort: 'l', delen: [r] } : { soort: 'p', delen: [`${los} ${r}`] };
      los = null;
    } else if (punt || NUMMER.test(r)) {
      sluit();
      huidig = { soort: punt ? 'l' : 'p', delen: [punt ? punt[1] : r] };
    } else if (huidig && !alineaPerRegel) {
      huidig.delen.push(r);
    } else {
      sluit();
      huidig = { soort: 'p', delen: [r] };
    }
    if (alineaPerRegel) { sluit(); continue; }
    const volgende = regels[i + 1] || '';
    if (r.length < breedte * 0.75 && (ZINSEINDE.test(r) || NIEUW_BEGIN.test(volgende))) sluit();
  }
  sluit();
  // Een korte losse regel zonder leesteken, gevolgd door een lange alinea, is
  // een kop; behalve de vaste regels uit de kop van een brief.
  const kop = (blok, volgende) => blok[0] === 'p' && blok[2] === 1 && blok[1].length <= 80 && !/[.,:;!]$/.test(blok[1])
    && !BRIEFKOP.test(blok[1]) && !DATUM.test(blok[1]) && volgende && volgende[0] !== 'k' && volgende[1].length >= 100;
  const uit = [];
  blokken.forEach((blok, i) => {
    if (kop(blok, blokken[i + 1])) return uit.push(['k', blok[1]]);
    // Opeenvolgende korte regels (een adres, de kop van een brief) blijven bij elkaar.
    const vorige = uit.at(-1);
    const kortBlok = blok[0] === 'p' && blok[2] === 1 && blok[1].length <= 60;
    if (kortBlok && vorige?.kort) {
      vorige[1] += `\n${blok[1]}`;
      return null;
    }
    const nieuw = [blok[0], blok[1]];
    if (kortBlok) Object.defineProperty(nieuw, 'kort', { value: true });
    return uit.push(nieuw);
  });
  return uit;
}

// Platte tekst van de blokken, voor het taalmodel: documenten gescheiden door " || ".
export function platVan(blokken) {
  const delen = [[]];
  for (const [soort, tekst] of blokken || []) {
    if (soort === 'd') delen.push([]);
    else delen.at(-1).push(tekst);
  }
  return delen.map((d) => d.join(' ').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' || ');
}

export const tekens = (blokken) => (blokken || []).reduce((n, [, t]) => n + t.length, 0);

// Hooguit `max` tekens; geeft { blokken, volledig }.
export function begrens(blokken, max = MAX_DOCUMENT) {
  const uit = [];
  let n = 0;
  for (const blok of blokken) {
    if (n + blok[1].length > max) {
      const rest = max - n;
      if (rest > 200 && blok[0] !== 'd') uit.push([blok[0], `${blok[1].slice(0, rest).replace(/\s+\S*$/, '')}…`]);
      return { blokken: uit, volledig: false };
    }
    uit.push(blok);
    n += blok[1].length;
  }
  return { blokken: uit, volledig: true };
}
