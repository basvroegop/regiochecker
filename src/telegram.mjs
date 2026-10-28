// De DVHN-bot: 112-fotografen en andere tipgevers sturen foto's, video's en
// berichten naar een Telegram-bot (1-op-1, of in een groep waar de bot in zit).
// Overgenomen uit de checker (/opt/checker/backend/services/telegram.py), met
// één verschil: de Regiochecker haalt de berichten zelf op (long polling,
// getUpdates) in plaats van een webhook. De site zit achter Authelia; een
// webhook zou een openbare uitzondering vragen.
//
// Elke chat begint als 'wacht'. Pas na goedkeuring bij Beheer › Telegram (of
// vooraf, op @gebruikersnaam of id) worden berichten stukken onder het
// tabblad Ingezonden, met de foto's en video's in data/ingezonden/. Een album
// (meerdere foto's tegelijk) wordt één stuk. De regio volgt uit een gedeelde
// locatie of een plaatsnaam in het bericht; zonder plaats gaat een inzending
// naar alle regio's (src/feed.mjs, `overalZonderPlek`).
//
// Het bottoken (via @BotFather) staat in Beheer › Telegram of in
// TELEGRAM_BOT_TOKEN, en gaat nooit terug naar de browser.

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fetch } from 'undici';
import { controleerUrl, openbaarDispatcher } from './netwerk.mjs';

const API = process.env.TELEGRAM_API || 'https://api.telegram.org';
export const BRON_ID = 'telegram';
const PEIL_S = 50;
const MAX_BESTAND = 20 * 1024 * 1024; // meer geeft de Bot API niet
const BEGROETING = 'Bedankt! Je bericht is ontvangen. Een redacteur moet deze chat eerst goedkeuren voordat inzendingen worden verwerkt.';
const slaap = (ms, signaal) => new Promise((klaar) => {
  const t = setTimeout(klaar, ms);
  signaal?.addEventListener('abort', () => { clearTimeout(t); klaar(); }, { once: true });
});

export const tokenVan = (opslag) => opslag.instellingen.telegram?.token || process.env.TELEGRAM_BOT_TOKEN || '';

// ---------- de Bot API ----------

class TelegramFout extends Error {
  constructor(bericht, code) { super(bericht); this.code = code; }
}

// Het token staat in het adres: dat hoort nooit in een foutmelding.
async function roep(token, methode, params = {}, { signaal, tijd = 20_000 } = {}) {
  const url = `${API}/bot${token}/${methode}`;
  let antwoord;
  try {
    controleerUrl(url);
    antwoord = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      dispatcher: openbaarDispatcher,
      signal: signaal ? AbortSignal.any([signaal, AbortSignal.timeout(tijd)]) : AbortSignal.timeout(tijd),
    });
  } catch (fout) {
    if (signaal?.aborted) throw new TelegramFout('gestopt', 'gestopt');
    throw new TelegramFout(`Telegram niet bereikbaar (${fout.cause?.code || fout.name})`, 'netwerk');
  }
  const data = await antwoord.json().catch(() => ({}));
  if (!data.ok) throw new TelegramFout(`Telegram: ${data.description || `HTTP ${antwoord.status}`}`, data.error_code || antwoord.status);
  return data.result;
}

async function download(token, filePath) {
  const url = `${API}/file/bot${token}/${filePath}`;
  controleerUrl(url);
  const antwoord = await fetch(url, { dispatcher: openbaarDispatcher, signal: AbortSignal.timeout(120_000) });
  if (!antwoord.ok) throw new TelegramFout(`Bestand ophalen gaf HTTP ${antwoord.status}`, antwoord.status);
  const buffer = Buffer.from(await antwoord.arrayBuffer());
  if (buffer.length > MAX_BESTAND) throw new TelegramFout('Bestand te groot', 413);
  return buffer;
}

// ---------- berichten lezen ----------

