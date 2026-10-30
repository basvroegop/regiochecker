// De huisstijl van de mails: Modernist, zoals de website (public/modernist.css).
// Mailclients kennen geen flexbox, grid, CSS-variabelen of color-mix(), en
// Outlook rekent met Word: daarom staat alles inline als vaste waarde, en
// bouwen we de opbouw met tabellen. De accentkleur hangt af van de titel van de
// ontvanger (LC paars, DVHN blauw); de lichtere en donkerdere tinten zijn vooraf
// uitgerekend (oklab-menging met wit en zwart, zie de handover van de mails).
// Gedeeld door de meldingsmail (src/meldingen.mjs), de weekmail (src/mail.mjs),
// de kamerstukken daarin (src/kamer/weergave.mjs) en de uitnodiging.

import { html, kort } from './html.mjs';
import { normaliseer, patroon } from './termen.mjs';

export const LETTER = 'Archivo,Arial,Helvetica,sans-serif';

const VAST = {
  inkt: '#201e1d',
  tweede: '#605d5d',
  derde: '#7d7979',
  n800: '#444141',
  n400: '#bab6b6',
  lijn: '#d6d4d3',
  kader: '#f3f2f2',
  buiten: '#e4e2e1',
};

const ACCENTEN = {
  LC: { a100: '#f1eff8', a200: '#e4dff1', a300: '#cbc1e5', a500: '#482AA5', a700: '#33187c', a800: '#250e5d' },
  DVHN: { a100: '#ebf4fc', a200: '#d9e9f8', a300: '#b2d2f1', a500: '#006ED1', a700: '#00519d', a800: '#003b75' },
};

// De kleuren voor een ontvanger; zonder (bekende) titel geldt LC.
export function stijl(titel) {
  return { ...VAST, ...(ACCENTEN[titel] || ACCENTEN.LC) };
}

// De letterfamilie staat op elke tabelcel (Outlook erft die niet door naar
// geneste tabellen) en op koppen; alles daarbinnen erft hem. Zo blijft een
// lange mail (alle stukken van veertig regio's) zo klein mogelijk.
export const FAMILIE = `font-family:${LETTER};`;
// Grootte, dikte en regelafstand als losse eigenschappen: Outlook slaat de
// verkorte `font:` over. Gewoon (400) hoeft er niet bij.
export const letter = (gewicht, grootte, regel = 1.4) => `font-size:${grootte}px;${gewicht === 400 ? '' : `font-weight:${gewicht};`}line-height:${regel};`;

const TABEL = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';
export const tabel = (inhoud, stijl = '', breed = true) => `<table ${TABEL}${breed ? ' width="100%"' : ''}${stijl ? ` style="border-collapse:collapse;${stijl}"` : ''}>${inhoud}</table>`;

// Een rij van de mail met de standaard zijmarges (op mobiel 20px, zie <style>).
export const rij = (inhoud, padding = '0 28px') => `<tr><td class="rc-p" style="padding:${padding};${FAMILIE}">${inhoud}</td></tr>`;

const datumFormaat = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
// "wo 28 okt. 09:42"
export const moment = (datum) => datumFormaat.format(datum).replace(',', '');

// ---------- het geheel ----------

// De hele mail: kop met het blokje in de accentkleur, de rijen, en de voet.
// `preheader`: de verborgen eerste tekst, die een mailprogramma naast het
// onderwerp laat zien.
export function mailHtml({ s, titel, preheader = '', rechts = '', rijen, voet }) {
  // Opvulling na de preheader, anders toont de lijst daarna de eerste tekst van de mail.
  const vulling = '&#847;&zwnj;&nbsp;'.repeat(60);
  return `<!doctype html>
<html lang="nl" xmlns="http://www.w3.org/1999/xhtml"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${html(titel)}</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;800&amp;display=swap" rel="stylesheet">
<style>
:root{color-scheme:light;supported-color-schemes:light}
body{margin:0;padding:0}
@media (max-width:480px){
  .rc-p{padding-left:20px!important;padding-right:20px!important}
  .rc-titel{font-size:22px!important}
  .rc-stapel,.rc-stapel>tbody>tr>td{display:block!important;width:auto!important}
  .rc-knop{display:block!important;margin:0 0 8px!important}
}
</style>
</head>
<body style="margin:0;padding:0;background:${s.buiten};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${s.buiten};">${html(preheader)}${vulling}</div>
${tabel(`<tr><td align="center" style="padding:24px 0;">
<table ${TABEL} width="600" style="border-collapse:collapse;table-layout:fixed;width:100%;max-width:600px;background:${s.kader};color:${s.inkt};${FAMILIE}${letter(400, 15, 1.5)}word-break:break-word;overflow-wrap:anywhere;">
${kop(s, rechts)}
${rijen.join('\n')}
${voet ? `<tr><td class="rc-p" style="padding:16px 28px 22px;border-top:2px solid ${s.inkt};${FAMILIE}${letter(400, 12, 1.6)}color:${s.tweede};">${voet}</td></tr>` : ''}
</table>
</td></tr>`, `background:${s.buiten};`)}
</body></html>`;
}

