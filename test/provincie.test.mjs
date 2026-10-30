// Bekendmakingen van de provincie Fryslân (src/bronnen/provincie.mjs), met
// echte weekpagina's van fryslan.frl (ingekort tot de inhoud): het lezen, de
// koppen, het archief vanaf januari, en dat een bekendmaking voor een gemeente
// die een regio is, een stuk van die regio wordt (feed, weekmail, zoeken).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MockAgent } from 'undici';
import { leesWeek, gemeentenIn, bekendmakingTitel, wekenInIndex, haalBekendmakingen, datumVanSlug } from '../src/bronnen/provincie.mjs';
import { zetOpenbaarDispatcher } from '../src/netwerk.mjs';
import { Opslag } from '../src/opslag.mjs';
import { alleBronnen } from '../src/register.mjs';
import { verwerk } from '../src/verzamel.mjs';
import { maakKader, bouwFeed, detail, zoekFeed } from '../src/feed.mjs';
import { stelMailSamen } from '../src/mail.mjs';
import { nieuweGebruiker } from '../src/gebruikers.mjs';

process.env.PROVINCIE_WACHT_MS = '0';
const fixture = (naam) => readFileSync(new URL(`./fixtures/${naam}`, import.meta.url), 'utf8');
const week = (d) => leesWeek(fixture(`fryslan-${d}.html`), `https://www.fryslan.frl/${d}`);

test('provincie Fryslân: een weekpagina lezen, per gemeente en de rest', () => {
  const stukken = week('24-oktober-2026');
  assert.deepEqual(stukken.map((s) => [s.gemeenten || [], s.titel]), [
    [[], 'Brug Warns afgesloten van 2 t/m 6 november'],
    [[], 'Vastgoed – bekendmaking 24-10-2026'],
    [[], 'Hoe houden we voorzieningen in onze dorpen beschikbaar en bereikbaar?'],
    [['De Fryske Marren'], 'Aanvraag vergunning Omgevingswet: het uitvoeren van kadewerk en bijbehorende werkzaamheden (Troelstraweg te Idskenhuizen)'],
    [['Noardeast-Fryslân'], 'Aanvraag vergunning Omgevingswet: aanleg verbindingsweg tussen de Kleasterdyk en Wirdsterterp (Kleasterdyk en Wirdsterterp te Wânswert)'],
    [['Smallingerland'], 'Beschikking Omgevingswet: voor het legaliseren van een aantal al aangelegde nieuwe watergangen en al verbrede… (Achter Folgeren 20 tot en met 40… te Drachten)'],
    [['Tytsjerksteradiel'], 'Aanvraag vergunning Omgevingswet: woningbouwuitbreiding in een grondwaterbeschermingsgebied (grondwaterbeschermingsgebied Noordbergum)'],
    [[], 'Kennisgeving omgevingsvergunning Natura 2000-activiteit Omgevinsgwet: Tolleane 3a te Wijnjewoude'],
  ], 'het nieuws van de provincie, de gemeenteblokken, en het blok van de provincie zelf; niet "Hieronder vind u…" en de contactgegevens');
  const drachten = stukken[5];
  assert.equal(drachten.url, 'https://www.fryslan.frl/24-oktober-2026#gemeente-smallingerland');
  assert.equal(drachten.datum, '2026-10-24');
  assert.equal(drachten.soortStuk, 'Beschikking Omgevingswet');
  assert.match(drachten.tekst, /Betreft: voor het legaliseren van een aantal al aangelegde nieuwe watergangen en al verbrede bestaande watergangen/, 'de over alinea\'s gebroken zin weer heel');
  assert.match(drachten.tekst, /\n\nKenmerk: 2026-FUMO-0119170\.\n\n/);
  assert.match(stukken[1].tekst, /• 11040: de verhuur van de ondergrond van een steiger .* te Heerenveen/, 'een opsomming');

  // Een blok zonder eigen kopjes is één bekendmaking; twee in één gemeenteblok zijn er twee.
  const okt17 = week('17-oktober-2026');
  assert.ok(okt17.some((s) => s.titel === 'Generieke TUG ontheffing Wet luchtvaart' && !s.gemeenten));
  assert.equal(okt17.filter((s) => s.gemeenten?.includes('Smallingerland')).length, 2);
  // Een blok voor twee gemeenten.
  assert.ok(week('1-augustus-2026').some((s) => s.gemeenten?.join() === 'Leeuwarden,Tytsjerksteradiel'));
  // Tot eind mei alleen stukken van de provincie zelf.
  assert.deepEqual(week('7-maart-2026').map((s) => [s.titel, s.gemeenten]), [['Vastgoed – bekendmaking 07-03-2026', undefined]]);
  // Elke sleutel uniek.
  const alle = ['24-oktober-2026', '17-oktober-2026', '1-augustus-2026', '7-maart-2026'].flatMap(week);
  assert.equal(new Set(alle.map((s) => s.sleutel)).size, alle.length);

  assert.deepEqual(['Gemeente Smallingerland', 'Gemeentes Achtkarspelen', 'Gemeente de Fryske Marren', 'Gemeente Súdwest-Fryslân', 'Gemeente Leeuwarden en Tytsjerksteradiel', 'Provincie Fryslân', 'Diverse Natura 2000-gebieden'].map(gemeentenIn), [
    ['Smallingerland'], ['Achtkarspelen'], ['De Fryske Marren'], ['Súdwest-Fryslân'], ['Leeuwarden', 'Tytsjerksteradiel'], [], [],
  ]);
  const r = (...t) => t.map((tekst) => ({ tekst, kop: false }));
  assert.equal(bekendmakingTitel('Kennisgeving omgevingsvergunning flora- en fauna-activiteit Omgevingswet', r('Gedeputeerde Staten hebben een omgevingsvergunning flora- en fauna-activiteit verleend ten behoeve van dakwerkzaamheden aan meerdere woningen in Workum (gewone dwergvleermuis).')),
    'Kennisgeving omgevingsvergunning flora- en fauna-activiteit Omgevingswet: dakwerkzaamheden aan meerdere woningen in Workum');
  assert.equal(bekendmakingTitel('Beschikking Omgevingswet', r('Betreft: het realiseren van een insteekhaven aan de Marderleane 43 te Rijs.', 'Locatie: Marderleane 43 te Rijs, gemeente De Fryske Marren.')),
    'Beschikking Omgevingswet: het realiseren van een insteekhaven aan de Marderleane 43 te Rijs', 'de locatie niet dubbel');
  assert.equal(bekendmakingTitel('Melding bodemsanering', r('Ontvangen is de volgende melding.', 'Locatie: Lemmerweg 47 te Sneek, gemeente Súdwest-Fryslân.')), 'Melding bodemsanering: Lemmerweg 47 te Sneek');
});

