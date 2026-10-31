// Audio en video, nu in de Regiochecker zelf: catalogi lezen (podcast,
// YouTube-adressen, Notubiz, iBabs met babscast of een mp3 per agendapunt, GemeenteOplossingen achter
// Anubis, een gemeentepagina die naar haar archief linkt), de
// verwerking tegen een nagebootste Whisper-worker (downloaden, ffmpeg,
// transcriberen, namen, nummers, herkansen, pauze, volgorde), het archief via
// de API, het overnemen van een audioscraper-archief, en de samenvatting van
// een raadsvergadering in de weekmail.
// node:sqlite (Node 22+) en ffmpeg zijn nodig; anders worden die tests overgeslagen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { Opslag } from '../src/opslag.mjs';
import { herken as herkenGebruiker, nieuweGebruiker } from '../src/gebruikers.mjs';
import { leesPodcast, youtubeAdres } from '../src/audio/catalogus.mjs';
import { nepWorker, nepPodcast, wav, TOKEN, STEM } from './nep-worker.mjs';
import { roep } from './api-hulp.mjs';

const sqlite = await import('node:sqlite').catch(() => null);
let ffmpeg = false;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); ffmpeg = true; } catch { /* niet aanwezig */ }
const metSqlite = { skip: sqlite ? false : 'node:sqlite niet beschikbaar (Node 22+ nodig)' };
const metAlles = { skip: !sqlite ? 'node:sqlite niet beschikbaar' : !ffmpeg ? 'ffmpeg niet aanwezig' : false };
const tijdelijk = () => mkdtempSync(path.join(tmpdir(), 'rc-audio-'));

// Nagebootste platforms draaien op 127.0.0.1; dat is normaal niet toegestaan.
process.env.REGIOCHECKER_PRIVE_ADRESSEN = '1';
process.env.GO_WACHT_MS = '0';
process.env.IBABS_WACHT_MS = '0';

