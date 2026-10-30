// De koppeling met gehoord.de (src/gehoord.mjs) en de MCP-client
// (src/mcp.mjs), tegen een nagebootste server: registreren, inloggen met PKCE,
// tokens vernieuwen en kwijtraken, en de tools van de MCP-server opvragen.
// De tokens komen nooit in wat de browser ziet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MockAgent } from 'undici';
import { zetOpenbaarDispatcher } from '../src/netwerk.mjs';
import { Opslag } from '../src/opslag.mjs';
import { koppelAdres, rondKoppelingAf, toegang, gehoordStatus, gehoordTools, ontkoppel, leesDebatten, leesTranscript, debatSegmenten, leesDebat, klokVan } from '../src/gehoord.mjs';
import { publiekeInstellingen } from '../src/instellingen.mjs';
import { leesStroom } from '../src/mcp.mjs';
import { herken, nieuweGebruiker } from '../src/gebruikers.mjs';
import { roep } from './api-hulp.mjs';

const BASIS = 'https://gehoord.test';
process.env.GEHOORD_URL = BASIS;
process.env.DEBAT_DIRECT_API = 'https://dd.test/api';
const TERUG = 'https://regiochecker.test/api/beheer/gehoord/terug';
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function nepGehoord() {
  const staat = { registraties: [], tokens: [], mcp: [], aanroepen: [], dd: [], ververs: 'goed', uitgedeeld: 0, challenge: null };
  const agent = new MockAgent();
  agent.disableNetConnect();
  const server = agent.get(BASIS);
  const json = (data, status = 200, koppen = {}) => ({ statusCode: status, data: JSON.stringify(data), responseOptions: { headers: { 'content-type': 'application/json', ...koppen } } });
  server.intercept({ path: '/.well-known/oauth-authorization-server', method: 'GET' }).reply(() => json({
    issuer: BASIS, authorization_endpoint: `${BASIS}/oauth/authorize`, token_endpoint: `${BASIS}/api/oauth/token`,
    registration_endpoint: `${BASIS}/api/oauth/register`, revocation_endpoint: `${BASIS}/api/oauth/revoke`,
  })).persist();
  server.intercept({ path: '/api/oauth/register', method: 'POST' }).reply(({ body }) => {
    staat.registraties.push(JSON.parse(body));
    return json({ client_id: 'klant-1' }, 201);
  }).persist();
  server.intercept({ path: '/api/oauth/token', method: 'POST' }).reply(({ body }) => {
    const f = Object.fromEntries(new URLSearchParams(body));
    staat.tokens.push(f);
    if (f.grant_type === 'authorization_code') {
      if (f.code !== 'code-1' || b64url(createHash('sha256').update(f.code_verifier).digest()) !== staat.challenge) return json({ error: 'invalid_grant' }, 400);
    } else if (staat.ververs !== 'goed') return json({ error: 'invalid_grant', error_description: 'ingetrokken' }, 400);
    staat.uitgedeeld++;
    return json({ access_token: `toegang-${staat.uitgedeeld}`, refresh_token: `ververs-${staat.uitgedeeld}`, expires_in: 3600, token_type: 'Bearer' });
  }).persist();
  server.intercept({ path: '/api/oauth/revoke', method: 'POST' }).reply(() => ({ statusCode: 200, data: '' })).persist();
  // Debat Direct: de dagagenda en het debat met de stream van de zaal.
  const dd = agent.get('https://dd.test');
  dd.intercept({ path: '/api/agenda/2026-10-29', method: 'GET' }).reply(() => {
    staat.dd.push('agenda');
    return json({ debates: [{ id: 'dd-1', slug: 'begroting-iw-23-58' }, { id: 'dd-2', slug: 'iets-anders' }] });
  }).persist();
  dd.intercept({ path: '/api/debates/dd-1', method: 'GET' }).reply(() => {
    staat.dd.push('debat');
    return json({ id: 'dd-1', startedAt: '2026-10-29T23:58:00+0100', endedAt: '2026-10-30T01:00:00+0100',
      video: { imageUrl: 'https://dd.test/zaal.jpg', vodUrl: 'https://stream.test/2026-10-29/plenairezaal/index.m3u8?hd=1', catchup: { vodUrl: 'https://stream.test/2026-10-29/plenairezaal/index.m3u8?hd=1&subtitles=vod' } } });
  }).persist();
  // De stream van de zaal: het eerste beeld een halve seconde voor startedAt.
  const stream = agent.get('https://stream.test');
  stream.intercept({ path: (p) => p.startsWith('/2026-10-29/plenairezaal/index.m3u8'), method: 'GET' })
    .reply(200, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nstream_01/prog_index.m3u8?x=1\n').persist();
  stream.intercept({ path: (p) => p.startsWith('/2026-10-29/plenairezaal/stream_01/prog_index.m3u8'), method: 'GET' })
    .reply(200, '#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2026-10-29T22:57:59.500Z\n#EXTINF:2,\nseg.m4v\n').persist();
  server.intercept({ path: '/api/mcp', method: () => true }).reply(({ method, body, headers }) => {
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    if (method === 'DELETE') return { statusCode: 204, data: '' };
    const b = JSON.parse(body);
    staat.mcp.push({ method: b.method, auth: h.authorization, sessie: h['mcp-session-id'] || null });
    if (!/^Bearer toegang-/.test(h.authorization || '')) return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Koppel eerst je account' } }, 401);
    if (b.method === 'initialize') {
      // Als eventstroom, zoals veel MCP-servers antwoorden.
      return { statusCode: 200, data: `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'gehoord.de', version: '1' }, capabilities: { tools: {} } } })}\n\n`, responseOptions: { headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'sessie-1' } } };
    }
    if (b.method === 'notifications/initialized') return { statusCode: 202, data: '' };
    if (b.method === 'tools/list') {
      return b.params.cursor
        ? json({ jsonrpc: '2.0', id: b.id, result: { tools: [{ name: 'zoek_uitspraken', description: 'Zoek in uitspraken\nmet details', inputSchema: { type: 'object' } }] } })
        : json({ jsonrpc: '2.0', id: b.id, result: { tools: [{ name: 'lijst_debatten', title: 'Debatten', description: 'Recente debatten' }], nextCursor: 'p2' } });
    }
    if (b.method === 'tools/call') {
      staat.aanroepen.push([b.params.name, b.params.arguments]);
      const a = b.params.arguments || {};
      const tekst = b.params.name === 'search_debates' ? DEBATTEN(a.offset || 0) : b.params.name === 'get_transcript' ? TRANSCRIPT(a.offset || 0) : b.params.name === 'get_debate' ? DEBAT : null;
      if (tekst) return json({ jsonrpc: '2.0', id: b.id, result: { content: [{ type: 'text', text: tekst }] } });
    }
    return json({ jsonrpc: '2.0', id: b.id, error: { code: -32601, message: 'onbekend' } });
  }).persist();
  const vorige = zetOpenbaarDispatcher(agent);
  return { staat, herstel: () => zetOpenbaarDispatcher(vorige) };
}

