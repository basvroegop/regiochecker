// WebUI van de Regiochecker. Geen framework: één keer /api/overzicht ophalen,
// alles daaruit tekenen, en na elke wijziging opnieuw ophalen.

import { $, esc, vraag, meld, voerUit, bezig, tijd, korteDatum } from './gedeeld.js';

const DAGEN = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'];

let staat = null;

function tekenStatus() {
  const { status, instellingen, ontvangers } = staat;
  const delen = [
    `Laatste controle: <strong>${esc(tijd(status.laatsteVerzamelronde))}</strong>`,
    `Volgende mail: <strong>${esc(status.volgendeMail ? tijd(status.volgendeMail) : 'geen verstuurdag ingesteld')}</strong>`,
    `${ontvangers.filter((o) => o.actief && o.regios.length).length} actieve ontvangers`,
  ];
  if (status.kamer) {
    const k = status.kamer;
    delen.push(`Kamerstukken: ${k.metTekst || 0} doorzoekbaar${k.wachtrij ? `, ${k.wachtrij} in de wachtrij` : ''}`);
  }
  const waarschuwingen = [];
  if (!instellingen.smtp.host) waarschuwingen.push('SMTP nog niet ingesteld: er gaan geen mails de deur uit');
  if (!instellingen.samenvatting.klaar && instellingen.samenvatting.via !== 'uit') waarschuwingen.push(`geen samenvatting: ${instellingen.samenvatting.reden}`);
  const kapot = staat.regios.flatMap((r) => r.bronnen).filter((b) => b.status && !b.status.ok).length;
  if (kapot) waarschuwingen.push(`${kapot} bron${kapot === 1 ? '' : 'nen'} gaf een fout`);
  $('#statusbalk').innerHTML = delen.join(' · ')
    + (waarschuwingen.length ? `<div class="waarschuwing">${waarschuwingen.map(esc).join(' · ')}</div>` : '');
}

function tekenOntvangers() {
  const tabel = $('#ontvangers');
  const regios = staat.regios;
  // Afbreekpunten in de lange namen, anders worden de kolommen zo breed dat de
  // tabel niet meer op een laptopscherm past.
  const afbreekbaar = (naam) => esc(naam).replace(/(stelling)(werf)/, '$1&shy;$2').replace(/(Smallinger)(land)/, '$1&shy;$2');
  $('thead', tabel).innerHTML = `<tr><th>Naam</th><th>E-mailadres</th>${regios.map((r) => `<th class="regio">${afbreekbaar(r.naam)}</th>`).join('')}<th>Actief</th><th>Vorige mail</th><th></th></tr>`;

  $('tbody', tabel).innerHTML = staat.ontvangers.length
    ? staat.ontvangers.map((o) => `
      <tr data-id="${esc(o.id)}" class="${o.actief ? '' : 'inactief'}">
        <td><input class="veld" data-veld="naam" value="${esc(o.naam)}" aria-label="Naam"></td>
        <td><input class="veld" data-veld="email" type="email" value="${esc(o.email)}" aria-label="E-mailadres"></td>
        ${regios.map((r) => `<td class="regio"><input type="checkbox" data-regio="${esc(r.id)}" ${o.regios.includes(r.id) ? 'checked' : ''} aria-label="${esc(r.naam)} voor ${esc(o.email)}"></td>`).join('')}
        <td class="regio"><input type="checkbox" data-veld="actief" ${o.actief ? 'checked' : ''} aria-label="Actief"></td>
        <td class="klein">${esc(tijd(o.laatsteMail))}</td>
        <td class="acties">
          <button class="knop licht klein" data-actie="voorbeeld" title="Bekijk de mail en verstuur hem eventueel meteen">Voorbeeld</button>
          <button class="knop gevaar klein" data-actie="verwijder" aria-label="Verwijder ${esc(o.email)}">×</button>
        </td>
      </tr>`).join('')
    : `<tr><td colspan="${regios.length + 5}" class="leeg">Nog geen ontvangers. Voeg hieronder de eerste toe.</td></tr>`;

  // De invoerregel maar één keer tekenen, anders wist het verversen elke minuut
  // wat iemand half heeft ingetypt.
  if (!$('#nieuw-email')) $('tfoot', tabel).innerHTML = `
    <tr class="nieuw">
      <td><input id="nieuw-naam" placeholder="Naam"></td>
      <td><input id="nieuw-email" type="email" placeholder="naam@krant.nl"></td>
      ${regios.map((r) => `<td class="regio"><input type="checkbox" data-nieuw-regio="${esc(r.id)}" aria-label="${esc(r.naam)}"></td>`).join('')}
      <td colspan="3"><button id="toevoegen" class="knop">Toevoegen</button></td>
    </tr>`;
}

