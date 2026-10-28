// Ollama zonder echte Ollama: een nagebootste server achter een nagebootste
// HTTP-proxy (zoals de Tailscale-container). Zo testen we de hele route: proxy,
// vraag met JSON-schema en contextvenster, en het terugvertalen van het antwoord.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Opslag } from '../src/opslag.mjs';
import { maakSamenvatting, samenvattingAanbieder, vraagVoorOllama } from '../src/samenvatting.mjs';
import { ollamaInfo } from '../src/ollama.mjs';
import { regioOpId } from '../src/regios.mjs';

const leegOpslag = () => new Opslag(mkdtempSync(path.join(tmpdir(), 'rc-test-')));
const luister = (server) => new Promise((klaar) => server.listen(0, '127.0.0.1', () => klaar(server.address().port)));

// server.close() wacht op open verbindingen; keep-alive en proxytunnels houden
// het testproces anders in leven.
function bijhouden(server) {
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.sluit = () => { for (const s of sockets) s.destroy(); server.close(); };
  return server;
}

const ITEMS = [
  { sleutel: 'groningen-woo:kiosk', regio: 'groningen', soort: 'woo', titel: 'Kiosk Grote Markt', soortStuk: 'Woo-verzoek of -besluit', datum: '2026-10-19', url: 'https://open.groningen.nl/publicaties/kiosk' },
  { sleutel: 'groningen-nieuws:casino', regio: 'groningen', soort: 'nieuws', titel: 'Sloop gestart op voormalige locatie Holland Casino', tekst: 'Wethouder gaf het startsein.', datum: '2026-10-20', url: 'https://gemeente.groningen.nl/sloop' },
];

async function nepOllama(antwoord) {
  const verzoeken = [];
  const server = bijhouden(http.createServer(async (req, res) => {
    let ruw = '';
    for await (const stuk of req) ruw += stuk;
    verzoeken.push({ pad: req.url, body: ruw ? JSON.parse(ruw) : null });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/version') return res.end(JSON.stringify({ version: '0.12.3' }));
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen3:14b', size: 9.3e9, details: { parameter_size: '14.8B' } }, { name: 'llama3.1:8b', size: 4.9e9, details: { parameter_size: '8.0B' } }] }));
    if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion', ...(verzoeken.at(-1).body.model.startsWith('qwen3') ? ['thinking'] : [])] }));
    if (req.url === '/api/chat') return res.end(JSON.stringify(antwoord));
    res.statusCode = 404;
    res.end('{"error":"niet gevonden"}');
  }));
  return { server, verzoeken, poort: await luister(server) };
}

// Minimale HTTP-proxy met CONNECT, zoals de outbound proxy van Tailscale.
async function nepProxy() {
  const tunnels = [];
  const server = bijhouden(http.createServer((req, res) => { res.statusCode = 405; res.end(); }));
  const open = new Set();
  server.on('connect', (req, klant, kop) => {
    tunnels.push(req.url);
    open.add(klant);
    const [host, poort] = req.url.split(':');
    const doel = net.connect(Number(poort), host, () => {
      klant.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      doel.write(kop);
      doel.pipe(klant);
      klant.pipe(doel);
    });
    open.add(doel);
    doel.on('error', () => klant.destroy());
  });
  const sluit = server.sluit;
  server.sluit = () => { for (const s of open) s.destroy(); sluit(); };
  return { server, tunnels, poort: await luister(server) };
}

test('aanbieder kiezen: wat ontbreekt er nog?', () => {
  const opslag = leegOpslag();
  delete process.env.ANTHROPIC_API_KEY;
  assert.deepEqual(samenvattingAanbieder(opslag), { via: 'claude', klaar: false, reden: 'er is nog geen Claude-API-sleutel ingesteld' });
  opslag.instellingen.samenvattingVia = 'ollama';
  assert.equal(samenvattingAanbieder(opslag).reden, 'de Ollama-URL is nog niet ingesteld');
  opslag.instellingen.ollama.url = 'http://gpu-doos:11434';
  assert.equal(samenvattingAanbieder(opslag).reden, 'er is nog geen Ollama-model gekozen');
  opslag.instellingen.ollama.model = 'qwen3:14b';
  assert.deepEqual(samenvattingAanbieder(opslag), { via: 'ollama', klaar: true, model: 'ollama:qwen3:14b' });
  opslag.instellingen.samenvattingVia = 'uit';
  assert.equal(samenvattingAanbieder(opslag).klaar, false);
});

