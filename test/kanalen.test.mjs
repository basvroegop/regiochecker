// Teams-kanalen (src/kanalen.mjs): instellen via Beheer, wat er per kanaal
// naartoe gaat (regio's, soorten, losse bronnen), het kaartje, een overzicht
// bij veel stukken tegelijk, en opnieuw proberen zonder dubbele berichten.
// Teams zelf is nagebootst.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MockAgent } from 'undici';
import { Opslag } from '../src/opslag.mjs';
import { herken, nieuweGebruiker } from '../src/gebruikers.mjs';
import { zetOpenbaarDispatcher } from '../src/netwerk.mjs';
import { verwerkKanalen } from '../src/kanalen.mjs';
import { roep } from './api-hulp.mjs';

process.env.TEAMS_TUSSENPOOS_MS = '0';
process.env.REGIOCHECKER_SITE_URL = 'https://regiochecker.example';

const WORKFLOW = 'https://teams.example/workflows/abc/triggers/manual/paths/invoke?sig=GEHEIM';
const WORKFLOW2 = 'https://teams.example/workflows/def/triggers/manual/paths/invoke?sig=OOKGEHEIM';

function nepTeams() {
  const nep = new MockAgent();
  nep.disableNetConnect();
  const berichten = [];
  // Na `lukkenNog` goede verzoeken geeft Teams een 500, tot `lukkenNog` weer Infinity is.
  const staat = { lukkenNog: Infinity };
  nep.get('https://teams.example').intercept({ path: () => true, method: 'POST' }).reply(({ path: pad, body }) => {
    if (staat.lukkenNog <= 0) return { statusCode: 500, data: '{"error":"kapot, zie https://teams.example/geheim"}' };
    staat.lukkenNog--;
    berichten.push({ pad, ...JSON.parse(body) });
    return { statusCode: 202, data: '' };
  }).persist();
  const vorige = zetOpenbaarDispatcher(nep);
  return { berichten, staat, herstel: () => zetOpenbaarDispatcher(vorige) };
}

const kaartVan = (b) => b.attachments[0].content;
const titelVan = (b) => kaartVan(b).body[0].text;

