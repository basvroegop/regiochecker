// De weekmail per journalist. Opbouw: per gemeente een H2 met daaronder de
// samenvatting van wat er speelt, en dan altijd dezelfde drie H3's in vaste volgorde:
// Gemeentenieuws, Ingekomen stukken, Woo-publicaties. Ook een lege categorie
// krijgt zijn kop, zodat alles elke week op dezelfde plek staat; wat er bij een
// categorie niet gecontroleerd kon worden, staat onder die kop. Daarna, als er
// iets is: stukken uit landelijke bronnen met een sleutelwoord van de regio,
// kamerstukken, en raadsvergaderingen en andere audio en video (met per
// vergadering een samenvatting per onderwerp, src/vergadering.mjs).
//
// De periode loopt altijd van de vorige mail aan deze gebruiker tot het moment
// van versturen. Ging er een week geen mail uit (niets nieuws, een fout, of de
// weekmail stond uit), dan zit die week gewoon in de volgende mail. Wie nog
// nooit een mail kreeg, krijgt de afgelopen week. Wanneer de mail gaat, stelt
// iedere gebruiker zelf in (src/planning.mjs).

import nodemailer from 'nodemailer';
import { SOORTEN, ENKELVOUD } from './regios.mjs';
import { alleRegios, bronnenVanRegio, geldtVoor, actieveTermen, TWEEDE_KAMER, isAudioBron } from './register.mjs';
import { maakSamenvatting, samenvattingAanbieder } from './samenvatting.mjs';
import { vatVergaderingSamen, tijdcode } from './vergadering.mjs';
import { maakKader, routeerItem, routeerAflevering } from './feed.mjs';
import { html, kort } from './html.mjs';
import { korteDatum, lokaleDatum } from './datum.mjs';
import { minDatum } from './kamer/db.mjs';
import { trefferHtml, trefferTekst, fragmentHtml } from './kamer/weergave.mjs';
import { weekmailNodig } from './planning.mjs';

// Meer kamerstukken dan in een mail passen: dat zeggen, niet stilzwijgend weglaten.
export const meerKamerstukken = (n) => `En nog zo'n ${n} ${n === 1 ? 'kamerstuk' : 'kamerstukken'} met deze termen, die niet meer in deze mail passen.`;

const SOORT_VOLGORDE = ['nieuws', 'ingekomen', 'woo'];
const DAG_MS = 86400000;
const EERSTE_MAIL_DAGEN = 7;
const HERKANSING_MS = 30 * 60000;

export function nieuweItems(opslag, regioId, sinds, tot) {
  return Object.values(opslag.items)
    .filter((i) => i.regio === regioId && !i.basislijn && i.eersteGezien > sinds && i.eersteGezien <= tot)
    .sort((a, b) => SOORT_VOLGORDE.indexOf(a.soort) - SOORT_VOLGORDE.indexOf(b.soort)
      || String(b.datum || '').localeCompare(String(a.datum || ''))
      || a.titel.localeCompare(b.titel));
}

function kenmerken(item) {
  return [item.afzender, item.soortStuk, item.advies].filter(Boolean).join(' · ');
}

// Opmerkingen bij één categorie van een regio: niet online, vervangende bron,
// of een bron die bij de laatste ronde faalde.
function bronOpmerkingen(opslag, regio, soort) {
  const regels = [];
  for (const bron of regio.bronnen.filter((b) => b.soort === soort)) {
    if (bron.type === 'ontbreekt') {
      regels.push('Niet gecontroleerd: de gemeente publiceert deze niet (vindbaar) online.');
      continue;
    }
    if (bron.vervangend) regels.push(`Vervangende bron: ${bron.label || bron.naam}${bron.mailnotitie ? `; ${bron.mailnotitie}` : ''}.`);
    const status = opslag.status.bronnen[bron.id];
    if (status && !status.ok) regels.push(`${bron.label || bron.naam} kon de laatste keer niet worden opgehaald (${status.fout}).`);
  }
  return regels;
}

