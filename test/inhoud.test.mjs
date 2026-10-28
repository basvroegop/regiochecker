// De inhoud achter de links, tegen een nagebootste server: een artikel met een
// pdf-bijlage, een iBabs-stuk met bijlagen, het GPP-Woo-portaal en een
// Notubiz-document. Als pdf dient de echte weeklijst van Súdwest-Fryslân.
// Daarnaast het hele document met zijn opmaak, voor het leespaneel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inhoudVoor, vulInhoud, pdfLinks, ibabsDocumenten, documentOpVraag } from '../src/inhoud.mjs';
import { htmlBlokken, tekstBlokken, platVan, begrens } from '../src/document.mjs';
import { Opslag } from '../src/opslag.mjs';
import { hoofdHtml } from '../src/html.mjs';

const sqlite = await import('node:sqlite').catch(() => null);
const metSqlite = { skip: sqlite ? false : 'node:sqlite niet beschikbaar (Node 22+ nodig)' };

const PDF = readFileSync(new URL('./fixtures/swf-week42.pdf', import.meta.url));
const DOC = '6ec7a7bc-aef9-4a7f-9194-922c4b8652e1';
const BIJLAGE = 'b6912b63-99b1-4b26-8f17-103eb2daa9ed';

async function nepServer() {
  const opgevraagd = [];
  const server = http.createServer((req, res) => {
    opgevraagd.push(req.url);
    const pdf = () => { res.setHeader('Content-Type', 'application/pdf'); res.end(PDF); };
    const html = (h) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(h); };
    const json = (j) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(j)); };
    switch (req.url.split('?')[0]) {
      case '/artikel':
        return html('<html><nav><a href="/menu.pdf">menu</a></nav><main><h1>Brug dicht</h1><p>De Bleekersbrêge is 2 weken dicht.</p><a href="/bijlage.pdf">Omleiding</a></main><footer>voet</footer></html>');
      case '/bijlage.pdf': case '/los.pdf': case `/Document/View/${DOC}`: case `/Document/View/${BIJLAGE}`: case '/api/v2/documenten/besluit/download': case '/notubiz/doc':
        return pdf();
      case '/Reports/Item/abc':
        return html(`<html><body><h1>Brief inwoner</h1><a href="/Reports/Document/abc?documentId=${DOC}">Brief</a><a href="/Reports/Document/abc?documentId=${BIJLAGE}">Bijlage 1</a></body></html>`);
      case '/api/v2/publicaties/pub1':
        return json({ uuid: 'pub1', omschrijving: 'Verzoek om stukken over de kiosk.' });
      case '/api/v2/documenten':
        return json({ results: [
          { uuid: 'verzoek', officieleTitel: 'Woo-verzoek', bestandsnaam: 'Woo-verzoek.pdf' },
          { uuid: 'besluit', officieleTitel: 'Woo-besluit', bestandsnaam: 'Woo-besluit.pdf' },
          { uuid: 'lijst', officieleTitel: 'Inventaris', bestandsnaam: 'inventaris.xlsx' },
        ] });
      default:
        res.statusCode = 404;
        return res.end('niet gevonden');
    }
  });
  await new Promise((klaar) => server.listen(0, '127.0.0.1', klaar));
  return { server, opgevraagd, basis: `http://127.0.0.1:${server.address().port}` };
}

test('pdf-links alleen uit het hoofdgedeelte, iBabs-bijlagen naar de echte pdf', () => {
  const pagina = '<nav><a href="/menu.pdf">x</a></nav><main><a href="/a.pdf">a</a><a href="/b.PDF?v=2">b</a><a href="/a.pdf">dubbel</a></main>';
  assert.deepEqual(pdfLinks(pagina, 'https://x.nl/p'), ['https://x.nl/a.pdf', 'https://x.nl/b.PDF?v=2']);
  assert.deepEqual(
    ibabsDocumenten(`<a href="/Reports/Document/abc?documentId=${DOC}">`, 'https://heerenveen.bestuurlijkeinformatie.nl'),
    [`https://heerenveen.bestuurlijkeinformatie.nl/Document/View/${DOC}`],
  );
});