test('catalogi: podcastfeed, YouTube-adressen, Notubiz-stream en de Anubis-puzzel', async () => {
  const { notubizStream, anubisNonce } = await import('../src/audio/vergaderingen.mjs');
  const feed = leesPodcast(`<rss><channel><title>Omrop &amp; Co</title><itunes:image href="https://x/hoes.jpg"/>
    <item><title><![CDATA[Afl. 2: De Haven]]></title><guid>g2</guid><pubDate>Tue, 27 Oct 2026 06:00:00 +0100</pubDate><link>https://x/2</link>
      <itunes:duration>1:02:03</itunes:duration><enclosure url="/m/2.mp3" type="audio/mpeg"/></item>
    <item><title>Alleen tekst</title><guid>g0</guid></item>
    <item><title>Afl. 1</title><guid>g1</guid><pubDate>Mon, 26 Oct 2026 06:00:00 +0100</pubDate><enclosure url="https://x/m/1.mp3" type=""/></item>
  </channel></rss>`, 'https://x/feed.xml');
  assert.equal(feed.titel, 'Omrop & Co');
  assert.deepEqual(feed.items.map((i) => [i.titel, i.mediaUrl, i.duur, i.afbeelding]), [['Afl. 2: De Haven', 'https://x/m/2.mp3', 3723, 'https://x/hoes.jpg'], ['Afl. 1', 'https://x/m/1.mp3', null, 'https://x/hoes.jpg']]);
  assert.equal(feed.items[0].extern, `rss:${createHash('sha256').update('https://x/feed.xml|g2').digest('hex')}`, 'dezelfde sleutel als audioscraper');
  assert.equal(feed.items[0].gepubliceerdOp, Date.parse('2026-10-27T05:00:00Z') / 1000);

  assert.deepEqual(youtubeAdres('https://youtu.be/dQw4w9WgXcQ'), { kind: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', video: 'dQw4w9WgXcQ' });
  assert.deepEqual(youtubeAdres('https://www.youtube.com/@omropfryslan/streams'), { kind: 'youtube-streams', url: 'https://www.youtube.com/@omropfryslan/streams' });
  assert.deepEqual(youtubeAdres('https://www.youtube.com/@omropfryslan', 'youtube-shorts'), { kind: 'youtube-shorts', url: 'https://www.youtube.com/@omropfryslan/shorts' });
  assert.equal(youtubeAdres('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1234567890ab', 'youtube-playlist').kind, 'youtube-playlist');
  assert.throws(() => youtubeAdres('https://www.youtube.com/feed/trending'), /kanaal, kanaaltab/);

  const pagina = `var media_files = []; media_file = { pubpoint: "rtmp://wowza1.notubiz.nl/nbvod", streamname: "Opname 1.mp4" }; media_files[0] = media_file; createPlayer({ title: "Raadsvergadering 23-10" })`;
  assert.equal(notubizStream(pagina), 'https://wowza1.notubiz.nl/nbvod/Opname 1.mp4/playlist.m3u8');
  assert.throws(() => notubizStream(pagina.replace('notubiz.nl', 'elders.nl')), /onbekende mediaserver/);

  const { antwoord, nonce } = anubisNonce('abc', 3);
  assert.equal(createHash('sha256').update(`abc${nonce}`).digest('hex'), antwoord);
  assert.match(antwoord, /^000/);
});

// Een nagebootst internet voor platforms die we op hun eigen domeinnaam
// herkennen: fetch beantwoordt alleen deze adressen.
// Een nagebootst internet voor platforms die we op hun eigen domeinnaam
// herkennen: de bewaakte verbinding (src/netwerk.mjs) wordt een undici
// MockAgent die alleen deze routes beantwoordt. Een route geeft een string
// (HTML), een object (JSON), { status, body }, of niets (404).
async function nepInternet(routes) {
  const { MockAgent } = await import('undici');
  const { zetOpenbaarDispatcher } = await import('../src/netwerk.mjs');
  const nep = new MockAgent();
  nep.disableNetConnect();
  const bezocht = [];
  nep.get(() => true).intercept({ path: () => true, method: () => true }).reply(({ origin, path }) => {
    const u = new URL(path, origin);
    bezocht.push(`${u.host}${u.pathname}`);
    const r = routes(u);
    if (r === undefined) return { statusCode: 404, data: 'niet gevonden' };
    if (r?.status) return { statusCode: r.status, data: r.body, responseOptions: { headers: { 'content-type': 'application/json' } } };
    if (Buffer.isBuffer(r)) return { statusCode: 200, data: r, responseOptions: { headers: { 'content-type': 'audio/wav' } } };
    return typeof r === 'string'
      ? { statusCode: 200, data: r, responseOptions: { headers: { 'content-type': 'text/html' } } }
      : { statusCode: 200, data: JSON.stringify(r), responseOptions: { headers: { 'content-type': 'application/json' } } };
  }).persist();
  const vorige = zetOpenbaarDispatcher(nep);
  return { bezocht, herstel: () => zetOpenbaarDispatcher(vorige) };
}

test('iBabs met babscast, Notubiz onder notubiz.nl, en een gemeentepagina die naar haar archief linkt', async () => {
  const { herken, ontdek, mediaVoor, ibabsSpelerblok } = await import('../src/audio/vergaderingen.mjs');
  const dag = 86400_000;
  const nu = Date.now();
  const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const op = (dagenGeleden) => {
    const d = new Date(nu - dagenGeleden * dag);
    d.setHours(19, 30, 0, 0);
    return d;
  };
  const lokaalIso = (d) => new Date(d - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
  // Raad en commissie met een speler, de openbaarmaking van collegebesluiten zonder.
  const vergaderingen = [
    { id: uuid(1), title: 'Raadsvergadering', soort: 1, start: op(10), event: uuid(101), status: 'Archived' },
    { id: uuid(2), title: 'Commissie Leefomgeving', soort: 3, start: op(20), event: uuid(102), status: 'Processing' },
    { id: uuid(3), title: 'Raadsvergadering', soort: 1, start: op(-2), event: uuid(103), status: 'Created' },
    { id: uuid(4), title: 'Commissie Leefomgeving', soort: 3, start: op(200), event: uuid(104), status: 'Archived' },
    { id: uuid(5), title: 'INFO-sessie raad', soort: 4, start: op(30), event: uuid(105), status: 'Archived', besloten: true },
    ...[40, 47, 54, 61, 68].map((d, i) => ({ id: uuid(10 + i), title: 'Openbaarmaking collegevergadering', soort: 2, start: op(d) })),
  ];
  const blok = (v) => (v.event ? `<div class="cwc" data-video-type="iBabsStream" data-video-id="${v.id}" data-video-url="https://player.babscast.com/${v.event}" data-video-base-url="https://player.babscast.com/" data-title="${v.title}">` : '');
  const net = await nepInternet((u) => {
    if (u.host === 'gemeente.bestuurlijkeinformatie.nl') {
      if (u.pathname === '/Calendar/GetAgendasForCalendar') {
        const van = Date.parse(u.searchParams.get('start'));
        const tot = Date.parse(u.searchParams.get('end'));
        return vergaderingen.filter((v) => v.start >= van && v.start < tot)
          .map((v) => ({ id: v.id, title: v.title, start: lokaalIso(v.start), url: `/Agenda/Index/${v.id}`, classNames: [`agendatype-${v.soort}`] }));
      }
      if (u.pathname === '/Calendar') return '<a href="/Calendar/OpenCategory/1">Raadsvergadering</a><a href="/Calendar/OpenCategory/3"><span>Commissie</span> Leefomgeving</a>';
      const v = vergaderingen.find((x) => u.pathname === `/Agenda/Index/${x.id}`);
      if (v) return `<html><h1>${v.title}</h1>${blok(v)}</html>`;
    }
    if (u.host === 'oost.bestuurlijkeinformatie.nl') {
      if (u.pathname === '/Calendar/GetAgendasForCalendar') return [{ id: uuid(50), title: 'Raadsvergadering', start: lokaalIso(op(3)), classNames: ['agendatype-1'] }];
      if (u.pathname === `/Agenda/Index/${uuid(50)}`) return '<div class="cwc" data-video-type="Cwc" data-video-id="gemeenteoost/20261025_1" data-video-url="">';
    }
    if (u.host === 'player.babscast.com') {
      const v = vergaderingen.find((x) => u.pathname === `/audience/v1/events/${x.event}`);
      if (v?.besloten) return { status: 403, body: '{"Title":"Forbidden","Status":403}' };
      if (v) {
        return {
          UniqueId: v.event, Title: `${v.title} - Begroting`, ClientName: 'Gemeente', IsPrivate: false, EventStatus: v.status,
          ActualStart: new Date(v.start).toISOString(), ActualEnd: new Date(v.start.getTime() + 5400_000).toISOString(),
          EventMetadata: { PlayListUrl: `https://vod.babscast.com/hls/${v.event}/video.mp4/master.m3u8`, Auth: 'Bearer geheim' },
          TimelineEvents: [{ EventType: 'Topic', TextRepresentation: '1 Opening', StartOffset: '00:00:12.5000000', EndOffset: '00:01:00.0000000' }, { EventType: 'Thumbnail', StartOffset: '00:00:04' }],
        };
      }
    }
    if (u.host === 'gemeentex.raadsinformatie.nl' && u.pathname === '/') return '<div id="app" organisation-id="1764"></div>';
    if (u.host === 'www.gemeentex.nl' && u.pathname === '/gemeenteraad') {
      return '<a href="https://gemeentex.bestuurlijkeinformatie.nl/">Raadsinformatie</a> <a href="https://channel.royalcast.com/gemeentex/#!/upcoming">Live</a>';
    }
    return undefined;
  });
  try {
    assert.equal(ibabsSpelerblok('<div class="cwc" data-video-type="iBabsStream" data-video-url="https://elders.example/abc">'), null, 'alleen babscast');

    assert.deepEqual(await herken(`https://gemeente.bestuurlijkeinformatie.nl/Agenda/Index/${uuid(3)}`, 'meetings'), { kind: 'ibabs', url: 'https://gemeente.bestuurlijkeinformatie.nl/' });
    assert.deepEqual(await herken('https://oost.bestuurlijkeinformatie.nl/', 'meetings'), { kind: 'companywebcast', url: 'https://channel.royalcast.com/gemeenteoost/' }, 'iBabs met Company Webcast wordt dat kanaal');
    assert.deepEqual(await herken('https://gemeentex.notubiz.nl/dashboard', 'meetings'), { kind: 'notubiz', url: 'https://gemeentex.raadsinformatie.nl/' });
    await assert.rejects(herken('https://onbekend.notubiz.nl/', 'meetings'), /geen bereikbaar raadsinformatieportaal/);
    assert.deepEqual(await herken('https://www.gemeentex.nl/gemeenteraad', 'meetings'), { kind: 'companywebcast', url: 'https://channel.royalcast.com/gemeentex/' }, 'het videokanaal gaat voor het documentportaal');

    // De eerste import: genoeg treffers, en minstens 120 dagen terug.
    net.bezocht.length = 0;
    const bron = { url: 'https://gemeente.bestuurlijkeinformatie.nl/', audio: { kind: 'ibabs', eersteImport: 1 } };
    const c = await ontdek(bron);
    assert.equal(c.titel, 'Gemeente Gemeente');
    assert.deepEqual(c.items.map((i) => [i.extern, i.titel, i.auteur, i.duur]), [
      [`ibabs:gemeente.bestuurlijkeinformatie.nl/${uuid(1)}`, 'Raadsvergadering - Begroting', 'Raadsvergadering', 5400],
    ], 'alleen afgelopen, openbare, gearchiveerde uitzendingen; 200 dagen terug valt buiten de eerste import van één');
    assert.equal(c.items[0].url, `https://gemeente.bestuurlijkeinformatie.nl/Agenda/Index/${uuid(1)}`);
    const collegepaginas = net.bezocht.filter((p) => /Agenda\/Index\/00000000-0000-4000-8000-00000000001\d/.test(p)).length;
    assert.equal(collegepaginas, 3, 'na drie keer geen speler wordt die agendasoort overgeslagen');
    assert.ok(!net.bezocht.some((p) => p.endsWith(uuid(3))), 'een toekomstige vergadering niet');

    // Met alles: ook de oudere commissie, in een volgend kalendervenster.
    const alles = await ontdek({ ...bron, audio: { kind: 'ibabs', eersteImport: 0 } });
    assert.deepEqual(alles.items.map((i) => i.extern.slice(-2)), ['01', '04']);

    const proef = await ontdek(bron, { proef: true });
    assert.equal(proef.deels, true);

    // Een uitzending die nog verwerkt wordt: vlak na de vergadering later nog eens, daarna niet meer.
    const bezigAf = { extern: `ibabs:gemeente.bestuurlijkeinformatie.nl/${uuid(2)}`, url: `https://gemeente.bestuurlijkeinformatie.nl/Agenda/Index/${uuid(2)}` };
    await assert.rejects(mediaVoor({ ...bezigAf, gepubliceerd: new Date(nu - dag).toISOString() }), (f) => f.later === 3 * 3600 && /nog niet beschikbaar/.test(f.message));
    await assert.rejects(mediaVoor({ ...bezigAf, gepubliceerd: new Date(nu - 20 * dag).toISOString() }), (f) => !f.later);

    const m = await mediaVoor(c.items[0]);
    assert.deepEqual(m, {
      adres: `https://vod.babscast.com/hls/${uuid(101)}/video.mp4/master.m3u8`,
      velden: { titel: 'Raadsvergadering - Begroting', duur: 5400, platform: { agenda: [{ titel: '1 Opening', start: 12.5, eind: 60 }], sprekers: [], versie: 2 } },
      stream: true,
    });
    assert.ok(!JSON.stringify(m).includes('geheim'), 'het spelertoken blijft buiten de Regiochecker');
  } finally {
    net.herstel();
  }
});

test('iBabs zonder speler: de mp3 bij elk agendapunt samen één opname, met de agenda erbij', { skip: ffmpeg ? false : 'ffmpeg niet aanwezig' }, async () => {
  const { herken, ontdek, mediaVoor, platformVoor, ibabsGeluid } = await import('../src/audio/vergaderingen.mjs');
  const { downloadAudio, audioDuur } = await import('../src/audio/ophalen.mjs');
  const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  // Zoals op westerwolde.bestuurlijkeinformatie.nl (oktober 2026).
  const punt = (id, nummer, titel, bijlagen) => `<li><div class="panel panel-default agenda-item" id="${id}" >
    <div class="panel-id">${nummer}</div><h3 class="panel-title"><button aria-controls="collapse-${id}"><span class="panel-title-label" >${titel}</span></button></h3>
    <ul class="list-group list-attachments">${bijlagen.map(([doc, soort, naam]) => `<li><a href="${soort === 'mp3' ? `/Document/View/${doc}` : `/Agenda/Document/${uuid(100)}?documentId=${doc}&amp;agendaItemId=${id}`}" class="unread" data-document-id="${doc}" target=_blank>
      <span class="icon ${soort}" aria-label="${soort}" role="img"></span> ${naam} <span class="badge badge-light badge-pill">433 KB</span></a></li>`).join('')}</ul></div></li>`;
  const pagina = punt(uuid(1), '1', 'Opening', [[uuid(11), 'mp3', 'Geluidsbestand agendapunt 1 - Opening']])
    + punt(uuid(2), '2', 'Parkeerverordening Westerwolde 2026', [[uuid(21), 'pdf', 'Raadsvoorstel'], [uuid(22), 'mp3', 'Geluidsbestand agendapunt 2 - Parkeerverordening']])
    + punt(uuid(3), '3', 'Sluiting', []);
  assert.deepEqual(ibabsGeluid(pagina), { type: 'geluid', delen: [{ id: uuid(11), titel: '1. Opening' }, { id: uuid(22), titel: '2. Parkeerverordening Westerwolde 2026' }] });
  assert.equal(ibabsGeluid(punt(uuid(4), '1', 'Opening', [[uuid(41), 'pdf', 'Agenda']])), null, 'alleen pdf\'s: geen opname');

  const begin = new Date(Date.now() - 10 * 86400_000);
  begin.setHours(19, 30, 0, 0);
  const lokaalIso = (d) => new Date(d - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
  const net = await nepInternet((u) => {
    if (u.host !== 'ww.bestuurlijkeinformatie.nl') return undefined;
    if (u.pathname === '/Calendar/GetAgendasForCalendar') {
      return Date.parse(u.searchParams.get('start')) <= begin && begin < Date.parse(u.searchParams.get('end'))
        ? [{ id: uuid(100), title: 'Raadsvergadering', start: lokaalIso(begin), url: `/Agenda/Index/${uuid(100)}`, classNames: ['agendatype-7'] }] : [];
    }
    if (u.pathname === '/Calendar') return '<a href="/Calendar/OpenCategory/7">Raadsvergadering</a>';
    if (u.pathname === `/Agenda/Index/${uuid(100)}`) return `<html>${pagina}</html>`;
    if (u.pathname === `/Document/View/${uuid(11)}`) return wav(1);
    if (u.pathname === `/Document/View/${uuid(22)}`) return wav(2);
    return undefined;
  });
  try {
    const portaal = 'https://ww.bestuurlijkeinformatie.nl/';
    assert.deepEqual(await herken(portaal, 'meetings'), { kind: 'ibabs', url: portaal });
    const c = await ontdek({ url: portaal, audio: { kind: 'ibabs', eersteImport: 0 } });
    assert.deepEqual(c.items.map((i) => [i.extern, i.titel, i.auteur, i.duur]), [[`ibabs:ww.bestuurlijkeinformatie.nl/${uuid(100)}`, 'Raadsvergadering', 'Raadsvergadering', null]]);

    const m = await mediaVoor(c.items[0]);
    assert.deepEqual(m.delen, [
      { adres: `${portaal}Document/View/${uuid(11)}`, titel: '1. Opening' },
      { adres: `${portaal}Document/View/${uuid(22)}`, titel: '2. Parkeerverordening Westerwolde 2026' },
    ]);
    assert.equal(typeof m.beurt, 'function', 'ook de downloads met de Crawl-delay');

    // Downloaden: samen één mp3, en de agenda met de tijden uit de lengte van elk deel.
    const map = tijdelijk();
    const meta = {};
    const pad = await downloadAudio({ ...c.items[0], id: 'w1' }, { map, vergadering: mediaVoor, metadata: (x) => Object.assign(meta, x) });
    const duur = await audioDuur(pad);
    assert.ok(duur > 2.8 && duur < 3.3, `drie seconden samen (${duur})`);
    assert.deepEqual(meta.platform.agenda.map((a) => [a.titel, Math.round(a.start), Math.round(a.eind)]), [['1. Opening', 0, 1], ['2. Parkeerverordening Westerwolde 2026', 1, 3]]);
    assert.equal(meta.platform.versie, 2);
    assert.equal(Math.round(meta.duur), 3);
    assert.ok(!existsSync(path.join(map, 'audio', 'w1', 'deel-0.media')) && !existsSync(path.join(map, 'audio', 'w1', 'delen.txt')), 'de losse delen zijn opgeruimd');

    // De agenda komt uit het downloaden; vernieuwen van de platformgegevens laat die staan.
    const metAgenda = { ...c.items[0], platform: { agenda: meta.platform.agenda, sprekers: [], versie: 1 } };
    assert.deepEqual((await platformVoor(metAgenda)).agenda, meta.platform.agenda);
    assert.equal(await platformVoor(c.items[0]), null);
  } finally {
    net.herstel();
  }
});

test('video van een vergadering voor het leespaneel: mp4 van Company Webcast, HLS van Notubiz, geen bij GemeenteOplossingen', async () => {
  const { videoVoor } = await import('../src/audio/vergaderingen.mjs');
  const net = await nepInternet((u) => {
    if (u.host === 'channel.royalcast.com' && u.pathname === '/portal/api/1.0/gemeenteoost/webcasts/gemeenteoost/20261027_1') {
      return { attachments: [
        { contentType: 'audio/mpeg', location: 'https://cwc-download.s3.test/x/mp3/bb.mp3?Signature=a' },
        { contentType: 'video/x-ms-wmv', location: 'http://player.companywebcast.com/x/wmv' },
        { contentType: 'video/mp4', location: 'https://cwc-download.s3.test/x/mp4/bb.mp4?Signature=b' },
      ] };
    }
    if (u.host === 'api.notubiz.nl' && u.pathname === '/media') {
      return { media: [{ streamer: 'rtmp://wowza1.notubiz.nl/nbvod/_definst_', stream_name: 'Gemeente/bestanden/raad.mp4' }] };
    }
    return undefined;
  });
  try {
    assert.deepEqual(await videoVoor({ extern: 'cwc:gemeenteoost/20261027_1', url: 'https://channel.royalcast.com/gemeenteoost/#!/gemeenteoost/20261027_1' }),
      { type: 'mp4', src: 'https://cwc-download.s3.test/x/mp4/bb.mp4?Signature=b', poster: null });
    assert.deepEqual(await videoVoor({ extern: 'ntb:1512/88', url: 'https://gemeente.raadsinformatie.nl/vergadering/88' }),
      { type: 'hls', src: 'https://wowza1.notubiz.nl/nbvod/_definst_/Gemeente/bestanden/raad.mp4/playlist.m3u8', poster: null });
    assert.equal(await videoVoor({ extern: 'go:gemeenteraad.groningen.nl/5711', url: 'https://gemeenteraad.groningen.nl/Vergaderingen/x' }), null, 'alleen geluid');
  } finally {
    net.herstel();
  }
});

test('GemeenteOplossingen: agenda uit de open API, de opname via de poort, met hergebruik van de cookie', metSqlite, async () => {
  const pogingen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/v2/meetings') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ result: { totalCount: 2, meetings: url.searchParams.get('limit') === '1' ? [{ id: 1 }] : [
        { id: 5425, date: '2026-10-21', startTime: '16:30', meetingLabel: '', dmu: { name: 'gemeenteraad' }, url: '/Vergaderingen/gemeenteraad/2026/21-oktober/16:30' },
        { id: 5420, date: '2026-10-14', startTime: '13:00', meetingLabel: 'Politiek Vragenuur', dmu: { name: 'Politiek Vragenuur' }, url: '/Vergaderingen/vragenuur/2026/14-oktober/13:00' },
      ] } }));
    }
    if (url.pathname.startsWith('/Vergaderingen/')) {
      pogingen.push(req.headers.cookie || '');
      if (!/within\.website-x-cmd-anubis-auth=ok/.test(req.headers.cookie || '')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(`<html><script id="anubis_challenge" type="application/json">{"challenge":{"id":"c1","randomData":"rnd"},"rules":{"difficulty":2}}</script></html>`);
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<audio src="https://go-va-web.gemeenteoplossingen.nl/groningen_1/2026-10-22-14-20-00-gemeenteraad.mp3"></audio>');
    }
    if (url.pathname === '/.within.website/x/cmd/anubis/api/pass-challenge') {
      const goed = createHash('sha256').update(`rnd${url.searchParams.get('nonce')}`).digest('hex');
      if (goed !== url.searchParams.get('response') || !goed.startsWith('00')) {
        res.writeHead(403);
        return res.end('fout');
      }
      res.writeHead(302, { Location: url.searchParams.get('redir'), 'Set-Cookie': 'within.website-x-cmd-anubis-auth=ok; Path=/' });
      return res.end();
    }
    res.writeHead(404);
    return res.end();
  });
  await new Promise((klaar) => server.listen(0, '127.0.0.1', klaar));
  try {
    const { herken, ontdek, mediaVoor } = await import('../src/audio/vergaderingen.mjs');
    const portaal = `http://127.0.0.1:${server.address().port}/`;
    const h = await herken(`${portaal}Vergaderingen`);
    assert.deepEqual(h, { kind: 'gemeenteoplossingen', url: portaal });
    const c = await ontdek({ url: h.url, audio: { kind: h.kind, eersteImport: 3, geinitialiseerd: true } });
    assert.deepEqual(c.items.map((i) => [i.extern, i.titel, i.auteur, i.gepubliceerd]), [
      ['go:127.0.0.1/5425', 'gemeenteraad', 'gemeenteraad', '20261021'],
      ['go:127.0.0.1/5420', 'Politiek Vragenuur', 'Politiek Vragenuur', '20261014'],
    ]);
    assert.equal(c.items[0].gepubliceerdOp, new Date(2026, 9, 21, 16, 30).getTime() / 1000);
    const m = await mediaVoor(c.items[0]);
    assert.deepEqual(m, { adres: 'https://go-va-web.gemeenteoplossingen.nl/groningen_1/2026-10-22-14-20-00-gemeenteraad.mp3', velden: {}, stream: false });
    await mediaVoor(c.items[1]);
    assert.deepEqual(pogingen.map((p) => p.includes('anubis-auth=ok')), [false, true, true], 'één keer de puzzel, daarna de cookie');
  } finally {
    server.close();
  }
});

