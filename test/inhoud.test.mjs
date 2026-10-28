// De inhoud achter de links, tegen een nagebootste server: een artikel met een
// pdf-bijlage, een iBabs-stuk met bijlagen, het GPP-Woo-portaal en een
// Notubiz-document. Als pdf dient de echte weeklijst van Súdwest-Fryslân.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inhoudVoor, vulInhoud, pdfLinks, ibabsDocumenten } from '../src/inhoud.mjs';
import { Opslag } from '../src/opslag.mjs';

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
