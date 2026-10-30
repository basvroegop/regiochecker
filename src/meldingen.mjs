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
import { html, kort } from './html.mjs';
import { lokaleDatum, korteDatum } from './datum.mjs';
import { ENKELVOUD } from './regios.mjs';
import { schoneTermen, leesZoekvraag, zoekvraagTekst, vindTermen } from './termen.mjs';
import { maakKader, meldingTreffers } from './feed.mjs';
import { tekstBlokken } from './document.mjs';
import { tijdcode } from './vergadering.mjs';
import { stijl, mailHtml, rij, letter, FAMILIE, sectieKop, fragmentBlok, markeerTermen, knoppen, zacht, link, moment as tijdstip } from './mailstijl.mjs';
import { InvoerFout } from './gebruikers.mjs';

export const BEREIK = ['overal', 'mijn'];
export const BRONNEN = { alle: 'Alle bronnen', gemeente: 'Alleen websites', kamerstuk: 'Alleen Kamerstukken', audio: 'Alleen audio en video' };
export const FREQUENTIES = ['direct', 'dagelijks'];
const TIJD = /^([01]\d|2[0-3]):[0-5]\d$/;

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

// ---------- de tekst van een stuk ----------

// Onder het fragment staat de tekst van het stuk, als de mail hooguit drie
// stukken heeft (anders wordt hij te lang). Tot ongeveer 600 woorden, afgekapt
// op een alineagrens.
const MAX_WOORDEN = 600;
export const MAX_MET_TEKST = 3;
const AUDIO_RUIMTE_S = 120;
const woordenIn = (t) => (String(t || '').match(/\S+/g) || []).length;
const gelijk = (a, b) => String(a || '').toLowerCase().replace(/\s+/g, ' ').trim() === String(b || '').toLowerCase().replace(/\s+/g, ' ').trim();
const datumLang = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });

