// Directe meldingen: een mail zodra er een nieuw stuk binnenkomt met een van
// de zoektermen van een journalist. Per melding:
//   termen      "stikstof" OR natura2000 (src/termen.mjs); leeg = alles binnen
//               bereik en bronnen (dan niet 'overal')
//   bereik      'overal', 'mijn' (de regio's van de journalist) of één regio
//   bronnen     'alle', 'gemeente' (gemeentelijke en landelijke websites),
//               'kamerstuk' of 'audio'
//   frequentie  'direct': na elke ronde waarin iets gevonden is (websites elk
//               uur, kamerstukken elk half uur, audio elk kwartier);
//               'dagelijks': hooguit één mail per dag, vanaf `tijd`
//
// "Nieuw" = binnengekomen na de vorige melding. Een kamerstuk dat we pas laat
// binnenhalen en dat al ouder is dan twee weken, telt niet: zo geeft de eerste
// keer inhalen geen stortvloed. Het zoeken zelf staat in src/feed.mjs, zodat
// de feed en de mail precies dezelfde stukken vinden.

import { verstuur, meerKamerstukken } from './mail.mjs';
import { html } from './html.mjs';
import { lokaleDatum, korteDatum } from './datum.mjs';
import { ENKELVOUD } from './regios.mjs';
import { schoneTermen, leesZoekvraag, zoekvraagTekst } from './termen.mjs';
import { maakKader, meldingTreffers } from './feed.mjs';
import { trefferHtml, trefferTekst, fragmentHtml } from './kamer/weergave.mjs';
import { InvoerFout } from './gebruikers.mjs';

export const BEREIK = ['overal', 'mijn'];
export const BRONNEN = { alle: 'Alle bronnen', gemeente: 'Alleen websites', kamerstuk: 'Alleen Kamerstukken', audio: 'Alleen audio en video' };
export const FREQUENTIES = ['direct', 'dagelijks'];
const TIJD = /^([01]\d|2[0-3]):[0-5]\d$/;
const KLEIN = 'font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#6b6b66;';

export function controleerMelding(invoer, bestaand, { regioIds }) {
  const termen = invoer.zoekvraag !== undefined ? leesZoekvraag(invoer.zoekvraag) : schoneTermen(invoer.termen ?? bestaand?.termen ?? []);
  const bereik = invoer.bereik ?? bestaand?.bereik ?? 'mijn';
  if (!BEREIK.includes(bereik) && !regioIds.includes(bereik)) throw new InvoerFout('Onbekend bereik');
  // Zonder zoekterm krijg je alles binnen de keuze; overal zou alles zijn wat
  // er binnenkomt (honderden Kamerstukken per week).
  if (!termen.length && bereik === 'overal') throw new InvoerFout('Kies zonder zoekterm een regio of je eigen regio\'s; overal zonder zoekterm is alles wat binnenkomt');
  const bronnen = invoer.bronnen ?? bestaand?.bronnen ?? 'alle';
  if (!BRONNEN[bronnen]) throw new InvoerFout('Onbekende keuze voor de bronnen');
  const frequentie = invoer.frequentie ?? bestaand?.frequentie ?? 'direct';
  if (!FREQUENTIES.includes(frequentie)) throw new InvoerFout('Kies direct of dagelijks');
  const tijd = invoer.tijd ?? bestaand?.tijd ?? '17:00';
  if (!TIJD.test(tijd)) throw new InvoerFout('Tijd moet de vorm UU:MM hebben');
  return { termen, bereik, bronnen, frequentie, tijd, actief: Boolean(invoer.actief ?? bestaand?.actief ?? true) };
}

function regelHtml(r) {
  const termen = r.gevonden.map((g) => `${g.term}${g.aantal > 1 ? ` (${g.aantal}×)` : ''}`).join(', ');
  const tijd = (s) => {
    const t = Math.max(0, Math.floor(s || 0));
    return `${t >= 3600 ? `${Math.floor(t / 3600)}:` : ''}${String(Math.floor(t / 60) % 60).padStart(t >= 3600 ? 2 : 1, '0')}:${String(t % 60).padStart(2, '0')}`;
  };
  return `<div style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;">
    <span style="color:#6b6b66;">${html(korteDatum(r.datum) || 'z.d.')}</span> &nbsp;<a href="${html(r.url)}" style="color:#1d1d1b;">${html(r.titel)}</a>
    <br><span style="${KLEIN}">${html([r.regioNaam, ENKELVOUD[r.soort]].filter(Boolean).join(' · '))}</span>
    ${termen ? `<br><span style="${KLEIN}">Gevonden: <strong>${html(termen)}</strong></span>` : ''}
    ${r.gevonden.slice(0, 2).map((g) => `<div style="margin:4px 0 0 10px;padding-left:8px;border-left:2px solid #e3e1da;font-size:13px;color:#3b3b38;">${g.tijd !== undefined ? `<strong>${tijd(g.tijd)}</strong> ` : ''}${fragmentHtml(g.fragment)}</div>`).join('')}
  </div>`;
}

