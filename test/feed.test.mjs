// De feed: alles uit de eigen regio's, plus stukken uit landelijke bronnen,
// kamerstukken en audio waarin een sleutelwoord van de regio staat, plus wat
// een melding van de journalist vindt. Bij elk stuk de reden. Daarnaast
// gelezen, bewaard en notities, zoeken, en de mail van een melding.
// node:sqlite zit in Node 22+; op een oudere Node worden deze tests overgeslagen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Opslag } from '../src/opslag.mjs';
import { nieuweGebruiker } from '../src/gebruikers.mjs';
import { lokaleDatum } from '../src/datum.mjs';

const sqlite = await import('node:sqlite').catch(() => null);
const metSqlite = { skip: sqlite ? false : 'node:sqlite niet beschikbaar (Node 22+ nodig)' };
const tijdelijk = () => mkdtempSync(path.join(tmpdir(), 'rc-feed-'));
const uurGeleden = (u) => new Date(Date.now() - u * 3600000).toISOString();

const E1 = 'e1'.repeat(16);
const E2 = 'e2'.repeat(16);
const E3 = 'e3'.repeat(16);

async function opzet() {
  const { openKamerDb } = await import('../src/kamer/db.mjs');
  const { openFeedDb } = await import('../src/feeddb.mjs');
  const { AudioDb } = await import('../src/audio/db.mjs');
  const map = tijdelijk();
  const opslag = new Opslag(map);
  const kdb = await openKamerDb(path.join(map, 'k.sqlite'));
  const fdb = await openFeedDb(path.join(map, 'f.sqlite'));
  const adb = new AudioDb(fdb.db);
  opslag.kamer = kdb;
  opslag.feeddb = fdb;
  opslag.audiodb = adb;
  opslag.regios = {
    smallingerland: { sleutelwoorden: [{ term: 'Drachten', actief: true }, { term: 'De Drait', actief: true }, { term: 'Ureterp', actief: false }] },
    heerenveen: { sleutelwoorden: [{ term: 'Thialf', actief: true }], landelijkUit: ['tweede-kamer'] },
  };
  opslag.bronnen = [
    { id: 'rijk', naam: 'Rijksoverheid · nieuws', soort: 'nieuws', bereik: 'landelijk', type: 'rss', url: 'https://feeds.rijksoverheid.nl/nieuws.rss' },
    { id: 'podcast', naam: 'De Haagse Kwestie', soort: 'podcast', bereik: 'landelijk', type: 'audio', url: 'https://x/feed', audio: { kind: 'rss', prioriteit: 1 } },
    { id: 'raad', naam: 'Smallingerland · Raad', soort: 'raadsvergadering', bereik: 'regio', regio: 'smallingerland', type: 'audio', url: 'https://smallingerland.raadsinformatie.nl/', audio: { kind: 'notubiz', prioriteit: 0 } },
  ];
  const item = (sleutel, extra) => ({ sleutel, titel: sleutel, url: `https://x/${sleutel}`, datum: lokaleDatum(), eersteGezien: uurGeleden(2), laatstGezien: uurGeleden(1), basislijn: false, ...extra });
  for (const i of [
    item('smallingerland-nieuws:a', { bron: 'smallingerland-nieuws', regio: 'smallingerland', soort: 'nieuws', titel: 'Nieuwe fietsbrug over de Drait' }),
    item('smallingerland-nieuws:oud', { bron: 'smallingerland-nieuws', regio: 'smallingerland', soort: 'nieuws', basislijn: true }),
    item('opsterland-nieuws:b', { bron: 'opsterland-nieuws', regio: 'opsterland', soort: 'nieuws', titel: 'Bakkeveen: omleiding', inhoud: 'Ook de huisartsenpost blijft bereikbaar.' }),
    item('rijk:c', { bron: 'rijk', regio: null, soort: 'nieuws', titel: 'Kabinet investeert in het noorden', tekst: 'Geld voor theater De Drait in Drachten en voor Ureterp.' }),
    item('rijk:d', { bron: 'rijk', regio: null, soort: 'nieuws', titel: 'Schaatsen', tekst: 'Thialf blijft open.' }),
    item('rijk:e', { bron: 'rijk', regio: null, soort: 'nieuws', titel: 'Niets regionaals', tekst: 'Over het weer.' }),
  ]) opslag.items[i.sleutel] = i;

  // Kamerstukken: één met Drachten, één met Thialf (maar Heerenveen heeft de Kamer uitgezet).
  for (const [id, tekst] of [['1', 'De huisartsenpost in Drachten sluit ’s nachts.'], ['2', 'Thialf blijft het nationale schaatscentrum.'], ['3', 'Over de drachten van een kledingstuk.']]) {
    kdb.bewaarStuk({ id: `doc${id}`, nummer: `2026D${id}`, soort: 'Schriftelijke vragen', titel: 'Vragen', onderwerp: `Vragen ${id}`, datum: lokaleDatum(), vergaderjaar: '2026-2027', dossier: null, dossiertitel: null, zaak: `2026Z${id}`, afzender: 'Lid Van der Meer', contenttype: 'application/pdf', gewijzigd: 'x' });
    kdb.bewaarTekst(kdb.db.prepare('SELECT nr FROM stukken WHERE id = ?').get(`doc${id}`).nr, tekst);
  }

  // Audio: de raadsvergadering van Smallingerland en een podcast waarin Drachten valt.
  const aflevering = (bronId, id, velden, segmenten, entiteiten = []) => {
    const bron = opslag.bronnen.find((b) => b.id === bronId);
    adb.voegToe(bron, { id, extern: id, vorm: bron.audio.kind === 'rss' ? 'rss' : 'vergadering', ...velden });
    adb.werkBij(id, { transcript: segmenten.map((x) => x.text).join(' '), segmenten, entiteiten, status: 'klaar', eersteGezien: uurGeleden(3) });
  };
  aflevering('raad', E1, { titel: 'Raadsvergadering 23 oktober', url: 'https://smallingerland.raadsinformatie.nl/v/1', gepubliceerdOp: Date.now() / 1000 - 30 * 3600, duur: 100 }, [
    { start: 0, end: 10, text: 'Het woord is aan wethouder Kramer.', speaker: 'Spreker 1', speaker_id: 'p1'.repeat(16) },
    { start: 10, end: 20, text: 'De huisartsenpost in Drachten moet blijven.', speaker: 'Spreker 2', speaker_id: 'p2'.repeat(16) },
    { start: 20, end: 30, text: 'Dank u.', speaker: 'Anke Postma', speaker_id: 'p3'.repeat(16) },
  ], [{ name: 'wethouder Kramer', type: 'person', count: 1, occurrences: [{ segment: 0, start: 4 }] }]);
  adb.werkBij(E1, { audioPad: path.join(map, 'audio', E1, 'audio.mp3') });
  aflevering('podcast', E2, { titel: 'De Haagse Kwestie #212', url: 'https://x/212', mediaUrl: 'https://x/212.mp3' }, [
    { start: 0, end: 20, text: 'Welkom.' }, { start: 20, end: 60, text: 'Kijk naar Drachten: daar liggen woningen klaar.' },
  ]);
  aflevering('podcast', E3, { titel: 'Niets', url: 'https://x/213', mediaUrl: 'https://x/213.mp3' }, [{ start: 0, end: 5, text: 'Over het weer.' }]);

  const sanne = nieuweGebruiker(opslag.instellingen, { naam: 'Sanne', email: 'sanne@lc.nl', regios: ['smallingerland', 'heerenveen'] });
  opslag.gebruikers.push(sanne);
  opslag.meldingen.push({ id: 'm1', gebruiker: sanne.id, termen: ['huisartsenpost'], bereik: 'overal', bronnen: 'alle', frequentie: 'direct', tijd: '17:00', actief: true, aangemaakt: uurGeleden(100), laatsteMelding: null });
  return { opslag, kdb, fdb, adb, sanne, ctx: { opslag, kdb, fdb, adb } };
}

