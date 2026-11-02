// Het archief van de gemeenten (src/archief.mjs): het hele overzicht van een
// iBabs-portaal, per pagina; daarna per stuk het document; doorzoekbaar via
// Zoeken en te lezen in het leespaneel, maar niet in de feed.
// node:sqlite zit in Node 22+; op een oudere Node worden deze tests overgeslagen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Opslag } from '../src/opslag.mjs';
import { nieuweGebruiker } from '../src/gebruikers.mjs';

process.env.REGIOCHECKER_PRIVE_ADRESSEN = '1';
const sqlite = await import('node:sqlite').catch(() => null);
const metSqlite = { skip: sqlite ? false : 'node:sqlite niet beschikbaar (Node 22+ nodig)' };

// Een iBabs-portaal met 7 ingekomen stukken uit 2018-2026.
function nepIbabs() {
  const regels = Array.from({ length: 7 }, (_, i) => ({
    DT_RowId: `stuk-${i}`,
    registrationdate: `0${(i % 9) + 1}-03-${2018 + i}`,
    title: i === 2 ? 'Brief over de huisartsenpost in Drachten' : `Ingekomen brief ${i}`,
    afzender: `Afzender ${i}`,
  }));
  const verzoeken = [];
  const server = http.createServer(async (req, res) => {
    let lijf = '';
    for await (const stuk of req) lijf += stuk;
    verzoeken.push(`${req.method} ${req.url}`);
    if (req.url.startsWith('/Reports/Details/')) {
      res.end(`<html><table data-columns='[{"data":"registrationdate"},{"data":"title"},{"data":"afzender"}]'></table></html>`);
    } else if (req.url.startsWith('/Reports/GetReportData/')) {
      const v = new URLSearchParams(lijf);
      const start = Number(v.get('start'));
      const lengte = Number(v.get('length'));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ recordsTotal: regels.length, data: regels.slice(start, start + lengte) }));
    } else if (req.url.startsWith('/Reports/Item/')) {
      const id = req.url.split('/').pop();
      res.end(`<html><main><h1>Stuk ${id}</h1><p>${id === 'stuk-5' ? 'Over het Thialfplein in Heerenveen.' : 'Gewone tekst.'}</p></main></html>`);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  return new Promise((klaar) => server.listen(0, '127.0.0.1', () => klaar({ server, verzoeken, url: `http://127.0.0.1:${server.address().port}` })));
}