function regelTekst(r) {
  return [
    `* ${korteDatum(r.datum) || 'z.d.'}  ${r.titel}`,
    `  ${[r.regioNaam, ENKELVOUD[r.soort]].filter(Boolean).join(' · ')}`,
    ...(r.gevonden.length ? [`  Gevonden: ${r.gevonden.map((g) => g.term).join(', ')}`] : []),
    ...r.gevonden.slice(0, 2).map((g) => `  "${g.fragment.tekst}"`),
    `  ${r.url}`,
  ].join('\n');
}

const GROEPEN = [
  ['kamerstuk', 'Kamerstukken'],
  ['gemeente', 'Websites van gemeenten en andere bronnen'],
  ['audio', 'Audio en video'],
];
const groepVanRegel = (r) => (r.soort === 'kamerstuk' ? 'kamerstuk' : r.id.startsWith('a:') ? 'audio' : 'gemeente');

// Wat een melding zonder zoekterm omvat: "Smallingerland" of "je regio's",
// met de bronnen als die beperkt zijn.
function selectieTekst(melding, regioNaam) {
  const waar = melding.bereik === 'mijn' ? 'je regio\'s' : regioNaam(melding.bereik) || melding.bereik;
  const wat = { gemeente: 'websites', kamerstuk: 'Kamerstukken', audio: 'audio en video' }[melding.bronnen];
  return `${waar}${wat ? `, alleen ${wat}` : ''}`;
}

// Hoe een melding heet, op het scherm en in de mail.
export function meldingNaam(melding, regioNaam = () => null) {
  return melding.termen?.length ? zoekvraagTekst(melding.termen) : `Alles uit ${selectieTekst(melding, regioNaam)}`;
}