function statusVanBron(b) {
  if (b.ontbreekt) return { klasse: 'ontbreekt', tekst: 'Niet gevonden' };
  if (!b.status) return { klasse: 'wacht', tekst: 'Nog niet gecontroleerd' };
  if (!b.status.ok) return { klasse: 'fout', tekst: 'Fout' };
  if (b.status.waarschuwing) return { klasse: 'waarschuw', tekst: 'Leeg' };
  if (b.vervangend) return { klasse: 'vervangend', tekst: 'Vervangende bron' };
  return { klasse: 'ok', tekst: 'Werkt' };
}

function tekenBronnen() {
  $('#regios').innerHTML = staat.regios.map((r) => {
    const volgers = staat.ontvangers.filter((o) => o.actief && o.regios.includes(r.id));
    return `
    <article class="kaart regio-kaart">
      <h3><a href="${esc(r.site)}" target="_blank" rel="noopener">${esc(r.naam)}</a></h3>
      <p class="klein">${volgers.length ? `Gaat naar ${volgers.map((o) => esc(o.naam || o.email)).join(', ')}` : 'Nog niemand volgt deze regio'}</p>
      <ul class="bronnen">
        ${r.bronnen.map((b) => {
          const s = statusVanBron(b);
          const st = b.status;
          const details = b.ontbreekt ? '' : st
            ? (st.ok
              ? `${st.aantal} items in de bron · ${b.nieuwDezeWeek} nieuw deze week · gecontroleerd ${esc(tijd(st.laatsteRonde))}${st.nulmeting ? ' (nulmeting)' : ''}`
              : `${esc(st.fout)} · ${esc(tijd(st.laatsteRonde))}`)
            : '';
          return `<li class="bron ${s.klasse}">
            <div class="bron-kop"><span class="stip" title="${esc(s.tekst)}"></span><span class="soort">${esc(b.soortNaam)}</span><span class="label-status">${esc(s.tekst)}</span></div>
            <div><a href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.label)}</a></div>
            ${details ? `<div class="klein">${details}</div>` : ''}
            ${st?.waarschuwing ? `<div class="klein waarschuw-tekst">${esc(st.waarschuwing)}</div>` : ''}
            ${b.toelichting ? `<div class="toelichting">${esc(b.toelichting)}</div>` : ''}
          </li>`;
        }).join('')}
      </ul>
    </article>`;
  }).join('');
}

async function tekenItems() {
  const regio = $('#filter-regio').value;
  const dagen = $('#filter-dagen').value;
  const items = await vraag('GET', `/api/items?dagen=${dagen}${regio ? `&regio=${encodeURIComponent(regio)}` : ''}`);
  const naam = Object.fromEntries(staat.regios.map((r) => [r.id, r.naam]));
  const soort = { nieuws: 'Nieuws', ingekomen: 'Ingekomen', woo: 'Woo' };
  $('#items').innerHTML = items.length
    ? `<table class="lijst"><thead><tr><th>Gezien</th><th>Regio</th><th>Soort</th><th>Datum stuk</th><th>Titel</th></tr></thead><tbody>
      ${items.map((i) => `<tr>
        <td class="klein">${esc(tijd(i.eersteGezien))}</td>
        <td>${esc(naam[i.regio] || i.regio)}</td>
        <td><span class="label ${esc(i.soort)}">${esc(soort[i.soort] || i.soort)}</span></td>
        <td class="klein">${esc(korteDatum(i.datum))}</td>
        <td><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.titel)}</a>${[i.afzender, i.soortStuk, i.advies].filter(Boolean).length ? `<div class="klein">${esc([i.afzender, i.soortStuk, i.advies].filter(Boolean).join(' · '))}</div>` : ''}</td>
      </tr>`).join('')}
    </tbody></table>`
    : '<p class="leeg">Niets gevonden in deze periode. Na de eerste controle staat hier alleen wat daarna nieuw binnenkomt.</p>';
}