async function opzet() {
  const { openFeedDb } = await import('../src/feeddb.mjs');
  const { AudioDb } = await import('../src/audio/db.mjs');
  const { Verwerking } = await import('../src/audio/verwerking.mjs');
  const map = tijdelijk();
  const opslag = new Opslag(map);
  const fdb = await openFeedDb(path.join(map, 'regiochecker.sqlite'));
  const adb = new AudioDb(fdb.db);
  opslag.feeddb = fdb;
  opslag.audiodb = adb;
  const beschikbaar = [];
  const verwerking = new Verwerking({ opslag, adb }, { bijBeschikbaar: (a) => beschikbaar.push(a.id) });
  return { opslag, fdb, adb, verwerking, beschikbaar, map };
}

test('spel op de GPU-machine: niets beginnen, een afgebroken deel telt niet mee, geen Ollama', metAlles, async () => {
  process.env.REGIOCHECKER_SPEL_WACHT_MS = '20';
  const worker = await nepWorker();
  const feed = await nepPodcast({ n: 2 });
  try {
    const { opslag, fdb, adb, verwerking } = await opzet();
    const { koppelSpel } = await import('../src/audio/spel.mjs');
    const { ollamaJson } = await import('../src/ollama.mjs');
    koppelSpel(opslag);
    const jan = herkenGebruiker(opslag, { login: 'jan', email: 'jan@example.nl' });
    const ctx = { opslag, kdb: null, fdb, adb };
    opslag.instellingen.audio = { ...opslag.instellingen.audio, workerUrl: worker.url, workerToken: TOKEN, viaTailnet: false };
    await roep(ctx, jan, 'POST', '/api/beheer/bronnen', { bereik: 'regio', regio: 'smallingerland', lezer: 'audio', soort: 'podcast', url: feed.url, eersteImport: 2 });
    assert.equal((await verwerking.synchroniseer(opslag.bronnen[0])).nieuw, 2);
    const eerste = verwerking.volgende()[0].id;

    // Er draait een spel: niets beginnen, niets naar de worker sturen.
    worker.staat.spel = { game: 'Cyberpunk2077.exe', since: '2026-10-31T17:40:00+01:00' };
    assert.equal(await verwerking.verwerkEen(), false);
    assert.ok(!worker.staat.verzoeken.some((v) => v.startsWith('POST')));
    assert.deepEqual((await roep(ctx, jan, 'GET', '/api/beheer/audio')).data.worker.spel, { naam: 'Cyberpunk2077.exe', sinds: '2026-10-31T16:40:00.000Z' });
    // Ollama draait op dezelfde machine: ook geen samenvatting, met de reden erbij.
    await assert.rejects(ollamaJson({ url: worker.url.replace(/:\d+$/, ':11434'), model: 'qwen3.5:9b', systeem: 'x', vraag: 'y', schema: {} }), /Er wordt gegamed op de GPU-machine \(Cyberpunk2077\.exe\); samenvatten kan daarna weer/);

    // Het spel begint midden in een transcriptie: geen mislukte poging, weer in de wachtrij.
    worker.staat.spel = null;
    koppelSpel(opslag);
    worker.staat.spelTijdensTranscriptie = { game: 'eldenring.exe', since: '2026-10-31T18:00:00+01:00' };
    assert.equal(await verwerking.verwerkEen(), true);
    let a = adb.aflevering(eerste);
    assert.deepEqual([a.status, a.pogingen, a.stap, a.fout], ['wacht', 0, 'Wacht tot het spel op de GPU-machine klaar is', null]);

    // Spel voorbij: gewoon verder.
    worker.staat.spel = null;
    koppelSpel(opslag);
    assert.equal(await verwerking.verwerkEen(), true);
    a = adb.aflevering(eerste);
    assert.ok(a.transcript, 'na het spel getranscribeerd');
  } finally {
    delete process.env.REGIOCHECKER_SPEL_WACHT_MS;
    worker.server.close();
    feed.server.close();
  }
});

