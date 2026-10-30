// De catalogus van een audio- of videobron: welke afleveringen zijn er?
//   YouTube     kanaal, kanaaltab (video's, live, Shorts), afspeellijst of losse
//               video, via yt-dlp (alleen de lijst, nog niets downloaden)
//   podcast     een RSS-feed met audiobijlagen
//   vergadering zie src/audio/vergaderingen.mjs
//
// Elke aflevering krijgt een vaste externe sleutel (yt:<id>, rss:<hash>,
// cwc:/ntb:/ibabs:/go:…), zodat dezelfde aflevering nooit twee keer in de wachtrij komt.

import { createHash } from 'node:crypto';
import { ytdlp, haalTekstOpenbaar, openbaar } from './ophalen.mjs';
import * as vergaderingen from './vergaderingen.mjs';
import { gehoordOntdek } from '../gehoord.mjs';
import { ontsnap } from '../html.mjs';

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be']);
export const YOUTUBE_SOORTEN = {
  youtube: ['Hele kanaal', null],
  'youtube-videos': ['Alleen video\'s', 'videos'],
  'youtube-streams': ['Alleen live-uitzendingen', 'streams'],
  'youtube-shorts': ['Alleen Shorts', 'shorts'],
  'youtube-playlist': ['Eén afspeellijst', null],
};

export const isYoutube = (url) => {
  try { return YT_HOSTS.has(new URL(url).hostname); } catch { return false; }
};

// { kind, url, video } voor een YouTube-adres; `scope` is 'auto' of een van YOUTUBE_SOORTEN.
export function youtubeAdres(url, scope = 'auto') {
  const u = new URL(url);
  if (!YT_HOSTS.has(u.hostname)) throw new Error('Gebruik een youtube.com- of youtu.be-link.');
  let video = u.hostname.endsWith('youtu.be') ? u.pathname.replace(/^\/+|\/+$/g, '') : u.searchParams.get('v') || '';
  if (/^\/(shorts|live|embed)\//.test(u.pathname)) video = u.pathname.split('/')[2];
  const lijst = u.searchParams.get('list');
  if (video) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(video)) throw new Error('Ongeldig YouTube-video-ID.');
    // Een video in een afspeellijst is alleen een afspeellijst als daarvoor gekozen is.
    if (scope === 'youtube-playlist' && lijst) {
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(lijst)) throw new Error('Ongeldig YouTube-afspeellijst-ID.');
      return { kind: 'youtube-playlist', url: `https://www.youtube.com/playlist?list=${lijst}` };
    }
    return { kind: 'video', url: `https://www.youtube.com/watch?v=${video}`, video };
  }
  if (u.pathname === '/playlist' && lijst) {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(lijst)) throw new Error('Ongeldig YouTube-afspeellijst-ID.');
    return { kind: 'youtube-playlist', url: `https://www.youtube.com/playlist?list=${lijst}` };
  }
  if (/^\/(@|channel\/|c\/|user\/)/.test(u.pathname)) {
    const delen = u.pathname.replace(/\/+$/, '').split('/');
    const tab = ['videos', 'streams', 'shorts', 'featured', 'playlists'].includes(delen.at(-1)) ? delen.pop() : null;
    const kind = scope === 'auto' || !scope ? ({ videos: 'youtube-videos', streams: 'youtube-streams', shorts: 'youtube-shorts' }[tab] || 'youtube') : scope;
    if (!YOUTUBE_SOORTEN[kind] || kind === 'youtube-playlist') throw new Error('Gebruik voor een afspeellijst een YouTube-link met list=.');
    const achter = YOUTUBE_SOORTEN[kind][1];
    return { kind, url: `https://www.youtube.com${delen.join('/')}${achter ? `/${achter}` : ''}` };
  }
  throw new Error('Gebruik een YouTube-kanaal, kanaaltab, afspeellijst of losse videolink.');
}

