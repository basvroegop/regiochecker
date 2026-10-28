// Verkeer uit de vroegere checker (src/bronnen/verkeer.mjs): files van de NDW
// (echte records uit de feed van 28 oktober 2026, plus een op de A7 bij
// Heerenveen) en NS-storingen (in het formaat van de Reisinformatie API v3).
// Lezen, het wegnummer via PDOK, de routering via traject en stations, de snelle
// ronde van vijf minuten, en buiten de weekmail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MockAgent } from 'undici';
import { leesFiles, leesStoringen, haalFiles } from '../src/bronnen/verkeer.mjs';
import { zetOpenbaarDispatcher } from '../src/netwerk.mjs';
import { Opslag } from '../src/opslag.mjs';
import { maakKader, routeerItem, bouwFeed } from '../src/feed.mjs';
import { alleBronnen, teVerzamelen } from '../src/register.mjs';
import { bronStatus } from '../src/beheer.mjs';
import { verzamelSnel } from '../src/verzamel.mjs';
import { stelMailSamen } from '../src/mail.mjs';
import { nieuweGebruiker } from '../src/gebruikers.mjs';

const fixture = (naam) => readFileSync(new URL(`./fixtures/${naam}`, import.meta.url), 'utf8');

function nepInternet() {
  const nep = new MockAgent();
  nep.disableNetConnect();
  const bezocht = [];
  nep.get(() => true).intercept({ path: () => true, method: () => true }).reply(({ origin, path: pad }) => {
    const u = new URL(pad, origin);
    bezocht.push(`${u.host}${u.pathname}`);
    if (u.host === 'opendata.ndw.nu') return { statusCode: 200, data: gzipSync(fixture('ndw-actueel-beeld.xml')) };
    if (u.host === 'api.pdok.nl' && u.pathname.endsWith('/reverse')) {
      const lat = Number(u.searchParams.get('lat'));
      const docs = lat > 52.9
        ? [{ straatnaam: 'Rykswg', woonplaatsnaam: 'Heerenveen', gemeentenaam: 'Heerenveen' }, { straatnaam: 'Rijksweg A7', woonplaatsnaam: 'Heerenveen', gemeentenaam: 'Heerenveen' }]
        : [{ straatnaam: 'A4', woonplaatsnaam: 'Leiden', gemeentenaam: 'Leiden' }];
      return { statusCode: 200, data: JSON.stringify({ response: { docs } }), responseOptions: { headers: { 'content-type': 'application/json' } } };
    }
    return { statusCode: 404, data: 'niet gevonden' };
  }).persist();
  const vorige = zetOpenbaarDispatcher(nep);
  return { bezocht, herstel: () => zetOpenbaarDispatcher(vorige) };
}

test('files: vanaf tien minuten vertraging, met het traject; het wegnummer via PDOK', async () => {
  const files = leesFiles(fixture('ndw-actueel-beeld.xml'));
  assert.deepEqual(files.map((f) => [f.id, f.vertraging, f.lengte, f.soort]), [
    ['NLRWS_0005510219_1', 1448, 12900, 'slowTraffic'],
    ['NLRWS_TEST_HEERENVEEN_1', 780, 4900, 'stationaryTraffic'],
  ], 'niet de file van 140 seconden, en geen ongeval');
  assert.ok(files[0].punten.length <= 13 && files[0].punten.length >= 10, 'het traject in hooguit twaalf stappen');
  assert.deepEqual(files[1].punten.at(-1), { lat: 52.953, lon: 5.885 });
  assert.equal(leesFiles(fixture('ndw-actueel-beeld.xml'), { minVertragingMin: 20 }).length, 1);

  const net = nepInternet();
  try {
    const stukken = await haalFiles({ url: 'https://opendata.ndw.nu/actueel_beeld.xml.gz', minVertragingMin: 10 });
    assert.deepEqual(stukken.map((s) => s.titel), [
      'File op de A4 bij Leiden: 12,9 km, 24 minuten vertraging',
      'File op de A7 bij Heerenveen: 4,9 km, 13 minuten vertraging',
    ]);
    const hv = stukken[1];
    assert.match(hv.tekst, /^Stilstaand verkeer over 4,9 km op de A7 bij Heerenveen, 13 minuten vertraging; sinds \d\d:\d\d\. Bron: NDW\.$/);
    assert.equal(hv.plek.naam, 'A7 bij Heerenveen');
    // Een tweede ronde vraagt het wegnummer niet opnieuw.
    const voor = net.bezocht.filter((b) => b.startsWith('api.pdok.nl')).length;
    await haalFiles({ url: 'https://opendata.ndw.nu/actueel_beeld.xml.gz', minVertragingMin: 10 });
    assert.equal(net.bezocht.filter((b) => b.startsWith('api.pdok.nl')).length, voor);
  } finally {
    net.herstel();
  }
});

