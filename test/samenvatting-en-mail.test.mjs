// Claude en SMTP zonder echte diensten: een nagebootste Messages-API en een
// SMTP-ontvanger op localhost. Zo testen we wat we versturen en hoe we het
// antwoord verwerken, zonder kosten en zonder dat er mail de deur uit gaat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { Opslag } from '../src/opslag.mjs';
import { maakSamenvatting, bouwVraag } from '../src/samenvatting.mjs';
import { stelMailSamen, verstuur, mailGebruiker } from '../src/mail.mjs';
import { regioOpId } from '../src/regios.mjs';

const leegOpslag = () => new Opslag(mkdtempSync(path.join(tmpdir(), 'rc-test-')));

const ITEMS = [
  { sleutel: 'heerenveen-ingekomen:ec004fea', regio: 'heerenveen', soort: 'ingekomen', titel: 'Brief Plaatselijk Belang Oude- en Nieuwehorne betreffende BOPA-aanvraag Oudehorne', afzender: 'Plaatselijk Belang Oude- en Nieuwehorne', soortStuk: 'Plaatselijk Belang / Wijkver.', datum: '2026-10-19', url: 'https://heerenveen.bestuurlijkeinformatie.nl/Reports/Item/ec004fea', eersteGezien: '2026-10-20T04:00:00.000Z', basislijn: false },
  { sleutel: 'heerenveen-ingekomen:81db99d0', regio: 'heerenveen', soort: 'ingekomen', titel: 'Nieuwsbrief Platform31', afzender: 'Platform31', soortStuk: 'Nieuwsbrief', datum: '2026-10-19', url: 'https://heerenveen.bestuurlijkeinformatie.nl/Reports/Item/81db99d0', eersteGezien: '2026-10-20T04:00:00.000Z', basislijn: false },
];

function nepClaude(antwoordVoor) {
  const verzoeken = [];
  const server = http.createServer(async (req, res) => {
    let ruw = '';
    for await (const stuk of req) ruw += stuk;
    const body = JSON.parse(ruw);
    verzoeken.push({ url: req.url, headers: req.headers, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(antwoordVoor(body)));
  });
  return new Promise((klaar) => server.listen(0, '127.0.0.1', () => klaar({
    server,
    verzoeken,
    client: new Anthropic({ apiKey: 'test', baseURL: `http://127.0.0.1:${server.address().port}`, maxRetries: 0 }),
  })));
}

const bericht = (inhoud, stop = 'end_turn') => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
  content: [{ type: 'thinking', thinking: '', signature: 'x' }, ...inhoud],
  stop_reason: stop, stop_details: stop === 'refusal' ? { type: 'refusal', category: 'cyber', explanation: '' } : null,
  usage: { input_tokens: 100, output_tokens: 50 },
});

