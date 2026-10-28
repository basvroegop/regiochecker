// Kleine hulpjes om tekst uit HTML te halen. Bewust zonder parserbibliotheek:
// de bronnen hebben elk een vaste, eenvoudige lijststructuur en de parsers per
// site (src/bronnen/) zijn met echte pagina's uit test/fixtures getest.

const ENTITEITEN = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bdquo: '„', sbquo: '‚',
  ndash: '–', mdash: '—', hellip: '…', euro: '€', middot: '·', bull: '•',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', aacute: 'á', agrave: 'à',
  acirc: 'â', auml: 'ä', iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï',
  oacute: 'ó', ograve: 'ò', ocirc: 'ô', ouml: 'ö', uacute: 'ú', ugrave: 'ù',
  ucirc: 'û', uuml: 'ü', ccedil: 'ç', ntilde: 'ñ', Eacute: 'É', Euml: 'Ë',
  Ouml: 'Ö', Uuml: 'Ü', Acirc: 'Â', Ucirc: 'Û', Ocirc: 'Ô', Icirc: 'Î',
  Ecirc: 'Ê', szlig: 'ß', copy: '©', reg: '®', deg: '°', shy: '',
};

export function ontsnap(tekst) {
  return String(tekst ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (heel, code) => {
    if (code[0] === '#') {
      const getal = code[1] === 'x' || code[1] === 'X'
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      return Number.isFinite(getal) ? String.fromCodePoint(getal) : heel;
    }
    return ENTITEITEN[code] ?? heel;
  });
}

// Tags eruit, entiteiten omgezet, witruimte samengevoegd.
export function platteTekst(html) {
  return ontsnap(String(html ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h\d|tr)>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// Voor in een e-mail of de webUI: alles wat uit een bron komt gaat hierdoorheen.
export function html(tekst) {
  return String(tekst ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function absoluut(href, basis) {
  try {
    return new URL(ontsnap(href).trim(), basis).href;
  } catch {
    return null;
  }
}

export function kort(tekst, max) {
  const t = String(tekst ?? '').trim();
  if (t.length <= max) return t;
  const knip = t.slice(0, max);
  const spatie = knip.lastIndexOf(' ');
  return (spatie > max * 0.6 ? knip.slice(0, spatie) : knip) + '…';
}

// De lopende tekst van een artikelpagina, voor de samenvatting die Claude te zien
// krijgt. Pakt <main> (of het element met role="main") en laat menu's, kop- en
// voetteksten en formulieren weg.
export function hoofdtekst(pagina, max = 1500) {
  let stuk = String(pagina ?? '');
  let start = stuk.search(/<main\b|role=["']main["']/i);
  if (start >= 0) {
    // Bij role="main" terug naar het begin van de tag, anders blijft de rest
    // van de tag als tekst staan.
    start = stuk.lastIndexOf('<', start);
    stuk = stuk.slice(start);
    const eind = stuk.search(/<\/main>|<footer\b/i);
    if (eind > 0) stuk = stuk.slice(0, eind);
  } else {
    const body = stuk.search(/<body\b/i);
    if (body >= 0) stuk = stuk.slice(body);
  }
  stuk = stuk.replace(/<(nav|header|footer|form|aside|button|select)\b[\s\S]*?<\/\1>/gi, ' ');
  return kort(platteTekst(stuk), max);
}
