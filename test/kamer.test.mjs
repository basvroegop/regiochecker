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

// Nagebootste servers draaien op 127.0.0.1; dat is normaal niet toegestaan (src/netwerk.mjs).
process.env.REGIOCHECKER_PRIVE_ADRESSEN = '1';

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
  // Een nieuwe tekstversie van een bestaand stuk: andere versie, dus geen verouderde feed.
  const voor = JSON.stringify(kdb.versie());
  kdb.bewaarTekst(c.nr, 'Nu wel tekst, over Drachten.', new Date('2026-10-21T10:00:00Z'));
  assert.notEqual(JSON.stringify(kdb.versie()), voor);
  kdb.bewaarTekst(c.nr, null, new Date('2026-10-21T10:00:00Z'));

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

test('sleutelwoorden van regio\'s zijn in kamerstukken hoofdlettergevoelig, termen van meldingen niet', metSqlite, async () => {
  const { openKamerDb } = await import('../src/kamer/db.mjs');
  const { vindTermen, hoofdlettersKloppen } = await import('../src/termen.mjs');
  const kdb = await openKamerDb(path.join(tijdelijk(), 'k.sqlite'));
  const binnen = new Date('2026-10-21T10:00:00Z');
  for (const [id, tekst] of [
    ['1', 'De assen van vrachtwagens slijten sneller dan gedacht.'],
    // Eerst de kleine letters: het fragment van SQLite toont dan "assen", de hele tekst ook Assen.
    ['2', 'De assen van de trein zijn vervangen. ' + 'Verder niets. '.repeat(60) + 'In Assen komt een station voor vrachtwagens.'],
    ['3', 'ASSEN – De gemeente vraagt om geld.'],
  ]) {
    kdb.bewaarStuk(stuk(id));
    kdb.bewaarTekst(kdb.wachtrij(10, 3).find((x) => x.id === id).nr, tekst, binnen);
  }
  const opties = { sinds: '2026-10-21T00:00:00Z', minDatum: '2026-10-01' };
  const ids = (lijst) => lijst.map((t) => t.stuk.id).sort();

  // Het sleutelwoord Assen: de stad, ook in een kop in hoofdletters, maar niet de assen van een auto.
  const regio = kdb.feedTreffers(['Assen'], { ...opties, hoofdletters: true });
  assert.deepEqual(ids(regio), ['2', '3']);
  assert.equal(regio.find((t) => t.stuk.id === '2').fragment.treffer, 'Assen', 'het fragment toont de juiste plek');
  assert.deepEqual(ids(kdb.treffers(['Assen'], { ...opties, hoofdletters: true })), ['2', '3']);
  assert.equal(kdb.treffers(['Assen'], { ...opties, hoofdletters: true }).find((t) => t.stuk.id === '2').gevonden[0].aantal, 1);
  assert.equal(kdb.telStukken(['Assen'], '2026-10-01', { hoofdletters: true }), 2);
  // Een zoekterm van een melding blijft ongevoelig voor hoofdletters…
  assert.deepEqual(ids(kdb.feedTreffers(['Assen'], opties)), ['1', '2', '3']);
  assert.equal(kdb.telStukken(['Assen'], '2026-10-01'), 3);
  // …maar beperkt tot de sleutelwoorden van een regio telt de hoofdletter weer.
  assert.deepEqual(ids(kdb.feedTreffers(['vrachtwagens'], { ...opties, ookTermen: ['Assen'] })), ['2']);
  // Past het niet in één keer, dan staat erbij hoeveel er nog zijn.
  const een = kdb.feedTreffers(['Assen'], { ...opties, hoofdletters: true, max: 1 });
  assert.deepEqual([een.length, een.meer], [1, 1]);

  // De regel zelf: hoofdletters van de term moeten er staan, kleine letters mogen allebei.
  assert.equal(vindTermen('In Witteveen ligt een weg.', ['in Witteveen'], { hoofdletters: true }).length, 1);
  assert.equal(vindTermen('in witteveen', ['in Witteveen'], { hoofdletters: true }).length, 0);
  assert.equal(vindTermen('Súdwest-Fryslân', ['Sudwest-Fryslan'], { hoofdletters: true }).length, 1, 'accenten tellen niet');
  assert.equal(hoofdlettersKloppen('Assen', 'assen'), false);
  assert.equal(hoofdlettersKloppen('Het Hogeland', 'het Hogeland'), true, 'een lidwoord mag klein');
  assert.equal(hoofdlettersKloppen('Het Hogeland', 'het hogeland'), false);
  assert.equal(vindTermen('Zie https://www.dvhn.nl/regio/groningen/stad/iets', ['Groningen'], { hoofdletters: true }).length, 1, 'in een webadres telt de hoofdletter niet');
  assert.equal(vindTermen('de provincie groningen', ['Groningen'], { hoofdletters: true }).length, 0);
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
    const { verwerkMeldingen } = await import('../src/meldingen.mjs');
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
    opslag.gebruikers = [
      { id: 'g1', email: 'x@example.nl', regios: [] },
      { id: 'g2', email: 'y@example.nl', regios: [] },
      { id: 'g3', email: 'z@example.nl', regios: [] },
    ];
    const melding = (id, gebruiker, termen, extra = {}) => ({ id, gebruiker, termen, bereik: 'overal', bronnen: 'kamerstuk', frequentie: 'direct', tijd: '07:00', actief: true, aangemaakt: '2026-10-01T00:00:00Z', laatsteMelding: null, ...extra });
    opslag.meldingen = [melding('m1', 'g1', ['ziekenhuis', 'Lunchwijs']), melding('m2', 'g2', ['Bakkeveen'])];
    const ctx = { opslag, kdb, fdb: null };
    const eerste = await verwerkMeldingen(ctx);
    assert.deepEqual(eerste.map((r) => [r.id, r.verstuurd, r.aantal]), [['m1', true, 2], ['m2', false, undefined]]);
    assert.equal(smtp.ontvangen.length, 1);
    assert.match(smtp.ontvangen[0], /Subject: Melding: 2 nieuwe stukken met ziekenhuis, Lunchwijs/);
    const tweede = await verwerkMeldingen(ctx);
    assert.equal(tweede[0].verstuurd, false, 'niet nog eens hetzelfde');

    // Dagelijks: pas na het verstuurmoment van de melding, en één keer per dag.
    opslag.meldingen = [melding('m3', 'g3', ['ziekenhuis'], { frequentie: 'dagelijks' })];
    // Morgen, want de stukken hierboven zijn "nu" binnengekomen.
    const morgen = (uur) => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(uur, 0, 0, 0); return d; };
    assert.equal((await verwerkMeldingen(ctx, { nu: morgen(6) })).length, 0);
    assert.equal((await verwerkMeldingen(ctx, { nu: morgen(8) }))[0].verstuurd, true);
    assert.equal((await verwerkMeldingen(ctx, { nu: morgen(9) })).length, 0);

    // Een mailfout bij een dagelijkse melding: dezelfde dag opnieuw proberen.
    opslag.meldingen = [melding('m4', 'g3', ['Lunchwijs'], { frequentie: 'dagelijks' })];
    const goedeSmtp = opslag.instellingen.smtp;
    opslag.instellingen.smtp = { ...goedeSmtp, port: 9 };
    const mislukt = await verwerkMeldingen(ctx, { nu: morgen(8) });
    assert.deepEqual([mislukt[0].verstuurd, Boolean(mislukt[0].fout)], [false, true]);
    opslag.instellingen.smtp = goedeSmtp;
    assert.equal((await verwerkMeldingen(ctx, { nu: morgen(10) }))[0].verstuurd, true, 'herkansing dezelfde dag');

    // Meer kamerstukken dan er in één keer opgehaald worden: zeggen hoeveel nog.
    const twee = kdb.treffers(['ziekenhuis', 'Lunchwijs'], { sinds: '2026-01-01', max: 1 });
    assert.deepEqual([twee.length, twee.meer], [1, 1]);
    assert.equal(kdb.treffers(['ziekenhuis', 'Lunchwijs'], { sinds: '2026-01-01' }).meer, 0);
    assert.equal(kdb.feedTreffers(['ziekenhuis', 'Lunchwijs'], { sinds: '2026-01-01', max: 1 }).meer, 1);
    const { stelMeldingSamen } = await import('../src/meldingen.mjs');
    const metMeer = stelMeldingSamen(melding('m5', 'g1', ['ziekenhuis']), [], new Date(), { meer: 3 });
    assert.equal(metMeer.html.includes("nog zo'n 3 kamerstukken"), false, 'zonder kamerstukken geen kopje');

    // Regiomail: Opsterland heeft "ziekenhuis" als sleutelwoord en krijgt een kopje Kamerstukken.
    opslag.regios = { opsterland: { sleutelwoorden: [{ term: 'ziekenhuis', actief: true }] } };
    const mail = await stelMailSamen(opslag, { email: 'v@example.nl', regios: ['opsterland', 'heerenveen'], laatsteMail: '2026-10-01T00:00:00Z' }, { samenvatting: false });
    // De regio's staan op naam: eerst Heerenveen, dan Opsterland.
    const opsterland = mail.html.slice(mail.html.indexOf('>Opsterland</h2>'));
    assert.match(opsterland, /<h3[^>]*>Kamerstukken <span[^>]*>\(1\)<\/span><\/h3>/);
    assert.match(opsterland, /href="https:\/\/www\.tweedekamer\.nl\/kamerstukken\/detail\?id=2026Z21147&amp;did=2026D1"/);
    assert.match(opsterland, /<strong style="background:#fff3b0;">ziekenhuis<\/strong>/);
    assert.ok(!mail.html.slice(mail.html.indexOf('>Heerenveen</h2>'), mail.html.indexOf('>Opsterland</h2>')).includes('Kamerstukken'), 'zonder termen geen kopje');
    assert.match(mail.tekst, /-- Kamerstukken \(1\) --/);
    // Passen ze niet allemaal in de mail, dan staat erbij hoeveel er nog zijn.
    opslag.kamer = new Proxy(kdb, {
      get: (doel, naam) => (naam === 'treffers' ? (...args) => Object.assign(doel.treffers(...args), { meer: 7 }) : typeof doel[naam] === 'function' ? doel[naam].bind(doel) : doel[naam]),
    });
    const vol = await stelMailSamen(opslag, { email: 'v@example.nl', regios: ['opsterland'], laatsteMail: '2026-10-01T00:00:00Z' }, { samenvatting: false });
    assert.match(vol.html, /En nog zo&#39;n 7 kamerstukken met deze termen|En nog zo'n 7 kamerstukken met deze termen/);
    assert.match(vol.tekst, /En nog zo'n 7 kamerstukken met deze termen/);
    opslag.kamer = kdb;
    kdb.sluit();
  } finally {
    delete process.env.KAMERSTUKKEN_API;
    kamer.server.close();
    smtp.server.close();
  }
});