// Per categorie de items en de opmerkingen. "Geen nieuwe berichten" alleen als
// er minstens één bron voor die categorie is; anders zegt de opmerking genoeg.
function categorieen(opslag, regio, items) {
  return SOORT_VOLGORDE.map((soort) => ({
    soort,
    naam: SOORTEN[soort],
    items: items.filter((i) => i.soort === soort),
    opmerkingen: bronOpmerkingen(opslag, regio, soort),
    gecontroleerd: regio.bronnen.some((b) => b.soort === soort && b.type !== 'ontbreekt'),
  }));
}

const STIJL = {
  body: 'margin:0;padding:0;background:#f4f4f1;',
  kader: 'max-width:680px;margin:0 auto;background:#ffffff;font-family:Georgia,\'Times New Roman\',serif;color:#1d1d1b;',
  kop: 'padding:22px 28px 14px;border-bottom:3px solid #1d1d1b;',
  h1: 'font-size:26px;font-weight:bold;margin:0 0 4px;',
  regio: 'padding:20px 28px 8px;',
  h2: 'font-size:26px;margin:0 0 6px;',
  klein: 'font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#6b6b66;',
  samenvatting: 'margin:14px 0 6px;padding:12px 16px 4px;background:#fbf6e9;border-left:4px solid #c8102e;',
  h3: 'font-size:19px;font-weight:bold;margin:26px 0 10px;padding-bottom:4px;border-bottom:1px solid #e3e1da;',
  item: 'margin:0 0 10px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;',
  link: 'color:#1d1d1b;',
};

function itemHtml(item) {
  const extra = kenmerken(item);
  return `<p style="${STIJL.item}"><span style="color:#6b6b66;">${html(korteDatum(item.datum) || 'z.d.')}</span> &nbsp;<a href="${html(item.url)}" style="${STIJL.link}">${html(item.titel)}</a>${extra ? `<br><span style="${STIJL.klein}">${html(extra)}</span>` : ''}</p>`;
}

function regioHtml(blok, opslag) {
  const { regio, items, samenvatting, samenvattingFout } = blok;
  const perSleutel = new Map(items.map((i) => [i.sleutel, i]));
  let uit = `<div style="${STIJL.regio}"><h2 style="${STIJL.h2}">${html(regio.naam)}</h2>`;
  uit += `<p style="${STIJL.klein}">${items.length ? `${items.length} nieuw${items.length === 1 ? ' bericht' : 'e berichten'}` : 'Niets nieuws gevonden.'}</p>`;

  if (samenvatting?.punten.length) {
    uit += `<div style="${STIJL.samenvatting}"><ul style="margin:0;padding:0 0 0 20px;">${samenvatting.punten.map((p) => {
      const bronnen = p.items.map((k) => perSleutel.get(k)).filter(Boolean);
      const links = bronnen.map((b) => `<a href="${html(b.url)}" style="color:#6b6b66;">${html(kort(b.titel, 80))}</a>`).join(' · ');
      return `<li style="font-size:15px;line-height:1.5;margin:0 0 8px;">${html(p.zin)}${links ? ` <span style="${STIJL.klein}">— ${links}</span>` : ''}</li>`;
    }).join('')}</ul></div>`;
  }
  if (samenvattingFout) uit += `<p style="${STIJL.klein}">Geen samenvatting: ${html(samenvattingFout)}. Hieronder staat wel alles wat nieuw is.</p>`;

  for (const c of categorieen(opslag, regio, items)) {
    uit += `<h3 style="${STIJL.h3}">${html(c.naam)}${c.items.length ? ` <span style="font-weight:normal;color:#6b6b66;">(${c.items.length})</span>` : ''}</h3>`;
    if (c.opmerkingen.length) uit += `<p style="${STIJL.klein};margin:0 0 10px;">${c.opmerkingen.map(html).join('<br>')}</p>`;
    if (c.items.length) uit += c.items.map(itemHtml).join('');
    else if (c.gecontroleerd) uit += `<p style="${STIJL.item};color:#6b6b66;">Geen nieuwe berichten.</p>`;
  }
  if (blok.landelijk.length) {
    uit += `<h3 style="${STIJL.h3}">Landelijke bronnen <span style="font-weight:normal;color:#6b6b66;">(${blok.landelijk.length})</span></h3>`;
    uit += blok.landelijk.map(landelijkHtml).join('');
  }
  if (blok.kamerTermen?.length) {
    const n = blok.kamerstukken.length;
    uit += `<h3 style="${STIJL.h3}">Kamerstukken${n ? ` <span style="font-weight:normal;color:#6b6b66;">(${n})</span>` : ''}</h3>`;
    uit += n
      ? blok.kamerstukken.map(trefferHtml).join('')
      : `<p style="${STIJL.item};color:#6b6b66;">Geen nieuwe kamerstukken met ${html(blok.kamerTermen.join(', '))}.</p>`;
    if (blok.kamerstukken.meer) uit += `<p style="${STIJL.item};color:#6b6b66;">${html(meerKamerstukken(blok.kamerstukken.meer))}${process.env.REGIOCHECKER_SITE_URL ? ` <a href="${html(process.env.REGIOCHECKER_SITE_URL)}/#/feed?groep=kamerstuk" style="color:#6b6b66;">Bekijk ze in de Regiochecker</a>.` : ''}</p>`;
  }
  if (blok.audio.length) {
    uit += `<h3 style="${STIJL.h3}">Raadsvergaderingen, audio en video <span style="font-weight:normal;color:#6b6b66;">(${blok.audio.length})</span></h3>`;
    uit += blok.audio.map(audioHtml).join('');
  }
  return `${uit}</div>`;
}

