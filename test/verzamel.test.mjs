import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Opslag } from '../src/opslag.mjs';
import { verwerk, telAlsNieuw } from '../src/verzamel.mjs';
import { nieuweItems } from '../src/mail.mjs';

const leegOpslag = () => new Opslag(mkdtempSync(path.join(tmpdir(), 'rc-test-')));
const nu = new Date(2026, 9, 20, 10, 0);
const bron = { id: 'test-nieuws', regio: 'heerenveen', soort: 'nieuws' };

test('nulmeting: alleen de laatste twee dagen tellen als nieuw', () => {
  const opslag = leegOpslag();
  const { nieuw, eersteKeer } = verwerk(opslag, bron, [
    { sleutel: 'a', titel: 'Vandaag', datum: '2026-10-20' },
    { sleutel: 'b', titel: 'Eergisteren', datum: '2026-10-18' },
    { sleutel: 'c', titel: 'Vorige week', datum: '2026-10-13' },
    { sleutel: 'd', titel: 'Zonder datum', datum: null },
  ], nu);
  assert.equal(eersteKeer, true);
  assert.deepEqual(nieuw.map((i) => i.titel), ['Vandaag', 'Eergisteren']);
  assert.equal(opslag.items['test-nieuws:c'].basislijn, true);
  assert.equal(opslag.items['test-nieuws:d'].basislijn, true);
});

test('na de nulmeting: nieuw is wat nieuw verschijnt, behalve oude stukken (niet bij Woo)', () => {
  const opslag = leegOpslag();
  verwerk(opslag, bron, [{ sleutel: 'a', titel: 'Bestaand', datum: '2026-10-01' }], nu);
  opslag.status.bronnen[bron.id] = { ok: true, laatsteSucces: nu.toISOString() };

  const later = new Date(2026, 9, 21, 10, 0);
  const { nieuw } = verwerk(opslag, bron, [
    { sleutel: 'a', titel: 'Bestaand (titel aangepast)', datum: '2026-10-01' },
    { sleutel: 'e', titel: 'Nieuw', datum: '2026-10-21' },
    { sleutel: 'f', titel: 'Zonder datum', datum: null },
    { sleutel: 'g', titel: 'Ineens opgedoken, maar van juni', datum: '2026-06-01' },
  ], later);
  assert.deepEqual(nieuw.map((i) => i.titel), ['Nieuw', 'Zonder datum']);
  assert.equal(opslag.items['test-nieuws:a'].titel, 'Bestaand (titel aangepast)');
  assert.equal(opslag.items['test-nieuws:a'].eersteGezien, nu.toISOString(), 'eersteGezien blijft staan');

  // Een Woo-besluit van augustus dat pas in oktober online komt, is wel nieuws.
  assert.equal(telAlsNieuw({ datum: '2026-08-10' }, 'woo', false, later), true);
  assert.equal(telAlsNieuw({ datum: '2026-08-10' }, 'ingekomen', false, later), false);
});

test('de mail pakt alleen wat na de vorige mail voor het eerst is gezien', () => {
  const opslag = leegOpslag();
  const maak = (sleutel, regio, eersteGezien, extra = {}) => {
    opslag.items[sleutel] = { sleutel, regio, soort: 'nieuws', titel: sleutel, eersteGezien, basislijn: false, ...extra };
  };
  maak('oud', 'heerenveen', '2026-10-19T05:00:00.000Z');
  maak('nieuw', 'heerenveen', '2026-10-19T09:00:00.000Z');
  maak('basislijn', 'heerenveen', '2026-10-19T09:00:00.000Z', { basislijn: true });
  maak('andere-regio', 'opsterland', '2026-10-19T09:00:00.000Z');
  maak('na-de-mail', 'heerenveen', '2026-10-20T06:00:00.000Z');
  const items = nieuweItems(opslag, 'heerenveen', '2026-10-19T06:00:00.000Z', '2026-10-20T05:00:00.000Z');
  assert.deepEqual(items.map((i) => i.sleutel), ['nieuw']);
});
