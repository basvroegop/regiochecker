// Uitnodigen maakt ook het Authelia-account aan (src/accounts.mjs): de
// Regiochecker zet een aanvraag neer, het hulpscript op de server legt een
// uitslag terug, en daarna gaat de uitnodiging per mail. Het script zelf wordt
// getest in test/authelia-accounts.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Opslag } from '../src/opslag.mjs';
import { herken, nieuweGebruiker } from '../src/gebruikers.mjs';
import { verwerkAccounts, uitnodigingsmail } from '../src/accounts.mjs';
import { roep } from './api-hulp.mjs';

process.env.REGIOCHECKER_PRIVE_ADRESSEN = '1';

function opzet() {
  const map = mkdtempSync(path.join(tmpdir(), 'rc-accounts-'));
  const opslag = new Opslag(map);
  const jan = herken(opslag, { login: 'jan', email: 'jan@example.nl', naam: 'Jan de Beheerder' });
  const sanne = nieuweGebruiker(opslag.instellingen, { login: 'sanne', naam: 'Sanne', email: 'sanne@lc.nl' });
  opslag.gebruikers.push(sanne);
  return { map, opslag, jan, sanne, ctx: { opslag, kdb: null, fdb: null } };
}

const aanvragen = (map) => {
  const m = path.join(map, 'authelia', 'aanvragen');
  return readdirSync(m).sort().map((n) => ({ bestand: n, ...JSON.parse(readFileSync(path.join(m, n), 'utf8')) }));
};

function legUitslag(map, naam, uitslag) {
  mkdirSync(path.join(map, 'authelia', 'klaar'), { recursive: true });
  writeFileSync(path.join(map, 'authelia', 'klaar', naam), JSON.stringify(uitslag));
}

function nepSmtp() {
  const ontvangen = [];
  const server = net.createServer((sok) => {
    let buffer = '';
    let inData = false;
    let huidig = { aan: [], data: '' };
    sok.write('220 nep ESMTP\r\n');
    sok.on('data', (stuk) => {
      buffer += stuk.toString();
      let eind;
      while ((eind = buffer.indexOf('\r\n')) >= 0) {
        const regel = buffer.slice(0, eind);
        buffer = buffer.slice(eind + 2);
        if (inData) {
          if (regel === '.') {
            inData = false;
            ontvangen.push(huidig);
            huidig = { aan: [], data: '' };
            sok.write('250 ok\r\n');
          } else huidig.data += `${regel}\n`;
          continue;
        }
        const opdracht = regel.slice(0, 4).toUpperCase();
        if (opdracht === 'RCPT') huidig.aan.push(regel);
        if (opdracht === 'DATA') { inData = true; sok.write('354 ga je gang\r\n'); } else if (opdracht === 'QUIT') { sok.write('221 doei\r\n'); sok.end(); } else sok.write('250 ok\r\n');
      }
    });
  });
  return new Promise((klaar) => server.listen(0, '127.0.0.1', () => klaar({ server, ontvangen, poort: server.address().port })));
}

// quoted-printable terug naar gewone tekst, om in de mail te kunnen zoeken.
const plat = (mail) => mail.data.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