const duurTekst = (s) => (s ? `${Math.floor(s / 3600) ? `${Math.floor(s / 3600)} u ` : ''}${Math.round((s % 3600) / 60)} min` : '');

function landelijkHtml({ item, bron, gevonden }) {
  const termen = gevonden.map((g) => `${g.term}${g.aantal > 1 ? ` (${g.aantal}×)` : ''}`).join(', ');
  return `<div style="${STIJL.item}"><span style="color:#6b6b66;">${html(korteDatum(item.datum) || 'z.d.')}</span> &nbsp;<a href="${html(item.url)}" style="${STIJL.link}">${html(item.titel)}</a>
    <br><span style="${STIJL.klein}">${html(bron.naam)} · gevonden: <strong>${html(termen)}</strong></span>
    <div style="margin:4px 0 0 10px;padding-left:8px;border-left:2px solid #e3e1da;font-size:13px;color:#3b3b38;">${fragmentHtml(gevonden[0].fragment)}</div></div>`;
}

function audioHtml({ aflevering: a, bron, gevonden, samenvatting, samenvattingFout }) {
  const kenmerk = [ENKELVOUD[a.soort], duurTekst(a.duur)].filter(Boolean).join(' · ');
  let uit = `<div style="${STIJL.item}"><span style="color:#6b6b66;">${html(korteDatum(String(a.gepubliceerd || '').slice(0, 10)) || 'z.d.')}</span> &nbsp;<a href="${html(a.url)}" style="${STIJL.link}">${html(a.titel)}</a>
    <br><span style="${STIJL.klein}">${html([bron.naam, kenmerk].filter(Boolean).join(' · '))}</span>`;
  for (const g of gevonden || []) {
    uit += `<div style="margin:4px 0 0 10px;padding-left:8px;border-left:2px solid #e3e1da;font-size:13px;color:#3b3b38;"><strong>${tijdcode(g.treffers[0].tijd)}</strong> ${fragmentHtml(g.treffers[0].fragment)}${g.aantal > 1 ? ` <span style="color:#6b6b66;">(${g.aantal}× ${html(g.term)})</span>` : ''}</div>`;
  }
  uit += '</div>';
  for (const o of samenvatting?.onderwerpen || []) {
    uit += `<h4 style="font-size:16px;margin:14px 0 6px;">${html(o.kop)}</h4><ul style="margin:0 0 8px;padding:0 0 0 20px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;">${o.punten.map((p) => `<li style="margin:0 0 4px;">${html(p)}</li>`).join('')}</ul>`;
  }
  if (samenvattingFout) uit += `<p style="${STIJL.klein}">Geen samenvatting van de vergadering: ${html(samenvattingFout)}.</p>`;
  return uit;
}