// Waar de tekst vandaan komt: kamerstukken uit de kamerdatabase, stukken van
// websites uit het opgehaalde document (of de korte inhoud), audio uit de
// segmenten rond de eerste treffer (twee minuten ervoor en erna, per alinea de
// tijd). Een aflevering zonder treffer (melding zonder zoekterm): de korte
// samenvatting. Geen tekst: null, dan komt er geen blok.
// `termen`: de zoektermen van de melding. Valt de eerste vondst buiten de
// eerste 600 woorden, dan het stuk tekst eromheen (met één alinea ervoor).
export function documentVoorMail(k, t, termen = []) {
  let alineas = [];
  let kop = 'Documenttekst';
  const meta = [];
  let totaal = null;
  if (t.stuk) {
    alineas = tekstBlokken(String(k.kdb?.tekst(t.stuk.nr) || '').slice(0, 200_000)).map(([soort, tekst]) => ({ soort, tekst }));
    if (t.stuk.datum) meta.push(`datum stuk ${datumLang(t.stuk.datum)}`);
  } else if (t.id.startsWith('i:')) {
    const item = k.opslag.items[t.id.slice(2)];
    if (!item) return null;
    const doc = k.fdb?.document(item.sleutel);
    const blokken = doc?.blokken?.length ? doc.blokken : tekstBlokken(item.inhoud || item.tekst || '');
    alineas = blokken.map(([soort, tekst]) => ({ soort, tekst }));
    if (alineas[0]?.soort === 'k' && gelijk(alineas[0].tekst, item.titel)) alineas.shift();
  } else if (t.id.startsWith('a:')) {
    const a = k.adb?.aflevering(t.id.slice(2));
    if (!a) return null;
    const tijd = t.gevonden[0]?.tijd;
    if (tijd === undefined) {
      if (!a.samenvatting?.tekst) return null;
      const w = woordenIn(a.samenvatting.tekst);
      return { kop: 'Samenvatting', meta: 'automatisch gemaakt; controleer altijd de opname zelf', alineas: [{ soort: 'p', tekst: a.samenvatting.tekst }], getoond: w, totaal: w, deel: false };
    }
    kop = 'Transcript';
    // Per spreker een alinea, met de tijd waarop die begint.
    for (const seg of a.segmenten || []) {
      if (seg.start < tijd - AUDIO_RUIMTE_S || seg.start > tijd + AUDIO_RUIMTE_S || !String(seg.text || '').trim()) continue;
      const vorige = alineas.at(-1);
      if (vorige && vorige.spreker === seg.speaker && seg.start - vorige.tijd < 90) vorige.tekst += ` ${seg.text.trim()}`;
      else alineas.push({ soort: 'p', tekst: seg.text.trim(), tijd: seg.start, spreker: seg.speaker });
    }
    totaal = woordenIn(a.transcript);
    meta.push(`${tijdcode(Math.max(0, tijd - AUDIO_RUIMTE_S))}–${tijdcode(tijd + AUDIO_RUIMTE_S)}`);
  }
  alineas = alineas.filter((a) => String(a.tekst || '').trim());
  if (!alineas.length) return null;
  totaal ??= alineas.reduce((n, a) => n + woordenIn(a.tekst), 0);
  let begin = 0;
  if (termen.length && kop !== 'Transcript') {
    const eerste = alineas.findIndex((a) => vindTermen(a.tekst, termen).length);
    const ervoor = alineas.slice(0, eerste + 1).reduce((n, a) => n + woordenIn(a.tekst), 0);
    if (eerste > 0 && ervoor > MAX_WOORDEN) begin = eerste - 1;
  }
  const getoond = [];
  let n = 0;
  for (const a of alineas.slice(begin)) {
    const w = woordenIn(a.tekst);
    if (getoond.length && n + w > MAX_WOORDEN) break;
    // Eén reusachtige eerste alinea (een pdf zonder alinea's): op woorden afkappen.
    if (w > MAX_WOORDEN) {
      getoond.push({ ...a, tekst: `${a.tekst.split(/\s+/).slice(0, MAX_WOORDEN).join(' ')} …` });
      n = MAX_WOORDEN;
      break;
    }
    getoond.push(a);
    n += w;
  }
  // Niet eindigen op een kop zonder de tekst eronder.
  while (getoond.length > 1 && getoond.at(-1).soort === 'k') n -= woordenIn(getoond.pop().tekst);
  if (kop !== 'Transcript') meta.unshift(`${totaal} woorden`);
  return { kop, meta: meta.join(' · '), alineas: getoond, getoond: n, totaal, deel: n < totaal, halverwege: begin > 0 };
}

// ---------- de mail ----------

const opsomming = (lijst) => (lijst.length > 1 ? `${lijst.slice(0, -1).join(', ')} en ${lijst.at(-1)}` : lijst[0] || '');
const bijBron = (t) => (t.stuk ? 'Bij de Tweede Kamer' : t.bronNaam ? `Bij ${t.bronNaam.split(' · ')[0]}` : 'Bij de bron');
const openUrl = (t, site) => (site ? `${site}/#/feed?stuk=${encodeURIComponent(t.id)}` : null);

function kenmerkenVan(t) {
  if (t.stuk) return ['Tweede Kamer', t.stuk.soort, t.stuk.nummer, t.stuk.afzender].filter(Boolean).join(' · ');
  return [t.bronNaam, korteDatum(t.datum)].filter(Boolean).join(' · ');
}