test('Ollama via de proxy: modellen ophalen en samenvatting maken', async () => {
  const ollama = await nepOllama({
    model: 'qwen3:14b',
    message: { role: 'assistant', content: JSON.stringify({ punten: [{ zin: 'Een Woo-besluit over de kiosk op de Grote Markt.', items: ['i1', 'i9'] }] }) },
    done: true,
    done_reason: 'stop',
  });
  const proxy = await nepProxy();
  process.env.REGIOCHECKER_TAILNET_PROXY = `http://127.0.0.1:${proxy.poort}`;
  try {
    const url = `http://127.0.0.1:${ollama.poort}`;
    const info = await ollamaInfo(url);
    assert.equal(info.versie, '0.12.3');
    assert.deepEqual(info.modellen.map((m) => m.naam), ['llama3.1:8b', 'qwen3:14b']);

    const opslag = leegOpslag();
    Object.assign(opslag.instellingen, { samenvattingVia: 'ollama', ollama: { url, model: 'qwen3:14b', maxContext: 32768 } });
    const resultaat = await maakSamenvatting({ opslag, regio: regioOpId('groningen'), items: ITEMS });
    assert.deepEqual(resultaat, { punten: [{ zin: 'Een Woo-besluit over de kiosk op de Grote Markt.', items: ['groningen-woo:kiosk'] }] });

    const chat = ollama.verzoeken.find((v) => v.pad === '/api/chat').body;
    assert.equal(chat.model, 'qwen3:14b');
    assert.equal(chat.stream, false);
    assert.equal(chat.think, false, 'denkend model: nadenken uit');
    assert.equal(chat.format.type, 'object');
    assert.deepEqual(chat.format.required, ['punten']);
    assert.equal(chat.messages[0].role, 'system');
    assert.match(chat.messages[1].content, /\[i1\] Woo-publicaties .*Kiosk Grote Markt/s);
    assert.equal(chat.options.num_ctx, 8192);
    assert.ok(proxy.tunnels.length >= 1, 'verkeer liep via de proxy');
    assert.ok(proxy.tunnels.every((t) => t === `127.0.0.1:${ollama.poort}`));

    // Tweede keer uit de cache, zonder Ollama.
    await maakSamenvatting({ opslag, regio: regioOpId('groningen'), items: ITEMS });
    assert.equal(ollama.verzoeken.filter((v) => v.pad === '/api/chat').length, 1);
  } finally {
    delete process.env.REGIOCHECKER_TAILNET_PROXY;
    ollama.server.sluit();
    proxy.server.sluit();
  }
});

test('Ollama: afgekapt antwoord en onbereikbare machine geven een leesbare fout', async () => {
  const ollama = await nepOllama({ model: 'x', message: { content: '{"samenv' }, done: true, done_reason: 'length' });
  try {
    const opslag = leegOpslag();
    Object.assign(opslag.instellingen, { samenvattingVia: 'ollama', ollama: { url: `http://127.0.0.1:${ollama.poort}`, model: 'x', maxContext: 32768 } });
    await assert.rejects(maakSamenvatting({ opslag, regio: regioOpId('groningen'), items: ITEMS }), /afgekapt/);
    // Model 'x' kan niet nadenken: dan geen think-parameter meesturen.
    assert.equal('think' in ollama.verzoeken.find((v) => v.pad === '/api/chat').body, false);
  } finally {
    ollama.server.sluit();
  }
  // Een poort die net vrij is gekomen: daar luistert niemand.
  const tijdelijk = http.createServer();
  const vrij = await luister(tijdelijk);
  await new Promise((klaar) => tijdelijk.close(klaar));
  await assert.rejects(ollamaInfo(`http://127.0.0.1:${vrij}`), /Ollama niet bereikbaar \(ECONNREFUSED\)/);
});

