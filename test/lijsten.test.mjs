// De lezers voor eigen sites van gemeenten en hun Woo-platforms
// (src/bronnen/htmllijst.mjs, ibabsagenda.mjs, woo.mjs), met kleine stukjes
// HTML en JSON in de vorm van de echte pagina's (oktober 2026). En de datum
// voor pagina's zonder datums: de dag dat de Regiochecker een stuk voor het
// eerst zag.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MockAgent } from 'undici';
import { leesHtmlLijst } from '../src/bronnen/htmllijst.mjs';
import { leesKalender, leesAgendapunten, leesIbabsAgenda, haalIbabsAgenda } from '../src/bronnen/ibabsagenda.mjs';
import { leesEdataloket, leesDivault, leesPublicaties, leesStack, leesDjuma, leesMozardRegels, leesRecentJson } from '../src/bronnen/woo.mjs';
import { zetOpenbaarDispatcher } from '../src/netwerk.mjs';
import { Opslag } from '../src/opslag.mjs';
import { verwerk } from '../src/verzamel.mjs';

process.env.IBABS_WACHT_MS = '0';

// ---------- HTML-lijst ----------

test('html-lijst: nieuws met <time>, een losse datum, "Lees meer" en een cachebuster', () => {
  const html = `<nav><a href="/nieuws/menu-item">Menu</a></nav>
    <main>
      <article><h3><a href="/nieuws/scrooge-live/">Meer over 'Scrooge Live keert terug'</a></h3>
        <time datetime="2026-10-28T09:15:00+01:00">28 okt</time><p>De voorstelling komt in december weer naar de stad.</p></article>
      <article><a href="/nieuws/brug-dicht/"><h3>Brug een week dicht</h3></a><span>23</span> <span>okt</span> <span>2026</span>
        <a href="/nieuws/brug-dicht/">Lees meer</a></article>
      <article><a href="/nieuws/geen-datum/?cb=123">Zonder datum</a></article>
    </main>`;
  const stukken = leesHtmlLijst(html, 'https://www.gemeente.nl/nieuws/', { link: '^/nieuws/[^/]+/?$', vanaf: '<main' });
  assert.deepEqual(stukken.map((s) => [s.titel, s.datum, s.url]), [
    ['Scrooge Live keert terug', '2026-10-28', 'https://www.gemeente.nl/nieuws/scrooge-live/'],
    ['Brug een week dicht', '2026-10-23', 'https://www.gemeente.nl/nieuws/brug-dicht/'],
    ['Zonder datum', null, 'https://www.gemeente.nl/nieuws/geen-datum/'],
  ]);
  assert.match(stukken[0].tekst, /^De voorstelling komt/);
  assert.equal(stukken[2].sleutel, 'https://www.gemeente.nl/nieuws/geen-datum/', 'de cachebuster hoort niet bij de sleutel');
});

test('html-lijst: alleen links in een kop, zonder datums, en de kop boven een kale link', () => {
  const coevorden = `<div><h2><a href="/nieuwe-sporthal">Nieuwe sporthal geopend</a></h2><p>12-10-2026</p>
    <a href="/afval">Afval</a></div>`;
  assert.deepEqual(leesHtmlLijst(coevorden, 'https://www.coevorden.nl/nieuwsoverzicht', { link: '^/[^/]+$', inKop: true }).map((s) => [s.titel, s.datum]),
    [['Nieuwe sporthal geopend', '2026-10-12']]);

  const westerveld = '<a href="/Nieuws/Nieuwsberichten/Okt_2026/Agenda_3_november">Agenda raadsvergadering 3 november 2026</a>';
  assert.equal(leesHtmlLijst(westerveld, 'https://www.westerveld.nl/', { link: '^/Nieuws/', zonderDatum: true })[0].datum, null);

  const dantumadiel = '<h3>Woo-verzoek parkeren Damwâld</h3><p>Besluit en stukken.</p><a href="/woo-parkeren">Meer informatie over dit woo-verzoek</a>';
  assert.equal(leesHtmlLijst(dantumadiel, 'https://www.dantumadiel.frl/', { link: '^/woo-', zonderDatum: true })[0].titel, 'Woo-verzoek parkeren Damwâld');
});

