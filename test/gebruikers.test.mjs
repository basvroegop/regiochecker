// Het datamodel van oktober 2026: de omzetting van ontvangers en kamertermen,
// inloggen via Authelia (wie is beheerder, wie is uitgenodigd) en de weekmail
// met een eigen schema per gebruiker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Opslag } from '../src/opslag.mjs';
import { herken, nieuweGebruiker, werkGebruikerBij } from '../src/gebruikers.mjs';
import { teMailen } from '../src/mail.mjs';
import { volgendeWeekmail } from '../src/planning.mjs';
import { alleRegios, alleBronnen, termenPerRegio, maakId } from '../src/register.mjs';

const tijdelijk = () => mkdtempSync(path.join(tmpdir(), 'rc-gebruikers-'));
const schrijf = (map, naam, data) => writeFileSync(path.join(map, `${naam}.json`), JSON.stringify(data));

test('omzetting: ontvangers worden gebruikers, kamertermen sleutelwoorden, meldingen horen bij een gebruiker', () => {
  const map = tijdelijk();
  schrijf(map, 'instellingen', { mailTijd: '08:30', mailDagen: [1, 4] });
  schrijf(map, 'status', { bronnen: {}, planningVanaf: '2026-10-01T00:00:00.000Z', laatsteMailronde: { tijd: '2026-10-26T07:30:00.000Z', resultaten: [] } });
  schrijf(map, 'ontvangers', [
    { id: 'o1', naam: 'Sanne', email: 'sanne@lc.nl', regios: ['smallingerland'], actief: true, laatsteMail: '2026-10-19T05:00:00.000Z', aangemaakt: '2026-10-01T00:00:00.000Z' },
    { id: 'o2', naam: 'Marrit', email: 'marrit@dvhn.nl', regios: ['groningen'], actief: false, laatsteMail: null },
  ]);
  schrijf(map, 'kamertermen', { smallingerland: ['Drachten', 'N31'], opsterland: [] });
  schrijf(map, 'meldingen', [
    { id: 'm1', naam: 'Zorg', email: 'sanne@lc.nl', termen: ['ziekenhuis'], frequentie: 'direct', actief: true, aangemaakt: '2026-10-02T00:00:00.000Z', laatsteMelding: null },
    { id: 'm2', email: 'nieuw@example.nl', termen: ['Thialf'], frequentie: 'dagelijks', actief: true, aangemaakt: '2026-10-02T00:00:00.000Z' },
  ]);

  const opslag = new Opslag(map);
  const [sanne, marrit, nieuw] = opslag.gebruikers;
  assert.equal(opslag.gebruikers.length, 3);
  assert.equal(sanne.id, 'o1');
  assert.equal(sanne.login, null);
  assert.equal(sanne.rol, 'journalist');
  assert.equal(sanne.titel, 'LC');
  assert.deepEqual(sanne.regios, ['smallingerland']);
  assert.deepEqual(sanne.weekmail, { aan: true, dagen: [1, 4], tijd: '08:30', ookLeeg: false });
  assert.equal(sanne.laatsteMail, '2026-10-19T05:00:00.000Z');
  // Het oude schema blijft gelden: geen mail dubbel of te vroeg.
  assert.equal(sanne.weekmailVanaf, '2026-10-01T00:00:00.000Z');
  assert.equal(sanne.laatsteWeekronde, '2026-10-26T07:30:00.000Z');
  assert.equal(marrit.titel, 'DVHN', 'dvhn in het adres: titel DVHN');
  assert.equal(marrit.weekmail.aan, false, 'een inactieve ontvanger krijgt geen weekmail');
  assert.equal(nieuw.email, 'nieuw@example.nl');
  assert.equal(nieuw.weekmail.aan, false);

  assert.deepEqual(opslag.regios.smallingerland.sleutelwoorden, [{ term: 'Drachten', actief: true }, { term: 'N31', actief: true }]);
  assert.equal(opslag.regios.opsterland, undefined);

  const [m1, m2] = opslag.meldingen;
  assert.deepEqual({ ...m1 }, { id: 'm1', naam: 'Zorg', termen: ['ziekenhuis'], frequentie: 'direct', actief: true, aangemaakt: '2026-10-02T00:00:00.000Z', laatsteMelding: null, gebruiker: 'o1', bereik: 'overal', bronnen: 'kamerstuk', tijd: '08:30' });
  assert.equal(m2.gebruiker, nieuw.id);

  for (const naam of ['gebruikers', 'regios', 'meldingen', 'ontvangers', 'kamertermen']) assert.ok(existsSync(path.join(map, `${naam}.json`)), naam);
  // Nog een keer openen: niets dubbel.
  const opnieuw = new Opslag(map);
  assert.equal(opnieuw.gebruikers.length, 3);
  assert.equal(opnieuw.meldingen[0].gebruiker, 'o1');
});