test('inhoud per soort bron', async () => {
  const nep = await nepServer();
  try {
    const artikel = await inhoudVoor({ url: `${nep.basis}/artikel` }, { type: 'rss' });
    assert.match(artikel, /^Brug dicht De Bleekersbrêge is 2 weken dicht\. Omleiding \|\| .*Stichting Lunchwijs/);
    assert.ok(!nep.opgevraagd.includes('/menu.pdf'), 'geen pdf uit het menu');

    assert.match(await inhoudVoor({ url: `${nep.basis}/los.pdf` }, { type: 'groningen-bw-besluiten' }), /Gezonde schoollunches/);

    const ibabs = await inhoudVoor({ url: `${nep.basis}/Reports/Item/abc` }, { type: 'ibabs' });
    assert.match(ibabs, /Lunchwijs.*\|\| .*Lunchwijs/, 'brief en eerste bijlage');
    assert.ok(nep.opgevraagd.includes(`/Document/View/${DOC}`));

    const woo = await inhoudVoor({ url: `${nep.basis}/publicaties/pub1` }, { type: 'gpp-woo', basis: nep.basis });
    assert.match(woo, /^Verzoek om stukken over de kiosk\. \|\| .*Lunchwijs/);
    assert.equal(nep.opgevraagd.filter((u) => u.includes('/download'))[0], '/api/v2/documenten/besluit/download', 'het besluit eerst');

    assert.match(await inhoudVoor({ url: 'https://portaal/1', document: `${nep.basis}/notubiz/doc` }, { type: 'notubiz-ingekomen' }), /Wise Nederland/);
    assert.equal(await inhoudVoor({ url: 'https://x' }, { type: 'swf-woo', inhoud: false }), null);
  } finally {
    nep.server.close();
  }
});

test('na een verzamelronde: recente berichten krijgen inhoud, de rest niet', async () => {
  const nep = await nepServer();
  try {
    const opslag = new Opslag(mkdtempSync(path.join(tmpdir(), 'rc-test-')));
    const nu = new Date('2026-10-26T10:00:00Z');
    const zet = (sleutel, extra) => {
      opslag.items[sleutel] = { sleutel, bron: 'groningen-nieuws', regio: 'groningen', soort: 'nieuws', titel: sleutel, url: `${nep.basis}/artikel`, eersteGezien: '2026-10-25T10:00:00.000Z', basislijn: false, ...extra };
    };
    zet('nieuw');
    zet('basislijn', { basislijn: true });
    zet('te-oud', { eersteGezien: '2026-10-01T10:00:00.000Z' });
    zet('swf', { bron: 'sudwestfryslan-woo' });
    zet('kapot', { url: `${nep.basis}/bestaat-niet` });
    zet('oude-inhoud', { eersteGezien: '2026-09-01T10:00:00.000Z', inhoud: 'oud' });

    const uitkomst = await vulInhoud(opslag, { nu });
    assert.deepEqual(uitkomst, { gevuld: 1, mislukt: 1 });
    assert.match(opslag.items.nieuw.inhoud, /Bleekersbrêge/);
    for (const k of ['basislijn', 'te-oud', 'swf']) assert.equal(opslag.items[k].inhoud, undefined, k);
    assert.equal(opslag.items.kapot.inhoudPogingen, 1);
    assert.match(opslag.items.kapot.inhoudFout, /404/);
    assert.equal(opslag.items['oude-inhoud'].inhoud, undefined, 'inhoud na vijf weken opgeruimd');

    // Na drie mislukte pogingen geven we het op.
    await vulInhoud(opslag, { nu });
    await vulInhoud(opslag, { nu });
    assert.deepEqual(await vulInhoud(opslag, { nu }), { gevuld: 0, mislukt: 0 });
    assert.equal(opslag.items.kapot.inhoudPogingen, 3);
  } finally {
    nep.server.close();
  }
});