const leegOpslag = () => new Opslag(mkdtempSync(path.join(tmpdir(), 'rc-gehoord-')));
const sqlite = await import('node:sqlite').catch(() => null);

// Zoals de tools van gehoord.de antwoorden (30 oktober 2026).
const DEBATTEN = (offset) => (offset ? `3 debat(ten) gevonden.

- #307209 · 29-10-2026 19:00 · Regeling van werkzaamheden · Plenaire zaal, Tweede Kamer · afgelopen · 1 fragmenten
  https://gehoord.de/beraadslagingen/307209
` : `3 debat(ten) gevonden.

- #307215 · 29-10-2026 23:58 · Begrotingen Infrastructuur en Waterstaat · Mobiliteitsfonds 2027 (voortzetting) · Plenaire zaal, Tweede Kamer · afgelopen · 4 fragmenten
  https://gehoord.de/beraadslagingen/307215
- #307214 · 29-10-2026 16:00 · EU-wetenschapstoets Omnibus directe belastingen · Groen van Prinstererzaal, Tweede Kamer · afgelopen · 47 fragmenten
  https://gehoord.de/beraadslagingen/307214

Nog 1 meer: offset=2.`);
const DEBAT = `# Begrotingen Infrastructuur en Waterstaat · Mobiliteitsfonds 2027 (voortzetting)
Debat #307215 · Tweede Kamer, Plenaire zaal · 29-10-2026 23:58 · afgelopen
Soort: Plenair debat
Op gehoord.de: https://gehoord.de/beraadslagingen/307215
Bron: https://debatdirect.tweedekamer.nl/2026-10-29/infrastructuur-waterstaat/plenaire-zaal/begroting-iw-23-58
Fragmenten: 4 (lees ze met get_transcript)

## Sprekers
- Thom van Campen (VVD)
- Hidde Heutink (Groep Markuszower)

## Let op
- Eerste Kamer: spraakherkenning zonder hoofdletters en leestekens.
`;
const TRANSCRIPT = (offset) => (offset ? `# Begrotingen Infrastructuur en Waterstaat · Mobiliteitsfonds 2027 (voortzetting)
Fragmenten 3–4 van 4.

[00:01:10] Thom van Campen (VVD) — https://gehoord.de/beraadslagingen/307215?segment=13
Dan de N31 bij Leeuwarden. Wanneer gaat de schop in de grond?

[00:01:30] Onbekende spreker — https://gehoord.de/beraadslagingen/307215?segment=14
Dank u wel.
` : `# Begrotingen Infrastructuur en Waterstaat · Mobiliteitsfonds 2027 (voortzetting)
Debat #307215 · Tweede Kamer, Plenaire zaal · 29-10-2026 23:58 · afgelopen
Automatische transcriptie zonder menselijke correctie.
Fragmenten 1–2 van 4.

[23:59:50] Voorzitter — https://gehoord.de/beraadslagingen/307215?segment=11
Ik open de vergadering.

[00:00:20] Hidde Heutink (Groep Markuszower) — https://gehoord.de/beraadslagingen/307215?segment=12
Voorzitter, de regio's
verdienen beter.

— Vervolg: get_transcript met debate_id=307215 en offset=2 (nog 2 fragmenten).`);