test('inloggen: de eerste wordt beheerder, een uitnodiging koppelt op e-mail, de rest heeft geen toegang', () => {
  const opslag = new Opslag(tijdelijk());
  opslag.gebruikers.push(nieuweGebruiker(opslag.instellingen, { naam: 'Sanne', email: 'sanne@lc.nl', regios: ['smallingerland'] }));

  const jan = herken(opslag, { login: 'jan', email: 'jan@example.nl', naam: 'Jan' });
  assert.equal(jan.rol, 'admin');
  assert.equal(jan.login, 'jan');
  assert.ok(jan.laatstActief);
  assert.equal(opslag.gebruikers.length, 2);

  assert.equal(herken(opslag, { login: 'pieter', email: 'pieter@lc.nl' }), null, 'niet uitgenodigd');
  assert.equal(herken(opslag, { login: '' }), null);

  const sanne = herken(opslag, { login: 'SANNE', email: 'Sanne@LC.nl' });
  assert.equal(sanne.login, 'sanne');
  assert.equal(sanne.rol, 'journalist');
  assert.equal(herken(opslag, { login: 'sanne' }).id, sanne.id, 'daarna op inlognaam');
  assert.equal(opslag.gebruikers.length, 2);

  const regioIds = alleRegios(opslag).map((r) => r.id);
  assert.throws(() => werkGebruikerBij(opslag, sanne, { regios: ['nergens'] }, { regioIds }), /Onbekende regio: nergens/);
  assert.throws(() => werkGebruikerBij(opslag, jan, { rol: 'journalist' }, { beheer: true, regioIds }), /minstens één beheerder/);
  assert.throws(() => werkGebruikerBij(opslag, sanne, { email: 'jan@example.nl' }, { beheer: true, regioIds }), /staat er al in/);
  // Zonder beheerrechten blijven rol en titel staan.
  werkGebruikerBij(opslag, sanne, { rol: 'admin', titel: 'DVHN', regios: ['heerenveen', 'smallingerland'] }, { regioIds });
  assert.equal(sanne.rol, 'journalist');
  assert.equal(sanne.titel, 'LC');
  assert.deepEqual(sanne.regios, ['heerenveen', 'smallingerland']);
  // Een nieuw schema geldt vanaf nu.
  sanne.weekmailVanaf = '2000-01-01T00:00:00.000Z';
  werkGebruikerBij(opslag, sanne, { weekmail: { dagen: [2, 2, 5], tijd: '06:45' } }, { regioIds });
  assert.deepEqual(sanne.weekmail, { aan: true, dagen: [2, 5], tijd: '06:45', ookLeeg: false });
  assert.notEqual(sanne.weekmailVanaf, '2000-01-01T00:00:00.000Z');
  assert.throws(() => werkGebruikerBij(opslag, sanne, { weekmail: { tijd: '25:00' } }, { regioIds }), /UU:MM/);

  // De inlognaam van de laatste beheerder leegmaken mag niet: dan zou de
  // eerstvolgende onbekende die door Authelia komt beheerder worden.
  assert.throws(() => werkGebruikerBij(opslag, jan, { login: '' }, { beheer: true, regioIds }), /minstens één beheerder met een inlognaam/);
  assert.equal(jan.login, 'jan');
  // En verdwijnen de beheerders toch (een bewerkt bestand), dan gaat die deur niet meer open.
  assert.ok(opslag.status.beheerGestart);
  opslag.gebruikers = opslag.gebruikers.filter((x) => x.id !== jan.id);
  assert.equal(herken(opslag, { login: 'onbekend', email: 'iemand@example.nl' }), null, 'geen automatische beheerder meer');
});