test('de vraag bevat van elk bericht titel én inhoud, met korte ids', () => {
  const items = [{ ...ITEMS[0], inhoud: 'Geacht college, wij maken bezwaar tegen de BOPA voor 40 woningen. '.repeat(100) }, ITEMS[1]];
  const { vraag, ids } = bouwVraag('Heerenveen', items);
  assert.match(vraag, /^Gemeente: Heerenveen/);
  assert.match(vraag, /\[i1\] Ingekomen stukken · datum 2026-10-19 · afzender: Plaatselijk Belang/);
  assert.match(vraag, /Inhoud: Geacht college, wij maken bezwaar tegen de BOPA voor 40 woningen/);
  assert.match(vraag, /\[i2\][^[]*Inhoud: \(alleen de titel is bekend\)/);
  assert.equal(ids.get('i2'), 'heerenveen-ingekomen:81db99d0');
  // Inhoud per bericht begrensd: 3000 tekens.
  const lengte = vraag.match(/Inhoud: (Geacht[^\n]*)/)[1].length;
  assert.equal(lengte, 3000);
});

test('samenvatting via Claude: verzoek, antwoord terugvertalen en cache', async () => {
  const nep = await nepClaude(() => bericht([{ type: 'text', text: JSON.stringify({
    punten: [
      { zin: 'Plaatselijk Belang Oude- en Nieuwehorne maakt bezwaar tegen de BOPA-aanvraag.', items: ['i1', 'i99', 'i1'] },
      { zin: '  ', items: [] },
    ],
  }) }]));
  try {
    const opslag = leegOpslag();
    opslag.instellingen.claude.apiKey = 'test';
    const regio = regioOpId('heerenveen');
    const resultaat = await maakSamenvatting({ opslag, regio, items: ITEMS, client: nep.client });
    // Onbekende ids vallen weg, dubbele ook, en een leeg punt telt niet.
    assert.deepEqual(resultaat, {
      punten: [{ zin: 'Plaatselijk Belang Oude- en Nieuwehorne maakt bezwaar tegen de BOPA-aanvraag.', items: ['heerenveen-ingekomen:ec004fea'] }],
    });

    const [verzoek] = nep.verzoeken;
    assert.equal(verzoek.url, '/v1/messages?beta=true');
    assert.equal(verzoek.body.model, 'claude-opus-5-5');
    assert.equal(verzoek.body.fallbacks, 'default');
    assert.match(verzoek.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
    assert.equal(verzoek.body.output_config.effort, 'medium');
    assert.equal(verzoek.body.output_config.format.type, 'json_schema');
    assert.equal(verzoek.body.output_config.format.schema.additionalProperties, false);
    assert.equal(verzoek.body.betas, undefined, 'betas hoort in de header, niet in de body');
    assert.equal(verzoek.body.thinking, undefined);

    // Dezelfde regio met dezelfde items: uit de cache, geen tweede aanroep.
    await maakSamenvatting({ opslag, regio, items: [...ITEMS].reverse(), client: nep.client });
    assert.equal(nep.verzoeken.length, 1);
  } finally {
    nep.server.close();
  }
});

test('samenvatting: een weigering wordt een leesbare fout', async () => {
  const nep = await nepClaude(() => bericht([], 'refusal'));
  try {
    const opslag = leegOpslag();
    await assert.rejects(
      maakSamenvatting({ opslag, regio: regioOpId('heerenveen'), items: ITEMS, client: nep.client }),
      /Claude weigerde \(cyber\)/,
    );
  } finally {
    nep.server.close();
  }
});

test('zonder sleutel: geen aanroep, mail zegt waarom er geen samenvatting is', async () => {
  const opslag = leegOpslag();
  delete process.env.ANTHROPIC_API_KEY;
  for (const item of ITEMS) opslag.items[item.sleutel] = item;
  const ontvanger = { email: 'x@example.nl', regios: ['heerenveen'], laatsteMail: '2026-10-19T05:00:00.000Z' };
  const mail = await stelMailSamen(opslag, ontvanger, { nu: new Date('2026-10-20T05:00:00.000Z') });
  assert.equal(mail.aantal, 2);
  assert.match(mail.onderwerp, /^Heerenveen: 2 nieuwe berichten/);
  assert.match(mail.html, /Geen samenvatting: er is nog geen Claude-API-sleutel ingesteld/);
  assert.match(mail.html, /Vervangende bron: Woo-stukken op heerenveen\.nl; alleen wat de gemeente zelf op de Woo-pagina zet\./);
  assert.match(mail.tekst, /Brief Plaatselijk Belang Oude- en Nieuwehorne/);
  assert.equal(mail.tot, '2026-10-20T05:00:00.000Z');
});

test('tekst uit de bron wordt in de mail ontsnapt', async () => {
  const opslag = leegOpslag();
  opslag.items.x = { ...ITEMS[0], sleutel: 'x', titel: '<script>alert(1)</script> & co', url: 'https://x/?a="b"' };
  const mail = await stelMailSamen(opslag, { email: 'x@example.nl', regios: ['heerenveen'], laatsteMail: '2026-10-19T00:00:00.000Z' }, { nu: new Date('2026-10-20T05:00:00.000Z'), samenvatting: false });
  assert.ok(!mail.html.includes('<script>'));
  assert.match(mail.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; co/);
  assert.match(mail.html, /href="https:\/\/x\/\?a=&quot;b&quot;"/);
});

function nepSmtp() {
  const ontvangen = [];
  const server = net.createServer((sok) => {
    let buffer = '';
    let inData = false;
    let huidig = { van: null, aan: [], data: '' };
    sok.write('220 nep ESMTP\r\n');
    sok.on('data', (stuk) => {
      buffer += stuk.toString();
      let regelEind;
      while ((regelEind = buffer.indexOf('\r\n')) >= 0) {
        const regel = buffer.slice(0, regelEind);
        buffer = buffer.slice(regelEind + 2);
        if (inData) {
          if (regel === '.') {
            inData = false;
            ontvangen.push(huidig);
            huidig = { van: null, aan: [], data: '' };
            sok.write('250 ok\r\n');
          } else {
            huidig.data += `${regel}\n`;
          }
          continue;
        }
        const opdracht = regel.slice(0, 4).toUpperCase();
        if (opdracht === 'EHLO' || opdracht === 'HELO') sok.write('250 nep\r\n');
        else if (opdracht === 'MAIL') { huidig.van = regel; sok.write('250 ok\r\n'); }
        else if (opdracht === 'RCPT') { huidig.aan.push(regel); sok.write('250 ok\r\n'); }
        else if (opdracht === 'DATA') { inData = true; sok.write('354 ga je gang\r\n'); }
        else if (opdracht === 'QUIT') { sok.write('221 doei\r\n'); sok.end(); }
        else sok.write('250 ok\r\n');
      }
    });
  });
  return new Promise((klaar) => server.listen(0, '127.0.0.1', () => klaar({ server, ontvangen, poort: server.address().port })));
}

test('versturen via SMTP', async () => {
  const smtp = await nepSmtp();
  try {
    const opslag = leegOpslag();
    opslag.instellingen.smtp = { host: '127.0.0.1', port: smtp.poort, secure: false, user: '', pass: '', from: 'Regiochecker <rc@example.nl>' };
    await verstuur(opslag, { aan: 'verslaggever@example.nl', onderwerp: 'Heerenveen: 2 nieuwe items', html: '<p>Hallo</p>', tekst: 'Hallo' });
    assert.equal(smtp.ontvangen.length, 1);
    assert.match(smtp.ontvangen[0].aan[0], /verslaggever@example\.nl/);
    assert.match(smtp.ontvangen[0].data, /Subject: Heerenveen: 2 nieuwe items/);
  } finally {
    smtp.server.close();
  }
});

test('versturen zonder SMTP-instellingen geeft een duidelijke fout', async () => {
  await assert.rejects(verstuur(leegOpslag(), { aan: 'x@example.nl', onderwerp: 't', html: '', tekst: '' }), /SMTP is nog niet ingesteld/);
});

test('mailloze periode: de volgende mail bevat alles sinds de vorige mail, hoe lang ook', async () => {
  const opslag = leegOpslag();
  const item = (sleutel, eersteGezien) => ({ ...ITEMS[0], sleutel, titel: sleutel, eersteGezien });
  opslag.items.a = item('week 41', '2026-10-07T10:00:00.000Z');
  opslag.items.b = item('week 42', '2026-10-14T10:00:00.000Z');
  opslag.items.c = item('week 43', '2026-10-19T10:00:00.000Z');
  const nu = new Date('2026-10-26T05:00:00.000Z');

  // Vorige mail drie weken terug (daarna geen mail: niets nieuws of een fout).
  const oud = await stelMailSamen(opslag, { email: 'x@example.nl', regios: ['heerenveen'], laatsteMail: '2026-10-05T05:00:00.000Z' }, { nu, samenvatting: false });
  assert.equal(oud.aantal, 3);
  assert.match(oud.onderwerp, /\(ma 5 okt – ma 26 okt\)$/);

  // Nieuwe ontvanger: de afgelopen week.
  const nieuw = await stelMailSamen(opslag, { email: 'y@example.nl', regios: ['heerenveen'], laatsteMail: null }, { nu, samenvatting: false });
  assert.equal(nieuw.aantal, 1);
});

test('opbouw: H2 per gemeente, daaronder H3 Gemeentenieuws, Ingekomen stukken, Woo-publicaties', async () => {
  const opslag = leegOpslag();
  const zet = (sleutel, regio, soort) => {
    opslag.items[sleutel] = { sleutel, regio, soort, titel: `Bericht ${sleutel}`, url: `https://x/${sleutel}`, datum: '2026-10-19', eersteGezien: '2026-10-19T10:00:00.000Z', basislijn: false };
  };
  zet('hv-woo-ontbreekt-dus-niet', 'opsterland', 'nieuws');
  zet('hv-ingekomen', 'heerenveen', 'ingekomen');
  zet('hv-nieuws', 'heerenveen', 'nieuws');
  zet('swf-woo', 'sudwestfryslan', 'woo');
  const ontvanger = { email: 'x@example.nl', regios: ['heerenveen', 'sudwestfryslan'], laatsteMail: '2026-10-12T05:00:00.000Z' };
  const mail = await stelMailSamen(opslag, ontvanger, { nu: new Date('2026-10-19T12:00:00.000Z'), samenvatting: false });

  const koppen = [...mail.html.matchAll(/<(h[123])\b[^>]*>(.*?)<\/\1>/g)].map(([, n, t]) => `${n} ${t.replace(/<[^>]+>/g, '').replace(/\s*\(\d+\)$/, '').trim()}`);
  assert.deepEqual(koppen.slice(1), [
    'h2 Heerenveen', 'h3 Gemeentenieuws', 'h3 Ingekomen stukken', 'h3 Woo-publicaties',
    'h2 Súdwest-Fryslân', 'h3 Gemeentenieuws', 'h3 Ingekomen stukken', 'h3 Woo-publicaties',
  ]);
  assert.match(koppen[0], /^h1 Regiochecker/);

  // Elk bericht staat onder de juiste kop.
  const heerenveen = mail.html.slice(mail.html.indexOf('>Heerenveen</h2>'), mail.html.indexOf('>Súdwest-Fryslân</h2>'));
  const onder = (kop, tekst) => {
    const begin = heerenveen.indexOf(`>${kop}`);
    const eind = heerenveen.indexOf('<h3', begin + 1);
    return heerenveen.slice(begin, eind < 0 ? undefined : eind).includes(tekst);
  };
  assert.ok(onder('Gemeentenieuws', 'Bericht hv-nieuws'));
  assert.ok(onder('Ingekomen stukken', 'Bericht hv-ingekomen'));
  assert.ok(onder('Woo-publicaties', 'Vervangende bron'));
  assert.ok(!heerenveen.includes('hv-woo-ontbreekt-dus-niet'), 'geen berichten van een andere gemeente');

  // Een lege categorie met een werkende bron zegt dat er niets nieuws is.
  const swf = mail.html.slice(mail.html.indexOf('>Súdwest-Fryslân</h2>'));
  assert.match(swf.slice(swf.indexOf('>Gemeentenieuws'), swf.indexOf('>Ingekomen stukken')), /Geen nieuwe berichten/);

  // De tekstversie volgt dezelfde volgorde.
  const t = mail.tekst;
  assert.ok(t.indexOf('-- Gemeentenieuws (1) --') < t.indexOf('-- Ingekomen stukken (1) --'));
  assert.ok(t.indexOf('-- Ingekomen stukken (1) --') < t.indexOf('-- Woo-publicaties --'));
});

test('twee keer tegelijk op versturen drukken geeft één mail, niet twee', async () => {
  const smtp = await nepSmtp();
  try {
    const opslag = leegOpslag();
    opslag.instellingen.smtp = { host: '127.0.0.1', port: smtp.poort, secure: false, user: '', pass: '', from: 'rc@example.nl' };
    opslag.instellingen.samenvattingVia = 'uit';
    for (const item of ITEMS) opslag.items[item.sleutel] = item;
    const gebruiker = { email: 'x@example.nl', regios: ['heerenveen'], laatsteMail: '2026-10-19T05:00:00.000Z', weekmail: { aan: true, dagen: [1], tijd: '07:00', ookLeeg: false } };
    opslag.gebruikers = [gebruiker];
    const nu = new Date('2026-10-20T05:00:00.000Z');
    const [eerste, tweede] = await Promise.all([mailGebruiker(opslag, gebruiker, { nu }), mailGebruiker(opslag, gebruiker, { nu })]);
    assert.equal(eerste.verstuurd, true);
    assert.deepEqual(tweede, { verstuurd: false, reden: 'niets nieuws' });
    assert.equal(smtp.ontvangen.length, 1);
  } finally {
    smtp.server.close();
  }
});

test('de samenvatting staat onder de gemeentekop: per onderwerp een punt, met de bronnen erachter', async () => {
  const nep = await nepClaude(() => bericht([{ type: 'text', text: JSON.stringify({
    punten: [{ zin: 'Plaatselijk Belang <maakt> bezwaar.', items: ['i1'] }, { zin: 'Platform31 stuurt een nieuwsbrief.', items: ['i2'] }],
  }) }]));
  try {
    const opslag = leegOpslag();
    for (const item of ITEMS) opslag.items[item.sleutel] = item;
    opslag.instellingen.claude.apiKey = 'test';
    // De mail maakt zelf een client; die laten we hier via de cache lopen.
    await maakSamenvatting({ opslag, regio: regioOpId('heerenveen'), items: [...ITEMS].sort((a, b) => a.titel.localeCompare(b.titel)), client: nep.client });
    const mail = await stelMailSamen(opslag, { email: 'x@example.nl', regios: ['heerenveen'], laatsteMail: '2026-10-19T05:00:00.000Z' }, { nu: new Date('2026-10-20T05:00:00.000Z') });
    const h2 = mail.html.indexOf('>Heerenveen</h2>');
    const punt = mail.html.indexOf('Plaatselijk Belang &lt;maakt&gt; bezwaar.');
    const eersteH3 = mail.html.indexOf('<h3', h2);
    assert.ok(h2 < punt && punt < eersteH3, 'samenvatting tussen H2 en de eerste H3');
    const lijst = mail.html.slice(mail.html.indexOf('<ul', h2), mail.html.indexOf('</ul>', h2));
    assert.equal((lijst.match(/<li/g) || []).length, 2, 'één punt per onderwerp');
    assert.match(lijst, /<li[^>]*>Plaatselijk Belang &lt;maakt&gt; bezwaar\. <span[^>]*>— <a href="https:\/\/heerenveen\.bestuurlijkeinformatie\.nl\/Reports\/Item\/ec004fea"/);
    assert.match(mail.tekst, /• Plaatselijk Belang <maakt> bezwaar\.\n {2}-> https:\/\/heerenveen/);
    assert.doesNotMatch(mail.onderwerp, /speerpunt/i);
  } finally {
    nep.server.close();
  }
});
