// Beheer: Regio's (1d), Bronnen met "Bron toevoegen" (1e en 2c), Gebruikers
// (1f), Teams-kanalen, Logboek en Instellingen.

import { $, $$, esc, vraag, toast, bezig, voerUit, toonVoorbeeld, moment, uurMinuut, geledenTekst, weekmailTekst, DAGEN_KORT } from './gedeeld.js';
import { app, laadIk, tekenBeheerStatus } from './app.js';

// ---------- gedeeld ----------

const statusHtml = (s) => `<span class="status ${esc(s.staat)}"><i></i>${esc(s.tekst)}</span>`;

function rondeTekst(b) {
  const s = b.status;
  if (s.staat === 'ontbreekt') return s.fout || 'Niet online';
  if (s.staat === 'fout') return `${s.fout ? `${s.fout.slice(0, 80)} · ` : ''}${s.tijd ? uurMinuut(s.tijd) : ''}`;
  if (s.waarschuwing) return s.waarschuwing;
  if (!s.tijd) return '';
  const vandaag = new Date(s.tijd).toDateString() === new Date().toDateString();
  return vandaag ? uurMinuut(s.tijd) : moment(s.tijd);
}

const toonTerm = (t) => (/\s/.test(t) ? `"${t}"` : t);
// De eerste zin die iets toevoegt aan de status ("Niet gevonden." staat er al).
function eersteZin(t) {
  const zin = String(t).replace(/^(Niet gevonden|Vervangende bron)\.\s*/, '').split(/(?<=\.)\s/)[0];
  return zin.length > 110 ? `${zin.slice(0, 108).replace(/\s+\S*$/, '')}…` : zin;
}

function sluitPopovers() {
  $$('.popover').forEach((p) => p.remove());
}