test('weekmail: iedere gebruiker op eigen dagen en tijd', () => {
  const opslag = new Opslag(tijdelijk());
  const g = (naam, weekmail, regios = ['heerenveen']) => {
    const x = nieuweGebruiker(opslag.instellingen, { naam, email: `${naam}@lc.nl`, regios, weekmail, weekmailVanaf: '2026-10-01T00:00:00.000Z' });
    opslag.gebruikers.push(x);
    return x;
  };
  const maandag = g('maandag', { aan: true, dagen: [1], tijd: '07:00' });
  const donderdag = g('donderdag', { aan: true, dagen: [4], tijd: '08:00' });
  // Vorige week gingen beide al; anders halen ze die week eerst in.
  maandag.laatsteWeekronde = new Date(2026, 9, 19, 7, 0).toISOString();
  donderdag.laatsteWeekronde = new Date(2026, 9, 22, 8, 0).toISOString();
  g('uit', { aan: false, dagen: [1], tijd: '07:00' });
  g('zonder-regio', { aan: true, dagen: [1], tijd: '07:00' }, []);

  const ma = new Date(2026, 9, 26, 7, 5);
  assert.deepEqual(teMailen(opslag, ma).map((x) => x.naam), ['maandag']);
  maandag.laatsteWeekronde = ma.toISOString();
  assert.deepEqual(teMailen(opslag, ma), [], 'afgehandeld');
  const doVroeg = new Date(2026, 9, 29, 7, 30);
  assert.deepEqual(teMailen(opslag, doVroeg).map((x) => x.naam), [], 'nog niet');
  const doLaat = new Date(2026, 9, 29, 8, 1);
  assert.deepEqual(teMailen(opslag, doLaat).map((x) => x.naam), ['donderdag']);
  // Gemist (dienst stond uit) wordt ingehaald, maar niets van vóór weekmailVanaf.
  donderdag.laatsteWeekronde = null;
  donderdag.weekmailVanaf = new Date(2026, 9, 29, 9, 0).toISOString();
  assert.deepEqual(teMailen(opslag, new Date(2026, 9, 30, 12, 0)), []);
  assert.equal(volgendeWeekmail(new Date(2026, 9, 30, 12, 0), donderdag).getTime(), new Date(2026, 10, 5, 8, 0).getTime());
});

test('register: ingebouwde en zelf toegevoegde regio\'s en bronnen, sleutelwoorden per landelijke bron', () => {
  const opslag = new Opslag(tijdelijk());
  opslag.regios = {
    leeuwarden: { naam: 'Leeuwarden', eigen: true, sleutelwoorden: [{ term: 'Leeuwarden', actief: true }] },
    heerenveen: { sleutelwoorden: [{ term: 'Thialf', actief: true }, { term: 'IJsstadion', actief: false }], landelijkUit: ['tweede-kamer'] },
  };
  opslag.bronnen = [{ id: 'rijk', naam: 'Rijksoverheid', soort: 'nieuws', bereik: 'landelijk', type: 'rss', url: 'https://x' }];
  const regios = alleRegios(opslag);
  assert.equal(regios.length, 8);
  assert.deepEqual(regios.map((r) => r.naam).slice(0, 3), ['Groningen', 'Heerenveen', 'Leeuwarden'], 'op naam');
  assert.ok(alleBronnen(opslag).some((b) => b.id === 'tweede-kamer' && b.bereik === 'landelijk'));
  assert.ok(alleBronnen(opslag).some((b) => b.id === 'heerenveen-ingekomen' && b.ingebouwd && b.naam === 'Heerenveen · Ingekomen stukken 2026-2030 (iBabs)'));
  assert.deepEqual(termenPerRegio(opslag, 'tweede-kamer').map((r) => [r.regio.id, r.termen]), [['leeuwarden', ['Leeuwarden']]]);
  assert.deepEqual(termenPerRegio(opslag, 'rijk').map((r) => [r.regio.id, r.termen]), [['heerenveen', ['Thialf']], ['leeuwarden', ['Leeuwarden']]]);
  assert.equal(maakId('Súdwest-Fryslân', new Set(['sudwest-fryslan'])), 'sudwest-fryslan-2');
});
