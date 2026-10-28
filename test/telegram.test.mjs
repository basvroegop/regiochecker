// De Telegram-bot voor tipgevers (src/telegram.mjs), tegen een nagebootste
// Bot API: goedkeuren, telefoonnummer delen, foto's en albums, de regio uit
// een plaatsnaam of locatie (en anders alle regio's), het leespaneel, de
// foto's achter de inlog, de Teams-kaart, en het ophalen zelf (long polling).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MockAgent } from 'undici';
import { Opslag } from '../src/opslag.mjs';
import { herken } from '../src/gebruikers.mjs';
import { zetOpenbaarDispatcher } from '../src/netwerk.mjs';
import { TelegramBot, inzendingTitel, schoneHandle } from '../src/telegram.mjs';
import { maakKader, routeerItem, detail, kanaalRegels } from '../src/feed.mjs';
import { stukKaart } from '../src/kanalen.mjs';
import { bronStatus } from '../src/beheer.mjs';
import { alleBronnen } from '../src/register.mjs';
import { roep } from './api-hulp.mjs';

const TOKEN = '123456789:AAEhBP0av28HtRnXzmBVcT1NoLrGuF5_xyz';
const FOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function nepTelegram({ webhook = '' } = {}) {
  const nep = new MockAgent();
  nep.disableNetConnect();
  const verzoeken = [];
  const staat = { updates: [], naUpdates: null };
  nep.get('https://api.telegram.org').intercept({ path: () => true, method: () => true }).reply(({ path: pad, body }) => {
    const ok = (result) => ({ statusCode: 200, data: JSON.stringify({ ok: true, result }), responseOptions: { headers: { 'content-type': 'application/json' } } });
    if (pad.startsWith(`/file/bot${TOKEN}/`)) {
      verzoeken.push({ methode: 'file', pad });
      return { statusCode: 200, data: FOTO };
    }
    if (!pad.startsWith(`/bot${TOKEN}/`)) return { statusCode: 401, data: JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }) };
    const methode = pad.split('/').pop();
    const params = body ? JSON.parse(body) : {};
    verzoeken.push({ methode, params });
    if (methode === 'getMe') return ok({ id: 1, is_bot: true, username: 'proef_bot' });
    if (methode === 'getWebhookInfo') return ok({ url: webhook });
    if (methode === 'getFile') return ok({ file_id: params.file_id, file_size: FOTO.length, file_path: `photos/${params.file_id}.jpg` });
    if (methode === 'getUpdates') {
      const uit = staat.updates.filter((u) => u.update_id >= (params.offset || 0));
      staat.updates = [];
      if (!uit.length) staat.naUpdates?.();
      return ok(uit);
    }
    return ok(true);
  }).persist();
  const vorige = zetOpenbaarDispatcher(nep);
  return { verzoeken, staat, herstel: () => zetOpenbaarDispatcher(vorige) };
}

const prive = { id: 501, type: 'private', first_name: 'Jan', last_name: 'de Vries', username: 'fotojan' };
const van = { id: 501, is_bot: false, first_name: 'Jan', last_name: 'de Vries', username: 'FotoJan' };
let nr = 100;
const bericht = (velden, chat = prive) => ({ update_id: ++nr, message: { message_id: nr, date: 1793210000, chat, from: van, ...velden } });
const foto = (id) => [{ file_id: `${id}-klein`, width: 90, file_size: 10 }, { file_id: id, width: 1280, file_size: 900 }];