test('feed: eigen regio, landelijk via sleutelwoord, kamerstuk, audio en melding, met de reden', metSqlite, async () => {
  const { bouwFeed } = await import('../src/feed.mjs');
  const { ctx, sanne } = await opzet();
  const feed = bouwFeed(ctx, sanne);
  const per = Object.fromEntries(feed.items.map((i) => [i.id, i]));

  assert.equal(per['i:smallingerland-nieuws:a'].match, null, 'eigen regio: geen reden nodig');
  assert.equal(per['i:smallingerland-nieuws:a'].regioNaam, 'Smallingerland');
  assert.equal(per['i:smallingerland-nieuws:a'].soortNaam, 'Gemeentenieuws');
  assert.ok(!per['i:smallingerland-nieuws:oud'], 'nulmeting');
  // Landelijk: Drachten gaat voor (volgorde van de sleutelwoorden); Ureterp staat uit.
  assert.deepEqual(per['i:rijk:c'].match, { term: 'Drachten', regio: 'smallingerland' });
  assert.deepEqual(per['i:rijk:c'].regios, ['smallingerland']);
  assert.deepEqual(per['i:rijk:d'].match, { term: 'Thialf', regio: 'heerenveen' }, 'alleen de Kamer staat uit voor Heerenveen');
  assert.ok(!per['i:rijk:e']);
  assert.deepEqual(per['k:doc1'].match, { term: 'Drachten', regio: 'smallingerland' });
  assert.equal(per['k:doc1'].groep, 'kamerstuk');
  assert.ok(!per['k:doc2'], 'Heerenveen heeft de Tweede Kamer uitgezet');
  // De melding "huisartsenpost" (overal): ook Opsterland, dat Sanne niet volgt.
  assert.deepEqual(per['i:opsterland-nieuws:b'].match, { term: 'huisartsenpost', melding: 'm1' });
  assert.equal(per['i:opsterland-nieuws:b'].regioNaam, 'Opsterland');
  assert.deepEqual(per[`a:${E1}`].match, { term: 'huisartsenpost', melding: 'm1', tijd: 10 });
  assert.deepEqual(per[`a:${E2}`].match, { term: 'Drachten', regio: 'smallingerland', tijd: 20 });
  assert.ok(!per[`a:${E3}`]);
  assert.deepEqual(feed.tellingen, { alles: 7, nieuws: 4, ingekomen: 0, woo: 0, kamerstuk: 1, raadsvergadering: 1, kamerdebat: 0, youtube: 0, podcast: 1, knmi: 0, rvs: 0, ransomware: 0, verkeer: 0, ingezonden: 0, bekendmaking: 0 });
  assert.deepEqual([per[`a:${E1}`].groep, per[`a:${E2}`].groep], ['raadsvergadering', 'podcast'], 'audio niet op één hoop');

  // Een tabblad per soort bron, in vaste volgorde, en alleen als er een bron van die soort is.
  const { zichtbareGroepen } = await import('../src/regios.mjs');
  assert.deepEqual(Object.entries(zichtbareGroepen([{ soort: 'kamerdebat' }, { soort: 'nieuws' }, { soort: 'aardbeving' }, { soort: 'raadsvergadering' }, { soort: 'kamerstuk' }])),
    [['nieuws', 'Gemeentenieuws'], ['raadsvergadering', 'Raadsvergaderingen'], ['kamerstuk', 'Kamerstukken'], ['kamerdebat', 'Kamerdebatten'], ['knmi', 'KNMI']]);

  assert.deepEqual(bouwFeed(ctx, sanne, { groep: 'kamerstuk' }).items.map((i) => i.id), ['k:doc1']);
  assert.deepEqual(bouwFeed(ctx, sanne, { regio: 'heerenveen' }).items.map((i) => i.id), ['i:rijk:d']);
  // Een journalist zonder regio's ziet alleen wat zijn meldingen vinden.
  const leeg = nieuweGebruiker(ctx.opslag.instellingen, { email: 'x@lc.nl' });
  assert.equal(bouwFeed(ctx, leeg).items.length, 0);
});