const youtubeAfbeelding = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const ytDatum = (s) => (/^\d{8}$/.test(String(s || '')) ? Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) / 1000 : null);

async function youtubeOntdek(bron, map) {
  const limiet = Number(bron.audio.eersteImport ?? 3);
  const args = ['--flat-playlist', '--extractor-args', 'youtubetab:approximate_date'];
  // Zonder eind: alles wat openbaar is (alleen bij een bewuste volledige eerste import).
  if (limiet) args.push('--playlist-end', String(Math.max(50, limiet)));
  const info = JSON.parse(await ytdlp([...args, '--dump-single-json', bron.url], { map, tijd: limiet ? 240_000 : 900_000 }));
  const items = [];
  const gezien = new Set();
  const loop = function* (knoop) {
    if (!knoop) return;
    if (Array.isArray(knoop.entries)) for (const k of knoop.entries) yield* loop(k);
    else yield knoop;
  };
  for (const e of loop(info)) {
    // Live-uitzendingen die nog bezig of ingepland zijn, slaan we over.
    if (['is_live', 'is_upcoming'].includes(e.live_status)) continue;
    const id = String(e.id || '');
    if (id.length !== 11 || gezien.has(id)) continue;
    gezien.add(id);
    const stempel = Number(e.timestamp || e.release_timestamp || 0);
    const datum = e.upload_date || e.release_date || (stempel ? new Date(stempel * 1000).toISOString().slice(0, 10).replaceAll('-', '') : null);
    items.push({
      extern: `yt:${id}`,
      vorm: 'youtube',
      url: `https://www.youtube.com/watch?v=${id}`,
      titel: e.title || id,
      auteur: e.channel || info.channel || null,
      gepubliceerd: datum,
      gepubliceerdOp: stempel || ytDatum(datum),
      duur: e.duration ?? null,
      afbeelding: e.thumbnail || youtubeAfbeelding(id),
      _sort: stempel || ytDatum(datum) || 0,
    });
  }
  if (!items.length) throw new Error('Geen openbare, afgeronde video\'s gevonden voor deze YouTube-bron.');
  return { titel: info.channel || info.uploader || info.title || bron.naam, items: items.sort((a, b) => b._sort - a._sort) };
}

// ---------- podcast-RSS ----------

function veld(blok, naam) {
  const m = new RegExp(`<${naam}\\b[^>]*>([\\s\\S]*?)</${naam}>`, 'i').exec(blok);
  return m ? ontsnap(m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim()) : '';
}
const attribuut = (tag, naam) => ontsnap(new RegExp(`\\b${naam}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)?.[1] || new RegExp(`\\b${naam}\\s*=\\s*'([^']*)'`, 'i').exec(tag)?.[1] || '');

function duurUit(tekst) {
  if (!tekst) return null;
  const delen = String(tekst).trim().split(':').map(Number);
  if (delen.some((d) => !Number.isFinite(d))) return null;
  return delen.reduce((s, d) => s * 60 + d, 0) || null;
}

