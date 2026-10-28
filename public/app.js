// De webUI van de Regiochecker: één pagina met een kleine router op de hash.
//   #/feed, #/bewaard, #/zoeken?q=…, #/meldingen      voor iedereen
//   #/beheer/regios[/id], #/beheer/bronnen, #/beheer/gebruikers,
//   #/beheer/teams, #/beheer/telegram, #/beheer/logboek,
//   #/beheer/instellingen                                     alleen voor admins
// Geen framework: elke weergave tekent in <main> en koppelt zijn eigen knoppen.

import { $, esc, vraag, icoon, toast, koppelVoorbeeld, uurMinuut } from './gedeeld.js';
import { toonFeed } from './feed.js';
import { toonMeldingen } from './meldingen.js';
import { toonRegios, toonBronnen, toonAudio, toonGebruikers, toonTeams, toonTelegram, toonLogboek, toonInstellingen } from './beheer.js';
import { toonArchief } from './archief.js';

export const app = {
  ik: null,
  beheerStatus: null,
  // Wordt door een weergave gezet om op te ruimen (luisteraars, audio).
  opruimen: null,
};

export async function laadIk() {
  app.ik = await vraag('GET', '/api/ik');
  return app.ik;
}

export function zetBewaardTeller(n) {
  if (app.ik) app.ik.bewaard = n;
  const el = $('#teller-bewaard');
  if (el) el.textContent = n || '';
}

function route() {
  const [pad, query = ''] = location.hash.replace(/^#/, '').split('?');
  const delen = pad.split('/').filter(Boolean);
  return { delen, params: new URLSearchParams(query) };
}

// ---------- header ----------

function menuLink(href, tekst, actief, extra = '') {
  return `<a href="${href}"${actief ? ' aria-current="page"' : ''}>${tekst}${extra}</a>`;
}

function tekenKop(r) {
  const ik = app.ik;
  const beheer = r.delen[0] === 'beheer';
  const naam = esc(ik.gebruiker.naam || ik.gebruiker.login || ik.gebruiker.email);
  if (beheer) {
    const sub = r.delen[1] || 'regios';
    $('#kop').innerHTML = `
      <a class="logo" href="#/feed"><span class="logo-blok"></span><span class="logo-naam">Regiochecker</span><span class="beheer-tag">Beheer</span></a>
      <nav class="menu" aria-label="Beheer">
        ${menuLink('#/feed', 'Feed', false)}
        ${menuLink('#/beheer/regios', 'Regio\'s', sub === 'regios')}
        ${menuLink('#/beheer/bronnen', 'Bronnen', sub === 'bronnen')}
        ${menuLink('#/beheer/audio', 'Audio', sub === 'audio')}
        ${menuLink('#/beheer/gebruikers', 'Gebruikers', sub === 'gebruikers')}
        ${menuLink('#/beheer/teams', 'Teams', sub === 'teams')}
        ${menuLink('#/beheer/telegram', 'Telegram', sub === 'telegram')}
        ${menuLink('#/beheer/logboek', 'Logboek', sub === 'logboek')}
        ${menuLink('#/beheer/instellingen', 'Instellingen', sub === 'instellingen')}
      </nav>
      <div class="kop-rechts"><span id="kop-status" class="kop-status"></span></div>`;
    tekenBeheerStatus();
    return;
  }
  const hier = r.delen[0] || 'feed';
  const zoekvraag = hier === 'zoeken' ? r.params.get('q') || '' : '';
  $('#kop').innerHTML = `
    <a class="logo" href="#/feed"><span class="logo-blok"></span><span class="logo-naam">Regiochecker</span></a>
    <nav class="menu" aria-label="Hoofdmenu">
      ${menuLink('#/feed', 'Feed', hier === 'feed')}
      ${menuLink('#/bewaard', 'Bewaard', hier === 'bewaard', `<span class="teller" id="teller-bewaard">${ik.bewaard || ''}</span>`)}
      ${ik.audio ? menuLink('#/archief', 'Audio-archief', hier === 'archief') : ''}
      ${menuLink('#/meldingen', 'Meldingen', hier === 'meldingen')}
    </nav>
    <div class="kop-rechts">
      <form class="zoekveld" id="zoekformulier" role="search" ${hier === 'zoeken' ? '' : 'hidden'}>
        ${icoon('search')}<input id="zoekinvoer" type="search" placeholder="Zoeken in alle bronnen" value="${esc(zoekvraag)}" aria-label="Zoeken">
      </form>
      <button class="zoekknop" id="zoekknop" ${hier === 'zoeken' ? 'hidden' : ''}>${icoon('search')}Zoeken</button>
      ${ik.beheerder ? '<a class="kop-link" href="#/beheer/regios">Beheer</a>' : ''}
      <span class="gebruikersnaam">${naam}</span>
    </div>`;
  $('#zoekknop').addEventListener('click', () => {
    $('#zoekknop').hidden = true;
    $('#zoekformulier').hidden = false;
    $('#zoekinvoer').focus();
  });
  $('#zoekformulier').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#zoekinvoer').value.trim();
    if (q) location.hash = `#/zoeken?q=${encodeURIComponent(q)}`;
  });
  $('#zoekinvoer').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && hier !== 'zoeken') {
      $('#zoekformulier').hidden = true;
      $('#zoekknop').hidden = false;
    }
  });
}