test('Ollama: lange weken passen in het contextvenster door de inhoud in te korten', () => {
  const veel = Array.from({ length: 120 }, (_, i) => ({ sleutel: `k${i}`, soort: 'nieuws', titel: `Bericht ${i}`, inhoud: 'x'.repeat(6000) }));
  const ruim = vraagVoorOllama('Groningen', veel, 262144);
  assert.equal(ruim.ingekort, false);
  assert.ok(ruim.context > 32768);
  const krap = vraagVoorOllama('Groningen', veel, 32768);
  assert.equal(krap.ingekort, true);
  assert.equal(krap.past, true);
  assert.ok(krap.context <= 32768);
  assert.match(krap.vraag, /Bericht 119/, 'alle titels blijven staan');
  const veelTeKrap = vraagVoorOllama('Groningen', veel, 4096);
  assert.equal(veelTeKrap.past, false);
});

test('Ollama via Tailscale: de echte reden uit de proxy wordt een concrete tip', async () => {
  // Nagebootste Tailscale-proxy die elke tunnel weigert met de kop die Tailscale meestuurt.
  const proxy = bijhouden(http.createServer());
  proxy.on('connect', (req, klant) => {
    klant.end('HTTP/1.1 500 Internal Server Error\r\nTailscale-Connect-Error: connect tcp 100.64.0.10:11434: connection was refused\r\nContent-Length: 0\r\n\r\n');
  });
  process.env.REGIOCHECKER_TAILNET_PROXY = `http://127.0.0.1:${await luister(proxy)}`;
  try {
    await assert.rejects(ollamaInfo('http://ollama-machine:11434'), /bereikbaar via Tailscale, maar weigert poort 11434.*OLLAMA_HOST=0\.0\.0\.0/);
  } finally {
    delete process.env.REGIOCHECKER_TAILNET_PROXY;
    proxy.sluit();
  }
});

test('Ollama: één aanvraag tegelijk, en dezelfde samenvatting maar één keer', async () => {
  let actief = 0;
  let maxActief = 0;
  const chats = [];
  const server = bijhouden(http.createServer(async (req, res) => {
    let ruw = '';
    for await (const stuk of req) ruw += stuk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion'] }));
    actief++;
    maxActief = Math.max(maxActief, actief);
    chats.push(JSON.parse(ruw).messages[1].content.split('\n')[0]);
    await new Promise((klaar) => setTimeout(klaar, 150));
    actief--;
    res.end(JSON.stringify({ model: 'x', done: true, done_reason: 'stop', message: { content: JSON.stringify({ punten: [{ zin: 'De kiosk [i1] en de sloop [i2][i1].', items: ['i1'] }] }) } }));
  }));
  const poort = await luister(server);
  try {
    const opslag = leegOpslag();
    Object.assign(opslag.instellingen, { samenvattingVia: 'ollama', ollama: { url: `http://127.0.0.1:${poort}`, model: 'x', maxContext: 32768 } });
    const groningen = regioOpId('groningen');
    const ander = { ...ITEMS[0], sleutel: 'heerenveen-ingekomen:a', regio: 'heerenveen' };
    const [a, b, c] = await Promise.all([
      maakSamenvatting({ opslag, regio: groningen, items: ITEMS }),
      maakSamenvatting({ opslag, regio: groningen, items: ITEMS }),
      maakSamenvatting({ opslag, regio: regioOpId('heerenveen'), items: [ander] }),
    ]);
    assert.equal(chats.length, 2, 'Groningen één keer, Heerenveen één keer');
    assert.equal(maxActief, 1, 'nooit twee aanvragen tegelijk bij Ollama');
    assert.deepEqual(a, b);
    assert.equal(a.punten[0].zin, 'De kiosk en de sloop.', 'verwijzingen uit de zin gehaald');
    assert.ok(c.punten.length);
  } finally {
    server.sluit();
  }
});
