// Gedeelde hulpjes voor de webUI: verzoeken aan de API, ontsnappen, iconen,
// tijden en datums, meldingen in beeld en lange taken op de achtergrond.

export const $ = (sel, ouder = document) => ouder.querySelector(sel);
export const $$ = (sel, ouder = document) => [...ouder.querySelectorAll(sel)];
export const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- API ----------

let sessieVerlopen = false;

// Authelia stuurt een verzoek zonder geldige sessie door naar de inlogpagina. Bij
// een fetch willen we dat niet volgen (dat mislukt op CORS), maar de hele pagina
// opnieuw laden, zodat de gebruiker netjes bij het inlogscherm uitkomt.
function sessieIsVerlopen() {
  if (sessieVerlopen) return;
  sessieVerlopen = true;
  toast('Je sessie is verlopen; je wordt naar het inlogscherm gestuurd…', 'fout');
  setTimeout(() => location.reload(), 1500);
}

export class ApiFout extends Error {
  constructor(bericht, status) { super(bericht); this.status = status; }
}

export async function vraag(methode, pad, data) {
  const opties = { method: methode, headers: { 'X-Requested-With': 'XMLHttpRequest' }, redirect: 'manual' };
  if (data !== undefined) {
    opties.headers['Content-Type'] = 'application/json';
    opties.body = JSON.stringify(data);
  }
  const antwoord = await fetch(pad, opties);
  if (antwoord.type === 'opaqueredirect' || antwoord.status === 401) {
    sessieIsVerlopen();
    throw new ApiFout('Sessie verlopen', 401);
  }
  const soort = antwoord.headers.get('content-type') || '';
  const inhoud = soort.includes('json') ? await antwoord.json() : await antwoord.text();
  if (!antwoord.ok) throw new ApiFout(inhoud?.fout || `HTTP ${antwoord.status}`, antwoord.status);
  return inhoud;
}

// Lange acties draaien op de server als taak (een samenvatting via Ollama duurt
// minuten; Cloudflare breekt een gewoon verzoek na 100 seconden af). We starten
// de taak en vragen daarna om de paar seconden hoe het ervoor staat.
export async function voerUit(soort, invoer, opVoortgang) {
  let taak = await vraag('POST', `/api/taken/${soort}`, invoer);
  let wacht = 400;
  while (taak.status === 'bezig') {
    await new Promise((klaar) => setTimeout(klaar, wacht));
    wacht = 2000;
    taak = await vraag('GET', `/api/taken/${taak.id}`);
    if (taak.voortgang?.tekst) opVoortgang?.(taak.voortgang.tekst);
  }
  if (taak.status === 'fout') throw new Error(taak.fout);
  return taak.resultaat;
}

// ---------- in beeld ----------

export function toast(tekst, soort = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${soort}`;
  el.textContent = tekst;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), soort === 'fout' ? 9000 : 4000);
}

// Knop uitzetten zolang de actie loopt; fouten als melding.
export async function bezig(knop, actie, tekst = 'Bezig…') {
  const oud = knop.innerHTML;
  knop.disabled = true;
  knop.textContent = tekst;
  try {
    return await actie((t) => { knop.textContent = t; });
  } catch (fout) {
    if (fout.status !== 401) toast(fout.message, 'fout');
    return undefined;
  } finally {
    knop.disabled = false;
    knop.innerHTML = oud;
  }
}

// Lucide-iconen, inline.
const PADEN = {
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  filter: '<path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>',
  star: '<polygon class="ster-vorm" points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  'arrow-up-right': '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  pencil: '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="m15 5 4 4"/>',
  download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
};
const GEVULD = {
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  pause: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
};

export function icoon(naam, grootte = 16, dikte = 2) {
  if (GEVULD[naam]) return `<svg class="icoon" width="${grootte}" height="${grootte}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${GEVULD[naam]}</svg>`;
  return `<svg class="icoon" width="${grootte}" height="${grootte}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${dikte}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PADEN[naam] || ''}</svg>`;
}

// ---------- tijd en datum ----------

const DAGEN_LANG = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
export const DAGEN_KORT = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'];

const dagStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export function dagKop(iso) {
  const d = new Date(iso);
  const verschil = Math.round((dagStart(new Date()) - dagStart(d)) / 86400000);
  const datum = `${DAGEN_LANG[d.getDay()]} ${d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long' })}`;
  if (verschil === 0) return `Vandaag · ${datum}`;
  if (verschil === 1) return `Gisteren · ${datum}`;
  return d.getFullYear() === new Date().getFullYear() ? datum : `${datum} ${d.getFullYear()}`;
}

export const uurMinuut = (iso) => (iso ? new Date(iso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }) : '');

