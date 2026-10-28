import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vorigMoment, volgendMoment, moetMailen } from '../src/planning.mjs';

const wekelijks = { mailTijd: '07:00', mailDagen: [1] }; // maandag 07:00
const ma = (d, u = 7, m = 0) => new Date(2026, 9, d, u, m); // oktober 2026; 19 en 26 zijn maandagen

test('vorig en volgend moment bij een wekelijkse mail', () => {
  assert.deepEqual(vorigMoment(ma(21, 12), wekelijks), ma(19));
  assert.deepEqual(volgendMoment(ma(21, 12), wekelijks), ma(26));
  assert.deepEqual(volgendMoment(ma(19, 6, 59), wekelijks), ma(19));
  assert.deepEqual(volgendMoment(ma(19, 7, 0), wekelijks), ma(26));
  assert.equal(volgendMoment(ma(19), { mailTijd: '07:00', mailDagen: [] }), null);
});

test('op het moment zelf mailen, en daarna niet nog eens', () => {
  const status = { planningVanaf: ma(12).toISOString(), laatsteMailronde: { tijd: ma(12, 7, 1).toISOString() } };
  assert.equal(moetMailen(ma(19, 6, 59), wekelijks, status), false);
  assert.equal(moetMailen(ma(19, 7, 0), wekelijks, status), true);
  status.laatsteMailronde = { tijd: ma(19, 7, 2).toISOString() };
  assert.equal(moetMailen(ma(19, 8), wekelijks, status), false);
  assert.equal(moetMailen(ma(25, 23), wekelijks, status), false);
});

test('een gemist moment wordt ingehaald, ook dagen later', () => {
  // Dienst lag eruit van zondag tot dinsdagmiddag.
  const status = { planningVanaf: ma(5).toISOString(), laatsteMailronde: { tijd: ma(12, 7, 1).toISOString() } };
  assert.equal(moetMailen(ma(20, 15), wekelijks, status), true);
});

test('na een nieuw schema niet meteen een "gemist" moment versturen', () => {
  // Woensdag verzet naar maandag 07:00: die maandag lag vóór de wijziging.
  const status = { planningVanaf: ma(21, 10).toISOString(), laatsteMailronde: null };
  assert.equal(moetMailen(ma(21, 10, 1), wekelijks, status), false);
  assert.equal(moetMailen(ma(26, 7, 0), wekelijks, status), true);
});
