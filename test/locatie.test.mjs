// Waar een ransomwareslachtoffer gevestigd is (src/locatie.mjs), tegen een
// nagebootste PDOK Locatieserver, OpenStreetMap en bedrijfswebsites.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent } from 'undici';
import { zetOpenbaarDispatcher } from '../src/netwerk.mjs';

process.env.NOMINATIM_WACHT_MS = '0';
const { vindVestiging, lijkt, domeinVan } = await import('../src/locatie.mjs');

const POSTCODES = {
  '8441AB': { woonplaatsnaam: 'Heerenveen', gemeentenaam: 'Heerenveen', provincienaam: 'Fryslân', centroide_ll: 'POINT(5.92 52.96)' },
  '9201AA': { woonplaatsnaam: 'Drachten', gemeentenaam: 'Smallingerland', provincienaam: 'Fryslân' },
  '8501AB': { woonplaatsnaam: 'Joure', gemeentenaam: 'De Fryske Marren', provincienaam: 'Fryslân' },
};
const treffer = (naam, adres) => ({ name: naam, namedetails: { name: naam }, address: adres, lat: '53.1', lon: '6.1' });
const OSM = {
  'Bakkerij Visser': [
    treffer('Bakkerij Visser', { town: 'Drachten', municipality: 'Smallingerland', state: 'Fryslân', postcode: '9201 AA' }),
    treffer('Visser Schoenen', { town: 'Sneek', municipality: 'Súdwest-Fryslân', state: 'Fryslân' }),
  ],
  Makro: [treffer('Makro', { city: 'Amsterdam', municipality: 'Amsterdam' }), treffer('Makro', { town: 'Nuth', municipality: 'Beekdaelen' })],
  Omrin: [treffer('Omrin', { village: 'Nijemirdum', municipality: 'De Friese Meren', postcode: '8501 AB' })],
};

function nepInternet() {
  const nep = new MockAgent();
  nep.disableNetConnect();
  const bezocht = [];
  nep.get(() => true).intercept({ path: () => true, method: () => true }).reply(({ origin, path }) => {
    const u = new URL(path, origin);
    bezocht.push(`${u.host}${u.pathname}`);
    const json = (d) => ({ statusCode: 200, data: JSON.stringify(d), responseOptions: { headers: { 'content-type': 'application/json' } } });
    const html = (d) => ({ statusCode: 200, data: d, responseOptions: { headers: { 'content-type': 'text/html' } } });
    if (u.host === 'api.pdok.nl') return json({ response: { docs: POSTCODES[u.searchParams.get('q')] ? [POSTCODES[u.searchParams.get('q')]] : [] } });
    if (u.host === 'nominatim.openstreetmap.org') return json(OSM[u.searchParams.get('q')] || []);
    if (u.host === 'garagehoekstra.nl' && u.pathname === '/') return html('<title>Garage Hoekstra | APK</title><a href="/over-ons/contact">Contact</a> Bel 0513-123456');
    if (u.host === 'garagehoekstra.nl' && u.pathname === '/over-ons/contact') return html('<p>Dorpsstraat 1<br>8501 AB Joure</p><footer>8501 AB Joure</footer><p>Postbus 12, 9201 AA Drachten</p>');
    return { statusCode: 404, data: 'niet gevonden' };
  }).persist();
  const vorige = zetOpenbaarDispatcher(nep);
  return { bezocht, herstel: () => zetOpenbaarDispatcher(vorige) };
}

test('vestiging: postcode, beschrijving, OpenStreetMap op naam, de eigen website, en onzeker bij twijfel', async () => {
  assert.ok(lijkt('Bakkerij Visser B.V.', 'Bakkerij Visser') > 0.9);
  assert.ok(lijkt('Bakkerij Visser', 'Visser Schoenen') < 0.6);
  assert.equal(domeinVan('https://www.garagehoekstra.nl/'), 'garagehoekstra.nl');
  assert.equal(domeinVan('Garage Hoekstra'), null);

  const net = nepInternet();
  try {
    // Wat de checker al vond: een postcode, via PDOK naar woonplaats en gemeente.
    assert.deepEqual(await vindVestiging({ naam: 'Iets', hint: { postcode: '8441 AB', bron: 'checker, website-contact' } }), {
      postcode: '8441 AB', plaats: 'Heerenveen', gemeente: 'Heerenveen', provincie: 'Fryslân', lat: 52.96, lon: 5.92, bron: 'postcode (checker, website-contact)', zeker: 0.8,
    });
    // De beschrijving noemt de plaats: dan niets opzoeken.
    const voor = net.bezocht.length;
    const thialf = await vindVestiging({ naam: 'Thialf', beschrijving: 'Thialf is an ice skating stadium based in Heerenveen, the Netherlands.' });
    assert.deepEqual([thialf.gemeente, thialf.bron], ['Heerenveen', 'de beschrijving']);
    assert.equal(net.bezocht.length, voor);

    // Op naam: alleen een treffer die op de naam lijkt.
    const visser = await vindVestiging({ naam: 'Bakkerij Visser' });
    assert.deepEqual([visser.plaats, visser.gemeente, visser.bron], ['Drachten', 'Smallingerland', 'OpenStreetMap']);
    // OpenStreetMap kent de gemeente onder een andere naam: de officiële via de postcode.
    assert.equal((await vindVestiging({ naam: 'Omrin' })).gemeente, 'De Fryske Marren');

    // Niets op naam: de contactpagina van de eigen site, de postcode die het vaakst staat.
    const garage = await vindVestiging({ naam: 'Garage Hoekstra', website: 'garagehoekstra.nl' });
    assert.deepEqual([garage.plaats, garage.gemeente, garage.postcode, garage.bron], ['Joure', 'De Fryske Marren', '8501 AB', 'postcode op de contactpagina van garagehoekstra.nl']);

    // Twee gemeenten: onzeker, dus naar geen enkele regio.
    const makro = await vindVestiging({ naam: 'Makro' });
    assert.equal(makro.onzeker, true);
    assert.deepEqual(makro.kandidaten.map((k) => k.gemeente).sort(), ['Amsterdam', 'Beekdaelen']);
    // Een plaats die de checker vond, als laatste redmiddel.
    assert.deepEqual([(await vindVestiging({ naam: 'Onbekend Bedrijf', hint: { plaats: 'Gorredijk', bron: 'checker' } })).gemeente], ['Opsterland']);
    assert.equal(await vindVestiging({ naam: 'Onbekend Bedrijf' }), null);
  } finally {
    net.herstel();
  }
});