function kop(s, rechts) {
  return `<tr><td class="rc-p" style="padding:18px 28px;border-bottom:2px solid ${s.inkt};">${tabel(`<tr>
<td width="18" height="18" bgcolor="${s.a500}" style="width:18px;height:18px;background:${s.a500};font-size:0;line-height:0;">&nbsp;</td>
<td style="padding-left:10px;${FAMILIE}${letter(800, 16, 1)}color:${s.inkt};">Regiochecker</td>
<td align="right" style="${FAMILIE}${letter(400, 12, 1.4)}color:${s.tweede};">${html(rechts)}</td>
</tr>`)}</td></tr>`;
}

// ---------- onderdelen ----------

// Knoppen naast elkaar (op mobiel onder elkaar): [{ tekst, url, tweede }].
// Een cel met achtergrond, want een <a> met padding valt in Outlook weg.
export function knoppen(lijst, s) {
  const cellen = lijst.filter((k) => k.url).map((k) => (k.tweede
    ? `<td class="rc-knop" style="border:2px solid ${s.inkt};padding:10px 16px;"><a href="${html(k.url)}" style="${FAMILIE}${letter(800, 14, 1.2)}color:${s.inkt};text-decoration:none;">${html(k.tekst)}</a></td>`
    : `<td class="rc-knop" bgcolor="${s.a500}" style="background:${s.a500};padding:12px 18px;"><a href="${html(k.url)}" style="${FAMILIE}${letter(800, 14, 1.2)}color:#ffffff;text-decoration:none;">${html(k.tekst)}</a></td>`));
  if (!cellen.length) return '';
  return tabel(`<tr>${cellen.join('<td width="8" style="width:8px;font-size:0;">&nbsp;</td>')}</tr>`, '', false);
}

// Kop van een blok: "Smallingerland  21 stukken", met een dikke lijn eronder.
// De kop zelf bevat alleen de naam (het aantal staat ernaast), zodat de tekst
// van een <h2> ook voor een schermlezer gewoon de naam is.
export function sectieKop(tag, tekst, bij, s, grootte = 20) {
  return `<div style="padding:0 0 8px;border-bottom:2px solid ${s.inkt};"><${tag} style="display:inline;margin:0;${FAMILIE}${letter(800, grootte, 1.2)}color:${s.inkt};">${html(tekst)}</${tag}>${bij ? ` <span style="${letter(400, 13, 1.2)}color:${s.tweede};">&nbsp;${html(bij)}</span>` : ''}</div>`;
}

// Kop van een categorie in de weekmail: klein, hoofdletters, accentkleur.
export function categorieKop(tekst, aantal, s) {
  const klein = `${letter(600, 11, 1.3)}letter-spacing:.08em;text-transform:uppercase;`;
  return `<div style="margin:22px 0 0;padding:0 0 6px;border-bottom:1px solid ${s.n400};"><h3 style="display:inline;margin:0;${FAMILIE}${klein}color:${s.a700};">${html(tekst)}</h3>${aantal ? ` <span style="${klein}color:${s.derde};">(${aantal})</span>` : ''}</div>`;
}