test('Teams-kanalen: per regio en per soort, met een kaartje per stuk', async () => {
  const opslag = new Opslag(mkdtempSync(path.join(tmpdir(), 'rc-kanalen-')));
  const jan = herken(opslag, { login: 'jan', email: 'jan@example.nl', naam: 'Jan' });
  const sanne = nieuweGebruiker(opslag.instellingen, { login: 'sanne', naam: 'Sanne', email: 'sanne@lc.nl', regios: ['heerenveen'] });
  opslag.gebruikers.push(sanne);
  const ctx = { opslag, kdb: null, fdb: null };
  const teams = nepTeams();
  try {
    // Alleen admins.
    assert.equal((await roep(ctx, sanne, 'GET', '/api/beheer/kanalen')).status, 403);
    let r = await roep(ctx, jan, 'GET', '/api/beheer/kanalen');
    assert.deepEqual(r.data.kanalen, []);
    assert.ok(r.data.keuzes.regios.some((x) => x.id === 'heerenveen'));
    const ransomware = r.data.keuzes.soorten.find((s) => s.id === 'ransomware');
    assert.deepEqual(ransomware.bronnen.map((b) => b.id), ['ransomware']);
    assert.ok(r.data.keuzes.soorten.find((s) => s.id === 'nieuws').bronnen.some((b) => b.id === 'heerenveen-nieuws' && b.regio === 'heerenveen'));

    assert.match((await roep(ctx, jan, 'POST', '/api/beheer/kanalen', { naam: 'Zonder adres' })).data.fout, /adres van de workflow/);
    assert.match((await roep(ctx, jan, 'POST', '/api/beheer/kanalen', { naam: 'X', url: 'http://teams.example/x' })).data.fout, /https/);
    assert.match((await roep(ctx, jan, 'POST', '/api/beheer/kanalen', { naam: 'X', url: WORKFLOW, regios: ['atlantis'] })).data.fout, /Onbekende regio's: atlantis/);

    // Redactie Heerenveen: alles uit Heerenveen. Ransomware: overal, alleen ransomware.
    r = await roep(ctx, jan, 'POST', '/api/beheer/kanalen', { naam: 'Redactie Heerenveen', url: WORKFLOW, regios: ['heerenveen'] });
    assert.equal(r.status, 201);
    const heerenveen = r.data;
    assert.equal(heerenveen.adres, 'teams.example/…');
    r = await roep(ctx, jan, 'POST', '/api/beheer/kanalen', { naam: 'Ransomware', url: WORKFLOW2, soorten: ['ransomware'] });
    const ransomKanaal = r.data;
    r = await roep(ctx, jan, 'GET', '/api/beheer/kanalen');
    assert.ok(!JSON.stringify(r.data).includes('GEHEIM'), 'het adres van de workflow gaat niet naar de browser');

    // Een proefbericht.
    r = await roep(ctx, jan, 'POST', `/api/beheer/kanalen/${heerenveen.id}/test`);
    assert.equal(r.status, 200);
    assert.match(titelVan(teams.berichten.at(-1)), /proefbericht voor Redactie Heerenveen/);
    assert.deepEqual(kaartVan(teams.berichten.at(-1)).body[2].facts, [{ title: "Regio's", value: 'Heerenveen' }, { title: 'Bronnen', value: 'alle bronnen' }]);
    teams.berichten.length = 0;

    // Wat er van vóór het kanaal was, gaat niet mee.
    const tijd = (minuten) => new Date(Date.now() + minuten * 60000).toISOString();
    const item = (sleutel, velden) => { opslag.items[sleutel] = { sleutel, basislijn: false, laatstGezien: tijd(0), ...velden }; };
    item('heerenveen-nieuws:oud', { bron: 'heerenveen-nieuws', regio: 'heerenveen', soort: 'nieuws', titel: 'Van gisteren', eersteGezien: tijd(-1440) });
    item('heerenveen-nieuws:1', { bron: 'heerenveen-nieuws', regio: 'heerenveen', soort: 'nieuws', titel: 'Thialf krijgt nieuw dak', url: 'https://www.heerenveen.nl/nieuws/1', datum: '2026-10-28', tekst: 'Het dak van Thialf wordt vervangen.', eersteGezien: tijd(1) });
    item('groningen-nieuws:1', { bron: 'groningen-nieuws', regio: 'groningen', soort: 'nieuws', titel: 'Nieuws uit Groningen', eersteGezien: tijd(1) });
    item('ransomware:g', {
      bron: 'ransomware', regio: null, soort: 'ransomware', titel: 'Ransomware-aanval: Garage Bouma (akira)', url: 'https://www.ransomlook.io/group/akira', afzender: 'akira', eersteGezien: tijd(2),
      vestiging: { plaats: 'Gorredijk', gemeente: 'Opsterland', bron: 'de beschrijving' },
    });

    let uit = await verwerkKanalen(ctx, { nu: new Date(Date.now() + 5 * 60000) });
    assert.deepEqual(uit.map((u) => u.verstuurd), [1, 1]);
    const naar = (url) => teams.berichten.filter((b) => url.endsWith(b.pad));
    assert.deepEqual(naar(WORKFLOW).map(titelVan), ['Thialf krijgt nieuw dak']);
    assert.deepEqual(naar(WORKFLOW2).map(titelVan), ['Ransomware-aanval: Garage Bouma (akira)']);
    const kaart = kaartVan(naar(WORKFLOW)[0]);
    assert.equal(teams.berichten[0].type, 'message');
    assert.equal(teams.berichten[0].attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
    assert.equal(kaart.body[1].text, 'Heerenveen · Gemeentenieuws');
    assert.deepEqual(kaart.body[3].facts, [{ title: 'Datum', value: 'wo 28 okt' }, { title: 'Bron', value: 'Heerenveen · Nieuwsfeed heerenveen.nl' }]);
    assert.equal(kaart.body[2].text, 'Het dak van Thialf wordt vervangen.');
    assert.deepEqual(kaart.actions.map((a) => [a.title, a.url]), [
      ['Openen in de Regiochecker', 'https://regiochecker.example/#/feed?stuk=i%3Aheerenveen-nieuws%3A1'],
      ['Naar de bron', 'https://www.heerenveen.nl/nieuws/1'],
    ]);
    const ransomKaart = kaartVan(naar(WORKFLOW2)[0]);
    assert.ok(ransomKaart.body.at(-1).facts.some((f) => f.title === 'Vestiging' && f.value === 'Gorredijk (gemeente Opsterland)'));
    assert.ok(!ransomKaart.body.at(-1).facts.some((f) => f.title === 'Gevonden'), 'de vestiging zegt al waarom');
    assert.ok(opslag.logboek.some((l) => l.soort === 'teams' && l.aan === 'Redactie Heerenveen' && /1 stuk naar Teams/.test(l.tekst)));
    assert.ok(!JSON.stringify(opslag.logboek).includes('GEHEIM'));

    // Daarna niet nog eens.
    teams.berichten.length = 0;
    await verwerkKanalen(ctx, { nu: new Date(Date.now() + 6 * 60000) });
    assert.equal(teams.berichten.length, 0);

    // Twaalf tegelijk: de tien nieuwste elk een kaartje, de twee oudste samen vooraf.
    for (let i = 1; i <= 12; i++) item(`heerenveen-nieuws:r${i}`, { bron: 'heerenveen-nieuws', regio: 'heerenveen', soort: 'nieuws', titel: `Bericht ${i}`, eersteGezien: tijd(10 + i / 10) });
    await verwerkKanalen(ctx, { nu: new Date(Date.now() + 15 * 60000) });
    assert.equal(teams.berichten.length, 11);
    assert.equal(titelVan(teams.berichten[0]), 'Nog 2 nieuwe stukken voor Redactie Heerenveen');
    assert.match(kaartVan(teams.berichten[0]).body[1].text, /^- \[Bericht 1\]\(https:\/\/regiochecker\.example\/#\/feed\?stuk=i%3Aheerenveen-nieuws%3Ar1\) · Gemeentenieuws\n- \[Bericht 2\]/);
    assert.deepEqual(teams.berichten.slice(1).map(titelVan), Array.from({ length: 10 }, (_, i) => `Bericht ${i + 3}`));

    // Teams hapert halverwege: de volgende ronde alleen wat nog niet aankwam.
    teams.berichten.length = 0;
    item('heerenveen-nieuws:a', { bron: 'heerenveen-nieuws', regio: 'heerenveen', soort: 'nieuws', titel: 'A', eersteGezien: tijd(20) });
    item('heerenveen-nieuws:b', { bron: 'heerenveen-nieuws', regio: 'heerenveen', soort: 'nieuws', titel: 'B', eersteGezien: tijd(21) });
    const ronde = async (minuten) => {
      const [a] = await verwerkKanalen(ctx, { nu: new Date(Date.now() + minuten * 60000) });
      return a;
    };
    teams.staat.lukkenNog = 1; // A lukt, B niet
    uit = await ronde(25);
    assert.deepEqual([uit.verstuurd, uit.fout], [1, 'Teams gaf HTTP 500: {"error":"kapot, zie …"}']);
    assert.deepEqual(teams.berichten.map(titelVan), ['A']);
    assert.equal(opslag.kanalen.find((c) => c.id === heerenveen.id).laatsteFout, uit.fout);
    r = await roep(ctx, jan, 'GET', '/api/beheer/kanalen');
    assert.equal(r.data.kanalen[0].laatsteFout, uit.fout, 'zichtbaar in Beheer');
    await ronde(26);
    assert.equal(opslag.logboek.filter((l) => l.soort === 'teamsfout').length, 1, 'dezelfde fout één keer in het logboek');
    teams.staat.lukkenNog = Infinity;
    uit = await ronde(27);
    assert.deepEqual(teams.berichten.map(titelVan), ['A', 'B'], 'A niet nog eens');
    assert.equal(uit.fout, undefined);
    assert.equal(opslag.kanalen.find((c) => c.id === heerenveen.id).laatsteFout, null);

    // Uit en weer aan: niet wat er in de tussentijd binnenkwam.
    opslag.kanalen.find((c) => c.id === ransomKanaal.id).laatsteVerzending = tijd(-60);
    await roep(ctx, jan, 'PUT', `/api/beheer/kanalen/${ransomKanaal.id}`, { actief: false });
    item('ransomware:h', { bron: 'ransomware', regio: null, soort: 'ransomware', titel: 'Ransomware-aanval: Iets (x)', eersteGezien: tijd(-1), vestiging: { plaats: 'Sneek', gemeente: 'Súdwest-Fryslân', bron: 'x' } });
    r = await roep(ctx, jan, 'PUT', `/api/beheer/kanalen/${ransomKanaal.id}`, { actief: true, naam: 'Ransomware NL' });
    assert.deepEqual([r.data.naam, r.data.actief, r.data.adres], ['Ransomware NL', true, 'teams.example/…'], 'zonder nieuw adres blijft het oude');
    teams.berichten.length = 0;
    await verwerkKanalen(ctx, { nu: new Date() });
    assert.equal(teams.berichten.length, 0);

    r = await roep(ctx, jan, 'DELETE', `/api/beheer/kanalen/${ransomKanaal.id}`);
    assert.deepEqual((await roep(ctx, jan, 'GET', '/api/beheer/kanalen')).data.kanalen.map((c) => c.naam), ['Redactie Heerenveen']);
  } finally {
    teams.herstel();
  }
});