// Eén stuk: (bij één stuk) waarom, dan soort en regio, titel, kenmerken, het
// fragmentblok, de tekst van het stuk, en de knoppen.
function stukHtml(t, { s, alles, selectie, document, termen, site, enkel }) {
  const gevonden = [...new Set(t.gevonden.map((g) => g.term))];
  const open = openUrl(t, site);
  let uit = '';
  if (enkel) {
    const waarom = alles
      ? `Nieuw uit ${html(selectie)}.`
      : `Een nieuw stuk bevat je ${gevonden.length > 1 ? 'zoektermen' : 'zoekterm'} ${opsomming(gevonden.map((g) => `<strong style="font-weight:600;color:${s.a700};">${html(g)}</strong>`))}.`;
    uit += `<p style="margin:0 0 12px;${letter(400, 13, 1.5)}color:${s.n800};">${waarom}</p>`;
  }
  uit += `<p style="margin:0;${letter(600, 11, 1.4)}letter-spacing:.08em;text-transform:uppercase;color:${s.tweede};">${html([ENKELVOUD[t.soort], t.regioNaam].filter(Boolean).join(' · '))}</p>`;
  uit += `<h2 class="rc-titel" style="margin:12px 0 0;${FAMILIE}${letter(800, enkel ? 25 : 22, 1.2)}color:${s.inkt};">${open ? `<a href="${html(open)}" style="color:${s.inkt};text-decoration:none;">${html(t.titel)}</a>` : html(t.titel)}</h2>`;
  const kenmerken = kenmerkenVan(t);
  if (kenmerken) uit += `<p style="margin:12px 0 0;${letter(400, 13, 1.5)}color:${s.tweede};">${html(kenmerken)}</p>`;
  if (t.gevonden.length) uit += `<div style="margin-top:16px;">${fragmentBlok(t.gevonden.slice(0, 2).map((g) => ({ fragment: g.fragment, tijd: g.tijd })), s, { tijdcode })}</div>`;
  if (document) {
    uit += `<div style="margin-top:24px;padding:0 0 8px;border-bottom:2px solid ${s.inkt};"><span style="${letter(800, 16, 1.2)}color:${s.inkt};">${html(document.kop)}</span>${document.meta ? `<span style="${letter(400, 12, 1.2)}color:${s.tweede};">&nbsp;&nbsp; ${html(document.meta)}</span>` : ''}</div>`;
    if (document.halverwege) uit += `<p style="margin:12px 0 0;${letter(400, 12, 1.5)}color:${s.tweede};">… eerder in de tekst; hieronder het deel met de eerste vondst.</p>`;
    for (const a of document.alineas) {
      const tekst = `${a.tijd !== undefined ? `<strong>${tijdcode(a.tijd)}</strong> ` : ''}${markeerTermen(a.tekst, termen, s)}`;
      uit += a.soort === 'k'
        ? `<p style="margin:16px 0 0;${letter(800, 15, 1.4)}color:${s.inkt};">${tekst}</p>`
        : `<p style="margin:12px 0 0;${letter(400, 15, 1.6)}color:${s.inkt};">${a.soort === 'l' ? '•&nbsp; ' : ''}${tekst}</p>`;
    }
    if (document.deel) {
      uit += `<p style="margin:12px 0 0;${letter(400, 12, 1.5)}color:${s.tweede};">Dit is een deel van de ${document.kop === 'Transcript' ? 'opname' : 'tekst'}${document.halverwege ? ', rond de eerste vondst' : ''} (${document.getoond} van ${document.totaal} woorden).${open ? ` ${link('Lees verder in Regiochecker →', open, s)}` : ''}</p>`;
    }
  }
  uit += `<div style="margin-top:24px;">${knoppen([{ tekst: 'Openen in Regiochecker', url: open }, { tekst: bijBron(t), url: t.url, tweede: true }], s)}</div>`;
  return uit;
}

function stukTekst(t, { document, site }) {
  const r = [[ENKELVOUD[t.soort], t.regioNaam].filter(Boolean).join(' · ').toUpperCase(), t.titel];
  const kenmerken = kenmerkenVan(t);
  if (kenmerken) r.push(kenmerken);
  for (const g of t.gevonden.slice(0, 2)) r.push(`  ${g.tijd !== undefined ? `${tijdcode(g.tijd)} ` : ''}“${g.fragment.tekst}”`);
  if (document) {
    r.push('', `  ${document.kop}${document.meta ? ` (${document.meta})` : ''}`);
    if (document.halverwege) r.push('    …');
    for (const a of document.alineas) r.push(`    ${a.tijd !== undefined ? `${tijdcode(a.tijd)} ` : ''}${a.tekst}`);
    if (document.deel) r.push(`    (Dit is een deel: ${document.getoond} van ${document.totaal} woorden.)`);
  }
  r.push('');
  if (openUrl(t, site)) r.push(`Openen in Regiochecker: ${openUrl(t, site)}`);
  if (t.url) r.push(`${bijBron(t)}: ${t.url}`);
  return r.join('\n');
}

