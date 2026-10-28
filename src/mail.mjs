// De mail per verslaggever. Opbouw: per gemeente een H2 met daaronder de
// samenvatting van wat er speelt, en dan altijd dezelfde drie H3's in vaste volgorde:
// Gemeentenieuws, Ingekomen stukken, Woo-publicaties. Ook een lege categorie
// krijgt zijn kop, zodat alles elke week op dezelfde plek staat; wat er bij een
// categorie niet gecontroleerd kon worden, staat onder die kop.
//
// De periode loopt altijd van de vorige mail aan deze ontvanger tot het moment
// van versturen. Ging er een week geen mail uit (niets nieuws, een fout, of de
// ontvanger stond uit), dan zit die week gewoon in de volgende mail. Wie nog
// nooit een mail kreeg, krijgt de afgelopen week.

import nodemailer from 'nodemailer';
import { REGIOS, SOORTEN } from './regios.mjs';
import { maakSamenvatting, samenvattingAanbieder } from './samenvatting.mjs';
import { html, kort } from './html.mjs';
import { korteDatum, lokaleDatum } from './datum.mjs';
import { minDatum } from './kamer/db.mjs';
import { trefferHtml, trefferTekst } from './kamer/weergave.mjs';

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
    if (bron.vervangend) regels.push(`Vervangende bron: ${bron.label}; ${bron.mailnotitie}.`);
    const status = opslag.status.bronnen[bron.id];
    if (status && !status.ok) regels.push(`${bron.label} kon de laatste keer niet worden opgehaald (${status.fout}).`);
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
  if (blok.kamerTermen?.length) {
    const n = blok.kamerstukken.length;
    uit += `<h3 style="${STIJL.h3}">Kamerstukken${n ? ` <span style="font-weight:normal;color:#6b6b66;">(${n})</span>` : ''}</h3>`;
    uit += n
      ? blok.kamerstukken.map(trefferHtml).join('')
      : `<p style="${STIJL.item};color:#6b6b66;">Geen nieuwe kamerstukken met ${html(blok.kamerTermen.join(', '))}.</p>`;
  }
  return `${uit}</div>`;
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
  if (blok.kamerTermen?.length) {
    r.push(`-- Kamerstukken${blok.kamerstukken.length ? ` (${blok.kamerstukken.length})` : ''} --`);
    if (blok.kamerstukken.length) r.push(...blok.kamerstukken.map(trefferTekst));
    else r.push(`Geen nieuwe kamerstukken met ${blok.kamerTermen.join(', ')}.`);
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

// opties.sinds: ISO-tijd; standaard de vorige mail aan deze ontvanger.
// opties.samenvatting: false om het taalmodel over te slaan (snel voorbeeld).
export async function stelMailSamen(opslag, ontvanger, opties = {}) {
  const nu = opties.nu || new Date();
  const tot = nu.toISOString();
  const sinds = opties.sinds || ontvanger.laatsteMail || new Date(nu - EERSTE_MAIL_DAGEN * DAG_MS).toISOString();
  const regios = REGIOS.filter((r) => ontvanger.regios.includes(r.id));

  const blokken = [];
  for (const [n, regio] of regios.entries()) {
    const items = nieuweItems(opslag, regio.id, sinds, tot);
    // Kamerstukken met de termen van deze regio (opslag.kamer: de database, als
    // die draait; zonder database geen kopje).
    const kamerTermen = opslag.kamer ? (opslag.kamertermen[regio.id] || []) : [];
    const kamerstukken = kamerTermen.length ? opslag.kamer.treffers(kamerTermen, { sinds, tot, minDatum: minDatum(sinds) }) : [];
    const blok = { regio, items, kamerTermen, kamerstukken, samenvatting: null, samenvattingFout: null };
    if (items.length && opties.samenvatting !== false) {
      const aanbieder = samenvattingAanbieder(opslag);
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
    blokken.push(blok);
  }

  const sindsTekst = new Date(sinds).toLocaleString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const kopTekst = `Regiochecker · ${nu.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' })}`;
  const totTekst = nu.toLocaleString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const voet = `Je krijgt deze mail omdat je ${regios.map((r) => r.naam).join(', ')} volgt. Nieuw = voor het eerst gezien tussen ${sindsTekst} en ${totTekst}.`;
  const site = process.env.REGIOCHECKER_SITE_URL;

  const htmlMail = `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="${STIJL.body}"><div style="${STIJL.kader}">
<div style="${STIJL.kop}"><h1 style="${STIJL.h1}">${html(kopTekst)}</h1>
<div style="${STIJL.klein}">Gemeentenieuws, ingekomen stukken en Woo-publicaties van ${html(sindsTekst)} tot ${html(totTekst)}</div></div>
${blokken.map((b) => regioHtml(b, opslag)).join('<hr style="border:0;border-top:1px solid #e3e1da;margin:8px 28px;">')}
<div style="padding:18px 28px 26px;${STIJL.klein}">${html(voet)}${site ? ` Instellingen: <a href="${html(site)}" style="color:#6b6b66;">${html(site)}</a>` : ''}</div>
</div></body></html>`;

  const tekst = [kopTekst, '', ...blokken.map((b) => regioTekst(b, opslag)), voet, site || ''].join('\n');

  return {
    onderwerp: onderwerp(blokken, sinds, nu),
    html: htmlMail,
    tekst,
    aantal: blokken.reduce((n, b) => n + b.items.length + b.kamerstukken.length, 0),
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

// Eén ontvanger: samenstellen, versturen, en bij succes de "vorige mail"-tijd
// verschuiven. Mislukt het versturen, dan blijft die staan en komen dezelfde
// items de volgende keer opnieuw mee.
async function verstuurAan(opslag, ontvanger, { nu = new Date(), forceer = false, voortgang } = {}) {
  const mail = await stelMailSamen(opslag, ontvanger, { nu, voortgang });
  if (!mail.aantal && !opslag.instellingen.mailBijNiets && !forceer) {
    return { verstuurd: false, reden: 'niets nieuws' };
  }
  await verstuur(opslag, { aan: ontvanger.email, ...mail });
  ontvanger.laatsteMail = mail.tot;
  opslag.bewaar('ontvangers');
  opslag.log({ soort: 'verzonden', aan: ontvanger.email, tekst: mail.onderwerp });
  return { verstuurd: true, onderwerp: mail.onderwerp };
}

export function mailOntvanger(opslag, ontvanger, opties = {}) {
  return eenTegelijk(() => verstuurAan(opslag, ontvanger, opties));
}

export function mailronde(opslag, nu = new Date(), voortgang) {
  return eenTegelijk(() => doeRonde(opslag, nu, voortgang));
}

async function doeRonde(opslag, nu, voortgang) {
  const resultaten = [];
  const ontvangers = opslag.ontvangers.filter((o) => o.actief && o.regios.length);
  for (const [n, ontvanger] of ontvangers.entries()) {
    const melding = (v) => voortgang?.({ ...v, tekst: `Mail ${n + 1} van ${ontvangers.length} (${ontvanger.email}): ${v.tekst}` });
    melding({ tekst: 'samenstellen' });
    try {
      resultaten.push({ email: ontvanger.email, ...(await verstuurAan(opslag, ontvanger, { nu, voortgang: melding })) });
    } catch (fout) {
      opslag.log({ soort: 'mailfout', aan: ontvanger.email, tekst: fout.message });
      resultaten.push({ email: ontvanger.email, verstuurd: false, fout: fout.message });
    }
  }
  opslag.status.laatsteMailronde = { tijd: nu.toISOString(), resultaten };
  opslag.bewaar('status');
  return resultaten;
}

// Een mislukte verzending (SMTP even onbereikbaar) proberen we de rest van de
// dag elk half uur opnieuw. Lukt het niet, dan blijft de vorige-mail-tijd van
// die ontvanger staan en zit alles in de mail van volgende week.
export function herkansMislukte(opslag, nu = new Date()) {
  return eenTegelijk(() => herkans(opslag, nu));
}

async function herkans(opslag, nu) {
  const ronde = opslag.status.laatsteMailronde;
  if (!ronde || nu - Date.parse(ronde.tijd) > DAG_MS) return;
  const mislukt = ronde.resultaten.filter((r) => r.fout);
  if (!mislukt.length || nu - Date.parse(ronde.laatsteHerkansing || ronde.tijd) < HERKANSING_MS) return;
  for (const r of mislukt) {
    const ontvanger = opslag.ontvangers.find((o) => o.email === r.email && o.actief && o.regios.length);
    if (!ontvanger) {
      r.fout = null;
      continue;
    }
    try {
      Object.assign(r, await verstuurAan(opslag, ontvanger, { nu }), { fout: null, herkansing: true });
    } catch (fout) {
      r.fout = fout.message;
    }
  }
  ronde.laatsteHerkansing = nu.toISOString();
  opslag.bewaar('status');
}