function tekenInstellingen() {
  const i = staat.instellingen;
  const schema = $('#form-schema');
  schema.mailTijd.value = i.mailTijd;
  schema.mailBijNiets.checked = i.mailBijNiets;
  schema.controleIntervalMinuten.value = i.controleIntervalMinuten;
  $('fieldset.dagen', schema).innerHTML = '<legend>Dagen</legend>' + DAGEN.map((d, n) =>
    `<label class="vink"><input type="checkbox" name="dag" value="${n + 1}" ${i.mailDagen.includes(n + 1) ? 'checked' : ''}> ${d}</label>`).join('');

  const smtp = $('#form-smtp');
  for (const veld of ['host', 'port', 'user', 'from']) smtp[veld].value = i.smtp[veld] ?? '';
  smtp.secure.checked = i.smtp.secure;
  smtp.pass.value = '';
  smtp.pass.placeholder = i.smtp.heeftWachtwoord ? '•••••••• (bewaard; leeg laten = niet wijzigen)' : '';

  const sp = $('#form-samenvatting');
  for (const r of sp.querySelectorAll('[name="via"]')) r.checked = r.value === i.samenvattingVia;
  sp.apiKey.value = '';
  sp.apiKey.placeholder = i.claude.heeftSleutel
    ? (i.claude.sleutelUitOmgeving ? 'ingesteld via ANTHROPIC_API_KEY' : '•••••••• (bewaard; leeg laten = niet wijzigen)')
    : 'sk-ant-…';
  sp.claudeModel.value = i.claude.model;
  sp.ollamaUrl.value = i.ollama.url;
  sp.ollamaModel.value = i.ollama.model;
  sp.maxContext.value = i.ollama.maxContext;
  $('#ollama-route').textContent = i.tailnetProxy
    ? 'Verbinding via de Tailscale-container naast de Regiochecker. Gebruik de naam of het 100.x-adres van de machine in je tailnet.'
    : 'Geen Tailscale-proxy ingesteld: de Regiochecker probeert de URL rechtstreeks.';
  toonAanbieder();
}

function toonAanbieder() {
  const via = $('#form-samenvatting [name="via"]:checked')?.value;
  for (const f of document.querySelectorAll('fieldset.aanbieder')) f.hidden = f.dataset.via !== via;
}

async function tekenTermen() {
  const { regios } = await vraag('GET', '/api/kamer/termen');
  const k = staat.status.kamer;
  $('#kamer-status').textContent = k
    ? `Index: ${k.totaal} kamerstukken van ${korteDatum(k.oudste)} tot ${korteDatum(k.nieuwste)}, waarvan ${k.metTekst || 0} met volledige tekst${k.wachtrij ? ` (${k.wachtrij} nog in de wachtrij)` : ''}. Laatst bijgewerkt ${tijd(k.laatsteSync)}.`
    : 'De kamerstukkendatabase is niet beschikbaar.';
  const maand = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  $('#termen').innerHTML = regios.map((r) => `
    <article class="kaart regio-kaart" data-regio="${esc(r.id)}">
      <h3>${esc(r.naam)}</h3>
      <textarea rows="6" class="termen-invoer" aria-label="Termen voor ${esc(r.naam)}" placeholder="Eén per regel: dorpen, wegen, gebieden, projecten">${esc(r.termen.join('\n'))}</textarea>
      <div class="knoppen"><button class="knop klein" data-actie="termen-bewaren">Bewaren</button></div>
      ${r.tellingen.length ? `<ul class="tellingen">${r.tellingen.map((t) => `<li><a href="/kamerstukken.html?q=${encodeURIComponent(`"${t.term}"`)}&van=${maand}">${esc(t.term)}</a> <span class="klein">${t.aantal}</span></li>`).join('')}</ul>` : '<p class="klein">Nog geen termen.</p>'}
    </article>`).join('');
}