test('accounts: uitnodigen zet een aanvraag neer, de uitslag koppelt de inlog en mailt', async () => {
  const smtp = await nepSmtp();
  process.env.REGIOCHECKER_AUTHELIA_ACCOUNTS = '1';
  process.env.REGIOCHECKER_SITE_URL = 'https://checker.example.nl/';
  try {
    const { map, opslag, jan, sanne, ctx } = opzet();
    opslag.instellingen.smtp = { host: '127.0.0.1', port: smtp.poort, secure: false, user: '', pass: '', from: 'Regiochecker <rc@example.nl>' };
    assert.equal((await roep(ctx, jan, 'GET', '/api/ik')).data.autheliaAccounts, true);
    assert.equal((await roep(ctx, sanne, 'GET', '/api/ik')).data.autheliaAccounts, false, 'alleen voor beheerders');

    let r = await roep(ctx, jan, 'POST', '/api/beheer/gebruikers', { naam: 'Marrit Bosma', email: 'Marrit.Bosma@dvhn.nl', titel: 'DVHN' });
    assert.equal(r.status, 201);
    assert.equal(r.data.account.status, 'aangevraagd');
    const id = r.data.id;
    let lijst = aanvragen(map);
    assert.equal(lijst.length, 1);
    const { bestand, ...aanvraag } = lijst[0];
    assert.match(bestand, /^\d{13}-[0-9a-f-]{36}\.json$/, 'de naam die het script accepteert');
    assert.deepEqual(aanvraag, { soort: 'aanmaken', gebruiker: id, login: null, naam: 'Marrit Bosma', email: 'marrit.bosma@dvhn.nl' });
    assert.deepEqual(readdirSync(path.join(map, 'authelia')).sort(), ['aanvragen', 'klaar'], 'geen half bestand achtergebleven');

    // Het script heeft het account gemaakt.
    legUitslag(map, bestand, { soort: 'aanmaken', gebruiker: id, ok: true, login: 'marrit.bosma', bestond: false });
    r = await roep(ctx, jan, 'GET', '/api/beheer/gebruikers');
    const marrit = r.data.find((g) => g.id === id);
    assert.equal(marrit.login, 'marrit.bosma');
    assert.equal(marrit.account.status, 'klaar');
    assert.ok(marrit.account.mail.verstuurd);
    assert.deepEqual(readdirSync(path.join(map, 'authelia', 'klaar')), [], 'uitslag verwerkt');
    assert.equal(smtp.ontvangen.length, 1);
    const mail = plat(smtp.ontvangen[0]);
    assert.match(smtp.ontvangen[0].aan[0], /marrit\.bosma@dvhn\.nl/);
    assert.match(mail, /Jan de Beheerder heeft je uitgenodigd/);
    assert.match(mail, /Je inlognaam: marrit\.bosma/);
    assert.match(mail, /Kies eerst een wachtwoord/);
    assert.match(mail, /Wachtwoord opnieuw instellen\?/);
    assert.match(mail, /https:\/\/checker\.example\.nl\./, 'zonder dubbele schuine streep');
    // Bij de eerste keer inloggen herkent de Regiochecker diegene aan de inlog.
    assert.equal(herken(opslag, { login: 'marrit.bosma' })?.id, id);

    // Opnieuw uitnodigen: weer een aanvraag; het account bestond al.
    r = await roep(ctx, jan, 'POST', `/api/beheer/gebruikers/${id}/uitnodiging`);
    assert.equal(r.data.account.status, 'aangevraagd');
    lijst = aanvragen(map);
    assert.equal(lijst.at(-1).login, 'marrit.bosma');
    legUitslag(map, lijst.at(-1).bestand, { soort: 'aanmaken', gebruiker: id, ok: true, login: 'marrit.bosma', bestond: true });
    await verwerkAccounts(opslag);
    assert.equal(smtp.ontvangen.length, 2);
    assert.match(plat(smtp.ontvangen[1]), /Je hebt al een account met deze inlognaam/);

    // Verwijderen zet het account uit (het script doet dat alleen bij de groep checker).
    assert.equal((await roep(ctx, jan, 'DELETE', `/api/beheer/gebruikers/${id}`)).status, 200);
    lijst = aanvragen(map);
    assert.deepEqual([lijst.at(-1).soort, lijst.at(-1).login, lijst.at(-1).gebruiker], ['uitzetten', 'marrit.bosma', id]);
    legUitslag(map, lijst.at(-1).bestand, { soort: 'uitzetten', gebruiker: id, ok: true, login: 'marrit.bosma' });
    await verwerkAccounts(opslag);
    assert.match(opslag.logboek[0].tekst, /marrit\.bosma uitgezet/);
  } finally {
    delete process.env.REGIOCHECKER_AUTHELIA_ACCOUNTS;
    delete process.env.REGIOCHECKER_SITE_URL;
    smtp.server.close();
  }
});

