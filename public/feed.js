// De feed (2a), Bewaard en Zoeken: lijst links, leespaneel rechts. Een
// raadsvergadering of andere audio krijgt het leespaneel van 2b: speler,
// treffers, transcript met sprekers. Filteren gebeurt hier in de browser; de
// server levert de hele lijst van de afgelopen dertig dagen.

import { $, $$, esc, vraag, icoon, toast, bezig, dagKop, uurMinuut, moment, tijdcode, duurTekst, markeer, markeerTermen } from './gedeeld.js';
import { app, zetBewaardTeller, laadIk } from './app.js';
import { archiefFilters, archiefBalkHtml, koppelArchiefBalk, laadBronnen } from './archief.js';

const STATUSNAAM = { wacht: 'in de wachtrij', downloaden: 'wordt gedownload', transcriberen: 'wordt getranscribeerd', getranscribeerd: 'wordt geanalyseerd', analyseren: 'wordt geanalyseerd', mislukt: 'mislukt' };

const GROEPEN = ['alles', 'nieuws', 'ingekomen', 'woo', 'kamerstuk', 'audio', 'knmi', 'rvs', 'ransomware', 'verkeer'];
const GROEPNAAM = { alles: 'Alles', nieuws: 'Gemeentenieuws', ingekomen: 'Ingekomen', woo: 'Woo', kamerstuk: 'Kamerstukken', audio: 'Audio & video', knmi: 'KNMI', rvs: 'Raad van State', ransomware: 'Ransomware', verkeer: 'Verkeer' };

// Filters blijven staan als je even naar een andere pagina gaat.
const filters = { groep: 'alles', regio: '', ongelezen: false };

const staat = {
  modus: 'feed',
  zoekvraag: '',
  items: [],
  gekozen: null,
  detail: null,
  volledig: false,
  speler: null,
};

const uniek = (lijst) => [...new Set(lijst)];
const opsomming = (lijst) => (lijst.length < 2 ? lijst.join('') : `${lijst.slice(0, -1).join(', ')} en ${lijst.at(-1)}`);
const aanhalen = (t) => `‘${t}’`;

// ---------- laden en filteren ----------

async function laad() {
  if (staat.modus === 'archief') {
    const q = new URLSearchParams(Object.entries(archiefFilters).filter(([, w]) => w));
    return (await vraag('GET', `/api/audio/archief?${q}`)).items;
  }
  if (staat.modus === 'bewaard') return (await vraag('GET', '/api/feed/bewaard')).items;
  if (staat.modus === 'zoeken') return staat.zoekvraag ? (await vraag('GET', `/api/zoek?q=${encodeURIComponent(staat.zoekvraag)}`)).items : [];
  return (await vraag('GET', '/api/feed')).items;
}

function voorFilters() {
  // Het archief heeft eigen filters (bron, status, zoeken), op de server.
  if (staat.modus === 'archief') return staat.items;
  return staat.items.filter((i) => (!filters.regio || i.regios.includes(filters.regio))
    && (!filters.ongelezen || !i.gelezen || i.id === staat.gekozen));
}

function zichtbaar() {
  const lijst = voorFilters();
  return filters.groep === 'alles' || staat.modus === 'archief' ? lijst : lijst.filter((i) => i.groep === filters.groep);
}

// ---------- filterbalk ----------

function regioNaam(id) {
  return app.ik.regios.find((r) => r.id === id)?.naam || id;
}

function tekenFilters() {
  const balk = $('#filterbalk');
  if (staat.modus === 'archief') {
    // Eén keer tekenen: de filters zelf blijven staan bij het opnieuw laden.
    if (!balk.classList.contains('archiefbalk')) balk.outerHTML = archiefBalkHtml('').replace('<div class="archiefbalk">', '<div class="archiefbalk" id="filterbalk">');
    return;
  }
  const tellingen = Object.fromEntries(GROEPEN.map((g) => [g, 0]));
  for (const i of voorFilters()) {
    tellingen.alles++;
    tellingen[i.groep] = (tellingen[i.groep] || 0) + 1;
  }
  const gevolgd = app.ik.gebruiker.regios;
  let links;
  if (staat.modus === 'zoeken') {
    links = `<span class="klein"><strong>${staat.items.length}</strong> resultaten voor ${esc(aanhalen(staat.zoekvraag))}</span>`;
  } else {
    links = gevolgd.map((id) => `<button class="chip${filters.regio && filters.regio !== id ? ' uit' : ''}" data-regio="${esc(id)}" title="${filters.regio === id ? 'Weer alle regio\'s tonen' : 'Alleen deze regio tonen'}">${esc(regioNaam(id))}</button>`).join('')
      + `<button class="chip-plus" id="regio-plus" title="Regio's volgen" aria-haspopup="true">+</button>`;
    if (!gevolgd.length) links = `<span class="klein zacht">Je volgt nog geen regio's</span><button class="chip-plus" id="regio-plus" title="Regio's volgen">+</button>`;
  }
  balk.innerHTML = `
    <div class="regiochips">${links}</div>
    <div class="soorttabs" role="tablist">
      ${GROEPEN.map((g) => `<button class="soorttab" role="tab" data-groep="${g}" aria-selected="${filters.groep === g}">${GROEPNAAM[g]} <span class="n">${tellingen[g] || 0}</span></button>`).join('')}
      <label class="ongelezen-schakel"><input type="checkbox" id="alleen-ongelezen" ${filters.ongelezen ? 'checked' : ''}><span class="vakje"></span>Alleen ongelezen</label>
    </div>`;
}

