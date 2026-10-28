// Landelijke signalen uit de vroegere checker: aardbevingen en
// weerwaarschuwingen van het KNMI, uitspraken van de Raad van State en
// ransomware. Lezen (met echte voorbeelden in test/fixtures), plaatsnamen en
// gemeentegrenzen (src/geo.mjs), en de routering naar de regio's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { leesAardbevingen, leesWaarschuwingen, leesUitspraken, leesRansomlook, leesRansomwareLive } from '../src/bronnen/signalen.mjs';
import { plaatsenIn, gemeente, afstandKm, provincieNaam } from '../src/geo.mjs';
import { Opslag } from '../src/opslag.mjs';
import { maakKader, routeerItem, bouwFeed, detail } from '../src/feed.mjs';
import { nieuweGebruiker } from '../src/gebruikers.mjs';

const fixture = (naam) => readFileSync(new URL(`./fixtures/${naam}`, import.meta.url), 'utf8');

test('signalen lezen: aardbevingen, weerwaarschuwingen, uitspraken en ransomware', () => {
  const fdsn = `#EventID|Time|Latitude|Longitude|Depth/km|Author|Catalog|Contributor|ContributorID|MagType|Magnitude|MagAuthor|EventLocationName|EventType
knmi2026a|2026-10-27T21:03:11.4|53.2489|6.6497|3.0|||KNMI|knmi2026a|MLn|1.6||Garmerwolde|induced or triggered event
knmi2026b|2026-10-26T10:00:00.0|53.256|6.83|3.0|||KNMI|knmi2026b|MLn|0.4||Steendam|induced or triggered event
knmi2026c|2026-10-20T06:30:00.0|50.693|7.171|12.0|||KNMI|knmi2026c|MLs|2.2||Bonn (Duitsland)|earthquake`;
  const bevingen = leesAardbevingen(fdsn, { minMagnitude: 1 });
  assert.deepEqual(bevingen.map((b) => [b.sleutel, b.titel, b.datum]), [
    ['knmi2026a', 'Aardbeving van 1,6 bij Garmerwolde', '2026-10-27'],
    ['knmi2026c', 'Aardbeving van 2,2 bij Bonn (Duitsland)', '2026-10-20'],
  ], 'te licht valt af');
  assert.deepEqual(bevingen[0].plek, { lat: 53.2489, lon: 6.6497, naam: 'Garmerwolde' });
  assert.match(bevingen[0].tekst, /^Kracht 1,6 \(MLn\) op 3,0 km diepte, geïnduceerd \(door gaswinning of -opslag\)\. 27 oktober 2026 om 22:03\./);
  assert.equal(bevingen[0].url, 'https://www.knmi.nl/nederland-nu/seismologie/aardbevingen/knmi2026a');

  // De echte RSS van 28 oktober: overal code geel of groen, dus vanaf oranje niets.
  const rss = fixture('knmi-waarschuwingen.xml');
  assert.deepEqual(leesWaarschuwingen(rss, { minCode: 'oranje' }), []);
  const geel = leesWaarschuwingen(rss, { minCode: 'geel', nu: new Date('2026-10-28T12:00:00Z') });
  const friesland = geel.find((w) => w.titel.includes('Friesland'));
  assert.equal(friesland.titel, 'Code geel voor Friesland: Zware windstoten van 80-90 km/uur, vooral aan zee van 90-100 km/uur');
  assert.deepEqual(friesland.provincies, ['Fryslân']);
  assert.match(friesland.sleutel, /^Friesland\|geel\|2026-10-28\|/);
  assert.ok(!geel.some((w) => w.titel.includes('Groningen')), 'code groen telt niet');
  assert.equal(provincieNaam('Friesland'), 'Fryslân');

  const uitspraken = leesUitspraken(fixture('rvs-uitspraken.html'));
  assert.equal(uitspraken.length, 2);
  assert.deepEqual([uitspraken[0].sleutel, uitspraken[0].datum, uitspraken[0].soortStuk], ['ECLI:NL:RVS:2026:6304', '2026-10-28', 'Voorlopige voorziening']);
  assert.equal(uitspraken[0].titel, 'Raad van State (voorlopige voorziening): besluit van de gemeente Sint-Michielsgestel');
  assert.equal(uitspraken[0].url, 'https://www.raadvanstate.nl/uitspraken/@161643/202602307-2-r2/');
  assert.match(uitspraken[0].tekst, /in Den Dungen.*Trefwoorden: Voorlopige voorziening, RO - Noord-Brabant\. Zaak 202602307\/2\/R2, ECLI:NL:RVS:2026:6304\.$/);

  const lijst = [
    { post_title: 'Thialf', group_name: 'thegentlemen', description: 'Thialf is an ice skating stadium based in Heerenveen, the Netherlands.', discovered: '2026-07-23 08:12:01.123456' },
    { post_title: 'sportschool.nl', group_name: 'akira', description: '', website: 'sportschool.nl' },
    { post_title: 'Machelen (Belgium)', group_name: 'rhysida', description: 'Dutch-speaking municipality in Belgium.' },
  ];
  assert.deepEqual(leesRansomlook(lijst).map((r) => [r.titel, r.datum]), [
    ['Ransomware-aanval: Thialf (thegentlemen)', '2026-07-23'],
    ['Ransomware-aanval: sportschool.nl (akira)', null],
  ], 'Nederlands: een .nl-website of Nederland in de beschrijving; "Dutch" alleen is niet genoeg');
  assert.match(leesRansomlook(lijst)[0].tekst, /nog niet bevestigd door het slachtoffer/);
  assert.equal(leesRansomwareLive({ victims: [{ victim: 'Omrin', group: 'qilin', description: 'Waste company in Leeuwarden.', discovered: '2026-06-29' }] })[0].sleutel, 'omrin|qilin');
});