test('provincie Fryslân: de eerste keer alles sinds januari, daarna de nieuwste weken', async () => {
  assert.equal(datumVanSlug('/3-januari-2026'), '2026-01-03');
  assert.deepEqual(wekenInIndex(fixture('fryslan-bekendmakingen-2026.html'), 'https://www.fryslan.frl/').slice(0, 2), ['https://www.fryslan.frl/24-oktober-2026', 'https://www.fryslan.frl/17-oktober-2026']);
  const nep = new MockAgent();
  nep.disableNetConnect();
  const bezocht = [];
  const pagina = (d) => ({ statusCode: 200, data: fixture(`fryslan-${d}.html`), responseOptions: { headers: { 'content-type': 'text/html' } } });
  nep.get('https://www.fryslan.frl').intercept({ path: () => true, method: 'GET' }).reply(({ path: pad }) => {
    bezocht.push(pad);
    if (pad === '/bekendmakingen-2026') return pagina('bekendmakingen-2026');
    const d = pad.slice(1);
    if (['24-oktober-2026', '17-oktober-2026', '1-augustus-2026', '7-maart-2026'].includes(d)) return pagina(d);
    return { statusCode: 404, data: 'niet gevonden' };
  }).persist();
  const vorige = zetOpenbaarDispatcher(nep);
  try {
    const bron = alleBronnen(new Opslag(mkdtempSync(path.join(tmpdir(), 'rc-prov-')))).find((b) => b.id === 'provincie-fryslan-bekendmakingen');
    const nu = new Date('2026-10-30T09:00:00Z');
    const eerste = await haalBekendmakingen(bron, { eersteKeer: true, nu });
    assert.ok(bezocht.includes('/3-januari-2026') && bezocht.includes('/7-maart-2026') && bezocht.includes('/31-oktober-2026'), 'elke zaterdag sinds januari, en komende zaterdag');
    assert.equal(new Set(bezocht).size, bezocht.length, 'elke pagina één keer');
    assert.equal(eerste.length, 8 + 10 + 11 + 1);
    bezocht.length = 0;
    const later = await haalBekendmakingen(bron, { nu });
    assert.deepEqual(bezocht.sort(), ['/10-oktober-2026', '/17-oktober-2026', '/24-oktober-2026', '/31-oktober-2026', '/bekendmakingen-2026'].sort(), 'de index, de drie nieuwste weken en komende zaterdag');
    assert.equal(later.length, 8 + 10);
  } finally {
    zetOpenbaarDispatcher(vorige);
  }
});

test('provincie Fryslân: de eerste ronde zet de laatste dertig dagen in de feed, op hun eigen datum', () => {
  const opslag = new Opslag(mkdtempSync(path.join(tmpdir(), 'rc-prov-')));
  const bron = alleBronnen(opslag).find((b) => b.id === 'provincie-fryslan-bekendmakingen');
  const nu = new Date('2026-10-30T09:00:00Z');
  const { nieuw } = verwerk(opslag, bron, [...week('24-oktober-2026'), ...week('1-augustus-2026')], nu);
  const items = Object.values(opslag.items);
  const van = (datum) => items.filter((i) => i.datum === datum);
  assert.ok(van('2026-10-24').every((i) => !i.basislijn && i.eersteGezien === '2026-10-24T12:00:00.000Z'));
  assert.ok(van('2026-08-01').every((i) => i.basislijn), 'ouder dan dertig dagen: nulmeting (wel doorzoekbaar)');
  assert.equal(nieuw.length, van('2026-10-24').length);
});