test('verwerking: van podcastfeed tot transcript, namen, stemmen en telefoonnummers', metAlles, async () => {
  const worker = await nepWorker();
  const feed = await nepPodcast({ n: 5 });
  try {
    const { opslag, fdb, adb, verwerking, beschikbaar } = await opzet();
    const jan = herkenGebruiker(opslag, { login: 'jan', email: 'jan@example.nl' });
    const ctx = { opslag, kdb: null, fdb, adb };
    const PODCAST = { bereik: 'regio', regio: 'smallingerland', lezer: 'audio', soort: 'podcast', url: feed.url, eersteImport: 2 };

    let r = await roep(ctx, jan, 'POST', '/api/beheer/bronnen/proef', PODCAST);
    assert.match(r.data.tekst, /5 afleveringen gevonden\. De nieuwste: "Aflevering 5: Drachten en de N31"/);
    assert.match(r.data.tekst, /de 2 nieuwste afleveringen gedownload en getranscribeerd/);
    assert.match(r.data.tekst, /Whisper-worker is nog niet ingesteld/);
    r = await roep(ctx, jan, 'POST', '/api/beheer/bronnen', PODCAST);
    assert.equal(r.status, 201);
    assert.deepEqual([r.data.naam, r.data.lezer, r.data.audio.kind, r.data.audio.eersteImport], ['Smallingerland · Podcast', 'Podcast-RSS', 'rss', 2]);
    const bron = opslag.bronnen[0];

    // Zonder worker: niets te doen.
    assert.equal(await verwerking.verwerkEen(), false);
    opslag.instellingen.audio = { ...opslag.instellingen.audio, workerUrl: worker.url, workerToken: TOKEN, viaTailnet: false, namenZoeken: true };

    // De eerste keer: de twee nieuwste in de wachtrij, de rest telt als gezien.
    assert.deepEqual(await verwerking.synchroniseer(bron), { ok: true, nieuw: 2, aantal: 5 });
    assert.equal(adb.gezien(bron.id).size, 5);
    assert.equal(opslag.status.bronnen[bron.id].nulmeting, true);
    assert.deepEqual((await verwerking.synchroniseer(bron)).nieuw, 0, 'niets dubbel');
    // Duikt er later iets ouders op dan de eerste import, dan is dat achterstand.
    feed.staat.extra.push({ guid: 'oud-archief', dagen: 30 }, { guid: 'net-binnen', dagen: 0.5 });
    assert.deepEqual((await verwerking.synchroniseer(bron)).nieuw, 1, 'alleen wat niet ouder is dan de eerste import');
    assert.ok(!adb.lijst({ bron: bron.id }).some((a) => a.titel === 'oud-archief'));
    const netBinnen = adb.lijst({ bron: bron.id }).find((a) => a.titel === 'net-binnen');
    assert.ok(netBinnen);
    adb.db.prepare('DELETE FROM afleveringen WHERE id = ?').run(netBinnen.id);
    const [nieuwste, tweede] = verwerking.volgende().map((v) => adb.aflevering(v.id));
    assert.equal(nieuwste.titel, 'Aflevering 5: Drachten en de N31');

    // Stap 1: downloaden, ffmpeg, transcriberen.
    assert.equal(await verwerking.verwerkEen(), true);
    let a = adb.aflevering(nieuwste.id);
    assert.equal(a.status, 'getranscribeerd');
    assert.deepEqual(worker.staat.laatsteUpload, { bytes: worker.staat.laatsteUpload.bytes, mp3: true, diarize: true, opname: `regiochecker:${a.id}` });
    assert.deepEqual(a.segmenten.map((s) => s.speaker), ['Voorzitter Bos', 'Anke Postma', 'Spreker 1', 'Spreker 2']);
    assert.equal(a.segmenten[3].speaker_id, STEM.wethouder);
    assert.equal(a.eersteGezien, a.gepubliceerd, 'eerste import: op de eigen datum');
    assert.equal(a.audioPad, null, 'podcast-audio wordt niet bewaard');
    assert.equal(a.taal, 'nl');
    assert.deepEqual(beschikbaar, [a.id]);
    assert.deepEqual(adb.db.prepare('SELECT nummer, segment, categorie FROM telefoon_vermeldingen').all().map((x) => ({ ...x })), [{ nummer: '0612345678', segment: 1, categorie: 'Mobiel nummer' }]);

    // Stap 2: eerst deze aflevering afmaken. Namen wachten als de GPU bezet is,
    // en intussen begint de verwerking niet aan de volgende.
    worker.staat.gpuBezig = true;
    await verwerking.verwerkEen();
    a = adb.aflevering(nieuwste.id);
    assert.deepEqual([a.status, a.stap], ['getranscribeerd', 'Namen wachten op de gedeelde GPU']);
    assert.ok(a.opnieuwOp > Date.now() / 1000);
    assert.equal(await verwerking.verwerkEen(), false, 'niet intussen de volgende transcriberen');
    assert.equal(adb.aflevering(tweede.id).status, 'wacht');
    worker.staat.gpuBezig = false;
    adb.werkBij(a.id, { opnieuwOp: 0 });

    await verwerking.verwerkEen();
    a = adb.aflevering(nieuwste.id);
    assert.equal(a.status, 'klaar');
    assert.equal(adb.aflevering(tweede.id).status, 'wacht', 'pas daarna de volgende');
    await verwerking.verwerkEen();
    assert.equal(adb.aflevering(tweede.id).status, 'getranscribeerd');
    // Alleen wat letterlijk in de tekst staat; de naam van een spreker niet.
    assert.deepEqual(a.entiteiten.map((e) => [e.name, e.type, e.count]), [['Drachten', 'location', 2], ['programmabegroting 2027', 'other', 1], ['wethouder Kramer', 'person', 1]]);
    assert.deepEqual(a.entiteiten[0].occurrences.map((o) => [o.segment, o.start]), [[1, 15], [3, 45]]);

    // Een storing bij de worker: herkansen met een wachttijd.
    worker.staat.entiteitFout = 1;
    await verwerking.verwerkEen();
    const fout = adb.aflevering(tweede.id);
    assert.deepEqual([fout.status, fout.pogingen], ['getranscribeerd', 1]);
    assert.match(fout.stap, /^Tijdelijke storing · nieuwe poging over 1 min$/);
    assert.equal(await verwerking.verwerkEen(), false, 'wacht op de herkansing');
    adb.werkBij(tweede.id, { opnieuwOp: 0 });
    await verwerking.verwerkEen();
    assert.equal(adb.aflevering(tweede.id).status, 'klaar');

    // Telefoonnummer duiden als er verder niets te doen is.
    assert.equal(await verwerking.duidEenNummer(), true);
    const duiding = adb.db.prepare('SELECT status, label, zekerheid, bewijs FROM telefoon_context').get();
    assert.deepEqual({ ...duiding }, { status: 'klaar', label: 'Anke Postma', zekerheid: 72, bewijs: 'Bel gerust [DOELNUMMER]' });

    // De feed van een journalist die Smallingerland volgt.
    const sanne = nieuweGebruiker(opslag.instellingen, { login: 'sanne', email: 'sanne@lc.nl', regios: ['smallingerland'] });
    opslag.gebruikers.push(sanne);
    r = await roep(ctx, sanne, 'GET', '/api/feed?groep=podcast');
    assert.deepEqual(r.data.items.map((i) => i.titel), ['Aflevering 5: Drachten en de N31', 'Aflevering 4: Drachten en de N31']);
    r = await roep(ctx, sanne, 'GET', `/api/stuk?id=a%3A${nieuwste.id}`);
    assert.deepEqual(r.data.sprekers.map((s) => [s.label, s.heeftNaam, s.suggestie?.naam ?? null]), [['Voorzitter Bos', true, null], ['Anke Postma', true, null], ['Spreker 1', false, null], ['Spreker 2', false, null]], 'geen voorstellen uit namen van het taalmodel');
    assert.deepEqual(r.data.namen.map((n) => n.naam), ['Drachten', 'programmabegroting 2027', 'wethouder Kramer']);
    assert.deepEqual(r.data.nummers.map((n) => [n.weergave, n.start]), [['06 1234 5678', 15]]);
    assert.match(r.data.speler, /\/audio\/5\.wav$/, 'podcast: afspelen bij de bron (de eigen kopie is weg)');

    // Het archief.
    r = await roep(ctx, sanne, 'GET', '/api/audio/archief?q=nachtdienst');
    assert.equal(r.data.items.length, 2);
    r = await roep(ctx, sanne, 'GET', '/api/audio/namen');
    assert.deepEqual(r.data.namen[0], { naam: 'Drachten', soort: 'location', aantal: 4, afleveringen: 2, soortNaam: 'Locatie', geografie: r.data.namen[0].geografie });
    assert.equal(r.data.namen[0].geografie.provincie, 'Friesland');
    r = await roep(ctx, sanne, 'GET', '/api/audio/namen/vermeldingen?naam=drachten&soort=location');
    assert.equal(r.data.naam, 'Drachten');
    assert.equal(r.data.vermeldingen.length, 4);
    r = await roep(ctx, sanne, 'GET', '/api/audio/stemmen');
    assert.deepEqual(r.data.stemmen.map((s) => [s.weergave, s.beurten]), [['Anke Postma', 2], ['Voorzitter Bos', 2], ['Onbekende stem', 2]]);
    r = await roep(ctx, sanne, 'PUT', `/api/audio/sprekers/${STEM.wethouder}`, { naam: 'Wethouder Kramer' });
    assert.deepEqual(r.data, { naam: 'Wethouder Kramer', afleveringen: 2 });
    assert.equal(adb.aflevering(nieuwste.id).segmenten[3].speaker, 'Wethouder Kramer');
    r = await roep(ctx, sanne, 'GET', '/api/audio/telefoonnummers');
    assert.deepEqual(r.data.map((n) => [n.nummer, n.vermeldingen, n.duidingen[0]?.label]), [['0612345678', 2, 'Anke Postma']]);
    r = await roep(ctx, sanne, 'PUT', '/api/audio/telefoonnummers/0612345678', { staat: 'bevestigd', soort: 'person', relatie: 'third_party_reference', label: 'Anke Postma' });
    assert.equal(r.data.koppeling.staat, 'bevestigd');
    assert.equal((await roep(ctx, sanne, 'PUT', '/api/audio/telefoonnummers/0612345678', { staat: 'bevestigd', soort: 'person', relatie: 'third_party_reference' })).status, 400);
    r = await roep(ctx, sanne, 'GET', `/api/audio/afleveringen/${nieuwste.id}/transcript.txt`);
    assert.match(r.data.toString(), /GENOEMDE NAMEN\nDrachten \(Locatie, 2×\)/);
    assert.match(r.data.toString(), /\[0:45\] Wethouder Kramer: Het college praat/);
    assert.equal((await roep(ctx, sanne, 'GET', `/api/audio/afleveringen/${nieuwste.id}/audio`)).status, 404);

    // Stemmen opnieuw laten herkennen: het transcript wordt opnieuw gemaakt.
    r = await roep({ ...ctx, verwerking }, sanne, 'POST', `/api/audio/afleveringen/${nieuwste.id}/sprekers`, {});
    assert.deepEqual(r.data, { ok: true });
    assert.equal(adb.aflevering(nieuwste.id).status, 'wacht');
    await verwerking.verwerkEen();
    a = adb.aflevering(nieuwste.id);
    assert.equal(a.segmenten[3].speaker, 'Wethouder Kramer', 'de worker kent de naam nu');
    assert.equal(a.eersteGezien, nieuwste.gepubliceerd, 'blijft op dezelfde plek in de feed');

    // Pauze, en een mislukte download.
    adb.zetStaat('gepauzeerd', '1');
    assert.equal(await verwerking.verwerkEen(), false);
    adb.zetStaat('gepauzeerd', '0');
    r = await roep({ ...ctx, verwerking }, jan, 'GET', '/api/beheer/audio');
    assert.deepEqual([r.data.worker.bereikbaar, r.data.worker.model, r.data.inWachtrij, r.data.bronnen.length], [true, 'large-v3', 1, 1]);
    assert.equal(r.data.wachtrij[0].titel, 'Aflevering 5: Drachten en de N31', 'de namen opnieuw');
  } finally {
    worker.server.close();
    feed.server.close();
  }
});

test('vergaderplatform: agenda met tijden, en wie had de microfoon', async () => {
  const { webcastPlatform, notubizAgenda } = await import('../src/audio/vergaderingen.mjs');
  const { platformSpreker, sprekersVan } = await import('../src/feed.mjs');
  const { agendaTekst } = await import('../src/vergadering.mjs');
  const t = (s) => `/Date(${1792431023000 + s * 1000})/`;
  const cwc = webcastPlatform({
    actualStart: t(0),
    topics: [{ title: '12 Advies recreatiepark Elsweg', events: [{ start: t(728), end: t(4393) }] }, { title: '1 Opening', events: [{ start: t(11), end: t(64) }] }, { title: 'Zonder tijd', events: [] }],
    speakers: [
      { name: { first: 'Marcel ', last: 'Bos ' }, role: null, events: [{ start: t(2700), end: t(3027) }, { start: t(3100), end: t(3110) }] },
      { name: { first: 'Anne', last: 'Schelhaas' }, events: [{ start: t(3501), end: t(3560) }] },
      { name: { first: 'Stil', last: 'Lid' }, events: [] },
    ],
  });
  assert.deepEqual(cwc.agenda, [{ titel: '1 Opening', start: 11, eind: 64 }, { titel: '12 Advies recreatiepark Elsweg', start: 728, eind: 4393 }], 'op volgorde, vanaf het begin van de opname');
  assert.deepEqual(cwc.sprekers.map((s) => [s.naam, s.momenten]), [['Marcel Bos', [[2700, 3027], [3100, 3110]]], ['Anne Schelhaas', [[3501, 3560]]]]);

  assert.deepEqual(notubizAgenda({ agenda_items: [
    { type_data: { title_prefix: '1', attributes: [{ id: 1, value: 'Opening' }] }, start_offset: '614', end_offset: '1034' },
    { type_data: { heading: true, title_prefix: 'A', attributes: [{ id: 1, value: 'Bespreekstukken' }] }, start_offset: null, agenda_items: [
      { type_data: { title_prefix: '4', attributes: [{ id: 1, value: 'Kapitaalgoederen' }] }, start_offset: '1101', end_offset: '2059' },
    ] },
  ] }), [{ titel: '1 Opening', start: 614, eind: 1034 }, { titel: '4 Kapitaalgoederen', start: 1101, eind: 2059 }], 'ook punten onder een kopje');

  // Notubiz: de spreekmomenten onder de agendapunten op de vergaderpagina.
  const moment = (id, start, eind, naam) => `<li class="speaker_index js_only" id="si_${start}"
			data-si_id="${start}" data-speaker_id="${id}"
			data-start_offset="${start}"
			data-end_offset="${eind}">
			<button>
				<span class="icon-user">spreker: </span>${naam}
					<span class="item_time"><span class="icon-time" title="Tijdsduur">Tijdsduur:</span><time datetime="PT00H01M14S">00:01:14</time></span>
			</button>
				</li>`;
  const { notubizSprekers } = await import('../src/audio/vergaderingen.mjs');
  assert.deepEqual(notubizSprekers(`<ul class="speakers_indexations">${[
    moment(1, 89, 104, 'Vries de, Jannewietske\t\t\t\t(burgemeester)'),
    moment(2, 104, 121, 'Groot, Jelmer de (BBB)'),
    moment(1, 14, 88, 'Vries de, Jannewietske (burgemeester)'),
    moment(1, 14, 88, 'Vries de, Jannewietske (burgemeester)'),
    moment(3, 130, 160, 'Akker, Petra van den (wethouder)'),
    moment(4, 0, 0, 'Zonder, Tijd (CDA)'),
  ].join('')}</ul>`), [
    { naam: 'Jannewietske de Vries', rol: 'burgemeester', momenten: [[14, 88], [89, 104]] },
    { naam: 'Jelmer de Groot', rol: 'BBB', momenten: [[104, 121]] },
    { naam: 'Petra van den Akker', rol: 'wethouder', momenten: [[130, 160]] },
  ], 'voornaam eerst, ook met het tussenvoegsel achter de voornaam; elk moment één keer');

  // Een stem die grotendeels samenvalt met Marcel Bos; een stem die maar half samenvalt niet.
  assert.deepEqual(platformSpreker([[2701, 3020], [3101, 3109]], cwc.sprekers), { naam: 'Marcel Bos', rol: null, deel: 100 });
  assert.equal(platformSpreker([[3501, 3530], [5000, 5100]], cwc.sprekers), null, 'minder dan 60% van de spreektijd');
  assert.equal(platformSpreker([[3501, 3510]], cwc.sprekers), null, 'minder dan 20 seconden');

  const a = {
    titel: 'Raadsvergadering', platform: cwc,
    segmenten: [{ start: 2701, end: 3020, text: 'Voorzitter, dank u wel.', speaker: 'Spreker 1019', speaker_id: 'p1' }, { start: 3502, end: 3558, text: 'Wij steunen het voorstel.', speaker: 'Anne Schelhaas', speaker_id: 'p2' }],
  };
  const sp = sprekersVan(a);
  assert.deepEqual(sp[0].suggestie, { naam: 'Marcel Bos', bron: 'platform', deel: 100 });
  assert.equal(sp[1].suggestie, undefined, 'een stem met een naam krijgt geen voorstel');
  assert.match(agendaTekst(a), /Agenda \(met de tijd waarop het punt begint\):\n- \[0:11\] 1 Opening\n- \[12:08\] 12 Advies recreatiepark Elsweg/);
  assert.equal(agendaTekst({}), '');
});