// Een lijst vinkjes in een popover naast een knop.
function vinkPopover(knop, { titel, opties, gekozen, voet, bijWijziging }) {
  sluitPopovers();
  const p = document.createElement('div');
  p.className = 'popover';
  p.innerHTML = `<h4>${esc(titel)}</h4>${opties.map((o) => `<label><input type="checkbox" value="${esc(o.id)}" ${gekozen.includes(o.id) ? 'checked' : ''}><span class="vakje"></span>${esc(o.naam)}</label>`).join('')}${voet ? `<div class="popover-voet">${esc(voet)}</div>` : ''}`;
  document.body.append(p);
  const rect = knop.getBoundingClientRect();
  p.style.left = `${Math.min(rect.left, window.innerWidth - 260)}px`;
  p.style.top = `${rect.bottom + window.scrollY + 8}px`;
  p.addEventListener('change', () => bijWijziging($$('input:checked', p).map((i) => i.value)));
  const weg = (e) => {
    if (!p.contains(e.target) && e.target !== knop) {
      p.remove();
      document.removeEventListener('mousedown', weg);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', weg));
}

// ---------- 1d: regio's ----------

function regioRij(r, gekozen) {
  const sub = r.eigen && !r.bronnen ? `${r.termen} termen · nog geen bronnen` : `${r.bronnen} bron${r.bronnen === 1 ? '' : 'nen'} · ${r.termen} term${r.termen === 1 ? '' : 'en'}`;
  return `<a class="regiorij" href="#/beheer/regios/${esc(r.id)}" ${r.id === gekozen ? 'aria-current="page"' : ''}>
    <span class="naamcel"><strong>${esc(r.naam)}</strong><small>${esc(sub)}</small></span>
    ${r.waarschuwing && r.id !== gekozen ? `<span class="waarschuwingstag">${esc(r.waarschuwing)}</span>` : ''}
  </a>`;
}

function bronRij(b) {
  return `<div class="tabelrij bronrij">
    <span style="font-weight:600">${esc(b.soortNaam)}</span>
    <span class="naamcel"><span>${esc(b.label || b.naam)}</span><small>${esc([b.host, b.lezer].filter(Boolean).join(' · '))}${b.toelichting && b.status.staat !== 'werkt' ? ` · ${esc(eersteZin(b.toelichting))}` : ''}</small></span>
    ${statusHtml(b.status)}
    <span class="klein zacht">${esc(rondeTekst(b))}</span>
    <span class="klein rechts-uitgelijnd">${b.nieuw7 === null ? '–' : `<strong>${b.nieuw7}</strong> nieuw`}</span>
  </div>`;
}

function termKaart(t) {
  const hint = t.ruis ? '<small class="ruis">Veel ruis: maak het specifieker</small>'
    : t.aantal === 0 ? '<small>Nog geen treffers</small>' : '<small>stukken in 30 dagen</small>';
  return `<div class="termkaart${t.actief ? '' : ' uit'}" data-term="${esc(t.term)}">
    <div class="boven"><span class="term">${esc(toonTerm(t.term))}</span><span class="n">${t.aantal}</span></div>
    ${t.actief ? hint : '<small>Uitgezet</small>'}
    <button class="verwijder" data-weg="${esc(t.term)}" title="Sleutelwoord verwijderen" aria-label="${esc(t.term)} verwijderen">×</button>
  </div>`;
}

function regioDetailHtml(d) {
  const lokaal = d.lokaleBronnen;
  return `<div class="regiodetail">
    <div class="regiodetail-kop">
      <div class="naamcel"><span class="klein zacht">Regio</span><h1>${esc(d.naam)}</h1></div>
      <div class="rechts"><span>${d.stukken7} stuk${d.stukken7 === 1 ? '' : 'ken'} in 7 dagen · ${d.volgers.length} volger${d.volgers.length === 1 ? '' : 's'}</span>
        ${d.eigen ? '<button class="linkknop" data-actie="hernoem">Naam wijzigen</button><button class="linkknop" data-actie="verwijder-regio">Verwijderen</button>' : ''}</div>
    </div>

    <section class="sectie">
      <div class="sectiekop"><span class="titel">1 · Lokale bronnen</span><span class="uitleg">Alles wat hier binnenkomt, gaat rechtstreeks naar deze regio.</span>
        <a class="knop primair klein rechts" href="#/beheer/bronnen?regio=${esc(d.id)}">+ Bron toevoegen</a></div>
      ${lokaal.length ? lokaal.map(bronRij).join('') : '<p class="leeg" style="padding-left:0">Nog geen bronnen. Voeg een RSS-feed, iBabs-overzicht, Woo-platform of raadsvergadering toe.</p>'}
    </section>

    <section class="sectie">
      <div class="sectiekop"><span class="titel">2 · Sleutelwoorden</span><span class="uitleg">Een stuk uit een landelijke bron met een van deze woorden gaat naar ${esc(d.naam)}.</span></div>
      <div class="geldt"><span>Geldt voor:</span>${d.landelijk.map((b) => `<button data-landelijk="${esc(b.id)}" aria-pressed="${b.aan}" title="${b.aan ? 'Klik om uit te zetten voor deze regio' : 'Klik om aan te zetten voor deze regio'}">${esc(b.naam)}</button>`).join('')}</div>
      ${d.sleutelwoorden.length ? `<div class="termen">${d.sleutelwoorden.map(termKaart).join('')}</div>` : '<p class="hulptekst">Nog geen sleutelwoorden. Uit landelijke bronnen komt nu alleen wat een plek in deze gemeente heeft: aardbevingen, files, ransomware, uitspraken, bekendmakingen van de provincie.</p>'}
      <form class="terminvoer" id="terminvoer">
        <label><input id="nieuwe-term" placeholder="Nieuw sleutelwoord, bijv. een dorp of wijk" autocomplete="off" aria-label="Nieuw sleutelwoord"><span class="voorbeeld" id="term-voorbeeld"></span></label>
        <button>Toevoegen</button>
      </form>
      <p class="hulptekst">Hoofdletters en accenten tellen niet mee, alleen hele woorden. Een woordgroep zet je tussen aanhalingstekens. Klik op een sleutelwoord om het tijdelijk uit te zetten.</p>
    </section>

    <section class="sectie">
      <div class="sectiekop"><span class="titel">3 · Gevolgd door</span><a class="linkknop rechts" href="#/beheer/gebruikers">Beheren bij Gebruikers</a></div>
      <div class="volgers">${d.volgers.length ? d.volgers.map((v) => `<span><strong>${esc(v.naam)}</strong> · ${esc(v.mail)}</span>`).join('') : '<span class="zacht">Nog niemand.</span>'}</div>
    </section>
  </div>`;
}

export async function toonRegios(hoofd, id) {
  let lijst = await vraag('GET', '/api/beheer/regios');
  const gekozen = id && lijst.some((r) => r.id === id) ? id : lijst[0]?.id;
  if (gekozen && gekozen !== id) history.replaceState(null, '', `#/beheer/regios/${gekozen}`);
  let d = gekozen ? await vraag('GET', `/api/beheer/regios/${encodeURIComponent(gekozen)}`) : null;

  hoofd.innerHTML = `<div class="regiobeheer">
    <nav class="regiolijst" id="regiolijst"></nav>
    <div id="regiodetail"></div>
  </div>`;
  const tekenLijst = () => {
    $('#regiolijst').innerHTML = `<div class="regiolijst-kop"><span>${lijst.length} regio's</span><button class="linkknop" id="nieuwe-regio-knop">+ Regio</button></div>
      <form class="nieuwe-regio" id="nieuwe-regio" hidden><input class="invoer klein" name="naam" placeholder="Naam van de regio" aria-label="Naam van de nieuwe regio"><button class="knop inkt klein">Maak</button></form>
      ${lijst.map((r) => regioRij(r, gekozen)).join('')}`;
  };
  const tekenDetail = () => {
    $('#regiodetail').innerHTML = d ? regioDetailHtml(d) : '<p class="leeg">Nog geen regio\'s.</p>';
  };
  tekenLijst();
  tekenDetail();

  const herlaad = async (wijziging) => {
    d = await vraag('PUT', `/api/beheer/regios/${encodeURIComponent(gekozen)}`, wijziging);
    lijst = await vraag('GET', '/api/beheer/regios');
    tekenLijst();
    tekenDetail();
  };

  $('#regiolijst').addEventListener('click', (e) => {
    if (e.target.closest('#nieuwe-regio-knop')) {
      $('#nieuwe-regio').hidden = false;
      $('#nieuwe-regio input').focus();
    }
  });
  $('#regiolijst').addEventListener('submit', async (e) => {
    e.preventDefault();
    const naam = e.target.naam.value.trim();
    if (!naam) return;
    await bezig(e.target.querySelector('button'), async () => {
      const r = await vraag('POST', '/api/beheer/regios', { naam });
      await laadIk();
      location.hash = `#/beheer/regios/${r.id}`;
    });
  });

  const detail = $('#regiodetail');
  detail.addEventListener('click', async (e) => {
    const knop = e.target.closest('button');
    if (!knop || !d) return;
    try {
      if (knop.dataset.landelijk) {
        const uit = d.landelijk.filter((b) => (b.id === knop.dataset.landelijk ? b.aan : !b.aan)).map((b) => b.id);
        await herlaad({ landelijkUit: uit });
      } else if (knop.dataset.weg) {
        await herlaad({ sleutelwoorden: d.sleutelwoorden.filter((t) => t.term !== knop.dataset.weg) });
      } else if (knop.dataset.actie === 'hernoem') {
        const naam = prompt('Nieuwe naam van de regio', d.naam);
        if (naam && naam.trim() !== d.naam) {
          await herlaad({ naam });
          await laadIk();
        }
      } else if (knop.dataset.actie === 'verwijder-regio') {
        if (!confirm(`Regio ${d.naam} verwijderen? Volgers verliezen deze regio.`)) return;
        await vraag('DELETE', `/api/beheer/regios/${encodeURIComponent(d.id)}`);
        await laadIk();
        location.hash = '#/beheer/regios';
      }
    } catch (fout) {
      toast(fout.message, 'fout');
    }
  });
  // Klik op een termkaart: aan of uit.
  detail.addEventListener('click', async (e) => {
    const kaart = e.target.closest('.termkaart');
    if (!kaart || e.target.closest('button')) return;
    const term = kaart.dataset.term;
    try {
      await herlaad({ sleutelwoorden: d.sleutelwoorden.map((t) => (t.term === term ? { ...t, actief: !t.actief } : t)) });
    } catch (fout) {
      toast(fout.message, 'fout');
    }
  });
  let proefTimer = null;
  detail.addEventListener('input', (e) => {
    if (e.target.id !== 'nieuwe-term') return;
    clearTimeout(proefTimer);
    const term = e.target.value.trim();
    const uit = $('#term-voorbeeld');
    if (term.length < 2) {
      uit.textContent = '';
      return;
    }
    proefTimer = setTimeout(async () => {
      try {
        const r = await vraag('GET', `/api/beheer/termproef?term=${encodeURIComponent(term)}&regio=${encodeURIComponent(d.id)}`);
        if ($('#nieuwe-term')?.value.trim() === term) uit.textContent = r.term ? `Voorbeeld: ${r.aantal} stuk${r.aantal === 1 ? '' : 'ken'} in de afgelopen 30 dagen` : '';
      } catch { /* geen voorbeeld */ }
    }, 350);
  });
  detail.addEventListener('submit', async (e) => {
    if (e.target.id !== 'terminvoer') return;
    e.preventDefault();
    const term = $('#nieuwe-term').value.trim();
    if (!term) return;
    await bezig(e.target.querySelector('button'), async () => {
      await herlaad({ sleutelwoorden: [...d.sleutelwoorden, { term, actief: true }] });
      $('#nieuwe-term')?.focus();
    });
  });
}

// ---------- 1e en 2c: bronnen ----------

const TYPES = {
  web: [
    { id: 'rss-nieuws', tekst: 'Nieuws (RSS-feed)', lezer: 'rss', soort: 'nieuws', voorbeeld: 'https://www.gemeente.nl/rss' },
    { id: 'rss-ingekomen', tekst: 'Ingekomen stukken (RSS-feed)', lezer: 'rss', soort: 'ingekomen', voorbeeld: 'https://…/feed' },
    { id: 'rss-woo', tekst: 'Woo-publicaties (RSS-feed)', lezer: 'rss', soort: 'woo', voorbeeld: 'https://…/feed' },
  ],
  raad: [
    { id: 'ibabs', tekst: 'Ingekomen stukken of raadsbrieven (iBabs-overzicht)', lezer: 'ibabs', soort: 'ingekomen', voorbeeld: 'https://gemeente.bestuurlijkeinformatie.nl/Reports/Details/…' },
    { id: 'gpp-woo', tekst: 'Woo-publicaties (Woo-platform, open.<gemeente>.nl)', lezer: 'gpp-woo', soort: 'woo', voorbeeld: 'https://open.gemeente.nl' },
  ],
  audio: [
    { id: 'raadsvergadering', tekst: 'Raadsvergadering (Notubiz, iBabs, Company Webcast, GemeenteOplossingen)', lezer: 'audio', soort: 'raadsvergadering', voorbeeld: 'https://gemeente.raadsinformatie.nl/' },
    { id: 'youtube', tekst: 'YouTube (kanaal, video\'s, live, Shorts of playlist)', lezer: 'audio', soort: 'youtube', voorbeeld: 'https://www.youtube.com/@kanaal' },
    { id: 'podcast', tekst: 'Podcast (RSS)', lezer: 'audio', soort: 'podcast', voorbeeld: 'https://feeds.example.nl/podcast.xml' },
  ],
};

function audioTelling(a) {
  const t = a.tellingen;
  return [`${t.transcripten} transcript${t.transcripten === 1 ? '' : 'en'}`, t.bezig && `${t.bezig} in de wachtrij`, t.mislukt && `${t.mislukt} mislukt`,
    a.archiefGevraagd && 'archief wordt gelezen'].filter(Boolean).join(' · ');
}

// Wat het lezen van het hele archief opleverde.
function archiefTekst(a) {
  if (a.archiefGevraagd) return `Het hele archief wordt gelezen (binnen een uur of wat); oudere afleveringen komen achter nieuwe in de wachtrij.${a.archief?.fout ? ` Vorige poging mislukt: ${a.archief.fout}` : ''}`;
  if (a.archief?.klaar) return `Hele archief gelezen op ${new Date(a.archief.klaar).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })}: ${a.archief.toegevoegd} oudere ${a.archief.toegevoegd === 1 ? 'aflevering' : 'afleveringen'} toegevoegd.`;
  if (a.archief?.fout) return `Het archief lezen lukte drie keer niet: ${a.archief.fout}`;
  return '';
}

function bronnenRij(b) {
  const bereik = b.bereik === 'landelijk' ? `Alle regio's · ${b.viaPlek ? `via ${b.viaPlek} en ` : ''}${b.termen} termen` : b.regioNaam || '';
  let sub = b.status.staat === 'werkt' || !b.toelichting ? [b.host, b.lezer].filter(Boolean).join(' · ') : eersteZin(b.toelichting);
  if (b.audio) sub = `${b.lezer} · ${audioTelling(b.audio)}`;
  const status = b.audio && !b.audio.actief ? { staat: 'wacht', tekst: 'Gepauzeerd' } : b.audio?.bezig ? { staat: 'wacht', tekst: 'Catalogus lezen…' } : b.status;
  return `<div class="tabelrij bronnenrij">
    <span class="naamcel"><strong>${esc(b.naam)}</strong><small>${esc(sub)}</small>${b.ingebouwd ? '' : `<button class="linkknop" data-wijzig="${esc(b.id)}" style="font-size:12px">Wijzig</button>`}</span>
    <span style="color:var(--color-neutral-800)">${esc(b.soortNaam)}</span>
    <span>${esc(bereik)}</span>
    <span class="statuscel">${statusHtml(status)}<small>${esc(rondeTekst(b))}</small></span>
    <span class="rechts-uitgelijnd tab-nums" style="font-weight:600">${b.nieuw7 === null ? '–' : b.nieuw7}</span>
    ${b.ingebouwd ? '<span></span>' : `<button class="verwijder" data-weg="${esc(b.id)}" title="Bron verwijderen" aria-label="${esc(b.naam)} verwijderen">×</button>`}
  </div>`;
}

// Naam, bereik en (bij audio) pauzeren van een zelf toegevoegde bron.
function wijzigBronDialoog(b, opslaan) {
  let dialoog = $('#bron-dialoog');
  if (!dialoog) {
    dialoog = document.createElement('dialog');
    dialoog.id = 'bron-dialoog';
    dialoog.className = 'formulier';
    document.body.append(dialoog);
  }
  dialoog.innerHTML = `<form method="dialog">
    <h2>${esc(b.naam)}</h2>
    <label class="veld"><span>Naam</span><input class="invoer" name="label" value="${esc(b.label || b.naam)}"></label>
    <label class="veld"><span>Bereik</span><select class="keuzelijst" name="bereik">
      <option value="landelijk" ${b.bereik === 'landelijk' ? 'selected' : ''}>Landelijk, via sleutelwoorden</option>
      ${app.ik.regios.map((r) => `<option value="regio:${esc(r.id)}" ${b.bereik === 'regio' && b.regio === r.id ? 'selected' : ''}>${esc(r.naam)}</option>`).join('')}
    </select></label>
    ${b.audio ? `<label class="vinkregel"><input type="checkbox" name="actief" ${b.audio.actief ? 'checked' : ''}><span class="vakje"></span>Nieuwe afleveringen blijven zoeken (uit = gepauzeerd; de wachtrij loopt door)</label>
      ${b.audio.kind !== 'video' ? `<label class="vinkregel"><input type="checkbox" name="archief" ${b.audio.archiefGevraagd ? 'checked' : ''}><span class="vakje"></span>Ook het hele archief transcriberen (oudere afleveringen komen achter nieuwe in de wachtrij)</label>` : ''}
      ${archiefTekst(b.audio) ? `<p class="uitleg-klein">${esc(archiefTekst(b.audio))}</p>` : ''}
      <p class="uitleg-klein">${esc(b.lezer)}${b.audio.titel ? ` · ${esc(b.audio.titel)}` : ''} · ${esc(audioTelling(b.audio))}${b.audio.catalogus !== null ? ` · catalogus ${b.audio.catalogus}` : ''}<br>${esc(b.url)}</p>` : `<p class="uitleg-klein">${esc(b.url)}</p>`}
    <div class="knoppenrij"><button class="knop primair" value="opslaan">Opslaan</button>${b.audio ? '<button class="knop" value="controleer">Nu controleren</button>' : ''}<button class="knop zacht" value="annuleer" formnovalidate>Annuleren</button></div>
  </form>`;
  dialoog.showModal();
  dialoog.onclose = () => {
    if (!['opslaan', 'controleer'].includes(dialoog.returnValue)) return;
    const f = dialoog.querySelector('form');
    const [bereik, regio] = f.bereik.value.split(':');
    opslaan({ label: f.label.value, bereik, regio, ...(b.audio ? { actief: f.actief.checked, ...(f.archief ? { archief: f.archief.checked } : {}) } : {}) }, dialoog.returnValue === 'controleer');
  };
}

const YOUTUBE_SCOPES = [['auto', 'Automatisch uit het adres'], ['youtube', 'Hele kanaal'], ['youtube-videos', 'Alleen video\'s'], ['youtube-streams', 'Alleen afgeronde live-uitzendingen'], ['youtube-shorts', 'Alleen Shorts'], ['youtube-playlist', 'Eén afspeellijst']];
const EERSTE_IMPORT = [[-1, 'Geen: alleen nieuwe afleveringen'], [1, 'De nieuwste aflevering'], [3, 'De 3 nieuwste'], [10, 'De 10 nieuwste'], [25, 'De 25 nieuwste'], [50, 'De 50 nieuwste'], [100, 'De 100 nieuwste'], [0, 'Alle beschikbare afleveringen']];

function formulierHtml(f, worker) {
  const types = TYPES[f.groep];
  const type = types.find((t) => t.id === f.type) || types[0];
  const audio = f.groep === 'audio';
  const uitlegBereik = f.bereik === 'landelijk'
    ? (audio ? 'Het transcript wordt doorzocht op de sleutelwoorden van alle regio\'s. Bij een treffer gaat de aflevering naar die regio, met de tijd waarop het woord valt.'
      : 'Landelijke stukken gaan naar de regio\'s waarvan een sleutelwoord in het stuk voorkomt.')
    : 'Alles wat deze bron oplevert, gaat rechtstreeks naar deze regio.';
  return `<h2>Bron toevoegen</h2>
    <div class="veld"><span class="stapnaam">1. Bereik</span>
      <div class="segmenten"><button type="button" data-bereik="regio" aria-pressed="${f.bereik === 'regio'}">Eén regio</button><button type="button" data-bereik="landelijk" aria-pressed="${f.bereik === 'landelijk'}">Landelijk</button></div>
      ${f.bereik === 'regio' ? `<select class="keuzelijst" id="bron-regio" aria-label="Regio"><option value="">Kies de regio…</option>${app.ik.regios.map((r) => `<option value="${esc(r.id)}" ${r.id === f.regio ? 'selected' : ''}>${esc(r.naam)}</option>`).join('')}</select>` : ''}
      <span class="uitleg-klein">${esc(uitlegBereik)}</span>
    </div>
    <div class="veld"><span class="stapnaam">2. Soort</span>
      <div class="segmenten"><button type="button" data-groep="web" aria-pressed="${f.groep === 'web'}">Webpagina / RSS</button><button type="button" data-groep="raad" aria-pressed="${f.groep === 'raad'}">Raadsinformatie</button><button type="button" data-groep="audio" aria-pressed="${f.groep === 'audio'}">Audio &amp; video</button></div>
    </div>
    <div class="veld"><span class="stapnaam">3. Type</span>
      <div class="radios">${types.map((t) => `<label class="radio-rij"><input type="radio" name="bron-type" value="${t.id}" ${t.id === type.id ? 'checked' : ''}><span class="vakje"></span>${esc(t.tekst)}</label>`).join('')}</div>
      ${f.groep === 'raad' ? '<span class="uitleg-klein">Notubiz-modules en eigen sites van gemeenten hebben een eigen lezer in de code nodig; vraag het aan de ontwikkelaar.</span>' : ''}
      ${type.soort === 'raadsvergadering' ? '<span class="uitleg-klein">Plak het vergaderarchief, het raadsinformatieportaal of de raadspagina van de gemeentesite; het videoplatform wordt erbij gezocht.</span>' : ''}
    </div>
    <div class="veld"><span class="stapnaam">4. Adres</span>
      <input class="invoer" id="bron-url" type="url" placeholder="${esc(type.voorbeeld)}" value="${esc(f.url)}" aria-label="Adres">
      <input class="invoer" id="bron-naam" placeholder="Naam (optioneel), bijv. De Haagse Kwestie" value="${esc(f.naam)}" aria-label="Naam">
    </div>
    ${audio ? `<div class="veld"><span class="stapnaam">5. Meteen verwerken</span>
      ${type.soort === 'youtube' ? `<select class="keuzelijst" id="bron-scope" aria-label="Wat volgen">${YOUTUBE_SCOPES.map(([w, t]) => `<option value="${w}" ${w === f.scope ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>` : ''}
      <select class="keuzelijst" id="bron-eerste" aria-label="Hoeveel afleveringen meteen">${EERSTE_IMPORT.map(([w, t]) => `<option value="${w}" ${w === f.eersteImport ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <span class="uitleg-klein">De rest van de bestaande catalogus telt als gezien; daarna komt elke nieuwe aflevering vanzelf binnen. Alles gaat via de Whisper-worker: één tegelijk, in de volgorde van Beheer › Audio.</span>
    </div>` : ''}
    ${audio && !worker?.ingesteld ? '<p class="statusregel fout">De Whisper-worker is nog niet ingesteld (Instellingen › Audio en video); tot dan blijft alles in de wachtrij.</p>' : ''}
    ${audio && worker?.ingesteld && !worker.token ? '<p class="statusregel fout">Het token van de Whisper-worker ontbreekt (Instellingen › Audio en video).</p>' : ''}
    <div class="knoppenrij"><button type="button" class="knop" id="proefknop">Proefronde</button></div>
    <div class="proef${f.proef?.fout ? ' fout' : ''}" id="proef" ${f.proef ? '' : 'hidden'}>${f.proef ? proefHtml(f.proef, audio) : ''}</div>
    <button type="button" class="knop primair" id="opslaan">Bron opslaan</button>`;
}

function proefHtml(p, audio) {
  return `<span class="stapnaam">${audio ? 'Proefronde' : 'Proefronde'}</span><p>${esc(p.tekst)}</p>
    ${p.voorbeelden?.length ? `<ul>${p.voorbeelden.map((v) => `<li>${v.datum ? `${esc(moment(v.datum))}: ` : ''}${esc(v.titel)}</li>`).join('')}</ul>` : ''}
    ${p.nulmeting ? `<small>${esc(p.nulmeting)}</small>` : ''}`;
}

export async function toonBronnen(hoofd, params) {
  let data = await vraag('GET', '/api/beheer/bronnen');
  const f = { bereik: 'regio', regio: params.get('regio') || '', groep: params.get('soort') === 'audio' ? 'audio' : 'web', type: params.get('soort') === 'audio' ? 'raadsvergadering' : 'rss-nieuws', url: '', naam: '', proef: null, scope: 'auto', eersteImport: 3 };

  hoofd.innerHTML = `<div class="bronnenbeheer"><div class="pagina" id="bronnenlijst"></div><aside class="bronformulier" id="bronformulier"></aside></div>`;
  const tekenLijst = () => {
    const landelijk = data.bronnen.filter((b) => b.bereik === 'landelijk');
    const gemeentelijk = data.bronnen.filter((b) => b.bereik !== 'landelijk')
      .sort((a, b) => (a.regioNaam || '').localeCompare(b.regioNaam || '', 'nl') || a.naam.localeCompare(b.naam, 'nl'));
    $('#bronnenlijst').innerHTML = `
      <div class="paginakop"><h1>Bronnen</h1><span class="klein zacht">${data.bronnen.length} bronnen: ${landelijk.length} landelijk en ${gemeentelijk.length} gemeentelijk</span>
        <div class="rechts"><button class="knop klein" id="nu-controleren">Nu controleren</button></div></div>
      <div class="tabelkop bronnenrij"><span>Bron</span><span>Soort</span><span>Bereik</span><span>Status</span><span class="rechts-uitgelijnd">7 d</span><span></span></div>
      <div class="groepkop">Landelijk · via sleutelwoorden of plek</div>
      ${landelijk.map(bronnenRij).join('')}
      <div class="groepkop">Gemeentelijk</div>
      ${gemeentelijk.map(bronnenRij).join('')}`;
  };
  const tekenFormulier = () => {
    $('#bronformulier').innerHTML = formulierHtml(f, data.worker);
  };
  tekenLijst();
  tekenFormulier();

  $('#bronnenlijst').addEventListener('click', async (e) => {
    const knop = e.target.closest('button');
    if (!knop) return;
    if (knop.id === 'nu-controleren') {
      await bezig(knop, async (zet) => {
        await voerUit('verzamel', {}, zet);
        data = await vraag('GET', '/api/beheer/bronnen');
        tekenLijst();
        tekenBeheerStatus();
        toast('Alle bronnen zijn gecontroleerd.');
      });
    } else if (knop.dataset.wijzig) {
      const b = data.bronnen.find((x) => x.id === knop.dataset.wijzig);
      wijzigBronDialoog(b, async (wijziging, controleer) => {
        try {
          await vraag('PUT', `/api/beheer/bronnen/${encodeURIComponent(b.id)}`, wijziging);
          if (controleer) {
            toast(`${b.naam}: catalogus wordt gelezen…`);
            const r = await vraag('POST', `/api/beheer/bronnen/${encodeURIComponent(b.id)}/controleer`, {});
            toast(r.ok ? `${r.nieuw} nieuwe afleveringen in de wachtrij` : `Controleren mislukt: ${r.fout}`, r.ok ? 'ok' : 'fout');
          }
          data = await vraag('GET', '/api/beheer/bronnen');
          tekenLijst();
        } catch (fout) {
          toast(fout.message, 'fout');
        }
      });
    } else if (knop.dataset.weg) {
      const b = data.bronnen.find((x) => x.id === knop.dataset.weg);
      if (!confirm(`${b.naam} verwijderen? Wat deze bron opleverde, verdwijnt uit de feed${b.audio ? `, en ${b.audio.tellingen.transcripten} transcripten met hun namen en nummers gaan weg` : ''}.`)) return;
      try {
        await vraag('DELETE', `/api/beheer/bronnen/${encodeURIComponent(b.id)}`);
        data = await vraag('GET', '/api/beheer/bronnen');
        tekenLijst();
      } catch (fout) {
        toast(fout.message, 'fout');
      }
    }
  });

  const form = $('#bronformulier');
  const lees = () => {
    f.url = $('#bron-url')?.value.trim() || '';
    f.naam = $('#bron-naam')?.value.trim() || '';
    f.regio = $('#bron-regio')?.value ?? f.regio;
    f.scope = $('#bron-scope')?.value ?? f.scope;
    f.eersteImport = $('#bron-eerste') ? Number($('#bron-eerste').value) : f.eersteImport;
  };
  const invoer = () => {
    const type = TYPES[f.groep].find((t) => t.id === f.type) || TYPES[f.groep][0];
    return { bereik: f.bereik, regio: f.bereik === 'regio' ? f.regio : undefined, lezer: type.lezer, soort: type.soort, url: f.url, naam: f.naam, scope: f.scope, eersteImport: f.eersteImport };
  };
  form.addEventListener('click', async (e) => {
    const knop = e.target.closest('button');
    if (!knop) return;
    lees();
    if (knop.dataset.bereik) {
      f.bereik = knop.dataset.bereik;
      f.proef = null;
      tekenFormulier();
    } else if (knop.dataset.groep) {
      f.groep = knop.dataset.groep;
      f.type = TYPES[f.groep][0].id;
      f.proef = null;
      tekenFormulier();
    } else if (knop.id === 'proefknop') {
      await bezig(knop, async () => {
        f.proef = await vraag('POST', '/api/beheer/bronnen/proef', invoer());
        tekenFormulier();
      }, 'Ophalen…');
    } else if (knop.id === 'opslaan') {
      await bezig(knop, async () => {
        const b = await vraag('POST', '/api/beheer/bronnen', invoer());
        toast(`${b.naam} toegevoegd. De eerste ronde is een nulmeting.`);
        Object.assign(f, { url: '', naam: '', proef: null });
        data = await vraag('GET', '/api/beheer/bronnen');
        tekenLijst();
        tekenFormulier();
      }, 'Opslaan…');
    }
  });
  form.addEventListener('change', (e) => {
    if (e.target.name === 'bron-type') {
      lees();
      f.type = e.target.value;
      f.proef = null;
      tekenFormulier();
    }
    if (e.target.id === 'bron-regio') f.regio = e.target.value;
    if (e.target.id === 'bron-scope') f.scope = e.target.value;
    if (e.target.id === 'bron-eerste') f.eersteImport = Number(e.target.value);
  });
}

// ---------- 1f: gebruikers ----------

// Hoe ver het Authelia-account is (src/accounts.mjs): aangevraagd, klaar en
// gemaild, of een fout van het accountscript of de mail.
function accountTekst(g) {
  const a = g.account;
  if (!a) return '';
  const regel = (tekst, fout) => `<small class="accountstatus${fout ? ' fout' : ''}" title="${esc(tekst)}">${esc(tekst)}</small>`;
  if (a.status === 'aangevraagd') return regel('Account wordt aangemaakt…');
  if (a.status === 'fout') return regel(`Account: ${a.melding}`, true);
  if (a.mail?.fout) return regel(`Account klaar, mail mislukt: ${a.mail.fout}`, true);
  if (a.mail?.verstuurd) return regel(`Uitnodiging gemaild ${geledenTekst(a.mail.verstuurd)}`);
  return '';
}

function gebruikerRij(g) {
  const regios = g.regios.map((id) => app.ik.regios.find((r) => r.id === id)?.naam || id);
  const alle = regios.length && regios.length === app.ik.regios.length;
  return `<div class="tabelrij gebruikersrij" data-id="${esc(g.id)}">
    <span class="naamcel"><strong>${esc(g.naam || g.login || g.email)}</strong><small>${esc(g.email || 'geen e-mailadres')}${g.login ? ` · inlog: ${esc(g.login)}` : ''}</small>${accountTekst(g)}</span>
    <select class="keuzelijst klein" data-veld="rol" aria-label="Rol"><option value="journalist" ${g.rol === 'journalist' ? 'selected' : ''}>Journalist</option><option value="admin" ${g.rol === 'admin' ? 'selected' : ''}>Admin</option></select>
    <select class="keuzelijst klein" data-veld="titel" aria-label="Titel"><option ${g.titel === 'LC' ? 'selected' : ''}>LC</option><option ${g.titel === 'DVHN' ? 'selected' : ''}>DVHN</option></select>
    <div class="regiochips-cel">${alle ? '<span class="regiochip">Alle regio\'s</span>' : regios.map((r) => `<span class="regiochip">${esc(r)}</span>`).join('')}<button class="linkknop" data-actie="regios">${regios.length ? 'wijzig' : '+ regio\'s'}</button></div>
    <button class="schakelaar" role="switch" aria-checked="${Boolean(g.weekmail?.aan)}" data-actie="weekmail" title="Weekmail aan of uit" ${g.email ? '' : 'disabled'}><span class="baan"><i></i></span><span class="tekst">${esc(weekmailTekst(g.weekmail))}</span></button>
    <span class="klein zacht">${esc(geledenTekst(g.laatstActief))}</span>
    <span class="rijacties">${app.ik.autheliaAccounts && g.email ? '<button class="linkknop" data-actie="uitnodiging" title="Het Authelia-account aanmaken (als het er nog niet is) en de uitnodiging mailen">Uitnodigen</button>' : ''}<button class="linkknop" data-actie="voorbeeld" title="Voorbeeld van de weekmail" ${g.email && g.regios.length ? '' : 'disabled'}>Mail</button><button class="linkknop" data-actie="bewerk">Wijzig</button><button class="verwijder" data-actie="verwijder" aria-label="${esc(g.naam || g.email)} verwijderen">×</button></span>
  </div>`;
}

function bewerkDialoog(g, opslaan) {
  let dialoog = $('#gebruiker-dialoog');
  if (!dialoog) {
    dialoog = document.createElement('dialog');
    dialoog.id = 'gebruiker-dialoog';
    dialoog.className = 'formulier';
    document.body.append(dialoog);
  }
  dialoog.innerHTML = `<form method="dialog">
    <h2>${esc(g.naam || g.email || 'Gebruiker')}</h2>
    <label class="veld"><span>Naam</span><input class="invoer" name="naam" value="${esc(g.naam)}"></label>
    <label class="veld"><span>E-mailadres</span><input class="invoer" name="email" type="email" value="${esc(g.email)}"></label>
    <label class="veld"><span>Inlognaam bij Authelia</span><input class="invoer" name="login" value="${esc(g.login || '')}" placeholder="Leeg: wordt gekoppeld bij de eerste keer inloggen"></label>
    <div class="knoppenrij"><button class="knop primair" value="opslaan">Opslaan</button><button class="knop zacht" value="annuleer" formnovalidate>Annuleren</button></div>
  </form>`;
  dialoog.showModal();
  dialoog.onclose = () => {
    if (dialoog.returnValue !== 'opslaan') return;
    const f = dialoog.querySelector('form');
    opslaan({ naam: f.naam.value, email: f.email.value, login: f.login.value });
  };
}

export async function toonGebruikers(hoofd) {
  let gebruikers = await vraag('GET', '/api/beheer/gebruikers');
  hoofd.innerHTML = '<div class="pagina" id="gebruikers"></div>';
  const teken = () => {
    const open = gebruikers.filter((g) => g.uitgenodigd && g.login === null).length;
    $('#gebruikers').innerHTML = `
      <div class="paginakop"><h1>Gebruikers</h1><span class="klein zacht">${gebruikers.length} personen${open ? ` · ${open} nog nooit ingelogd` : ''}</span>
        <div class="rechts"><button class="knop primair klein" id="uitnodigen-knop">+ Uitnodigen</button></div></div>
      <form class="uitnodigen" id="uitnodigen" hidden>
        <label class="veld"><span>Naam</span><input class="invoer" name="naam" required></label>
        <label class="veld"><span>E-mailadres</span><input class="invoer" name="email" type="email" required></label>
        <label class="veld"><span>Inlognaam (optioneel)</span><input class="invoer" name="login" placeholder="zoals bij Authelia"></label>
        <label class="veld"><span>Rol</span><select class="keuzelijst" name="rol"><option value="journalist">Journalist</option><option value="admin">Admin</option></select></label>
        <label class="veld"><span>Titel</span><select class="keuzelijst" name="titel"><option>LC</option><option>DVHN</option></select></label>
        <button class="knop inkt">Uitnodigen</button>
      </form>
      <div class="tabelkop gebruikersrij"><span>Naam</span><span>Rol</span><span>Titel</span><span>Regio's</span><span>Weekmail</span><span>Laatst actief</span><span></span></div>
      ${gebruikers.map(gebruikerRij).join('')}
      <p class="uitleg-klein" style="margin-top:20px;max-width:760px">${app.ik.autheliaAccounts
    ? 'Inloggen gaat via Authelia. Uitnodigen maakt daar ook het account aan (de inlognaam komt uit het e-mailadres als je er geen invult) en mailt de uitnodiging; het wachtwoord kiest de nieuwe gebruiker zelf. Heeft iemand met dat e-mailadres al een Authelia-account, dan wordt dat gebruikt. Verwijderen zet een account dat via de Regiochecker is gemaakt ook in Authelia uit.'
    : 'Inloggen gaat via Authelia. Iemand die je uitnodigt, kan inloggen zodra er bij Authelia een account is met hetzelfde e-mailadres (of dezelfde inlognaam) en Authelia diegene toegang geeft tot deze site; dat regel je in Authelia zelf.'} De titel bepaalt de huisstijl (LC of DVHN). Gebruikers zonder inlog krijgen alleen de weekmail.</p>`;
  };
  teken();

  // Zolang het accountscript nog bezig is, af en toe de lijst opnieuw ophalen.
  let wachtTimer = null;
  const volgAccounts = (keer = 0) => {
    clearTimeout(wachtTimer);
    if (keer > 20 || !gebruikers.some((g) => g.account?.status === 'aangevraagd')) return;
    wachtTimer = setTimeout(async () => {
      if (!$('#gebruikers')) return;
      try {
        gebruikers = await vraag('GET', '/api/beheer/gebruikers');
        teken();
      } catch { /* volgende keer */ }
      volgAccounts(keer + 1);
    }, 3000);
  };
  volgAccounts();

  const werkBij = async (g, wijziging) => {
    try {
      const nieuw = await vraag('PUT', `/api/beheer/gebruikers/${encodeURIComponent(g.id)}`, wijziging);
      gebruikers = gebruikers.map((x) => (x.id === g.id ? { ...x, ...nieuw } : x));
      if (g.id === app.ik.gebruiker.id) {
        await laadIk();
        document.documentElement.dataset.titel = (app.ik.gebruiker.titel || 'LC').toLowerCase();
        if (!app.ik.beheerder) location.hash = '#/feed';
      }
    } catch (fout) {
      toast(fout.message, 'fout');
    }
    teken();
  };

  const pagina = $('#gebruikers');
  pagina.addEventListener('click', async (e) => {
    const knop = e.target.closest('button');
    if (!knop) return;
    if (knop.id === 'uitnodigen-knop') {
      $('#uitnodigen').hidden = !$('#uitnodigen').hidden;
      if (!$('#uitnodigen').hidden) $('#uitnodigen [name="naam"]').focus();
      return;
    }
    const rij = knop.closest('[data-id]');
    if (!rij) return;
    const g = gebruikers.find((x) => x.id === rij.dataset.id);
    const actie = knop.dataset.actie;
    if (actie === 'weekmail') werkBij(g, { weekmail: { ...g.weekmail, aan: !g.weekmail.aan } });
    if (actie === 'regios') {
      vinkPopover(knop, {
        titel: `Regio's van ${g.naam || g.email}`,
        opties: app.ik.regios,
        gekozen: g.regios,
        voet: 'Feed en weekmail volgen deze regio\'s.',
        bijWijziging: (regios) => {
          vraag('PUT', `/api/beheer/gebruikers/${encodeURIComponent(g.id)}`, { regios })
            .then((nieuw) => {
              Object.assign(g, nieuw);
              const oud = $(`[data-id="${CSS.escape(g.id)}"] .regiochips-cel`);
              const tmp = document.createElement('div');
              tmp.innerHTML = gebruikerRij(g);
              oud?.replaceWith(tmp.querySelector('.regiochips-cel'));
              if (g.id === app.ik.gebruiker.id) laadIk();
            })
            .catch((fout) => toast(fout.message, 'fout'));
        },
      });
    }
    if (actie === 'uitnodiging') {
      if (!confirm(`${g.naam || g.email} uitnodigen? ${g.login ? `Het Authelia-account ${g.login} wordt gecontroleerd` : 'Er komt een Authelia-account'} en er gaat een uitnodiging naar ${g.email}.`)) return;
      try {
        Object.assign(g, await vraag('POST', `/api/beheer/gebruikers/${encodeURIComponent(g.id)}/uitnodiging`));
        teken();
        volgAccounts();
      } catch (fout) {
        toast(fout.message, 'fout');
      }
    }
    if (actie === 'voorbeeld') toonVoorbeeld(g, { magVersturen: true });
    if (actie === 'bewerk') bewerkDialoog(g, (wijziging) => werkBij(g, wijziging));
    if (actie === 'verwijder') {
      if (!confirm(`${g.naam || g.email} verwijderen? Ook diens meldingen, bewaarde stukken en notities verdwijnen.`)) return;
      try {
        await vraag('DELETE', `/api/beheer/gebruikers/${encodeURIComponent(g.id)}`);
        gebruikers = gebruikers.filter((x) => x.id !== g.id);
        teken();
      } catch (fout) {
        toast(fout.message, 'fout');
      }
    }
  });
  pagina.addEventListener('change', (e) => {
    const veld = e.target.dataset.veld;
    const rij = e.target.closest('[data-id]');
    if (!veld || !rij) return;
    const g = gebruikers.find((x) => x.id === rij.dataset.id);
    werkBij(g, { [veld]: e.target.value });
  });
  pagina.addEventListener('submit', async (e) => {
    if (e.target.id !== 'uitnodigen') return;
    e.preventDefault();
    const f = e.target;
    await bezig(f.querySelector('button'), async () => {
      const g = await vraag('POST', '/api/beheer/gebruikers', {
        naam: f.naam.value, email: f.email.value, login: f.login.value || undefined, rol: f.rol.value, titel: f.titel.value, regios: [],
      });
      gebruikers.push(g);
      teken();
      toast(app.ik.autheliaAccounts && g.account?.status === 'aangevraagd'
        ? `${g.naam} uitgenodigd: het account wordt aangemaakt en de uitnodiging gemaild. Kies nu de regio's.`
        : `${g.naam} toegevoegd. Kies nu de regio's.`);
      volgAccounts();
    });
  });
  app.opruimen = () => {
    clearTimeout(wachtTimer);
    sluitPopovers();
  };
}

// ---------- Teams-kanalen ----------

function kanaalBronnen(c, keuzes) {
  const soorten = keuzes.soorten.filter((s) => c.soorten.includes(s.id)).map((s) => s.naam);
  const los = keuzes.soorten.flatMap((s) => s.bronnen).filter((b) => c.bronnen.includes(b.id)).map((b) => b.naam);
  return [...soorten, ...los];
}

function kanaalRij(c, keuzes) {
  const regios = c.regios.map((id) => keuzes.regios.find((r) => r.id === id)?.naam || id);
  const bronnen = kanaalBronnen(c, keuzes);
  const chips = (lijst, alle) => (lijst.length ? lijst.map((x) => `<span class="regiochip">${esc(x)}</span>`).join('') : `<span class="regiochip">${alle}</span>`);
  const laatst = c.laatsteFout
    ? `<span class="kanaalfout" title="${esc(c.laatsteFout)}">${esc(c.laatsteFout.slice(0, 90))}</span>`
    : c.laatsteSucces ? `${esc(geledenTekst(c.laatsteSucces))} · ${c.laatsteAantal} stuk${c.laatsteAantal === 1 ? '' : 'ken'}` : 'Nog niets verstuurd';
  return `<div class="tabelrij kanaalrij" data-id="${esc(c.id)}">
    <span class="naamcel"><strong>${esc(c.naam)}</strong><small>${esc(c.adres)}</small></span>
    <div class="regiochips-cel">${chips(regios, 'Alle regio\'s')}</div>
    <div class="regiochips-cel">${chips(bronnen, 'Alle bronnen')}</div>
    <button class="schakelaar" role="switch" aria-checked="${c.actief !== false}" data-actie="aan" title="Kanaal aan of uit"><span class="baan"><i></i></span><span class="tekst">${c.actief !== false ? 'Aan' : 'Uit'}</span></button>
    <span class="klein zacht">${laatst}</span>
    <span class="rijacties"><button class="linkknop" data-actie="test" title="Een proefbericht naar dit kanaal">Proef</button><button class="linkknop" data-actie="bewerk">Wijzig</button><button class="verwijder" data-actie="verwijder" aria-label="${esc(c.naam)} verwijderen">×</button></span>
  </div>`;
}

function kanaalDialoog(c, keuzes, opslaan) {
  let dialoog = $('#kanaal-dialoog');
  if (!dialoog) {
    dialoog = document.createElement('dialog');
    dialoog.id = 'kanaal-dialoog';
    dialoog.className = 'formulier breed';
    document.body.append(dialoog);
  }
  const vink = (naam, waarde, label, aan, extra = '') => `<label class="vink"><input type="checkbox" name="${naam}" value="${esc(waarde)}" ${aan ? 'checked' : ''} ${extra}><span class="vakje"></span>${esc(label)}</label>`;
  const regioNaam = (id) => keuzes.regios.find((r) => r.id === id)?.naam;
  dialoog.innerHTML = `<form method="dialog">
    <h2>${c ? esc(c.naam) : 'Nieuw Teams-kanaal'}</h2>
    <label class="veld"><span>Naam</span><input class="invoer" name="naam" value="${esc(c?.naam || '')}" placeholder="Bijvoorbeeld: Redactie Heerenveen" required></label>
    <label class="veld"><span>Adres van de workflow in Teams</span><input class="invoer" name="url" type="url" ${c ? '' : 'required'} placeholder="${c ? `Leeg laten: blijft ${esc(c.adres)}` : 'https://…'}" autocomplete="off"></label>
    <fieldset class="veld"><legend>Regio's</legend><div class="vinkraster">${keuzes.regios.map((r) => vink('regio', r.id, r.naam, c?.regios.includes(r.id))).join('')}</div>
      <p class="uitleg-klein kanaalhint">Niets aangevinkt: alle regio's. Een landelijke bron stuurt alleen wat via een sleutelwoord of plek bij een van deze regio's hoort.</p></fieldset>
    <fieldset class="veld"><legend>Bronnen</legend>
      ${keuzes.soorten.map((s) => {
        const heel = c?.soorten.includes(s.id);
        const los = s.bronnen.filter((b) => c?.bronnen.includes(b.id)).length;
        return `<div class="bronsoort">${vink('soort', s.id, `Alles uit ${s.naam}`, heel)}
          <details ${los ? 'open' : ''}><summary class="klein zacht">${s.bronnen.length === 1 ? '1 bron' : `${s.bronnen.length} bronnen`}${los ? ` · ${los} gekozen` : ''}</summary>
            <div class="vinkraster">${s.bronnen.map((b) => vink('bron', b.id, `${b.naam}${b.regio && !b.naam.includes(regioNaam(b.regio) || '\u0000') ? ` (${regioNaam(b.regio) || b.regio})` : ''}`, heel || c?.bronnen.includes(b.id), heel ? 'disabled' : '')).join('')}</div></details></div>`;
      }).join('')}
      <p class="uitleg-klein kanaalhint">Niets aangevinkt: alle bronnen. "Alles uit" geldt ook voor bronnen die er later bij komen.</p></fieldset>
    <div class="knoppenrij"><button class="knop primair" value="opslaan">Opslaan</button><button class="knop zacht" value="annuleer" formnovalidate>Annuleren</button></div>
  </form>`;
  const form = dialoog.querySelector('form');
  // "Alles uit" vinkt de losse bronnen van die soort mee aan, en zet ze vast.
  form.addEventListener('change', (e) => {
    if (e.target.name !== 'soort') return;
    for (const b of $$('input[name="bron"]', e.target.closest('.bronsoort'))) {
      b.checked = e.target.checked;
      b.disabled = e.target.checked;
    }
  });
  dialoog.showModal();
  dialoog.onclose = () => {
    if (dialoog.returnValue !== 'opslaan') return;
    const waarden = (naam) => $$(`input[name="${naam}"]:checked:not(:disabled)`, form).map((i) => i.value);
    opslaan({ naam: form.naam.value, ...(form.url.value ? { url: form.url.value } : {}), regios: waarden('regio'), soorten: waarden('soort'), bronnen: waarden('bron') });
  };
}

export async function toonTeams(hoofd) {
  let { kanalen, keuzes, siteUrl } = await vraag('GET', '/api/beheer/kanalen');
  hoofd.innerHTML = '<div class="pagina" id="kanalen"></div>';
  const teken = () => {
    $('#kanalen').innerHTML = `
      <div class="paginakop"><h1>Teams-kanalen</h1><span class="klein zacht">${kanalen.length ? `${kanalen.length} kana${kanalen.length === 1 ? 'al' : 'len'}` : 'Nog geen kanalen'}</span>
        <div class="rechts"><button class="knop primair klein" id="kanaal-nieuw">+ Kanaal</button></div></div>
      ${kanalen.length ? `<div class="tabelkop kanaalrij"><span>Kanaal</span><span>Regio's</span><span>Bronnen</span><span>Aan</span><span>Laatst verstuurd</span><span></span></div>
      ${kanalen.map((c) => kanaalRij(c, keuzes)).join('')}` : ''}
      <div class="uitleg-klein kanaaluitleg">
        <p>Wat er binnenkomt voor de gekozen regio's en bronnen, gaat na elke ronde als kaartje naar het kanaal: elk stuk een eigen kaartje, en bij meer dan tien tegelijk de oudere samen in één overzicht. Een nieuw kanaal begint vanaf nu, zonder achterstand.</p>
        <p><strong>Een kanaal koppelen:</strong> open in Teams het kanaal, kies bij de drie puntjes <em>Workflows</em> en dan <em>Post to a channel when a webhook request is received</em> (Nederlands: <em>Berichten in een kanaal plaatsen wanneer een webhookaanvraag wordt ontvangen</em>). Kies team en kanaal, en kopieer aan het eind het adres. Plak dat hier. Wie dat adres heeft, kan in het kanaal berichten zetten; het staat daarom alleen op de server en is hier na het opslaan niet meer te zien.</p>
        ${siteUrl ? '' : '<p>REGIOCHECKER_SITE_URL is niet ingesteld: de kaartjes krijgen dan geen knop naar de Regiochecker.</p>'}
      </div>`;
  };
  teken();
  const werkBij = async (c, wijziging) => {
    try {
      const nieuw = await vraag('PUT', `/api/beheer/kanalen/${encodeURIComponent(c.id)}`, wijziging);
      kanalen = kanalen.map((x) => (x.id === c.id ? nieuw : x));
    } catch (fout) {
      toast(fout.message, 'fout');
    }
    teken();
  };
  const pagina = $('#kanalen');
  pagina.addEventListener('click', async (e) => {
    const knop = e.target.closest('button');
    if (!knop) return;
    if (knop.id === 'kanaal-nieuw') {
      kanaalDialoog(null, keuzes, async (invoer) => {
        try {
          kanalen.push(await vraag('POST', '/api/beheer/kanalen', invoer));
          teken();
          toast(`${invoer.naam} toegevoegd. Stuur met "Proef" een proefbericht.`);
        } catch (fout) {
          toast(fout.message, 'fout');
        }
      });
      return;
    }
    const rij = knop.closest('[data-id]');
    const c = rij && kanalen.find((x) => x.id === rij.dataset.id);
    if (!c) return;
    const actie = knop.dataset.actie;
    if (actie === 'aan') werkBij(c, { actief: c.actief === false });
    if (actie === 'bewerk') kanaalDialoog(c, keuzes, (wijziging) => werkBij(c, wijziging));
    if (actie === 'test') {
      await bezig(knop, async () => {
        await vraag('POST', `/api/beheer/kanalen/${encodeURIComponent(c.id)}/test`);
        c.laatsteFout = null;
        toast(`Proefbericht naar ${c.naam} verstuurd. Staat het in het kanaal?`);
      });
      teken();
    }
    if (actie === 'verwijder') {
      if (!confirm(`Kanaal ${c.naam} verwijderen? Er gaat dan niets meer naartoe; de workflow in Teams blijft bestaan.`)) return;
      try {
        await vraag('DELETE', `/api/beheer/kanalen/${encodeURIComponent(c.id)}`);
        kanalen = kanalen.filter((x) => x.id !== c.id);
        teken();
      } catch (fout) {
        toast(fout.message, 'fout');
      }
    }
  });
}

// ---------- Telegram-bot ----------

const CHATSTATUS = { wacht: 'Wacht op goedkeuring', goedgekeurd: 'Goedgekeurd', geblokkeerd: 'Geblokkeerd' };
const CHATSOORT = { private: 'Persoon', group: 'Groep', supergroup: 'Groep', channel: 'Kanaal' };

function botStatus(t) {
  if (!t.token) return { staat: 'ontbreekt', tekst: 'Nog geen bot' };
  if (t.status.staat === 'fout') return { staat: 'fout', tekst: t.status.fout };
  if (t.status.staat === 'aan') return { staat: 'werkt', tekst: `Verbonden als @${t.status.bot}` };
  return { staat: 'wacht', tekst: 'Verbinden…' };
}

export async function toonTelegram(hoofd) {
  let t = await vraag('GET', '/api/beheer/telegram');
  hoofd.innerHTML = '<div class="pagina" id="telegram"></div>';
  const teken = () => {
    const s = botStatus(t);
    const wacht = t.chats.filter((c) => c.status === 'wacht').length;
    $('#telegram').innerHTML = `
      <div class="paginakop"><h1>Telegram-bot</h1><span class="klein zacht">Inzendingen van tipgevers${wacht ? ` · ${wacht} chat${wacht === 1 ? '' : 's'} wacht${wacht === 1 ? '' : 'en'} op goedkeuring` : ''}</span></div>
      ${instelBlok('Bot', 'Maak een bot via @BotFather in Telegram en plak het token hier. De Regiochecker haalt de berichten zelf op; de bot mag dus geen webhook elders hebben.', `
        <div class="botregel">${statusHtml(s)}${t.status.tijd && t.status.staat === 'aan' ? `<span class="klein zacht">laatst ${esc(uurMinuut(t.status.tijd))}</span>` : ''}</div>
        <form class="tokenrij" id="token-form">
          <input class="invoer" name="token" type="password" autocomplete="off" placeholder="${t.token ? (t.tokenUitOmgeving ? 'Uit TELEGRAM_BOT_TOKEN; plak hier een ander token' : 'Ingesteld; plak hier een nieuw token') : '123456789:ABC…'}">
          <button class="knop inkt klein">Opslaan</button>${t.token && !t.tokenUitOmgeving ? '<button class="linkknop" type="button" id="token-wis">Bot loskoppelen</button>' : ''}
        </form>
        <label class="vink"><input type="checkbox" id="reageren" ${t.reageren ? 'checked' : ''}><span class="vakje"></span>Duim omhoog bij een inzending die binnen is</label>`)}
      ${instelBlok('Vooraf goedgekeurd', 'Een chat van deze afzenders (of deze groep) is meteen goedgekeurd: @gebruikersnaam of het nummer van een persoon of groep.', `
        <div class="regiochips-cel">${t.vooraf.map((h) => `<span class="regiochip">${esc(/^-?\d+$/.test(h) ? h : `@${h}`)} <button class="verwijder" data-vooraf="${esc(h)}" aria-label="${esc(h)} weghalen">×</button></span>`).join('') || '<span class="klein zacht">Nog niemand.</span>'}</div>
        <form class="tokenrij" id="vooraf-form"><input class="invoer" name="handle" placeholder="@fotograaf of 123456789" required><button class="knop zacht klein">Toevoegen</button></form>`)}
      <h2 class="sectiekop">Chats</h2>
      ${t.chats.length ? `<div class="tabelkop chatrij"><span>Chat</span><span>Soort</span><span>Berichten</span><span>Laatst</span><span>Status</span><span></span></div>
      ${t.chats.map((c) => `<div class="tabelrij chatrij" data-chat="${esc(c.id)}">
        <span class="naamcel"><strong>${esc(c.naam || c.id)}</strong><small>${esc([c.username && `@${c.username}`, c.id].filter(Boolean).join(' · '))}</small></span>
        <span class="klein">${esc(CHATSOORT[c.type] || c.type || '')}</span>
        <span class="klein">${c.aantal || 0}</span>
        <span class="klein zacht">${esc(geledenTekst(c.laatst))}</span>
        <span class="klein ${c.status === 'wacht' ? 'kanaalfout' : ''}">${esc(CHATSTATUS[c.status] || c.status)}</span>
        <span class="rijacties">${c.status !== 'goedgekeurd' ? '<button class="linkknop" data-status="goedgekeurd">Goedkeuren</button>' : ''}${c.status !== 'geblokkeerd' ? '<button class="linkknop" data-status="geblokkeerd">Blokkeren</button>' : ''}${c.status !== 'wacht' ? '<button class="linkknop" data-status="wacht">Terugzetten</button>' : ''}</span>
      </div>`).join('')}` : '<p class="leeg">Nog geen berichten aan de bot.</p>'}
      <div class="uitleg-klein kanaaluitleg">
        <p>Een nieuwe chat (een persoon die de bot een bericht stuurt, of een groep waar de bot in zit) wacht eerst op goedkeuring; de inzender krijgt daar een bericht over, en kan zijn telefoonnummer delen. Berichten van vóór de goedkeuring worden niet bewaard. Na goedkeuring wordt elk bericht met tekst, foto, video of locatie een stuk onder <strong>Ingezonden</strong>; een album wordt één stuk. Een gedeelde locatie of een plaatsnaam ("brand in Gorredijk") bepaalt de regio; zonder plaats staat een inzending bij alle regio's.</p>
        <p>In een groep ziet een bot alleen alle berichten als hij beheerder is, of als bij @BotFather de privacymodus uit staat (/setprivacy).</p>
      </div>`;
  };
  teken();
  const werk = async (methode, pad, body) => {
    try {
      t = await vraag(methode, `/api/beheer/telegram${pad}`, body);
    } catch (fout) {
      toast(fout.message, 'fout');
    }
    teken();
  };
  const pagina = $('#telegram');
  pagina.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.target.id === 'token-form' && e.target.token.value) await bezig(e.target.querySelector('button'), () => werk('PUT', '', { token: e.target.token.value }), 'Verbinden…');
    if (e.target.id === 'vooraf-form') await werk('POST', '/vooraf', { handle: e.target.handle.value });
  });
  pagina.addEventListener('click', (e) => {
    const knop = e.target.closest('button');
    if (!knop) return;
    if (knop.id === 'token-wis' && confirm('De bot loskoppelen? Er komen dan geen inzendingen meer binnen.')) werk('PUT', '', { wisToken: true });
    if (knop.dataset.vooraf) werk('DELETE', `/vooraf/${encodeURIComponent(knop.dataset.vooraf)}`);
    const chat = knop.closest('[data-chat]');
    if (chat && knop.dataset.status) werk('PUT', `/chats/${encodeURIComponent(chat.dataset.chat)}`, { status: knop.dataset.status });
  });
  pagina.addEventListener('change', (e) => {
    if (e.target.id === 'reageren') werk('PUT', '', { reageren: e.target.checked });
  });
  // Even later nog eens: na een nieuw token weet de bot pas na een paar seconden wie hij is.
  const ververs = setInterval(async () => {
    if (!document.body.contains(pagina)) return clearInterval(ververs);
    if (document.activeElement?.closest('#telegram form')) return;
    try {
      t = await vraag('GET', '/api/beheer/telegram');
      teken();
    } catch { /* volgende keer */ }
  }, 15_000);
  app.opruimen = () => clearInterval(ververs);
}

// ---------- logboek ----------

export async function toonLogboek(hoofd) {
  const log = await vraag('GET', '/api/logboek');
  hoofd.innerHTML = `<div class="pagina">
    <div class="paginakop"><h1>Logboek</h1><span class="klein zacht">Verzonden mails, meldingen en fouten (de laatste 200)</span></div>
    <div class="tabelkop logrij"><span>Tijd</span><span>Soort</span><span>Aan</span><span>Wat</span></div>
    ${log.length ? log.map((r) => `<div class="tabelrij logrij"><span class="klein">${esc(moment(r.tijd))}</span><span class="klein">${esc(r.soort)}</span><span class="klein">${esc(r.aan || '')}</span><span class="tekst">${esc(r.tekst)}</span></div>`).join('') : '<p class="leeg">Nog niets.</p>'}
  </div>`;
}

// ---------- instellingen ----------

function instelBlok(titel, uitleg, inhoud) {
  return `<div class="instelblok"><div><span class="titel">${titel}</span><span class="uitleg">${uitleg}</span></div><div class="inhoud">${inhoud}</div></div>`;
}

export async function toonInstellingen(hoofd) {
  let i = await vraag('GET', '/api/instellingen');
  let kamer = null;
  try { kamer = await vraag('GET', '/api/kamer/status'); } catch { /* geen database */ }

  const teken = () => {
    const via = i.samenvattingVia || 'claude';
    hoofd.innerHTML = `<div class="pagina"><div class="paginakop"><h1>Instellingen</h1></div><div class="instellingen">
      ${instelBlok('Bronnen controleren', 'Hoe vaak de Regiochecker de websites afgaat. Kamerstukken worden elk half uur bijgewerkt, audio elk kwartier.', `
        <form id="form-interval"><label class="veld"><span>Elke … minuten</span><input class="invoer smal" type="number" name="controleIntervalMinuten" min="15" max="1440" step="5" value="${esc(i.controleIntervalMinuten)}"></label>
        <div class="knoppenrij"><button class="knop inkt klein">Bewaren</button></div></form>
        ${kamer ? `<p class="statusregel">Kamerstukken: ${kamer.metTekst || 0} doorzoekbaar sinds ${esc(moment(kamer.vanaf || kamer.oudste))}${kamer.wachtrij ? `, ${kamer.wachtrij} in de wachtrij` : ''}; laatst bijgewerkt ${esc(moment(kamer.ronde?.tijd))}.</p>
        <div class="knoppenrij"><button class="knop klein" id="kamer-nu">Kamerstukken nu bijwerken</button></div>` : '<p class="statusregel fout">De kamerstukkendatabase is niet beschikbaar.</p>'}`)}

      ${instelBlok('Weekmail', 'Iedereen stelt zijn eigen weekmail in bij Meldingen. Dit is het schema voor nieuwe gebruikers.', `
        <form id="form-weekmail">
          <div class="veld"><span>Dagen</span><div class="dagen" id="standaard-dagen">${DAGEN_KORT.map((d, n) => `<button type="button" aria-pressed="${i.mailDagen.includes(n + 1)}" data-dag="${n + 1}">${d}</button>`).join('')}</div></div>
          <div class="rij-velden"><label class="veld"><span>Tijd</span><input class="invoer smal" type="time" name="mailTijd" value="${esc(i.mailTijd)}"></label>
          <div class="veld"><span>Ook als er niets nieuws is</span><label class="vinkregel"><input type="checkbox" name="mailBijNiets" ${i.mailBijNiets ? 'checked' : ''}><span class="vakje"></span>Ja</label></div></div>
          <div class="knoppenrij"><button class="knop inkt klein">Bewaren</button><button type="button" class="knop klein" id="mailronde">Weekmail nu naar iedereen sturen</button></div>
          <p class="uitleg-klein">"Nu naar iedereen" stuurt elke gebruiker met de weekmail aan alles sinds diens vorige mail. Het volgende geplande moment gaat gewoon door.</p>
        </form>`)}

      ${instelBlok('Uitgaande mail (SMTP)', 'Zonder SMTP gaan er geen weekmails en meldingen de deur uit.', `
        <form id="form-smtp">
          <div class="drie"><label class="veld"><span>Server</span><input class="invoer" name="host" value="${esc(i.smtp.host)}" placeholder="smtp.example.nl"></label>
          <label class="veld"><span>Poort</span><input class="invoer" name="port" type="number" value="${esc(i.smtp.port)}"></label>
          <div class="veld"><span>Versleuteling</span><label class="vinkregel"><input type="checkbox" name="secure" ${i.smtp.secure ? 'checked' : ''}><span class="vakje"></span>Direct TLS (465)</label></div></div>
          <div class="twee"><label class="veld"><span>Gebruikersnaam</span><input class="invoer" name="user" value="${esc(i.smtp.user)}" autocomplete="off"></label>
          <label class="veld"><span>Wachtwoord</span><input class="invoer" name="pass" type="password" autocomplete="new-password" placeholder="${i.smtp.heeftWachtwoord ? '•••••• (ingesteld)' : ''}"></label></div>
          <label class="veld"><span>Afzender</span><input class="invoer" name="from" value="${esc(i.smtp.from)}" placeholder="Regiochecker &lt;regiochecker@example.nl&gt;"></label>
          <div class="knoppenrij"><button class="knop inkt klein">Bewaren</button>${i.smtp.heeftWachtwoord ? '<button type="button" class="knop zacht klein" id="wis-wachtwoord">Wachtwoord wissen</button>' : ''}</div>
          <div class="twee"><label class="veld"><span>Testmail naar</span><input class="invoer" id="testmail-aan" type="email" placeholder="jij@example.nl"></label><div class="veld"><span>&nbsp;</span><button type="button" class="knop klein" id="testmail">Testmail sturen</button></div></div>
        </form>`)}

      ${instelBlok('Samenvatting', 'Wie schrijft per gemeente de samenvatting van de week, en per raadsvergadering de samenvatting per onderwerp? Het taalmodel krijgt titel en inhoud van elk stuk, of het transcript.', `
        <form id="form-samenvatting">
          <div class="segmenten">${[['claude', 'Claude (Anthropic)'], ['ollama', 'Eigen Ollama'], ['uit', 'Uit']].map(([w, t]) => `<button type="button" data-via="${w}" aria-pressed="${via === w}">${t}</button>`).join('')}</div>
          ${via === 'claude' ? `<div class="twee"><label class="veld"><span>API-sleutel</span><input class="invoer" name="apiKey" type="password" autocomplete="off" placeholder="${i.claude.heeftSleutel ? (i.claude.sleutelUitOmgeving ? 'ingesteld via de omgeving' : '•••••• (ingesteld)') : 'sk-ant-…'}"></label>
            <label class="veld"><span>Model</span><input class="invoer" name="claudeModel" value="${esc(i.claude.model)}"></label></div>` : ''}
          ${via === 'ollama' ? `<p class="uitleg-klein">${i.tailnetProxy ? 'Verbinding via de Tailscale-container: gebruik de naam of het 100.x-adres van de machine in je tailnet.' : 'Rechtstreekse verbinding (geen Tailscale-proxy ingesteld).'}</p>
            <div class="twee"><label class="veld"><span>URL</span><input class="invoer" name="ollamaUrl" value="${esc(i.ollama.url)}" placeholder="http://naam-van-machine:11434"></label>
            <div class="veld"><span>&nbsp;</span><div class="knoppenrij"><button type="button" class="knop klein" id="ollama-test">Verbinding testen</button><span class="statusregel" id="ollama-status"></span></div></div></div>
            <div class="twee"><label class="veld"><span>Model</span><input class="invoer" name="ollamaModel" list="ollama-modellen" value="${esc(i.ollama.model)}" placeholder="bijvoorbeeld qwen3:14b"><datalist id="ollama-modellen"></datalist></label>
            <label class="veld"><span>Grootste contextvenster (tokens)</span><input class="invoer" name="maxContext" type="number" min="4096" max="262144" step="1024" value="${esc(i.ollama.maxContext)}"></label></div>
            <div class="twee"><label class="veld"><span>Model voor opnames</span><input class="invoer" name="modelOpnames" list="ollama-modellen" value="${esc(i.ollama.modelOpnames || '')}" placeholder="leeg: hetzelfde model"></label>
            <p class="uitleg-klein" style="align-self:end">Voor de AI-samenvatting van vergaderingen en podcasts. Een klein model dat helemaal op de GPU past (zoals dat van de Whisper-worker) is daar veel sneller en laat Whisper de ruimte.</p></div>` : ''}
          <p class="statusregel${i.samenvatting.klaar || via === 'uit' ? '' : ' fout'}">${i.samenvatting.klaar ? `Klaar: ${esc(i.samenvatting.model)}` : esc(i.samenvatting.reden || '')}</p>
          <div class="knoppenrij"><button class="knop inkt klein">Bewaren</button>${via === 'claude' && i.claude.heeftSleutel && !i.claude.sleutelUitOmgeving ? '<button type="button" class="knop zacht klein" id="wis-sleutel">Sleutel wissen</button>' : ''}</div>
        </form>`)}

      ${instelBlok('Audio en video', 'Transcriberen, stemmen herkennen en namen zoeken doet de Whisper-worker in het thuisnetwerk, via Tailscale. Het token staat alleen op de server.', `
        <form id="form-audio">
          <div class="twee"><label class="veld"><span>Adres van de worker</span><input class="invoer" name="workerUrl" value="${esc(i.audio.workerUrl)}" placeholder="http://naam-of-ip:8765"></label>
          <label class="veld"><span>Token</span><input class="invoer" name="workerToken" type="password" autocomplete="off" placeholder="${i.audio.heeftToken ? (i.audio.tokenUitOmgeving ? 'ingesteld via de omgeving' : '•••••• (ingesteld)') : 'token van de worker'}"></label></div>
          <label class="vinkregel"><input type="checkbox" name="viaTailnet" ${i.audio.viaTailnet ? 'checked' : ''} ${i.tailnetProxy ? '' : 'disabled'}><span class="vakje"></span>Via Tailscale</label>
          <div class="twee"><label class="veld"><span>Audio bewaren om terug te luisteren</span><select class="keuzelijst" name="bewaarAudio">
            ${[['vergaderingen', 'Alleen raadsvergaderingen'], ['alles', 'Alles'], ['niets', 'Niets (alleen het transcript)']].map(([w, t]) => `<option value="${w}" ${i.audio.bewaarAudio === w ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label class="veld"><span>Hoe lang (dagen)</span><input class="invoer smal" type="number" name="bewaarDagen" min="1" max="3650" value="${esc(i.audio.bewaarDagen)}"></label></div>
          <p class="uitleg-klein">Een uur audio is zo'n 29 MB. YouTube speelt altijd af bij YouTube zelf; een podcast bij de bron.</p>
          <label class="vinkregel"><input type="checkbox" name="namenZoeken" ${i.audio.namenZoeken ? 'checked' : ''}><span class="vakje"></span>Namen zoeken met AI (personen, plaatsen, organisaties)</label>
          <p class="uitleg-klein">Kost bij een lange vergadering een kwartier GPU-tijd op de worker. Namen van sprekers komen uit de gegevens van het vergaderplatform, ook als dit uit staat.</p>
          <div class="knoppenrij"><button class="knop inkt klein">Bewaren</button><button type="button" class="knop klein" id="worker-test">Verbinding testen</button>${i.audio.heeftToken && !i.audio.tokenUitOmgeving ? '<button type="button" class="knop zacht klein" id="wis-token">Token wissen</button>' : ''}<span class="statusregel" id="worker-status"></span></div>
        </form>`)}

      ${instelBlok('Kamerdebatten (gehoord.de)', 'gehoord.de transcribeert de debatten in de Tweede en Eerste Kamer live, met tijd, spreker en fractie. Koppel een account: je logt bij gehoord.de zelf in; de Regiochecker krijgt alleen een toegangssleutel, en die blijft op de server.', `
        <p class="statusregel${i.gehoord.fout ? ' fout' : ''}">${i.gehoord.gekoppeld ? `Gekoppeld sinds ${esc(moment(i.gehoord.sinds))}.` : 'Niet gekoppeld.'}${i.gehoord.fout ? ` ${esc(i.gehoord.fout)}` : ''}</p>
        <div class="knoppenrij">${i.gehoord.gekoppeld ? '<button type="button" class="knop zacht klein" id="gehoord-los">Ontkoppelen</button>' : '<button type="button" class="knop inkt klein" id="gehoord-koppel">Koppelen met gehoord.de</button>'}</div>
        ${i.gehoord.gekoppeld ? '<div id="gehoord-tools"><p class="uitleg-klein">Wat gehoord.de aanbiedt, wordt opgehaald…</p></div>' : ''}`)}
    </div></div>`;
    if (i.gehoord.gekoppeld) toonGehoordTools();
  };
  // Wat de MCP-server van gehoord.de aanbiedt, ter controle.
  async function toonGehoordTools() {
    const doel = $('#gehoord-tools');
    try {
      const g = await vraag('GET', '/api/beheer/gehoord');
      if (!doel.isConnected) return;
      doel.innerHTML = g.tools ? `<p class="uitleg-klein">${esc(g.server?.name || 'gehoord.de')}: ${g.tools.length} ${g.tools.length === 1 ? 'functie' : 'functies'}.</p>
        <ul class="uitleg-klein">${g.tools.map((t) => `<li><strong>${esc(t.titel || t.naam)}</strong>${t.omschrijving ? ` · ${esc(t.omschrijving.split('\n')[0].slice(0, 160))}` : ''}</li>`).join('')}</ul>`
        : `<p class="statusregel fout">${esc(g.fout || 'Niet bereikbaar.')}</p>`;
    } catch (fout) {
      if (doel.isConnected) doel.innerHTML = `<p class="statusregel fout">${esc(fout.message)}</p>`;
    }
  }

  teken();
  // Terug van het koppelen bij gehoord.de (?gehoord=… achter de hash).
  const terug = new URLSearchParams(location.hash.split('?')[1] || '').get('gehoord');
  if (terug) {
    toast(terug === 'gekoppeld' ? 'Gekoppeld met gehoord.de' : `Koppelen mislukt: ${terug}`, terug === 'gekoppeld' ? 'ok' : 'fout');
    history.replaceState(null, '', '#/beheer/instellingen');
  }

  const bewaar = async (knop, wijziging, melding = 'Bewaard') => bezig(knop, async () => {
    i = await vraag('PUT', '/api/instellingen', wijziging);
    teken();
    toast(melding);
  });

  // De luisteraars hangen aan <main>, dat blijft bestaan: opruimen bij weggaan.
  const stop = new AbortController();
  app.opruimen = () => stop.abort();
  hoofd.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const knop = f.querySelector('button:not([type="button"])');
    if (f.id === 'form-interval') bewaar(knop, { controleIntervalMinuten: Number(f.controleIntervalMinuten.value) });
    if (f.id === 'form-weekmail') {
      const dagen = $$('#standaard-dagen [aria-pressed="true"]').map((b) => Number(b.dataset.dag));
      bewaar(knop, { mailTijd: f.mailTijd.value, mailDagen: dagen, mailBijNiets: f.mailBijNiets.checked });
    }
    if (f.id === 'form-smtp') bewaar(knop, { smtp: { host: f.host.value, port: Number(f.port.value), secure: f.secure.checked, user: f.user.value, pass: f.pass.value, from: f.from.value } });
    if (f.id === 'form-samenvatting') {
      const w = { samenvattingVia: i.samenvattingVia };
      if (f.apiKey || f.claudeModel) w.claude = { apiKey: f.apiKey?.value || undefined, model: f.claudeModel?.value || undefined };
      if (f.ollamaUrl) w.ollama = { url: f.ollamaUrl.value, model: f.ollamaModel.value, maxContext: Number(f.maxContext.value), modelOpnames: f.modelOpnames.value };
      bewaar(knop, w);
    }
    if (f.id === 'form-audio') bewaar(knop, { audio: { workerUrl: f.workerUrl.value, workerToken: f.workerToken.value || undefined, viaTailnet: f.viaTailnet.checked, bewaarAudio: f.bewaarAudio.value, bewaarDagen: Number(f.bewaarDagen.value), namenZoeken: f.namenZoeken.checked } });
  }, { signal: stop.signal });

  hoofd.addEventListener('click', async (e) => {
    const knop = e.target.closest('button');
    if (!knop) return;
    if (knop.dataset.dag) {
      knop.setAttribute('aria-pressed', String(knop.getAttribute('aria-pressed') !== 'true'));
      return;
    }
    if (knop.dataset.via) {
      // Eerst wat er is ingevuld bewaren, anders is het na het wisselen weg.
      i.samenvattingVia = knop.dataset.via;
      teken();
      return;
    }
    if (knop.id === 'wis-wachtwoord') bewaar(knop, { smtp: { wisWachtwoord: true } }, 'Wachtwoord gewist');
    if (knop.id === 'wis-sleutel') bewaar(knop, { claude: { wisSleutel: true } }, 'Sleutel gewist');
    if (knop.id === 'testmail') {
      const aan = $('#testmail-aan').value.trim();
      await bezig(knop, async () => {
        await vraag('POST', '/api/testmail', { aan });
        toast(`Testmail verstuurd naar ${aan}`);
      });
    }
    if (knop.id === 'kamer-nu') {
      await bezig(knop, async (zet) => {
        await voerUit('kamer', {}, zet);
        kamer = await vraag('GET', '/api/kamer/status');
        teken();
        toast('Kamerstukken bijgewerkt.');
      });
    }
    if (knop.id === 'mailronde') {
      if (!confirm('De weekmail nu naar iedereen sturen die hem aan heeft staan?')) return;
      await bezig(knop, async (zet) => {
        const r = await voerUit('mailronde', {}, zet);
        toast(`${r.filter((x) => x.verstuurd).length} verstuurd, ${r.filter((x) => x.fout).length} mislukt, ${r.filter((x) => !x.verstuurd && !x.fout).length} zonder nieuws`);
      });
    }
    if (knop.id === 'ollama-test') {
      const status = $('#ollama-status');
      await bezig(knop, async () => {
        status.textContent = '';
        try {
          const r = await vraag('POST', '/api/ollama/test', { url: $('[name="ollamaUrl"]').value });
          status.className = 'statusregel';
          status.textContent = `Verbonden, Ollama ${r.versie || ''}: ${r.modellen.length} modellen`;
          $('#ollama-modellen').innerHTML = r.modellen.map((m) => `<option value="${esc(m.naam)}">${esc([m.parameters].filter(Boolean).join(' '))}</option>`).join('');
        } catch (fout) {
          status.className = 'statusregel fout';
          status.textContent = fout.message;
        }
      });
    }
    if (knop.id === 'wis-token') bewaar(knop, { audio: { wisToken: true } }, 'Token gewist');
    if (knop.id === 'gehoord-koppel') {
      await bezig(knop, async () => {
        const { url } = await vraag('POST', '/api/beheer/gehoord/koppel', {});
        location.href = url;
      });
    }
    if (knop.id === 'gehoord-los') {
      if (!confirm('De koppeling met gehoord.de verwijderen?')) return;
      await bezig(knop, async () => {
        await vraag('DELETE', '/api/beheer/gehoord');
        i = await vraag('GET', '/api/instellingen');
        teken();
        toast('Ontkoppeld');
      });
    }
    if (knop.id === 'worker-test') {
      const status = $('#worker-status');
      const f = $('#form-audio');
      await bezig(knop, async () => {
        status.textContent = '';
        try {
          const r = await vraag('POST', '/api/worker/test', { workerUrl: f.workerUrl.value, workerToken: f.workerToken.value || undefined, viaTailnet: f.viaTailnet.checked });
          status.className = r.token === false ? 'statusregel fout' : 'statusregel';
          status.textContent = `Verbonden${r.viaTailnet ? ' via Tailscale' : ''}: Whisper ${r.model || '?'}${r.gpu ? ` op ${r.gpu}` : ''}${r.stemmen ? ', stemherkenning' : ''}. ${r.token === true ? 'Token klopt.' : r.token === false ? 'Het token wordt geweigerd.' : 'Token niet gecontroleerd.'}`;
        } catch (fout) {
          status.className = 'statusregel fout';
          status.textContent = fout.message;
        }
      });
    }
  }, { signal: stop.signal });
}

// ---------- audio en video: de verwerking ----------

const STATUSNAAM = { wacht: 'In de wachtrij', downloaden: 'Downloaden', transcriberen: 'Transcriberen', getranscribeerd: 'Namen zoeken', analyseren: 'Namen zoeken', klaar: 'Klaar', mislukt: 'Mislukt' };

function workerRegel(w) {
  if (!w.ingesteld) return '<span class="statusregel fout">De Whisper-worker is nog niet ingesteld (Instellingen › Audio en video).</span>';
  if (!w.token) return '<span class="statusregel fout">Het token van de Whisper-worker ontbreekt (Instellingen › Audio en video).</span>';
  if (!w.bereikbaar) return `<span class="statusregel fout">Worker niet bereikbaar: ${esc(w.fout || '')}</span>`;
  return `<span class="statusregel">Worker online${w.viaTailnet ? ' via Tailscale' : ''} · Whisper ${esc(w.model || '')}${w.gpu ? ` op ${esc(w.gpu)}` : ''}${w.stemmen ? ' · stemherkenning' : ''} · GPU ${w.bezig ? 'bezig' : 'vrij'}</span>`;
}

function afleveringRij(a, { knop = '' } = {}) {
  return `<div class="tabelrij audiorij">
    <span class="naamcel"><strong>${esc(a.titel)}</strong><small>${esc(a.bronNaam)}${a.gepubliceerd ? ` · ${esc(moment(a.gepubliceerd, { metTijd: false }))}` : ''}${a.duur ? ` · ${Math.round(a.duur / 60)} min` : ''}</small></span>
    <span class="statuscel"><span>${esc(STATUSNAAM[a.status] || a.status)}</span><small>${esc(a.stap || '')}${a.fout ? ` · ${esc(a.fout.slice(0, 200))}` : ''}</small></span>
    <span class="rechts-uitgelijnd">${knop}</span>
  </div>`;
}

export async function toonAudio(hoofd) {
  let d = await vraag('GET', '/api/beheer/audio');
  hoofd.innerHTML = '<div class="pagina" id="audiobeheer"></div>';
  const teken = () => {
    const bronnen = d.bronnen;
    $('#audiobeheer').innerHTML = `
      <div class="paginakop"><h1>Audio en video</h1>${workerRegel(d.worker)}
        <div class="rechts">
          <button class="schakelaar" role="switch" aria-checked="${!d.gepauzeerd}" id="pauze" title="Alle verwerking stilleggen of hervatten"><span class="baan"><i></i></span><span class="tekst">${d.gepauzeerd ? 'Gepauzeerd' : 'Verwerking loopt'}</span></button>
          <a class="knop primair klein" href="#/beheer/bronnen?soort=audio">+ Bron toevoegen</a>
        </div></div>
      <div class="instellingen" style="max-width:none">
        <section class="sectie">
          <div class="sectiekop"><span class="titel">Nu bezig</span><span class="uitleg">Eén aflevering tegelijk: de GPU wordt gedeeld met Plaud en Storyteller.</span></div>
          ${d.bezig.length ? d.bezig.map((a) => afleveringRij(a)).join('') : '<p class="leeg" style="padding-left:0">Niets.</p>'}
        </section>
        <section class="sectie">
          <div class="sectiekop"><span class="titel">Wachtrij</span><span class="uitleg">${d.inWachtrij} ${d.inWachtrij === 1 ? 'stap' : 'stappen'} te gaan. Eerst wat nieuw is, per bron het nieuwste eerst; het archief daarna, het nieuwste eerst over alle bronnen.</span></div>
          ${d.wachtrij.length ? d.wachtrij.map((a) => afleveringRij(a)).join('') : '<p class="leeg" style="padding-left:0">Leeg.</p>'}
        </section>
        ${d.mislukt.length ? `<section class="sectie">
          <div class="sectiekop"><span class="titel">Mislukt</span><span class="uitleg">Na drie pogingen. Tijdelijke storingen (worker of netwerk weg) blijven vanzelf herkansen.</span></div>
          ${d.mislukt.map((a) => afleveringRij(a, { knop: `<button class="knop klein" data-opnieuw="${esc(a.id)}">Opnieuw</button>` })).join('')}
        </section>` : ''}
        <section class="sectie">
          <div class="sectiekop"><span class="titel">Volgorde van de bronnen</span><span class="uitleg">Nieuwe afleveringen gaan in deze volgorde: een bron eerst helemaal, dan de volgende.</span></div>
          ${bronnen.length ? bronnen.map((b, i) => `<div class="tabelrij volgorderij">
            <span class="tab-nums" style="font-weight:600">${i + 1}</span>
            <span class="naamcel"><strong>${esc(b.naam)}</strong><small>${esc(b.lezer)} · ${esc(audioTelling(b.audio))}${b.audio.actief ? '' : ' · gepauzeerd'}</small></span>
            <span class="statuscel">${statusHtml(b.audio.actief ? b.status : { staat: 'wacht', tekst: 'Gepauzeerd' })}<small>${esc(rondeTekst(b))}</small></span>
            <span class="rijacties">
              <button class="knop zacht klein" data-omhoog="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Eerder">↑</button>
              <button class="knop zacht klein" data-omlaag="${i}" ${i === bronnen.length - 1 ? 'disabled' : ''} aria-label="Later">↓</button>
              <button class="knop klein" data-controleer="${esc(b.id)}">Nu controleren</button>
            </span>
          </div>`).join('') : '<p class="leeg" style="padding-left:0">Nog geen audio- of videobronnen.</p>'}
        </section>
      </div>`;
  };
  teken();
  const ververs = async () => {
    try {
      d = await vraag('GET', '/api/beheer/audio');
      teken();
    } catch { /* volgende keer */ }
  };
  const wekker = setInterval(ververs, 10_000);
  app.opruimen = () => clearInterval(wekker);

  $('#audiobeheer').addEventListener('click', async (e) => {
    const knop = e.target.closest('button');
    if (!knop) return;
    try {
      if (knop.id === 'pauze') d = await vraag('PUT', '/api/beheer/audio', { gepauzeerd: !d.gepauzeerd });
      else if (knop.dataset.opnieuw) d = await vraag('POST', '/api/beheer/audio/opnieuw', { id: knop.dataset.opnieuw });
      else if (knop.dataset.omhoog || knop.dataset.omlaag) {
        const ids = d.bronnen.map((b) => b.id);
        const i = Number(knop.dataset.omhoog ?? knop.dataset.omlaag);
        const j = knop.dataset.omhoog ? i - 1 : i + 1;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        d = await vraag('PUT', '/api/beheer/audio/volgorde', { ids });
      } else if (knop.dataset.controleer) {
        await bezig(knop, async () => {
          const r = await vraag('POST', `/api/beheer/bronnen/${encodeURIComponent(knop.dataset.controleer)}/controleer`, {});
          toast(r.ok ? `${r.nieuw} nieuwe ${r.nieuw === 1 ? 'aflevering' : 'afleveringen'} in de wachtrij` : `Controleren mislukt: ${r.fout}`, r.ok ? 'ok' : 'fout');
        }, 'Controleren…');
        d = await vraag('GET', '/api/beheer/audio');
      }
      teken();
    } catch (fout) {
      toast(fout.message, 'fout');
    }
  });
}
