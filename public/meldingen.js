// Meldingen (1g): de weekmail en directe meldingen op zoektermen, op één plek.

import { $, esc, vraag, toast, bezig, toonVoorbeeld, moment, DAGEN_KORT } from './gedeeld.js';
import { app, laadIk } from './app.js';

const BRONNEN = { alle: 'Alle bronnen', gemeente: 'Alleen websites', kamerstuk: 'Alleen Kamerstukken', audio: 'Alleen audio en video' };

function weekmailHtml() {
  const g = app.ik.gebruiker;
  const w = g.weekmail;
  const zonderMail = !g.email;
  return `<div class="meldingsectie">
    <div><span class="titel">Weekoverzicht</span><span class="uitleg">Een mail met alles uit je regio's sinds de vorige mail, met per gemeente een samenvatting. Raadsvergaderingen krijgen een samenvatting per onderwerp.</span></div>
    <div class="inhoud">
      ${zonderMail ? '<p class="statusregel fout">Er staat nog geen e-mailadres bij je account; vraag een beheerder om het toe te voegen.</p>' : ''}
      <button class="schakelaar" id="weekmail-aan" role="switch" aria-checked="${Boolean(w.aan)}" ${zonderMail ? 'disabled' : ''}><span class="baan"><i></i></span>${w.aan ? 'Aan' : 'Uit'}</button>
      <div class="veld"><span>Dagen</span>
        <div class="dagen" id="weekmail-dagen">${DAGEN_KORT.map((d, i) => `<button aria-pressed="${w.dagen.includes(i + 1)}" data-dag="${i + 1}">${d}</button>`).join('')}</div>
      </div>
      <div class="rij-velden">
        <label class="veld"><span>Tijd</span><input class="invoer smal" type="time" id="weekmail-tijd" value="${esc(w.tijd)}"></label>
        <div class="veld"><span>Ook als er niets nieuws is</span><label class="vinkregel"><input type="checkbox" id="weekmail-leeg" ${w.ookLeeg ? 'checked' : ''}><span class="vakje"></span>${w.ookLeeg ? 'Ja' : 'Nee'}</label></div>
      </div>
      <span class="statusregel" id="weekmail-status">${w.aan && app.ik.volgendeWeekmail ? `Volgende mail: ${esc(moment(app.ik.volgendeWeekmail))}` : ''}${g.regios.length ? '' : ' · Je volgt nog geen regio\'s; kies ze in de feed met +.'}</span>
      <button class="linkknop" id="weekmail-voorbeeld">Voorbeeld van de volgende mail bekijken</button>
    </div>
  </div>`;
}

function bereikOpties(gekozen) {
  const opties = [['mijn', 'Mijn regio\'s'], ['overal', 'Overal'], ...app.ik.regios.map((r) => [r.id, r.naam])];
  return opties.map(([w, t]) => `<option value="${esc(w)}" ${w === gekozen ? 'selected' : ''}>${esc(t)}</option>`).join('');
}