test('html-lijst: één stuk per kop met de eerste pdf eronder (Meppel), en pdf\'s op een ander domein', () => {
  const meppel = `<h4>Woo-besluit bomen Reggersweg</h4><a href="/app/uploads/2026/02/besluit.pdf">Besluit</a><a href="/app/uploads/2026/02/bijlage.pdf">Bijlage</a>
    <h4>Woo-besluit evenementen</h4><a href="/contact">Contact</a><a href="/app/uploads/2026/03/besluit.pdf">Besluit</a>`;
  assert.deepEqual(leesHtmlLijst(meppel, 'https://open.meppel.nl/woo-verzoeken/', { link: '\\.pdf$', perKop: 'h4', zonderDatum: true }).map((s) => [s.sleutel, s.url, s.tekst]), [
    ['woo-besluit bomen reggersweg', 'https://open.meppel.nl/app/uploads/2026/02/besluit.pdf', '2 documenten.'],
    ['woo-besluit evenementen', 'https://open.meppel.nl/app/uploads/2026/03/besluit.pdf', '2 documenten.'],
  ]);
  const terschelling = '<a href="https://cuatro.sim-cdn.nl/terschelling/uploads/Woo-besluit%20fietspad.pdf?cb=99">Woo-besluit fietspad (PDF, 518,5 kB )</a>';
  const [stuk] = leesHtmlLijst(terschelling, 'https://www.terschelling.nl/wet-open-overheid', { link: '^https://cuatro\\.sim-cdn\\.nl/', extern: true, zonderDatum: true });
  assert.deepEqual([stuk.titel, stuk.url], ['Woo-besluit fietspad', 'https://cuatro.sim-cdn.nl/terschelling/uploads/Woo-besluit%20fietspad.pdf']);
});

// ---------- iBabs-agenda ----------

const punt = (id, nummer, titel, bijlagen = []) => `<li><div class="panel panel-default agenda-item" id="${id}" >
  <div class="panel-heading large"><div class="d-flex"><div class="panel-id">${nummer}</div>
  ${bijlagen.length ? `<h3 class="panel-title"><button aria-controls="collapse-${id}"><span class="panel-title-label" >${titel}</span></button></h3>` : `<div class="panel-title"><span class="panel-title-label" >${titel}</span></div>`}
  </div></div>
  ${bijlagen.length ? `<div id="collapse-${id}"><ul class="list-group list-attachments">${bijlagen.map(([doc, naam]) => `<li><a href="/Agenda/Document/aaaaaaaa-0000-0000-0000-000000000000?documentId=${doc}&amp;agendaItemId=${id}" class="unread" data-document-id="${doc}" ><span class="icon pdf"></span>${naam}<span class="badge badge-light badge-pill">609 KB</span></a></li>`).join('')}</ul></div>` : ''}
</div></li>`;
const uuid = (n) => `${String(n).padStart(8, '0')}-1111-2222-3333-444444444444`;

const BORGER = punt(uuid(1), '1', 'Ter kennisname')
  + punt(uuid(2), '1.1', 'E-mail Stichting Kico inzake hervorming jeugdzorg', [[uuid(20), '20260910 e-mail Stichting Kico inzake hervorming jeugdzorg']])
  + punt(uuid(3), '1.2', 'Brief college inzake begraafplaatsenbeleid', [[uuid(30), 'Brief college inzake begraafplaatsenbeleid'], [uuid(31), 'Bijlage 1 - Verslag']])
  + punt(uuid(4), '2', 'Ter afhandeling van het college')
  + punt(uuid(5), '2.1', 'E-mail burger inzake houtkachels', [[uuid(50), '20261005 e-mail burger inzake houtkachels']]);

