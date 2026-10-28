// Ophalen voor audio en video: catalogi, pagina's en mediabestanden van
// openbare adressen, YouTube via yt-dlp, en omzetten naar één compacte mono-mp3
// met ffmpeg (24 kHz, 64 kbit/s: zo'n 29 MB per uur).
//
// Een beheerder plakt hier zelf adressen in, en mediaservers sturen door naar
// weer andere adressen. Daarom gaat elke stap, ook elke doorverwijzing, alleen
// naar openbare internetadressen: nooit naar iets in het eigen netwerk.

import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

export const MAX_BYTES = 2 * 1024 ** 3;
export const UA = 'Regiochecker/1.0 (audio; https://github.com/basvroegop/regiochecker)';

const PRIVE = new net.BlockList();
for (const [adres, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) PRIVE.addSubnet(adres, prefix, 'ipv4');
// Geen ::ffff:0:0/96 hier: BlockList zou dan elk IPv4-adres afwijzen. Zo'n
// adres (IPv4 in IPv6-vorm) controleren we hieronder als het IPv4-adres zelf.
for (const [adres, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) PRIVE.addSubnet(adres, prefix, 'ipv6');

function prive(adres, familie) {
  const v4 = familie === 6 && /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(adres)?.[1];
  return v4 ? PRIVE.check(v4, 'ipv4') : PRIVE.check(adres, familie === 6 ? 'ipv6' : 'ipv4');
}

// Alleen voor de tests: nagebootste platforms draaien op 127.0.0.1.
const priveToegestaan = () => process.env.REGIOCHECKER_PRIVE_ADRESSEN === '1';

export async function openbaar(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('Ongeldig internetadres.');
  }
  if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password) {
    throw new Error('Gebruik een openbare http- of https-adres zonder inloggegevens.');
  }
  if (priveToegestaan()) return u.href;
  let adressen;
  try {
    adressen = await lookup(u.hostname.replace(/^\[|\]$/g, ''), { all: true });
  } catch {
    throw new Error(`${u.hostname} is niet bereikbaar.`);
  }
  if (!adressen.length || adressen.some((a) => prive(a.address, a.family))) {
    throw new Error('Alleen openbare internetadressen zijn toegestaan als bron.');
  }
  return u.href;
}

// Ophalen met elke doorverwijzing gecontroleerd. Zonder `naar` komt de inhoud
// terug als Buffer; met `naar` (een pad) wordt hij gestreamd weggeschreven.
// `cookies` (Map host → string) houdt koekjes vast tussen verzoeken.
export async function haalOpenbaar(url, { naar, maxBytes = 10 * 1024 ** 2, ua = UA, tijd = 90_000, cookies, headers = {} } = {}) {
  let adres = url;
  for (let hop = 0; hop < 8; hop++) {
    await openbaar(adres);
    const host = new URL(adres).host;
    const antwoord = await fetch(adres, {
      redirect: 'manual',
      headers: { 'User-Agent': ua, ...(cookies?.get(host) ? { Cookie: cookies.get(host) } : {}), ...headers },
      signal: AbortSignal.timeout(naar ? 4 * 3600_000 : tijd),
    });
    if (cookies) {
      const nieuw = antwoord.headers.getSetCookie?.() || [];
      if (nieuw.length) {
        const bestaand = new Map((cookies.get(host) || '').split('; ').filter(Boolean).map((c) => [c.split('=')[0], c]));
        for (const c of nieuw) {
          const paar = c.split(';')[0];
          bestaand.set(paar.split('=')[0], paar);
        }
        cookies.set(host, [...bestaand.values()].join('; '));
      }
    }
    if ([301, 302, 303, 307, 308].includes(antwoord.status) && antwoord.headers.get('location')) {
      await antwoord.body?.cancel();
      adres = new URL(antwoord.headers.get('location'), adres).href;
      continue;
    }
    if (!antwoord.ok) {
      await antwoord.body?.cancel();
      throw new Error(`${new URL(adres).host} gaf HTTP ${antwoord.status}`);
    }
    const lengte = Number(antwoord.headers.get('content-length'));
    if (lengte > maxBytes) {
      await antwoord.body?.cancel();
      throw new Error('Bestand is groter dan de ingestelde limiet.');
    }
    let teller = 0;
    const bewaker = new Transform({
      transform(stuk, _, klaar) {
        teller += stuk.length;
        if (teller > maxBytes) return klaar(new Error('Bestand is groter dan de ingestelde limiet.'));
        return klaar(null, stuk);
      },
    });
    if (naar) {
      await pipeline(Readable.fromWeb(antwoord.body), bewaker, createWriteStream(naar));
      return null;
    }
    const delen = [];
    for await (const stuk of Readable.fromWeb(antwoord.body).pipe(bewaker)) delen.push(stuk);
    return Buffer.concat(delen);
  }
  throw new Error('Te veel doorverwijzingen.');
}

export const haalTekstOpenbaar = async (url, opties) => (await haalOpenbaar(url, { maxBytes: 4 * 1024 ** 2, ...opties })).toString('utf8');
export const haalJsonOpenbaar = async (url, opties) => JSON.parse(await haalTekstOpenbaar(url, opties));

