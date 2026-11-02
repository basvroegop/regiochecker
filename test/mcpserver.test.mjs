// De MCP-server (src/mcpserver.mjs) en het inloggen daarvoor (src/oauth.mjs),
// via een lokale HTTP-server die routeert zoals src/dienst.mjs. De ingelogde
// gebruiker van Authelia speelt de test na met de kop x-test-gebruiker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Opslag } from '../src/opslag.mjs';
import { nieuweGebruiker } from '../src/gebruikers.mjs';
import { lokaleDatum } from '../src/datum.mjs';
import { roep } from './api-hulp.mjs';

const sqlite = await import('node:sqlite').catch(() => null);
const metSqlite = { skip: sqlite ? false : 'node:sqlite niet beschikbaar (Node 22+ nodig)' };
const uurGeleden = (u) => new Date(Date.now() - u * 3600000).toISOString();
const BASIS = 'https://checker.test';
const TERUG = 'https://claude.example/api/mcp/auth_callback';
const E1 = 'e1'.repeat(16);

async function opzet() {
  process.env.REGIOCHECKER_SITE_URL = BASIS;
  const { openKamerDb } = await import('../src/kamer/db.mjs');
  const { openFeedDb } = await import('../src/feeddb.mjs');
  const { AudioDb } = await import('../src/audio/db.mjs');
  const { OAuth, isOAuthPad, oauthRoute } = await import('../src/oauth.mjs');
  const { mcpRoute } = await import('../src/mcpserver.mjs');
  // Geen echt internet: een document ophalen bij de bron faalt meteen.
  const { MockAgent } = await import('undici');
  const { zetOpenbaarDispatcher } = await import('../src/netwerk.mjs');
  const internet = new MockAgent();
  internet.disableNetConnect();
  zetOpenbaarDispatcher(internet);
  const map = mkdtempSync(path.join(tmpdir(), 'rc-mcp-'));
  const opslag = new Opslag(map);
  const kdb = await openKamerDb(path.join(map, 'k.sqlite'));
  const fdb = await openFeedDb(path.join(map, 'f.sqlite'));
  const adb = new AudioDb(fdb.db);
  Object.assign(opslag, { kamer: kdb, feeddb: fdb, audiodb: adb });
  opslag.regios = { smallingerland: { sleutelwoorden: [{ term: 'Drachten', actief: true }] } };
  opslag.bronnen = [
    { id: 'raad', naam: 'Smallingerland · Raad', soort: 'raadsvergadering', bereik: 'regio', regio: 'smallingerland', type: 'audio', url: 'https://smallingerland.raadsinformatie.nl/', audio: { kind: 'notubiz', prioriteit: 0 } },
  ];
  const item = (sleutel, extra) => ({ sleutel, titel: sleutel, url: `https://x/${sleutel}`, datum: lokaleDatum(), eersteGezien: uurGeleden(2), laatstGezien: uurGeleden(1), basislijn: false, ...extra });
  for (const i of [
    item('smallingerland-nieuws:a', { bron: 'smallingerland-nieuws', regio: 'smallingerland', soort: 'nieuws', titel: 'Huisartsenpost Drachten blijft open', inhoud: 'De huisartsenpost in Drachten blijft ook ’s nachts open. '.repeat(40) }),
    item('opsterland-nieuws:b', { bron: 'opsterland-nieuws', regio: 'opsterland', soort: 'nieuws', titel: 'Bakkeveen: omleiding', inhoud: 'Ook de huisartsenpost blijft bereikbaar.' }),
    item('telegram:t1', { bron: 'telegram', regio: null, soort: 'ingezonden', titel: 'Tip over de huisartsenpost', tekst: 'Huisartsenpost in Drachten dicht?', inzender: { naam: 'Tipgever', telefoon: '+31600000000' } }),
  ]) opslag.items[i.sleutel] = i;
  // Het document achter het nieuwsbericht is al opgehaald.
  fdb.zetDocument('smallingerland-nieuws:a', { blokken: [['k', 'Huisartsenpost'], ['p', opslag.items['smallingerland-nieuws:a'].inhoud], ['d', 'Bijlage'], ['p', 'Openingstijden van de huisartsenpost.']], volledig: true });
  kdb.bewaarStuk({ id: 'doc1', nummer: '2026D1', soort: 'Schriftelijke vragen', titel: 'Vragen', onderwerp: 'Vragen over de huisartsenpost', datum: lokaleDatum(), vergaderjaar: '2026-2027', dossier: null, dossiertitel: null, zaak: '2026Z1', afzender: 'Lid Van der Meer', contenttype: 'application/pdf', gewijzigd: 'x' });
  kdb.bewaarTekst(kdb.db.prepare('SELECT nr FROM stukken WHERE id = ?').get('doc1').nr, 'De huisartsenpost in Drachten sluit ’s nachts. Is de minister daarvan op de hoogte?');
  const raad = opslag.bronnen[0];
  adb.voegToe(raad, { id: E1, extern: E1, vorm: 'vergadering', titel: 'Raadsvergadering 23 oktober', url: 'https://smallingerland.raadsinformatie.nl/v/1', gepubliceerdOp: Date.now() / 1000 - 30 * 3600, duur: 100 });
  const segmenten = [
    { start: 0, end: 10, text: 'Het woord is aan wethouder Kramer.', speaker: 'Voorzitter' },
    { start: 10, end: 20, text: 'De huisartsenpost in Drachten moet blijven.', speaker: 'Kramer' },
    { start: 20, end: 25, text: 'Daar sta ik achter.', speaker: 'Kramer' },
  ];
  adb.werkBij(E1, { transcript: segmenten.map((x) => x.text).join(' '), segmenten, status: 'klaar', eersteGezien: uurGeleden(3) });
  const sanne = nieuweGebruiker(opslag.instellingen, { login: 'sanne', naam: 'Sanne', email: 'sanne@lc.nl', regios: ['smallingerland'] });
  const piet = nieuweGebruiker(opslag.instellingen, { login: 'piet', naam: 'Piet', email: 'piet@lc.nl', regios: [] });
  opslag.gebruikers.push(sanne, piet);

  let klok = Date.now();
  const oauth = new OAuth(fdb.db, { bestaat: (id) => opslag.gebruikers.some((g) => g.id === id), klok: () => klok });
  const ctx = { opslag, kdb, fdb, adb, oauth };
  // Zoals src/dienst.mjs: de gebruiker achter Authelia komt uit een kop.
  const wie = (req) => {
    const login = req.headers['x-test-gebruiker'];
    if (!login) return undefined;
    return opslag.gebruikers.find((g) => g.login === login) || null;
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/mcp') return await mcpRoute(req, res, url, ctx);
      if (isOAuthPad(url.pathname)) return await oauthRoute(req, res, url, { oauth, opslag, wie });
      res.writeHead(404);
      res.end();
    } catch (fout) {
      res.writeHead(500);
      res.end(fout.stack);
    }
  });
  await new Promise((klaar) => server.listen(0, '127.0.0.1', klaar));
  const adres = `http://127.0.0.1:${server.address().port}`;
  const haal = (pad, opties = {}) => fetch(`${adres}${pad}`, { redirect: 'manual', ...opties });
  return { opslag, ctx, oauth, sanne, piet, haal, stop: () => server.close(), verzet: (ms) => { klok += ms; } };
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, uitdaging: createHash('sha256').update(verifier).digest('base64url') };
};
const formulier = (velden) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(velden).toString() });