function regioPopover(knop) {
  $('.popover')?.remove();
  const p = document.createElement('div');
  p.className = 'popover';
  const gevolgd = new Set(app.ik.gebruiker.regios);
  p.innerHTML = `<h4>Regio's volgen</h4>${app.ik.regios.map((r) => `<label><input type="checkbox" value="${esc(r.id)}" ${gevolgd.has(r.id) ? 'checked' : ''}><span class="vakje"></span>${esc(r.naam)}</label>`).join('')}
    <div class="popover-voet">Je weekmail volgt dezelfde regio's.</div>`;
  document.body.append(p);
  const rect = knop.getBoundingClientRect();
  p.style.left = `${Math.min(rect.left, window.innerWidth - 260)}px`;
  p.style.top = `${rect.bottom + window.scrollY + 8}px`;
  p.addEventListener('change', async () => {
    const regios = $$('input:checked', p).map((i) => i.value);
    try {
      await vraag('PUT', '/api/ik', { regios });
      await laadIk();
      if (filters.regio && !regios.includes(filters.regio)) filters.regio = '';
      staat.items = await laad();
      tekenFilters();
      tekenLijst();
    } catch (fout) {
      toast(fout.message, 'fout');
    }
  });
  const weg = (e) => {
    if (!p.contains(e.target) && e.target !== knop) {
      p.remove();
      document.removeEventListener('mousedown', weg);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', weg));
}

// ---------- lijst ----------

function rijHtml(i) {
  const tijd = (staat.modus === 'feed' || staat.modus === 'archief') && i.tijdBekend ? uurMinuut(i.tijd) : moment(i.datum || i.tijd, { metTijd: false });
  const verwerking = i.status && i.status !== 'klaar' && STATUSNAAM[i.status] ? `<span class="status-bezig">· ${esc(STATUSNAAM[i.status])}</span>` : '';
  const tags = [];
  if (i.match?.term) tags.push(`<span class="match">${esc(i.match.term)}${i.match.tijd !== undefined && i.match.tijd !== null ? ` · ${tijdcode(i.match.tijd)}` : ''}</span>`);
  if (i.bewaard && staat.modus !== 'bewaard') tags.push(`<span class="ster" title="Bewaard">${icoon('star', 12)}</span>`);
  if (i.notitie) tags.push(`<span class="ster" title="Met notitie">${icoon('pencil', 12)}</span>`);
  if (i.verdwenen) tags.push('<span class="weg" title="De bron heeft deze pagina weggehaald">Verwijderd bij de bron</span>');
  return `<button class="rij" role="option" data-id="${esc(i.id)}" aria-selected="${i.id === staat.gekozen}">
    <div class="stip">${i.gelezen ? '' : '<span title="Ongelezen"></span>'}</div>
    <div class="rij-tekst">
      <div class="rij-meta"><span class="tab-nums">${esc(tijd)}</span><span class="regio">${esc(staat.modus === 'archief' ? i.bronNaam || i.regioNaam : i.regioNaam)}</span><span>· ${esc(i.soortNaam)}</span>${verwerking}</div>
      <div class="rij-titel">${esc(i.titel)}</div>
      ${tags.length ? `<div class="rij-tags">${tags.join('')}</div>` : ''}
    </div>
  </button>`;
}

function tekenLijst() {
  const lijst = zichtbaar();
  const el = $('#lijst');
  if (!lijst.length) {
    const leeg = {
      feed: app.ik.gebruiker.regios.length ? 'Niets gevonden met deze filters.' : 'Je volgt nog geen regio\'s. Kies er een met + hierboven.',
      bewaard: 'Nog niets bewaard. Met de ster bij een stuk bewaar je het hier.',
      archief: archiefFilters.q ? 'Niets gevonden in titels en transcripten.' : 'Nog geen audio of video. Een beheerder voegt bronnen toe bij Beheer › Bronnen.',
      zoeken: staat.zoekvraag ? 'Niets gevonden.' : 'Typ een zoekterm in het veld rechtsboven.',
    }[staat.modus];
    el.innerHTML = `<p class="leeg">${esc(leeg)}</p>`;
    return;
  }
  let html = '';
  let dag = null;
  for (const i of lijst) {
    if (staat.modus !== 'bewaard') {
      const kop = dagKop(i.tijd);
      if (kop !== dag) {
        html += `<div class="dagkop">${esc(kop)}</div>`;
        dag = kop;
      }
    }
    html += rijHtml(i);
  }
  el.innerHTML = html;
}

function werkRijBij(id) {
  const i = staat.items.find((x) => x.id === id);
  const oud = $(`.rij[data-id="${CSS.escape(id)}"]`);
  if (!i || !oud) return;
  const nieuw = document.createElement('div');
  nieuw.innerHTML = rijHtml(i);
  oud.replaceWith(nieuw.firstElementChild);
}

// ---------- status: gelezen, bewaard, notitie ----------

async function zetStatus(id, wijziging) {
  const r = await vraag('PUT', '/api/stuk', { id, ...wijziging });
  const i = staat.items.find((x) => x.id === id);
  if (i) {
    i.gelezen = Boolean(r.status.gelezen);
    i.bewaard = Boolean(r.status.bewaard);
    i.notitie = Boolean(r.status.notitie);
  }
  if (staat.detail?.id === id) staat.detail.status = r.status;
  zetBewaardTeller(r.bewaard);
  werkRijBij(id);
  return r.status;
}

// ---------- kiezen ----------

async function kies(id, { scroll = false } = {}) {
  if (!id) return;
  staat.gekozen = id;
  for (const rij of $$('.rij')) rij.setAttribute('aria-selected', String(rij.dataset.id === id));
  const rij = $(`.rij[data-id="${CSS.escape(id)}"]`);
  if (scroll && rij) rij.scrollIntoView({ block: 'nearest' });
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  params.set('stuk', id);
  history.replaceState(null, '', `#/${staat.modus}?${params}`);
  stopSpeler();
  const paneel = $('#paneel');
  paneel.innerHTML = '<div class="paneel-leeg">Laden…</div>';
  let d;
  try {
    d = await vraag('GET', `/api/stuk?id=${encodeURIComponent(id)}`);
  } catch (fout) {
    if (staat.gekozen === id) paneel.innerHTML = `<div class="paneel-leeg">${esc(fout.message)}</div>`;
    return;
  }
  if (staat.gekozen !== id) return;
  staat.detail = d;
  paneel.scrollTop = 0;
  tekenPaneel();
  // Openen = gelezen.
  if (!d.status.gelezen) {
    try { await zetStatus(id, { gelezen: true }); tekenActies(); } catch { /* volgende keer */ }
  }
}

function volgende(stap) {
  const lijst = zichtbaar();
  if (!lijst.length) return;
  const nu = lijst.findIndex((i) => i.id === staat.gekozen);
  const doel = lijst[Math.min(lijst.length - 1, Math.max(0, nu < 0 ? 0 : nu + stap))];
  if (doel && doel.id !== staat.gekozen) kies(doel.id, { scroll: true });
}

// ---------- leespaneel ----------

// Een weggehaalde pagina: misschien heeft het Internet Archive een kopie.
const archiefLink = (url) => `https://web.archive.org/web/*/${url}`;

function actiesHtml(d) {
  const s = d.status || {};
  const audio = d.groep === 'audio';
  const rechts = [];
  rechts.push(`<button class="tekstlink" data-actie="volledig">${staat.volledig ? 'Terug naar de lijst' : 'Volledig scherm ↗'}</button>`);
  return `
    ${d.url && d.verdwenen ? `<a class="knop primair" href="${esc(archiefLink(d.url))}" target="_blank" rel="noopener noreferrer">Kopie zoeken in het Internet Archive${icoon('arrow-up-right', 16, 2.5)}</a>` : ''}
    ${d.url && !d.verdwenen ? `<a class="knop primair" href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">Openen bij ${esc(d.openenBij)}${icoon('arrow-up-right', 16, 2.5)}</a>` : ''}
    <button class="knop" data-actie="bewaar" aria-pressed="${Boolean(s.bewaard)}">${icoon('star')}${s.bewaard ? 'Bewaard' : 'Bewaren'}</button>
    <button class="knop ${s.gelezen ? 'zacht' : ''}" data-actie="gelezen" aria-pressed="${Boolean(s.gelezen)}" title="${s.gelezen ? 'Markeer als ongelezen' : 'Markeer als gelezen'}">${icoon('check', 16, 2.5)}${s.gelezen ? 'Gelezen' : 'Markeer gelezen'}</button>
    <span class="rechts" style="display:flex;gap:16px">${rechts.join('')}</span>`;
}

function tekenActies() {
  const el = $('#acties');
  if (el && staat.detail) el.innerHTML = actiesHtml(staat.detail);
}

function metaWaarde(m) {
  if (m.k === 'Datum stuk' || m.k === 'Gepubliceerd' || m.k === 'Eerst gezien') return moment(m.v);
  return m.v;
}

function metaHtml(d) {
  if (!d.meta?.length) return '';
  return `<div class="metagrid">${d.meta.map((m) => `<div><span class="label">${esc(m.k)}</span><span class="waarde">${esc(metaWaarde(m))}</span></div>`).join('')}</div>`;
}

function tijdLink(d, t, inhoud, klasse) {
  if (d.speler) return `<button class="${klasse}" data-tijd="${t}">${inhoud}</button>`;
  if (d.youtube && d.url) {
    try {
      const u = new URL(d.url);
      u.searchParams.set('t', `${Math.floor(t)}s`);
      return `<a class="${klasse}" href="${esc(u.href)}" target="_blank" rel="noopener noreferrer" title="Openen bij YouTube op deze tijd">${inhoud}</a>`;
    } catch { /* gewone tekst */ }
  }
  return `<span class="${klasse}">${inhoud}</span>`;
}

function waaromHtml(d) {
  const treffers = d.treffers || [];
  const viaRegio = treffers.filter((t) => t.regio);
  const viaMelding = treffers.filter((t) => t.melding);
  // Bij een gemeentelijke bron is alleen een melding een reden.
  if (!viaMelding.length && (!d.landelijk || !viaRegio.length)) return '';
  const audio = d.groep === 'audio';
  const zinnen = [];
  if (d.landelijk && viaRegio.length) {
    const termen = uniek(viaRegio.map((t) => aanhalen(esc(t.term))));
    const regios = uniek(viaRegio.map((t) => t.regioNaam));
    const aantal = viaRegio.length === 1 && viaRegio[0].aantal > 1 ? ` ${viaRegio[0].aantal}×` : '';
    const werkwoord = audio ? (termen.length === 1 ? `wordt${aantal} ${termen[0]} gezegd` : `worden ${opsomming(termen)} gezegd`)
      : (termen.length === 1 ? `komt${aantal} ${termen[0]} voor` : `komen ${opsomming(termen)} voor`);
    zinnen.push(`Dit is een landelijke bron. ${audio ? 'In de aflevering' : 'In het stuk'} ${werkwoord}, ${termen.length === 1 ? 'een sleutelwoord' : 'sleutelwoorden'} van de regio${regios.length > 1 ? '\'s' : ''} <strong>${esc(opsomming(regios))}</strong>.`);
  }
  if (viaMelding.length) {
    const termen = uniek(viaMelding.map((t) => t.term));
    zinnen.push(`${esc(opsomming(termen.map(aanhalen)))} ${termen.length === 1 ? 'is een zoekterm' : 'zijn zoektermen'} van je meldingen.`);
  }
  if (audio && (d.speler || d.youtube)) zinnen.push('Klik op een tijd om vanaf daar te luisteren.');
  // Eén rij per term, ook als hij er zowel als sleutelwoord als via een melding in staat.
  const getoond = new Set();
  const rijen = treffers.filter((t) => (t.melding || d.landelijk) && !getoond.has(t.term) && getoond.add(t.term)).map((t) => {
    const links = audio && t.tijd !== undefined
      ? tijdLink(d, t.tijd, `${icoon('play', 12)}${tijdcode(t.tijd)}`, 'treffer-tijd')
      : `<span class="treffer-term">${esc(t.term)}${t.aantal ? `<span class="aantal">${t.aantal}× in het stuk</span>` : ''}</span>`;
    return `<div class="treffer">${links}<span>${markeer(t.fragment.tekst, t.fragment.treffer)}</span></div>`;
  });
  return `<div class="waarom"><div class="waarom-titel">Waarom staat dit in je feed?</div><div class="waarom-uitleg">${zinnen.join(' ')}</div>${rijen.join('')}</div>`;
}

function notitieHtml(d) {
  return `<div class="notitie"><label for="notitie">Notitie</label>
    <textarea id="notitie" placeholder="Bijvoorbeeld: griffie bellen, of: bewonersavond 4 november">${esc(d.status?.notitie || '')}</textarea>
    <span class="hint" id="notitie-hint">Alleen voor jou zichtbaar.</span></div>`;
}

// Het document als blokken (src/document.mjs): koppen, alinea's, opsommingen
// en het begin van elke bijlage.
function documentTekst(doc, termen) {
  let html = '';
  let lijst = false;
  for (const [soort, tekst] of doc.blokken) {
    if (soort === 'l' && !lijst) html += '<ul>';
    if (soort !== 'l' && lijst) html += '</ul>';
    lijst = soort === 'l';
    if (soort === 'k') html += `<h4>${markeerTermen(tekst, termen)}</h4>`;
    else if (soort === 'l') html += `<li>${markeerTermen(tekst, termen)}</li>`;
    else if (soort === 'd') html += `<div class="document-deel">${esc(tekst)}</div>`;
    else html += `<p>${markeerTermen(tekst, termen)}</p>`;
  }
  return lijst ? `${html}</ul>` : html;
}

function documentHtml(d) {
  const termen = (d.treffers || []).map((t) => t.term);
  const doc = d.document || { blokken: [], volledig: false };
  const tekst = doc.blokken.length
    ? `${documentTekst(doc, termen)}${doc.volledig ? '' : '<p class="document-rest">…</p>'}`
    : d.documentOphalen ? '' : `<p class="toelichting">${esc(d.toelichting || 'De tekst van dit stuk is (nog) niet opgehaald; open het bij de bron.')}</p>`;
  // "Openen bij …" staat al bij de knoppen bovenaan; hier alleen als het stuk niet helemaal hier staat.
  const bronLink = d.url && !doc.volledig && !d.verdwenen ? `<a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">Volledig stuk openen →</a>` : '';
  const weg = d.verdwenen
    ? `<p class="document-weg"><strong>Verwijderd bij de bron.</strong> De pagina bestaat niet meer (vastgesteld op ${esc(new Date(d.verdwenen).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }))}). ${doc.blokken.length ? 'Hieronder de tekst zoals de Regiochecker hem eerder ophaalde; de opmaak is toen niet bewaard.' : 'De tekst is niet eerder opgehaald.'}</p>`
    : '';
  return `<div class="document" id="document">
      <div class="document-kop"><span>Uit het document</span><span class="klein" style="display:flex;gap:16px">${d.download ? `<a href="${esc(d.download)}" target="_blank" rel="noopener noreferrer">Downloaden</a>` : ''}${bronLink}</span></div>
      ${weg}
      ${d.documentOphalen ? '<p class="document-laden" id="document-laden">Het hele document wordt opgehaald…</p>' : ''}
      <div class="document-tekst">${tekst}</div>
      ${d.toelichting && doc.blokken.length ? `<p class="toelichting">${esc(d.toelichting)}</p>` : ''}
    </div>`;
}

// Nog niet opgehaald: het leespaneel toont de korte inhoud en haalt het hele document erbij.
async function laadDocument(d) {
  d.documentOphalen = false;
  let r;
  try {
    r = await vraag('GET', `/api/stuk/document?id=${encodeURIComponent(d.id)}`);
  } catch (fout) {
    const el = staat.detail === d && $('#document-laden');
    if (el) el.textContent = fout.message;
    return;
  }
  if (r.document?.blokken?.length) d.document = r.document;
  if (r.verdwenen) d.verdwenen = r.verdwenen;
  if (staat.detail !== d) return;
  const el = $('#document');
  if (el) el.outerHTML = documentHtml(d);
  if (r.verdwenen) {
    tekenActies();
    const rij = staat.items.find((x) => x.id === d.id);
    if (rij) {
      rij.verdwenen = r.verdwenen;
      tekenLijst();
    }
  }
}

function tekstPaneel(d) {
  const kicker = d.soort === 'kamerstuk' ? ['Kamerstuk', 'landelijk', d.kicker] : d.landelijk ? [d.soortNaam, 'landelijk'] : [d.regioNaam, d.soortNaam];
  // De notitie staat boven het document: dat kan tientallen pagina's lang zijn.
  return `<div class="paneel-binnen">
    <div class="acties" id="acties">${actiesHtml(d)}</div>
    <div class="kopblok"><div class="kicker">${esc(kicker.filter(Boolean).join(' · '))}</div><h2>${esc(d.titel)}</h2></div>
    ${metaHtml(d)}
    ${waaromHtml(d)}
    ${notitieHtml(d)}
    ${documentHtml(d)}
  </div>`;
}

// ---------- audio en video (2b) ----------

const audioTab = { tab: 'transcript', zoek: '' };

function sprekerInfo(d) {
  const map = new Map();
  for (const sp of d.sprekers || []) map.set(sp.id || sp.label, sp);
  return map;
}

// Opeenvolgende segmenten van dezelfde spreker vormen één beurt; zonder
// sprekers voegen we segmenten samen tot stukken van zo'n halve minuut.
function beurten(d) {
  const uit = [];
  for (const s of d.segmenten || []) {
    const sleutel = s.sprekerId || s.spreker || null;
    const vorige = uit.at(-1);
    const samen = vorige && (sleutel ? vorige.sleutel === sleutel : !vorige.sleutel && s.start - vorige.start < 30);
    if (samen && s.start - vorige.eind < 20) {
      vorige.tekst += ` ${s.tekst}`;
      vorige.eind = s.eind;
      continue;
    }
    uit.push({ sleutel, start: Number(s.start) || 0, eind: Number(s.eind) || 0, tekst: s.tekst || '', spreker: s.spreker, sprekerId: s.sprekerId });
  }
  return uit;
}

// Een voorstel voor de naam van een stem, van het vergaderplatform (wie had de microfoon).
function voorstelHtml(sp) {
  const s = sp.suggestie;
  return `<span class="suggestie">Volgens het vergaderplatform is dit ${esc(aanhalen(s.naam))} (${s.deel}% van de spreektijd).</span><button class="overnemen" data-profiel="${esc(sp.id)}" data-naam="${esc(s.naam)}">Overnemen</button>`;
}

function sprekerHtml(d, b, eerste) {
  if (!b.sleutel) return '<div class="spreker"></div>';
  const sp = sprekerInfo(d).get(b.sleutel) || { label: b.spreker, heeftNaam: Boolean(b.spreker) };
  if (sp.heeftNaam) return `<div class="spreker"><span class="spreker-naam">${esc(sp.label)}</span></div>`;
  let html = `<div class="spreker"><span class="spreker-label">${esc(sp.label || 'Onbekende spreker')}</span>`;
  if (sp.id) {
    html += `<div class="spreker-invoer"><button class="fragmentknop" data-fragment="${esc(sp.id)}" title="Fragment van deze spreker beluisteren">${icoon('play', 12)}</button><input class="naamveld" data-profiel="${esc(sp.id)}" placeholder="Naam invullen" aria-label="Naam van ${esc(sp.label)}"></div>`;
    if (eerste && sp.suggestie) html += voorstelHtml(sp);
  }
  return `${html}</div>`;
}

const zonderAccenten = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function transcriptHtml(d) {
  const lijst = beurten(d);
  if (!lijst.length) return '<p class="leeg">Er is (nog) geen transcript.</p>';
  const termen = uniek((d.treffers || []).map((t) => t.term));
  const zoek = audioTab.zoek.trim();
  const gezien = new Set();
  // Agendapunten als tussenkopjes (niet bij zoeken), vóór de beurt die het
  // dichtst bij het begin van het punt begint: een beurt is soms minuten lang.
  const kopjes = new Map();
  let vanaf = 0;
  for (const p of zoek ? [] : d.agenda || []) {
    let beste = vanaf;
    for (let i = vanaf; i < lijst.length && lijst[i].start <= p.start + 600; i++) {
      if (Math.abs(lijst[i].start - p.start) < Math.abs(lijst[beste].start - p.start)) beste = i;
    }
    if (!kopjes.has(beste)) kopjes.set(beste, []);
    kopjes.get(beste).push(p);
    vanaf = beste;
  }
  let html = '';
  for (const [n, b] of lijst.entries()) {
    const eerste = b.sleutel && !gezien.has(b.sleutel);
    if (b.sleutel) gezien.add(b.sleutel);
    for (const p of kopjes.get(n) || []) {
      html += `<div class="agendakop">${tijdLink(d, p.start, tijdcode(p.start), 'beurt-tijd')}<span>${esc(p.titel)}</span></div>`;
    }
    if (zoek && !zonderAccenten(b.tekst).includes(zonderAccenten(zoek))) continue;
    html += `<div class="beurt" data-beurt="${n}" data-start="${b.start}">
      ${tijdLink(d, b.start, tijdcode(b.start), 'beurt-tijd')}
      ${sprekerHtml(d, b, eerste)}
      <span>${markeerTermen(b.tekst, zoek ? [...termen, zoek] : termen)}</span>
    </div>`;
  }
  return `<div class="transcript">${html || '<p class="leeg">Niets gevonden in het transcript.</p>'}
    <span class="transcript-voet">${d.stemmenHerkend ? 'Een naam die je invult, geldt voor deze stem in alle vergaderingen en is zichtbaar voor de hele redactie.' : 'Automatisch transcript; fouten in namen en woorden zijn mogelijk.'}
    <a href="/api/audio/afleveringen/${esc(d.episode)}/transcript.txt" target="_blank" rel="noopener">Transcript downloaden</a></span></div>`;
}

function sprekersHtml(d) {
  if (!d.stemmenHerkend) {
    return `<div class="document"><p>Stemmen nog niet herkend: het transcript zegt niet wie er spreekt.</p>
      <div><button class="knop" data-actie="stemmen">Stemmen laten herkennen</button></div>
      <p class="toelichting">De worker herkent de stemmen en koppelt namen die eerder zijn ingevuld (ook uit Plaud). Het transcript wordt daarvoor opnieuw gemaakt; daarna staat het hier vanzelf.</p></div>`;
  }
  const rijen = (d.sprekers || []).map((sp) => `<div class="beurt">
      <div class="spreker">${sp.heeftNaam ? `<span class="spreker-naam">${esc(sp.label)}</span>` : `<span class="spreker-label">${esc(sp.label)}</span>`}
        ${!sp.heeftNaam && sp.suggestie ? voorstelHtml(sp) : ''}</div>
      <span class="zacht klein">${sp.beurten} ${sp.beurten === 1 ? 'beurt' : 'beurten'}</span>
      <div class="spreker-invoer">${sp.id ? `<button class="fragmentknop" data-fragment="${esc(sp.id)}" title="Fragment beluisteren">${icoon('play', 12)}</button><input class="naamveld" data-profiel="${esc(sp.id)}" placeholder="${sp.heeftNaam ? 'Naam wijzigen' : 'Naam invullen'}" value="">` : ''}</div>
    </div>`).join('');
  const platform = (d.sprekers || []).filter((sp) => sp.id && !sp.heeftNaam && sp.suggestie?.bron === 'platform');
  const alle = platform.length > 1
    ? `<div class="knoppenrij" style="padding:12px 0"><button class="knop" data-actie="alle-namen" title="Geldt voor deze stemmen in alle opnames, ook in Plaud">Alle ${platform.length} namen van het vergaderplatform overnemen</button></div>`
    : '';
  return `<div class="transcript sprekerlijst">${alle}${rijen || '<p class="leeg">Geen sprekers gevonden.</p>'}
    <span class="transcript-voet">Een naam die je invult, geldt voor deze stem in alle vergaderingen en is zichtbaar voor de hele redactie.</span></div>`;
}

const NAAMSOORTEN = { person: 'Personen', organization: 'Organisaties', location: 'Locaties', product: 'Producten en werken', event: 'Evenementen', other: 'Overig' };

function namenHtml(d) {
  const namen = d.namen || [];
  const nummers = d.nummers || [];
  if (!namen.length && !nummers.length) {
    if (d.namenUit) return '<p class="leeg">Namen zoeken met AI staat uit (Beheer › Instellingen › Audio en video). Zoek in het transcript, of kijk bij Sprekers.</p>';
    return `<p class="leeg">${['getranscribeerd', 'analyseren'].includes(d.verwerking?.status) ? 'De namen worden nog gezocht.' : 'Geen namen gevonden.'}</p>`;
  }
  const groepen = Object.entries(NAAMSOORTEN).map(([soort, titel]) => [titel, namen.filter((n) => n.soort === soort)]).filter(([, lijst]) => lijst.length);
  return `<div class="namenlijst" style="padding-top:14px">
    ${groepen.map(([titel, lijst]) => `<div class="namengroep"><h4>${esc(titel)}</h4><div class="chips">${lijst.map((n) => `<button class="naamchip" data-naam="${esc(n.naam)}" aria-pressed="${audioTab.zoek === n.naam}" title="Toon de plekken in het transcript">${esc(n.naam)} <span>${n.aantal}×</span></button>`).join('')}</div></div>`).join('')}
    ${nummers.length ? `<div class="namengroep"><h4>Telefoonnummers</h4>${nummers.map((n) => `<div class="treffer" style="border-top-color:var(--color-neutral-300)">${tijdLink(d, n.start, `${icoon('play', 12)}${tijdcode(n.start)}`, 'treffer-tijd')}<span><strong>${esc(n.weergave)}</strong>${n.wie ? ` · ${esc(n.wie)}` : ''} · ${esc(n.categorie)}<br>“${esc(n.context)}”</span></div>`).join('')}</div>` : ''}
    <span class="transcript-voet">Automatisch gevonden: onvolledig en soms onjuist. Alle namen over het hele archief staan bij Audio-archief › Namen.</span>
  </div>`;
}

// De agenda van het vergaderplatform; een tijd springt naar dat punt.
function agendaHtml(d) {
  if (!d.agenda?.length) return '<p class="leeg">Het vergaderplatform geeft bij deze vergadering geen agenda met tijden mee. Zoek in het transcript op een agendapunt, of open de vergadering bij de bron.</p>';
  return `<div class="transcript agendalijst">${d.agenda.map((p) => `<div class="beurt agendapunt">
      ${tijdLink(d, p.start, tijdcode(p.start), 'beurt-tijd')}
      <span class="agenda-titel">${esc(p.titel)}</span>
      <span class="zacht klein">${p.eind > p.start ? (p.eind - p.start < 60 ? '< 1 min' : duurTekst(p.eind - p.start)) : ''}</span>
    </div>`).join('')}
    <span class="transcript-voet">Agenda en tijden van het vergaderplatform.</span></div>`;
}

function tabInhoud(d) {
  if (audioTab.tab === 'sprekers') return sprekersHtml(d);
  if (audioTab.tab === 'agenda') return agendaHtml(d);
  if (audioTab.tab === 'namen') return namenHtml(d);
  if (audioTab.tab === 'notitie') return notitieHtml(d);
  return transcriptHtml(d);
}

// De hele opname in hooguit 100 woorden, boven het transcript.
function samenvattingHtml(d) {
  const s = d.samenvatting;
  if (!s) return '';
  const termen = (d.treffers || []).map((t) => t.term);
  const kop = `<div class="document-kop"><span>AI-samenvatting</span>${s.model ? `<span class="klein zacht">${esc(s.model)}</span>` : ''}</div>`;
  if (s.volgt) return `<div class="ai-samenvatting">${kop}<p class="toelichting">Volgt zodra de namen gezocht zijn en de gedeelde GPU vrij is.</p></div>`;
  return `<div class="ai-samenvatting">${kop}<p>${markeerTermen(s.tekst, termen)}</p>
    <p class="toelichting">Automatisch gemaakt uit het transcript, dat zelf ook verkeerd verstane woorden kan bevatten. Controleer het voor publicatie.</p></div>`;
}

function audioPaneel(d) {
  const onbekend = (d.sprekers || []).filter((s) => !s.heeftNaam).length;
  const kicker = d.landelijk ? [d.soortNaam, 'landelijk', 'transcript'] : [d.regioNaam, d.soortNaam, d.soort === 'podcast' ? 'audio' : 'video'];
  const sub = [
    d.gepubliceerd && new Date(d.gepubliceerd).toLocaleString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    duurTekst(d.duur),
    d.getranscribeerd && `getranscribeerd op ${new Date(d.getranscribeerd).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`,
  ].filter(Boolean).join(' · ');
  const chips = !d.landelijk && d.treffers?.length
    ? `<div class="in-stuk"><span>In dit stuk:</span>${d.treffers.map((t) => `<span class="in-stuk-chip"><strong>${esc(t.term)}</strong><span>${t.aantal}× · ${t.melding ? 'jouw melding' : 'sleutelwoord regio'}</span></span>`).join('')}</div>`
    : '';
  const speler = d.speler
    ? `<div class="speler" id="speler">
        <button class="speelknop" id="speel" aria-label="Afspelen">${icoon('play', 20)}</button>
        <div class="voortgang">
          <div class="balk" id="balk" title="Klik om naar die tijd te gaan"><span class="vulling" id="vulling"></span></div>
          <div class="tijden"><span class="nu"><strong id="nu-tijd">0:00</strong><span id="nu-wie"></span></span><span id="totaal">${d.duur ? tijdcode(d.duur) : ''}</span></div>
        </div>
        <div class="spelerknoppen"><button id="terug15" title="15 seconden terug">−15 s</button><button id="tempo" title="Afspeelsnelheid">1×</button></div>
      </div>`
    : `<div class="geen-speler">${d.youtube ? 'De tijden openen de video bij YouTube op dat moment.' : 'De audio van deze aflevering is niet bewaard; de tijden zijn ter oriëntatie. Luister terug bij de bron.'}</div>`;
  const kop = `<div class="acties" id="acties">${actiesHtml(d)}</div>
    <div class="kopblok" style="gap:8px"><div class="kicker">${esc(kicker.filter(Boolean).join(' · '))}</div><h2>${esc(d.titel)}</h2>${sub ? `<span class="subregel">${esc(sub)}</span>` : ''}</div>`;
  // Nog geen transcript: zeggen waar de aflevering in de verwerking staat.
  if (!d.segmenten?.length) {
    const v = d.verwerking || {};
    return `<div class="paneel-binnen breed">${kop}
      <div class="verwerkingsstatus"><strong>${v.status === 'mislukt' ? 'Verwerking mislukt' : 'Nog geen transcript'}</strong>
        ${esc(v.stap || 'In de wachtrij')}${v.fout ? `<br><span class="zacht">${esc(v.fout)}</span>` : ''}
        <br><span class="zacht klein">Afleveringen gaan één voor één door de Whisper-worker; de volgorde staat bij Beheer › Audio.</span></div>
      ${metaHtml(d)}${notitieHtml(d)}</div>`;
  }
  const aantalNamen = (d.namen || []).length;
  return `<div class="paneel-binnen breed">
    ${kop}
    ${speler}
    ${waaromHtml(d)}
    ${chips}
    ${samenvattingHtml(d)}
    <div class="subtabs" role="tablist">
      <button class="subtab" role="tab" data-tab="transcript" aria-selected="${audioTab.tab === 'transcript'}">Transcript</button>
      <button class="subtab" role="tab" data-tab="sprekers" aria-selected="${audioTab.tab === 'sprekers'}">Sprekers${onbekend ? ` <span class="badge">${onbekend} zonder naam</span>` : ''}</button>
      <button class="subtab" role="tab" data-tab="namen" aria-selected="${audioTab.tab === 'namen'}">Namen${aantalNamen ? ` <span class="zacht" style="font-weight:400">${aantalNamen}</span>` : ''}</button>
      <button class="subtab" role="tab" data-tab="agenda" aria-selected="${audioTab.tab === 'agenda'}">Agenda</button>
      <button class="subtab" role="tab" data-tab="notitie" aria-selected="${audioTab.tab === 'notitie'}">Notitie</button>
      <label class="subtab-zoek">${icoon('search', 14)}<input id="transcript-zoek" type="search" placeholder="Zoeken" value="${esc(audioTab.zoek)}" aria-label="Zoeken in het transcript"></label>
    </div>
    <div id="tabinhoud">${tabInhoud(d)}</div>
  </div>`;
}

function tekenTab() {
  const d = staat.detail;
  if (!d) return;
  $('#tabinhoud').innerHTML = tabInhoud(d);
  for (const t of $$('.subtab')) t.setAttribute('aria-selected', String(t.dataset.tab === audioTab.tab));
  const onbekend = (d.sprekers || []).filter((s) => !s.heeftNaam).length;
  const sprekersTab = $('.subtab[data-tab="sprekers"]');
  if (sprekersTab) sprekersTab.innerHTML = `Sprekers${onbekend ? ` <span class="badge">${onbekend} zonder naam</span>` : ''}`;
  if (staat.speler) staat.speler.beurt = -1;
}

// ---------- de speler ----------

function stopSpeler() {
  if (staat.speler) {
    staat.speler.audio.pause();
    staat.speler.audio.removeAttribute('src');
    staat.speler.audio.load();
  }
  staat.speler = null;
  fragmentSpeler.pause();
}

const fragmentSpeler = new Audio();

function koppelSpeler(d) {
  if (!d.speler) return;
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.src = d.speler;
  const sp = { audio, beurt: -1, volgen: true, starts: beurten(d).map((b) => b.start), namen: beurten(d).map((b) => sprekerInfo(d).get(b.sleutel)?.label || b.spreker || '') };
  staat.speler = sp;
  const duur = () => audio.duration && Number.isFinite(audio.duration) ? audio.duration : d.duur || 0;
  const tekenTicks = () => {
    const balk = $('#balk');
    if (!balk || !duur()) return;
    $$('.tick', balk).forEach((t) => t.remove());
    const tijden = uniek((d.treffers || []).flatMap((t) => t.tijden || [t.tijd]).filter((t) => t !== undefined));
    for (const t of tijden) {
      const tick = document.createElement('span');
      tick.className = 'tick';
      tick.style.left = `${(t / duur()) * 100}%`;
      balk.append(tick);
    }
  };
  tekenTicks();
  audio.addEventListener('loadedmetadata', () => {
    $('#totaal').textContent = tijdcode(duur());
    tekenTicks();
  });
  audio.addEventListener('play', () => { $('#speel').innerHTML = icoon('pause', 20); $('#speel').classList.add('speelt'); $('#speel').setAttribute('aria-label', 'Pauzeren'); });
  audio.addEventListener('pause', () => { $('#speel').innerHTML = icoon('play', 20); $('#speel').classList.remove('speelt'); $('#speel').setAttribute('aria-label', 'Afspelen'); });
  audio.addEventListener('error', () => {
    if (staat.speler === sp && audio.getAttribute('src')) toast('De audio kon niet worden geladen; misschien is hij al opgeruimd.', 'fout');
  });
  audio.addEventListener('timeupdate', () => {
    if (staat.speler !== sp) return;
    const t = audio.currentTime;
    $('#vulling').style.width = `${duur() ? (t / duur()) * 100 : 0}%`;
    $('#nu-tijd').textContent = tijdcode(t);
    // De beurt die nu loopt, oplichten en in beeld houden.
    let n = -1;
    for (let lo = 0, hi = sp.starts.length - 1; lo <= hi;) {
      const mid = (lo + hi) >> 1;
      if (sp.starts[mid] <= t) { n = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (n !== sp.beurt) {
      sp.beurt = n;
      $('#nu-wie').textContent = n >= 0 && sp.namen[n] ? ` · ${sp.namen[n]}` : '';
      $$('.beurt.actief').forEach((b) => b.classList.remove('actief'));
      const el = $(`.beurt[data-beurt="${n}"]`);
      if (el) {
        el.classList.add('actief');
        if (!audio.paused && sp.volgen) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  });
  $('#speel').addEventListener('click', () => (audio.paused ? audio.play() : audio.pause()));
  $('#terug15').addEventListener('click', () => { audio.currentTime = Math.max(0, audio.currentTime - 15); });
  const TEMPI = [1, 1.25, 1.5, 2];
  $('#tempo').addEventListener('click', (e) => {
    audio.playbackRate = TEMPI[(TEMPI.indexOf(audio.playbackRate) + 1) % TEMPI.length];
    e.currentTarget.textContent = `${String(audio.playbackRate).replace('.', ',')}×`;
  });
  $('#balk').addEventListener('click', (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (duur()) spring(((e.clientX - rect.left) / rect.width) * duur());
  });
}

// Een tijd uit een link (Audio-archief › Namen, Stemmen, Telefoonnummers): die beurt
// laten zien en de speler erop zetten, zonder meteen af te spelen.
function markeerTijd(t) {
  const lijst = $$('.beurt[data-start]');
  let doel = null;
  for (const b of lijst) if (Number(b.dataset.start) <= t + 0.5) doel = b;
  if (doel) {
    doel.classList.add('gemarkeerd');
    doel.scrollIntoView({ block: 'center' });
  }
  if (staat.speler) staat.speler.audio.currentTime = t;
}

function spring(t) {
  const sp = staat.speler;
  if (!sp) return;
  sp.audio.currentTime = Math.max(0, t);
  sp.volgen = true;
  sp.audio.play().catch(() => {});
}

async function speelFragment(knop) {
  const id = knop.dataset.fragment;
  if (!fragmentSpeler.paused && fragmentSpeler.dataset.id === id) {
    fragmentSpeler.pause();
    return;
  }
  staat.speler?.audio.pause();
  $$('.fragmentknop.speelt').forEach((k) => { k.classList.remove('speelt'); k.innerHTML = icoon('play', 12); });
  fragmentSpeler.dataset.id = id;
  fragmentSpeler.src = `/api/audio/sprekers/${encodeURIComponent(id)}/fragment`;
  const knoppen = $$(`.fragmentknop[data-fragment="${CSS.escape(id)}"]`);
  const klaar = () => knoppen.forEach((k) => { k.classList.remove('speelt'); k.innerHTML = icoon('play', 12); });
  fragmentSpeler.onended = klaar;
  fragmentSpeler.onpause = klaar;
  fragmentSpeler.onerror = () => {
    klaar();
    // Geen fragment van de worker: dan de langste beurt uit de eigen audio.
    const sp = (staat.detail?.sprekers || []).find((s) => s.id === id);
    if (staat.speler && sp?.langste) {
      spring(sp.langste.start);
      setTimeout(() => staat.speler?.audio.pause(), 8000);
    } else {
      toast('Er is geen luisterfragment van deze stem beschikbaar.', 'fout');
    }
  };
  knoppen.forEach((k) => { k.classList.add('speelt'); k.innerHTML = icoon('pause', 12); });
  try { await fragmentSpeler.play(); } catch { /* onerror vangt het */ }
}

async function noemSpreker(profiel, naam, { stil = false } = {}) {
  const schoon = naam.trim();
  if (!schoon) return;
  try {
    const r = await vraag('PUT', `/api/audio/sprekers/${encodeURIComponent(profiel)}`, { naam: schoon });
    const d = staat.detail;
    for (const s of d.segmenten) if (s.sprekerId === profiel) s.spreker = r.naam;
    for (const sp of d.sprekers) if (sp.id === profiel) Object.assign(sp, { label: r.naam, heeftNaam: true, suggestie: null });
    if (staat.speler) staat.speler.namen = beurten(d).map((b) => sprekerInfo(d).get(b.sleutel)?.label || b.spreker || '');
    tekenTab();
    if (!stil) toast(`${aanhalen(r.naam)} geldt nu voor deze stem, in alle vergaderingen.`);
    return true;
  } catch (fout) {
    toast(fout.message, 'fout');
    return false;
  }
}

// Alle voorstellen van het vergaderplatform in één keer.
async function alleNamen(knop) {
  const d = staat.detail;
  const lijst = (d.sprekers || []).filter((sp) => sp.id && !sp.heeftNaam && sp.suggestie?.bron === 'platform');
  await bezig(knop, async () => {
    let n = 0;
    for (const sp of lijst) if (await noemSpreker(sp.id, sp.suggestie.naam, { stil: true })) n++;
    toast(`${n} ${n === 1 ? 'naam' : 'namen'} overgenomen; die gelden voor deze stemmen in alle vergaderingen.`);
  }, 'Overnemen…');
}

// ---------- paneel tekenen en koppelen ----------

function tekenPaneel() {
  const d = staat.detail;
  const paneel = $('#paneel');
  if (!d) {
    paneel.innerHTML = `<div class="paneel-leeg"><h2>${{ bewaard: 'Bewaard', zoeken: 'Zoeken', archief: 'Audio-archief' }[staat.modus] || 'Feed'}</h2>
      <p>Kies links een stuk om het hier te lezen. Met <strong>j</strong> en <strong>k</strong> (of de pijltjes) ga je door de lijst.</p></div>`;
    return;
  }
  if (d.groep === 'audio') {
    paneel.innerHTML = audioPaneel(d);
    koppelSpeler(d);
    if (staat.springNaar !== null && staat.springNaar !== undefined) {
      markeerTijd(staat.springNaar);
      staat.springNaar = null;
    }
  } else {
    paneel.innerHTML = tekstPaneel(d);
    if (d.documentOphalen) laadDocument(d);
  }
}

let notitieTimer = null;
function bewaarNotitie(direct = false) {
  clearTimeout(notitieTimer);
  const veld = $('#notitie');
  const d = staat.detail;
  if (!veld || !d) return;
  const id = d.id;
  const tekst = veld.value;
  const doe = async () => {
    if ((d.status?.notitie || '') === tekst) return;
    try {
      await zetStatus(id, { notitie: tekst });
      const hint = $('#notitie-hint');
      if (hint && staat.detail?.id === id) hint.textContent = 'Opgeslagen · alleen voor jou zichtbaar.';
    } catch (fout) {
      toast(`Notitie niet opgeslagen: ${fout.message}`, 'fout');
    }
  };
  if (direct) doe();
  else notitieTimer = setTimeout(doe, 800);
}

function koppelPaneel(paneel) {
  paneel.addEventListener('click', async (e) => {
    const knop = e.target.closest('button, a');
    if (!knop || !staat.detail) return;
    const d = staat.detail;
    if (knop.dataset.actie === 'bewaar') {
      await bezig(knop, async () => {
        await zetStatus(d.id, { bewaard: !d.status.bewaard });
        if (staat.modus === 'bewaard' && !d.status.bewaard) {
          staat.items = staat.items.filter((i) => i.id !== d.id);
          tekenFilters();
          tekenLijst();
        }
      });
      tekenActies();
    } else if (knop.dataset.actie === 'gelezen') {
      await bezig(knop, () => zetStatus(d.id, { gelezen: !d.status.gelezen }));
      tekenActies();
    } else if (knop.dataset.actie === 'volledig') {
      staat.volledig = !staat.volledig;
      $('#feed').classList.toggle('volledig', staat.volledig);
      tekenActies();
    } else if (knop.dataset.actie === 'alle-namen') {
      await alleNamen(knop);
    } else if (knop.dataset.actie === 'stemmen') {
      await bezig(knop, async () => {
        await vraag('POST', `/api/audio/afleveringen/${encodeURIComponent(d.episode)}/sprekers`);
        toast('Aangevraagd. Zodra de worker klaar is, staat het hier vanzelf.');
      });
    } else if (knop.dataset.tab) {
      audioTab.tab = knop.dataset.tab;
      tekenTab();
    } else if (knop.classList.contains('naamchip')) {
      // Een naam aanklikken: het transcript, alleen de beurten waarin hij valt.
      audioTab.zoek = knop.dataset.naam;
      audioTab.tab = 'transcript';
      const zoekveld = $('#transcript-zoek');
      if (zoekveld) zoekveld.value = audioTab.zoek;
      tekenTab();
    } else if (knop.dataset.tijd !== undefined && knop.tagName === 'BUTTON') {
      spring(Number(knop.dataset.tijd));
    } else if (knop.dataset.fragment) {
      speelFragment(knop);
    } else if (knop.classList.contains('overnemen')) {
      const naam = knop.dataset.naam;
      noemSpreker(knop.dataset.profiel, naam.charAt(0).toUpperCase() + naam.slice(1));
    }
  });
  paneel.addEventListener('input', (e) => {
    if (e.target.id === 'notitie') bewaarNotitie();
    if (e.target.id === 'transcript-zoek') {
      audioTab.zoek = e.target.value;
      if (audioTab.tab !== 'transcript') audioTab.tab = 'transcript';
      clearTimeout(koppelPaneel.zoekTimer);
      koppelPaneel.zoekTimer = setTimeout(tekenTab, 250);
    }
  });
  paneel.addEventListener('focusout', (e) => {
    if (e.target.id === 'notitie') bewaarNotitie(true);
  });
  paneel.addEventListener('keydown', (e) => {
    // Enter = klaar; het opslaan gebeurt bij 'change', zodat het één keer gaat.
    if (e.target.classList.contains('naamveld') && e.key === 'Enter') {
      e.preventDefault();
      e.target.blur();
    }
  });
  paneel.addEventListener('change', (e) => {
    if (e.target.classList.contains('naamveld') && e.target.value.trim()) noemSpreker(e.target.dataset.profiel, e.target.value);
  });
  // Zelf scrollen in het transcript zet het meelezen even uit.
  paneel.addEventListener('wheel', () => {
    if (!staat.speler) return;
    staat.speler.volgen = false;
    clearTimeout(koppelPaneel.volgTimer);
    koppelPaneel.volgTimer = setTimeout(() => { if (staat.speler) staat.speler.volgen = true; }, 8000);
  }, { passive: true });
}

// ---------- de weergave ----------

export async function toonFeed(hoofd, { modus, params }) {
  staat.modus = modus;
  staat.zoekvraag = modus === 'zoeken' ? params.get('q') || '' : '';
  staat.gekozen = null;
  staat.detail = null;
  hoofd.innerHTML = `<div class="filterbalk" id="filterbalk"></div>
    <div class="feed${staat.volledig ? ' volledig' : ''}" id="feed"><div class="lijst" id="lijst" role="listbox" aria-label="Stukken"><p class="leeg">Laden…</p></div><section class="paneel" id="paneel"></section></div>`;
  if (modus === 'archief') await laadBronnen();
  staat.items = await laad();
  tekenFilters();
  tekenLijst();
  tekenPaneel();

  if (modus === 'archief') {
    koppelArchiefBalk($('#filterbalk'), async () => {
      $('#lijst').innerHTML = '<p class="leeg">Laden…</p>';
      staat.items = await laad();
      tekenLijst();
    });
  }
  $('#filterbalk').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-regio]');
    if (chip) {
      filters.regio = filters.regio === chip.dataset.regio ? '' : chip.dataset.regio;
      tekenFilters();
      tekenLijst();
      return;
    }
    const tab = e.target.closest('[data-groep]');
    if (tab) {
      filters.groep = tab.dataset.groep;
      tekenFilters();
      tekenLijst();
      return;
    }
    if (e.target.closest('#regio-plus')) regioPopover(e.target.closest('#regio-plus'));
  });
  $('#filterbalk').addEventListener('change', (e) => {
    if (e.target.id === 'alleen-ongelezen') {
      filters.ongelezen = e.target.checked;
      tekenFilters();
      tekenLijst();
    }
  });
  $('#lijst').addEventListener('click', (e) => {
    const rij = e.target.closest('.rij');
    if (rij) kies(rij.dataset.id);
  });
  koppelPaneel($('#paneel'));

  const toetsen = (e) => {
    if (e.target.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); volgende(1); }
    if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); volgende(-1); }
    if (e.key === 's' && staat.detail) $('[data-actie="bewaar"]')?.click();
  };
  document.addEventListener('keydown', toetsen);
  app.opruimen = () => {
    document.removeEventListener('keydown', toetsen);
    bewaarNotitie(true);
    stopSpeler();
    $('.popover')?.remove();
  };

  const gevraagd = params.get('stuk');
  if (gevraagd) {
    staat.springNaar = params.has('t') ? Number(params.get('t')) : null;
    await kies(gevraagd, { scroll: true });
  }
}
