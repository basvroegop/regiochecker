// Zoekpagina voor kamerstukken, plus de meldingen op termen.

import { $, esc, vraag, meld, bezig, tijd, korteDatum } from './gedeeld.js';

const MARK_BEGIN = '\u0001';
const MARK_EIND = '\u0002';
const formulier = $('#zoekformulier');
let status = null;

// Fragment uit de zoekindex: eerst ontsnappen, dan de markeringen omzetten.
const fragment = (f) => esc(f).replaceAll(MARK_BEGIN, '<mark>').replaceAll(MARK_EIND, '</mark>');

function tekenStatus() {
  $('#vanaf').textContent = korteDatum(status.vanaf);
  const delen = [
    `<strong>${status.totaal || 0}</strong> stukken, ${status.metTekst || 0} met volledige tekst`,
    status.wachtrij ? `${status.wachtrij} teksten nog in de wachtrij` : null,
    `nieuwste ${esc(korteDatum(status.nieuwste))}`,
    `bijgewerkt ${esc(tijd(status.laatsteSync))}`,
  ].filter(Boolean);
  $('#statusbalk').innerHTML = delen.join(' · ')
    + (status.ronde && !status.ronde.ok ? `<div class="waarschuwing">Laatste ronde mislukt: ${esc(status.ronde.fout)}</div>` : '');
  const keuze = formulier.soort;
  if (keuze.options.length === 1) {
    keuze.insertAdjacentHTML('beforeend', status.soorten.map((s) => `<option value="${esc(s.soort)}">${esc(s.soort)} (${s.aantal})</option>`).join(''));
  }
}

function zoekParameters() {
  const p = new URLSearchParams();
  for (const naam of ['q', 'soort', 'van', 'tot', 'sorteer']) {
    const w = formulier[naam].value.trim();
    if (w && !(naam === 'sorteer' && w === 'relevantie')) p.set(naam, w);
  }
  return p;
}

async function zoek(pagina = 1) {
  const p = zoekParameters();
  if (pagina > 1) p.set('pagina', pagina);
  history.replaceState(null, '', `?${p}${location.hash}`);
  const r = await vraag('GET', `/api/kamer/zoek?${p}`);
  const aantalPaginas = Math.ceil(r.totaal / 20);
  $('#resultaten').innerHTML = `
    <p class="klein">${r.totaal} ${r.totaal === 1 ? 'stuk' : 'stukken'}${r.aangepast ? ` (zoekvraag niet begrepen; gezocht op ${esc(r.vraag)})` : ''}${aantalPaginas > 1 ? ` · pagina ${pagina} van ${aantalPaginas}` : ''}</p>
    ${r.resultaten.map((s) => `
      <article class="resultaat">
        <h3><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.onderwerp || s.titel || s.nummer)}</a></h3>
        <div class="klein">${esc(korteDatum(s.datum))} · ${esc(s.soort || '')}${s.dossier ? ` · dossier ${esc(s.dossier)}${s.dossiertitel ? ` (${esc(s.dossiertitel)})` : ''}` : ''}${s.afzender ? ` · ${esc(s.afzender)}` : ''} · <a href="${esc(s.download)}" target="_blank" rel="noopener">document</a>${s.tekststatus ? '' : ' · <em>tekst nog niet binnen</em>'}</div>
        ${s.fragment ? `<p class="fragment">${fragment(s.fragment)}</p>` : ''}
      </article>`).join('')}
    ${aantalPaginas > 1 ? `<div class="paginering">
      <button class="knop licht klein" data-pagina="${pagina - 1}" ${pagina <= 1 ? 'disabled' : ''}>← Vorige</button>
      <button class="knop licht klein" data-pagina="${pagina + 1}" ${pagina >= aantalPaginas ? 'disabled' : ''}>Volgende →</button>
    </div>` : ''}`;
}

formulier.addEventListener('submit', (e) => {
  e.preventDefault();
  zoek().catch((f) => meld(f.message, 'fout'));
});
for (const naam of ['soort', 'van', 'tot', 'sorteer']) formulier[naam].addEventListener('change', () => zoek().catch((f) => meld(f.message, 'fout')));
$('#resultaten').addEventListener('click', (e) => {
  const knop = e.target.closest('[data-pagina]');
  if (knop) zoek(Number(knop.dataset.pagina)).then(() => scrollTo(0, 0)).catch((f) => meld(f.message, 'fout'));
});

// ---------- meldingen ----------

