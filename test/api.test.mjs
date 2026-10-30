// De API achter de webUI: wat een journalist mag en wat alleen een beheerder,
// en de beheerschermen (regio's, sleutelwoorden, gebruikers, bronnen met
// proefronde). Zonder echte server: src/api.mjs met een nagebootst verzoek.
// node:sqlite zit in Node 22+; op een oudere Node worden deze tests overgeslagen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Opslag } from '../src/opslag.mjs';
import { herken, nieuweGebruiker } from '../src/gebruikers.mjs';
import { roep } from './api-hulp.mjs';

// Nagebootste servers draaien op 127.0.0.1; dat is normaal niet toegestaan (src/netwerk.mjs).
process.env.REGIOCHECKER_PRIVE_ADRESSEN = '1';

const sqlite = await import('node:sqlite').catch(() => null);
const metSqlite = { skip: sqlite ? false : 'node:sqlite niet beschikbaar (Node 22+ nodig)' };
const tijdelijk = () => mkdtempSync(path.join(tmpdir(), 'rc-api-'));

async function opzet() {
  const { openFeedDb } = await import('../src/feeddb.mjs');
  const map = tijdelijk();
  const opslag = new Opslag(map);
  const fdb = await openFeedDb(path.join(map, 'f.sqlite'));
  opslag.feeddb = fdb;
  const jan = herken(opslag, { login: 'jan', email: 'jan@example.nl', naam: 'Jan' });
  const sanne = nieuweGebruiker(opslag.instellingen, { login: 'sanne', naam: 'Sanne', email: 'sanne@lc.nl', regios: ['heerenveen'] });
  opslag.gebruikers.push(sanne);
  opslag.items['heerenveen-nieuws:1'] = {
    sleutel: 'heerenveen-nieuws:1', bron: 'heerenveen-nieuws', regio: 'heerenveen', soort: 'nieuws', titel: 'Thialf krijgt nieuw dak',
    url: 'https://www.heerenveen.nl/nieuws/1', datum: '2026-10-27', eersteGezien: new Date(Date.now() - 3600000).toISOString(), basislijn: false,
  };
  return { opslag, fdb, jan, sanne, ctx: { opslag, kdb: null, fdb } };
}

test('journalist: eigen feed, regio\'s en weekmail; geen beheer', metSqlite, async () => {
  const { ctx, sanne, jan, opslag } = await opzet();
  let r = await roep(ctx, sanne, 'GET', '/api/ik');
  assert.equal(r.data.beheerder, false);
  assert.equal(r.data.gebruiker.titel, 'LC');
  assert.equal(r.data.regios.length, 7);
  assert.equal(r.data.gebruiker.weekmailVanaf, undefined, 'interne planning blijft binnen');

  r = await roep(ctx, sanne, 'GET', '/api/feed');
  assert.deepEqual(r.data.items.map((i) => i.titel), ['Thialf krijgt nieuw dak']);
  r = await roep(ctx, sanne, 'PUT', '/api/stuk', { id: 'i:heerenveen-nieuws:1', bewaard: true, gelezen: true });
  assert.equal(r.data.bewaard, 1);
  assert.ok(r.data.status.gelezen);
  r = await roep(ctx, sanne, 'GET', '/api/feed/bewaard');
  assert.deepEqual(r.data.items.map((i) => [i.titel, i.regioNaam, i.gelezen]), [['Thialf krijgt nieuw dak', 'Heerenveen', true]]);
  assert.equal((await roep(ctx, sanne, 'PUT', '/api/stuk', { id: 'x' })).status, 400);
  assert.equal((await roep(ctx, sanne, 'GET', '/api/stuk?id=i%3Aweg')).status, 404);

  // Eigen regio's en weekmail; rol en titel kan een journalist niet zelf zetten.
  r = await roep(ctx, sanne, 'PUT', '/api/ik', { regios: ['opsterland', 'heerenveen'], weekmail: { dagen: [1, 4] }, rol: 'admin', titel: 'DVHN' });
  assert.deepEqual(r.data.gebruiker.regios, ['heerenveen', 'opsterland']);
  assert.deepEqual(r.data.gebruiker.weekmail.dagen, [1, 4]);
  assert.equal(r.data.gebruiker.rol, 'journalist');
  assert.equal(r.data.gebruiker.titel, 'LC');
  assert.ok(r.data.volgendeWeekmail);
  assert.equal((await roep(ctx, sanne, 'PUT', '/api/ik', { regios: ['atlantis'] })).status, 400);

  // Meldingen: alleen de eigen.
  r = await roep(ctx, sanne, 'POST', '/api/meldingen', { zoekvraag: 'Thialf', bereik: 'mijn', bronnen: 'alle', frequentie: 'direct' });
  assert.equal(r.status, 201);
  assert.deepEqual([r.data.zoekvraag, r.data.bereikNaam, r.data.bronnenNaam, r.data.aantal30], ['Thialf', 'Mijn regio\'s', 'Alle bronnen', 1]);
  const melding = r.data.id;
  r = await roep(ctx, sanne, 'PUT', `/api/meldingen/${melding}`, { zoekvraag: 'Thialf OR "Sportstad Heerenveen"', frequentie: 'dagelijks', tijd: '17:00' });
  assert.deepEqual([r.data.zoekvraag, r.data.frequentie], ['Thialf OR "Sportstad Heerenveen"', 'dagelijks']);
  assert.equal((await roep(ctx, jan, 'DELETE', `/api/meldingen/${melding}`)).status, 404, 'niet van een ander');
  assert.equal((await roep(ctx, sanne, 'GET', '/api/meldingen')).data.length, 1);
  assert.deepEqual((await roep(ctx, sanne, 'DELETE', `/api/meldingen/${melding}`)).data, { ok: true });

  for (const [methode, pad] of [['GET', '/api/beheer/regios'], ['GET', '/api/beheer/gebruikers'], ['GET', '/api/logboek'], ['GET', '/api/instellingen'], ['PUT', '/api/instellingen'], ['POST', '/api/testmail']]) {
    assert.equal((await roep(ctx, sanne, methode, pad, methode === 'GET' ? undefined : {})).status, 403, `${methode} ${pad}`);
  }
  // Taken: een voorbeeld van de eigen mail mag, de rest niet.
  assert.equal((await roep(ctx, sanne, 'POST', '/api/taken/voorbeeld', {})).status, 202);
  assert.equal((await roep(ctx, sanne, 'POST', '/api/taken/voorbeeld', { gebruiker: jan.id })).status, 403);
  assert.equal((await roep(ctx, sanne, 'POST', '/api/taken/verzamel', {})).status, 403);
  assert.equal((await roep(ctx, jan, 'POST', '/api/taken/verzamel', {})).status, 202);
  assert.equal(opslag.gebruikers.length, 2);
});