test('gehoord.de: de debattenlijst en het transcript lezen, ook na middernacht', () => {
  const { debatten, volgende } = leesDebatten(DEBATTEN(0));
  assert.deepEqual(debatten.map((d) => [d.id, d.titel, d.plek, d.fragmenten]), [
    [307215, 'Begrotingen Infrastructuur en Waterstaat · Mobiliteitsfonds 2027 (voortzetting)', 'Plenaire zaal, Tweede Kamer', 4],
    [307214, 'EU-wetenschapstoets Omnibus directe belastingen', 'Groen van Prinstererzaal, Tweede Kamer', 47],
  ], 'een middenpunt in de titel blijft bij de titel');
  assert.equal(volgende, 2);
  assert.deepEqual([debatten[0].begin.getHours(), debatten[0].begin.getMinutes(), debatten[0].begin.getDate()], [23, 58, 29]);
  assert.equal(leesDebatten(DEBATTEN(2)).volgende, null);

  const een = leesTranscript(TRANSCRIPT(0));
  assert.equal(een.volgende, 2);
  assert.deepEqual(een.fragmenten.map((f) => [f.spreker, f.fragment, f.tekst]), [
    ['Voorzitter', 11, 'Ik open de vergadering.'], ['Hidde Heutink (Groep Markuszower)', 12, 'Voorzitter, de regio\'s verdienen beter.'],
  ]);
  const twee = leesTranscript(TRANSCRIPT(2));
  assert.equal(twee.volgende, null);
  assert.equal(twee.fragmenten[1].spreker, null, '"Onbekende spreker" is geen naam');
  assert.deepEqual(debatSegmenten([...een.fragmenten, ...twee.fragmenten]).map((x) => [x.start, x.end, x.speaker || null, x.fragment]), [
    [0, 30, 'Voorzitter', 11], [30, 80, 'Hidde Heutink (Groep Markuszower)', 12], [80, 100, 'Thom van Campen (VVD)', 13], [100, 105, null, 14],
  ], 'de tijden lopen over middernacht door');

  assert.deepEqual(leesDebat(DEBAT), {
    soort: 'Plenair debat', bron: 'https://debatdirect.tweedekamer.nl/2026-10-29/infrastructuur-waterstaat/plenaire-zaal/begroting-iw-23-58',
    letOp: ['Eerste Kamer: spraakherkenning zonder hoofdletters en leestekens.'], sprekers: ['Thom van Campen (VVD)', 'Hidde Heutink (Groep Markuszower)'],
  });
  // De kloktijd van het eerste fragment, ook als dat na middernacht valt.
  const gepland = new Date(2026, 9, 29, 23, 58).toISOString();
  assert.equal(klokVan({ gepubliceerd: gepland }, 23 * 3600 + 59 * 60 + 50), new Date(2026, 9, 29, 23, 59, 50).toISOString());
  assert.equal(klokVan({ gepubliceerd: gepland }, 10), new Date(2026, 9, 30, 0, 0, 10).toISOString());
});

