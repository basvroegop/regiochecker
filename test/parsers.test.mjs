// De parsers tegen echte pagina's, opgeslagen op 20 oktober 2026. Faalt een
// bron in productie, sla dan de nieuwe pagina op in test/fixtures en kijk hier
// wat er anders is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { leesRss } from '../src/bronnen/rss.mjs';
import { leesKolommen, leesRegels, dataTablesVelden } from '../src/bronnen/ibabs.mjs';
import { leesNotubizApi } from '../src/bronnen/notubiz.mjs';
import * as smallingerland from '../src/bronnen/smallingerland.mjs';
import * as swf from '../src/bronnen/sudwestfryslan.mjs';
import { leesGppWoo } from '../src/bronnen/gppwoo.mjs';
import { leesBwBesluiten } from '../src/bronnen/groningen.mjs';
import { leesDatum } from '../src/datum.mjs';
import { hoofdtekst, platteTekst } from '../src/html.mjs';

const fixture = (naam) => readFileSync(new URL(`./fixtures/${naam}`, import.meta.url), 'utf8');

test('RSS van Opsterland (SIM)', () => {
  const items = leesRss(fixture('opsterland-rss.xml'), 'https://www.opsterland.nl/');
  assert.equal(items.length, 25);
  const vuurwerk = items.find((i) => i.titel.startsWith('Vraag uiterlijk 1 november'));
  assert.equal(vuurwerk.url, 'https://www.opsterland.nl/vraag-uiterlijk-1-november-een-vuurwerk-ontheffing-aan');
  assert.equal(vuurwerk.datum, '2026-10-19');
  assert.match(vuurwerk.tekst, /ontheffing/);
  assert.ok(items.every((i) => i.titel && i.sleutel));
});

test('RSS van Heerenveen (WordPress) zonder "verscheen eerst op"', () => {
  const items = leesRss(fixture('heerenveen-rss.xml'), 'https://www.heerenveen.nl/');
  assert.equal(items.length, 10);
  assert.equal(items[0].titel, 'Nieuwe subsidie helpt De Streek verder op weg naar aardgasvrij wonen');
  assert.equal(items[0].datum, '2026-10-15');
  assert.ok(items.every((i) => !/verscheen eerst op/.test(i.tekst || '')));
  assert.ok(!items[0].sleutel.includes('&#038;'));
});

test('iBabs: kolommen uit de pagina en sorteren op datum', () => {
  const kolommen = leesKolommen(fixture('ibabs-details.html'));
  assert.deepEqual(kolommen, ['registrationdate', 'afzender', 'title', 'toelichting']);
  const velden = dataTablesVelden(kolommen, 50);
  assert.equal(velden['order[0][column]'], '0');
  assert.equal(velden['order[0][dir]'], 'desc');
  assert.equal(velden['columns[2][data]'], 'title');
});

test('iBabs: regels van verschillende gemeenten', () => {
  // Heerenveen (soortstuk, datum) en Ooststellingwerf (titel, registrationdate).
  const heerenveen = leesRegels({ data: [{
    DT_RowId: 'ec004fea', identity: '587', soortstuk: 'Plaatselijk Belang / Wijkver.',
    title: 'Brief Plaatselijk Belang Oude- en Nieuwehorne betreffende BOPA-aanvraag Oudehorne',
    afzender: 'Plaatselijk Belang Oude- en Nieuwehorne ', thema: '', locatie: '', datum: '19-10-2026', toelichting: '',
  }] }, 'https://heerenveen.bestuurlijkeinformatie.nl');
  assert.deepEqual(heerenveen[0], {
    sleutel: 'ec004fea',
    titel: 'Brief Plaatselijk Belang Oude- en Nieuwehorne betreffende BOPA-aanvraag Oudehorne',
    url: 'https://heerenveen.bestuurlijkeinformatie.nl/Reports/Item/ec004fea',
    datum: '2026-10-19',
    afzender: 'Plaatselijk Belang Oude- en Nieuwehorne',
    soortStuk: 'Plaatselijk Belang / Wijkver.',
    tekst: null,
  });
  const ost = leesRegels({ data: [{ DT_RowId: '9ca3', registrationdate: '15-10-2026', titel: 'Brief inwoner - antennemast' }, { DT_RowId: 'leeg', registrationdate: null, titel: '' }] }, 'https://x');
  assert.equal(ost.length, 1);
  assert.equal(ost[0].datum, '2026-10-15');
});

