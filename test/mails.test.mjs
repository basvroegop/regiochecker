// De mails in de huisstijl van de website (src/mailstijl.mjs): de meldingsmail
// met de tekst van het stuk, en de weekmail met weeknummer en tellers. De
// inhoud en de volgorde testen samenvatting-en-mail, kamer en feed al; hier wat
// er met het nieuwe ontwerp bij kwam.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stijl, markeerTermen, fragmentHtml } from '../src/mailstijl.mjs';
import { stelMeldingSamen, documentVoorMail } from '../src/meldingen.mjs';
import { stelMailSamen, isoWeek } from '../src/mail.mjs';
import { Opslag } from '../src/opslag.mjs';
import { herken } from '../src/gebruikers.mjs';
import { roep } from './api-hulp.mjs';

const melding = (velden = {}) => ({ id: 'm1', termen: ['huisartsenpost'], bereik: 'mijn', bronnen: 'alle', frequentie: 'direct', tijd: '17:00', ...velden });
const kamerTreffer = (velden = {}) => ({
  id: 'k:doc1', soort: 'kamerstuk', titel: 'Kamervragen over de nachtdienst van de huisartsenpost in Drachten', regios: ['smallingerland'], regioNaam: 'Smallingerland',
  tijd: '2026-10-28T08:00:00.000Z', datum: '2026-10-27', bron: 'tweede-kamer', bronNaam: 'Tweede Kamer', url: 'https://www.tweedekamer.nl/x',
  stuk: { id: 'doc1', nr: 1, soort: 'Schriftelijke vragen', nummer: '2026D1', afzender: 'lid Van der Meer', datum: '2026-10-27' },
  gevonden: [{ term: 'huisartsenpost', fragment: { tekst: '…sluit de huisartsenpost in Drachten ’s nachts…', treffer: 'huisartsenpost' } }],
  ...velden,
});