// Aanmelden, toestemming geven, code inwisselen: zoals claude.ai het doet.
async function koppel(t, { login = 'sanne', registratie = {} } = {}) {
  const reg = await (await t.haal('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [TERUG], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], ...registratie }) })).json();
  const { verifier, uitdaging } = pkce();
  const vraag = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: TERUG, code_challenge: uitdaging, code_challenge_method: 'S256', state: 'xyz', resource: `${BASIS}/mcp`, scope: 'zoeken' });
  const scherm = await t.haal(`/oauth/authorize?${vraag}`, { headers: { 'x-test-gebruiker': login } });
  const html = await scherm.text();
  const verzoek = /name="verzoek" value="([^"]+)"/.exec(html)?.[1];
  const besluit = await t.haal('/oauth/authorize', { ...formulier({ verzoek, besluit: 'toestaan' }), headers: { ...formulier({}).headers, 'x-test-gebruiker': login, origin: BASIS } });
  const terug = new URL(besluit.headers.get('location'));
  const code = terug.searchParams.get('code');
  const tokens = await (await t.haal('/oauth/token', formulier({ grant_type: 'authorization_code', code, redirect_uri: TERUG, client_id: reg.client_id, code_verifier: verifier, resource: `${BASIS}/mcp` }))).json();
  return { reg, scherm, html, verzoek, besluit, terug, code, verifier, tokens };
}