export async function tekenBeheerStatus() {
  const el = $('#kop-status');
  if (!el) return;
  try {
    const s = await vraag('GET', '/api/beheer/status');
    app.beheerStatus = s;
    if (s.fouten.length) {
      el.textContent = `${s.fouten.length} bron${s.fouten.length === 1 ? '' : 'nen'} met fout`;
      el.className = 'kop-status fout';
      el.title = s.fouten.join('\n');
    } else {
      const elk = s.intervalMinuten === 60 ? 'Elk uur' : `Elke ${s.intervalMinuten} minuten`;
      el.textContent = `${elk} gecontroleerd${s.laatsteVerzamelronde ? ` · laatst ${uurMinuut(s.laatsteVerzamelronde)}` : ''}`;
      el.className = 'kop-status';
    }
  } catch {
    el.textContent = '';
  }
}

// ---------- router ----------

async function toon() {
  app.opruimen?.();
  app.opruimen = null;
  const r = route();
  if (!r.delen.length) {
    location.replace('#/feed');
    return;
  }
  if (r.delen[0] === 'beheer' && !app.ik.beheerder) {
    location.replace('#/feed');
    return;
  }
  tekenKop(r);
  const hoofd = $('#hoofd');
  hoofd.innerHTML = '';
  try {
    const [eerste, tweede, derde] = r.delen;
    if (eerste === 'feed' || eerste === 'bewaard' || eerste === 'zoeken') await toonFeed(hoofd, { modus: eerste, params: r.params });
    else if (eerste === 'archief' && !tweede) await toonFeed(hoofd, { modus: 'archief', params: r.params });
    else if (eerste === 'archief') await toonArchief(hoofd, tweede, r.params);
    else if (eerste === 'meldingen') await toonMeldingen(hoofd);
    else if (eerste === 'beheer' && tweede === 'regios') await toonRegios(hoofd, derde);
    else if (eerste === 'beheer' && tweede === 'bronnen') await toonBronnen(hoofd, r.params);
    else if (eerste === 'beheer' && tweede === 'audio') await toonAudio(hoofd);
    else if (eerste === 'beheer' && tweede === 'gebruikers') await toonGebruikers(hoofd);
    else if (eerste === 'beheer' && tweede === 'teams') await toonTeams(hoofd);
    else if (eerste === 'beheer' && tweede === 'telegram') await toonTelegram(hoofd);
    else if (eerste === 'beheer' && tweede === 'logboek') await toonLogboek(hoofd);
    else if (eerste === 'beheer' && tweede === 'instellingen') await toonInstellingen(hoofd);
    else if (eerste === 'beheer') location.replace('#/beheer/regios');
    else location.replace('#/feed');
  } catch (fout) {
    if (fout.status !== 401) {
      hoofd.innerHTML = `<p class="leeg">${esc(fout.message)}</p>`;
      toast(fout.message, 'fout');
    }
  }
}

async function start() {
  try {
    await laadIk();
  } catch (fout) {
    if (fout.status === 403) {
      $('#kop').innerHTML = '<span class="logo"><span class="logo-blok"></span><span class="logo-naam">Regiochecker</span></span>';
      $('#hoofd').innerHTML = `<div class="geen-toegang"><h1>Nog geen toegang</h1><p>${esc(fout.message)}</p></div>`;
    } else if (fout.status !== 401) {
      $('#hoofd').innerHTML = `<p class="leeg">De Regiochecker is niet bereikbaar: ${esc(fout.message)}</p>`;
    }
    return;
  }
  // De huisstijl kan na een wijziging bij Gebruikers anders zijn dan bij het laden.
  document.documentElement.dataset.titel = (app.ik.gebruiker.titel || 'LC').toLowerCase();
  koppelVoorbeeld();
  window.addEventListener('hashchange', toon);
  await toon();
}

start();