export function stelMeldingSamen(melding, treffers, nu = new Date(), { meer = 0, regioNaam = () => null } = {}) {
  const alles = !melding.termen?.length;
  const gevonden = new Set(treffers.flatMap((t) => t.gevonden.map((g) => g.term)));
  const termen = (melding.termen || []).filter((t) => gevonden.has(t));
  const aantal = `${treffers.length} nieuw${treffers.length === 1 ? ' stuk' : 'e stukken'}`;
  const naam = meldingNaam(melding, regioNaam);
  const onderwerp = alles
    ? `Melding: ${aantal} uit ${selectieTekst(melding, regioNaam)} (${korteDatum(lokaleDatum(nu))})`
    : `Melding: ${aantal} met ${termen.slice(0, 3).join(', ')}${termen.length > 3 ? ' …' : ''} (${korteDatum(lokaleDatum(nu))})`;
  const site = process.env.REGIOCHECKER_SITE_URL;
  const voet = alles
    ? `Je krijgt deze melding voor alles wat er nieuw binnenkomt uit ${selectieTekst(melding, regioNaam)}.`
    : `Je krijgt deze melding omdat je stukken volgt met: ${zoekvraagTekst(melding.termen)}.`;
  let inhoud = '';
  const tekst = [`Melding: ${naam}`, ''];
  for (const [groep, kop] of GROEPEN) {
    const lijst = treffers.filter((t) => groepVanRegel(t) === groep);
    if (!lijst.length) continue;
    inhoud += `<h3 style="font-size:19px;margin:18px 0 10px;padding-bottom:4px;border-bottom:1px solid #e3e1da;">${kop} <span style="font-weight:normal;color:#6b6b66;">(${lijst.length})</span></h3>`;
    inhoud += lijst.map((t) => (t.stuk ? trefferHtml({ stuk: t.stuk, gevonden: t.gevonden }) : regelHtml(t))).join('');
    tekst.push(`-- ${kop} (${lijst.length}) --`, ...lijst.map((t) => (t.stuk ? trefferTekst({ stuk: t.stuk, gevonden: t.gevonden }) : regelTekst(t))), '');
    if (groep === 'kamerstuk' && meer) {
      const zoek = !site ? '' : alles ? `${site}/#/feed?groep=kamerstuk` : `${site}/#/zoeken?q=${encodeURIComponent(zoekvraagTekst(melding.termen))}`;
      inhoud += `<p style="${KLEIN}">${html(meerKamerstukken(meer))}${zoek ? ` <a href="${html(zoek)}" style="color:#6b6b66;">Bekijk ze in de Regiochecker</a>.` : ''}</p>`;
      tekst.splice(tekst.length - 1, 0, meerKamerstukken(meer) + (zoek ? ` ${zoek}` : ''));
    }
  }
  tekst.push(voet);
  const htmlMail = `<!doctype html><html lang="nl"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f4f1;"><div style="max-width:680px;margin:0 auto;background:#fff;font-family:Georgia,'Times New Roman',serif;color:#1d1d1b;">
<div style="padding:22px 28px 14px;border-bottom:3px solid #1d1d1b;"><h1 style="font-size:26px;margin:0 0 4px;">${html(naam)}</h1>
<div style="${KLEIN}">${aantal}${alles ? '' : ` met ${html(termen.join(', '))}`}</div></div>
<div style="padding:4px 28px 8px;">${inhoud}</div>
<div style="padding:8px 28px 26px;${KLEIN}">${html(voet)}${site ? ` Instellen: <a href="${html(site)}/#/meldingen" style="color:#6b6b66;">${html(site)}/#/meldingen</a>` : ''}</div>
</div></body></html>`;
  return { onderwerp, html: htmlMail, tekst: tekst.join('\n') };
}

function moment(nu, tijd) {
  const [uur, minuut] = String(tijd || '07:00').split(':').map(Number);
  return new Date(nu.getFullYear(), nu.getMonth(), nu.getDate(), uur || 0, minuut || 0);
}

// Na elke ronde. Nooit twee tegelijk: de rondes van websites, kamerstukken en
// audio lopen los van elkaar, en zouden anders allebei dezelfde stukken mailen.
let wachtrij = Promise.resolve();
export function verwerkMeldingen(ctx, opties = {}) {
  const resultaat = wachtrij.then(() => verwerk(ctx, opties));
  wachtrij = resultaat.catch(() => {});
  return resultaat;
}

async function verwerk(ctx, { nu = new Date() } = {}) {
  const { opslag } = ctx;
  const k = maakKader(ctx);
  const resultaten = [];
  const vandaag = lokaleDatum(nu);
  for (const melding of opslag.meldingen.filter((m) => m.actief !== false)) {
    const gebruiker = opslag.gebruikers.find((g) => g.id === melding.gebruiker);
    if (!gebruiker?.email) continue;
    // Een dagelijkse melding één keer per dag; als afgehandeld pas als de mail
    // weg is (of er niets te melden was), zodat een mailfout dezelfde dag herkanst.
    const dagelijks = melding.frequentie === 'dagelijks';
    if (dagelijks && (nu < moment(nu, melding.tijd) || melding.laatsteDagronde === vandaag)) continue;
    const sinds = melding.laatsteMelding || melding.aangemaakt;
    const tot = nu.toISOString();
    const gevonden = meldingTreffers(k, gebruiker, melding, { sinds, tot });
    const treffers = gevonden
      .map((t) => ({ ...t, regioNaam: t.regios.map((r) => k.regioMap.get(r)?.naam).filter(Boolean).join(', ') }))
      .sort((a, b) => b.tijd.localeCompare(a.tijd));
    if (!treffers.length) {
      if (dagelijks) melding.laatsteDagronde = vandaag;
      resultaten.push({ id: melding.id, verstuurd: false });
      continue;
    }
    try {
      const mail = stelMeldingSamen(melding, treffers, nu, { meer: gevonden.meerKamerstukken || 0, regioNaam: (id) => k.regioMap.get(id)?.naam });
      await verstuur(opslag, { aan: gebruiker.email, ...mail });
      melding.laatsteMelding = tot;
      melding.laatsteFout = null;
      if (dagelijks) melding.laatsteDagronde = vandaag;
      opslag.log({ soort: 'melding', aan: gebruiker.email, tekst: mail.onderwerp });
      resultaten.push({ id: melding.id, verstuurd: true, aantal: treffers.length });
    } catch (fout) {
      // laatsteMelding blijft staan: de volgende ronde probeert het opnieuw.
      melding.laatsteFout = fout.message;
      opslag.log({ soort: 'mailfout', aan: gebruiker.email, tekst: `Melding: ${fout.message}` });
      resultaten.push({ id: melding.id, verstuurd: false, fout: fout.message });
    }
  }
  opslag.bewaar('meldingen');
  return resultaten;
}