test('document: koppen, alinea\'s en opsommingen uit HTML en uit pdf-regels', () => {
  assert.deepEqual(htmlBlokken('<h1>Brug <em>dicht</em></h1><p>De Bleekers<strong>brêge</strong> is 2 weken dicht.</p><ul><li><p>Omleiding via de N31</p></li><li>Fietsers kunnen er langs</li></ul><p>Postbus 1<br>9200 AA Drachten</p><script>weg()</script>'), [
    ['k', 'Brug dicht'],
    ['p', 'De Bleekersbrêge is 2 weken dicht.'],
    ['l', 'Omleiding via de N31'],
    ['l', 'Fietsers kunnen er langs'],
    ['p', 'Postbus 1\n9200 AA Drachten'],
  ]);

  // Zoals pdftotext het geeft: regels van de pagina, een kop, een opsommingsteken
  // op een eigen regel, een paginanummer, en alinea's zonder witregel ertussen.
  const regel = 'woorden die de regel vullen tot aan de rechterkantlijn van de pagina, zoals in een brief';
  const pdf = [
    'Aan de gemeenteraad', '', 'Drachten, 6 oktober 2026', '',
    'Compensatie maatschappelijke organisaties',
    `Op 28 oktober besloot u de heffing te wijzigen; ${regel}`, regel, 'en dat is de laatste regel van de eerste alinea.',
    `In de raadsbrief van 21 oktober is een aanpak ${regel}`, 'die in samenhang werkt.',
    '•', `Een subsidieregeling voor lokale organisaties ${regel}`, 'met een maatschappelijk belang.',
    '•', 'Een verduurzamingsregeling.', '2', '\f',
    `Ad 2. De verduurzamingsregeling richt zich op vastgoed ${regel}`, 'en is nog niet gereed.',
  ].join('\n');
  const b = tekstBlokken(pdf);
  assert.deepEqual(b.map(([s, t]) => [s, t.slice(0, 40)]), [
    ['p', 'Aan de gemeenteraad\nDrachten, 6 oktober '],
    ['k', 'Compensatie maatschappelijke organisatie'],
    ['p', 'Op 28 oktober besloot u de heffing te wi'],
    ['p', 'In de raadsbrief van 21 oktober is een a'],
    ['l', 'Een subsidieregeling voor lokale organis'],
    ['l', 'Een verduurzamingsregeling.'],
    ['p', 'Ad 2. De verduurzamingsregeling richt zi'],
  ]);
  assert.match(b[2][1], /rechterkantlijn van de pagina, zoals in een brief woorden die/, 'regels van één alinea aan elkaar');
  assert.match(b[2][1], /eerste alinea\.$/);

  // Een Word-document of een al platgeslagen tekst: elke regel is een alinea.
  const lang = 'Het Presidium legt hierbij aan u voor een voorstel van de vaste commissie voor Digitale Zaken om een onderzoek te laten verrichten. ';
  assert.deepEqual(tekstBlokken(`${lang.repeat(2)}\n${lang.repeat(2)}\nKort slot.`).map(([s]) => s), ['p', 'p', 'p']);

  assert.equal(platVan([['p', 'Brief'], ['d', 'Bijlage 1'], ['k', 'Kop'], ['p', 'tekst']]), 'Brief || Kop tekst');
  assert.ok(!tekstBlokken('Uw kenmerk\n-\n\nBehandeld door\nJ. Lukkes').some(([soort]) => soort === 'l'), 'een los streepje met een witregel erna is geen opsomming');
  assert.deepEqual(htmlBlokken(hoofdHtml('<nav>menu</nav><main><div id="breadcrumb-container"><ul class="breadcrumbs"><li><a href="/">Home</a></li></ul></div><h1>Titel</h1><p>Tekst.</p></main>')), [['k', 'Titel'], ['p', 'Tekst.']], 'zonder kruimelpad');
  const groot = begrens([['p', 'a'.repeat(400)], ['p', `${'b '.repeat(200)}`]], 700);
  assert.equal(groot.volledig, false);
  assert.equal(groot.blokken.length, 2);
  assert.match(groot.blokken[1][1], /^b( b)+…$/, 'afgekapt op een woordgrens');
});