test('leespaneel: waarom staat het erin, sprekers, speler; gelezen, bewaard en notitie', metSqlite, async () => {
  const { bouwFeed, bewaardeFeed, detail, momentopname, zoekFeed } = await import('../src/feed.mjs');
  const { ctx, fdb, sanne } = await opzet();

  const k = detail(ctx, sanne, 'k:doc1');
  assert.equal(k.openenBij, 'Tweede Kamer');
  assert.equal(k.url, 'https://www.tweedekamer.nl/kamerstukken/detail?id=2026Z1&did=2026D1');
  assert.deepEqual(k.treffers.map((t) => [t.term, t.aantal, t.regio || t.melding, t.fragment.treffer]), [['Drachten', 1, 'smallingerland', 'Drachten'], ['huisartsenpost', 1, 'm1', 'huisartsenpost']]);
  // "drachten" met een kleine letter is geen Drachten: geen reden, geen regio.
  const k3 = detail(ctx, sanne, 'k:doc3');
  assert.deepEqual([k3.treffers, k3.regios], [[], []]);
  assert.ok(!bouwFeed(ctx, sanne).items.some((i) => i.id === 'k:doc3'));
  assert.ok(k.meta.some((m) => m.k === 'Regio' && m.v === 'Smallingerland'));
  assert.ok(k.document.blokken.length && k.document.blokken.every(([soort, tekst]) => ['k', 'p', 'l'].includes(soort) && tekst), 'het kamerstuk als blokken');
  assert.equal(k.document.volledig, true);

  // Een item: eerst de korte inhoud, en het leespaneel haalt het hele document op.
  const voorlopig = detail(ctx, sanne, 'i:opsterland-nieuws:b');
  assert.deepEqual(voorlopig.document, { blokken: [['p', 'Ook de huisartsenpost blijft bereikbaar.']], volledig: false });
  assert.equal(voorlopig.documentOphalen, true);
  fdb.zetDocument('opsterland-nieuws:b', { blokken: [['k', 'Bakkeveen'], ['p', 'Ook de huisartsenpost blijft bereikbaar.'], ['l', 'Omleiding via de Weg']], volledig: true });
  const heel = detail(ctx, sanne, 'i:opsterland-nieuws:b');
  assert.deepEqual(heel.document.blokken[0], ['k', 'Bakkeveen']);
  assert.equal(heel.documentOphalen, false);

  const r = detail(ctx, sanne, `a:${E1}`);
  assert.equal(r.speler, `/api/audio/afleveringen/${E1}/audio`);
  assert.equal(r.openenBij, 'Notubiz');
  assert.deepEqual(r.treffers.map((t) => [t.term, t.aantal, t.tijd]), [['Drachten', 1, 10], ['huisartsenpost', 1, 10]], 'ook sleutelwoorden van de eigen regio');
  assert.deepEqual(r.sprekers.map((s) => [s.label, s.heeftNaam, s.suggestie?.naam]), [['Spreker 1', false, undefined], ['Spreker 2', false, undefined], ['Anke Postma', true, undefined]], 'geen voorstellen uit namen van het taalmodel');
  const p = detail(ctx, sanne, `a:${E2}`);
  assert.equal(p.speler, 'https://x/212.mp3', 'podcast: het oorspronkelijke bestand');
  assert.equal(p.treffers[0].tijd, 20);
  assert.equal(detail(ctx, sanne, 'i:bestaat-niet'), null);

  fdb.zet(sanne.id, 'k:doc1', { gelezen: true, bewaard: true, notitie: 'Griffie bellen', momentopname: momentopname(ctx, sanne, 'k:doc1') });
  assert.ok(!bouwFeed(ctx, sanne, { ongelezen: true }).items.some((i) => i.id === 'k:doc1'));
  const opnieuw = bouwFeed(ctx, sanne).items.find((i) => i.id === 'k:doc1');
  assert.deepEqual([opnieuw.gelezen, opnieuw.bewaard, opnieuw.notitie], [true, true, true]);
  const bewaard = bewaardeFeed(ctx, sanne).items;
  assert.deepEqual(bewaard.map((i) => [i.id, i.titel, i.regioNaam]), [['k:doc1', 'Vragen 1', 'Smallingerland']]);
  assert.equal(detail(ctx, sanne, 'k:doc1').status.notitie, 'Griffie bellen');
  fdb.zet(sanne.id, 'k:doc1', { bewaard: false });
  assert.equal(bewaardeFeed(ctx, sanne).items.length, 0);
  assert.equal(fdb.status(sanne.id, 'k:doc1').notitie, 'Griffie bellen', 'notitie blijft');

  // Zoeken: alle regio's en bronnen.
  const z = zoekFeed(ctx, sanne, 'huisartsenpost').items.map((i) => i.id).sort();
  assert.deepEqual(z, [`a:${E1}`, 'i:opsterland-nieuws:b', 'k:doc1']);
  assert.deepEqual(zoekFeed(ctx, sanne, 'fietsbrug drait').items.map((i) => i.id), ['i:smallingerland-nieuws:a']);
  assert.equal(zoekFeed(ctx, sanne, '').items.length, 0);
});

