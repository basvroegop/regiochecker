// Authelia-accounts voor wie een beheerder uitnodigt (Beheer › Gebruikers).
//
// Het gebruikersbestand van Authelia is van de hele server: ook de wiki logt
// daar in. De Regiochecker schrijft er daarom zelf niet in. Hij zet een
// aanvraag in data/authelia/aanvragen/; het hulpscript op de server
// (scripts/authelia-accounts.py, door systemd gestart zodra daar iets staat)
// maakt het account aan, alleen in de groep checker en nooit over een ander
// account heen, en legt de uitslag in data/authelia/klaar/. Die verwerken we
// hier: de inlognaam vastleggen en de uitnodiging mailen. Het wachtwoord kiest
// de gebruiker zelf via "Wachtwoord opnieuw instellen?" van Authelia; wij zien
// het nooit.
//
// Alleen aan met REGIOCHECKER_AUTHELIA_ACCOUNTS=1 (zie docker-compose.yml).

import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { verstuur, smtpIngesteld } from './mail.mjs';
import { html } from './html.mjs';
import { stijl, mailHtml, rij, letter, FAMILIE, link, knoppen } from './mailstijl.mjs';

export const accountsAan = () => process.env.REGIOCHECKER_AUTHELIA_ACCOUNTS === '1';

function mappen(opslag) {
  const basis = path.join(opslag.map, 'authelia');
  return { basis, aanvragen: path.join(basis, 'aanvragen'), klaar: path.join(basis, 'klaar') };
}

export function maakMappen(opslag) {
  const m = mappen(opslag);
  mkdirSync(m.aanvragen, { recursive: true });
  mkdirSync(m.klaar, { recursive: true });
}

function zetNeer(opslag, aanvraag) {
  const m = mappen(opslag);
  maakMappen(opslag);
  const naam = `${Date.now()}-${randomUUID()}.json`;
  // Eerst ernaast schrijven en dan verplaatsen: in aanvragen/ staat zo nooit
  // een half bestand (systemd start het script zodra de map niet leeg is).
  const tijdelijk = path.join(m.basis, `.${naam}.tmp`);
  writeFileSync(tijdelijk, JSON.stringify(aanvraag));
  renameSync(tijdelijk, path.join(m.aanvragen, naam));
}

const wie = (g) => g?.naam || g?.login || null;

// Bij uitnodigen, en met de knop Uitnodigen bij een bestaande gebruiker. Het
// script geeft een bestaand account terug als het e-mailadres al bekend is.
export function vraagAccount(opslag, g, door) {
  if (!accountsAan()) return false;
  const nu = new Date().toISOString();
  if (!g.email) {
    g.account = { status: 'fout', melding: 'Zonder e-mailadres geen account: het wachtwoord kiest iemand via een mail', bijgewerkt: nu };
    return false;
  }
  zetNeer(opslag, { soort: 'aanmaken', gebruiker: g.id, login: g.login || null, naam: g.naam || '', email: g.email });
  g.account = { status: 'aangevraagd', door: wie(door), bijgewerkt: nu };
  return true;
}

// Bij verwijderen. Het script zet alleen accounts uit die in de groep checker
// zitten; andere (de beheerder, de wiki) blijven aan.
export function zetAccountUit(opslag, g) {
  if (!accountsAan() || !g.login) return false;
  zetNeer(opslag, { soort: 'uitzetten', gebruiker: g.id, login: g.login });
  return true;
}

export function uitnodigingsmail(g, site) {
  const naam = g.naam || g.login;
  const door = g.account?.door;
  const inleiding = `${door ? `${door} heeft je` : 'Je bent'} uitgenodigd voor de Regiochecker: nieuws uit de gemeenten, Kamerstukken, raadsvergaderingen en Kamerdebatten op één plek.`;
  const stappen = [
    `Ga naar ${site}.`,
    'Klik onder het inlogscherm op ‘Wachtwoord opnieuw instellen?’ en vul je inlognaam in.',
    'Je krijgt een mail (in het Engels) met een link. Die werkt vijf minuten: kies daar je wachtwoord.',
  ];
  const nieuw = !g.account?.bestond;
  const uitleg = nieuw
    ? 'Kies eerst een wachtwoord:'
    : 'Je hebt al een account met deze inlognaam: log in met je wachtwoord. Nog nooit een wachtwoord gekozen, of vergeten? Zo stel je er een in:';
  const slot = 'Daarna log je in met je inlognaam en wachtwoord. Kies in de feed welke regio’s je volgt.';
  const tekst = [`Hallo ${naam},`, '', inleiding, '', `Je inlognaam: ${g.login}`, '', uitleg, ...stappen.map((s, i) => `${i + 1}. ${s}`), '', slot].join('\n');
  const s = stijl(g.titel);
  const p = (inhoud, marge = '0 0 12px') => `<p style="margin:${marge};${letter(400, 15, 1.6)}color:${s.inkt};">${inhoud}</p>`;
  const htmlMail = mailHtml({
    s,
    titel: 'Je account voor de Regiochecker',
    preheader: `Je inlognaam: ${g.login}`,
    rechts: 'Uitnodiging',
    rijen: [rij(`<h1 class="rc-titel" style="margin:0 0 16px;${FAMILIE}${letter(800, 25, 1.2)}color:${s.inkt};">Welkom bij de Regiochecker</h1>
${p(`Hallo ${html(naam)},`)}
${p(html(inleiding))}
<div style="margin:4px 0 16px;padding:14px 16px;background:${s.a100};border:2px solid ${s.a300};${letter(400, 15, 1.5)}">Je inlognaam: <strong style="font-weight:800;color:${s.a700};">${html(g.login)}</strong></div>
${p(html(uitleg), '0 0 4px')}
<ol style="margin:0 0 12px;padding:0 0 0 22px;${letter(400, 15, 1.6)}color:${s.inkt};">${stappen.map((st, i) => `<li style="margin:0 0 4px;">${i === 0 ? `Ga naar ${link(site, site, s)}.` : html(st)}</li>`).join('')}</ol>
${p(html(slot), '0 0 20px')}
${knoppen([{ tekst: 'Naar de Regiochecker', url: site }], s)}`, '28px 28px 32px')],
  });
  return { onderwerp: 'Je account voor de Regiochecker', html: htmlMail, tekst };
}