test('Telegram: goedkeuren, foto\'s en albums, de regio, en de foto\'s achter de inlog', async () => {
  const opslag = new Opslag(mkdtempSync(path.join(tmpdir(), 'rc-telegram-')));
  const jan = herken(opslag, { login: 'jan', email: 'jan@example.nl', naam: 'Jan' });
  opslag.instellingen.telegram = { token: TOKEN };
  const bot = new TelegramBot(opslag);
  const ctx = { opslag, kdb: null, fdb: null, telegram: bot };
  const tg = nepTelegram();
  try {
    // Een nieuwe chat wacht: een begroeting met de knop voor het telefoonnummer, nog geen stuk.
    assert.equal(await bot.verwerkUpdate(TOKEN, bericht({ text: 'Hallo, ik heb foto\'s van een brand' })), false);
    assert.equal(opslag.telegram.chats['501'].status, 'wacht');
    const begroeting = tg.verzoeken.find((v) => v.methode === 'sendMessage');
    assert.match(begroeting.params.text, /eerst goedkeuren/);
    assert.equal(begroeting.params.reply_markup.keyboard[0][0].request_contact, true);
    await bot.verwerkUpdate(TOKEN, bericht({ text: 'Nog een' }));
    assert.equal(tg.verzoeken.filter((v) => v.methode === 'sendMessage').length, 1, 'één keer begroeten');
    // Zijn eigen contact: het telefoonnummer.
    await bot.verwerkUpdate(TOKEN, bericht({ contact: { phone_number: '+31612345678', user_id: 501, first_name: 'Jan' } }));
    assert.equal(opslag.telegram.afzenders['501'].telefoon, '+31612345678');
    assert.equal(Object.keys(opslag.items).length, 0);

    // Beheer: de chat goedkeuren.
    let r = await roep(ctx, jan, 'GET', '/api/beheer/telegram');
    assert.deepEqual([r.data.token, r.data.chats.map((c) => [c.id, c.status, c.naam])], [true, [['501', 'wacht', 'Jan de Vries']]]);
    assert.ok(!JSON.stringify(r.data).includes(TOKEN.split(':')[1]), 'het token gaat niet naar de browser');
    r = await roep(ctx, jan, 'PUT', '/api/beheer/telegram/chats/501', { status: 'goedgekeurd' });
    assert.equal(r.data.chats[0].status, 'goedgekeurd');

    // Een foto met bijschrift: een stuk, met de grootste foto, en een duim omhoog.
    assert.equal(await bot.verwerkUpdate(TOKEN, bericht({ photo: foto('f1'), caption: 'Brand in een schuur in Gorredijk\nBrandweer is ter plaatse.' })), true);
    const sleutel = `telegram:501:${nr}`;
    const stuk = opslag.items[sleutel];
    assert.deepEqual([stuk.titel, stuk.soort, stuk.afzender, stuk.inzender.telefoon, stuk.inzender.username], ['Brand in een schuur in Gorredijk', 'ingezonden', 'Jan de Vries', '+31612345678', 'FotoJan']);
    assert.equal(stuk.media.length, 1);
    assert.ok(existsSync(path.join(opslag.map, 'ingezonden', stuk.media[0].pad)));
    assert.ok(tg.verzoeken.some((v) => v.methode === 'getFile' && v.params.file_id === 'f1'), 'de grootste foto');
    assert.deepEqual(tg.verzoeken.find((v) => v.methode === 'setMessageReaction').params.reaction, [{ type: 'emoji', emoji: '👍' }]);
    // Dezelfde update nog eens (Telegram probeert opnieuw): niets dubbel.
    assert.equal(await bot.verwerkUpdate(TOKEN, { update_id: 999, message: { message_id: nr, date: 1, chat: prive, from: van, photo: foto('f1') } }), false);

    const k = () => maakKader({ opslag });
    const telegramBron = alleBronnen(opslag).find((b) => b.id === 'telegram');
    const route = (s) => routeerItem(k(), opslag.items[s], telegramBron).map((x) => x.regio).sort();
    assert.deepEqual(route(sleutel), ['opsterland'], 'de plaatsnaam in het bijschrift');

    // Een album: twee berichten, één stuk; het bijschrift staat bij de tweede foto.
    await bot.verwerkUpdate(TOKEN, bericht({ photo: foto('a1'), media_group_id: 'G7' }));
    await bot.verwerkUpdate(TOKEN, bericht({ photo: foto('a2'), media_group_id: 'G7', caption: 'Ongeval op de A7' }));
    const album = opslag.items['telegram:501:album-G7'];
    assert.deepEqual([album.media.length, album.titel, album.berichten.length], [2, 'Ongeval op de A7', 2]);
    // Geen plaats bekend: bij alle regio's, met uitleg.
    assert.equal(route('telegram:501:album-G7').length, 7);
    const waarom = routeerItem(k(), album, telegramBron)[0].gevonden[0];
    assert.match(waarom.fragment.tekst, /noemt geen plaats/);

    // Een gedeelde locatie bepaalt de regio.
    await bot.verwerkUpdate(TOKEN, bericht({ location: { latitude: 52.9563, longitude: 5.9221 } }));
    const locatie = opslag.items[`telegram:501:${nr}`];
    assert.equal(locatie.titel, 'Locatie van Jan de Vries');
    assert.deepEqual(route(`telegram:501:${nr}`), ['heerenveen']);

    // Een aangepast bijschrift.
    await bot.verwerkUpdate(TOKEN, { update_id: ++nr, edited_message: { message_id: Number(sleutel.split(':')[2]), date: 1, chat: prive, from: van, caption: 'Grote brand in Gorredijk' } });
    assert.equal(opslag.items[sleutel].titel, 'Grote brand in Gorredijk');
    assert.equal(opslag.items[sleutel].media.length, 1, 'de foto niet nog eens');

    // Een groep die vooraf is goedgekeurd: meteen binnen, met de groep erbij.
    r = await roep(ctx, jan, 'POST', '/api/beheer/telegram/vooraf', { handle: 'x' });
    assert.equal(r.status, 400);
    r = await roep(ctx, jan, 'POST', '/api/beheer/telegram/vooraf', { handle: '-100777' });
    assert.deepEqual(r.data.vooraf, ['-100777']);
    const groep = { id: -100777, type: 'supergroup', title: '112 Friesland' };
    await bot.verwerkUpdate(TOKEN, bericht({ text: 'Aanrijding in Wolvega, twee auto\'s' }, groep));
    const inGroep = opslag.items[`telegram:-100777:${nr}`];
    assert.deepEqual([inGroep.afzender, opslag.telegram.chats['-100777'].status], ['Jan de Vries in 112 Friesland', 'goedgekeurd']);
    assert.deepEqual(route(`telegram:-100777:${nr}`), ['weststellingwerf']);

    // Geblokkeerd: niets meer.
    await roep(ctx, jan, 'PUT', '/api/beheer/telegram/chats/-100777', { status: 'geblokkeerd' });
    assert.equal(await bot.verwerkUpdate(TOKEN, bericht({ text: 'Nog iets in Wolvega' }, groep)), false);

    // In het leespaneel: de foto's, en hoe je de inzender bereikt.
    const d = detail(k(), jan, `i:${sleutel}`);
    assert.equal(d.soortNaam, 'Inzending');
    assert.deepEqual(d.media.map((m) => m.soort), ['foto']);
    assert.ok(d.meta.some((m) => m.k === 'Telefoon' && m.v === '+31612345678'));
    assert.ok(d.meta.some((m) => m.k === 'Telegram' && m.v === '@FotoJan'));
    // De foto zelf: alleen via de API (dus achter de inlog), en alleen bestanden uit de map.
    r = await roep(ctx, jan, 'GET', d.media[0].url);
    assert.equal(r.status, 200);
    assert.equal(r.kop['Content-Type'], 'image/jpeg');
    assert.deepEqual(r.data, FOTO);
    assert.equal((await roep(ctx, jan, 'GET', '/api/ingezonden/..%2F..%2Fgebruikers.json/x')).status, 400);
    assert.equal((await roep(ctx, jan, 'GET', `/api/ingezonden/${'a'.repeat(32)}/.htaccess`)).status, 400);

    // Op een Teams-kaart: inzender, telefoon en wat er bij zit; de foto zelf niet.
    const [regel] = kanaalRegels(k(), { regios: ['opsterland'], soorten: ['ingezonden'], bronnen: [] }, { sinds: '2000-01-01T00:00:00Z', tot: '2100-01-01T00:00:00Z' });
    const feiten = stukKaart(k(), regel).attachments[0].content.body.find((b) => b.type === 'FactSet').facts;
    assert.deepEqual(feiten.filter((f) => ['Inzender', 'Telefoon', 'Bij de inzending'].includes(f.title)).map((f) => f.value), ['Jan de Vries', '+31612345678', '1 foto']);
  } finally {
    tg.herstel();
  }
});