// opties.documenten: Map van stuk-id naar documentVoorMail(), alleen bij
// hooguit drie stukken. opties.titel: LC of DVHN (de accentkleur).
export function stelMeldingSamen(melding, treffers, nu = new Date(), { meer = 0, regioNaam = () => null, titel = 'LC', documenten = new Map() } = {}) {
  const s = stijl(titel);
  const alles = !melding.termen?.length;
  const selectie = selectieTekst(melding, regioNaam);
  const gevonden = new Set(treffers.flatMap((t) => t.gevonden.map((g) => g.term)));
  const termen = (melding.termen || []).filter((t) => gevonden.has(t));
  const aantal = `${treffers.length} nieuw${treffers.length === 1 ? ' stuk' : 'e stukken'}`;
  const site = process.env.REGIOCHECKER_SITE_URL;
  const enkel = treffers.length === 1;
  const eerste = treffers[0];

  // Eén stuk: "{term}: {titel}"; meer: zoals altijd.
  const onderwerp = enkel
    ? `${alles ? eerste.regioNaam?.split(', ')[0] || 'Nieuw' : eerste.gevonden[0]?.term || termen[0]}: ${kort(eerste.titel, 90)}`
    : alles
      ? `Melding: ${aantal} uit ${selectie} (${korteDatum(lokaleDatum(nu))})`
      : `Melding: ${aantal} met ${termen.slice(0, 3).join(', ')}${termen.length > 3 ? ' …' : ''} (${korteDatum(lokaleDatum(nu))})`;
  const preheader = eerste ? [eerste.bronNaam, eerste.regioNaam, eerste.gevonden[0] && `“…${kort(eerste.gevonden[0].fragment.tekst.replace(/^…|…$/g, ''), 110)}…”`].filter(Boolean).join(' · ') : '';

  const waar = melding.bereik === 'mijn' ? 'in je regio’s' : melding.bereik === 'overal' ? 'overal' : `in ${regioNaam(melding.bereik) || melding.bereik}`;
  const beperkt = { gemeente: 'alleen websites', kamerstuk: 'alleen Kamerstukken', audio: 'alleen audio en video' }[melding.bronnen];
  const soortMelding = melding.frequentie === 'dagelijks' ? 'dagelijkse' : 'directe';
  const reden = alles
    ? `Je krijgt deze mail omdat je een ${soortMelding} melding hebt voor alles uit ${selectie}.`
    : `Je krijgt deze mail omdat je een ${soortMelding} melding hebt op ‘${zoekvraagTekst(melding.termen)}’ ${waar}${beperkt ? ` (${beperkt})` : ''}.`;

  const rijen = [];
  const tekst = [`Regiochecker · Melding · ${tijdstip(nu)}`, ''];
  if (enkel) {
    const document = documenten.get(eerste.id) || null;
    rijen.push(rij(stukHtml(eerste, { s, alles, selectie, document, termen: melding.termen, site, enkel: true }), '28px 28px 28px'));
    tekst.push(alles ? `Nieuw uit ${selectie}.` : `Een nieuw stuk bevat je zoekterm ${[...new Set(eerste.gevonden.map((g) => g.term))].join(', ')}.`, '', stukTekst(eerste, { document, site }), '');
  } else {
    const intro = alles ? `${aantal} uit ${html(selectie)}.` : `${aantal} met je ${termen.length > 1 ? 'zoektermen' : 'zoekterm'} ${opsomming(termen.map((g) => `<strong style="font-weight:600;color:${s.a700};">${html(g)}</strong>`))}.`;
    rijen.push(rij(`<p style="margin:0;${letter(400, 13, 1.5)}color:${s.n800};">${intro}</p>`, '28px 28px 0'));
    tekst.push(`${aantal} ${alles ? `uit ${selectie}` : `met ${termen.join(', ')}`}.`, '');
    for (const [groep, kop] of GROEPEN) {
      const lijst = treffers.filter((t) => groepVanRegel(t) === groep);
      if (!lijst.length) continue;
      rijen.push(rij(sectieKop('h3', kop, String(lijst.length), s), '28px 28px 0'));
      tekst.push(`-- ${kop} (${lijst.length}) --`, '');
      lijst.forEach((t, i) => {
        const document = documenten.get(t.id) || null;
        rijen.push(rij(`<div style="${i ? `border-top:2px solid ${s.inkt};` : ''}padding:${i ? '24px' : '20px'} 0 4px;">${stukHtml(t, { s, alles, selectie, document, termen: melding.termen, site, enkel: false })}</div>`));
        tekst.push(stukTekst(t, { document, site }), '');
      });
      if (groep === 'kamerstuk' && meer) {
        const zoek = !site ? '' : alles ? `${site}/#/feed?groep=kamerstuk` : `${site}/#/zoeken?q=${encodeURIComponent(zoekvraagTekst(melding.termen))}`;
        rijen.push(rij(zacht(`${html(meerKamerstukken(meer))}${zoek ? ` ${link('Bekijk ze in de Regiochecker', zoek, s)}.` : ''}`, s, '16px 0 0')));
        tekst.push(meerKamerstukken(meer) + (zoek ? ` ${zoek}` : ''), '');
      }
    }
    rijen.push(rij('&nbsp;', '12px 28px'));
  }
  tekst.push(reden);
  if (site) tekst.push(`Melding aanpassen of uitzetten: ${site}/#/meldingen`);

  const htmlMail = mailHtml({
    s,
    titel: onderwerp,
    preheader,
    rechts: `Melding · ${tijdstip(nu)}`,
    rijen,
    voet: `${html(reden)}${site ? ` ${link('Melding aanpassen', `${site}/#/meldingen`, s)} · ${link('Alle meldingen uitzetten', `${site}/#/meldingen`, s)}` : ''}`,
  });
  return { onderwerp, html: htmlMail, tekst: tekst.join('\n') };
}