export async function stuurUitnodiging(opslag, g) {
  const site = (process.env.REGIOCHECKER_SITE_URL || '').replace(/\/$/, '');
  const nu = new Date().toISOString();
  g.account = g.account || {};
  if (!site || !smtpIngesteld(opslag)) {
    g.account.mail = { fout: site ? 'SMTP is niet ingesteld' : 'REGIOCHECKER_SITE_URL ontbreekt', moment: nu };
    return false;
  }
  try {
    await verstuur(opslag, { aan: g.email, ...uitnodigingsmail(g, site) });
    g.account.mail = { verstuurd: nu };
    opslag.log({ soort: 'account', aan: g.email, tekst: `Uitnodiging verstuurd (inlognaam ${g.login})` });
    return true;
  } catch (fout) {
    g.account.mail = { fout: fout.message, moment: nu };
    opslag.log({ soort: 'fout', aan: g.email, tekst: `Uitnodiging mislukt: ${fout.message}` });
    return false;
  }
}

async function verwerkUitslag(opslag, u) {
  const nu = new Date().toISOString();
  if (u.soort === 'uitzetten') {
    opslag.log({ soort: 'account', tekst: u.ok ? `Authelia-account ${u.login} uitgezet` : `Authelia-account niet uitgezet: ${u.fout}` });
    return;
  }
  const g = opslag.gebruikers.find((x) => x.id === u.gebruiker);
  // Intussen verwijderd: het script zet het account bij die aanvraag uit.
  if (!g) return;
  if (!u.ok) {
    g.account = { ...g.account, status: 'fout', melding: String(u.fout || 'Onbekende fout'), bijgewerkt: nu };
    opslag.log({ soort: 'fout', aan: g.email, tekst: `Authelia-account niet aangemaakt: ${g.account.melding}` });
    return;
  }
  const login = String(u.login || '').toLowerCase();
  if (g.login !== login) {
    if (opslag.gebruikers.some((x) => x.id !== g.id && x.login === login)) {
      g.account = { ...g.account, status: 'fout', melding: `Het Authelia-account ${login} hoort hier al bij een andere gebruiker`, bijgewerkt: nu };
      return;
    }
    g.login = login;
  }
  g.account = { ...g.account, status: 'klaar', bestond: Boolean(u.bestond), melding: null, bijgewerkt: nu };
  opslag.log({ soort: 'account', aan: g.email, tekst: u.bestond ? `Bestaand Authelia-account ${login} gekoppeld` : `Authelia-account ${login} aangemaakt` });
  await stuurUitnodiging(opslag, g);
}

// De uitslagen van het script ophalen. Elke 15 seconden vanuit src/dienst.mjs,
// en bij het openen van Beheer › Gebruikers; nooit twee keer tegelijk.
let lopend = null;
export function verwerkAccounts(opslag) {
  if (!accountsAan()) return Promise.resolve(0);
  lopend ||= (async () => {
    const { klaar } = mappen(opslag);
    let namen;
    try {
      namen = readdirSync(klaar).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
    } catch {
      return 0;
    }
    let aantal = 0;
    for (const naam of namen) {
      const bestand = path.join(klaar, naam);
      let uitslag = null;
      try {
        uitslag = JSON.parse(readFileSync(bestand, 'utf8'));
      } catch { /* kapot: weg ermee */ }
      // Eerst weghalen: een mislukte mail mag niet bij elke ronde opnieuw.
      unlinkSync(bestand);
      if (!uitslag) continue;
      await verwerkUitslag(opslag, uitslag);
      aantal++;
    }
    if (aantal) opslag.bewaar('gebruikers');
    return aantal;
  })().finally(() => { lopend = null; });
  return lopend;
}