$('#termen').addEventListener('click', (e) => {
  const knop = e.target.closest('[data-actie="termen-bewaren"]');
  if (!knop) return;
  const kaart = knop.closest('[data-regio]');
  bezig(knop, async () => {
    const r = await vraag('PUT', `/api/kamer/termen/${kaart.dataset.regio}`, { termen: $('textarea', kaart).value.split('\n') });
    meld(`${r.termen.length} termen bewaard voor ${$('h3', kaart).textContent}`);
    await tekenTermen();
  });
});

async function tekenLogboek() {
  const regels = await vraag('GET', '/api/logboek');
  const namen = { verzonden: 'Verzonden', mailfout: 'Mail mislukt', bronfout: 'Bron mislukt', claudefout: 'Claude mislukt', ollamafout: 'Ollama mislukt', kamermelding: 'Kamermelding', testmail: 'Testmail', fout: 'Fout' };
  $('#logboek').innerHTML = regels.length
    ? `<table class="lijst"><thead><tr><th>Tijd</th><th>Wat</th><th>Aan</th><th>Details</th></tr></thead><tbody>
      ${regels.map((r) => `<tr class="${/fout/.test(r.soort) ? 'fout' : ''}"><td class="klein">${esc(tijd(r.tijd))}</td><td>${esc(namen[r.soort] || r.soort)}</td><td>${esc(r.aan || '')}</td><td class="pre">${esc(r.tekst || '')}</td></tr>`).join('')}
    </tbody></table>`
    : '<p class="leeg">Nog niets gebeurd.</p>';
}

async function laad() {
  staat = await vraag('GET', '/api/overzicht');
  tekenStatus();
  tekenOntvangers();
  tekenBronnen();
  tekenInstellingen();
  const filter = $('#filter-regio');
  if (filter.options.length === 1) {
    filter.insertAdjacentHTML('beforeend', staat.regios.map((r) => `<option value="${esc(r.id)}">${esc(r.naam)}</option>`).join(''));
  }
}

// ---------- ontvangers ----------

function ontvangerUitRij(rij) {
  return {
    naam: $('[data-veld="naam"]', rij).value,
    email: $('[data-veld="email"]', rij).value,
    actief: $('[data-veld="actief"]', rij).checked,
    regios: [...rij.querySelectorAll('[data-regio]:checked')].map((c) => c.dataset.regio),
  };
}

async function bewaarRij(rij) {
  try {
    await vraag('PUT', `/api/ontvangers/${rij.dataset.id}`, ontvangerUitRij(rij));
    rij.classList.add('bewaard');
    setTimeout(() => rij.classList.remove('bewaard'), 800);
    await laad();
  } catch (fout) {
    meld(fout.message, 'fout');
    await laad();
  }
}

$('#ontvangers').addEventListener('change', (e) => {
  const rij = e.target.closest('tbody tr[data-id]');
  if (rij) bewaarRij(rij);
});

$('#ontvangers').addEventListener('click', async (e) => {
  const knop = e.target.closest('button');
  if (!knop) return;
  if (knop.id === 'toevoegen') {
    return bezig(knop, async () => {
      await vraag('POST', '/api/ontvangers', {
        naam: $('#nieuw-naam').value,
        email: $('#nieuw-email').value,
        regios: [...document.querySelectorAll('[data-nieuw-regio]:checked')].map((c) => c.dataset.nieuwRegio),
      });
      meld('Ontvanger toegevoegd');
      $('tfoot', $('#ontvangers')).innerHTML = '';
      await laad();
    });
  }
  const rij = knop.closest('tr[data-id]');
  if (!rij) return;
  const ontvanger = staat.ontvangers.find((o) => o.id === rij.dataset.id);
  if (knop.dataset.actie === 'verwijder') {
    if (!confirm(`${ontvanger.email} verwijderen?`)) return;
    await bezig(knop, async () => {
      await vraag('DELETE', `/api/ontvangers/${ontvanger.id}`);
      await laad();
    });
  }
  if (knop.dataset.actie === 'voorbeeld') openVoorbeeld(ontvanger);
});

// ---------- voorbeeld ----------

let voorbeeldVan = null;