test('namen van het vergaderplatform gelden meteen voor de stemmen', metSqlite, async () => {
  const { TRANSCRIPT } = await import('./nep-worker.mjs');
  const worker = await nepWorker();
  try {
    const { opslag, adb, verwerking } = await opzet();
    opslag.instellingen.audio = { ...opslag.instellingen.audio, workerUrl: worker.url, workerToken: TOKEN, viaTailnet: false };
    const bron = { id: 'west', naam: 'Weststellingwerf · Raad', soort: 'raadsvergadering', bereik: 'regio', regio: 'weststellingwerf', type: 'audio', url: 'https://channel.royalcast.com/gemeenteweststellingwerf/', audio: { kind: 'companywebcast', prioriteit: 0 } };
    opslag.bronnen.push(bron);
    const id = 'e'.repeat(32);
    adb.voegToe(bron, { id, extern: 'cwc:gemeenteweststellingwerf/20261019_1', vorm: 'vergadering', url: 'https://channel.royalcast.com/gemeenteweststellingwerf/#!/gemeenteweststellingwerf/20261019_1', titel: 'Raadsvergadering', gepubliceerdOp: Date.now() / 1000 - 86400 });
    const { schoonSegmenten } = await import('../src/audio/verwerking.mjs');
    adb.werkBij(id, {
      transcript: 'x', segmenten: schoonSegmenten(TRANSCRIPT), status: 'getranscribeerd',
      // Kramer had de microfoon toen SPEAKER_02 sprak; bij Anke Postma noteert het platform iemand anders.
      platform: { agenda: [], sprekers: [{ naam: 'Wethouder Kramer', rol: null, momenten: [[44, 71]] }, { naam: 'Iemand Anders', rol: null, momenten: [[15, 38]] }] },
    });
    await verwerking.verwerkEen();
    const a = adb.aflevering(id);
    assert.equal(worker.staat.namen.get(STEM.wethouder), 'Wethouder Kramer', 'de naam staat bij de worker');
    assert.equal(a.segmenten.find((s) => s.speaker_id === STEM.wethouder).speaker, 'Wethouder Kramer', 'en in het transcript');
    assert.equal(worker.staat.namen.get(STEM.postma), 'Anke Postma', 'een stem met een naam blijft ongemoeid');
    assert.equal(a.status, 'klaar');
    assert.ok(opslag.logboek.some((l) => /1 stem genoemd naar het vergaderplatform/.test(l.tekst)));
  } finally {
    worker.server.close();
  }
});

test('Notubiz: de opname en agenda uit de API als het portaal achter een Cloudflare-controle zit', async () => {
  const { mediaVoor, notubizApiStream } = await import('../src/audio/vergaderingen.mjs');
  const media = { media: [{ streamer: 'rtmp://wowza1.notubiz.nl/nbvod/_definst_', stream_name: 'Sudwestfryslan/bestanden/08.10.26 SudwestFryslan Raad.mp4', event_id: 88 }] };
  assert.equal(notubizApiStream(media), 'https://wowza1.notubiz.nl/nbvod/_definst_/Sudwestfryslan/bestanden/08.10.26%20SudwestFryslan%20Raad.mp4/playlist.m3u8');
  assert.equal(notubizApiStream({ media: [] }), null);
  assert.throws(() => notubizApiStream({ media: [{ streamer: 'rtmp://elders.example/vod', stream_name: 'x.mp4' }] }), /onbekende mediaserver/);
  const net = await nepInternet((u) => {
    if (u.host === 'sudwestfryslan.raadsinformatie.nl') return { status: 403, body: '<title>Just a moment...</title>' };
    if (u.host === 'api.notubiz.nl' && u.pathname === '/media') return u.searchParams.get('event_id') === '88' ? media : { media: [] };
    if (u.host === 'api.notubiz.nl' && u.pathname === '/events/meetings/88') {
      return { meeting: { agenda_items: [{ type_data: { title_prefix: '1', attributes: [{ id: 1, value: 'Iepening' }] }, start_offset: '13', end_offset: '88' }] } };
    }
  });
  try {
    const af = { extern: 'ntb:1512/88', url: 'https://sudwestfryslan.raadsinformatie.nl/vergadering/88', vorm: 'vergadering', gepubliceerd: new Date().toISOString() };
    const m = await mediaVoor(af);
    assert.equal(m.adres, notubizApiStream(media));
    assert.deepEqual(m.velden.platform.agenda.map((a) => a.titel), ['1 Iepening']);
    assert.deepEqual(m.velden.platform.sprekers, [], 'de sprekers staan alleen op de pagina');
    // Zonder opname in de API en zonder pagina: (nog) geen opname.
    await assert.rejects(mediaVoor({ ...af, extern: 'ntb:1512/89', url: 'https://sudwestfryslan.raadsinformatie.nl/vergadering/89' }), /geen opname/);
  } finally {
    net.herstel();
  }

  // Niet live uitgezonden, wel een video achteraf (Pekela): die telt mee; zonder video niet.
  const { ontdek } = await import('../src/audio/vergaderingen.mjs');
  const dagen = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
  const ev = (id, live, d) => ({ id, live, type: 'meeting', permission_group: 'public', canceled: false, inactive: false, gremium: { id: 1 }, attributes: [{ id: 1, value: `Raad ${id}` }], plannings: [{ start_date: `${dagen(d)} 19:30:00` }] });
  const gevraagd = [];
  const pekela = await nepInternet((u) => {
    if (u.host !== 'api.notubiz.nl') return undefined;
    if (u.pathname === '/organisations/1811/gremia') return { gremia: [{ id: 1, title: 'Gemeenteraad' }] };
    if (u.pathname === '/organisations/1811') return { organisation: { name: 'Gemeente Pekela' } };
    if (u.pathname === '/events') return { events: [ev(1, true, 10), ev(2, false, 20), ev(3, false, 30)], pagination: { has_more_pages: false } };
    if (u.pathname === '/media') {
      gevraagd.push(u.searchParams.get('event_id'));
      return u.searchParams.get('event_id') === '2' ? media : { media: [] };
    }
    return undefined;
  });
  try {
    const c = await ontdek({ url: 'https://pekela.raadsinformatie.nl/', audio: { kind: 'notubiz', organisatie: '1811', eersteImport: 0, geinitialiseerd: true } });
    assert.deepEqual(c.items.map((i) => i.extern), ['ntb:1811/1', 'ntb:1811/2']);
    assert.deepEqual(gevraagd, ['2', '3'], 'alleen bij wat niet live was, de media opvragen');
    gevraagd.length = 0;
    await ontdek({ url: 'https://pekela.raadsinformatie.nl/', audio: { kind: 'notubiz', organisatie: '1811', eersteImport: 0, geinitialiseerd: true } });
    assert.deepEqual(gevraagd, ['2'], 'een oude vergadering zonder video wordt onthouden');
  } finally {
    pekela.herstel();
  }
});

test('een vergadering die al klaar was, krijgt de sprekers van Notubiz alsnog', metSqlite, async () => {
  const { TRANSCRIPT } = await import('./nep-worker.mjs');
  const worker = await nepWorker();
  const net = await nepInternet((u) => {
    if (u.host === 'sudwestfryslan.raadsinformatie.nl' && u.pathname === '/vergadering/77') {
      return `<script>media_file = { pubpoint: "rtmp://wowza1.notubiz.nl/nbvod", streamname: "raad.mp4" }; media_files[1] = media_file;</script>
        <ul class="speakers_indexations"><li class="speaker_index js_only" data-speaker_id="9" data-start_offset="44" data-end_offset="71">
        <button><span class="icon-user">spreker: </span>Kramer, Jan (wethouder)</button></li></ul>`;
    }
    if (u.host === 'api.notubiz.nl' && u.pathname === '/events/meetings/77') {
      return { meeting: { agenda_items: [{ type_data: { title_prefix: '1', attributes: [{ id: 1, value: 'Iepening' }] }, start_offset: '0', end_offset: '40' }] } };
    }
  });
  try {
    const { opslag, adb, verwerking } = await opzet();
    opslag.instellingen.audio = { ...opslag.instellingen.audio, workerUrl: worker.url, workerToken: TOKEN, viaTailnet: false };
    const bron = { id: 'swf', naam: 'Súdwest-Fryslân · Raad', soort: 'raadsvergadering', bereik: 'regio', regio: 'sudwestfryslan', type: 'audio', url: 'https://sudwestfryslan.raadsinformatie.nl/', audio: { kind: 'notubiz', prioriteit: 0 } };
    opslag.bronnen.push(bron);
    const id = 'f'.repeat(32);
    adb.voegToe(bron, { id, extern: 'ntb:1/77', vorm: 'vergadering', url: 'https://sudwestfryslan.raadsinformatie.nl/vergadering/77', titel: 'Raadsvergadering', gepubliceerdOp: Date.now() / 1000 - 86400 });
    const { schoonSegmenten } = await import('../src/audio/verwerking.mjs');
    adb.werkBij(id, { transcript: 'x', segmenten: schoonSegmenten(TRANSCRIPT), status: 'klaar', platform: { agenda: [], sprekers: [] } });
    assert.equal(verwerking.volgende().length, 0, 'niets in de wachtrij');

    assert.equal(await verwerking.verwerkEen(), true);
    const a = adb.aflevering(id);
    assert.deepEqual([a.platform.versie, a.platform.agenda.map((p) => p.titel), a.platform.sprekers.map((p) => p.naam)], [2, ['1 Iepening'], ['Jan Kramer']]);
    assert.equal(worker.staat.namen.get(STEM.wethouder), 'Jan Kramer', 'de stem heeft zijn naam');
    assert.equal(a.status, 'klaar');
    assert.equal(await verwerking.verwerkEen(), false, 'daarna niet nog eens');

    // Een recente vergadering waarbij Notubiz de sprekers nog niet had: een dag later opnieuw kijken.
    adb.werkBij(id, { platform: { agenda: [], sprekers: [], versie: 2, opgehaald: Date.now() / 1000 - 3600 } });
    assert.equal(await verwerking.verwerkEen(), false, 'een uur geleden bekeken');
    adb.werkBij(id, { platform: { agenda: [], sprekers: [], versie: 2, opgehaald: Date.now() / 1000 - 90000 } });
    verwerking.platformGeprobeerd.clear();
    assert.equal(await verwerking.verwerkEen(), true, 'gisteren bekeken');
    assert.equal(adb.aflevering(id).platform.sprekers.length, 1);
    assert.equal(await verwerking.verwerkEen(), false, 'met sprekers is het klaar');
  } finally {
    net.herstel();
    worker.server.close();
  }
});