// Alles voor één melding: de treffers sinds `sinds`, met regio- en bronnaam,
// de tekst van de stukken (bij hooguit drie), en de mail. Ook voor het
// voorbeeld in Beheer (GET /api/beheer/mailvoorbeeld).
export function meldingMail(k, melding, gebruiker, { sinds, tot, nu = new Date(), max = Infinity }) {
  const gevonden = meldingTreffers(k, gebruiker, melding, { sinds, tot });
  const treffers = gevonden
    .map((t) => ({
      ...t,
      regioNaam: t.regios.map((r) => k.regioMap.get(r)?.naam).filter(Boolean).join(', '),
      bronNaam: t.stuk ? 'Tweede Kamer' : k.bronnen.get(t.bron)?.naam || '',
    }))
    .sort((a, b) => b.tijd.localeCompare(a.tijd))
    .slice(0, max);
  if (!treffers.length) return { treffers, mail: null };
  const documenten = new Map(treffers.length <= MAX_MET_TEKST ? treffers.map((t) => [t.id, documentVoorMail(k, t, melding.termen || [])]) : []);
  const mail = stelMeldingSamen(melding, treffers, nu, {
    meer: gevonden.meerKamerstukken || 0,
    regioNaam: (id) => k.regioMap.get(id)?.naam,
    titel: gebruiker.titel,
    documenten,
  });
  return { treffers, mail };
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
    const { treffers, mail } = meldingMail(k, melding, gebruiker, { sinds, tot, nu });
    if (!treffers.length) {
      if (dagelijks) melding.laatsteDagronde = vandaag;
      resultaten.push({ id: melding.id, verstuurd: false });
      continue;
    }
    try {
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