function optiesHtml(m = {}) {
  const freq = m.frequentie || 'direct';
  return `<div class="meldingopties">
    <select class="keuzelijst klein" name="bereik" aria-label="Waar">${bereikOpties(m.bereik || 'mijn')}</select>
    <select class="keuzelijst klein" name="bronnen" aria-label="Welke bronnen">${Object.entries(BRONNEN).map(([w, t]) => `<option value="${w}" ${w === (m.bronnen || 'alle') ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <select class="keuzelijst klein" name="frequentie" aria-label="Hoe vaak"><option value="direct" ${freq === 'direct' ? 'selected' : ''}>Direct</option><option value="dagelijks" ${freq === 'dagelijks' ? 'selected' : ''}>Dagelijks om</option></select>
    <input class="invoer klein smal" type="time" name="tijd" value="${esc(m.tijd || '17:00')}" ${freq === 'dagelijks' ? '' : 'hidden'} aria-label="Tijd">
  </div>`;
}

function meldingRij(m) {
  return `<div class="meldingrij" data-id="${esc(m.id)}" title="Klik om te wijzigen">
    <div class="naamcel"><strong>${esc(m.zoekvraag)}</strong><small>${esc(m.bereikNaam)} · ${esc(m.bronnenNaam)}${m.laatsteFout ? ` · laatste mail mislukt: ${esc(m.laatsteFout)}` : ''}</small></div>
    <span>${m.frequentie === 'dagelijks' ? `Dagelijks ${esc(m.tijd)}` : 'Direct'}</span>
    <span class="klein zacht">${m.aantal30} in 30 dagen</span>
    <button class="verwijder" data-verwijder="${esc(m.id)}" title="Melding verwijderen" aria-label="Melding ${esc(m.zoekvraag)} verwijderen">×</button>
  </div>`;
}

function bewerkHtml(m) {
  return `<form class="melding-bewerken" data-bewerk="${esc(m.id)}">
    <label class="veld"><span>Zoektermen</span><input class="invoer" name="zoekvraag" value="${esc(m.zoekvraag)}"></label>
    ${optiesHtml(m)}
    <div class="knoppenrij"><button class="knop inkt klein">Opslaan</button><button type="button" class="knop zacht klein" data-annuleer>Annuleren</button></div>
  </form>`;
}

function leesOpties(form) {
  const v = (n) => form.querySelector(`[name="${n}"]`)?.value;
  return { bereik: v('bereik'), bronnen: v('bronnen'), frequentie: v('frequentie'), tijd: v('tijd') };
}

export async function toonMeldingen(hoofd) {
  let meldingen = await vraag('GET', '/api/meldingen');
  let bewerken = null;
  hoofd.innerHTML = `<div class="meldingenpagina"><h1>Meldingen</h1><div id="weekmail"></div>
    <div class="meldingsectie">
      <div><span class="titel">Directe meldingen</span><span class="uitleg">Een mail zodra een nieuw stuk een van je zoektermen bevat: websites van gemeenten, Kamerstukken, raadsvergaderingen. Ook buiten je eigen regio's, als je dat wilt.</span></div>
      <div class="inhoud" style="gap:0">
        <div id="meldinglijst"></div>
        <form id="nieuwe-melding">
          <div class="meldinginvoer"><input name="zoekvraag" placeholder='Nieuwe zoekterm, bijv. "stikstof" OR natura2000' aria-label="Nieuwe zoekterm"><button>Melding maken</button></div>
          ${optiesHtml()}
        </form>
        <p class="uitleg-klein" style="margin-top:12px">Hoofdletters en accenten tellen niet mee, alleen hele woorden. Meer termen scheid je met OR of een komma; een woordgroep zet je tussen aanhalingstekens.</p>
      </div>
    </div></div>`;

  const tekenWeekmail = () => { $('#weekmail').innerHTML = weekmailHtml(); };
  const tekenLijst = () => {
    $('#meldinglijst').innerHTML = meldingen.length
      ? meldingen.map((m) => (m.id === bewerken ? bewerkHtml(m) : meldingRij(m))).join('')
      : '<p class="klein zacht" style="padding:14px 0;border-bottom:1px solid var(--color-neutral-300)">Nog geen meldingen.</p>';
  };
  tekenWeekmail();
  tekenLijst();

  const bewaarWeekmail = async (wijziging) => {
    try {
      const r = await vraag('PUT', '/api/ik', { weekmail: { ...app.ik.gebruiker.weekmail, ...wijziging } });
      app.ik.gebruiker = r.gebruiker;
      app.ik.volgendeWeekmail = r.volgendeWeekmail;
      tekenWeekmail();
    } catch (fout) {
      toast(fout.message, 'fout');
      tekenWeekmail();
    }
  };

  $('#weekmail').addEventListener('click', (e) => {
    const w = app.ik.gebruiker.weekmail;
    if (e.target.closest('#weekmail-aan')) bewaarWeekmail({ aan: !w.aan });
    const dag = e.target.closest('[data-dag]');
    if (dag) {
      const d = Number(dag.dataset.dag);
      const dagen = w.dagen.includes(d) ? w.dagen.filter((x) => x !== d) : [...w.dagen, d];
      if (!dagen.length) return toast('Kies minstens één dag, of zet de weekmail uit.', 'fout');
      bewaarWeekmail({ dagen });
    }
    if (e.target.closest('#weekmail-voorbeeld')) toonVoorbeeld(app.ik.gebruiker);
  });
  $('#weekmail').addEventListener('change', (e) => {
    if (e.target.id === 'weekmail-tijd' && e.target.value) bewaarWeekmail({ tijd: e.target.value });
    if (e.target.id === 'weekmail-leeg') bewaarWeekmail({ ookLeeg: e.target.checked });
  });

  const hoofdEl = hoofd.firstElementChild;
  hoofdEl.addEventListener('change', (e) => {
    if (e.target.name === 'frequentie') {
      const tijd = e.target.closest('.meldingopties').querySelector('[name="tijd"]');
      tijd.hidden = e.target.value !== 'dagelijks';
    }
  });
  $('#nieuwe-melding').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const zoekvraag = form.zoekvraag.value.trim();
    if (!zoekvraag) return;
    await bezig(form.querySelector('button'), async () => {
      const m = await vraag('POST', '/api/meldingen', { zoekvraag, ...leesOpties(form) });
      meldingen.push(m);
      form.zoekvraag.value = '';
      tekenLijst();
      toast(`Melding gemaakt: ${m.zoekvraag}`);
    });
  });
  $('#meldinglijst').addEventListener('click', async (e) => {
    const weg = e.target.closest('[data-verwijder]');
    if (weg) {
      e.stopPropagation();
      const m = meldingen.find((x) => x.id === weg.dataset.verwijder);
      if (!confirm(`Melding "${m.zoekvraag}" verwijderen?`)) return;
      try {
        await vraag('DELETE', `/api/meldingen/${encodeURIComponent(m.id)}`);
        meldingen = meldingen.filter((x) => x.id !== m.id);
        tekenLijst();
      } catch (fout) {
        toast(fout.message, 'fout');
      }
      return;
    }
    if (e.target.closest('[data-annuleer]')) {
      bewerken = null;
      tekenLijst();
      return;
    }
    const rij = e.target.closest('.meldingrij');
    if (rij) {
      bewerken = rij.dataset.id;
      tekenLijst();
      $('[data-bewerk] [name="zoekvraag"]')?.focus();
    }
  });
  $('#meldinglijst').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    await bezig(form.querySelector('button'), async () => {
      const m = await vraag('PUT', `/api/meldingen/${encodeURIComponent(form.dataset.bewerk)}`, { zoekvraag: form.zoekvraag.value, ...leesOpties(form) });
      meldingen = meldingen.map((x) => (x.id === m.id ? m : x));
      bewerken = null;
      tekenLijst();
    });
  });
  // Na een wijziging elders (regio's in de feed) klopt de tekst weer.
  await laadIk().then(tekenWeekmail).catch(() => {});
}