test('accounts: fouten van het script en botsende inlognamen', async () => {
  process.env.REGIOCHECKER_AUTHELIA_ACCOUNTS = '1';
  try {
    const { map, opslag, jan, ctx } = opzet();
    let r = await roep(ctx, jan, 'POST', '/api/beheer/gebruikers', { naam: 'Piet', email: 'piet@lc.nl', login: 'piet' });
    const piet = r.data.id;
    legUitslag(map, aanvragen(map)[0].bestand, { soort: 'aanmaken', gebruiker: piet, ok: false, fout: 'De inlognaam piet bestaat al in Authelia, met een ander e-mailadres' });
    await verwerkAccounts(opslag);
    let g = opslag.gebruikers.find((x) => x.id === piet);
    assert.deepEqual([g.account.status, g.account.melding], ['fout', 'De inlognaam piet bestaat al in Authelia, met een ander e-mailadres']);

    // Het script geeft een inlog terug die hier al van iemand anders is.
    r = await roep(ctx, jan, 'POST', '/api/beheer/gebruikers', { naam: 'Tweede Sanne', email: 'sanne2@lc.nl' });
    legUitslag(map, aanvragen(map).at(-1).bestand, { soort: 'aanmaken', gebruiker: r.data.id, ok: true, login: 'sanne', bestond: true });
    await verwerkAccounts(opslag);
    g = opslag.gebruikers.find((x) => x.id === r.data.id);
    assert.equal(g.login, null);
    assert.match(g.account.melding, /hoort hier al bij een andere gebruiker/);

    // Zonder SMTP: account klaar, mail niet verstuurd, en dat staat erbij.
    r = await roep(ctx, jan, 'POST', '/api/beheer/gebruikers', { naam: 'Klaas', email: 'klaas@lc.nl' });
    legUitslag(map, aanvragen(map).at(-1).bestand, { soort: 'aanmaken', gebruiker: r.data.id, ok: true, login: 'klaas', bestond: false });
    await verwerkAccounts(opslag);
    g = opslag.gebruikers.find((x) => x.id === r.data.id);
    assert.equal(g.account.status, 'klaar');
    assert.ok(g.account.mail.fout);

    // Kapotte uitslag: weg, verder niets.
    legUitslag(map, '1-kapot.json', 'geen json');
    writeFileSync(path.join(map, 'authelia', 'klaar', '2-kapot.json'), '{');
    await verwerkAccounts(opslag);
    assert.deepEqual(readdirSync(path.join(map, 'authelia', 'klaar')), []);
  } finally {
    delete process.env.REGIOCHECKER_AUTHELIA_ACCOUNTS;
  }
});

test('accounts: uit zonder REGIOCHECKER_AUTHELIA_ACCOUNTS', async () => {
  const { map, jan, ctx } = opzet();
  const r = await roep(ctx, jan, 'POST', '/api/beheer/gebruikers', { naam: 'Piet', email: 'piet@lc.nl' });
  assert.equal(r.status, 201);
  assert.equal(r.data.account, undefined);
  assert.equal((await roep(ctx, jan, 'POST', `/api/beheer/gebruikers/${r.data.id}/uitnodiging`)).status, 400);
  assert.deepEqual(readdirSync(map).includes('authelia'), false);
  assert.equal((await roep(ctx, jan, 'GET', '/api/ik')).data.autheliaAccounts, false);
});

test('accounts: de uitnodigingsmail ontsnapt namen', () => {
  const mail = uitnodigingsmail({ naam: '<b>Eva</b>', login: 'eva', account: { door: 'Jan & co', bestond: false } }, 'https://checker.example.nl');
  assert.match(mail.html, /Hallo &lt;b&gt;Eva&lt;\/b&gt;/);
  assert.match(mail.html, /Jan &amp; co heeft je uitgenodigd/);
  assert.match(mail.tekst, /1\. Ga naar https:\/\/checker\.example\.nl\./);
});