test('archief: het hele iBabs-overzicht, documenten, zoeken en lezen; niet in de feed', metSqlite, async () => {
  const { openArchief } = await import('../src/archief.mjs');
  const { openFeedDb } = await import('../src/feeddb.mjs');
  const { zoekFeed, bouwFeed, detail } = await import('../src/feed.mjs');
  const { documentOpVraag } = await import('../src/inhoud.mjs');
  const portaal = await nepIbabs();
  process.env.ARCHIEF_PAUZE_MS = '0';
  try {
    const map = mkdtempSync(path.join(tmpdir(), 'rc-archief-'));
    const opslag = new Opslag(map);
    const fdb = await openFeedDb(path.join(map, 'f.sqlite'));
    opslag.feeddb = fdb;
    opslag.bronnen = [{ id: 'test-ingekomen', naam: 'Smallingerland · Ingekomen (test)', soort: 'ingekomen', type: 'ibabs', bereik: 'regio', regio: 'smallingerland', basis: portaal.url, overzicht: 'abc' }];
    const archief = await openArchief(path.join(map, 'archief.sqlite'), opslag, { map, wacht: async () => {} });
    // Alleen de nagebootste bron: de ingebouwde gemeenten zouden echt het internet op gaan.
    const echteBronnen = archief.bronnen.bind(archief);
    archief.bronnen = () => echteBronnen().filter((b) => b.id === 'test-ingekomen');
    opslag.archief = archief;
    // Eén stuk staat ook al in de feed (de gewone ronde): dat niet dubbel.
    opslag.items['test-ingekomen:stuk-6'] = { sleutel: 'test-ingekomen:stuk-6', bron: 'test-ingekomen', regio: 'smallingerland', soort: 'ingekomen', titel: 'Ingekomen brief 6', url: `${portaal.url}/Reports/Item/stuk-6`, datum: '2024-07-03', eersteGezien: new Date().toISOString(), basislijn: false };

    // De lijst, in pagina's van drie.
    const { haalIbabsAlles } = await import('../src/bronnen/ibabs.mjs');
    assert.equal((await haalIbabsAlles(opslag.bronnen[0], { per: 3, pauze: 0 })).length, 7);
    assert.equal(portaal.verzoeken.filter((v) => v.startsWith('POST')).length, 3, 'drie pagina\'s');
    assert.equal(await archief.stap(), 0);
    let st = archief.status();
    assert.deepEqual([st.totaal, st.metTekst, st.wachtrij, st.gelezen, st.bronnen, st.oudste], [7, 0, 7, 1, 1, '2018-03-01']);
    // Dan de documenten, per portaal tien per keer.
    await archief.stap();
    st = archief.status();
    assert.deepEqual([st.metTekst, st.wachtrij, st.bezig], [7, 0, 'documenten']);
    assert.equal(await archief.stap(), 3600_000, 'bij: over een uur weer kijken');
    assert.equal(archief.status().bezig, 'bij');

    // Zoeken: op titel en op de tekst van het document; nieuwste eerst.
    assert.deepEqual(archief.zoek('huisartsenpost').map((r) => r.sleutel), ['test-ingekomen:stuk-2']);
    assert.deepEqual(archief.zoek('Thialfplein').map((r) => r.sleutel), ['test-ingekomen:stuk-5']);
    assert.match(archief.zoek('Thialfplein')[0].fragment, /\u0001Thialfplein\u0002/);
    assert.equal(archief.zoek('brief').length, 7);
    assert.equal(archief.zoek('kapot AND (').length, 0, 'foute syntax: losse woorden');

    // In Zoeken van de webUI, op de eigen datum, en het stuk uit de feed niet dubbel.
    const ctx = { opslag, kdb: null, fdb };
    const sanne = nieuweGebruiker(opslag.instellingen, { naam: 'Sanne', email: 'sanne@lc.nl', regios: ['smallingerland'] });
    opslag.gebruikers.push(sanne);
    const z = zoekFeed(ctx, sanne, 'brief').items;
    assert.equal(z.length, 7);
    assert.equal(z.filter((i) => i.id === 'i:test-ingekomen:stuk-6').length, 1);
    const oud = z.find((i) => i.id === 'i:test-ingekomen:stuk-0');
    assert.deepEqual([oud.tijd, oud.groep, oud.regioNaam], ['2018-03-01T12:00:00.000Z', 'ingekomen', 'Smallingerland']);
    // Niet in de feed: alleen het stuk dat er al in stond.
    assert.deepEqual(bouwFeed(ctx, sanne).items.map((i) => i.id), ['i:test-ingekomen:stuk-6']);

    // Lezen: het document uit het archief.
    const d = detail(ctx, sanne, 'i:test-ingekomen:stuk-5');
    assert.equal(d.titel, 'Ingekomen brief 5');
    assert.ok(d.document.blokken.some(([, t]) => /Thialfplein/.test(t)));
    // Een stuk zonder document haalt het leespaneel op, en bewaart het in het archief.
    archief.db.prepare("UPDATE stukken SET status = NULL, blokken = NULL WHERE sleutel = 'test-ingekomen:stuk-3'").run();
    const doc = await documentOpVraag(opslag, 'test-ingekomen:stuk-3');
    assert.ok(doc.blokken.length);
    assert.ok(archief.documentVan('test-ingekomen:stuk-3'));

    // Schijfbewaking.
    process.env.ARCHIEF_MIN_VRIJ_GB = '100000000';
    assert.equal(await archief.stap(), 3600_000);
    assert.match(archief.status().gestopt, /^minder dan 100000000 GB vrij/);
  } finally {
    delete process.env.ARCHIEF_PAUZE_MS;
    delete process.env.ARCHIEF_MIN_VRIJ_GB;
    portaal.server.close();
  }
});

