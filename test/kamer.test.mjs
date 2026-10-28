// Kamerstukken: tekst uit docx/pdf, de database met zoekindex, het bijhouden
// tegen een nagebootste Kamer-API, meldingen en het kopje in de regiomail.
// node:sqlite zit in Node 22+; op een oudere Node worden deze tests overgeslagen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { docxXmlNaarTekst, stukNaarTekst } from '../src/kamer/tekst.mjs';
import { Opslag } from '../src/opslag.mjs';

const sqlite = await import('node:sqlite').catch(() => null);
const metSqlite = { skip: sqlite ? false : 'node:sqlite niet beschikbaar (Node 22+ nodig)' };

const DOCX = readFileSync(new URL('./fixtures/kamer-brief.docx', import.meta.url));
const PDF = readFileSync(new URL('./fixtures/swf-week42.pdf', import.meta.url));
const tijdelijk = () => mkdtempSync(path.join(tmpdir(), 'rc-kamer-'));

test('tekst uit Word en pdf', async () => {
  assert.equal(docxXmlNaarTekst('<w:p><w:r><w:t>Geachte</w:t></w:r><w:r><w:tab/><w:t>voorzitter &amp; leden</w:t></w:r></w:p><w:p><w:r><w:t>Tweede</w:t></w:r></w:p>'), 'Geachte voorzitter & leden\nTweede');
  const brief = await stukNaarTekst(DOCX, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.match(brief, /^Geachte voorzitter,/);
  assert.match(brief, /Regionale bereikbaarheid is voor mij dan ook een grote prioriteit/);
  assert.match(await stukNaarTekst(PDF, 'application/pdf'), /Stichting Lunchwijs/);
  assert.equal(await stukNaarTekst(Buffer.from('GIF89a'), 'image/gif'), null);
});

function stuk(id, extra = {}) {
  return { id, nummer: `2026D${id}`, soort: 'Brief regering', titel: 'Mobiliteitsbeleid', onderwerp: `Onderwerp ${id}`, datum: '2026-10-20', vergaderjaar: '2026-2027', dossier: '31305', dossiertitel: 'Mobiliteitsbeleid', zaak: `2026Z${id}`, afzender: 'A.W.H. Bertram', contenttype: 'application/pdf', gewijzigd: '2026-10-20T10:00:00Z', ...extra };
}

test('database: zoeken zonder accenten, fragmenten, termen alleen als heel woord', metSqlite, async () => {
  const { openKamerDb, stukUrl, MARK_BEGIN } = await import('../src/kamer/db.mjs');
  const kdb = await openKamerDb(path.join(tijdelijk(), 'k.sqlite'));
  kdb.bewaarStuk(stuk('1'));
  kdb.bewaarStuk(stuk('2', { titel: 'Waddenzee', zaak: null, datum: '2026-09-01' }));
  kdb.bewaarStuk(stuk('3'));
  const [a, b, c] = kdb.wachtrij(10, 3).sort((x, y) => x.id.localeCompare(y.id));
  kdb.bewaarTekst(a.nr, 'De N381 bij Bakkeveen en de provincie Fryslân krijgen geld voor de busverbinding naar Drachten.', new Date('2026-10-21T10:00:00Z'));
  kdb.bewaarTekst(b.nr, 'Geen nieuws over de Wadden. Wel over de tegenhoudharen.', new Date('2026-10-21T10:00:00Z'));
  kdb.bewaarTekst(c.nr, null, new Date('2026-10-21T10:00:00Z'));
  assert.equal(kdb.wachtrij(10, 3).length, 0);

  const r = kdb.zoek({ vraag: 'fryslan' });
  assert.equal(r.totaal, 1);
  assert.ok(r.rijen[0].fragment.includes(`${MARK_BEGIN}Fryslân`));
  assert.equal(kdb.zoek({ vraag: 'bus*' }).totaal, 1, 'voorvoegsel');
  assert.equal(kdb.zoek({ vraag: '"de provincie fryslan"' }).totaal, 1, 'woordgroep');
  const kapot = kdb.zoek({ vraag: 'Drachten AND (' });
  assert.equal(kapot.aangepast, true);
  assert.equal(kapot.totaal, 1, 'bij foute syntax zoeken op de losse woorden');
  assert.equal(kdb.zoek({ vraag: '', van: '2026-10-01' }).totaal, 2, 'alleen filters');
  assert.equal(kdb.zoek({ vraag: 'mobiliteitsbeleid', soort: 'Motie' }).totaal, 0);

  const treffers = kdb.treffers(['Bakkeveen', 'haren', 'Súdwest-Fryslân'], { sinds: '2026-10-21T00:00:00Z', minDatum: '2026-10-01' });
  assert.equal(treffers.length, 1);
  assert.deepEqual(treffers[0].gevonden.map((g) => g.term), ['Bakkeveen']);
  assert.equal(kdb.treffers(['Bakkeveen'], { sinds: '2026-10-22T00:00:00Z' }).length, 0, 'alleen wat na sinds binnenkwam');
  assert.equal(kdb.treffers(['Wadden'], { sinds: '2026-10-21T00:00:00Z', minDatum: '2026-10-01' }).length, 0, 'te oud stuk telt niet als nieuw');
  assert.deepEqual(kdb.telTermen(['Bakkeveen', 'Ureterp'], 3650), [{ term: 'Bakkeveen', aantal: 1 }, { term: 'Ureterp', aantal: 0 }]);

  assert.equal(stukUrl(a), 'https://www.tweedekamer.nl/kamerstukken/detail?id=2026Z1&did=2026D1');
  assert.equal(stukUrl(b), 'https://www.tweedekamer.nl/downloads/document?id=2');

  // Nieuwe versie van een stuk: tekst opnieuw ophalen. Verwijderd: eruit.
  kdb.bewaarStuk(stuk('1', { gewijzigd: '2026-10-25T10:00:00Z' }));
  assert.equal(kdb.wachtrij(10, 3).length, 1);
  assert.equal(kdb.verwijderStuk('3'), true);
  assert.equal(kdb.status().totaal, 2);
  kdb.sluit();
});

async function nepKamer() {
  const verzoeken = [];
  const docs = [
    { Id: 'a', DocumentNummer: '2026D1', Soort: 'Brief regering', Titel: 'Mobiliteitsbeleid', Onderwerp: 'Routeplan regionale bereikbaarheid', Datum: '2026-10-06T00:00:00+02:00', Vergaderjaar: '2026-2027', ContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', GewijzigdOp: '2026-10-27T14:06:06+01:00', ApiGewijzigdOp: '2026-10-27T13:06:28.4569363Z', Verwijderd: false, Kamerstukdossier: [{ Nummer: 31305, Toevoeging: null, Titel: 'Mobiliteitsbeleid' }], Zaak: [{ Nummer: '2026Z21147' }], DocumentActor: [{ ActorNaam: 'A.W.H. Bertram', Functie: 'staatssecretaris van Infrastructuur en Waterstaat' }] },
    { Id: 'b', DocumentNummer: '2026D2', Soort: 'Bijlage', Titel: 'Ingekomen stukken', Onderwerp: 'Lijst', Datum: '2026-10-07T00:00:00+02:00', ContentType: 'application/pdf', GewijzigdOp: '2026-10-27T14:07:00+01:00', ApiGewijzigdOp: '2026-10-27T13:07:00Z', Verwijderd: false, Kamerstukdossier: [], Zaak: [], DocumentActor: [] },
    { Id: 'c', DocumentNummer: '2026D3', Soort: 'Motie', Titel: 'Weg', Onderwerp: 'Weg', Datum: '2026-10-07T00:00:00+02:00', ApiGewijzigdOp: '2026-10-27T13:08:00Z', Verwijderd: true, Kamerstukdossier: [], Zaak: [], DocumentActor: [] },
  ];
  const server = http.createServer((req, res) => {
    verzoeken.push(decodeURIComponent(req.url));
    if (req.url.startsWith('/Document?')) {
      const skip = Number(new URL(req.url, 'http://x').searchParams.get('$skip'));
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ value: skip ? [] : docs }));
    }
    if (req.url === '/Document(a)/resource') return res.end(DOCX);
    if (req.url === '/Document(b)/resource') return res.end(PDF);
    res.statusCode = 404;
    res.end();
  });
  await new Promise((klaar) => server.listen(0, '127.0.0.1', klaar));
  return { server, verzoeken, basis: `http://127.0.0.1:${server.address().port}` };
}