test('beheer: regio\'s, sleutelwoorden, landelijke bronnen aan en uit, gebruikers', metSqlite, async () => {
  const { ctx, jan, sanne } = await opzet();
  let r = await roep(ctx, jan, 'GET', '/api/beheer/regios');
  const heerenveen = r.data.find((x) => x.id === 'heerenveen');
  assert.deepEqual(heerenveen, { id: 'heerenveen', naam: 'Heerenveen', eigen: false, bronnen: 2, termen: 0, waarschuwing: 'Woo ontbreekt' });
  assert.equal(r.data.find((x) => x.id === 'opsterland').waarschuwing, 'Woo ontbreekt');
  assert.equal(r.data.find((x) => x.id === 'groningen').waarschuwing, 'Vervangend');

  r = await roep(ctx, jan, 'PUT', '/api/beheer/regios/heerenveen', { sleutelwoorden: ['Thialf', '"Sportstad Heerenveen"', 'thialf', ' '] });
  assert.deepEqual(r.data.sleutelwoorden.map((s) => [s.term, s.actief]), [['Thialf', true], ['Sportstad Heerenveen', true]]);
  assert.deepEqual(r.data.landelijk, [{ id: 'tweede-kamer', naam: 'Tweede Kamer', aan: true }, { id: 'knmi-aardbevingen', naam: 'KNMI · Aardbevingen', aan: true }, { id: 'knmi-waarschuwingen', naam: 'KNMI · Weerwaarschuwingen', aan: true }, { id: 'raad-van-state', naam: 'Raad van State · Uitspraken', aan: true }, { id: 'ransomware', naam: 'Ransomware · Nederlandse slachtoffers', aan: true }, { id: 'ndw-files', naam: 'NDW · Files', aan: true }, { id: 'ns-storingen', naam: 'NS · Storingen en werkzaamheden', aan: true }, { id: 'telegram', naam: 'Telegram · Ingezonden', aan: true }, { id: 'provincie-fryslan-bekendmakingen', naam: 'Provincie Fryslân · Bekendmakingen', aan: true }]);
  assert.deepEqual(r.data.volgers.map((v) => [v.naam, v.mail]), [['Sanne', 'weekmail ma 07:00']]);
  r = await roep(ctx, jan, 'PUT', '/api/beheer/regios/heerenveen', { sleutelwoorden: [{ term: 'Thialf', actief: false }], landelijkUit: ['tweede-kamer', 'bestaat-niet'] });
  assert.deepEqual(r.data.sleutelwoorden.map((s) => [s.term, s.actief]), [['Thialf', false]]);
  assert.deepEqual(r.data.landelijk, [{ id: 'tweede-kamer', naam: 'Tweede Kamer', aan: false }, { id: 'knmi-aardbevingen', naam: 'KNMI · Aardbevingen', aan: true }, { id: 'knmi-waarschuwingen', naam: 'KNMI · Weerwaarschuwingen', aan: true }, { id: 'raad-van-state', naam: 'Raad van State · Uitspraken', aan: true }, { id: 'ransomware', naam: 'Ransomware · Nederlandse slachtoffers', aan: true }, { id: 'ndw-files', naam: 'NDW · Files', aan: true }, { id: 'ns-storingen', naam: 'NS · Storingen en werkzaamheden', aan: true }, { id: 'telegram', naam: 'Telegram · Ingezonden', aan: true }, { id: 'provincie-fryslan-bekendmakingen', naam: 'Provincie Fryslân · Bekendmakingen', aan: true }]);
  assert.equal((await roep(ctx, jan, 'PUT', '/api/beheer/regios/heerenveen', { naam: 'Hearrenfean' })).status, 400, 'ingebouwd: naam staat in de code');
  r = await roep(ctx, jan, 'GET', '/api/beheer/termproef?term=Thialf&regio=heerenveen');
  assert.deepEqual(r.data, { term: 'Thialf', aantal: 0 });

  // Een eigen regio: maken, hernoemen, verwijderen (en volgers verliezen hem).
  r = await roep(ctx, jan, 'POST', '/api/beheer/regios', { naam: 'Leeuwarden' });
  assert.deepEqual(r.data, { id: 'leeuwarden', stukken: 0 });
  assert.equal((await roep(ctx, jan, 'POST', '/api/beheer/regios', { naam: 'leeuwarden' })).status, 400);
  await roep(ctx, jan, 'PUT', `/api/beheer/gebruikers/${sanne.id}`, { regios: ['heerenveen', 'leeuwarden'] });
  assert.equal((await roep(ctx, jan, 'PUT', '/api/beheer/regios/leeuwarden', { naam: 'Ljouwert' })).data.naam, 'Ljouwert');
  assert.deepEqual((await roep(ctx, jan, 'DELETE', '/api/beheer/regios/leeuwarden')).data, { ok: true });
  assert.deepEqual(sanne.regios, ['heerenveen']);
  assert.equal((await roep(ctx, jan, 'DELETE', '/api/beheer/regios/heerenveen')).status, 400);

  // Gebruikers: uitnodigen, titel en rol, verwijderen.
  r = await roep(ctx, jan, 'POST', '/api/beheer/gebruikers', { naam: 'Marrit', email: 'Marrit@DVHN.nl', titel: 'DVHN', rol: 'journalist', regios: ['groningen'] });
  assert.equal(r.status, 201);
  assert.deepEqual([r.data.email, r.data.titel, r.data.uitgenodigd, r.data.weekmail.aan], ['marrit@dvhn.nl', 'DVHN', true, false]);
  const marrit = r.data.id;
  assert.equal((await roep(ctx, jan, 'POST', '/api/beheer/gebruikers', { naam: 'Dubbel', email: 'marrit@dvhn.nl' })).status, 400);
  assert.equal((await roep(ctx, jan, 'PUT', `/api/beheer/gebruikers/${marrit}`, { titel: 'NRC' })).status, 400);
  r = await roep(ctx, jan, 'PUT', `/api/beheer/gebruikers/${marrit}`, { rol: 'admin', weekmail: { aan: true } });
  assert.deepEqual([r.data.rol, r.data.weekmail.aan], ['admin', true]);
  // Marrit logt voor het eerst in: gekoppeld op e-mailadres.
  const ingelogd = herken(ctx.opslag, { login: 'marrit', email: 'marrit@dvhn.nl' });
  assert.equal(ingelogd.id, marrit);
  r = await roep(ctx, jan, 'GET', '/api/beheer/gebruikers');
  assert.equal(r.data.find((g) => g.id === marrit).uitgenodigd, false);
  assert.ok(r.data.find((g) => g.id === marrit).volgendeWeekmail);
  assert.deepEqual((await roep(ctx, jan, 'DELETE', `/api/beheer/gebruikers/${marrit}`)).data, { ok: true });
  assert.equal((await roep(ctx, jan, 'DELETE', `/api/beheer/gebruikers/${jan.id}`)).status, 400, 'de laatste beheerder blijft');
});