const naamVan = (van = {}) => [van.first_name, van.last_name].filter(Boolean).join(' ').trim() || van.username || 'onbekend';
const chatNaam = (chat = {}) => chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ').trim() || chat.username || null;
const veiligeNaam = (naam) => String(naam || 'bestand').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-80) || 'bestand';
const SOORT_VAN = (mime) => (/^image\//.test(mime || '') ? 'foto' : /^video\//.test(mime || '') ? 'video' : null);

// [{ fileId, naam, soort }] uit een bericht: de grootste foto, een afbeelding
// of video als document, een video.
export function mediaIn(bericht) {
  const uit = [];
  const fotos = bericht.photo || [];
  if (fotos.length) {
    const grootste = fotos.reduce((a, b) => ((b.file_size || b.width || 0) > (a.file_size || a.width || 0) ? b : a));
    uit.push({ fileId: grootste.file_id, naam: null, soort: 'foto' });
  }
  if (bericht.document && SOORT_VAN(bericht.document.mime_type)) {
    uit.push({ fileId: bericht.document.file_id, naam: bericht.document.file_name, soort: SOORT_VAN(bericht.document.mime_type) });
  }
  if (bericht.video) uit.push({ fileId: bericht.video.file_id, naam: bericht.video.file_name, soort: 'video' });
  return uit.filter((m) => m.fileId);
}

// De kop van een inzending: de eerste regel van het bericht, of wat er is.
export function inzendingTitel(tekst, media, afzender) {
  const regel = String(tekst || '').split('\n').map((r) => r.trim()).find(Boolean);
  if (regel) return regel.length > 110 ? `${regel.slice(0, 109).replace(/\s+\S*$/, '')}…` : regel;
  const fotos = media.filter((m) => m.soort === 'foto').length;
  const videos = media.length - fotos;
  const wat = fotos && videos ? "Foto's en video" : fotos > 1 ? "Foto's" : fotos ? 'Foto' : videos > 1 ? "Video's" : videos ? 'Video' : 'Locatie';
  return `${wat} van ${afzender}`;
}

// Mag deze chat of afzender vooraf (op @gebruikersnaam of id)?
export function vooraf(tg, chat, van = {}) {
  const namen = new Set([chat.username, van.username].filter(Boolean).map((n) => n.toLowerCase()));
  const ids = new Set([chat.id, van.id].filter((i) => i !== undefined && i !== null).map(String));
  return (tg.vooraf || []).some((h) => (/^-?\d+$/.test(h) ? ids.has(h) : namen.has(h)));
}

export function schoneHandle(invoer) {
  const h = String(invoer || '').trim().replace(/^@/, '');
  if (/^-?\d{3,20}$/.test(h)) return h;
  if (/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(h)) return h.toLowerCase();
  return null;
}

// ---------- de bot ----------

export class TelegramBot {
  constructor(opslag, { bijNieuw } = {}) {
    this.opslag = opslag;
    this.bijNieuw = bijNieuw;
    this.status = { staat: 'uit', fout: null, bot: null, tijd: null };
    this.lus = null;
    this.stopper = null;
  }

  get tg() {
    return this.opslag.telegram;
  }

  get mediaMap() {
    return path.join(this.opslag.map, 'ingezonden');
  }

  start() {
    if (this.lus) return;
    this.stopper = new AbortController();
    const signaal = this.stopper.signal;
    this.lus = (async () => {
      while (!signaal.aborted) {
        const token = tokenVan(this.opslag);
        if (!token) {
          this.status = { staat: 'uit', fout: null, bot: null, tijd: null };
          await slaap(60_000, signaal);
          continue;
        }
        try {
          await this.peil(token, signaal);
        } catch (fout) {
          if (fout.code === 'gestopt') break;
          // 401: verkeerd token; 409: een webhook of een andere server gebruikt deze bot al.
          const uitleg = fout.code === 401 ? 'Het bottoken klopt niet.'
            : fout.code === 409 ? 'Deze bot wordt al ergens anders gebruikt (een webhook of een tweede server). Haal hem daar weg.'
              : fout.message;
          if (this.status.fout !== uitleg) this.opslag.log({ soort: 'bronfout', tekst: `Telegram: ${uitleg}` });
          // Bij de volgende poging opnieuw nagaan wie de bot is en of er een webhook staat.
          this.status = { staat: 'fout', fout: uitleg, bot: null, tijd: new Date().toISOString() };
          this.zetBronStatus(false, uitleg);
          await slaap(fout.code === 401 || fout.code === 409 ? 5 * 60_000 : 30_000, signaal);
        }
      }
    })().finally(() => { this.lus = null; });
  }

  async stop() {
    this.stopper?.abort();
    await this.lus;
  }

  async herstart() {
    await this.stop();
    this.start();
  }

  zetBronStatus(ok, fout = null) {
    const s = this.opslag.status.bronnen;
    const nu = new Date().toISOString();
    s[BRON_ID] = { ...s[BRON_ID], ok, fout, laatsteRonde: nu, ...(ok ? { laatsteSucces: nu } : {}) };
  }

  // Wie is de bot, staat er geen webhook, en dan berichten ophalen tot er een
  // fout is of de bot stopt (of, met `eenKeer`, één keer).
  async peil(token, signaal, { eenKeer = false } = {}) {
    if (!this.status.bot || this.status.token !== token) {
      const ik = await roep(token, 'getMe', {}, { signaal });
      const haak = await roep(token, 'getWebhookInfo', {}, { signaal });
      if (haak.url) throw new TelegramFout('webhook', 409);
      this.status = { staat: 'aan', fout: null, bot: ik.username, token, tijd: new Date().toISOString() };
    }
    do {
      const updates = await roep(token, 'getUpdates', {
        offset: this.tg.offset || 0, timeout: PEIL_S, allowed_updates: ['message', 'edited_message', 'channel_post'],
      }, { signaal, tijd: (PEIL_S + 15) * 1000 });
      let nieuw = 0;
      for (const update of updates) {
        try {
          if (await this.verwerkUpdate(token, update)) nieuw++;
        } catch (fout) {
          console.error('Telegram: bericht niet verwerkt:', fout.message);
        }
        this.tg.offset = update.update_id + 1;
      }
      this.status = { ...this.status, staat: 'aan', fout: null, tijd: new Date().toISOString() };
      this.zetBronStatus(true);
      this.opslag.bewaar(...(updates.length ? ['telegram', 'items', 'status'] : ['status']));
      if (nieuw) this.bijNieuw?.();
    } while (!eenKeer && !signaal.aborted);
  }

  stuur(token, chatId, tekst, extra = {}) {
    return roep(token, 'sendMessage', { chat_id: chatId, text: tekst, ...extra }).catch(() => {});
  }

  // Geeft true als er een stuk bij kwam of veranderde.
  async verwerkUpdate(token, update) {
    const bericht = update.message || update.channel_post || update.edited_message;
    const chat = bericht?.chat;
    if (!chat?.id) return false;
    const tg = this.tg;
    const chatId = String(chat.id);
    const nu = new Date().toISOString();
    const c = tg.chats[chatId] ||= { status: 'wacht', eerst: nu, aantal: 0, begroet: false };
    Object.assign(c, { type: chat.type, naam: chatNaam(chat), username: chat.username || null, laatst: nu, aantal: (c.aantal || 0) + 1 });
    const van = bericht.from || {};
    if (van.id) {
      const a = tg.afzenders[String(van.id)] ||= {};
      Object.assign(a, { naam: naamVan(van), username: van.username || a.username || null });
    }

    // Een gedeeld eigen contact: het telefoonnummer, zodat de redactie kan terugbellen.
    if (bericht.contact?.phone_number && String(bericht.contact.user_id) === String(van.id)) {
      tg.afzenders[String(van.id)].telefoon = bericht.contact.phone_number;
      if (c.status !== 'geblokkeerd') this.stuur(token, chatId, 'Bedankt, je telefoonnummer is opgeslagen bij de redactie.', { reply_markup: { remove_keyboard: true } });
      return false;
    }
    if (c.status === 'geblokkeerd') return false;
    if (c.status !== 'goedgekeurd' && vooraf(tg, chat, van)) c.status = 'goedgekeurd';
    if (c.status !== 'goedgekeurd') {
      if (!c.begroet) {
        c.begroet = true;
        const prive = chat.type === 'private';
        this.stuur(token, chatId, prive ? `${BEGROETING}\n\nDeel eventueel je telefoonnummer, dan kan de redactie je bereiken.` : BEGROETING, prive
          ? { reply_markup: { keyboard: [[{ text: 'Deel mijn telefoonnummer', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } }
          : {});
      }
      return false;
    }

    const tekst = String(bericht.caption || bericht.text || '').trim();
    if (tekst.startsWith('/')) return false; // opdrachten aan de bot
    const media = mediaIn(bericht);
    const locatie = bericht.location;
    if (!tekst && !media.length && !locatie) return false;

    // Een album komt als losse berichten met hetzelfde media_group_id: één stuk.
    const sleutel = `${BRON_ID}:${chatId}:${bericht.media_group_id ? `album-${bericht.media_group_id}` : bericht.message_id}`;
    const items = this.opslag.items;
    const bestaand = items[sleutel];
    // Een aangepast bijschrift: alleen de tekst bijwerken.
    if (update.edited_message && bestaand) {
      if (!tekst) return false;
      Object.assign(bestaand, { tekst, titel: inzendingTitel(tekst, bestaand.media || [], bestaand.inzender?.naam || 'onbekend'), laatstGezien: nu });
      return true;
    }
    if (bestaand?.berichten?.includes(bericht.message_id)) return false; // al binnen

    const opgeslagen = [];
    const uid = bestaand?.mediaUid || randomBytes(16).toString('hex');
    for (const m of media) {
      try {
        const bestand = await roep(token, 'getFile', { file_id: m.fileId });
        if (!bestand.file_path || (bestand.file_size || 0) > MAX_BESTAND) continue;
        const data = await download(token, bestand.file_path);
        const naam = `${String(bericht.message_id)}-${veiligeNaam(m.naam || path.basename(bestand.file_path))}`;
        mkdirSync(path.join(this.mediaMap, uid), { recursive: true });
        writeFileSync(path.join(this.mediaMap, uid, naam), data);
        opgeslagen.push({ soort: m.soort, pad: `${uid}/${naam}`, grootte: data.length });
      } catch (fout) {
        console.error('Telegram: bestand niet opgehaald:', fout.message);
      }
    }

    const afzender = tg.afzenders[String(van.id)] || {};
    const groep = ['group', 'supergroup', 'channel'].includes(chat.type);
    const inzender = {
      naam: van.id ? naamVan(van) : c.naam, username: afzender.username || null, telefoon: afzender.telefoon || null,
      ...(groep ? { groep: c.naam } : {}),
    };
    const plek = locatie ? { lat: locatie.latitude, lon: locatie.longitude, naam: 'de gedeelde locatie' } : null;
    if (bestaand) {
      // Het volgende bericht van een album; het bijschrift staat soms bij een latere foto.
      const alleMedia = [...(bestaand.media || []), ...opgeslagen];
      const nieuweTekst = bestaand.tekst || tekst || null;
      Object.assign(bestaand, {
        media: alleMedia,
        mediaUid: bestaand.mediaUid || (opgeslagen.length ? uid : null),
        tekst: nieuweTekst,
        titel: inzendingTitel(nieuweTekst, alleMedia, inzender.naam),
        berichten: [...new Set([...(bestaand.berichten || []), bericht.message_id])],
        laatstGezien: nu,
        ...(plek ? { plek } : {}),
      });
      return true;
    }
    items[sleutel] = {
      sleutel, bron: BRON_ID, regio: null, soort: 'ingezonden',
      titel: inzendingTitel(tekst, opgeslagen, inzender.naam), url: null,
      datum: new Date((bericht.date || Date.now() / 1000) * 1000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }),
      tekst: tekst || null, afzender: groep ? `${inzender.naam} in ${c.naam}` : inzender.naam,
      inzender, media: opgeslagen, mediaUid: opgeslagen.length ? uid : null, berichten: [bericht.message_id],
      telegram: { chat: chatId, bericht: bericht.message_id },
      ...(plek ? { plek } : {}),
      eersteGezien: nu, laatstGezien: nu, basislijn: false,
    };
    // Een duim omhoog: de inzending is binnen.
    if (this.opslag.instellingen.telegram?.reageren !== false) {
      roep(token, 'setMessageReaction', { chat_id: chat.id, message_id: bericht.message_id, reaction: [{ type: 'emoji', emoji: '👍' }] }).catch(() => {});
    }
    return true;
  }
}

// De foto's en video's van een stuk dat wordt opgeruimd (src/verzamel.mjs).
export function gooiMediaWeg(map, item) {
  if (/^[a-f0-9]{32}$/.test(item.mediaUid || '')) rmSync(path.join(map, 'ingezonden', item.mediaUid), { recursive: true, force: true });
}

export function telegramVoorClient(opslag, bot) {
  const tg = opslag.telegram;
  return {
    token: Boolean(opslag.instellingen.telegram?.token || process.env.TELEGRAM_BOT_TOKEN),
    tokenUitOmgeving: !opslag.instellingen.telegram?.token && Boolean(process.env.TELEGRAM_BOT_TOKEN),
    reageren: opslag.instellingen.telegram?.reageren !== false,
    status: { staat: bot?.status.staat || 'uit', fout: bot?.status.fout || null, bot: bot?.status.bot || null, tijd: bot?.status.tijd || null },
    vooraf: tg.vooraf || [],
    chats: Object.entries(tg.chats || {}).map(([id, c]) => ({ id, ...c })).sort((a, b) => String(b.laatst).localeCompare(String(a.laatst))),
  };
}