test('mails: één melding heeft "{term}: {titel}", voorbeeldtekst, documenttekst en knoppen', () => {
  process.env.REGIOCHECKER_SITE_URL = 'https://checker.example.nl';
  try {
    const t = kamerTreffer();
    const documenten = new Map([[t.id, { kop: 'Documenttekst', meta: '120 woorden · datum stuk 27 okt 2026', alineas: [{ soort: 'p', tekst: 'Bent u bekend met het sluiten van de Huisartsenpost?' }], getoond: 120, totaal: 120, deel: false }]]);
    const mail = stelMeldingSamen(melding(), [t], new Date('2026-10-28T08:42:00Z'), { regioNaam: () => 'Smallingerland', titel: 'DVHN', documenten });
    assert.equal(mail.onderwerp, 'huisartsenpost: Kamervragen over de nachtdienst van de huisartsenpost in Drachten');
    // Verborgen voorbeeldtekst: bron, regio en het fragment.
    assert.match(mail.html, /<div style="display:none[^>]*>Tweede Kamer · Smallingerland · “…sluit de huisartsenpost in Drachten ’s nachts…”/);
    assert.match(mail.html, /Melding · wo 28 okt 09:42/);
    assert.match(mail.html, /Een nieuw stuk bevat je zoekterm <strong[^>]*>huisartsenpost<\/strong>\./);
    assert.match(mail.html, /Tweede Kamer · Schriftelijke vragen · 2026D1 · lid Van der Meer/);
    // DVHN-blauw: het blokje, de knop, het fragmentvlak en de markeringen.
    assert.match(mail.html, /bgcolor="#006ED1"/);
    assert.match(mail.html, /background:#ebf4fc;border:2px solid #b2d2f1/);
    assert.match(mail.html, /<span style="background:#00519d;color:#ffffff;[^"]*">huisartsenpost<\/span>/, 'in het fragment donker');
    assert.match(mail.html, /<span style="background:#d9e9f8;color:#201e1d;[^"]*">Huisartsenpost<\/span>/, 'in de lopende tekst licht, ook met hoofdletter');
    assert.ok(!mail.html.includes('#482AA5'), 'geen LC-paars in een DVHN-mail');
    assert.match(mail.html, /href="https:\/\/checker\.example\.nl\/#\/feed\?stuk=k%3Adoc1"[^>]*>Openen in Regiochecker/);
    assert.match(mail.html, /href="https:\/\/www\.tweedekamer\.nl\/x"[^>]*>Bij de Tweede Kamer/);
    assert.match(mail.html, /een directe melding hebt op ‘huisartsenpost’ in je regio’s\./);
    assert.match(mail.html, /Melding aanpassen<\/a> · <a[^>]*>Alle meldingen uitzetten/);
    // Tabellen, geen flexbox; lichte kleuren afgedwongen.
    assert.ok(!/display:\s*(flex|grid)/.test(mail.html));
    assert.match(mail.html, /<meta name="color-scheme" content="light">/);
    // De tekstversie heeft dezelfde inhoud.
    assert.match(mail.tekst, /Een nieuw stuk bevat je zoekterm huisartsenpost\./);
    assert.match(mail.tekst, /\n {4}Bent u bekend met het sluiten van de Huisartsenpost\?/);
    assert.match(mail.tekst, /Openen in Regiochecker: https:\/\/checker\.example\.nl\/#\/feed\?stuk=k%3Adoc1/);
  } finally {
    delete process.env.REGIOCHECKER_SITE_URL;
  }
});

test('mails: meer stukken: per groep een kop, het oude onderwerp, en de tekst alleen tot drie stukken', () => {
  const treffers = [kamerTreffer(), kamerTreffer({ id: 'k:doc2', titel: 'Tweede stuk' }), {
    ...kamerTreffer({ id: 'i:smallingerland-nieuws:a', soort: 'nieuws', bron: 'smallingerland-nieuws', bronNaam: 'Smallingerland · Nieuws', url: 'https://x/a' }), stuk: undefined,
  }];
  const mail = stelMeldingSamen(melding(), treffers, new Date('2026-10-28T08:42:00Z'), { regioNaam: () => null });
  assert.match(mail.onderwerp, /^Melding: 3 nieuwe stukken met huisartsenpost \(wo 28 okt\)$/);
  assert.match(mail.html, /<h3[^>]*>Kamerstukken<\/h3>/);
  assert.match(mail.html, /<h3[^>]*>Websites van gemeenten en andere bronnen<\/h3>/);
  assert.match(mail.html, /Bij Smallingerland<\/a>/);
  assert.ok(!mail.html.includes('Documenttekst'), 'zonder documenten geen lege kop');
});

test('mails: de tekst van een stuk, rond de eerste vondst als die ver weg staat', () => {
  const vulling = Array.from({ length: 30 }, (_, i) => `Alinea ${i} met ${'woorden '.repeat(40)}`.trim());
  const tekst = [...vulling, 'Nu over de huisartsenpost in Drachten.', 'En een slotalinea.', 'Een kop zonder tekst'].join('\n\n');
  const k = { kdb: { tekst: () => tekst }, opslag: { items: {} } };
  const d = documentVoorMail(k, kamerTreffer(), ['huisartsenpost']);
  assert.equal(d.halverwege, true);
  assert.match(d.alineas[0].tekst, /^Alinea 29/, 'één alinea vóór de vondst');
  assert.match(d.alineas[1].tekst, /huisartsenpost/);
  assert.equal(d.deel, true);
  assert.ok(d.getoond <= 600 && d.totaal > 1000);
  // Zonder zoekterm (of met een vondst vooraan): gewoon het begin.
  assert.equal(documentVoorMail(k, kamerTreffer(), []).halverwege, false);
  assert.match(documentVoorMail(k, kamerTreffer(), []).alineas[0].tekst, /^Alinea 0/);
  // Geen tekst: geen blok.
  assert.equal(documentVoorMail({ kdb: { tekst: () => '' }, opslag: { items: {} } }, kamerTreffer(), []), null);
});

test('mails: bij audio de segmenten rond de treffer, per spreker een alinea met de tijd', () => {
  const segmenten = [
    { start: 0, text: 'Opening.', speaker: 'A' },
    { start: 300, text: 'De voorzitter geeft het woord.', speaker: 'A' },
    { start: 330, text: 'Over de huisartsenpost', speaker: 'B' },
    { start: 340, text: 'in Drachten.', speaker: 'B' },
    { start: 900, text: 'Sluiting.', speaker: 'A' },
  ];
  const k = { adb: { aflevering: () => ({ segmenten, transcript: segmenten.map((s) => s.text).join(' ') }) }, opslag: { items: {} } };
  const t = { id: 'a:e1', soort: 'raadsvergadering', gevonden: [{ term: 'huisartsenpost', tijd: 330, fragment: { tekst: 'Over de huisartsenpost', treffer: 'huisartsenpost' } }] };
  const d = documentVoorMail(k, t, ['huisartsenpost']);
  assert.equal(d.kop, 'Transcript');
  assert.deepEqual(d.alineas.map((a) => [a.tijd, a.tekst]), [[300, 'De voorzitter geeft het woord.'], [330, 'Over de huisartsenpost in Drachten.']]);
  assert.equal(d.meta, '3:30–7:30');
});

test('mails: kwaadaardige tekst blijft tekst, en markeren telt accenten en hoofdletters niet', () => {
  const s = stijl('LC');
  assert.equal(markeerTermen('<b>x</b> & Fryslân', ['fryslan'], s), `&lt;b&gt;x&lt;/b&gt; &amp; <span style="background:${s.a200};color:${s.inkt};font-weight:600;padding:0 2px;">Fryslân</span>`);
  assert.match(fragmentHtml({ tekst: 'a <script> b', treffer: '<script>' }, s), /a <span[^>]*>&lt;script&gt;<\/span> b/);
  assert.equal(stijl('onbekend').a500, '#482AA5', 'zonder titel LC');
});

test('weekmail: weeknummer, tellers per regio, en meer dan drie regio\'s in het onderwerp', async () => {
  process.env.REGIOCHECKER_SITE_URL = 'https://checker.example.nl';
  try {
    const opslag = new Opslag(mkdtempSync(path.join(tmpdir(), 'rc-mails-')));
    const regios = ['heerenveen', 'opsterland', 'smallingerland', 'sudwestfryslan'];
    for (const [n, regio] of regios.entries()) {
      for (let i = 0; i <= n; i++) opslag.items[`${regio}:${i}`] = { sleutel: `${regio}:${i}`, regio, soort: 'nieuws', titel: `Bericht ${i}`, url: `https://x/${regio}/${i}`, datum: '2026-10-28', eersteGezien: '2026-10-28T10:00:00.000Z', basislijn: false };
    }
    const mail = await stelMailSamen(opslag, { naam: 'Sanne de Vries', titel: 'DVHN', email: 'x@example.nl', regios, laatsteMail: '2026-10-26T06:00:00.000Z' }, { nu: new Date('2026-11-02T06:00:00.000Z'), samenvatting: false });
    assert.equal(isoWeek(new Date('2026-10-29T12:00:00Z')), 44);
    assert.equal(mail.onderwerp, 'Week 44: 10 nieuwe stukken in Heerenveen, Opsterland en 2 andere');
    assert.match(mail.html, /<h1[^>]*>Week 44<\/h1>/);
    assert.match(mail.html, /Goedemorgen Sanne, dit kwam er binnen in je regio’s\./);
    // Tellers: drie per rij, dus twee rijen voor vier regio's.
    const tellers = mail.html.slice(mail.html.indexOf('class="rc-stapel"'), mail.html.indexOf('</table>', mail.html.indexOf('class="rc-stapel"')));
    assert.equal((tellers.match(/<tr>/g) || []).length, 2);
    assert.match(tellers, /tabular-nums;">4<\/div><div[^>]*>Súdwest-Fryslân/);
    assert.match(mail.html, /href="https:\/\/checker\.example\.nl\/#\/feed\?regio=smallingerland"[^>]*>Alle 3 stukken uit Smallingerland →/);
    assert.match(mail.html, />Naar je feed<\/a>/);
    assert.match(mail.html, /De samenvattingen zijn automatisch gemaakt; controleer altijd het stuk zelf\./);
    assert.match(mail.html, /Weekmail aanpassen<\/a> · <a[^>]*>Uitzetten/);
    assert.match(mail.html, /bgcolor="#006ED1"/);
    assert.match(mail.tekst, /^Regiochecker · Week 44\n/);
    // Ging er langer geen mail uit, dan de datums in plaats van een weeknummer.
    const lang = await stelMailSamen(opslag, { email: 'x@example.nl', regios: ['heerenveen'], laatsteMail: '2026-10-12T06:00:00.000Z' }, { nu: new Date('2026-11-02T06:00:00.000Z'), samenvatting: false });
    assert.equal(lang.onderwerp, '1 nieuw stuk in Heerenveen (ma 12 okt – ma 2 nov)');
  } finally {
    delete process.env.REGIOCHECKER_SITE_URL;
  }
});

test('mailvoorbeeld: een beheerder bekijkt de weekmail als HTML, zonder te versturen', async () => {
  const opslag = new Opslag(mkdtempSync(path.join(tmpdir(), 'rc-mails-')));
  const jan = herken(opslag, { login: 'jan', email: 'jan@example.nl', naam: 'Jan' });
  jan.regios = ['heerenveen'];
  const ctx = { opslag, kdb: null, fdb: null };
  const r = await roep(ctx, jan, 'GET', '/api/beheer/mailvoorbeeld?soort=week&titel=DVHN');
  assert.equal(r.status, 200);
  assert.match(String(r.kop['Content-Type']), /text\/html/);
  assert.match(r.data.toString(), /<h1[^>]*>Week \d+<\/h1>/);
  assert.match(r.data.toString(), /#006ED1/);
  assert.equal((await roep(ctx, jan, 'GET', '/api/beheer/mailvoorbeeld?soort=melding')).status, 404, 'geen meldingen');
});