test('MCP: berichten uit een eventstroom', () => {
  assert.deepEqual(leesStroom('event: message\ndata: {"id":1}\n\n: keepalive\n\ndata: {"id":2,\ndata: "x":1}\n\n'), [{ id: 1 }, { id: 2, x: 1 }]);
});

test('gehoord.de: koppelen met PKCE, tokens vernieuwen, tools opvragen, en ontkoppelen', async () => {
  const net = nepGehoord();
  try {
    const opslag = leegOpslag();
    assert.equal(gehoordStatus(opslag).gekoppeld, false);
    await assert.rejects(toegang(opslag), /Nog niet gekoppeld/);

    // Stap 1: registreren (één keer) en het adres om in te loggen.
    const adres = new URL(await koppelAdres(opslag, TERUG));
    assert.equal(`${adres.origin}${adres.pathname}`, `${BASIS}/oauth/authorize`);
    const p = Object.fromEntries(adres.searchParams);
    assert.deepEqual([p.client_id, p.redirect_uri, p.scope, p.code_challenge_method, p.resource], ['klant-1', TERUG, 'transcripts:read', 'S256', `${BASIS}/api/mcp`]);
    assert.deepEqual(net.staat.registraties[0].redirect_uris, [TERUG]);
    await koppelAdres(opslag, TERUG);
    assert.equal(net.staat.registraties.length, 1, 'niet opnieuw registreren');

    // Stap 2: terug met een onbekende state, en daarna goed.
    await assert.rejects(rondKoppelingAf(opslag, { code: 'code-1', state: 'verzonnen' }), /verlopen of onbekend/);
    await assert.rejects(rondKoppelingAf(opslag, { state: p.state, fout: 'access_denied' }), /geweigerd/);
    const derde = Object.fromEntries(new URL(await koppelAdres(opslag, TERUG)).searchParams);
    net.staat.challenge = derde.code_challenge;
    await rondKoppelingAf(opslag, { code: 'code-1', state: derde.state });
    assert.equal(gehoordStatus(opslag).gekoppeld, true);
    assert.equal(net.staat.tokens.at(-1).grant_type, 'authorization_code');
    await assert.rejects(rondKoppelingAf(opslag, { code: 'code-1', state: derde.state }), /verlopen of onbekend/, 'een state geldt maar één keer');

    // Geen tokens naar de browser.
    const publiek = JSON.stringify(publiekeInstellingen(opslag));
    assert.ok(!/toegang-|ververs-|klant-1/.test(publiek), publiek);
    assert.equal(publiekeInstellingen(opslag).gehoord.gekoppeld, true);

    // Tools, over twee pagina's, met het token en de sessie.
    const t = await gehoordTools(opslag);
    assert.deepEqual(t.tools.map((x) => [x.naam, x.titel]), [['lijst_debatten', 'Debatten'], ['zoek_uitspraken', null]]);
    assert.equal(t.server.name, 'gehoord.de');
    assert.ok(net.staat.mcp.every((m) => m.auth === 'Bearer toegang-1'));
    assert.deepEqual(net.staat.mcp.map((m) => [m.method, m.sessie]), [['initialize', null], ['notifications/initialized', 'sessie-1'], ['tools/list', 'sessie-1'], ['tools/list', 'sessie-1']]);

    // Een verlopen toegangstoken wordt vernieuwd; een ingetrokken koppeling valt weg.
    opslag.instellingen.gehoord.verloopt = Math.floor(Date.now() / 1000);
    assert.equal(await toegang(opslag), 'toegang-2');
    assert.equal(net.staat.tokens.at(-1).refresh_token, 'ververs-1');
    opslag.instellingen.gehoord.verloopt = 0;
    net.staat.ververs = 'ingetrokken';
    await assert.rejects(toegang(opslag), /ingetrokken/);
    assert.deepEqual([gehoordStatus(opslag).gekoppeld, /opnieuw/.test(gehoordStatus(opslag).fout)], [false, true]);

    await ontkoppel(opslag);
    assert.deepEqual(gehoordStatus(opslag), { gekoppeld: false, sinds: null, fout: null });
  } finally {
    net.herstel();
  }
});