// "Vandaag 09:42", "gisteren 17:12", "di 20 okt. 09:00"
export function moment(iso, { metTijd = true } = {}) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
  const verschil = Math.round((dagStart(new Date()) - dagStart(d)) / 86400000);
  const tijd = metTijd ? ` ${uurMinuut(iso)}` : '';
  if (verschil === 0) return `Vandaag${tijd}`;
  if (verschil === 1) return `Gisteren${tijd}`;
  return `${d.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) })}${tijd}`;
}

export function geledenTekst(iso) {
  if (!iso) return 'uitgenodigd';
  const d = new Date(iso);
  const verschil = Math.round((dagStart(new Date()) - dagStart(d)) / 86400000);
  if (verschil === 0) return `vandaag ${uurMinuut(iso)}`;
  if (verschil === 1) return 'gisteren';
  if (verschil < 14) return `${verschil} dagen geleden`;
  return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
}

export function tijdcode(seconden) {
  const t = Math.max(0, Math.floor(Number(seconden) || 0));
  const u = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  const s = t % 60;
  return u ? `${u}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function duurTekst(seconden) {
  if (!seconden) return '';
  const u = Math.floor(seconden / 3600);
  const m = Math.round((seconden % 3600) / 60);
  return u ? `${u} u ${m} min` : `${m} min`;
}

export const weekmailTekst = (w) => (w?.aan ? `${(w.dagen || []).map((d) => DAGEN_KORT[d - 1]).join(', ')} ${w.tijd}` : 'Uit');

// Een fragment met de treffer gemarkeerd: eerst ontsnappen, dan markeren.
export function markeer(tekst, treffer) {
  const veilig = esc(tekst);
  const t = esc(treffer || '');
  const i = t ? veilig.indexOf(t) : -1;
  if (i < 0) return veilig;
  return `${veilig.slice(0, i)}<mark>${t}</mark>${veilig.slice(i + t.length)}`;
}

// Alle termen in een tekst markeren (hoofdletters en accenten tellen niet).
export function markeerTermen(tekst, termen) {
  const veilig = esc(tekst);
  const lijst = termen.filter(Boolean);
  if (!lijst.length) return veilig;
  const zonder = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const plat = zonder(tekst);
  const posities = [];
  for (const term of lijst) {
    const delen = zonder(term).split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!delen.length) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${delen.join('[^\\p{L}\\p{N}]+')}(?![\\p{L}\\p{N}])`, 'gu');
    for (const m of plat.matchAll(re)) posities.push([m.index, m.index + m[0].length]);
  }
  if (!posities.length) return veilig;
  posities.sort((a, b) => a[0] - b[0]);
  // Alleen als de platte tekst even lang is als het origineel kloppen de posities.
  if (plat.length !== tekst.length) return veilig;
  let uit = '';
  let vanaf = 0;
  for (const [begin, eind] of posities) {
    if (begin < vanaf) continue;
    uit += esc(tekst.slice(vanaf, begin)) + `<mark>${esc(tekst.slice(begin, eind))}</mark>`;
    vanaf = eind;
  }
  return uit + esc(tekst.slice(vanaf));
}

// ---------- voorbeeld van de mail ----------

let voorbeeldVoor = null;

async function laadVoorbeeld(samenvatting = false) {
  const dialoog = $('#voorbeeld');
  const frame = $('#voorbeeld-frame');
  const onderwerp = $('#voorbeeld-onderwerp');
  onderwerp.textContent = samenvatting ? 'Samenvatting maken…' : 'Bezig…';
  try {
    const r = await voerUit('voorbeeld', { gebruiker: voorbeeldVoor.id, dagen: Number($('#voorbeeld-dagen').value), samenvatting }, (t) => { onderwerp.textContent = t; });
    onderwerp.textContent = r.onderwerp;
    frame.srcdoc = r.html;
  } catch (fout) {
    onderwerp.textContent = '';
    if (dialoog.open) toast(fout.message, 'fout');
  }
}

export function toonVoorbeeld(gebruiker, { magVersturen = false } = {}) {
  voorbeeldVoor = gebruiker;
  $('#voorbeeld-frame').srcdoc = '';
  $('#voorbeeld-verstuur').hidden = !magVersturen;
  $('#voorbeeld').showModal();
  laadVoorbeeld();
}

export function koppelVoorbeeld() {
  $('#voorbeeld-sluit').addEventListener('click', () => $('#voorbeeld').close());
  $('#voorbeeld-dagen').addEventListener('change', () => laadVoorbeeld());
  $('#voorbeeld-samenvatting').addEventListener('click', (e) => bezig(e.currentTarget, () => laadVoorbeeld(true)));
  $('#voorbeeld-verstuur').addEventListener('click', (e) => bezig(e.currentTarget, async (zet) => {
    const r = await voerUit('verstuur', { gebruiker: voorbeeldVoor.id }, zet);
    toast(r.verstuurd ? `Verstuurd: ${r.onderwerp}` : 'Niet verstuurd: niets nieuws');
  }, 'Versturen…'));
}