// Een stuk in een lijst (weekmail): een metaregel (soort, datum, het
// sleutelwoord als label), de titel als link, de kenmerken, en eventueel een
// klein fragmentblok. Een lijn eronder scheidt de stukken.
export function itemRij({ soort, datum, labels = [], titel, url, kenmerken, fragmenten = [], tijdcode = null, na = '' }, s) {
  const meta = [soort && `<span style="font-weight:600;color:${s.inkt};">${html(soort)}</span>`, datum && html(datum), ...labels.map((l) => label(l, s))].filter(Boolean).join('&nbsp;&nbsp; ');
  return `<tr><td style="padding:10px 0;border-bottom:1px solid ${s.lijn};${FAMILIE}color:${s.inkt};">${meta ? `<div style="font-size:12px;line-height:1.6;color:${s.tweede};">${meta}</div>` : ''}<div style="margin-top:3px;font-size:15px;font-weight:600;line-height:1.35;"><a href="${html(url)}" style="color:${s.inkt};text-decoration:none;">${html(titel)}</a></div>${kenmerken ? `<div style="margin-top:2px;font-size:13px;line-height:1.45;color:${s.tweede};">${html(kenmerken)}</div>` : ''}${fragmenten.length ? `<div style="margin-top:8px;">${fragmentBlok(fragmenten, s, { klein: true, tijdcode })}</div>` : ''}${na}</td></tr>`;
}

export const lijst = (rijen) => (rijen.length ? tabel(rijen.join('')) : '');

// Grijze regel (Geen nieuwe berichten, opmerkingen bij een bron).
export const zacht = (tekst, s, marge = '10px 0 0') => `<p style="margin:${marge};${letter(400, 13, 1.5)}color:${s.tweede};">${tekst}</p>`;

// Een label in de accentkleur, voor het sleutelwoord waardoor een stuk erin staat.
export const label = (tekst, s) => `<span style="background:${s.a200};color:${s.a800};font-weight:600;padding:0 6px;">${html(tekst)}</span>`;

// Fragment met de treffer gemarkeerd. Eerst ontsnappen, dan markeren. In een
// fragmentblok donker (accent-700), in lopende tekst licht (accent-200).
// Geen <mark>: dat negeren sommige clients.
export function fragmentHtml({ tekst, treffer }, s, { max = 400 } = {}) {
  const veilig = html(kort(tekst, max));
  const t = html(treffer || '');
  const i = t ? veilig.indexOf(t) : -1;
  if (i < 0) return veilig;
  return `${veilig.slice(0, i)}<span style="background:${s.a700};color:#ffffff;font-weight:600;padding:0 3px;">${t}</span>${veilig.slice(i + t.length)}`;
}

// Het fragmentblok: een vlak in de lichtste accenttint, hooguit twee
// fragmenten, gescheiden door een dunne lijn. Bij audio de tijd vet ervoor.
// [{ fragment, tijd }]
export function fragmentBlok(fragmenten, s, { klein = false, tijdcode = null } = {}) {
  if (!fragmenten.length) return '';
  const grootte = klein ? 13 : 14;
  const delen = fragmenten.map((f, i) => `<div${i ? ` style="margin-top:10px;padding-top:10px;border-top:1px solid ${s.a300};"` : ''}>${f.tijd !== undefined && tijdcode ? `<strong>${tijdcode(f.tijd)}</strong> ` : ''}${fragmentHtml(f.fragment, s)}${f.bij ? ` <span style="color:${s.tweede};">${html(f.bij)}</span>` : ''}</div>`);
  return tabel(`<tr><td style="background:${s.a100};border:2px solid ${s.a300};padding:${klein ? '8px 10px' : '14px 16px'};${FAMILIE}${letter(400, grootte, 1.55)}color:${s.inkt};">${delen.join('')}</td></tr>`);
}

// Alle plekken van de termen in een stuk lopende tekst licht markeren
// (hoofdletters en accenten tellen niet, zoals bij het zoeken).
export function markeerTermen(tekst, termen, s) {
  const norm = normaliseer(tekst);
  const stukken = [];
  for (const term of termen || []) {
    const re = patroon(term);
    if (!re) continue;
    for (const m of norm.matchAll(re)) stukken.push([m.index, m.index + m[0].length]);
  }
  if (!stukken.length) return html(tekst);
  stukken.sort((a, b) => a[0] - b[0]);
  let uit = '';
  let plek = 0;
  for (const [van, tot] of stukken) {
    if (van < plek) continue;
    uit += `${html(tekst.slice(plek, van))}<span style="background:${s.a200};color:${s.inkt};font-weight:600;padding:0 2px;">${html(tekst.slice(van, tot))}</span>`;
    plek = tot;
  }
  return uit + html(tekst.slice(plek));
}

// Een link in de accentkleur (in de voet, of "Alle 21 stukken uit … →").
export const link = (tekst, url, s, extra = '') => `<a href="${html(url)}" style="color:${s.a700};text-decoration:underline;${extra}">${html(tekst)}</a>`;