test('lange opnames in delen naar de worker, met tussenstand', metAlles, async () => {
  const { voegDelenSamen } = await import('../src/audio/verwerking.mjs');
  const X = 'ab'.repeat(16);
  const samen = voegDelenSamen([
    { start: 0, language: 'nl', segments: [{ start: 0, end: 10, text: ' Een', speaker: 'SPEAKER_00' }, { start: 10, end: 2702, text: ' Twee', speaker: 'SPEAKER_01', speaker_id: X }] },
    { start: 2700, language: 'nl', segments: [{ start: 0, end: 2, text: ' Twee nog eens', speaker: 'SPEAKER_00' }, { start: 3, end: 20, text: ' Drie', speaker: 'SPEAKER_00' }, { start: 20, end: 30, text: ' Vier', speaker: 'SPEAKER_01', speaker_id: X }] },
  ]);
  assert.equal(samen.text, 'Een Twee Drie Vier', 'de overlap niet dubbel');
  assert.deepEqual(samen.segments.map((s) => [s.start, s.end, s.speaker, s.speaker_id || null]), [
    [0, 10, 'SPEAKER_0', null], [10, 2702, 'SPEAKER_1', X], [2703, 2720, 'SPEAKER_100', null], [2720, 2730, 'SPEAKER_101', X],
  ], 'tijden vanaf het begin; een stem zonder profiel per deel apart, een profiel overal hetzelfde');
  assert.equal(samen.language, 'nl');
  // Een lange beurt die in de overlap begint en daarna doorloopt, blijft staan:
  // met woordtijden zonder de dubbele woorden, zonder woordtijden heel.
  const beurt = (words) => voegDelenSamen([
    { start: 0, segments: [{ start: 2690, end: 2702, text: ' Dat is het. Voorzitter,' }] },
    { start: 2700, segments: [{ start: 0.5, end: 320, text: ' Voorzitter, dank u wel. Lang verhaal.', ...(words ? { words: [{ start: 0.5, end: 1.6, word: ' Voorzitter,' }, { start: 2.2, end: 2.6, word: ' dank' }, { start: 2.6, end: 3, word: ' u' }, { start: 3, end: 3.3, word: ' wel.' }, { start: 4, end: 320, word: ' Lang verhaal.' }] } : {}) }] },
  ]);
  assert.deepEqual(beurt(true).segments.map((s) => [s.start, s.text, s.words]), [[2690, ' Dat is het. Voorzitter,', undefined], [2702.2, 'dank u wel. Lang verhaal.', undefined]]);
  assert.deepEqual(beurt(false).segments.map((s) => [s.start, s.end, s.text]), [[2690, 2702, ' Dat is het. Voorzitter,'], [2700.5, 3020, ' Voorzitter, dank u wel. Lang verhaal.']], 'één woord gelijk: te weinig om op te vertrouwen');
  const dubbel = voegDelenSamen([
    { start: 0, segments: [{ start: 2690, end: 2703, text: ' Dat is het. Dank u wel, voorzitter.' }] },
    { start: 2700, segments: [{ start: 1, end: 300, text: ' dank u wel voorzitter. Dan de begroting.' }] },
  ]);
  assert.equal(dubbel.segments[1].text, 'Dan de begroting.', 'zonder woordtijden: de herhaalde woorden uit de overlap eruit');

  // Een opname van twee seconden met delen van één seconde: twee keer naar de worker.
  process.env.AUDIO_DEEL_S = '1';
  const worker = await nepWorker();
  const feed = await nepPodcast({ n: 2 });
  try {
    const { opslag, adb, verwerking } = await opzet();
    opslag.instellingen.audio = { ...opslag.instellingen.audio, workerUrl: worker.url, workerToken: TOKEN, viaTailnet: false };
    const bron = { id: 'p', naam: 'p', soort: 'podcast', bereik: 'landelijk', type: 'audio', url: feed.url, aangemaakt: '2026-10-01', audio: { kind: 'rss', eersteImport: 0, actief: true, geinitialiseerd: true, prioriteit: 0 } };
    opslag.bronnen.push(bron);
    const basis = feed.url.replace(/\/feed\.xml$/, '');
    for (const n of [1, 2]) adb.voegToe(bron, { extern: `rss:${n}`, vorm: 'rss', url: `${basis}/afl/${n}`, mediaUrl: `${basis}/audio/${n}.wav`, titel: `Aflevering ${n}`, gepubliceerdOp: Date.now() / 1000 - n * 86400 });
    const uploads = () => worker.staat.verzoeken.filter((v) => v === 'POST /v1/media/transcriptions').length;

    assert.equal(await verwerking.verwerkEen(), true);
    const a = adb.aflevering(adb.lijst({ bron: 'p' }).find((x) => x.titel === 'Aflevering 1').id);
    assert.equal(uploads(), 2);
    assert.equal(worker.staat.laatsteUpload.opname, `regiochecker:${a.id}-2`);
    assert.equal(a.status, 'getranscribeerd');
    assert.deepEqual(a.transcriptDelen, [], 'de tussenstand is opgeruimd');
    // De nagebootste worker geeft voor elk deel 70 seconden tekst, ook voor één seconde audio:
    // van deel 2 blijft alleen het segment staan dat na het einde van deel 1 doorloopt.
    assert.deepEqual(a.segmenten.map((s) => [s.speaker, s.start]), [['Voorzitter Bos', 2], ['Anke Postma', 15], ['Spreker 1', 39], ['Spreker 2', 45], ['Spreker 3', 46]]);
    assert.ok(a.duur > 1.5 && a.duur < 2.5, 'de lengte van de hele opname');

    // Eerst deze aflevering afmaken, dan de volgende. Namen zoeken staat
    // standaard uit: geen verzoek om namen naar de worker.
    assert.equal(await verwerking.verwerkEen(), true);
    assert.equal(adb.aflevering(a.id).status, 'klaar');
    assert.equal(uploads(), 2);
    assert.ok(!worker.staat.verzoeken.includes('POST /v1/entities'));
    assert.equal(adb.aflevering(a.id).entiteiten, null);

    // Na een storing: verder bij het deel dat nog ontbreekt.
    const tweede = adb.lijst({ bron: 'p' }).find((x) => x.titel === 'Aflevering 2');
    adb.werkBij(tweede.id, { transcriptDelen: [{ start: 0, text: 'Al klaar.', segments: [{ start: 0, end: 1, text: ' Al klaar.' }], language: 'nl' }] });
    assert.equal(await verwerking.verwerkEen(), true);
    assert.equal(uploads(), 3, 'alleen het tweede deel');
    assert.match(adb.aflevering(tweede.id).transcript, /^Al klaar\. Dan gaan we naar agendapunt 6/);
  } finally {
    delete process.env.AUDIO_DEEL_S;
    worker.server.close();
    feed.server.close();
  }
});

test('een eerste import van alleen nieuwe afleveringen, en later toch het hele archief, achter wat nieuw is', metSqlite, async () => {
  const feed = await nepPodcast({ n: 4 });
  try {
    const { opslag, adb, verwerking } = await opzet();
    const bron = { id: 'p', naam: 'p', soort: 'podcast', bereik: 'landelijk', type: 'audio', url: feed.url, aangemaakt: new Date().toISOString(), audio: { kind: 'rss', eersteImport: -1, actief: true, prioriteit: 0 } };
    opslag.bronnen.push(bron);
    assert.deepEqual(await verwerking.synchroniseer(bron), { ok: true, nieuw: 0, aantal: 4 });
    assert.equal(adb.lijst({ bron: 'p' }).length, 0, 'het archief niet');
    feed.staat.extra.push({ guid: 'afl-nieuw', dagen: 0 });
    assert.deepEqual(await verwerking.synchroniseer(bron), { ok: true, nieuw: 1, aantal: 5 });
    assert.deepEqual(adb.lijst({ bron: 'p' }).map((a) => [a.titel, a.status]), [['afl-nieuw', 'wacht']]);

    // Later toch het hele archief: wat als gezien was gemarkeerd, komt alsnog
    // binnen, als archief, en achter wat nieuw is in de wachtrij.
    bron.audio.archiefGevraagd = true;
    await verwerking.controleerBronnen(Date.now() - 2 * 3600_000);
    assert.equal(bron.audio.archiefGevraagd, undefined);
    assert.deepEqual([bron.audio.archief.aantal, bron.audio.archief.toegevoegd], [5, 4]);
    const archief = adb.lijst({ bron: 'p' }).filter((a) => a.nulmeting);
    assert.equal(archief.length, 4);
    const tweede = { ...bron, id: 'q', naam: 'q', audio: { ...bron.audio, prioriteit: 1, archiefGevraagd: undefined, archief: undefined } };
    opslag.bronnen.push(tweede);
    adb.voegToe(tweede, { extern: 'q:1', vorm: 'rss', url: `${feed.url}#q1`, mediaUrl: `${feed.url}#q1`, titel: 'Nieuw bij de tweede bron', gepubliceerdOp: Date.now() / 1000 - 30 * 86400 });
    const volgorde = verwerking.volgende(Date.now() / 1000 + 60).map((r) => adb.aflevering(r.id).titel);
    assert.deepEqual(volgorde.slice(0, 2), ['afl-nieuw', 'Nieuw bij de tweede bron'], 'eerst wat nieuw is, ook van een latere bron');
    assert.equal(volgorde.length, 6);

    // Audio van een archiefopname ouder dan de bewaartermijn gaat meteen weg.
    opslag.instellingen.audio = { ...opslag.instellingen.audio, bewaarAudio: 'alles', bewaarDagen: 180 };
    assert.equal(verwerking.bewaarAudio({ soort: 'podcast', nulmeting: true, gepubliceerd: new Date(Date.now() - 400 * 86400_000).toISOString() }), false);
    assert.equal(verwerking.bewaarAudio({ soort: 'podcast', nulmeting: true, gepubliceerd: new Date(Date.now() - 10 * 86400_000).toISOString() }), true);
    assert.equal(verwerking.bewaarAudio({ soort: 'podcast', nulmeting: false, gepubliceerd: new Date(Date.now() - 400 * 86400_000).toISOString() }), true);
  } finally {
    feed.server.close();
  }
});