// Quoted-printable terug naar platte tekst, zodat woorden niet over regels breken.
const plat = (mail) => mail.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

function nepSmtp() {
  const ontvangen = [];
  const server = net.createServer((sok) => {
    let buffer = '';
    let inData = false;
    let huidig = '';
    sok.write('220 nep\r\n');
    sok.on('data', (stuk) => {
      buffer += stuk;
      let i;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const regel = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (inData) {
          if (regel === '.') { inData = false; ontvangen.push(huidig); huidig = ''; sok.write('250 ok\r\n'); } else huidig += `${regel}\n`;
          continue;
        }
        if (/^DATA/i.test(regel)) { inData = true; sok.write('354 ga je gang\r\n'); } else if (/^QUIT/i.test(regel)) { sok.write('221 doei\r\n'); sok.end(); } else sok.write('250 ok\r\n');
      }
    });
  });
  return new Promise((klaar) => server.listen(0, '127.0.0.1', () => klaar({ server, ontvangen, poort: server.address().port })));
}

test('meldingen: bereik en bronnen, één mail met alles wat nieuw is, daarna niet nog eens', metSqlite, async () => {
  const { verwerkMeldingen, controleerMelding } = await import('../src/meldingen.mjs');
  const { ctx, opslag, sanne } = await opzet();
  const smtp = await nepSmtp();
  try {
    opslag.instellingen.smtp = { host: '127.0.0.1', port: smtp.poort, secure: false, user: '', pass: '', from: 'rc@example.nl' };
    const regioIds = ['smallingerland', 'opsterland'];
    assert.deepEqual(controleerMelding({ zoekvraag: '"stikstof" OR natura2000, De Peinder Mieden' }, null, { regioIds }).termen, ['stikstof', 'natura2000', 'De Peinder Mieden']);
    assert.throws(() => controleerMelding({ zoekvraag: '  ', bereik: 'overal' }, null, { regioIds }), /overal zonder zoekterm/);
    assert.throws(() => controleerMelding({ zoekvraag: 'x y', bereik: 'nergens' }, null, { regioIds }), /Onbekend bereik/);

    // Alleen Sanne's regio's: Opsterland valt af, de rest blijft.
    opslag.meldingen[0].bereik = 'mijn';
    const eerste = await verwerkMeldingen(ctx);
    assert.deepEqual(eerste.map((r) => [r.verstuurd, r.aantal]), [[true, 2]]);
    assert.equal(smtp.ontvangen.length, 1);
    const mail = plat(smtp.ontvangen[0]);
    assert.match(mail, /Subject: Melding: 2 nieuwe stukken met huisartsenpost/);
    assert.match(mail, /Kamerstukken/);
    assert.match(mail, /Audio en video/);
    assert.doesNotMatch(mail, /Bakkeveen/, 'Opsterland valt buiten "mijn regio\'s"');
    assert.deepEqual((await verwerkMeldingen(ctx)).map((r) => r.verstuurd), [false], 'niet nog eens');

    // Overal, alleen websites: dan wel Opsterland, en de rest niet.
    Object.assign(opslag.meldingen[0], { bereik: 'overal', bronnen: 'gemeente', laatsteMelding: null });
    assert.deepEqual((await verwerkMeldingen(ctx)).map((r) => [r.verstuurd, r.aantal]), [[true, 1]]);
    assert.match(plat(smtp.ontvangen[1]), /Bakkeveen/);
    assert.equal(sanne.email, 'sanne@lc.nl');
    assert.ok(opslag.logboek.some((l) => l.soort === 'melding' && l.aan === 'sanne@lc.nl'));
  } finally {
    smtp.server.close();
  }
});