test('beheer: bron toevoegen met proefronde, landelijk via sleutelwoorden', metSqlite, async () => {
  const rss = readFileSync(new URL('./fixtures/opsterland-rss.xml', import.meta.url));
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/rss+xml' }); res.end(rss); });
  await new Promise((klaar) => server.listen(0, '127.0.0.1', klaar));
  const url = `http://127.0.0.1:${server.address().port}/rss`;
  try {
    const { ctx, jan, opslag } = await opzet();
    // Een sleutelwoord dat in de feed van Opsterland voorkomt.
    const titels = String(rss).match(/<title>([^<]+)<\/title>/g).slice(1).map((t) => t.replace(/<\/?title>/g, ''));
    const woord = titels[0].split(/\s+/).find((w) => /^\p{Lu}\p{Ll}{4,}$/u.test(w));
    opslag.regios = { opsterland: { sleutelwoorden: [{ term: woord, actief: true }] } };

    let r = await roep(ctx, jan, 'POST', '/api/beheer/bronnen/proef', { bereik: 'landelijk', lezer: 'rss', soort: 'nieuws', url });
    assert.match(r.data.tekst, new RegExp(`^Er zijn ${titels.length} stukken gevonden\\. Met de huidige sleutelwoorden gaan er \\d+ naar Opsterland`));
    assert.equal(r.data.voorbeelden.length, 5);
    assert.match(r.data.nulmeting, /nulmeting/);
    assert.equal((await roep(ctx, jan, 'POST', '/api/beheer/bronnen/proef', { bereik: 'regio', lezer: 'rss', soort: 'nieuws', url })).status, 400, 'regio ontbreekt');
    assert.match((await roep(ctx, jan, 'POST', '/api/beheer/bronnen/proef', { bereik: 'regio', regio: 'opsterland', lezer: 'ibabs', soort: 'ingekomen', url: 'https://x.nl/iets' })).data.fout, /iBabs-overzicht/);
    r = await roep(ctx, jan, 'POST', '/api/beheer/bronnen/proef', { bereik: 'landelijk', lezer: 'rss', soort: 'nieuws', url: 'http://127.0.0.1:1/rss' });
    assert.match(r.data.tekst, /^Ophalen mislukt/);

    r = await roep(ctx, jan, 'POST', '/api/beheer/bronnen', { bereik: 'landelijk', lezer: 'rss', soort: 'nieuws', url, naam: 'Testfeed' });
    assert.equal(r.status, 201);
    assert.deepEqual([r.data.id, r.data.naam, r.data.bereik, r.data.lezer, r.data.termen], ['landelijk-testfeed', 'Testfeed', 'landelijk', 'RSS', 1]);
    r = await roep(ctx, jan, 'GET', '/api/beheer/bronnen');
    assert.deepEqual(r.data.bronnen.filter((b) => b.bereik === 'landelijk').map((b) => b.id), ['tweede-kamer', 'knmi-aardbevingen', 'knmi-waarschuwingen', 'raad-van-state', 'ransomware', 'ndw-files', 'ns-storingen', 'telegram', 'provincie-fryslan-bekendmakingen', 'landelijk-testfeed']);
    assert.ok(r.data.bronnen.some((b) => b.id === 'opsterland-woo' && b.status.staat === 'ontbreekt' && b.nieuw7 === null));
    // De nieuwe landelijke bron staat bij elke regio onder "Geldt voor".
    r = await roep(ctx, jan, 'GET', '/api/beheer/regios/opsterland');
    assert.deepEqual(r.data.landelijk.map((b) => [b.id, b.aan]), [['tweede-kamer', true], ['knmi-aardbevingen', true], ['knmi-waarschuwingen', true], ['raad-van-state', true], ['ransomware', true], ['ndw-files', true], ['ns-storingen', true], ['telegram', true], ['provincie-fryslan-bekendmakingen', true], ['landelijk-testfeed', true]]);

    // Een verzamelronde haalt hem op (nulmeting), en de proef-items gaan via het sleutelwoord naar Opsterland.
    const { verwerk } = await import('../src/verzamel.mjs');
    const { haalBron } = await import('../src/bronnen/index.mjs');
    const bron = opslag.bronnen[0];
    verwerk(opslag, bron, await haalBron(bron));
    assert.ok(Object.values(opslag.items).filter((i) => i.bron === bron.id).every((i) => i.regio === null));

    // Naar een regio verplaatsen: wat de bron al opleverde, verhuist mee (en terug naar landelijk ook).
    r = await roep(ctx, jan, 'PUT', `/api/beheer/bronnen/${bron.id}`, { bereik: 'regio', regio: 'heerenveen' });
    assert.equal(r.status, 200);
    const vanBron = () => Object.values(opslag.items).filter((i) => i.bron === bron.id);
    assert.ok(vanBron().length && vanBron().every((i) => i.regio === 'heerenveen'));
    r = await roep(ctx, jan, 'PUT', `/api/beheer/bronnen/${bron.id}`, { bereik: 'landelijk' });
    assert.ok(vanBron().every((i) => i.regio === null));
  } finally {
    server.close();
  }
});