test('AI-samenvatting: de hele opname in hooguit 100 woorden, als laatste stap', metSqlite, async () => {
  const { beperkWoorden } = await import('../src/vergadering.mjs');
  const zin = (n) => Array.from({ length: n }, (_, i) => `woord${i + 1}`).join(' ');
  assert.equal(beperkWoorden(`${zin(70)}. ${zin(50)}.`), `${zin(70)}.`, 'op een zinsgrens');
  assert.equal(beperkWoorden(zin(150)), `${zin(100)}…`);
  assert.equal(beperkWoorden('  Kort.  '), 'Kort.');

  // Een nagebootste Ollama: aantekeningen per deel, of de samenvatting (te lang).
  const chats = [];
  let kapot = false;
  const ollama = http.createServer(async (req, res) => {
    let ruw = '';
    for await (const stuk of req) ruw += stuk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion'] }));
    const body = JSON.parse(ruw);
    chats.push(body);
    if (kapot) return res.end(JSON.stringify({ message: { content: 'geen json' }, done_reason: 'stop' }));
    const deel = Boolean(body.format?.properties?.punten);
    const inhoud = deel ? { punten: [`Punt uit deel ${chats.length}.`] } : { samenvatting: `De raad besprak de huisartsenpost in Drachten. ${zin(120)}.` };
    return res.end(JSON.stringify({ model: body.model, message: { content: JSON.stringify(inhoud) }, done_reason: 'stop' }));
  });
  await new Promise((klaar) => ollama.listen(0, '127.0.0.1', klaar));
  const worker = await nepWorker();
  // De nagebootste Ollama staat op deze machine, niet in het tailnet.
  const proxy = process.env.REGIOCHECKER_TAILNET_PROXY;
  delete process.env.REGIOCHECKER_TAILNET_PROXY;
  try {
    const { opslag, adb, fdb, verwerking } = await opzet();
    opslag.instellingen.audio = { ...opslag.instellingen.audio, workerUrl: worker.url, workerToken: TOKEN, viaTailnet: false };
    opslag.instellingen.audio.namenZoeken = true;
    opslag.instellingen.samenvattingVia = 'ollama';
    // Een klein model voor opnames, naast het grote voor de weekmail.
    opslag.instellingen.ollama = { url: `http://127.0.0.1:${ollama.address().port}`, model: 'qwen3:14b', modelOpnames: 'klein:4b', maxContext: 4096 };
    const bron = { id: 'raad', naam: 'Smallingerland · Raad', soort: 'raadsvergadering', bereik: 'regio', regio: 'smallingerland', type: 'audio', url: 'https://smallingerland.raadsinformatie.nl/', audio: { kind: 'notubiz', prioriteit: 0 } };
    opslag.bronnen.push(bron);
    const voeg = (id, segmenten) => {
      adb.voegToe(bron, { id, extern: `ntb:1/${id.slice(0, 4)}`, vorm: 'vergadering', url: `https://x/${id}`, titel: 'Raadsvergadering 23 oktober', gepubliceerdOp: Date.now() / 1000 - 86400 });
      adb.werkBij(id, { transcript: segmenten.map((t) => t.text).join(' '), segmenten, entiteiten: [], status: 'klaar', eersteGezien: new Date().toISOString() });
    };
    const KORT = 'a'.repeat(32);
    const LANG = 'b'.repeat(32);
    voeg(KORT, [{ start: 2, end: 14, text: 'Dan gaan we naar agendapunt 6.', speaker: 'Voorzitter Bos' }]);
    // Te lang voor één keer in het (kleine) contextvenster: in delen.
    voeg(LANG, Array.from({ length: 120 }, (_, i) => ({ start: i * 30, end: i * 30 + 29, text: `Zin ${i} over de begroting van de gemeente en de plannen voor het komende jaar.`, speaker: 'Spreker 1' })));
    assert.equal(verwerking.volgende().length, 2, 'klaar, maar nog zonder samenvatting');

    // De GPU is bezig (Plaud): wachten.
    worker.staat.gpuBezig = true;
    await verwerking.verwerkEen();
    assert.equal(chats.length, 0);
    assert.ok([LANG, KORT].some((id) => /wacht op de gedeelde GPU/.test(adb.aflevering(id).stap)));
    worker.staat.gpuBezig = false;
    adb.db.prepare('UPDATE afleveringen SET opnieuw_op = 0').run();

    while (verwerking.volgende().length) await verwerking.verwerkEen();
    const kort = adb.aflevering(KORT);
    assert.equal(kort.status, 'klaar');
    assert.equal(kort.samenvatting.tekst.split(' ').length <= 100, true, 'hooguit 100 woorden');
    assert.match(kort.samenvatting.tekst, /^De raad besprak de huisartsenpost in Drachten\./);
    assert.equal(kort.samenvatting.model, 'klein:4b');
    assert.ok(chats.every((c) => c.model === 'klein:4b' && c.options.num_ctx <= 16384), 'het model voor opnames, met een beperkt contextvenster');
    const lang = adb.aflevering(LANG);
    const delen = chats.filter((c) => c.format?.properties?.punten);
    assert.ok(delen.length >= 2, 'een lang transcript eerst in delen');
    assert.ok(chats.some((c) => !c.format?.properties?.punten && /^Aantekeningen per deel/m.test(c.messages[1].content)), 'daarna de aantekeningen tot het geheel');
    assert.ok(lang.samenvatting.tekst);
    assert.ok(chats.every((c) => c.keep_alive === 0), 'het model gaat meteen uit het geheugen');
    assert.match(chats[0].messages[0].content, /hooguit|Noteer de belangrijkste punten/);

    // In het leespaneel, boven het transcript.
    const jan = herkenGebruiker(opslag, { login: 'jan', email: 'jan@example.nl' });
    const r = await roep({ opslag, kdb: null, fdb, adb }, jan, 'GET', `/api/stuk?id=a:${KORT}`);
    assert.deepEqual([r.data.samenvatting.tekst, r.data.samenvatting.model], [kort.samenvatting.tekst, 'klein:4b']);

    // Een nieuwe aflevering: namen en samenvatting direct na elkaar, vóór achterstand.
    const NIEUW = 'c'.repeat(32);
    adb.voegToe(bron, { id: NIEUW, extern: 'ntb:1/nieuw', vorm: 'vergadering', url: 'https://x/nieuw', titel: 'Commissie 27 oktober', gepubliceerdOp: Date.now() / 1000 - 3600 });
    adb.werkBij(NIEUW, { transcript: 'Wij maken ons zorgen over de huisartsenpost in Drachten.', segmenten: [{ start: 1, end: 9, text: 'Wij maken ons zorgen over de huisartsenpost in Drachten.' }], status: 'getranscribeerd' });
    adb.werkBij(LANG, { samenvatting: null });
    await verwerking.verwerkEen();
    assert.deepEqual([adb.aflevering(NIEUW).status, adb.aflevering(NIEUW).stap], ['getranscribeerd', 'Namen klaar · samenvatting volgt']);
    await verwerking.verwerkEen();
    assert.equal(adb.aflevering(NIEUW).status, 'klaar');
    assert.ok(adb.aflevering(NIEUW).samenvatting.tekst);
    assert.equal(adb.aflevering(LANG).samenvatting, null, 'achterstand pas daarna');
    adb.werkBij(LANG, { samenvatting: { tekst: 'Al gedaan.' } });

    // Lukt het niet, dan blijft de aflevering klaar; na drie keer niet meer proberen.
    kapot = true;
    adb.werkBij(KORT, { samenvatting: null });
    for (let i = 0; i < 3; i++) {
      adb.db.prepare('UPDATE afleveringen SET opnieuw_op = 0').run();
      await verwerking.verwerkEen();
    }
    const mislukt = adb.aflevering(KORT);
    assert.deepEqual([mislukt.status, mislukt.samenvatting.pogingen, mislukt.stap], ['klaar', 3, 'Klaar · geen samenvatting']);
    adb.db.prepare('UPDATE afleveringen SET opnieuw_op = 0').run();
    assert.equal(verwerking.volgende().length, 0);
    assert.equal((await roep({ opslag, kdb: null, fdb, adb }, jan, 'GET', `/api/stuk?id=a:${KORT}`)).data.samenvatting, null);
    // Een nieuwe aflevering blijft bij een herkansing lopend; pas na drie keer klaar.
    adb.werkBij(NIEUW, { samenvatting: null, status: 'getranscribeerd', opnieuwOp: 0 });
    await verwerking.verwerkEen();
    assert.deepEqual([adb.aflevering(NIEUW).status, adb.aflevering(NIEUW).stap], ['getranscribeerd', 'Samenvatting over 1 min opnieuw']);
  } finally {
    if (proxy) process.env.REGIOCHECKER_TAILNET_PROXY = proxy;
    ollama.close();
    worker.server.close();
  }
});

test('verwerking: volgorde van de bronnen, mislukken na drie keer, opnieuw proberen', metSqlite, async () => {
  const { opslag, adb, verwerking } = await opzet();
  const bron = (id, prioriteit) => ({ id, naam: id, soort: 'podcast', bereik: 'landelijk', type: 'audio', url: `https://x/${id}`, aangemaakt: '2026-10-01', audio: { kind: 'rss', eersteImport: 3, actief: true, geinitialiseerd: true, prioriteit } });
  opslag.bronnen.push(bron('a', 0), bron('b', 1));
  const voeg = (b, extern, dagen) => adb.voegToe(opslag.bronnen.find((x) => x.id === b), { extern, vorm: 'rss', url: `https://x/${extern}`, titel: extern, mediaUrl: 'http://192.168.1.1/x.mp3', gepubliceerdOp: Date.now() / 1000 - dagen * 86400 });
  voeg('a', 'a-oud', 5);
  voeg('a', 'a-nieuw', 1);
  voeg('b', 'b-1', 0);
  const titels = () => verwerking.volgende().map((r) => adb.aflevering(r.id).titel);
  assert.deepEqual(titels(), ['a-nieuw', 'a-oud', 'b-1'], 'bron a eerst, het nieuwste eerst');
  verwerking.zetVolgorde(['b']);
  assert.deepEqual(titels(), ['b-1', 'a-nieuw', 'a-oud']);
  assert.deepEqual(opslag.bronnen.map((b) => b.audio.prioriteit), [1, 0]);

  // Een echte fout (geen storing): drie keer, dan mislukt.
  const af = adb.aflevering(verwerking.volgende()[0].id);
  for (let i = 0; i < 3; i++) verwerking.mislukt(adb.aflevering(af.id), new Error('Bestand is groter dan de ingestelde limiet.'));
  const mislukt = adb.aflevering(af.id);
  assert.deepEqual([mislukt.status, mislukt.pogingen, mislukt.stap], ['mislukt', 3, 'Verwerking mislukt']);
  assert.ok(opslag.logboek.some((l) => l.soort === 'audiofout'));
  assert.ok(!verwerking.volgende().some((r) => r.id === af.id));
  verwerking.opnieuw(af.id);
  assert.deepEqual([adb.aflevering(af.id).status, adb.aflevering(af.id).pogingen], ['wacht', 0]);
  // De opname van een recente vergadering staat er nog niet: later opnieuw, geen mislukte poging.
  for (let i = 0; i < 4; i++) verwerking.mislukt(adb.aflevering(af.id), Object.assign(new Error('Nog geen opname.'), { later: 3 * 3600 }));
  const later = adb.aflevering(af.id);
  assert.deepEqual([later.status, later.pogingen, later.stap], ['wacht', 0, 'Opname nog niet beschikbaar · nieuwe poging over 3 uur']);
  assert.ok(!verwerking.volgende().some((r) => r.id === af.id), 'pas over drie uur weer aan de beurt');
  // Een privéadres als media: geweigerd (zonder de uitzondering voor de tests).
  delete process.env.REGIOCHECKER_PRIVE_ADRESSEN;
  try {
    const { openbaar } = await import('../src/audio/ophalen.mjs');
    await assert.rejects(openbaar('http://192.168.1.1/x.mp3'), /openbare internetadressen/);
    await assert.rejects(openbaar('http://[::ffff:127.0.0.1]/'), /openbare internetadressen/);
  } finally {
    process.env.REGIOCHECKER_PRIVE_ADRESSEN = '1';
  }
});

