// Het audio-archief: alle afleveringen van audio en video (in de lijst met
// leespaneel, zie feed.js), en over alle afleveringen heen de namen die vallen,
// de stemmen, en de telefoonnummers. Wat vroeger het dashboard van audioscraper was.

import { $, $$, esc, vraag, toast, bezig, icoon, moment, tijdcode, markeer } from './gedeeld.js';
import { app } from './app.js';

// Filters die tussen de tabbladen blijven staan.
export const archiefFilters = { bron: '', status: '', q: '' };
let bronnen = null;

export async function laadBronnen() {
  bronnen ||= await vraag('GET', '/api/audio/bronnen');
  return bronnen;
}

const TABS = [['', 'Afleveringen'], ['namen', 'Namen'], ['stemmen', 'Stemmen'], ['nummers', 'Telefoonnummers']];

export function archiefBalkHtml(actief) {
  const f = archiefFilters;
  return `<div class="archiefbalk">
    <div class="links">
      <select class="keuzelijst" id="archief-bron" aria-label="Bron"><option value="">Alle bronnen</option>${(bronnen || []).map((b) => `<option value="${esc(b.id)}" ${b.id === f.bron ? 'selected' : ''}>${esc(b.naam)}</option>`).join('')}</select>
      ${actief === '' ? `<select class="keuzelijst" id="archief-status" aria-label="Status">${[['', 'Alles'], ['klaar', 'Met transcript'], ['bezig', 'In de wachtrij'], ['mislukt', 'Mislukt']].map(([w, t]) => `<option value="${w}" ${w === f.status ? 'selected' : ''}>${t}</option>`).join('')}</select>` : ''}
    </div>
    <div class="rechts">
      ${TABS.map(([pad, naam]) => `<a class="archieftab" href="#/archief${pad ? `/${pad}` : ''}" ${pad === actief ? 'aria-current="page"' : ''}>${naam}</a>`).join('')}
      ${actief === '' ? `<form class="archiefzoek" id="archief-zoekform">${icoon('search', 14)}<input id="archief-q" type="search" placeholder="Zoek in titels en transcripten" value="${esc(f.q)}" aria-label="Zoek in het audio-archief"></form>` : ''}
    </div>
  </div>`;
}

// Filters koppelen; `opnieuw` laadt de weergave opnieuw.
export function koppelArchiefBalk(balk, opnieuw) {
  balk.addEventListener('change', (e) => {
    if (e.target.id === 'archief-bron') archiefFilters.bron = e.target.value;
    if (e.target.id === 'archief-status') archiefFilters.status = e.target.value;
    if (['archief-bron', 'archief-status'].includes(e.target.id)) opnieuw();
  });
  balk.addEventListener('submit', (e) => {
    if (e.target.id !== 'archief-zoekform') return;
    e.preventDefault();
    archiefFilters.q = $('#archief-q').value.trim();
    opnieuw();
  });
}

const stukLink = (aflevering, start) => `#/archief?stuk=${encodeURIComponent(`a:${aflevering}`)}${start !== undefined ? `&t=${Math.floor(start)}` : ''}`;
const bronParam = () => (archiefFilters.bron ? `&bron=${encodeURIComponent(archiefFilters.bron)}` : '');

// ---------- namen ----------

const namenStaat = { q: '', soort: '', gebied: '', offset: 0, gekozen: null };