async function laadVoorbeeld(samenvatting) {
  const voor = voorbeeldVan;
  const regel = $('#voorbeeld-onderwerp');
  const mail = await voerUit('voorbeeld', { ontvanger: voor.id, dagen: Number($('#voorbeeld-dagen').value), samenvatting }, (tekst) => {
    if (voorbeeldVan === voor) regel.textContent = `${tekst}…`;
  });
  // Intussen een ander voorbeeld geopend? Dan dit resultaat niet tonen.
  if (voorbeeldVan !== voor) return;
  regel.textContent = `Onderwerp: ${mail.onderwerp}`;
  // Links uit de mail in een nieuw tabblad, niet binnen het voorbeeldvenster.
  $('#voorbeeld-frame').srcdoc = mail.html.replace('<head>', '<head><base target="_blank">');
}

async function openVoorbeeld(ontvanger) {
  voorbeeldVan = ontvanger;
  $('#voorbeeld-titel').textContent = `Voorbeeld voor ${ontvanger.naam || ontvanger.email}`;
  $('#voorbeeld').showModal();
  try {
    await laadVoorbeeld(false);
  } catch (fout) {
    meld(fout.message, 'fout');
  }
}

$('#voorbeeld-dagen').addEventListener('change', () => laadVoorbeeld(false).catch((f) => meld(f.message, 'fout')));
$('#voorbeeld-samenvatting').addEventListener('click', (e) => bezig(e.target, () => laadVoorbeeld(true)));
$('#voorbeeld-sluit').addEventListener('click', () => $('#voorbeeld').close());
$('#voorbeeld-verstuur').addEventListener('click', (e) => {
  const o = voorbeeldVan;
  const sinds = o.laatsteMail ? `sinds de vorige mail (${tijd(o.laatsteMail)})` : 'van de afgelopen week';
  if (!confirm(`Nu een mail sturen naar ${o.email}, met alles wat ${sinds} nieuw is?`)) return;
  bezig(e.target, async () => {
    const r = await voerUit('verstuur', { ontvanger: o.id }, (tekst) => { $('#voorbeeld-onderwerp').textContent = `${tekst}…`; });
    meld(`Verstuurd: ${r.onderwerp}`);
    $('#voorbeeld').close();
    await laad();
  });
});

// ---------- bronnen, gevonden, instellingen ----------

$('#nu-controleren').addEventListener('click', (e) => bezig(e.target, async () => {
  const resultaten = await voerUit('verzamel', {}, (tekst) => { e.target.textContent = tekst; });
  const nieuw = resultaten.reduce((n, r) => n + (r.nieuw || 0), 0);
  const fout = resultaten.filter((r) => !r.ok).length;
  meld(`Klaar: ${nieuw} nieuwe items${fout ? `, ${fout} bronnen mislukt` : ''}`, fout ? 'fout' : 'ok');
  await laad();
}));

$('#filter-regio').addEventListener('change', () => tekenItems().catch((f) => meld(f.message, 'fout')));
$('#filter-dagen').addEventListener('change', () => tekenItems().catch((f) => meld(f.message, 'fout')));

$('#form-schema').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  bezig($('button', f), async () => {
    await vraag('PUT', '/api/instellingen', {
      mailTijd: f.mailTijd.value,
      mailDagen: [...f.querySelectorAll('[name="dag"]:checked')].map((c) => Number(c.value)),
      mailBijNiets: f.mailBijNiets.checked,
      controleIntervalMinuten: Number(f.controleIntervalMinuten.value),
    });
    meld('Verstuurmoment bewaard');
    await laad();
  });
});

$('#form-smtp').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  bezig($('button', f), async () => {
    await vraag('PUT', '/api/instellingen', {
      smtp: { host: f.host.value, port: Number(f.port.value), secure: f.secure.checked, user: f.user.value, pass: f.pass.value, from: f.from.value },
    });
    meld('SMTP-instellingen bewaard');
    await laad();
  });
});

$('#wis-wachtwoord').addEventListener('click', (e) => bezig(e.target, async () => {
  await vraag('PUT', '/api/instellingen', { smtp: { wisWachtwoord: true } });
  meld('Wachtwoord gewist');
  await laad();
}));