export function leesPodcast(xml, feedUrl) {
  const tekst = String(xml);
  const eerste = tekst.search(/<(item|entry)\b/i);
  const kop = eerste > 0 ? tekst.slice(0, eerste) : tekst;
  const feedTitel = veld(kop, 'title');
  const afbeeldingBlok = /<image\b[\s\S]*?<\/image>/i.exec(kop)?.[0] || '';
  const feedAfbeelding = attribuut(/<itunes:image\b[^>]*>/i.exec(kop)?.[0] || '', 'href') || veld(afbeeldingBlok, 'url');
  const items = [];
  for (const [, blok] of tekst.matchAll(/<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi)) {
    const bijlagen = [...blok.matchAll(/<enclosure\b[^>]*>/gi), ...blok.matchAll(/<link\b[^>]*rel=["']enclosure["'][^>]*>/gi)].map((m) => m[0]);
    const bijlage = bijlagen.find((b) => {
      const type = attribuut(b, 'type');
      return (attribuut(b, 'url') || attribuut(b, 'href')) && (!type || type.startsWith('audio/') || type === 'application/octet-stream');
    });
    if (!bijlage) continue;
    let media;
    try { media = new URL(attribuut(bijlage, 'url') || attribuut(bijlage, 'href'), feedUrl).href; } catch { continue; }
    const sleutel = veld(blok, 'guid') || veld(blok, 'id') || media;
    const datum = veld(blok, 'pubDate') || veld(blok, 'published') || veld(blok, 'updated');
    const moment = Date.parse(datum);
    const link = veld(blok, 'link') || attribuut(/<link\b[^>]*rel=["']alternate["'][^>]*>/i.exec(blok)?.[0] || '', 'href');
    items.push({
      extern: `rss:${createHash('sha256').update(`${feedUrl}|${sleutel}`).digest('hex')}`,
      vorm: 'rss',
      url: link || feedUrl,
      mediaUrl: media,
      titel: veld(blok, 'title') || 'Podcastaflevering',
      auteur: feedTitel || null,
      gepubliceerd: datum || null,
      gepubliceerdOp: Number.isFinite(moment) ? moment / 1000 : null,
      duur: duurUit(veld(blok, 'itunes:duration')),
      afbeelding: attribuut(/<itunes:image\b[^>]*>/i.exec(blok)?.[0] || '', 'href') || feedAfbeelding || null,
      _sort: Number.isFinite(moment) ? moment : 0,
    });
  }
  return { titel: feedTitel, items: items.sort((a, b) => b._sort - a._sort) };
}

async function podcastOntdek(bron) {
  const { titel, items } = leesPodcast(await haalTekstOpenbaar(bron.url, { maxBytes: 20 * 1024 ** 2 }), bron.url);
  if (!items.length && !titel) throw new Error('Geen geldige podcast-RSS-feed gevonden.');
  return { titel: titel || bron.naam, items };
}

// ---------- samen ----------

// `opslag`: voor een bron met een eigen koppeling (gehoord.de, de tokens).
export function ontdek(bron, { map, proef = false, opslag } = {}) {
  const kind = bron.audio.kind;
  if (kind === 'gehoord') return gehoordOntdek(bron, { opslag, proef });
  if (vergaderingen.PLATFORMS[kind]) return vergaderingen.ontdek(bron, { proef });
  if (kind === 'rss') return podcastOntdek(bron);
  if (kind === 'video') {
    const id = youtubeAdres(bron.url).video;
    return Promise.resolve({ titel: bron.naam, items: [{ extern: `yt:${id}`, vorm: 'youtube', url: bron.url, titel: `YouTube · ${id}`, afbeelding: youtubeAfbeelding(id), _sort: 0 }] });
  }
  return youtubeOntdek(bron, map);
}

// Een geplakt adres bij het toevoegen van een bron: welk soort en welke vorm?
//   soort 'raadsvergadering' → een vergaderplatform, anders een duidelijke fout
//   soort 'youtube'          → een YouTube-adres, met `scope`
//   soort 'podcast'          → een RSS-feed
//   soort 'kamerdebat'       → gehoord.de (inloggen via Beheer › Instellingen)
export async function herkenBron(url, soort, scope = 'auto') {
  await openbaar(url);
  if (soort === 'kamerdebat') {
    if (new URL(url).hostname.replace(/^www\./, '') !== 'gehoord.de') throw new Error('Kamerdebatten komen van gehoord.de: gebruik https://gehoord.de/beraadslagingen');
    return { kind: 'gehoord', url: 'https://gehoord.de/beraadslagingen' };
  }
  if (soort === 'youtube' || isYoutube(url)) {
    if (soort !== 'youtube') throw new Error('Dit is een YouTube-link; kies het type YouTube.');
    return youtubeAdres(url, scope);
  }
  if (soort === 'raadsvergadering') return vergaderingen.herken(url, 'meetings');
  return { kind: 'rss', url };
}