test('een audioscraper-archief overnemen', metSqlite, async () => {
  const { DatabaseSync } = sqlite;
  const { importeerAudioscraper } = await import('../src/audio/importeer.mjs');
  const pad = path.join(tijdelijk(), 'audioscraper.sqlite3');
  const oud = new DatabaseSync(pad);
  oud.exec(`CREATE TABLE sources (id TEXT PRIMARY KEY, url TEXT, kind TEXT, title TEXT, enabled INTEGER, initial_limit INTEGER, initialized INTEGER, created REAL, checked REAL, error TEXT, syncing INTEGER, name TEXT, description TEXT, accent TEXT, priority INTEGER);
    CREATE TABLE seen (source_id TEXT, external_id TEXT);
    CREATE TABLE episodes (id TEXT PRIMARY KEY, source_id TEXT, external_id TEXT, url TEXT, media_url TEXT, kind TEXT, title TEXT, author TEXT, published TEXT, duration REAL, thumbnail_url TEXT, status TEXT, stage TEXT, created REAL, updated REAL, attempts INTEGER, retry_at REAL, error TEXT, audio_path TEXT, transcript TEXT, segments TEXT, language TEXT, entities TEXT, entity_chunks TEXT, speaker_error TEXT, speaker_requested INTEGER, published_at REAL);
    CREATE TABLE phone_mentions (phone TEXT, episode_id TEXT, segment INTEGER, start REAL, raw TEXT, display TEXT, category TEXT, context TEXT);
    CREATE TABLE phone_attributions (phone TEXT, state TEXT, subject_type TEXT, relation TEXT, label TEXT, description TEXT, confidence INTEGER, evidence TEXT, episode_id TEXT, segment INTEGER, source TEXT, reviewed REAL);
    CREATE TABLE app_settings (key TEXT, value TEXT);`);
  oud.prepare('INSERT INTO sources VALUES (?, ?, ?, ?, 1, 3, 1, 1790000000, 1793000000, NULL, 0, ?, NULL, NULL, ?)').run('s1', 'https://channel.royalcast.com/gemeenteopsterland/', 'companywebcast', 'Gemeente Opsterland', null, 0);
  oud.prepare('INSERT INTO sources VALUES (?, ?, ?, ?, 0, 3, 1, 1790000000, NULL, NULL, 0, ?, NULL, NULL, ?)').run('s2', 'https://www.youtube.com/@omropfryslan/videos', 'youtube-videos', 'Omrop Fryslân', 'Omrop', 1);
  const segs = JSON.stringify([{ start: 0, end: 5, text: 'Welkom in Gorredijk.', speaker: 'Spreker 1', speaker_id: 'a'.repeat(32) }]);
  const ep = oud.prepare('INSERT INTO episodes VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?, 5, NULL, ?, ?, 1790000000, 1793000000, 0, 0, NULL, NULL, ?, ?, ?, ?, NULL, NULL, 0, ?)');
  ep.run('e'.repeat(32), 's1', 'cwc:gemeenteopsterland/20261027_1', 'https://channel.royalcast.com/x', 'meeting', 'Raadsvergadering', '20261027', 'completed', 'Voltooid', 'Welkom in Gorredijk.', segs, 'nl', '[]', 1793059200);
  ep.run('f'.repeat(32), 's1', 'cwc:gemeenteopsterland/20261030_1', 'https://channel.royalcast.com/y', 'meeting', 'Commissie', '20261030', 'transcribing', 'Transcriberen', null, null, null, null, 1793318400);
  ep.run('9'.repeat(32), 's2', 'yt:abcdefghijk', 'https://www.youtube.com/watch?v=abcdefghijk', 'youtube', 'Sportcast', '20261027', 'transcribed', 'Klaar', 'Over Thialf.', '[]', 'nl', null, 1793059200);
  oud.prepare('INSERT INTO seen VALUES (?, ?)').run('s1', 'cwc:gemeenteopsterland/20261027_1');
  oud.prepare('INSERT INTO seen VALUES (?, ?)').run('s1', 'cwc:gemeenteopsterland/2012_oud');
  oud.prepare('INSERT INTO phone_mentions VALUES (?, ?, 0, 1.5, ?, ?, ?, ?)').run('0612345678', 'e'.repeat(32), '06-12345678', '06 1234 5678', 'Mobiel nummer', 'bel 06-12345678');
  oud.prepare("INSERT INTO phone_attributions VALUES ('0612345678', 'confirmed', 'person', 'called_target', 'Jan', '', 100, '', NULL, NULL, 'manual', 1793000000)").run();
  oud.close();

  const { opslag, adb } = await opzet();
  const uit = await importeerAudioscraper({ opslag, adb }, pad);
  assert.deepEqual(uit, { bronnen: 2, afleveringen: 3, overgeslagen: 0, nummers: 1, beoordelingen: 1 });
  const [raad, omrop] = opslag.bronnen;
  assert.deepEqual([raad.naam, raad.soort, raad.bereik, raad.regio, raad.audio.kind, raad.audio.actief], ['Opsterland · Gemeente Opsterland', 'raadsvergadering', 'regio', 'opsterland', 'companywebcast', true]);
  assert.deepEqual([omrop.naam, omrop.soort, omrop.bereik, omrop.audio.actief, omrop.audio.prioriteit], ['Omrop', 'youtube', 'landelijk', false, 1]);
  assert.deepEqual(adb.lijst({}).map((a) => [a.titel, a.status, a.heeftTranscript]).sort(), [['Commissie', 'wacht', false], ['Raadsvergadering', 'klaar', true], ['Sportcast', 'getranscribeerd', true]]);
  const vergadering = adb.aflevering('e'.repeat(32));
  assert.equal(vergadering.eersteGezien, new Date(1793059200 * 1000).toISOString(), 'als nulmeting: op de eigen datum');
  assert.equal(vergadering.segmenten[0].speaker_id, 'a'.repeat(32));
  assert.deepEqual([...adb.gezien(raad.id)].sort(), ['cwc:gemeenteopsterland/2012_oud', 'cwc:gemeenteopsterland/20261027_1']);
  assert.equal(adb.db.prepare('SELECT staat FROM telefoon_koppelingen').get().staat, 'bevestigd');
  // Nog een keer: niets dubbel.
  assert.deepEqual(await importeerAudioscraper({ opslag, adb }, pad), { bronnen: 0, afleveringen: 0, overgeslagen: 0, nummers: 0, beoordelingen: 0 });
});

function nepClaude(antwoord) {
  const verzoeken = [];
  const server = http.createServer(async (req, res) => {
    let ruw = '';
    for await (const stuk of req) ruw += stuk;
    verzoeken.push(JSON.parse(ruw));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
      content: [{ type: 'text', text: JSON.stringify(antwoord) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  return new Promise((klaar) => server.listen(0, '127.0.0.1', () => klaar({
    server, verzoeken, client: new Anthropic({ apiKey: 'test', baseURL: `http://127.0.0.1:${server.address().port}`, maxRetries: 0 }),
  })));
}

test('raadsvergadering in de weekmail: per onderwerp een kop met punten', metSqlite, async () => {
  const nep = await nepClaude({ onderwerpen: [
    { kop: 'Programmabegroting 2027', punten: ['Gemeentebelangen dient een motie in over de huisartsenpost in Drachten.', 'De motie wordt <unaniem> aangenomen.'] },
    { kop: 'Leeg onderwerp', punten: [] },
  ] });
  try {
    const { vatVergaderingSamen } = await import('../src/vergadering.mjs');
    const { stelMailSamen } = await import('../src/mail.mjs');
    const { TRANSCRIPT } = await import('./nep-worker.mjs');
    const { opslag, adb } = await opzet();
    opslag.instellingen.claude.apiKey = 'test';
    const bron = { id: 'raad', naam: 'Smallingerland · Raad', soort: 'raadsvergadering', bereik: 'regio', regio: 'smallingerland', type: 'audio', url: 'https://smallingerland.raadsinformatie.nl/', audio: { kind: 'notubiz', prioriteit: 0 } };
    opslag.bronnen.push(bron);
    adb.voegToe(bron, { id: 'a'.repeat(32), extern: 'ntb:1/2', vorm: 'vergadering', url: 'https://smallingerland.raadsinformatie.nl/vergadering/2', titel: 'Raadsvergadering 23 oktober', gepubliceerdOp: Date.now() / 1000 - 86400 });
    adb.werkBij('a'.repeat(32), { transcript: 'x', segmenten: TRANSCRIPT.map((s) => ({ ...s, text: s.text.trim() })), status: 'klaar', eersteGezien: new Date().toISOString() });
    const a = adb.aflevering('a'.repeat(32));

    const samenvatting = await vatVergaderingSamen({ opslag, aflevering: a, regioNaam: 'Smallingerland', client: nep.client });
    assert.deepEqual(samenvatting.onderwerpen.map((o) => o.kop), ['Programmabegroting 2027'], 'een onderwerp zonder punten valt weg');
    const vraag = nep.verzoeken[0];
    assert.match(vraag.system, /gemeenteraad/);
    assert.match(vraag.messages[0].content, /^Gemeente: Smallingerland\nVergadering: Raadsvergadering 23 oktober/);
    assert.match(vraag.messages[0].content, /\[0:45\] SPEAKER_02: Het college praat/);

    // De weekmail haalt hem uit de cache: geen tweede aanroep.
    const mail = await stelMailSamen(opslag, { email: 'x@lc.nl', regios: ['smallingerland'], laatsteMail: new Date(Date.now() - 2 * 86400000).toISOString() });
    assert.equal(nep.verzoeken.length, 1);
    assert.match(mail.html, /<h3[^>]*>Raadsvergaderingen<\/h3> <span[^>]*>\(1\)<\/span>/, 'per soort een eigen kop, zoals de tabbladen');
    assert.match(mail.html, /<h4[^>]*>Programmabegroting 2027<\/h4><ul[^>]*><li[^>]*>Gemeentebelangen dient een motie in/);
    assert.match(mail.html, /De motie wordt &lt;unaniem&gt; aangenomen\./);
    assert.match(mail.tekst, /\n {2}Programmabegroting 2027\n {3}- Gemeentebelangen/);
    assert.equal(mail.aantal, 1);
    assert.ok(existsSync(opslag.map));
  } finally {
    nep.server.close();
  }
});