function regioTekst(blok, opslag) {
  const { regio, items, samenvatting, samenvattingFout } = blok;
  const perSleutel = new Map(items.map((i) => [i.sleutel, i]));
  const r = [`== ${regio.naam.toUpperCase()} ==`, items.length ? `${items.length} nieuwe berichten` : 'Niets nieuws gevonden.', ''];
  for (const p of samenvatting?.punten || []) {
    r.push(`• ${p.zin}`);
    for (const k of p.items) if (perSleutel.has(k)) r.push(`  -> ${perSleutel.get(k).url}`);
  }
  if (samenvatting?.punten.length) r.push('');
  if (samenvattingFout) r.push(`Geen samenvatting: ${samenvattingFout}.`, '');
  for (const c of categorieen(opslag, regio, items)) {
    r.push(`-- ${c.naam}${c.items.length ? ` (${c.items.length})` : ''} --`, ...c.opmerkingen);
    for (const i of c.items) {
      r.push(`* ${korteDatum(i.datum) || 'z.d.'}  ${i.titel}${kenmerken(i) ? ` (${kenmerken(i)})` : ''}`, `  ${i.url}`);
    }
    if (!c.items.length && c.gecontroleerd) r.push('Geen nieuwe berichten.');
    r.push('');
  }
  if (blok.landelijk.length) {
    r.push(`-- Landelijke bronnen (${blok.landelijk.length}) --`);
    for (const { item, bron, gevonden } of blok.landelijk) {
      r.push(`* ${korteDatum(item.datum) || 'z.d.'}  ${item.titel}`, `  ${bron.naam} · gevonden: ${gevonden.map((g) => g.term).join(', ')}`, `  "${gevonden[0].fragment.tekst}"`, `  ${item.url}`);
    }
    r.push('');
  }
  if (blok.kamerTermen?.length) {
    r.push(`-- Kamerstukken${blok.kamerstukken.length ? ` (${blok.kamerstukken.length})` : ''} --`);
    if (blok.kamerstukken.length) r.push(...blok.kamerstukken.map(trefferTekst));
    else r.push(`Geen nieuwe kamerstukken met ${blok.kamerTermen.join(', ')}.`);
    if (blok.kamerstukken.meer) r.push(meerKamerstukken(blok.kamerstukken.meer) + (process.env.REGIOCHECKER_SITE_URL ? ` ${process.env.REGIOCHECKER_SITE_URL}/#/feed?groep=kamerstuk` : ''));
    r.push('');
  }
  if (blok.audio.length) {
    r.push(`-- Raadsvergaderingen, audio en video (${blok.audio.length}) --`);
    for (const { aflevering: a, bron, gevonden, samenvatting } of blok.audio) {
      r.push(`* ${korteDatum(String(a.gepubliceerd || '').slice(0, 10)) || 'z.d.'}  ${a.titel}`, `  ${bron.naam}`);
      for (const g of gevonden || []) r.push(`  ${tijdcode(g.treffers[0].tijd)} "${g.treffers[0].fragment.tekst}"`);
      for (const o of samenvatting?.onderwerpen || []) r.push(`  ${o.kop}`, ...o.punten.map((p) => `   - ${p}`));
      r.push(`  ${a.url}`);
    }
    r.push('');
  }
  return r.join('\n');
}

function onderwerp(blokken, sinds, nu) {
  const namen = blokken.map((b) => b.regio.naam).join(', ');
  const items = blokken.reduce((n, b) => n + b.items.length, 0);
  const aantal = items ? `${items} nieuw${items === 1 ? ' bericht' : 'e berichten'}` : 'niets nieuws';
  return `${namen}: ${aantal} (${korteDatum(lokaleDatum(new Date(sinds)))} – ${korteDatum(lokaleDatum(nu))})`;
}

