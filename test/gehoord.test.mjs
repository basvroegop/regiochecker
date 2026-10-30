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
import { koppelAdres, rondKoppelingAf, toegang, gehoordStatus, gehoordTools, ontkoppel } from '../src/gehoord.mjs';
import { publiekeInstellingen } from '../src/instellingen.mjs';
import { leesStroom } from '../src/mcp.mjs';
import { herken, nieuweGebruiker } from '../src/gebruikers.mjs';
import { roep } from './api-hulp.mjs';

const BASIS = 'https://gehoord.test';
process.env.GEHOORD_URL = BASIS;
const TERUG = 'https://regiochecker.test/api/beheer/gehoord/terug';
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function nepGehoord() {
  const staat = { registraties: [], tokens: [], mcp: [], ververs: 'goed', uitgedeeld: 0, challenge: null };
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
    return json({ jsonrpc: '2.0', id: b.id, error: { code: -32601, message: 'onbekend' } });
  }).persist();
  const vorige = zetOpenbaarDispatcher(agent);
  return { staat, herstel: () => zetOpenbaarDispatcher(vorige) };
}

const leegOpslag = () => new Opslag(mkdtempSync(path.join(tmpdir(), 'rc-gehoord-')));

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