async function toonNamen(inhoud) {
  const laad = async (meer = false) => {
    const q = new URLSearchParams({ q: namenStaat.q, soort: namenStaat.soort, gebied: namenStaat.gebied, offset: meer ? namenStaat.offset : 0, limiet: 150 });
    if (archiefFilters.bron) q.set('bron', archiefFilters.bron);
    const d = await vraag('GET', `/api/audio/namen?${q}`);
    return d;
  };
  let d = await laad();
  let lijst = d.namen;
  const teken = () => {
    inhoud.innerHTML = `<div class="archiefpagina">
      <div class="paginakop"><h1>Namen</h1><span class="klein zacht">${d.totaal} ${d.totaal === 1 ? 'naam' : 'namen'} in de transcripten${archiefFilters.bron ? ' van deze bron' : ''}. Automatisch gevonden: onvolledig en soms onjuist.</span></div>
      <form class="namenfilter" id="namenfilter">
        <input class="invoer" name="q" type="search" placeholder="Zoek een persoon, organisatie of plaats…" value="${esc(namenStaat.q)}">
        <select class="keuzelijst" name="soort"><option value="">Alle soorten</option>${Object.entries(d.soorten).map(([w, t]) => `<option value="${w}" ${w === namenStaat.soort ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
        <select class="keuzelijst" name="gebied"><option value="">Alle gebieden</option>${Object.entries(d.gebieden).map(([w, t]) => `<option value="${w}" ${w === namenStaat.gebied ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
        <button class="knop inkt klein">Zoeken</button>
      </form>
      ${lijst.length ? `<div class="namenraster">${lijst.map((n) => `<button class="naamtegel" data-naam="${esc(n.naam)}" data-soort="${esc(n.soort)}" aria-pressed="${namenStaat.gekozen?.naam === n.naam && namenStaat.gekozen?.soort === n.soort}">
        <span class="soort">${esc(n.soortNaam)}</span><span class="naam">${esc(n.naam)}</span>
        ${n.geografie ? `<small>${esc([n.geografie.provincie, n.geografie.land].filter(Boolean).join(' · '))}</small>` : ''}
        <small>${n.aantal} ${n.aantal === 1 ? 'vermelding' : 'vermeldingen'} · ${n.afleveringen} ${n.afleveringen === 1 ? 'aflevering' : 'afleveringen'}</small></button>`).join('')}</div>` : '<p class="leeg" style="padding-left:0">Geen namen gevonden.</p>'}
      ${lijst.length < d.totaal ? '<div class="knoppenrij" style="margin-top:14px"><button class="knop klein" id="meer-namen">Toon meer namen</button></div>' : ''}
      <div id="vermeldingen"></div>
    </div>`;
  };
  teken();
  const toonVermeldingen = async () => {
    const plek = $('#vermeldingen');
    if (!namenStaat.gekozen) {
      plek.innerHTML = '';
      return;
    }
    const v = await vraag('GET', `/api/audio/namen/vermeldingen?naam=${encodeURIComponent(namenStaat.gekozen.naam)}&soort=${encodeURIComponent(namenStaat.gekozen.soort)}${bronParam()}`);
    const perAflevering = new Map();
    for (const m of v.vermeldingen) {
      if (!perAflevering.has(m.aflevering)) perAflevering.set(m.aflevering, []);
      perAflevering.get(m.aflevering).push(m);
    }
    plek.innerHTML = `<div class="vermeldingen"><h2>${esc(v.naam)}</h2><p class="klein zacht">${esc(v.soortNaam)} · ${v.vermeldingen.length} ${v.vermeldingen.length === 1 ? 'plek' : 'plekken'} in ${perAflevering.size} ${perAflevering.size === 1 ? 'aflevering' : 'afleveringen'}. Klik om de aflevering op die tijd te openen.</p>
      ${[...perAflevering.values()].map((lijstAf) => `<div class="afleveringkop">${esc(lijstAf[0].titel)} <small>${lijstAf[0].gepubliceerd ? esc(moment(lijstAf[0].gepubliceerd, { metTijd: false })) : ''}</small></div>
        ${lijstAf.map((m) => `<a class="vermelding" href="${stukLink(m.aflevering, m.start)}"><span class="tijd">${icoon('play', 10)} ${tijdcode(m.start)}</span><span>${markeer(m.tekst, v.naam)}</span></a>`).join('')}`).join('')}</div>`;
    plek.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  inhoud.addEventListener('submit', async (e) => {
    if (e.target.id !== 'namenfilter') return;
    e.preventDefault();
    const f = e.target;
    Object.assign(namenStaat, { q: f.q.value.trim(), soort: f.soort.value, gebied: f.gebied.value, offset: 0, gekozen: null });
    d = await laad();
    lijst = d.namen;
    teken();
  });
  inhoud.addEventListener('click', async (e) => {
    const tegel = e.target.closest('.naamtegel');
    if (tegel) {
      const gekozen = { naam: tegel.dataset.naam, soort: tegel.dataset.soort };
      namenStaat.gekozen = namenStaat.gekozen?.naam === gekozen.naam && namenStaat.gekozen?.soort === gekozen.soort ? null : gekozen;
      for (const t of $$('.naamtegel', inhoud)) t.setAttribute('aria-pressed', String(t === tegel && Boolean(namenStaat.gekozen)));
      await toonVermeldingen();
      return;
    }
    if (e.target.id === 'meer-namen') {
      namenStaat.offset = lijst.length;
      const extra = await laad(true);
      lijst = [...lijst, ...extra.namen];
      teken();
    }
  });
}

// ---------- stemmen ----------

const fragmentSpeler = new Audio();

async function toonStemmen(inhoud) {
  let d = await vraag('GET', `/api/audio/stemmen?${bronParam().slice(1)}`);
  const teken = () => {
    inhoud.innerHTML = `<div class="archiefpagina">
      <div class="paginakop"><h1>Stemmen</h1><span class="klein zacht">${d.stemmen.length} herkende ${d.stemmen.length === 1 ? 'stem' : 'stemmen'}. Een naam die je invult, geldt voor die stem in alle afleveringen, ook in Plaud.</span></div>
      ${d.fout ? `<p class="statusregel fout">De worker gaf de stemprofielen niet: ${esc(d.fout)}. Namen zijn wel te zien, invullen niet.</p>` : ''}
      <div class="tabelkop stemrij"><span>Stem</span><span>Te horen</span><span>Naam</span></div>
      ${d.stemmen.length ? d.stemmen.map((s) => `<div class="tabelrij stemrij">
        <span class="naamcel"><strong>${esc(s.naam || s.weergave)}</strong>
          <small>${s.eerste ? `Eerst in <a href="${stukLink(s.eerste.aflevering, s.eerste.start)}">${esc(s.eerste.titel)}</a>` : ''}${s.voorstel && !s.naam ? ` · voorstel: ${esc(s.voorstel)}` : ''}</small>
          ${s.namen.length ? `<span class="chips">${s.namen.map((n) => `<span title="${n.aantal}× genoemd tijdens deze stem">${esc(n.naam)}</span>`).join('')}</span>` : ''}</span>
        <span class="klein">${s.beurten} beurten<br><span class="zacht">${Math.round(s.seconden / 60)} min · ${s.afleveringen} ${s.afleveringen === 1 ? 'aflevering' : 'afleveringen'}</span></span>
        <span class="spreker-invoer"><button class="fragmentknop" data-fragment="${esc(s.profiel)}" title="Fragment beluisteren">${icoon('play', 12)}</button><input class="naamveld" data-profiel="${esc(s.profiel)}" placeholder="${s.naam ? 'Naam wijzigen' : 'Naam invullen'}" value=""></span>
      </div>`).join('') : '<p class="leeg" style="padding-left:0">Nog geen herkende stemmen.</p>'}
    </div>`;
  };
  teken();
  inhoud.addEventListener('click', async (e) => {
    const knop = e.target.closest('.fragmentknop');
    if (!knop) return;
    fragmentSpeler.src = `/api/audio/sprekers/${encodeURIComponent(knop.dataset.fragment)}/fragment`;
    fragmentSpeler.onerror = () => toast('Er is geen luisterfragment van deze stem.', 'fout');
    fragmentSpeler.play().catch(() => {});
  });
  inhoud.addEventListener('keydown', (e) => {
    if (e.target.classList.contains('naamveld') && e.key === 'Enter') {
      e.preventDefault();
      e.target.blur();
    }
  });
  inhoud.addEventListener('change', async (e) => {
    if (!e.target.classList.contains('naamveld') || !e.target.value.trim()) return;
    try {
      const r = await vraag('PUT', `/api/audio/sprekers/${encodeURIComponent(e.target.dataset.profiel)}`, { naam: e.target.value.trim() });
      toast(`‘${r.naam}’ geldt nu voor deze stem (${r.afleveringen} ${r.afleveringen === 1 ? 'aflevering' : 'afleveringen'}).`);
      d = await vraag('GET', `/api/audio/stemmen?${bronParam().slice(1)}`);
      teken();
    } catch (fout) {
      toast(fout.message, 'fout');
    }
  });
  app.opruimen = () => fragmentSpeler.pause();
}

// ---------- telefoonnummers ----------

const NUMMERSOORTEN = { person: 'Persoon', organization: 'Organisatie', service: 'Dienst of hulplijn', private_contact: 'Privécontact', own_number: 'Eigen nummer van de beller', invalid: 'Geen echt nummer', unknown: 'Onbekend' };
const RELATIES = { called_target: 'Werd gebeld', submitted_target: 'Werd doorgegeven', caller_own_number: 'Nummer van de beller zelf', third_party_reference: 'Genoemd als nummer van een ander', invalid_number: 'Geen geldig nummer', unclear: 'Onduidelijk' };

function nummerWie(n) {
  if (n.bedrijf) {
    return `<strong>${esc(n.bedrijf.naam)}</strong>${n.bedrijf.locatie ? `<small>${esc(n.bedrijf.locatie)}</small>` : ''}
      <small>Openbaar bevestigd · <a href="${esc(n.bedrijf.bronUrl)}" target="_blank" rel="noopener noreferrer">${esc(n.bedrijf.bronLabel)} ↗</a>${n.bedrijf.kvk ? ` · KvK ${esc(n.bedrijf.kvk)}` : ''}</small>`;
  }
  if (n.koppeling?.staat === 'bevestigd') {
    return `<strong>${esc(n.koppeling.label || n.koppeling.omschrijving)}</strong><small>${esc(NUMMERSOORTEN[n.koppeling.soort] || '')} · ${esc(RELATIES[n.koppeling.relatie] || '')} · door de redactie bevestigd</small>
      <button class="linkknop" data-wis="${esc(n.nummer)}">Beoordeling weghalen</button>`;
  }
  if (n.koppeling?.staat === 'afgewezen') return `<small>Suggestie afgewezen door de redactie.</small><button class="linkknop" data-wis="${esc(n.nummer)}">Beoordeling weghalen</button>`;
  const d = n.duidingen.find((x) => x.soort !== 'unknown');
  const gebied = n.gebied ? `<small>Netnummer ${esc(n.gebied[0])} · ${esc(n.gebied[1])}</small>` : '';
  if (!d) return `${gebied}<small>${n.duidingBezig ? 'Wordt nog geduid door de worker…' : 'Nog geen koppeling.'}</small>`;
  return `${gebied}<div class="duiding"><span><strong>Suggestie: ${esc(d.label || d.omschrijving || NUMMERSOORTEN[d.soort])}</strong> · ${esc(NUMMERSOORTEN[d.soort])} · ${esc(RELATIES[d.relatie] || '')} · ${d.zekerheid}% zeker</span>
    ${d.bewijs ? `<span>“${esc(d.bewijs)}”</span>` : ''}
    <span class="knoppenrij"><button class="knop klein" data-bevestig="${esc(n.nummer)}">Klopt</button><button class="knop zacht klein" data-afwijs="${esc(n.nummer)}">Klopt niet</button></span>
    <small>Afgeleid uit het transcript, geen bewijs. Bevestig alleen als je het hebt nagegaan.</small></div>`;
}

async function toonNummers(inhoud) {
  let lijst = await vraag('GET', `/api/audio/telefoonnummers?${bronParam().slice(1)}`);
  const teken = () => {
    inhoud.innerHTML = `<div class="archiefpagina">
      <div class="paginakop"><h1>Telefoonnummers</h1><span class="klein zacht">${lijst.length} ${lijst.length === 1 ? 'nummer' : 'nummers'}, geschreven of uitgesproken in de transcripten. Een openbare bedrijfspagina bewijst een koppeling; een suggestie uit het transcript niet.</span></div>
      <div class="tabelkop nummerrij"><span>Nummer</span><span>Wie</span><span>Waar het valt</span></div>
      ${lijst.length ? lijst.map((n) => `<div class="tabelrij nummerrij">
        <span class="naamcel"><span class="nummer">${esc(n.weergave)}</span><small>${esc(n.categorie)} · ${n.vermeldingen}× in ${n.afleveringen.length} ${n.afleveringen.length === 1 ? 'aflevering' : 'afleveringen'}</small></span>
        <span class="naamcel">${nummerWie(n)}</span>
        <span>${n.afleveringen.map((a) => `<div class="afleveringkop" style="padding-top:0">${esc(a.titel)} <small>${a.gepubliceerd ? esc(moment(a.gepubliceerd, { metTijd: false })) : ''}</small></div>
          ${a.vermeldingen.map((m) => `<a class="vermelding" href="${stukLink(a.id, m.start)}"><span class="tijd">${esc(m.tijd)}</span><span>“${markeer(m.context, m.ruw)}”</span></a>`).join('')}`).join('')}</span>
      </div>`).join('') : '<p class="leeg" style="padding-left:0">Nog geen telefoonnummers gevonden.</p>'}
    </div>`;
  };
  teken();
  inhoud.addEventListener('click', async (e) => {
    const knop = e.target.closest('button');
    if (!knop) return;
    const nummer = knop.dataset.bevestig || knop.dataset.afwijs || knop.dataset.wis;
    if (!nummer) return;
    const n = lijst.find((x) => x.nummer === nummer);
    const d = n.duidingen.find((x) => x.soort !== 'unknown');
    let invoer = { staat: 'wis' };
    if (knop.dataset.afwijs) invoer = { staat: 'afgewezen' };
    if (knop.dataset.bevestig) {
      const label = prompt('Wie of wat zit er achter dit nummer? (naam of korte omschrijving)', d?.label || '');
      if (label === null) return;
      invoer = { staat: 'bevestigd', soort: d?.soort && d.soort !== 'unknown' ? d.soort : 'organization', relatie: d?.relatie || 'unclear', label: label.trim(), omschrijving: d?.omschrijving || '', aflevering: d?.aflevering, segment: d?.segment };
    }
    await bezig(knop, async () => {
      await vraag('PUT', `/api/audio/telefoonnummers/${encodeURIComponent(nummer)}`, invoer);
      lijst = await vraag('GET', `/api/audio/telefoonnummers?${bronParam().slice(1)}`);
      teken();
    });
  });
}

// ---------- de weergave ----------

export async function toonArchief(hoofd, tab, params) {
  if (!['namen', 'stemmen', 'nummers'].includes(tab)) {
    location.replace('#/archief');
    return;
  }
  await laadBronnen();
  if (params.get('bron') !== null) archiefFilters.bron = params.get('bron');
  hoofd.innerHTML = `${archiefBalkHtml(tab)}<div id="archiefinhoud"><p class="leeg">Laden…</p></div>`;
  const inhoud = $('#archiefinhoud');
  const toon = () => (tab === 'namen' ? toonNamen(inhoud) : tab === 'stemmen' ? toonStemmen(inhoud) : toonNummers(inhoud));
  koppelArchiefBalk(hoofd.querySelector('.archiefbalk'), () => toonArchief(hoofd, tab, new URLSearchParams()));
  await toon();
}