test('Notubiz-API: ingekomen stukken Smallingerland', () => {
  const items = leesNotubizApi(JSON.parse(fixture('smallingerland-notubiz-api.json')), 'https://smallingerland.notubiz.nl');
  assert.equal(items.length, 8);
  assert.deepEqual(items.find((i) => i.sleutel === '1208232'), {
    sleutel: '1208232',
    titel: 'Bericht Provinsje Fryslân - Brief BO Leefomgeving',
    url: 'https://smallingerland.notubiz.nl/modules/1/Ingekomen%20stukken/1208232',
    datum: '2026-09-30',
    document: 'https://api.notubiz.nl/document/17483299/1',
    soortStuk: 'Nr. 2026-247',
    advies: 'Voor kennisgeving aannemen',
    afzender: null,
  });

  // Andere gemeenten, andere velden (Pekela: "Datum publicatie", "Nieuw document", "Afzender"); een andere module.
  const pekela = leesNotubizApi({ item: [{ '@attributes': { id: 77 }, attributes: { attribute: [
    { label: 'Onderwerp', value: 'Provincie - Zienswijze ontwerp beheersverordening' },
    { label: 'Afzender', value: 'Provincie Groningen' },
    { label: 'Datum publicatie', value: '2026-10-17 10:33:03' },
    { label: 'Nieuw document', value: { title: 'Zienswijze', url: 'https://api.notubiz.nl/document/123/1' } },
  ] } }] }, 'https://pekela.notubiz.nl', { module: 5, moduleNaam: 'Collegeberichten' });
  assert.deepEqual([pekela[0].datum, pekela[0].document, pekela[0].afzender, pekela[0].url],
    ['2026-10-17', 'https://api.notubiz.nl/document/123/1', 'Provincie Groningen', 'https://pekela.notubiz.nl/modules/5/Collegeberichten/77']);
});

test('Smallingerland: nieuwsarchief en Woo-verzoeken', () => {
  const nieuws = smallingerland.leesNieuws(fixture('smallingerland-nieuws.html'), 'https://www.smallingerland.nl/Nieuwsarchief');
  assert.equal(nieuws[0].titel, 'Bladkooien staan klaar voor het herfstblad');
  assert.equal(nieuws[0].datum, '2026-10-20');
  assert.equal(nieuws[1].titel, 'Drachten maakt ’t: nieuw event voor stad en dorpen');
  assert.ok(nieuws.length >= 50);

  const woo = smallingerland.leesWoo(fixture('smallingerland-woo.html'), 'https://www.smallingerland.nl/Onderwerpen/Klacht_en_bezwaar/Verzoek_informatie_Wet_open_overheid_Woo');
  assert.equal(woo.length, 28);
  assert.ok(woo.some((w) => w.titel === 'WOO-verzoek Locatiecriteria AZC'));
  assert.ok(woo.every((w) => w.url.includes('/Verzoek_informatie_Wet_open_overheid_Woo/')));
});

test('Súdwest-Fryslân: nieuws, Woo-tabel en pdf-links', () => {
  const nieuws = swf.leesNieuws(fixture('swf-nieuws.html'), 'https://sudwestfryslan.nl/publicaties/nieuws');
  assert.equal(nieuws[0].titel, 'Stembureauleden gezocht voor verkiezingen');
  assert.equal(nieuws[0].datum, '2026-10-19');

  const woo = swf.leesWoo(fixture('swf-woo.html'), 'https://sudwestfryslan.nl/onderwerp/woo-verzoeken/');
  assert.ok(woo.length > 150);
  assert.equal(woo[0].titel, 'Voornemen grondverkoop groenstrook tegenover Burenlaan 32 Pingjum');
  assert.equal(woo[0].datum, '2026-08-10');
  assert.equal(new Set(woo.map((w) => w.sleutel)).size, woo.length, 'sleutels moeten uniek zijn');

  const links = swf.leesLijstLinks(fixture('swf-ingekomen.html'), 'https://sudwestfryslan.nl/');
  assert.equal(links[0], 'https://sudwestfryslan.nl/wp-content/uploads/2026/10/Lijst-ingekomen-stukken-Raad-week-42.pdf');
});