test('meldingen zonder zoekterm: alles binnen regio\'s en bronnen, en niet extra in de feed', metSqlite, async () => {
  const { verwerkMeldingen, controleerMelding, meldingNaam } = await import('../src/meldingen.mjs');
  const { meldingTreffers, maakKader, bouwFeed } = await import('../src/feed.mjs');
  const { ctx, opslag, sanne } = await opzet();
  const smtp = await nepSmtp();
  try {
    opslag.instellingen.smtp = { host: '127.0.0.1', port: smtp.poort, secure: false, user: '', pass: '', from: 'rc@example.nl' };
    const regioIds = ['smallingerland', 'opsterland', 'heerenveen'];
    assert.deepEqual(controleerMelding({ zoekvraag: '  ', bereik: 'opsterland' }, null, { regioIds }).termen, []);
    assert.equal(controleerMelding({ zoekvraag: '' }, null, { regioIds }).bereik, 'mijn');
    assert.throws(() => controleerMelding({ zoekvraag: '', bereik: 'overal' }, null, { regioIds }), /overal zonder zoekterm/);
    // Een bestaande melding: de zoekterm weghalen mag, zolang hij niet overal zoekt.
    assert.throws(() => controleerMelding({ zoekvraag: '' }, { termen: ['x'], bereik: 'overal' }, { regioIds }), /overal zonder zoekterm/);
    assert.equal(meldingNaam({ termen: [], bereik: 'mijn', bronnen: 'kamerstuk' }), 'Alles uit je regio\'s, alleen Kamerstukken');
    assert.equal(meldingNaam({ termen: [], bereik: 'opsterland', bronnen: 'alle' }, () => 'Opsterland'), 'Alles uit Opsterland');

    const k = maakKader(ctx);
    const basis = { id: 'm2', gebruiker: sanne.id, termen: [], bronnen: 'alle', frequentie: 'direct', tijd: '17:00', actief: true };
    const ids = (m) => meldingTreffers(k, sanne, { ...basis, ...m }, { sinds: uurGeleden(100) }).map((r) => r.id).sort();
    // Sanne's regio's, zoals de feed ze toont: eigen nieuws, landelijk via
    // sleutelwoord, het kamerstuk met Drachten (Heerenveen heeft de Kamer uit) en audio.
    assert.deepEqual(ids({ bereik: 'mijn' }), [`a:${E1}`, `a:${E2}`, 'i:rijk:c', 'i:rijk:d', 'i:smallingerland-nieuws:a', 'k:doc1']);
    assert.deepEqual(ids({ bereik: 'opsterland', bronnen: 'gemeente' }), ['i:opsterland-nieuws:b']);
    assert.deepEqual(ids({ bereik: 'smallingerland', bronnen: 'kamerstuk' }), ['k:doc1']);
    assert.deepEqual(ids({ bereik: 'heerenveen', bronnen: 'kamerstuk' }), []);
    assert.deepEqual(ids({ bereik: 'smallingerland', bronnen: 'audio' }), [`a:${E1}`, `a:${E2}`]);
    assert.deepEqual(ids({ bereik: 'overal' }), [], 'een oude melding zonder termen en overal: niets');

    // De mail: alles uit Opsterland, zonder "Gevonden".
    opslag.meldingen[0].actief = false;
    opslag.meldingen.push({ ...basis, bereik: 'opsterland', aangemaakt: uurGeleden(100), laatsteMelding: null });
    assert.deepEqual((await verwerkMeldingen(ctx)).filter((r) => r.verstuurd).map((r) => [r.id, r.aantal]), [['m2', 1]]);
    const mail = plat(smtp.ontvangen[0]);
    assert.match(mail, /Subject: Melding: 1 nieuw stuk uit Opsterland/);
    assert.match(mail, /Alles uit Opsterland/);
    assert.match(mail, /Bakkeveen: omleiding/);
    assert.doesNotMatch(mail, /Gevonden:/);
    assert.match(mail, /voor alles wat er nieuw binnenkomt uit Opsterland/);

    // Sanne volgt Opsterland niet: de melding zet het niet in haar feed.
    assert.ok(!bouwFeed(ctx, sanne).items.some((i) => i.id === 'i:opsterland-nieuws:b'));
  } finally {
    smtp.server.close();
  }
});