const SCHIER = punt(uuid(6), '1', 'Opening')
  + punt(uuid(7), '9', 'Lijst van Ingekomen Stukken', [
    [uuid(70), 'Overzicht Lijst van Ingekomen Stukken - 20-10-2026'],
    [uuid(71), '01-01 - VNG - Lbr. 26-032 - Uitnodiging ALV'],
    [uuid(72), '04- 01 - FNV - Aanbiedingsbrief brochure'],
    [uuid(73), '04-02 - Bijl.1 - Leeftijdsvriendelijke gemeente'],
    [uuid(74), 'B&amp;W 01-01 - Besluitenlijst B&amp;W Openbaar - 25-08-2026'],
    [uuid(75), 'B&amp;W 04-01 - Raadsbrief - Aardgasvrij eiland'],
    [uuid(76), 'B&amp;W 04-02 - Bijl.1 - Voortgangsrapportage'],
    [uuid(77), 'B&amp;W 04-03 - Bijl.2 - Memo'],
  ]);

test('iBabs-agenda: de kalender, en een stuk per agendapunt met het kopje als advies (Borger-Odoorn)', () => {
  assert.deepEqual(leesKalender([
    { start: '2026-11-12T19:30:00', title: 'RAAD: Lijst ingekomen stukken', url: `/Agenda/Index/${uuid(9)}`, classNames: ['agendatype-100000044'] },
    { start: '2026-10-08T19:30:00', title: 'RAAD: Lijst ingekomen stukken', url: `/Agenda/Index/${uuid(8)}`, classNames: ['agendatype-100000044'] },
    { start: '2026-10-08T19:30:00', title: 'RAAD: Raadsvergadering', url: `/Agenda/Index/${uuid(7)}`, classNames: ['agendatype-100000006'] },
  ], '100000044').map((a) => [a.id, a.datum]), [[uuid(8), '2026-10-08'], [uuid(9), '2026-11-12']]);

  assert.deepEqual(leesAgendapunten(BORGER).map((p) => [p.nummer, p.kopje, p.bijlagen.length]), [['1', true, 0], ['1.1', false, 1], ['1.2', false, 2], ['2', true, 0], ['2.1', false, 1]]);
  const basis = 'https://borgerodoorn.bestuurlijkeinformatie.nl';
  const stukken = leesIbabsAgenda(BORGER, basis);
  assert.deepEqual(stukken.map((s) => [s.titel, s.datum, s.advies, s.tekst]), [
    ['E-mail Stichting Kico inzake hervorming jeugdzorg', '2026-09-10', 'Ter kennisname', null],
    ['Brief college inzake begraafplaatsenbeleid', null, 'Ter kennisname', 'Met 1 bijlage.'],
    ['E-mail burger inzake houtkachels', '2026-10-05', 'Ter afhandeling van het college', null],
  ]);
  assert.equal(stukken[0].sleutel, uuid(2));
  assert.equal(stukken[0].url, `${basis}/Agenda/Document/aaaaaaaa-0000-0000-0000-000000000000?documentId=${uuid(20)}&agendaItemId=${uuid(2)}`);
  assert.equal(stukken[0].document, `${basis}/Document/View/${uuid(20)}`, 'de pdf, voor de inhoud');
});

test('iBabs-agenda: een stuk per bijlage van één agendapunt, met de bijlagen erbij (Schiermonnikoog)', () => {
  const stukken = leesIbabsAgenda(SCHIER, 'https://schiermonnikoog.bestuurlijkeinformatie.nl', { punt: 'Lijst van Ingekomen Stukken' });
  assert.deepEqual(stukken.map((s) => [s.titel, s.afzender, s.datum, s.tekst]), [
    ['VNG - Lbr. 26-032 - Uitnodiging ALV', 'VNG', null, null],
    ['FNV - Aanbiedingsbrief brochure', 'FNV', null, 'Met 1 bijlage.'],
    ['Besluitenlijst B&W Openbaar - 25-08-2026', 'College van B&W', '2026-08-25', null],
    ['Raadsbrief - Aardgasvrij eiland', 'College van B&W', null, 'Met 2 bijlagen.'],
  ]);
  assert.deepEqual(stukken.map((s) => s.sleutel), [uuid(71), uuid(72), uuid(74), uuid(75)]);
  assert.deepEqual(leesIbabsAgenda(BORGER, 'https://x.bestuurlijkeinformatie.nl', { punt: 'Lijst van Ingekomen Stukken' }), [], 'geen agendapunt: niets');
});