test('Súdwest-Fryslân: weeklijst ingekomen stukken uit de pdf', () => {
  const tekst = execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', new URL('./fixtures/swf-week42.pdf', import.meta.url).pathname, '-']).toString();
  const items = swf.leesLijstTekst(tekst, 'https://voorbeeld/lijst.pdf');
  assert.deepEqual(items.map((i) => [i.datum, i.afzender, i.titel]), [
    ['2026-10-09', 'Stichting Lunchwijs', 'Gezonde schoollunches in Súdwest-Fryslân'],
    ['2026-10-09', 'Ontwikkelbedrijven.nl', 'Dashboard Sociale Infrastructuur Súdwest-Fryslân – actuele cijfers en rijksmiddelen'],
    ['2026-10-12', 'Vlasman & Jelsma v.o.f.', 'Grote zorgen over organisatie Sneekweekkermis'],
    ['2026-10-12', 'Alliantie Informele steun Jeugd en Gezin', 'Voorbeeldmotie: Structurele borging van informele steun voor jeugd en gezin'],
    ['2026-10-13', 'Inwoner', 'Teleurstelling over de motie Súdwest-Fryslân grutske lânbougemeente'],
    ['2026-10-14', 'Wise Nederland', 'Small Modular Reactors en kernafval'],
  ]);
});

test('Groningen: nieuwsfeed', () => {
  const items = leesRss(fixture('groningen-rss.xml'), 'https://gemeente.groningen.nl/');
  assert.equal(items.length, 50);
  assert.equal(items[0].titel, 'Sloop gestart op voormalige locatie Holland Casino in binnenstad');
  assert.equal(items[0].url, 'https://gemeente.groningen.nl/sloop-gestart-op-voormalige-locatie-holland-casino-in-binnenstad');
  assert.equal(items[0].datum, '2026-10-20');
});

test('Groningen: B&W-besluiten, alleen de meest recente week', () => {
  const items = leesBwBesluiten(fixture('groningen-bw-besluiten.html'), 'https://gemeente.groningen.nl/bw-besluiten');
  assert.equal(items.length, 13);
  assert.deepEqual(items[0], {
    sleutel: '/file/26-10-06-0-besluitenlijst-6-oktober-2026pdf',
    titel: 'Besluitenlijst 6 oktober 2026',
    url: 'https://gemeente.groningen.nl/file/26-10-06-0-besluitenlijst-6-oktober-2026pdf',
    datum: '2026-10-06',
    soortStuk: 'Besluitenlijst B&W',
  });
  assert.equal(items[4].titel, 'Beantwoording vragen over € 20 miljoen Nij Begun voor WK Wielrennen 2032');
  assert.ok(items.every((i) => i.datum === '2026-10-06'), 'niets uit "Eerdere besluitenlijsten"');
  assert.throws(() => leesBwBesluiten('<html>omgebouwd</html>', 'https://x'), /Meest recente besluiten/);
});

test('Groningen: Woo-publicaties uit GPP-Woo', () => {
  const items = leesGppWoo(JSON.parse(fixture('groningen-woo-zoeken.json')), 'https://open.groningen.nl');
  assert.equal(items.length, 10);
  assert.deepEqual(items[0], {
    sleutel: 'f9a6224a-6fcd-4b2b-9cc5-f96d0fdd2c3b',
    titel: 'Muziekcentrum deelbesluit 1',
    url: 'https://open.groningen.nl/publicaties/f9a6224a-6fcd-4b2b-9cc5-f96d0fdd2c3b',
    datum: '2026-10-19',
    soortStuk: 'Woo-verzoek of -besluit',
    tekst: null,
  });
  assert.deepEqual(leesGppWoo({ results: [{ type: 'document', record: { uuid: 'x', officieleTitel: 'los document' } }] }, 'https://x'), []);
});

test('datums in alle vormen die de bronnen gebruiken', () => {
  assert.equal(leesDatum('20 oktober 2026'), '2026-10-20');
  assert.equal(leesDatum('	02 oktober 2026'), '2026-10-02');
  assert.equal(leesDatum('maandag 19 oktober 2026'), '2026-10-19');
  assert.equal(leesDatum('9-8-2026'), '2026-08-09');
  assert.equal(leesDatum('19-10-2026'), '2026-10-19');
  assert.equal(leesDatum('2026-10-19 14:11:39'), '2026-10-19');
  assert.equal(leesDatum('Mon, 19 Oct 2026 15:47:00 +0200'), '2026-10-19');
  assert.equal(leesDatum('Mon, 19 Oct 2026 23:30:00 +0000'), '2026-10-20'); // 01.30 uur in Nederland
  assert.equal(leesDatum(''), null);
  assert.equal(leesDatum('binnenkort'), null);
});

test('tekst uit HTML', () => {
  assert.equal(platteTekst('<p>Gorredijk &ndash; Bleekersbr&ecirc;ge&nbsp;<b>dicht</b></p>'), 'Gorredijk – Bleekersbrêge dicht');
  assert.equal(hoofdtekst('<header>Menu</header><div class="x" role="main"><h1>Kop</h1><nav>weg</nav><p>Tekst</p></div><footer>voet</footer>'), 'Kop Tekst');
});