test('snelheid: opwarmen in stapjes, en normaliseren blijft teken voor teken gelijk', metSqlite, async () => {
  const { warmOp } = await import('../src/feed.mjs');
  const { normaliseer, vindInSegmenten } = await import('../src/termen.mjs');
  const { ctx } = await opzet();
  // Drie landelijke berichten, twee podcastafleveringen, en de kamerstukken van
  // Smallingerland (Heerenveen heeft de Kamer uitgezet).
  assert.equal(await warmOp(ctx, { stapMs: 0 }), 6);
  // Zelfde lengte, zodat een plek in de genormaliseerde tekst een plek in het origineel is.
  for (const [tekst, verwacht] of [['Súdwest-Fryslân', 'sudwest-fryslan'], ['ÉÉN Ærø', 'een ærø'], ['İstanbul', 'istanbul'], ['’t Zandt', '’t zandt']]) {
    assert.equal(normaliseer(tekst), verwacht);
    assert.equal(normaliseer(tekst).length, tekst.length);
  }
  // De woordenset is een voorselectie: een term die alleen binnen een woord staat, telt niet.
  const segmenten = [{ start: 0, text: 'Over Drachtenaren.' }, { start: 5, text: 'En nu Drachten zelf.' }];
  assert.deepEqual(vindInSegmenten(segmenten, ['Drachten', 'Ureterp']).map((t) => [t.term, t.aantal, t.treffers[0].tijd]), [['Drachten', 1, 5]]);
});