test('gehoord.de: terugkomen in de Regiochecker stuurt door naar Instellingen', async () => {
  const net = nepGehoord();
  try {
    const opslag = leegOpslag();
    const jan = herken(opslag, { login: 'jan', email: 'jan@example.nl', naam: 'Jan' });
    opslag.gebruikers.push(nieuweGebruiker({ naam: 'Sanne', email: 'sanne@example.nl' }));
    const sanne = opslag.gebruikers.at(-1);
    const ctx = { opslag };
    const p = Object.fromEntries(new URL(await koppelAdres(opslag, TERUG)).searchParams);
    net.staat.challenge = p.code_challenge;
    assert.equal((await roep(ctx, sanne, 'GET', `/api/beheer/gehoord/terug?code=code-1&state=${p.state}`)).status, 403, 'alleen voor beheerders');
    const r = await roep(ctx, jan, 'GET', `/api/beheer/gehoord/terug?code=code-1&state=${p.state}`);
    assert.deepEqual([r.status, r.kop.Location], [302, '/#/beheer/instellingen?gehoord=gekoppeld']);
    const fout = await roep(ctx, jan, 'GET', '/api/beheer/gehoord/terug?error=access_denied&state=x');
    assert.match(decodeURIComponent(fout.kop.Location), /gehoord=Koppeling geweigerd/);
    assert.equal((await roep(ctx, jan, 'GET', '/api/instellingen')).data.gehoord.gekoppeld, true);
  } finally {
    net.herstel();
  }
});