test('ransomwarekoppen van vóór 28 oktober krijgen de nieuwe vorm', () => {
  const map = mkdtempSync(path.join(tmpdir(), 'rc-titels-'));
  const oud = (sleutel, titel) => ({ sleutel, bron: 'ransomware', soort: 'ransomware', titel, eersteGezien: '2026-10-06T00:00:00Z', laatstGezien: '2026-10-06T00:00:00Z' });
  writeFileSync(path.join(map, 'items.json'), JSON.stringify({
    'ransomware:a': oud('ransomware:a', 'Ransomwaregroep everest claimt aanval op B-accountants'),
    'ransomware:b': oud('ransomware:b', 'Ransomwaregroep onbekend claimt aanval op sra.nl'),
  }));
  const opslag = new Opslag(map);
  assert.deepEqual(Object.values(opslag.items).map((i) => i.titel), ['Ransomware-aanval: B-accountants (everest)', 'Ransomware-aanval: sra.nl']);
  assert.equal(JSON.parse(readFileSync(path.join(map, 'items.json'), 'utf8'))['ransomware:a'].titel, 'Ransomware-aanval: B-accountants (everest)', 'en bewaard');
});

test('plaatsen en gemeenten: plaatsnamen in een tekst, grenzen en afstanden', () => {
  const p = (t) => plaatsenIn(t).map((x) => [x.plaats, x.gemeenten]);
  assert.deepEqual(p('Bij besluit heeft de raad van de gemeente Opsterland het omgevingsplan voor een zonnepark bij Gorredijk vastgesteld.'), [['Opsterland', ['Opsterland']], ['Gorredijk', ['Opsterland']]]);
  assert.deepEqual(p('Het college van burgemeester en wethouders van Smallingerland weigerde.'), [['Smallingerland', ['Smallingerland']]]);
  assert.deepEqual(p('Er reden geen treinen tussen Groningen en Amsterdam. De Rijksuniversiteit Groningen besliste.'), [], 'een plaatsnaam zonder aanwijzing telt niet');
  assert.deepEqual(p('Een bedrijf in Sneek. Heel goed. Best wel. De heer De Vries uit Ten Boer.'), [['Sneek', ['Súdwest-Fryslân']], ['Ten Boer', ['Groningen']]], 'korte namen alleen met "in", "uit"; gewone woorden niet');
  assert.deepEqual(p('Sneek is mooi.'), [], 'een korte naam zonder aanwijzing telt niet');
  assert.deepEqual(p('De provincie Groningen en de gemeente Groningen.'), [['Groningen', ['Groningen']]], 'na "provincie" niet de gemeente');
  assert.deepEqual(p('Een boerderij in Oudega.').at(0)?.[1].sort(), ['De Fryske Marren', 'Smallingerland', 'Súdwest-Fryslân'].sort(), 'een plaatsnaam in drie gemeenten');

  const groningen = gemeente('Groningen');
  assert.equal(groningen.provincie, 'Groningen');
  assert.equal(afstandKm({ lat: 53.2489, lon: 6.6497 }, groningen), 0, 'Garmerwolde ligt in de gemeente');
  const steendam = afstandKm({ lat: 53.256, lon: 6.83 }, groningen);
  assert.ok(steendam > 3 && steendam < 7, `Steendam ligt er net buiten (${steendam} km)`);
  assert.equal(gemeente('Sudwest-Fryslan').naam, 'Súdwest-Fryslân', 'ook zonder accenten');
  assert.equal(gemeente('Nergenshuizen'), null);
});