test('iBabs-agenda: ophalen via de kalender, alleen de gekozen vergadersoort', async (t) => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  zetOpenbaarDispatcher(agent);
  t.after(() => zetOpenbaarDispatcher(null));
  const portaal = agent.get('https://borgerodoorn.bestuurlijkeinformatie.nl');
  let gevraagd = null;
  portaal.intercept({ path: (p) => p.startsWith('/Calendar/GetAgendasForCalendar'), method: 'GET' }).reply((opts) => {
    gevraagd = opts.path;
    return { statusCode: 200, data: JSON.stringify([
      { start: '2026-10-08T19:30:00', url: `/Agenda/Index/${uuid(8)}`, classNames: ['agendatype-100000044'] },
      { start: '2026-10-08T19:30:00', url: `/Agenda/Index/${uuid(7)}`, classNames: ['agendatype-100000006'] },
    ]), responseOptions: { headers: { 'content-type': 'application/json' } } };
  });
  portaal.intercept({ path: `/Agenda/Index/${uuid(8)}`, method: 'GET' }).reply(200, BORGER, { headers: { 'content-type': 'text/html' } });
  const stukken = await haalIbabsAgenda({ basis: 'https://borgerodoorn.bestuurlijkeinformatie.nl', agendatype: '100000044' }, { nu: new Date(2026, 9, 30, 12) });
  assert.equal(stukken.length, 3);
  assert.match(gevraagd, /start=2026-08-31T00:00:00&end=2026-12-14T00:00:00$/);
});

// ---------- Woo-platforms ----------

test('Woo-platforms: eData-loket, Divault, publicatieplatform en STACK', () => {
  assert.deepEqual(leesEdataloket({ hits: [{ id: 'f9ef', name: 'Boom Slagdijk', description: 'Kap van een boom', publicationDate: '2026-09-10T00:00:00Z', category: { description: 'Woo-verzoeken en -besluiten' } }] }, 'https://westerveld.edataloket.nl'), [
    { sleutel: 'f9ef', titel: 'Boom Slagdijk', url: 'https://westerveld.edataloket.nl/dossier/f9ef', datum: '2026-09-10', tekst: 'Kap van een boom', soortStuk: 'Woo-verzoeken en -besluiten' },
  ]);
  const [divault] = leesDivault({ records: [{ loc: 'https://woo-oldambt.divault.com/doc=NL-GM1895_Woo-besluit Molenlaan', divault_publication_date: '2026-10-12', Document: { DiWoo: { aggregatiekenmerk: 'NL-GM1895_Woo-besluit Molenlaan', titelcollectie: { officieleTitel: 'Woo-besluit Molenlaan' } } } }] });
  assert.deepEqual([divault.titel, divault.url, divault.datum], ['Woo-besluit Molenlaan', 'https://woo-oldambt.divault.com/doc=NL-GM1895_Woo-besluit%20Molenlaan', '2026-10-12']);
  const [publicatie] = leesPublicaties({ items: [{ id: 'b60e', title: 'Opslagboxen Handelsstraat', publicationDate: '2026-07-01T10:00:00', totalDocuments: 3, category: 'Woo-verzoeken en -besluiten' }] }, 'https://publicaties.stadskanaal.nl');
  assert.deepEqual([publicatie.url, publicatie.datum, publicatie.tekst], ['https://publicaties.stadskanaal.nl/publication/b60e', '2026-07-01', '3 documenten.']);
  const stack = leesStack([{ id: 1, name: '2026-10-26 Woo-verzoek Achter de Brinken 4a in Gasselte', created: '2026-10-27T08:00:00Z' }], 'https://gemeenteaaenhunze.stack.storage/s/eeDnM4VxwESgIUo2/nl');
  assert.deepEqual([stack[0].titel, stack[0].datum], ['Woo-verzoek Achter de Brinken 4a in Gasselte', '2026-10-26']);
});