test('Kamerdebatten als landelijke bron: catalogus, transcript zonder Whisper, en naar de regio via een sleutelwoord', { skip: sqlite ? false : 'node:sqlite niet beschikbaar' }, async () => {
  const { openFeedDb } = await import('../src/feeddb.mjs');
  const { AudioDb } = await import('../src/audio/db.mjs');
  const { Verwerking } = await import('../src/audio/verwerking.mjs');
  const { detail } = await import('../src/feed.mjs');
  const net = nepGehoord();
  try {
    const map = mkdtempSync(path.join(tmpdir(), 'rc-gehoord-'));
    const opslag = new Opslag(map);
    const fdb = await openFeedDb(path.join(map, 'regiochecker.sqlite'));
    const adb = new AudioDb(fdb.db);
    Object.assign(opslag, { feeddb: fdb, audiodb: adb });
    // Een worker is ingesteld, maar een debat heeft hem niet nodig.
    opslag.instellingen.audio = { ...opslag.instellingen.audio, workerUrl: 'http://127.0.0.1:9', workerToken: 'x' };
    const p = Object.fromEntries(new URL(await koppelAdres(opslag, TERUG)).searchParams);
    net.staat.challenge = p.code_challenge;
    await rondKoppelingAf(opslag, { code: 'code-1', state: p.state });
    opslag.regios = { heerenveen: { sleutelwoorden: [{ term: 'N31', actief: true }] } };
    const jan = herken(opslag, { login: 'jan', email: 'jan@example.nl', naam: 'Jan' });
    jan.regios = ['heerenveen'];

    const bron = { id: 'kamerdebatten', naam: 'Kamerdebatten (gehoord.de)', soort: 'kamerdebat', bereik: 'landelijk', type: 'audio', url: 'https://gehoord.de/beraadslagingen', aangemaakt: new Date().toISOString(), audio: { kind: 'gehoord', eersteImport: 0, actief: true, prioriteit: 0 } };
    opslag.bronnen.push(bron);
    const verwerking = new Verwerking({ opslag, adb });
    assert.deepEqual(await verwerking.synchroniseer(bron), { ok: true, nieuw: 2, aantal: 2 }, 'de regeling met één fragment niet');
    assert.deepEqual(net.staat.aanroepen.filter(([n]) => n === 'search_debates').map(([, a]) => a.offset), [0, 2]);
    // Een nieuwere vergadering uit een archief wacht: een debat kost geen GPU en gaat voor.
    const raad = { id: 'raad', naam: 'Raad', soort: 'raadsvergadering', bereik: 'regio', regio: 'heerenveen', type: 'audio', url: 'https://x.test/', audio: { kind: 'notubiz', actief: true, prioriteit: -5 } };
    opslag.bronnen.push(raad);
    adb.voegToe(raad, { extern: 'ntb:1/1', vorm: 'vergadering', url: 'https://x.test/v/1', titel: 'Raadsvergadering', gepubliceerdOp: Date.now() / 1000 }, { nulmeting: true });
    assert.deepEqual(verwerking.volgende(Date.now() / 1000 + 60).map((r) => adb.aflevering(r.id).bron), ['kamerdebatten', 'kamerdebatten', 'raad']);
    // Een nieuwe vergadering (geen archief) gaat wel voor.
    adb.voegToe(raad, { extern: 'ntb:1/2', vorm: 'vergadering', url: 'https://x.test/v/2', titel: 'Nieuwe raad', gepubliceerdOp: Date.now() / 1000 });
    assert.equal(adb.aflevering(verwerking.volgende(Date.now() / 1000 + 60)[0].id).titel, 'Nieuwe raad');
    adb.db.prepare("DELETE FROM afleveringen WHERE extern IN ('ntb:1/1', 'ntb:1/2')").run();

    assert.equal(await verwerking.verwerkEen(), true);
    const a = adb.lijst({ bron: 'kamerdebatten' }).map((x) => adb.aflevering(x.id)).find((x) => x.transcript);
    assert.equal(a.titel, 'Begrotingen Infrastructuur en Waterstaat · Mobiliteitsfonds 2027 (voortzetting)');
    assert.equal(a.status, 'getranscribeerd');
    assert.match(a.transcript, /^Ik open de vergadering\. .* Dan de N31 bij Leeuwarden/);
    assert.deepEqual(a.segmenten.map((x) => x.fragment), [11, 12, 13, 14]);
    // Op de klok van de video: het eerste fragment (23:59:50) is 110,5 s na het eerste beeld (23:57:59,5).
    assert.deepEqual(a.segmenten.map((x) => x.start), [110.5, 140.5, 190.5, 210.5]);
    assert.equal(a.duur, 215.5);
    assert.equal(a.platform.tijdbasis, 'video');
    assert.deepEqual(net.staat.aanroepen.filter(([n]) => n === 'get_transcript').map(([, x]) => [x.debate_id, x.offset]), [[307215, 0], [307215, 2]]);

    // Een landelijke bron: via het sleutelwoord naar Heerenveen, met de tijd en een link naar dat fragment.
    const d = detail({ opslag, fdb, adb }, jan, `a:${a.id}`);
    assert.deepEqual([d.soort, d.soortNaam, d.groep, d.audio, d.gehoord, d.regios], ['kamerdebat', 'Kamerdebat', 'kamerdebat', true, true, ['heerenveen']]);
    assert.equal(d.treffers.find((t) => t.term === 'N31').tijd, 190.5, 'de tijd in de video');
    assert.equal(d.segmenten[2].link, `${BASIS}/beraadslagingen/307215?segment=13`);
    assert.equal(d.speler, null);
    assert.equal(d.meta.find((m) => m.k === 'Soort debat').v, 'Plenair debat');
    assert.match(d.meta.find((m) => m.k === 'Let op').v, /zonder hoofdletters/);

    // De video: de stream van Debat Direct, beperkt tot het debat, en de kloktijd
    // van het eerste fragment; één keer opgezocht en daarna bewaard.
    const { roep: roepApi } = await import('./api-hulp.mjs');
    let r = await roepApi({ opslag, fdb, adb }, jan, 'GET', `/api/stuk/video?id=a:${a.id}`);
    const hls = new URL(r.data.video.hls);
    assert.deepEqual([hls.origin + hls.pathname, hls.searchParams.get('subtitles'), hls.searchParams.get('start'), hls.searchParams.get('end')],
      ['https://stream.test/2026-10-29/plenairezaal/index.m3u8', 'vod', '2026-10-29T23:58:00+0100', '2026-10-30T01:00:00+0100']);
    assert.deepEqual([r.data.video.begin, r.data.nul], ['2026-10-29T22:57:59.500Z', '2026-10-29T22:57:59.500Z'], 'het eerste beeld uit de stream, niet startedAt');
    assert.equal(r.data.klokBegin, new Date(2026, 9, 29, 23, 59, 50).toISOString());
    assert.deepEqual(net.staat.dd, ['agenda', 'debat'], 'al opgezocht bij het binnenhalen');

    // Een debat van vóór de klok van de video: één keer omgezet bij het openen.
    const oud = { ...a.platform };
    delete oud.tijdbasis;
    delete oud.video;
    adb.werkBij(a.id, { platform: oud, segmenten: a.segmenten.map((x) => ({ ...x, start: x.start - 110.5, end: x.end - 110.5 })) });
    r = await roepApi({ opslag, fdb, adb }, jan, 'GET', `/api/stuk/video?id=a:${a.id}`);
    assert.equal(r.data.omgezet, true);
    assert.deepEqual(adb.aflevering(a.id).segmenten.map((x) => x.start), [110.5, 140.5, 190.5, 210.5]);
    r = await roepApi({ opslag, fdb, adb }, jan, 'GET', `/api/stuk/video?id=a:${a.id}`);
    assert.equal(r.data.omgezet, undefined, 'daarna uit de opslag');
    assert.deepEqual(adb.aflevering(a.id).segmenten.map((x) => x.start), [110.5, 140.5, 190.5, 210.5], 'niet nog eens verschoven');
    assert.equal((await roepApi({ opslag, fdb, adb }, jan, 'GET', '/api/stuk/video?id=a:bestaatniet')).status, 404);
  } finally {
    net.herstel();
  }
});