test('het hele document doorzoeken: zoeken, sleutelwoorden en meldingen, ook na vijf weken', metSqlite, async () => {
  const { zoekFeed, routeerItem, meldingTreffers, maakKader } = await import('../src/feed.mjs');
  const { ctx, opslag, fdb, sanne } = await opzet();
  // Een landelijk bericht waarvan de korte inhoud niets regionaals heeft; diep in het document staat Thialf.
  const item = opslag.items['rijk:e'];
  item.inhoud = 'Over het weer.';
  const lang = 'Een lange alinea over het landelijke weerbeeld en de vooruitzichten voor de komende weken. '.repeat(120);
  fdb.zetDocument('rijk:e', { blokken: [['p', lang], ['d', 'Bijlage'], ['p', 'De schaatsbaan Thialf krijgt een nieuwe koelinstallatie.']], volledig: true });
  let k = maakKader(ctx);
  assert.ok(zoekFeed(k, sanne, 'koelinstallatie').items.some((i) => i.id === 'i:rijk:e'), 'zoeken vindt het, ook voorbij 6000 tekens');
  assert.deepEqual(routeerItem(k, item, k.bronnen.get('rijk')).map((r) => r.regio), ['heerenveen'], 'het sleutelwoord van Heerenveen ook');
  const melding = { id: 'm9', gebruiker: sanne.id, termen: ['koelinstallatie'], bereik: 'overal', bronnen: 'gemeente' };
  assert.equal(meldingTreffers(k, sanne, melding, { sinds: '2000-01-01T00:00:00Z' }).length, 1, 'en een melding');
  // Na vijf weken gaat de korte inhoud weg; het document blijft doorzoekbaar.
  delete item.inhoud;
  k = maakKader(ctx);
  assert.ok(zoekFeed(k, sanne, 'koelinstallatie').items.some((i) => i.id === 'i:rijk:e'));
});