async function tekenMeldingen() {
  const lijst = await vraag('GET', '/api/kamer/meldingen');
  $('#meldingen-lijst tbody').innerHTML = lijst.length
    ? lijst.map((m) => `<tr data-id="${esc(m.id)}">
        <td>${esc(m.naam || '–')}</td>
        <td>${esc(m.email)}</td>
        <td>${m.termen.map(esc).join(', ')}</td>
        <td>${m.frequentie === 'dagelijks' ? 'Dagelijks' : 'Direct'}</td>
        <td>${m.actief ? 'Ja' : 'Nee'}</td>
        <td class="klein">${esc(tijd(m.laatsteMelding))}${m.laatsteFout ? `<span class="waarschuw-tekst">${esc(m.laatsteFout)}</span>` : ''}</td>
        <td class="acties">
          <button class="knop licht klein" data-actie="voorbeeld">Voorbeeld</button>
          <button class="knop licht klein" data-actie="bewerk">Bewerken</button>
          <button class="knop gevaar klein" data-actie="verwijder" aria-label="Verwijderen">×</button>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="7" class="leeg">Nog geen meldingen.</td></tr>';
  return lijst;
}

function vulFormulier(m) {
  const f = $('#form-melding');
  f.id.value = m?.id || '';
  f.naam.value = m?.naam || '';
  f.email.value = m?.email || '';
  f.termen.value = (m?.termen || []).join('\n');
  f.frequentie.value = m?.frequentie || 'direct';
  f.actief.checked = m ? m.actief : true;
  $('#melding-kop').textContent = m?.id ? 'Melding bewerken' : 'Nieuwe melding';
  $('#melding-annuleer').hidden = !m?.id;
}

$('#form-melding').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  bezig($('button.knop:not(.licht)', f), async () => {
    const data = { naam: f.naam.value, email: f.email.value, termen: f.termen.value.split('\n'), frequentie: f.frequentie.value, actief: f.actief.checked };
    if (f.id.value) await vraag('PUT', `/api/kamer/meldingen/${f.id.value}`, data);
    else await vraag('POST', '/api/kamer/meldingen', data);
    meld('Melding bewaard');
    vulFormulier(null);
    await tekenMeldingen();
  });
});
$('#melding-annuleer').addEventListener('click', () => vulFormulier(null));

$('#meldingen-lijst').addEventListener('click', async (e) => {
  const knop = e.target.closest('button[data-actie]');
  if (!knop) return;
  const id = knop.closest('tr').dataset.id;
  const lijst = await vraag('GET', '/api/kamer/meldingen');
  const m = lijst.find((x) => x.id === id);
  if (knop.dataset.actie === 'bewerk') {
    vulFormulier(m);
    $('#form-melding').scrollIntoView({ behavior: 'smooth' });
  }
  if (knop.dataset.actie === 'verwijder') {
    if (!confirm(`Melding voor ${m.email} verwijderen?`)) return;
    await bezig(knop, async () => {
      await vraag('DELETE', `/api/kamer/meldingen/${id}`);
      await tekenMeldingen();
    });
  }
  if (knop.dataset.actie === 'voorbeeld') {
    await bezig(knop, async () => {
      const v = await vraag('GET', `/api/kamer/meldingen/${id}/voorbeeld`);
      $('#voorbeeld-onderwerp').textContent = `Onderwerp: ${v.onderwerp} (met de stukken van de afgelopen week)`;
      $('#voorbeeld-frame').srcdoc = v.html.replace('<head>', '<head><base target="_blank">');
      $('#voorbeeld').showModal();
    });
  }
});
$('#voorbeeld-sluit').addEventListener('click', () => $('#voorbeeld').close());

// Van de zoekvraag een melding maken: de losse woorden of woordgroepen als termen.
$('#maak-melding').addEventListener('click', () => {
  const q = formulier.q.value;
  const termen = [...q.matchAll(/"([^"]+)"|([^\s"]+)/g)]
    .map((m) => (m[1] || m[2]).replace(/\*$/, ''))
    .filter((t) => t && !['AND', 'OR', 'NOT', 'NEAR'].includes(t));
  vulFormulier({ termen, actief: true });
  toonTab('meldingen');
});

// ---------- tabs en start ----------

function toonTab(naam) {
  for (const knop of document.querySelectorAll('[role="tab"]')) knop.setAttribute('aria-selected', String(knop.dataset.tab === naam));
  for (const tab of document.querySelectorAll('.tab')) tab.hidden = tab.id !== `tab-${naam}`;
  if (naam === 'meldingen') tekenMeldingen().catch((f) => meld(f.message, 'fout'));
  history.replaceState(null, '', `${location.search}#${naam}`);
}
for (const knop of document.querySelectorAll('[role="tab"]')) knop.addEventListener('click', () => toonTab(knop.dataset.tab));

(async () => {
  status = await vraag('GET', '/api/kamer/status');
  tekenStatus();
  const p = new URLSearchParams(location.search);
  for (const naam of ['q', 'soort', 'van', 'tot', 'sorteer']) if (p.get(naam)) formulier[naam].value = p.get(naam);
  toonTab(location.hash.slice(1) || 'zoeken');
  await zoek(Number(p.get('pagina')) || 1);
})().catch((f) => meld(`Kon de kamerstukken niet laden: ${f.message}`, 'fout'));