test('bijhouden: op een paginagrens valt niets weg, ook niet bij gelijke tijdstempels', metSqlite, async () => {
  // Een API die filter, volgorde, $skip en $top echt toepast. Tien stukken met
  // precies dezelfde tijdstempel: meer dan er in één ronde (2 × 2) passen.
  const docs = [
    ...Array.from({ length: 10 }, (_, i) => ({ Id: `s${String(i).padStart(2, '0')}`, Titel: `Stuk ${i}`, Datum: '2026-10-07T00:00:00+02:00', ApiGewijzigdOp: '2026-10-27T13:08:00Z', Verwijderd: false })),
    { Id: 'z', Titel: 'Later', Datum: '2026-10-07T00:00:00+02:00', ApiGewijzigdOp: '2026-10-27T13:09:00.5Z', Verwijderd: false },
  ];
  const server = http.createServer((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const na = Date.parse(/ApiGewijzigdOp gt (\S+)/.exec(q.get('$filter'))[1]);
    const lijst = docs.filter((d) => Date.parse(d.ApiGewijzigdOp) > na)
      .sort((a, b) => Date.parse(a.ApiGewijzigdOp) - Date.parse(b.ApiGewijzigdOp) || a.Id.localeCompare(b.Id));
    const skip = Number(q.get('$skip'));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ value: lijst.slice(skip, skip + Number(q.get('$top'))) }));
  });
  await new Promise((klaar) => server.listen(0, '127.0.0.1', klaar));
  Object.assign(process.env, { KAMERSTUKKEN_API: `http://127.0.0.1:${server.address().port}`, KAMERSTUKKEN_PAGINA: '2', KAMERSTUKKEN_MAX_PAGINAS: '2' });
  try {
    const { openKamerDb } = await import('../src/kamer/db.mjs');
    const { synchroniseer } = await import('../src/kamer/ophalen.mjs');
    const kdb = await openKamerDb(path.join(tijdelijk(), 'k.sqlite'));
    const rondes = [];
    for (let i = 0; i < 5; i++) rondes.push(await synchroniseer(kdb));
    assert.deepEqual(rondes.map((r) => [r.nieuw, r.klaar]), [[4, false], [4, false], [3, true], [0, true], [0, true]]);
    assert.equal(kdb.db.prepare('SELECT count(*) n FROM stukken').get().n, 11, 'alle elf binnen');
    assert.equal(kdb.staat('synchronisatiepunt'), '2026-10-27T13:09:00.5Z');
    kdb.sluit();
  } finally {
    for (const k of ['KAMERSTUKKEN_API', 'KAMERSTUKKEN_PAGINA', 'KAMERSTUKKEN_MAX_PAGINAS']) delete process.env[k];
    server.close();
  }
});