test('het hele document: bewaard na een verzamelronde, en op verzoek voor een ouder stuk', metSqlite, async () => {
  const nep = await nepServer();
  try {
    const { openFeedDb } = await import('../src/feeddb.mjs');
    const map = mkdtempSync(path.join(tmpdir(), 'rc-test-'));
    const opslag = new Opslag(map);
    opslag.feeddb = await openFeedDb(path.join(map, 'regiochecker.sqlite'));
    const nu = new Date('2026-10-26T10:00:00Z');
    const zet = (sleutel, extra) => {
      opslag.items[sleutel] = { sleutel, bron: 'groningen-nieuws', regio: 'groningen', soort: 'nieuws', titel: sleutel, url: `${nep.basis}/artikel`, eersteGezien: '2026-10-25T10:00:00.000Z', basislijn: false, ...extra };
    };
    zet('nieuw');
    zet('al-inhoud', { eersteGezien: '2026-10-01T10:00:00.000Z', inhoud: 'plat' });
    zet('basislijn', { basislijn: true });
    zet('weggehaald', { url: `${nep.basis}/bestaat-niet`, inhoud: 'Tekst van toen.' });
    opslag.feeddb.zetDocument('verdwenen', { blokken: [['p', 'x']], volledig: true });

    assert.deepEqual(await vulInhoud(opslag, { nu }), { gevuld: 2, mislukt: 1 }, 'ook een ouder bericht met inhoud krijgt zijn document');
    assert.equal(opslag.items.weggehaald.verdwenen, nu.toISOString(), '404: door de bron weggehaald');
    assert.equal(opslag.items.weggehaald.inhoud, 'Tekst van toen.', 'de tekst van eerder blijft');
    assert.equal(opslag.items.nieuw.verdwenen, undefined);
    const doc = opslag.feeddb.document('nieuw');
    assert.deepEqual(doc.blokken.slice(0, 3), [['k', 'Brug dicht'], ['p', 'De Bleekersbrêge is 2 weken dicht.'], ['p', 'Omleiding']]);
    assert.deepEqual(doc.blokken[3], ['d', 'Omleiding'], 'de bijlage met de linktekst als naam');
    assert.ok(doc.blokken.length > 10, 'de hele pdf, niet alleen het begin');
    assert.equal(doc.volledig, true);
    assert.match(opslag.items.nieuw.inhoud, /^Brug dicht De Bleekersbrêge/);
    assert.equal(opslag.feeddb.document('verdwenen'), null, 'opgeruimd met het item');
    assert.equal(opslag.feeddb.heeftDocument('basislijn'), false);

    // Het leespaneel vraagt het document van de basislijn op; twee keer tegelijk is één keer ophalen.
    const voor = nep.opgevraagd.length;
    const [een, twee] = await Promise.all([documentOpVraag(opslag, 'basislijn'), documentOpVraag(opslag, 'basislijn')]);
    assert.deepEqual(een, twee);
    assert.equal(nep.opgevraagd.slice(voor).filter((u) => u === '/artikel').length, 1);
    assert.deepEqual(opslag.feeddb.document('basislijn').blokken[0], ['k', 'Brug dicht']);
    assert.equal(documentOpVraag(opslag, 'bestaat-niet'), null);
    delete opslag.items.weggehaald.verdwenen;
    await assert.rejects(documentOpVraag(opslag, 'weggehaald', { nu }), /HTTP 404/);
    assert.equal(opslag.items.weggehaald.verdwenen, nu.toISOString(), 'ook bij openen in het leespaneel');
  } finally {
    nep.server.close();
  }
});