// Stukken uit landelijke bronnen (niet de Tweede Kamer, die heeft een eigen
// kopje) met een sleutelwoord van deze regio.
function landelijkVoor(k, regio, sinds, tot) {
  const uit = [];
  for (const item of Object.values(k.opslag.items)) {
    if (item.regio || item.basislijn || item.eersteGezien <= sinds || item.eersteGezien > tot) continue;
    const bron = k.bronnen.get(item.bron);
    if (bron?.bereik !== 'landelijk' || bron.inMail === false) continue;
    const r = routeerItem(k, item, bron).find((x) => x.regio === regio.id);
    if (r) uit.push({ item, bron, gevonden: r.gevonden });
  }
  return uit.sort((a, b) => String(b.item.datum || '').localeCompare(String(a.item.datum || '')));
}

// Audio en video: alles van de regio zelf, en landelijke afleveringen waarin
// een sleutelwoord valt.
function audioVoor(k, regio, sinds, tot) {
  if (!k.adb) return [];
  const uit = [];
  for (const a of k.adb.metTranscriptSinds(sinds, tot)) {
    const bron = k.bronnen.get(a.bron);
    if (!bron) continue;
    if (bron.bereik === 'landelijk') {
      const r = routeerAflevering(k, a).find((x) => x.regio === regio.id);
      if (r) uit.push({ aflevering: a, bron, gevonden: r.gevonden });
    } else if (bron.regio === regio.id) {
      uit.push({ aflevering: a, bron, gevonden: [] });
    }
  }
  return uit;
}