$('#testmail').addEventListener('click', (e) => bezig(e.target, async () => {
  await vraag('POST', '/api/testmail', { aan: $('#testmail-aan').value });
  meld(`Testmail verstuurd naar ${$('#testmail-aan').value}`);
}));

$('#form-samenvatting').addEventListener('change', (e) => {
  if (e.target.name === 'via') toonAanbieder();
});

$('#form-samenvatting').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  bezig($('button.knop:not(.licht)', f), async () => {
    await vraag('PUT', '/api/instellingen', {
      samenvattingVia: f.querySelector('[name="via"]:checked')?.value,
      claude: { apiKey: f.apiKey.value, model: f.claudeModel.value },
      ollama: { url: f.ollamaUrl.value, model: f.ollamaModel.value, maxContext: Number(f.maxContext.value) },
    });
    meld('Instellingen voor de samenvatting bewaard');
    await laad();
  });
});

$('#ollama-test').addEventListener('click', (e) => {
  const status = $('#ollama-status');
  status.textContent = '';
  bezig(e.target, async () => {
    try {
      const info = await vraag('POST', '/api/ollama/test', { url: $('#form-samenvatting').ollamaUrl.value });
      $('#ollama-modellen').innerHTML = info.modellen.map((m) => `<option value="${esc(m.naam)}">${esc([m.parameters, m.grootte && `${(m.grootte / 1e9).toFixed(1)} GB`].filter(Boolean).join(', '))}</option>`).join('');
      status.textContent = `Verbonden met Ollama ${info.versie || ''}: ${info.modellen.length} model${info.modellen.length === 1 ? '' : 'len'} (${info.modellen.map((m) => m.naam).join(', ') || 'geen'})`;
      const veld = $('#form-samenvatting').ollamaModel;
      if (!veld.value && info.modellen[0]) veld.value = info.modellen[0].naam;
    } catch (fout) {
      status.textContent = fout.message;
      throw fout;
    }
  });
});

$('#wis-sleutel').addEventListener('click', (e) => bezig(e.target, async () => {
  await vraag('PUT', '/api/instellingen', { claude: { wisSleutel: true } });
  meld('Sleutel gewist');
  await laad();
}));

$('#mailronde').addEventListener('click', (e) => {
  const aantal = staat.ontvangers.filter((o) => o.actief && o.regios.length).length;
  if (!confirm(`Nu de mailronde versturen naar ${aantal} actieve ontvangers?`)) return;
  bezig(e.target, async () => {
    const r = await voerUit('mailronde', {}, (tekst) => { e.target.textContent = `${tekst}…`; });
    const verstuurd = r.filter((x) => x.verstuurd).length;
    const mislukt = r.filter((x) => x.fout);
    meld(`${verstuurd} verstuurd${mislukt.length ? `, ${mislukt.length} mislukt: ${mislukt.map((x) => x.fout).join('; ')}` : ''}`, mislukt.length ? 'fout' : 'ok');
    await laad();
  });
});

// ---------- tabs ----------

function toonTab(naam) {
  for (const knop of document.querySelectorAll('[role="tab"]')) knop.setAttribute('aria-selected', String(knop.dataset.tab === naam));
  for (const tab of document.querySelectorAll('.tab')) tab.hidden = tab.id !== `tab-${naam}`;
  if (naam === 'gevonden') tekenItems().catch((f) => meld(f.message, 'fout'));
  if (naam === 'logboek') tekenLogboek().catch((f) => meld(f.message, 'fout'));
  if (naam === 'termen') tekenTermen().catch((f) => meld(f.message, 'fout'));
  history.replaceState(null, '', `#${naam}`);
}

for (const knop of document.querySelectorAll('[role="tab"]')) knop.addEventListener('click', () => toonTab(knop.dataset.tab));
window.addEventListener('hashchange', () => toonTab(location.hash.slice(1) || 'ontvangers'));

laad()
  .then(() => toonTab(location.hash.slice(1) || 'ontvangers'))
  .catch((fout) => meld(`Kon de gegevens niet laden: ${fout.message}`, 'fout'));
setInterval(() => { if (!document.hidden && !$('#voorbeeld').open && !document.activeElement?.matches('input, select')) laad().catch(() => {}); }, 60000);