test('archief: welke bronnen, de B&W-pagina van Groningen, en pagina voor pagina tot het op is', async () => {
  const { heeftArchief } = await import('../src/archief.mjs');
  const { leesBwBesluitenAlles } = await import('../src/bronnen/groningen.mjs');
  const { haalEdataloketAlles } = await import('../src/bronnen/woo.mjs');
  const { zetOpenbaarDispatcher } = await import('../src/netwerk.mjs');
  const { MockAgent } = await import('undici');
  // Ingekomen stukken en Woo, op elk platform met een lijst; nieuws niet (RSS gaat niet terug).
  assert.equal(heeftArchief({ soort: 'woo', type: 'edataloket' }), true);
  assert.equal(heeftArchief({ soort: 'ingekomen', type: 'ibabs-agenda' }), true);
  assert.equal(heeftArchief({ soort: 'woo', type: 'html-lijst' }), true);
  assert.equal(heeftArchief({ soort: 'nieuws', type: 'html-lijst' }), false);
  assert.equal(heeftArchief({ soort: 'nieuws', type: 'rss' }), false);
  assert.equal(heeftArchief({ soort: 'woo', type: 'ontbreekt' }), false);

  // Groningen: ook de eerdere besluitenlijsten; dezelfde lijst onder twee links één keer.
  const pagina = `<h2>Meest recente besluiten</h2><section>
    <a href="/file/26-10-27-0-besluitenlijst-27-oktober-2026pdf"><span class="filename">26-10-27 0. Besluitenlijst 27 oktober 2026.pdf</span></a>
    <a href="/file/26-10-27-2-beantw-vragen-groenpdf"><span class="filename">26-10-27 2. Beantw vragen over groen.pdf</span></a></section>
    <h2>Eerdere besluitenlijsten</h2>
    <a href="/file/besluitenlijst-27-oktober-2026pdf"><span class="filename">Besluitenlijst 27 oktober 2026.pdf</span></a>
    <a href="/file/besluitenlijst-20-oktober-2026pdf"><span class="filename">Besluitenlijst 20 oktober 2026.pdf</span></a>`;
  assert.deepEqual(leesBwBesluitenAlles(pagina, 'https://gemeente.groningen.nl/bw-besluiten').map((i) => [i.titel, i.datum]), [
    ['Besluitenlijst 27 oktober 2026', '2026-10-27'],
    ['Beantwoording vragen over groen', '2026-10-27'],
    ['Besluitenlijst 20 oktober 2026', '2026-10-20'],
  ]);

  // eData-loket pagina voor pagina; een platform dat het paginanummer negeert, eindigt na de herhaling.
  const internet = new MockAgent();
  internet.disableNetConnect();
  const hit = (id) => ({ id: `d${id}`, name: `Besluit ${id}`, publicationDate: '2024-05-01' });
  const pool = internet.get('https://woo.voorbeeld.nl');
  pool.intercept({ path: /page=1&/, method: 'GET' }).reply(200, { hits: Array.from({ length: 100 }, (_, i) => hit(i)) });
  pool.intercept({ path: /page=2&/, method: 'GET' }).reply(200, { hits: Array.from({ length: 100 }, (_, i) => hit(100 + i)) });
  pool.intercept({ path: /page=3&/, method: 'GET' }).reply(200, { hits: Array.from({ length: 100 }, (_, i) => hit(100 + i)) });
  const vorige = zetOpenbaarDispatcher(internet);
  try {
    const alles = await haalEdataloketAlles({ url: 'https://woo.voorbeeld.nl/' }, { pauze: 0 });
    assert.equal(alles.length, 200);
    assert.equal(alles.at(-1).titel, 'Besluit 199');
  } finally {
    zetOpenbaarDispatcher(vorige);
  }
});