// opties.sinds: ISO-tijd; standaard de vorige mail aan deze gebruiker.
// opties.samenvatting: false om het taalmodel over te slaan (snel voorbeeld).
export async function stelMailSamen(opslag, gebruiker, opties = {}) {
  const nu = opties.nu || new Date();
  const tot = nu.toISOString();
  const sinds = opties.sinds || gebruiker.laatsteMail || new Date(nu - EERSTE_MAIL_DAGEN * DAG_MS).toISOString();
  const k = maakKader({ opslag, kdb: opslag.kamer, fdb: opslag.feeddb, adb: opslag.audiodb });
  const regios = k.regios
    .filter((r) => gebruiker.regios.includes(r.id))
    .map((r) => ({ ...r, bronnen: bronnenVanRegio(opslag, r.id).filter((b) => !isAudioBron(b)) }));
  const aanbieder = samenvattingAanbieder(opslag);
  const samenvatten = opties.samenvatting !== false;

  const blokken = [];
  for (const [n, regio] of regios.entries()) {
    const items = nieuweItems(opslag, regio.id, sinds, tot);
    // Kamerstukken met de sleutelwoorden van deze regio (opslag.kamer: de
    // database, als die draait; zonder database of sleutelwoorden geen kopje).
    const kamerTermen = opslag.kamer && geldtVoor(regio, TWEEDE_KAMER.id) ? actieveTermen(regio) : [];
    const kamerstukken = kamerTermen.length ? opslag.kamer.treffers(kamerTermen, { sinds, tot, minDatum: minDatum(sinds) }) : [];
    const blok = {
      regio, items, kamerTermen, kamerstukken,
      landelijk: landelijkVoor(k, regio, sinds, tot),
      audio: audioVoor(k, regio, sinds, tot),
      samenvatting: null, samenvattingFout: null,
    };
    if (items.length && samenvatten) {
      if (!aanbieder.klaar) {
        blok.samenvattingFout = aanbieder.reden;
      } else {
        opties.voortgang?.({ stap: n + 1, totaal: regios.length, tekst: `Samenvatting ${n + 1} van ${regios.length}: ${regio.naam}` });
        try {
          blok.samenvatting = await maakSamenvatting({ opslag, regio, items });
        } catch (fout) {
          blok.samenvattingFout = fout.message;
          opslag.log({ soort: aanbieder.via === 'ollama' ? 'ollamafout' : 'claudefout', tekst: `${regio.naam}: ${fout.message}` });
        }
      }
    }
    // Per raadsvergadering van de regio een samenvatting per onderwerp.
    for (const a of blok.audio.filter((x) => x.aflevering.soort === 'raadsvergadering' && x.bron.bereik === 'regio')) {
      if (!samenvatten || !aanbieder.klaar) continue;
      opties.voortgang?.({ stap: n + 1, totaal: regios.length, tekst: `Samenvatting vergadering: ${a.aflevering.titel}` });
      try {
        a.samenvatting = await vatVergaderingSamen({ opslag, aflevering: a.aflevering, regioNaam: regio.naam });
      } catch (fout) {
        a.samenvattingFout = fout.message;
        opslag.log({ soort: aanbieder.via === 'ollama' ? 'ollamafout' : 'claudefout', tekst: `${regio.naam}, vergadering: ${fout.message}` });
      }
    }
    blokken.push(blok);
  }

  const sindsTekst = new Date(sinds).toLocaleString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const kopTekst = `Regiochecker · ${nu.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' })}`;
  const totTekst = nu.toLocaleString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const voet = `Je krijgt deze mail omdat je ${regios.map((r) => r.naam).join(', ')} volgt. Nieuw = voor het eerst gezien tussen ${sindsTekst} en ${totTekst}. Je weekmail stel je in bij Meldingen.`;
  const site = process.env.REGIOCHECKER_SITE_URL;

  const htmlMail = `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="${STIJL.body}"><div style="${STIJL.kader}">
<div style="${STIJL.kop}"><h1 style="${STIJL.h1}">${html(kopTekst)}</h1>
<div style="${STIJL.klein}">Gemeentenieuws, ingekomen stukken en Woo-publicaties van ${html(sindsTekst)} tot ${html(totTekst)}</div></div>
${blokken.map((b) => regioHtml(b, opslag)).join('<hr style="border:0;border-top:1px solid #e3e1da;margin:8px 28px;">')}
<div style="padding:18px 28px 26px;${STIJL.klein}">${html(voet)}${site ? ` <a href="${html(site)}/#/meldingen" style="color:#6b6b66;">${html(site)}/#/meldingen</a>` : ''}</div>
</div></body></html>`;

  const tekst = [kopTekst, '', ...blokken.map((b) => regioTekst(b, opslag)), voet, site || ''].join('\n');

  return {
    onderwerp: onderwerp(blokken, sinds, nu),
    html: htmlMail,
    tekst,
    aantal: blokken.reduce((n, b) => n + b.items.length + b.kamerstukken.length + b.landelijk.length + b.audio.length, 0),
    tot,
  };
}

export function smtpIngesteld(opslag) {
  return Boolean(opslag.instellingen.smtp.host);
}

export async function verstuur(opslag, { aan, onderwerp: titel, html: htmlMail, tekst }) {
  const smtp = opslag.instellingen.smtp;
  if (!smtp.host) throw new Error('SMTP is nog niet ingesteld');
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: Number(smtp.port) || 587,
    secure: Boolean(smtp.secure),
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    connectionTimeout: 20_000,
  });
  await transport.sendMail({
    from: smtp.from || smtp.user,
    to: aan,
    subject: titel,
    html: htmlMail,
    text: tekst,
  });
}

// Versturen gebeurt altijd één tegelijk. Twee rondes tegelijk (de klok en
// iemand die op "Mailronde nu versturen" drukt) zouden allebei de berichten
// sinds dezelfde vorige mail pakken en dus dubbel mailen.
let wachtrij = Promise.resolve();
function eenTegelijk(werk) {
  const resultaat = wachtrij.then(werk, werk);
  wachtrij = resultaat.catch(() => {});
  return resultaat;
}

// Eén gebruiker: samenstellen, versturen, en bij succes de "vorige mail"-tijd
// verschuiven. Mislukt het versturen, dan blijft die staan en komen dezelfde
// items de volgende keer opnieuw mee.
async function verstuurAan(opslag, gebruiker, { nu = new Date(), forceer = false, voortgang } = {}) {
  const mail = await stelMailSamen(opslag, gebruiker, { nu, voortgang });
  if (!mail.aantal && !gebruiker.weekmail?.ookLeeg && !forceer) {
    return { verstuurd: false, reden: 'niets nieuws' };
  }
  await verstuur(opslag, { aan: gebruiker.email, ...mail });
  gebruiker.laatsteMail = mail.tot;
  delete gebruiker.mailFout;
  opslag.bewaar('gebruikers');
  opslag.log({ soort: 'verzonden', aan: gebruiker.email, tekst: mail.onderwerp });
  return { verstuurd: true, onderwerp: mail.onderwerp };
}

export function mailGebruiker(opslag, gebruiker, opties = {}) {
  return eenTegelijk(() => verstuurAan(opslag, gebruiker, opties));
}

// Wie krijgt nu een weekmail? Iedereen met de weekmail aan, een e-mailadres,
// minstens één regio, en een verstuurmoment dat nog niet is afgehandeld.
export function teMailen(opslag, nu = new Date()) {
  return opslag.gebruikers.filter((g) => g.email && g.regios.length && weekmailNodig(nu, g));
}

// Iedereen met de weekmail aan, ongeacht het schema (knop "Mailronde nu versturen").
export const allemaalMetWeekmail = (opslag) => opslag.gebruikers.filter((g) => g.email && g.regios.length && g.weekmail?.aan);

export function mailronde(opslag, nu = new Date(), voortgang, gebruikers = teMailen(opslag, nu)) {
  return eenTegelijk(() => doeRonde(opslag, nu, voortgang, gebruikers));
}

async function doeRonde(opslag, nu, voortgang, gebruikers) {
  const resultaten = [];
  for (const [n, g] of gebruikers.entries()) {
    const melding = (v) => voortgang?.({ ...v, tekst: `Mail ${n + 1} van ${gebruikers.length} (${g.email}): ${v.tekst}` });
    melding({ tekst: 'samenstellen' });
    // Dit verstuurmoment is afgehandeld, ook als er niets nieuws was of het
    // versturen mislukte; een mislukte mail proberen we nog een dag opnieuw.
    g.laatsteWeekronde = nu.toISOString();
    try {
      resultaten.push({ gebruiker: g.id, email: g.email, ...(await verstuurAan(opslag, g, { nu, voortgang: melding })) });
    } catch (fout) {
      g.mailFout = { tijd: nu.toISOString(), fout: fout.message, pogingen: 1 };
      opslag.log({ soort: 'mailfout', aan: g.email, tekst: fout.message });
      resultaten.push({ gebruiker: g.id, email: g.email, verstuurd: false, fout: fout.message });
    }
  }
  opslag.bewaar('gebruikers');
  opslag.status.laatsteMailronde = { tijd: nu.toISOString(), resultaten };
  opslag.bewaar('status');
  return resultaten;
}

// Een mislukte verzending (SMTP even onbereikbaar) proberen we de rest van de
// dag elk half uur opnieuw. Lukt het niet, dan blijft de vorige-mail-tijd van
// die gebruiker staan en zit alles in de volgende weekmail.
export function herkansMislukte(opslag, nu = new Date()) {
  return eenTegelijk(() => herkans(opslag, nu));
}

async function herkans(opslag, nu) {
  let gewijzigd = false;
  for (const g of opslag.gebruikers.filter((x) => x.mailFout)) {
    const f = g.mailFout;
    if (nu - Date.parse(f.tijd) > DAG_MS || !g.weekmail?.aan || !g.email) {
      delete g.mailFout;
      gewijzigd = true;
      continue;
    }
    if (nu - Date.parse(f.laatstePoging || f.tijd) < HERKANSING_MS) continue;
    try {
      await verstuurAan(opslag, g, { nu });
      delete g.mailFout;
    } catch (fout) {
      Object.assign(f, { fout: fout.message, laatstePoging: nu.toISOString(), pogingen: (f.pogingen || 1) + 1 });
    }
    gewijzigd = true;
  }
  if (gewijzigd) opslag.bewaar('gebruikers');
}