test('Woo-platforms: Djuma per dossier, Mozard-regels en recent.json per dossier', () => {
  const djuma = leesDjuma([
    { dossier: 19521, title: 'Woo-besluit', datumActueel: '2026-08-20' },
    { dossier: 19521, title: 'Woo-verzoek {[hl]}windpark{[/hl]} Meerstad', datumActueel: '2026-08-25' },
    { dossier: 19600, title: 'Inventarislijst', datumActueel: '2026-07-01' },
  ], 'https://eloket.midden-groningen.nl');
  assert.deepEqual(djuma.map((d) => [d.titel, d.datum]), [['Woo-verzoek windpark Meerstad', '2026-08-25'], ['Inventarislijst (dossier 19600)', '2026-07-01']]);
  assert.equal(djuma[0].url, 'https://eloket.midden-groningen.nl/o/search?q=19521');

  const mozard = leesMozardRegels(`<a href="!suite92.scherm1007?mObj=67364&amp;mSelod=222"><h3>2026-06-25 - Woo-verzoeken - Woo-verzoek WOZ-documenten</h3></a>
    <a href="!suite92.scherm1007?mObj=173407"><h3>Woo-verzoek Holland Casino - 19-07-2024</h3></a>`, 'https://zaakloket.ameland.nl/mozard/');
  assert.deepEqual(mozard.map((m) => [m.sleutel, m.titel, m.datum]), [['67364', 'Woo-verzoek WOZ-documenten', '2026-06-25'], ['173407', 'Woo-verzoek Holland Casino', '2024-07-19']]);

  const recent = leesRecentJson([
    { date: '2026-10-19', title: 'Woo besluit', url: '/woo-publicaties/2026/woo-verzoeken/stedelijk-museum-coevorden-12-2026/besluit.html' },
    { date: '2026-10-12', title: 'Inventarislijst', url: '/woo-publicaties/2026/woo-verzoeken/stedelijk-museum-coevorden-12-2026/inventaris.html' },
  ], 'https://open.coevorden.nl');
  assert.deepEqual(recent.map((r) => [r.titel, r.datum, r.url]), [['Stedelijk museum coevorden', '2026-10-19', 'https://open.coevorden.nl/woo-publicaties/2026/woo-verzoeken/stedelijk-museum-coevorden-12-2026/']]);
});

// ---------- datum bij eerste zicht ----------

test('een pagina zonder datums: de dag van eerste zicht, behalve bij de nulmeting', () => {
  const opslag = new Opslag(mkdtempSync(path.join(tmpdir(), 'rc-test-')));
  const bron = { id: 'westerveld-nieuws', regio: 'westerveld', soort: 'nieuws', datumBijEersteZicht: true };
  const eerste = new Date(2026, 9, 29, 10, 0);
  verwerk(opslag, bron, [{ sleutel: 'oud', titel: 'Al online', datum: null }], eerste);
  assert.equal(opslag.items['westerveld-nieuws:oud'].datum, null, 'wat er al stond, kan van veel eerder zijn');
  opslag.status.bronnen[bron.id] = { ok: true, laatsteSucces: eerste.toISOString() };

  const later = new Date(2026, 9, 30, 9, 0);
  const { nieuw } = verwerk(opslag, bron, [
    { sleutel: 'oud', titel: 'Al online', datum: null },
    { sleutel: 'nieuw', titel: 'Net online', datum: null },
    { sleutel: 'met', titel: 'Met eigen datum', datum: '2026-10-28' },
  ], later);
  assert.deepEqual(nieuw.map((i) => [i.titel, i.datum]), [['Net online', '2026-10-30'], ['Met eigen datum', '2026-10-28']]);
  assert.equal(opslag.items['westerveld-nieuws:oud'].datum, null);

  verwerk(opslag, bron, [{ sleutel: 'nieuw', titel: 'Net online', datum: null }], new Date(2026, 10, 2, 9, 0));
  assert.equal(opslag.items['westerveld-nieuws:nieuw'].datum, '2026-10-30', 'de datum blijft die van de eerste keer');
});