test('signalen naar de regio: via de plek, de provincie en plaatsnamen; andere landelijke bronnen niet op plaatsnaam', () => {
  const opslag = new Opslag(mkdtempSync(path.join(tmpdir(), 'rc-signalen-')));
  opslag.bronnen.push({ id: 'landelijk-nieuws', naam: 'Landelijk nieuws', soort: 'nieuws', bereik: 'landelijk', type: 'rss', url: 'https://x/rss' });
  const nu = new Date().toISOString();
  const item = (sleutel, bron, extra) => {
    opslag.items[sleutel] = { sleutel, bron, regio: null, soort: extra.soort, titel: extra.titel, url: 'https://x', datum: nu.slice(0, 10), tekst: extra.tekst || null, eersteGezien: nu, laatstGezien: nu, basislijn: false, ...extra };
  };
  item('knmi-aardbevingen:a', 'knmi-aardbevingen', { soort: 'aardbeving', titel: 'Aardbeving van 1,6 bij Garmerwolde', plek: { lat: 53.2489, lon: 6.6497, naam: 'Garmerwolde' } });
  item('knmi-aardbevingen:b', 'knmi-aardbevingen', { soort: 'aardbeving', titel: 'Aardbeving van 2,0 bij Zeerijp', plek: { lat: 53.354, lon: 6.775, naam: 'Zeerijp' } });
  item('knmi-waarschuwingen:f', 'knmi-waarschuwingen', { soort: 'weerwaarschuwing', titel: 'Code oranje voor Friesland: zeer zware windstoten', provincies: ['Fryslân'] });
  item('raad-van-state:o', 'raad-van-state', { soort: 'uitspraak', titel: 'Raad van State (hoger beroep): besluit van de gemeente Opsterland', tekst: 'Bij besluit heeft de raad van de gemeente Opsterland het omgevingsplan voor een zonnepark bij Gorredijk vastgesteld.' });
  item('ransomware:t', 'ransomware', { soort: 'ransomware', titel: 'Ransomware-aanval: Thialf (x)', tekst: 'Thialf is an ice skating stadium based in Heerenveen, the Netherlands.' });
  item('landelijk-nieuws:d', 'landelijk-nieuws', { soort: 'nieuws', titel: 'Nieuws uit Drachten', tekst: 'Een bericht over Drachten.' });
  // De locatiezoeker vond de vestiging (src/locatie.mjs).
  item('ransomware:g', 'ransomware', { soort: 'ransomware', titel: 'Ransomware-aanval: Garage Bouma (x)', tekst: 'Garage Bouma', vestiging: { plaats: 'Gorredijk', gemeente: 'Opsterland', postcode: '8401 AB', bron: 'postcode op de contactpagina van garagebouma.nl', zeker: 0.75 } });

  const k = maakKader({ opslag });
  const route = (sleutel) => routeerItem(k, opslag.items[sleutel], k.bronnen.get(opslag.items[sleutel].bron)).map((r) => r.regio).sort();
  assert.deepEqual(route('knmi-aardbevingen:a'), ['groningen'], 'in de gemeente');
  assert.deepEqual(route('knmi-aardbevingen:b'), [], 'Zeerijp ligt verder dan 5 km van de gemeente');
  assert.deepEqual(route('knmi-waarschuwingen:f'), ['heerenveen', 'ooststellingwerf', 'opsterland', 'smallingerland', 'sudwestfryslan', 'weststellingwerf'], 'alle Friese regio\'s');
  assert.deepEqual(route('raad-van-state:o'), ['opsterland']);
  assert.deepEqual(route('ransomware:t'), ['heerenveen']);
  assert.deepEqual(route('ransomware:g'), ['opsterland'], 'via de vestiging');
  assert.deepEqual(route('landelijk-nieuws:d'), [], 'een gewone landelijke bron alleen via sleutelwoorden');

  // Sleutelwoorden bij een uitspraak alleen in titel en samenvatting: de volledige
  // tekst noemt ook de advocaten.
  opslag.regios = { heerenveen: { sleutelwoorden: [{ term: 'Heerenveen', actief: true }] } };
  item('raad-van-state:w', 'raad-van-state', { soort: 'uitspraak', titel: 'Raad van State (hoger beroep): jachtwerf in Warten', tekst: 'Een jachtwerf aan de [locatie] in Warten.', inhoud: 'Bijgestaan door mr. S. Maakal, advocaat in Heerenveen.' });
  assert.deepEqual(routeerItem(maakKader({ opslag }), opslag.items['raad-van-state:w'], k.bronnen.get('raad-van-state')), []);
  opslag.regios = {};

  // Uit voor een regio: dan ook niet via de plek.
  opslag.regios = { groningen: { landelijkUit: ['knmi-aardbevingen'] } };
  assert.deepEqual(routeerItem(maakKader({ opslag }), opslag.items['knmi-aardbevingen:a'], k.bronnen.get('knmi-aardbevingen')), []);
  opslag.regios = {};

  // In de feed onder Signalen, met de plek als reden.
  const sanne = nieuweGebruiker(opslag.instellingen, { naam: 'Sanne', email: 'sanne@lc.nl', regios: ['groningen', 'opsterland'] });
  opslag.gebruikers.push(sanne);
  const feed = bouwFeed(maakKader({ opslag }), sanne, {});
  assert.deepEqual(feed.items.filter((i) => i.groep === 'knmi').map((i) => i.id).sort(), ['i:knmi-aardbevingen:a', 'i:knmi-waarschuwingen:f'], 'aardbevingen en weer onder KNMI');
  assert.deepEqual(feed.items.filter((i) => i.groep === 'rvs').map((i) => i.id), ['i:raad-van-state:o']);
  assert.deepEqual([feed.tellingen.knmi, feed.tellingen.rvs, feed.tellingen.ransomware], [2, 1, 1]);
  const g = detail(maakKader({ opslag }), sanne, 'i:ransomware:g');
  assert.equal(g.meta.find((m) => m.k === 'Vestiging').v, 'Gorredijk (gemeente Opsterland), 8401 AB · volgens postcode op de contactpagina van garagebouma.nl');
  assert.deepEqual(g.treffers, [], 'geen "Waarom staat dit in je feed?": de vestiging staat al bij de gegevens');
  assert.equal(feed.items.find((i) => i.id === 'i:ransomware:g').titel, 'Ransomware-aanval: Garage Bouma (x)');
  const d = detail(maakKader({ opslag }), sanne, 'i:knmi-aardbevingen:a');
  assert.equal(d.soortNaam, 'Aardbeving');
  assert.deepEqual(d.treffers.map((t) => [t.term, t.regio, t.fragment.tekst]), [['Garmerwolde', 'groningen', 'Garmerwolde, in de gemeente Groningen']]);
});