test('NS-storingen: storingen, werkzaamheden op titel samengevoegd, en calamiteiten', () => {
  const s = leesStoringen(JSON.parse(fixture('ns-storingen.json')));
  assert.deepEqual(s.map((x) => [x.sleutel, x.titel, x.datum]), [
    ['7001234', 'Treinstoring: Heerenveen - Leeuwarden', '2026-10-28'],
    ['w:groningen - zuidhorn', 'Werkzaamheden op het spoor: Groningen - Zuidhorn', '2026-11-07'],
    ['C-99', 'Calamiteit op het spoor: Stroomstoring in de regio Amsterdam', null],
  ]);
  assert.equal(s[0].tekst, 'Tussen Heerenveen en Leeuwarden rijden geen treinen. Oorzaak: een aanrijding met een persoon. Reken op een uur extra reistijd. Verwacht tot 19:00. Tussen Heerenveen en Leeuwarden rijden stopbussen. Bron: NS.');
  assert.deepEqual(s[0].punten.map((p) => p.naam), ['station Heerenveen', 'station Akkrum', 'station Grou-Jirnsum', 'station Leeuwarden']);
  assert.equal(s[2].url, 'https://www.ns.nl/reisinformatie/calamiteiten');
  assert.equal(s[2].tekst, 'Door een stroomstoring rijden er minder treinen rond Amsterdam. Bron: NS.');
  assert.equal(leesStoringen(JSON.parse(fixture('ns-storingen.json')), { werkzaamheden: false }).length, 2);
});