function nepSmtp() {
  const ontvangen = [];
  const server = net.createServer((sok) => {
    let buffer = '';
    let inData = false;
    let data = '';
    sok.write('220 nep\r\n');
    sok.on('data', (d) => {
      buffer += d;
      let i;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const regel = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (inData) {
          if (regel === '.') { inData = false; ontvangen.push(data); data = ''; sok.write('250 ok\r\n'); } else data += `${regel}\n`;
          continue;
        }
        const o = regel.slice(0, 4).toUpperCase();
        if (o === 'DATA') { inData = true; sok.write('354 ga\r\n'); } else if (o === 'QUIT') { sok.end('221 doei\r\n'); } else sok.write('250 ok\r\n');
      }
    });
  });
  return new Promise((klaar) => server.listen(0, '127.0.0.1', () => klaar({ server, ontvangen, poort: server.address().port })));
}

test('bijhouden, meldingen en het kopje in de regiomail', metSqlite, async () => {
  const kamer = await nepKamer();
  const smtp = await nepSmtp();
  process.env.KAMERSTUKKEN_API = kamer.basis;
  try {
    const { openKamerDb } = await import('../src/kamer/db.mjs');
    const { synchroniseer, haalTeksten, zetOm } = await import('../src/kamer/ophalen.mjs');
    const { verwerkMeldingen } = await import('../src/kamer/meldingen.mjs');
    const { stelMailSamen } = await import('../src/mail.mjs');

    assert.deepEqual({ ...zetOm({ Id: 'x', Datum: '2026-10-06T00:00:00+02:00', Kamerstukdossier: [{ Nummer: 36600, Toevoeging: 'XII', Titel: 'Begroting' }], DocumentActor: [{ ActorNaam: 'Jansen', ActorFractie: 'CDA' }] }), gewijzigd: undefined },
      { id: 'x', nummer: null, soort: null, titel: '', onderwerp: '', datum: '2026-10-06', vergaderjaar: null, dossier: '36600-XII', dossiertitel: 'Begroting', zaak: null, afzender: 'Jansen, CDA', contenttype: null, gewijzigd: undefined });

    const map = tijdelijk();
    const opslag = new Opslag(map);
    const kdb = await openKamerDb(path.join(map, 'k.sqlite'));
    opslag.kamer = kdb;

    const sync = await synchroniseer(kdb);
    assert.deepEqual(sync, { nieuw: 2, bijgewerkt: 0, verwijderd: 0, klaar: true });
    assert.equal(kdb.staat('synchronisatiepunt'), '2026-10-27T13:08:00Z');
    assert.match(kamer.verzoeken[0], /\$filter=Datum ge 2026-09-15T00:00:00Z and ApiGewijzigdOp gt 1900-01-01T00:00:00Z/);
    assert.deepEqual(await haalTeksten(kdb), { gelukt: 2, mislukt: 0, over: 0 });

    // Ongewijzigd startpunt: verder vanaf het synchronisatiepunt.
    await synchroniseer(kdb);
    assert.match(kamer.verzoeken.at(-1), /ApiGewijzigdOp gt 2026-10-27T13:08:00Z/);
    // Verder terug: opnieuw vanaf het begin, zonder bestaande teksten opnieuw op te halen.
    process.env.KAMERSTUKKEN_VANAF = '2024-01-01';
    assert.deepEqual(await synchroniseer(kdb), { nieuw: 0, bijgewerkt: 2, verwijderd: 0, klaar: true });
    assert.match(kamer.verzoeken.at(-1), /Datum ge 2024-01-01T00:00:00Z and ApiGewijzigdOp gt 1900-01-01T00:00:00Z/);
    assert.equal(kdb.wachtrij(10, 3).length, 0);
    delete process.env.KAMERSTUKKEN_VANAF;
    assert.equal(kdb.zoek({ vraag: 'regionale bereikbaarheid' }).rijen[0].afzender, 'A.W.H. Bertram, staatssecretaris van Infrastructuur en Waterstaat');

    // Melding op "ziekenhuis" (staat in de brief) en "Lunchwijs" (in de pdf).
    opslag.instellingen.smtp = { host: '127.0.0.1', port: smtp.poort, secure: false, user: '', pass: '', from: 'rc@example.nl' };
    opslag.meldingen = [
      { id: 'm1', naam: 'Zorg', email: 'x@example.nl', termen: ['ziekenhuis', 'Lunchwijs'], frequentie: 'direct', actief: true, aangemaakt: '2026-10-01T00:00:00Z', laatsteMelding: null },
      { id: 'm2', email: 'y@example.nl', termen: ['Bakkeveen'], frequentie: 'direct', actief: true, aangemaakt: '2026-10-01T00:00:00Z', laatsteMelding: null },
    ];
    const eerste = await verwerkMeldingen(opslag, kdb);
    assert.deepEqual(eerste.map((r) => [r.id, r.verstuurd, r.aantal]), [['m1', true, 2], ['m2', false, undefined]]);
    assert.equal(smtp.ontvangen.length, 1);
    assert.match(smtp.ontvangen[0], /Subject: Kamerstukken: 2 nieuwe met ziekenhuis, Lunchwijs/);
    const tweede = await verwerkMeldingen(opslag, kdb);
    assert.equal(tweede[0].verstuurd, false, 'niet nog eens hetzelfde');

    // Dagelijks: pas na het verstuurmoment, en één keer per dag.
    opslag.meldingen = [{ id: 'm3', email: 'z@example.nl', termen: ['ziekenhuis'], frequentie: 'dagelijks', actief: true, aangemaakt: '2026-10-01T00:00:00Z', laatsteMelding: null }];
    opslag.instellingen.mailTijd = '07:00';
    // Morgen, want de stukken hierboven zijn "nu" binnengekomen.
    const morgen = (uur) => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(uur, 0, 0, 0); return d; };
    assert.equal((await verwerkMeldingen(opslag, kdb, { nu: morgen(6) })).length, 0);
    assert.equal((await verwerkMeldingen(opslag, kdb, { nu: morgen(8) }))[0].verstuurd, true);
    assert.equal((await verwerkMeldingen(opslag, kdb, { nu: morgen(9) })).length, 0);

    // Regiomail: Opsterland volgt "ziekenhuis" en krijgt een kopje Kamerstukken.
    opslag.kamertermen = { opsterland: ['ziekenhuis'] };
    const mail = await stelMailSamen(opslag, { email: 'v@example.nl', regios: ['opsterland', 'heerenveen'], laatsteMail: '2026-10-01T00:00:00Z' }, { samenvatting: false });
    const opsterland = mail.html.slice(mail.html.indexOf('>Opsterland</h2>'), mail.html.indexOf('>Heerenveen</h2>'));
    assert.match(opsterland, /<h3[^>]*>Kamerstukken <span[^>]*>\(1\)<\/span><\/h3>/);
    assert.match(opsterland, /href="https:\/\/www\.tweedekamer\.nl\/kamerstukken\/detail\?id=2026Z21147&amp;did=2026D1"/);
    assert.match(opsterland, /<strong style="background:#fff3b0;">ziekenhuis<\/strong>/);
    assert.ok(!mail.html.slice(mail.html.indexOf('>Heerenveen</h2>')).includes('Kamerstukken'), 'zonder termen geen kopje');
    assert.match(mail.tekst, /-- Kamerstukken \(1\) --/);
    kdb.sluit();
  } finally {
    delete process.env.KAMERSTUKKEN_API;
    kamer.server.close();
    smtp.server.close();
  }
});
