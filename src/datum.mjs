// Datums uit de bronnen komen in allerlei vormen binnen: "20 oktober 2026",
// "9-10-2026", "2026-10-19 14:11:39" of een RSS-datum. Alles wordt een
// kalenderdatum JJJJ-MM-DD in Nederlandse tijd; de tijd van de dag gebruiken we niet.

const MAANDEN = {
  januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6, juli: 7,
  augustus: 8, september: 9, oktober: 10, november: 11, december: 12,
  jan: 1, feb: 2, mrt: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  okt: 10, nov: 11, dec: 12,
};

const twee = (n) => String(n).padStart(2, '0');

function geldig(j, m, d) {
  if (!(j > 1990 && j < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  return `${j}-${twee(m)}-${twee(d)}`;
}

export function lokaleDatum(datum = new Date()) {
  return `${datum.getFullYear()}-${twee(datum.getMonth() + 1)}-${twee(datum.getDate())}`;
}

export function leesDatum(tekst) {
  if (!tekst) return null;
  const t = String(tekst).trim().toLowerCase();

  // RSS-datum ("Mon, 19 Oct 2026 15:47:00 +0200"): eerst naar lokale tijd, anders
  // valt een bericht van 23.30 uur UTC op de verkeerde dag.
  if (/^[a-z]{3}, /.test(t)) {
    const ms = Date.parse(tekst);
    if (Number.isFinite(ms)) return lokaleDatum(new Date(ms));
  }

  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t]|$)/);
  if (m && !/[zt+]/.test(t.slice(10))) return geldig(+m[1], +m[2], +m[3]);

  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return geldig(+m[3], +m[2], +m[1]);

  m = t.match(/(\d{1,2})\s+([a-z]+)\.?\s+(\d{4})/);
  if (m && MAANDEN[m[2]]) return geldig(+m[3], MAANDEN[m[2]], +m[1]);

  // RSS (RFC 822) en ISO met tijdzone: via Date, en dan terug naar lokale tijd.
  const ms = Date.parse(tekst);
  if (Number.isFinite(ms)) return lokaleDatum(new Date(ms));
  return null;
}

export function dagenGeleden(isoDatum, nu = new Date()) {
  if (!isoDatum) return null;
  const [j, m, d] = isoDatum.split('-').map(Number);
  const dan = new Date(j, m - 1, d);
  const vandaag = new Date(nu.getFullYear(), nu.getMonth(), nu.getDate());
  return Math.round((vandaag - dan) / 86400000);
}

const DAGNAMEN = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
const MAANDNAMEN = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

// "di 20 okt"
export function korteDatum(isoDatum) {
  if (!isoDatum) return '';
  const [j, m, d] = isoDatum.split('-').map(Number);
  const dan = new Date(j, m - 1, d);
  return `${DAGNAMEN[dan.getDay()]} ${d} ${MAANDNAMEN[m - 1]}`;
}