test('verkeer naar de regio, onder Verkeer; NS pas met een sleutel; niet in de weekmail', async () => {
  const opslag = new Opslag(mkdtempSync(path.join(tmpdir(), 'rc-verkeer-')));
  const nu = new Date().toISOString();
  const k = () => maakKader({ opslag });
  const bronnen = new Map(alleBronnen(opslag).map((b) => [b.id, b]));

  // Zonder NS_API_KEY: niet ophalen, en "Sleutel nodig" in Beheer.
  const sleutel = process.env.NS_API_KEY;
  delete process.env.NS_API_KEY;
  assert.ok(!teVerzamelen(opslag).some((b) => b.id === 'ns-storingen'));
  assert.ok(teVerzamelen(opslag).some((b) => b.id === 'ndw-files'));
  assert.deepEqual([bronStatus(opslag, bronnen.get('ns-storingen')).tekst, bronStatus(opslag, bronnen.get('ns-storingen')).fout], ['Sleutel nodig', 'Zet NS_API_KEY in .env om deze bron te gebruiken.']);
  process.env.NS_API_KEY = 'proef';
  assert.ok(teVerzamelen(opslag).some((b) => b.id === 'ns-storingen'));
  if (sleutel === undefined) delete process.env.NS_API_KEY; else process.env.NS_API_KEY = sleutel;

  // Niet de allereerste ronde (dan telt alleen wat van de laatste twee dagen is).
  opslag.status.bronnen['ndw-files'] = { ok: true, laatsteSucces: '2026-10-01T00:00:00Z', laatsteRonde: '2026-10-01T00:00:00Z' };
  const net = nepInternet();
  try {
    // De snelle ronde: alleen files (NS zonder sleutel), alleen in een regio, en
    // pas na vijf minuten weer.
    assert.equal(await verzamelSnel(opslag), 1);
    assert.ok(opslag.items['ndw-files:NLRWS_TEST_HEERENVEEN_1']);
    assert.equal(opslag.items['ndw-files:NLRWS_0005510219_1'], undefined, 'Leiden is geen regio');
    assert.equal(opslag.status.bronnen['ndw-files'].aantal, 1);
    assert.equal(await verzamelSnel(opslag), 0);
    assert.equal(net.bezocht.filter((b) => b === 'opendata.ndw.nu/actueel_beeld.xml.gz').length, 1, 'nog geen vijf minuten later');
    assert.equal(await verzamelSnel(opslag, Date.now() + 5 * 60000), 0, 'na vijf minuten opnieuw, zonder nieuwe files');
    assert.equal(net.bezocht.filter((b) => b === 'opendata.ndw.nu/actueel_beeld.xml.gz').length, 2);
  } finally {
    net.herstel();
  }

  const file = opslag.items['ndw-files:NLRWS_TEST_HEERENVEEN_1'];
  assert.deepEqual(routeerItem(k(), file, bronnen.get('ndw-files')).map((r) => [r.regio, r.gevonden[0].fragment.tekst]), [['heerenveen', 'A7 bij Heerenveen, in de gemeente Heerenveen']]);

  // Een storing gaat naar elke regio met een station op het traject.
  for (const s of leesStoringen(JSON.parse(fixture('ns-storingen.json')))) {
    opslag.items[`ns-storingen:${s.sleutel}`] = { ...s, sleutel: `ns-storingen:${s.sleutel}`, bron: 'ns-storingen', regio: null, soort: 'treinstoring', eersteGezien: nu, laatstGezien: nu, basislijn: false };
  }
  const route = (sleutel) => routeerItem(k(), opslag.items[sleutel], bronnen.get('ns-storingen')).map((r) => [r.regio, r.gevonden[0].term]);
  assert.deepEqual(route('ns-storingen:7001234'), [['heerenveen', 'station Heerenveen']]);
  assert.deepEqual(route('ns-storingen:w:groningen - zuidhorn'), [['groningen', 'station Groningen']]);
  assert.deepEqual(route('ns-storingen:C-99'), [], 'zonder stations nergens heen');

  // In de feed onder Verkeer.
  const sanne = nieuweGebruiker(opslag.instellingen, { naam: 'Sanne', email: 'sanne@lc.nl', regios: ['heerenveen', 'groningen'] });
  opslag.gebruikers.push(sanne);
  const feed = bouwFeed(k(), sanne, {});
  assert.deepEqual(feed.items.filter((i) => i.groep === 'verkeer').map((i) => i.titel).sort(), [
    'File op de A7 bij Heerenveen: 4,9 km, 13 minuten vertraging',
    'Treinstoring: Heerenveen - Leeuwarden',
    'Werkzaamheden op het spoor: Groningen - Zuidhorn',
  ]);
  assert.equal(feed.tellingen.verkeer, 3);

  // Een file die groeit: titel en tekst bijgewerkt, nog steeds hetzelfde stuk.
  const { verwerk } = await import('../src/verzamel.mjs');
  const langer = { ...file, sleutel: 'NLRWS_TEST_HEERENVEEN_1', titel: 'File op de A7 bij Heerenveen: 7,0 km, 20 minuten vertraging', tekst: 'Langer.' };
  const { nieuw } = verwerk(opslag, bronnen.get('ndw-files'), [langer]);
  assert.deepEqual([nieuw.length, file.titel, file.tekst], [0, 'File op de A7 bij Heerenveen: 7,0 km, 20 minuten vertraging', 'Langer.']);

  // Niet in de weekmail: een file van maandag is vrijdag geen nieuws. Een
  // ander landelijk signaal in dezelfde regio wel.
  opslag.items['ransomware:g'] = {
    sleutel: 'ransomware:g', bron: 'ransomware', regio: null, soort: 'ransomware', titel: 'Ransomware-aanval: Garage Bouma (akira)', url: 'https://x', eersteGezien: nu, laatstGezien: nu, basislijn: false,
    vestiging: { plaats: 'Heerenveen', gemeente: 'Heerenveen', bron: 'de beschrijving' },
  };
  const mail = await stelMailSamen(opslag, sanne, { sinds: new Date(Date.now() - 86400000).toISOString(), samenvatting: false });
  assert.match(mail.tekst, /Ransomware-aanval: Garage Bouma/);
  assert.doesNotMatch(mail.tekst, /File op de A7|Treinstoring|Werkzaamheden op het spoor/);
});