test('provincie Fryslân: een bekendmaking voor een regiogemeente is een stuk van die regio; de rest gaat via sleutelwoorden', async () => {
  const opslag = new Opslag(mkdtempSync(path.join(tmpdir(), 'rc-prov-')));
  const bron = alleBronnen(opslag).find((b) => b.id === 'provincie-fryslan-bekendmakingen');
  opslag.status.bronnen[bron.id] = { ok: true, laatsteSucces: '2026-10-01T00:00:00Z' };
  const stukken = [...week('24-oktober-2026'), ...week('17-oktober-2026')];
  // Een (verzonnen) blok voor twee regiogemeenten: een stuk per regio.
  stukken.push({ ...stukken[5], sleutel: 'x:twee', titel: 'Voor Heerenveen en Opsterland', gemeenten: ['Heerenveen', 'Opsterland'] });
  verwerk(opslag, bron, stukken);
  const items = Object.values(opslag.items);
  const regioVan = (titel) => items.filter((i) => i.titel === titel).map((i) => i.regio);
  assert.deepEqual(regioVan(stukken[5].titel), ['smallingerland']);
  assert.deepEqual(regioVan('Voor Heerenveen en Opsterland').sort(), ['heerenveen', 'opsterland']);
  assert.deepEqual(regioVan(stukken[3].titel), [null], 'De Fryske Marren is geen regio');
  assert.deepEqual(regioVan('Brug Warns afgesloten van 2 t/m 6 november'), [null]);

  // Súdwest-Fryslân volgt "Warns" als sleutelwoord.
  opslag.regios = { sudwestfryslan: { sleutelwoorden: [{ term: 'Warns', actief: true }] } };
  const sanne = nieuweGebruiker(opslag.instellingen, { naam: 'Sanne', email: 'sanne@lc.nl', regios: ['smallingerland', 'sudwestfryslan'] });
  const gert = nieuweGebruiker(opslag.instellingen, { naam: 'Gert', email: 'gert@dvhn.nl', regios: ['groningen'] });
  opslag.gebruikers.push(sanne, gert);
  const k = maakKader({ opslag });
  const feed = bouwFeed(k, sanne, {});
  const bekend = feed.items.filter((i) => i.groep === 'bekendmaking');
  assert.deepEqual(bekend.map((i) => [i.regioNaam, i.titel.slice(0, 40)]).sort(), [
    ['Smallingerland', 'Aanvraag vergunning Omgevingswet: gefase'],
    ['Smallingerland', 'Aanvraag vergunning Omgevingswet: natuur'],
    ['Smallingerland', 'Beschikking Omgevingswet: voor het legal'],
    ['Súdwest-Fryslân', 'Brug Warns afgesloten van 2 t/m 6 novemb'],
  ]);
  assert.equal(feed.tellingen.bekendmaking, 4);
  // Een bekendmaking van de regio zelf: geen landelijk stuk, dus geen "Waarom".
  const d = detail(k, sanne, bekend.find((i) => i.regioNaam === 'Smallingerland').id);
  assert.deepEqual([d.landelijk, d.soortNaam, d.treffers.length], [false, 'Bekendmaking', 0]);
  const warns = detail(k, sanne, bekend.find((i) => i.regioNaam === 'Súdwest-Fryslân').id);
  assert.deepEqual([warns.landelijk, warns.treffers[0].term], [true, 'Warns']);
  assert.deepEqual(bouwFeed(k, gert, {}).items.filter((i) => i.groep === 'bekendmaking'), []);

  // De weekmail: een kopje Bekendmakingen bij Smallingerland, niet bij Groningen.
  const sinds = new Date(Date.now() - 86400000).toISOString();
  const mail = await stelMailSamen(opslag, sanne, { sinds, samenvatting: false });
  assert.match(mail.tekst, /-- Bekendmakingen \(3\) --/);
  assert.match(mail.tekst, /Brug Warns afgesloten/, 'en bij Súdwest-Fryslân onder de landelijke bronnen');
  assert.doesNotMatch((await stelMailSamen(opslag, gert, { sinds, samenvatting: false })).tekst, /Bekendmakingen/);

  // Zoeken vindt ook wat bij de eerste ronde al bestond, op de datum van het stuk.
  const oud = Object.values(opslag.items).find((i) => i.regio === 'smallingerland');
  oud.basislijn = true;
  const gevonden = zoekFeed(k, sanne, 'Vrijburgh').items.find((i) => i.id === `i:${oud.sleutel}`);
  assert.deepEqual([gevonden?.tijd, gevonden?.tijdBekend], ['2026-10-24T12:00:00.000Z', false]);
});