test('Telegram: ophalen met long polling, status bij Bronnen, en een bot die elders in gebruik is', async () => {
  assert.equal(inzendingTitel('', [{ soort: 'foto' }, { soort: 'foto' }], 'Jan'), "Foto's van Jan");
  assert.equal(inzendingTitel('', [{ soort: 'video' }], 'Jan'), 'Video van Jan');
  assert.deepEqual(['@FotoJan', '-100123', 'ab', '@x y'].map(schoneHandle), ['fotojan', '-100123', null, null]);

  const opslag = new Opslag(mkdtempSync(path.join(tmpdir(), 'rc-telegram-')));
  const bron = alleBronnen(opslag).find((b) => b.id === 'telegram');
  assert.equal(bronStatus(opslag, bron).tekst, 'Niet ingesteld');
  opslag.instellingen.telegram = { token: TOKEN };
  opslag.telegram.vooraf = ['fotojan'];
  const bot = new TelegramBot(opslag);
  const tg = nepTelegram();
  try {
    tg.staat.updates = [bericht({ text: 'Rookontwikkeling bij een bedrijf in Drachten' })];
    await bot.peil(TOKEN, new AbortController().signal, { eenKeer: true });
    assert.equal(opslag.telegram.offset, nr + 1, 'de volgende keer vanaf de volgende update');
    assert.equal(bot.status.bot, 'proef_bot');
    assert.ok(Object.values(opslag.items).some((i) => i.titel === 'Rookontwikkeling bij een bedrijf in Drachten'));
    assert.equal(bronStatus(opslag, bron).staat, 'werkt');
  } finally {
    tg.herstel();
  }

  // Een webhook bij deze bot: niet overnemen, maar melden.
  const bot2 = new TelegramBot(opslag);
  const tg2 = nepTelegram({ webhook: 'https://elders.example/haak' });
  try {
    bot2.start();
    for (let i = 0; i < 50 && bot2.status.staat !== 'fout'; i++) await new Promise((r) => setTimeout(r, 10));
    assert.match(bot2.status.fout, /al ergens anders gebruikt/);
    assert.ok(!tg2.verzoeken.some((v) => v.methode === 'deleteWebhook'));
    await bot2.stop();
    assert.ok(opslag.logboek.some((l) => /Telegram: Deze bot wordt al ergens anders gebruikt/.test(l.tekst)));
  } finally {
    tg2.herstel();
  }
});