// Een programma draaien met een tijdslimiet; geeft stdout, gooit bij een fout.
export function draai(programma, args, { tijd = 240_000 } = {}) {
  return new Promise((klaar, mislukt) => {
    const proces = spawn(programma, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let uit = '';
    let fout = '';
    proces.stdout.on('data', (d) => { uit += d; });
    proces.stderr.on('data', (d) => { fout += d; if (fout.length > 20_000) fout = fout.slice(-10_000); });
    const wekker = setTimeout(() => proces.kill('SIGKILL'), tijd);
    proces.on('error', (e) => {
      clearTimeout(wekker);
      mislukt(new Error(e.code === 'ENOENT' ? `${programma} is niet geïnstalleerd` : e.message));
    });
    proces.on('close', (code, signaal) => {
      clearTimeout(wekker);
      if (code === 0) return klaar(uit);
      // Geen ondertekende media-adressen of paden in de foutmelding.
      const melding = fout.slice(-1500).replace(/https?:\/\/\S+/g, '[URL]').trim();
      return mislukt(new Error(signaal === 'SIGKILL' ? `${programma} duurde te lang` : melding || `${programma} mislukt (code ${code})`));
    });
  });
}

export function ytdlp(args, { map, tijd = 240_000 } = {}) {
  const basis = ['--ignore-config', '--no-warnings', '--js-runtimes', 'node', '--socket-timeout', '30', '--retries', '3'];
  // Lukt YouTube niet zonder inlog ("bevestig dat je geen bot bent"), dan kan een
  // beheerder een cookiesbestand neerzetten; dat gebruiken we dan.
  const koekjes = map && path.join(map, 'youtube-cookies.txt');
  if (koekjes && existsSync(koekjes)) basis.push('--cookies', koekjes);
  return draai(process.env.YTDLP || 'yt-dlp', [...basis, ...args], { tijd });
}

// Eén compacte mono-mp3, uit een bestand of rechtstreeks van een stream.
// Bij een stream (HLS van een raadsvergadering) staat de invoer vast op
// HTTPS zonder doorverwijzingen: ffmpeg mag nergens anders heen dan de bron.
export async function zetOm(bron, doel, { netwerk = false } = {}) {
  const bereik = netwerk ? ['-protocol_whitelist', 'https,tls,tcp,crypto,hls', '-max_redirects', '0', '-user_agent', UA,
    '-reconnect', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '60'] : [];
  await draai(process.env.FFMPEG || 'ffmpeg', ['-nostdin', '-y', '-v', 'error', ...bereik, '-i', bron, '-vn', '-ac', '1', '-ar', '24000', '-b:a', '64k', doel], { tijd: 2 * 3600_000 });
}

// De audio van één aflevering, als mp3 in data/audio/<id>/. `bron`: de
// aflevering met vorm youtube, rss of vergadering; `vergadering(af)` zoekt bij
// een vergadering het actuele media-adres op (src/audio/vergaderingen.mjs).
export async function downloadAudio(af, { map, vergadering, metadata }) {
  const mapAf = path.join(map, 'audio', af.id);
  await mkdir(mapAf, { recursive: true });
  const doel = path.join(mapAf, 'audio.mp3');
  let pad;
  if (af.vorm === 'youtube') {
    const uit = await ytdlp(['--no-playlist', '-f', 'bestaudio/best', '--max-filesize', String(MAX_BYTES), '--write-info-json',
      '-o', path.join(mapAf, 'bron.%(ext)s'), '--print', 'after_move:filepath', af.url], { map, tijd: 2 * 3600_000 });
    const regels = uit.split('\n').map((r) => r.trim()).filter(Boolean);
    if (!regels.length) throw new Error('YouTube leverde geen audiobestand op.');
    pad = regels.at(-1);
    const info = path.join(mapAf, 'bron.info.json');
    if (existsSync(info)) {
      // Het infobestand bevat ondertekende adressen; alleen een paar velden overnemen.
      const i = JSON.parse(await readFile(info, 'utf8'));
      metadata?.({ titel: i.title, auteur: i.channel, duur: i.duration, gepubliceerd: i.upload_date });
      await unlink(info);
    }
  } else {
    let adres = af.mediaUrl;
    let stream = false;
    if (af.vorm === 'vergadering') {
      const r = await vergadering(af);
      adres = r.adres;
      stream = r.stream;
      if (r.velden) metadata?.(r.velden);
    }
    if (!adres) throw new Error('Deze aflevering heeft geen mediabestand.');
    if (stream) {
      await zetOm(await openbaar(adres), doel, { netwerk: true });
      pad = doel;
    } else {
      const deel = path.join(mapAf, 'bron.deel');
      await haalOpenbaar(adres, { naar: deel, maxBytes: MAX_BYTES });
      pad = path.join(mapAf, 'bron.media');
      await rename(deel, pad);
    }
  }
  if (!existsSync(pad) || (await stat(pad)).size === 0) throw new Error('Het gedownloade audiobestand is leeg.');
  if (pad !== doel) {
    await zetOm(pad, doel);
    await rm(pad, { force: true });
  }
  return doel;
}

// De lengte van een audiobestand in seconden (ffprobe), of null.
export async function audioDuur(pad) {
  try {
    const uit = await draai(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', pad], { tijd: 60_000 });
    const s = Number.parseFloat(uit);
    return Number.isFinite(s) && s > 0 ? s : null;
  } catch {
    return null;
  }
}

// Een stuk uit een mp3, zonder opnieuw te coderen (de mp3 heeft een vaste bitrate).
export async function knipAudio(pad, doel, start, lengte) {
  await draai(process.env.FFMPEG || 'ffmpeg', ['-nostdin', '-y', '-v', 'error', '-ss', String(start), '-t', String(lengte), '-i', pad, '-c', 'copy', doel], { tijd: 10 * 60_000 });
}

// Alleen bestanden binnen data/audio weggooien.
export async function gooiAudioWeg(map, pad) {
  if (!pad) return false;
  const wortel = path.resolve(map, 'audio');
  const echt = path.resolve(pad);
  if (!echt.startsWith(wortel + path.sep)) return false;
  await rm(path.dirname(echt), { recursive: true, force: true });
  return true;
}