const rpc = async (t, token, methode, params, id = 1) => {
  const r = await t.haal('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id, method: methode, ...(params ? { params } : {}) }) });
  return { status: r.status, kop: r.headers, data: r.status === 202 ? null : await r.json() };
};
const tool = async (t, token, naam, args) => (await rpc(t, token, 'tools/call', { name: naam, arguments: args })).data.result;

test('MCP: ontdekken, aanmelden, toestemming en tokens zoals claude.ai het doet', metSqlite, async () => {
  const t = await opzet();
  try {
    // Zonder token: 401 met de weg naar de metadata (RFC 9728).
    const zonder = await rpc(t, null, 'initialize', {});
    assert.equal(zonder.status, 401);
    assert.equal(zonder.kop.get('www-authenticate'), `Bearer resource_metadata="${BASIS}/.well-known/oauth-protected-resource/mcp"`);
    const prm = await (await t.haal('/.well-known/oauth-protected-resource/mcp')).json();
    assert.deepEqual([prm.resource, prm.authorization_servers], [`${BASIS}/mcp`, [BASIS]]);
    const as = await (await t.haal('/.well-known/oauth-authorization-server')).json();
    assert.equal(as.issuer, BASIS);
    assert.equal(as.registration_endpoint, `${BASIS}/oauth/register`);
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);

    const k = await koppel(t);
    assert.equal(k.scherm.status, 200);
    assert.match(k.html, /<strong>Claude<\/strong> vraagt toegang/);
    assert.match(k.html, /claude\.example/, 'de bestemming staat op het scherm');
    assert.match(k.scherm.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(k.besluit.status, 303);
    assert.equal(k.terug.origin + k.terug.pathname, TERUG);
    assert.deepEqual([k.terug.searchParams.get('state'), k.terug.searchParams.get('iss')], ['xyz', BASIS]);
    assert.equal(k.tokens.token_type, 'Bearer');
    assert.match(k.tokens.access_token, /^rct_/);
    assert.equal(t.opslag.logboek[0].soort, 'koppeling');

    // Ingelogd: initialize en de tools.
    const init = await rpc(t, k.tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.data.result.protocolVersion, '2025-06-18');
    assert.equal(init.data.result.serverInfo.name, 'regiochecker');
    assert.equal((await rpc(t, k.tokens.access_token, 'initialize', { protocolVersion: '1999-01-01' })).data.result.protocolVersion, '2025-11-25');
    const melding = await t.haal('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${k.tokens.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.equal(melding.status, 202);
    const lijst = (await rpc(t, k.tokens.access_token, 'tools/list')).data.result.tools;
    assert.deepEqual(lijst.map((x) => x.name), ['zoeken', 'kamerstukken_zoeken', 'nieuwste', 'stuk_lezen', 'regios_en_soorten']);
    assert.ok(lijst.every((x) => x.annotations.readOnlyHint && x.inputSchema.type === 'object'));
    assert.ok(!lijst[0].inputSchema.properties.soorten.items.enum.includes('ingezonden'));
    assert.equal((await rpc(t, k.tokens.access_token, 'bestaat/niet')).data.error.code, -32601);
    assert.equal((await t.haal('/mcp', { headers: { authorization: `Bearer ${k.tokens.access_token}` } })).status, 405, 'geen SSE-stroom');

    // Vernieuwen: een nieuw paar; het oude vernieuwtoken werkt daarna niet meer.
    const nieuw = await (await t.haal('/oauth/token', formulier({ grant_type: 'refresh_token', refresh_token: k.tokens.refresh_token, client_id: k.reg.client_id }))).json();
    assert.match(nieuw.access_token, /^rct_/);
    assert.notEqual(nieuw.refresh_token, k.tokens.refresh_token);
    const weer = await t.haal('/oauth/token', formulier({ grant_type: 'refresh_token', refresh_token: k.tokens.refresh_token, client_id: k.reg.client_id }));
    assert.equal((await weer.json()).error, 'invalid_grant');
    assert.equal((await rpc(t, nieuw.access_token, 'ping')).status, 200, 'binnen een minuut: alleen geweigerd, niet ingetrokken');
    // Later nog eens het oude: gestolen, dus de hele koppeling eruit.
    t.verzet(120_000);
    await t.haal('/oauth/token', formulier({ grant_type: 'refresh_token', refresh_token: k.tokens.refresh_token, client_id: k.reg.client_id }));
    assert.equal((await rpc(t, nieuw.access_token, 'ping')).status, 401);

    // Een toegangstoken verloopt na een uur.
    const k2 = await koppel(t);
    assert.equal((await rpc(t, k2.tokens.access_token, 'ping')).status, 200);
    t.verzet(3601_000);
    const verlopen = await rpc(t, k2.tokens.access_token, 'ping');
    assert.equal(verlopen.status, 401);
    assert.match(verlopen.kop.get('www-authenticate'), /error="invalid_token"/);
  } finally {
    t.stop();
  }
});

test('MCP: wat niet mag bij aanmelden, toestemming en inwisselen', metSqlite, async () => {
  const t = await opzet();
  try {
    const registreer = (velden) => t.haal('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'X', token_endpoint_auth_method: 'none', ...velden }) });
    for (const fout of [['javascript:alert(1)'], ['http://aanvaller.example/terug'], ['https://x.example/#frag'], []]) {
      assert.equal((await registreer({ redirect_uris: fout })).status, 400, `geweigerd: ${fout}`);
    }
    // Wel: Claude Code (loopback), een eigen schema van een desktop-app.
    assert.equal((await registreer({ redirect_uris: ['http://localhost:33418/callback'] })).status, 201);
    assert.equal((await registreer({ redirect_uris: ['cursor://anysphere.cursor-retrieval/oauth/callback'] })).status, 201);

    const reg = await (await registreer({ redirect_uris: [TERUG] })).json();
    const { verifier, uitdaging } = pkce();
    const autoriseer = (velden, login = 'sanne') => t.haal(`/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: TERUG, code_challenge: uitdaging, code_challenge_method: 'S256', ...velden })}`, login ? { headers: { 'x-test-gebruiker': login } } : {});
    // Niet ingelogd, of geen gebruiker van de Regiochecker.
    assert.equal((await autoriseer({}, null)).status, 401);
    // Met het gedeelde wachtwoord (src/inloggen.mjs): eerst inloggen, daarna terug naar dit scherm.
    process.env.REGIOCHECKER_WACHTWOORD = 'scrypt:a:b';
    try {
      const naarInloggen = await autoriseer({ state: 's0' }, null);
      assert.equal(naarInloggen.status, 303);
      const doel = new URL(naarInloggen.headers.get('location'), BASIS);
      assert.equal(doel.pathname, '/inloggen');
      assert.match(doel.searchParams.get('terug'), /^\/oauth\/authorize\?.*client_id=rca_.*state=s0/);
    } finally {
      delete process.env.REGIOCHECKER_WACHTWOORD;
    }
    assert.equal((await autoriseer({}, 'onbekend')).status, 403);
    // Een ander terugkeeradres of een onbekende app: een foutpagina, níet terug naar dat adres.
    const vreemd = await autoriseer({ redirect_uri: 'https://aanvaller.example/x' });
    assert.equal(vreemd.status, 400);
    assert.equal(vreemd.headers.get('location'), null);
    assert.equal((await autoriseer({ client_id: 'rca_bestaatniet' })).status, 400);
    // Zonder PKCE: de fout gaat wel terug naar de (bekende) app.
    const zonderPkce = await autoriseer({ code_challenge: '', state: 's1' });
    assert.equal(zonderPkce.status, 303);
    const fout = new URL(zonderPkce.headers.get('location'));
    assert.deepEqual([fout.searchParams.get('error'), fout.searchParams.get('state')], ['invalid_request', 's1']);

    // Het verzoek van Sanne kan Piet niet goedkeuren, en een andere site ook niet.
    const verzoek = /name="verzoek" value="([^"]+)"/.exec(await (await autoriseer({ state: 's2' })).text())[1];
    const keur = (login, origin) => t.haal('/oauth/authorize', { ...formulier({ verzoek, besluit: 'toestaan' }), headers: { ...formulier({}).headers, 'x-test-gebruiker': login, ...(origin ? { origin } : {}) } });
    assert.equal((await keur('piet', BASIS)).status, 400);
    assert.equal((await keur('sanne', 'https://aanvaller.example')).status, 400);
    const ok = await keur('sanne', BASIS);
    assert.equal(ok.status, 303);
    assert.equal((await keur('sanne', BASIS)).status, 400, 'een verzoek kan maar één keer');
    const code = new URL(ok.headers.get('location')).searchParams.get('code');

    const wissel = (velden) => t.haal('/oauth/token', formulier({ grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: TERUG, ...velden }));
    assert.equal((await (await wissel({ code_verifier: 'x'.repeat(43) })).json()).error, 'invalid_grant', 'verkeerde verifier');
    // Na een verkeerde verifier is de code weg (geen gokken).
    assert.equal((await (await wissel({ code_verifier: verifier })).json()).error, 'invalid_grant');

    // Een nieuwe code, dan twee keer inwisselen: de tweede keer trekt de eerste tokens in.
    const k = await koppel(t);
    const tweede = await t.haal('/oauth/token', formulier({ grant_type: 'authorization_code', code: k.code, client_id: k.reg.client_id, code_verifier: k.verifier }));
    assert.equal((await tweede.json()).error, 'invalid_grant');
    assert.equal((await rpc(t, k.tokens.access_token, 'ping')).status, 401);

    // Een app met een geheim (client_secret_basic): zonder of met een verkeerd geheim niet.
    const g = await koppel(t, { registratie: { token_endpoint_auth_method: 'client_secret_basic' } });
    assert.ok(g.reg.client_secret);
    assert.equal(g.tokens.error, 'invalid_client', 'koppel() stuurt geen geheim mee');

    // Een verwijderde gebruiker verliest zijn koppelingen meteen.
    const s = await koppel(t);
    assert.equal((await rpc(t, s.tokens.access_token, 'ping')).status, 200);
    t.opslag.gebruikers = t.opslag.gebruikers.filter((x) => x.login !== 'sanne');
    assert.equal((await rpc(t, s.tokens.access_token, 'ping')).status, 401);
  } finally {
    t.stop();
  }
});

test('MCP-tools: zoeken, Kamerstukken, nieuwste, lezen; ingezonden tips blijven erbuiten', metSqlite, async () => {
  const t = await opzet();
  try {
    const { tokens } = await koppel(t);
    const tk = tokens.access_token;

    const alles = await tool(t, tk, 'zoeken', { vraag: 'huisartsenpost' });
    assert.ok(!alles.isError);
    const tekst = alles.content[0].text;
    for (const id of ['i:smallingerland-nieuws:a', 'i:opsterland-nieuws:b', 'k:doc1', `a:${E1}`]) assert.ok(tekst.includes(`id: ${id}`), id);
    assert.ok(!tekst.includes('telegram'), 'geen ingezonden tips');
    assert.match(tekst, /\[0:00:10\] De huisartsenpost in Drachten moet blijven/, 'fragment met tijd uit het transcript');
    assert.match(tekst, /link: https:\/\/x\/smallingerland-nieuws:a/);

    // Op regio (naam of id, of "mijn"), soort en datum.
    const ids = async (args) => [...(await tool(t, tk, 'zoeken', { vraag: 'huisartsenpost', ...args })).content[0].text.matchAll(/id: (\S+)/g)].map((m) => m[1]).sort();
    assert.deepEqual(await ids({ regios: ['Opsterland'] }), ['i:opsterland-nieuws:b']);
    assert.deepEqual(await ids({ regios: ['mijn'] }), [`a:${E1}`, 'i:smallingerland-nieuws:a', 'k:doc1']);
    assert.deepEqual(await ids({ soorten: ['kamerstuk'] }), ['k:doc1']);
    assert.deepEqual(await ids({ soorten: ['Raadsvergaderingen'] }), [`a:${E1}`]);
    assert.match((await tool(t, tk, 'zoeken', { vraag: 'huisartsenpost', tot: '2020-01-01' })).content[0].text, /^Niets gevonden/);
    const onbekend = await tool(t, tk, 'zoeken', { vraag: 'x', regios: ['Atlantis'] });
    assert.equal(onbekend.isError, true);
    assert.match(onbekend.content[0].text, /Onbekende regio: Atlantis/);
    assert.equal((await tool(t, tk, 'zoeken', { vraag: 'x', soorten: ['ingezonden'] })).isError, true);

    const kamer = (await tool(t, tk, 'kamerstukken_zoeken', { vraag: 'huisartsenpost' })).content[0].text;
    assert.match(kamer, /^1 Kamerstukken/);
    assert.match(kamer, /\*\*huisartsenpost\*\*/);

    const nieuw = (await tool(t, tk, 'nieuwste', { regios: ['smallingerland'], dagen: 2 })).content[0].text;
    assert.ok(nieuw.includes('id: i:smallingerland-nieuws:a') && nieuw.includes(`id: a:${E1}`));
    assert.ok(nieuw.includes('id: k:doc1') && nieuw.includes('via sleutelwoord "Drachten"'));

    // Lezen: het transcript per beurt, met tijd en spreker.
    const audio = (await tool(t, tk, 'stuk_lezen', { id: `a:${E1}` })).content[0].text;
    assert.match(audio, /\[0:00:10\] Kramer: De huisartsenpost in Drachten moet blijven\. Daar sta ik achter\./);
    const kamerstuk = (await tool(t, tk, 'stuk_lezen', { id: 'k:doc1' })).content[0].text;
    assert.match(kamerstuk, /Is de minister daarvan op de hoogte\?/);
    // In delen, en alleen de passages rond een woord.
    const deel = (await tool(t, tk, 'stuk_lezen', { id: 'i:smallingerland-nieuws:a', lengte: 1000 })).content[0].text;
    assert.match(deel, /Tekens 0–1000 van \d+\. Vervolg: vanaf=1000\./);
    const zoek = (await tool(t, tk, 'stuk_lezen', { id: 'i:smallingerland-nieuws:a', zoek: 'huisartsenpost' })).content[0].text;
    assert.match(zoek, /\d+× gevonden: huisartsenpost/);
    assert.match(zoek, /\[positie \d+\]/);
    const tip = await tool(t, tk, 'stuk_lezen', { id: 'i:telegram:t1' });
    assert.equal(tip.isError, true);
    assert.ok(!tip.content[0].text.includes('+316'));

    const lijst = (await tool(t, tk, 'regios_en_soorten', {})).content[0].text;
    assert.match(lijst, /- smallingerland: Smallingerland/);
    assert.match(lijst, /Jouw regio's: Smallingerland\./);
    assert.ok(!/ingezonden/i.test(lijst.split('Archieven')[0]));
  } finally {
    t.stop();
  }
});

test('koppelingen in de webUI: zien en intrekken, alleen de eigen', metSqlite, async () => {
  const t = await opzet();
  try {
    const { tokens } = await koppel(t);
    const lijst = await roep(t.ctx, t.sanne, 'GET', '/api/koppelingen');
    assert.equal(lijst.data.adres, `${BASIS}/mcp`);
    assert.equal(lijst.data.koppelingen.length, 1);
    assert.deepEqual([lijst.data.koppelingen[0].app, lijst.data.koppelingen[0].bestemming], ['Claude', 'claude.example']);
    const id = lijst.data.koppelingen[0].id;
    assert.equal((await roep(t.ctx, t.piet, 'GET', '/api/koppelingen')).data.koppelingen.length, 0);
    assert.equal((await roep(t.ctx, t.piet, 'DELETE', `/api/koppelingen/${id}`)).status, 404, 'niet die van een ander');
    assert.equal((await rpc(t, tokens.access_token, 'ping')).status, 200);
    assert.equal((await roep(t.ctx, t.sanne, 'DELETE', `/api/koppelingen/${id}`)).status, 200);
    assert.equal((await rpc(t, tokens.access_token, 'ping')).status, 401);
    assert.equal((await roep(t.ctx, t.sanne, 'GET', '/api/koppelingen')).data.koppelingen.length, 0);
    // Ook het vernieuwtoken is weg.
    const r = await t.haal('/oauth/token', formulier({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: (await (await t.haal('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [TERUG], token_endpoint_auth_method: 'none' }) })).json()).client_id }));
    assert.equal((await r.json()).error, 'invalid_grant');
  } finally {
    t.stop();
  }
});
