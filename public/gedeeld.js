// Gedeelde hulpjes voor de webUI-pagina's (index.html en kamerstukken.html).

export const $ = (sel, ouder = document) => ouder.querySelector(sel);
export const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));


let sessieVerlopen = false;

// Authelia stuurt een verzoek zonder geldige sessie door naar de inlogpagina. Bij
// een fetch willen we dat niet volgen (dat mislukt op CORS), maar de hele pagina
// opnieuw laden, zodat de gebruiker netjes bij het inlogscherm uitkomt.
function sessieIsVerlopen() {
  if (sessieVerlopen) return;
  sessieVerlopen = true;
  meld('Je sessie is verlopen; je wordt naar het inlogscherm gestuurd…', 'fout');
  setTimeout(() => location.reload(), 1500);
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
    throw new Error('Sessie verlopen');
  }
  const soort = antwoord.headers.get('content-type') || '';
  const inhoud = soort.includes('json') ? await antwoord.json() : await antwoord.text();
  if (!antwoord.ok) throw new Error(inhoud?.fout || `HTTP ${antwoord.status}`);
  return inhoud;
}

export function meld(tekst, soort = 'ok') {
  const el = document.createElement('div');
  el.className = `melding ${soort}`;
  el.textContent = tekst;
  $('#meldingen').append(el);
  setTimeout(() => el.remove(), soort === 'fout' ? 9000 : 4000);
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

export async function bezig(knop, taak) {
  const oud = knop.textContent;
  knop.disabled = true;
  knop.textContent = 'Bezig…';
  try {
    return await taak();
  } catch (fout) {
    meld(fout.message, 'fout');
  } finally {
    knop.disabled = false;
    knop.textContent = oud;
  }
}

export const tijd = (iso) => iso
  ? new Date(iso).toLocaleString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '–';

export const korteDatum = (d) => d
  ? new Date(`${d}T12:00:00`).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' })
  : 'z.d.';

// ---------- tekenen ----------
