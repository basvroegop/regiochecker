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
import { SOORTEN, ENKELVOUD, GROEPEN, groepVan } from './regios.mjs';
import { alleRegios, bronnenVanRegio, geldtVoor, actieveTermen, TWEEDE_KAMER, isAudioBron } from './register.mjs';
import { maakSamenvatting, samenvattingAanbieder } from './samenvatting.mjs';
import { vatVergaderingSamen, tijdcode } from './vergadering.mjs';
import { maakKader, routeerItem, routeerAflevering } from './feed.mjs';
import { html, kort } from './html.mjs';
import { korteDatum, lokaleDatum } from './datum.mjs';
import { minDatum } from './kamer/db.mjs';
import { trefferHtml, trefferTekst } from './kamer/weergave.mjs';
import { stijl, mailHtml, rij, letter, FAMILIE, sectieKop, categorieKop, itemRij, lijst, zacht, link, knoppen } from './mailstijl.mjs';
import { weekmailNodig } from './planning.mjs';

// Meer kamerstukken dan in een mail passen: dat zeggen, niet stilzwijgend weglaten.
export const meerKamerstukken = (n) => `En nog zo'n ${n} ${n === 1 ? 'kamerstuk' : 'kamerstukken'} met deze termen, die niet meer in deze mail passen.`;

const SOORT_VOLGORDE = ['nieuws', 'ingekomen', 'woo', 'bekendmaking'];
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
// Een categorie zonder eigen bron en zonder stukken (Bekendmakingen buiten
// Fryslân) blijft weg.
function categorieen(opslag, regio, items) {
  return SOORT_VOLGORDE.map((soort) => ({
    soort,
    naam: SOORTEN[soort],
    items: items.filter((i) => i.soort === soort),
    opmerkingen: bronOpmerkingen(opslag, regio, soort),
    gecontroleerd: regio.bronnen.some((b) => b.soort === soort && b.type !== 'ontbreekt'),
  })).filter((c) => c.items.length || c.opmerkingen.length || c.gecontroleerd);
}

function itemHtml(item, s) {
  return itemRij({ soort: ENKELVOUD[item.soort], datum: korteDatum(item.datum), titel: item.titel, url: item.url, kenmerken: kenmerken(item) }, s);
}

// Alles wat er voor deze regio in de mail staat: de stukken van de regio zelf,
// landelijke stukken, kamerstukken en audio.
const aantalVan = (blok) => blok.items.length + blok.landelijk.length + blok.kamerstukken.length + blok.audio.length;
const stukken = (n) => `${n} ${n === 1 ? 'stuk' : 'stukken'}`;

function regioHtml(blok, opslag, s) {
  const { regio, items, samenvatting, samenvattingFout } = blok;
  const perSleutel = new Map(items.map((i) => [i.sleutel, i]));
  const site = process.env.REGIOCHECKER_SITE_URL;
  const n = aantalVan(blok);
  let uit = sectieKop('h2', regio.naam, n ? stukken(n) : 'niets nieuws', s);

  // De samenvatting: lopende tekst, per onderwerp een punt met vierkant
  // opsommingsteken, en de bronnen klein erachter.
  if (samenvatting?.punten.length) {
    uit += `<ul style="margin:14px 0 0;padding:0 0 0 18px;list-style-type:square;">${samenvatting.punten.map((p) => {
      const bronnen = p.items.map((k) => perSleutel.get(k)).filter(Boolean);
      const links = bronnen.map((b) => `<a href="${html(b.url)}" style="color:${s.tweede};text-decoration:underline;text-decoration-color:${s.a700};">${html(kort(b.titel, 80))}</a>`).join(' · ');
      return `<li style="margin:0 0 8px;${letter(400, 15, 1.55)}">${html(p.zin)}${links ? ` <span style="${letter(400, 13, 1.5)}color:${s.tweede};">— ${links}</span>` : ''}</li>`;
    }).join('')}</ul>`;
  }
  if (samenvattingFout) uit += zacht(`Geen samenvatting: ${html(samenvattingFout)}. Hieronder staat wel alles wat nieuw is.`, s, '12px 0 0');

  for (const c of categorieen(opslag, regio, items)) {
    uit += categorieKop(c.naam, c.items.length, s);
    if (c.opmerkingen.length) uit += zacht(c.opmerkingen.map(html).join('<br>'), s, '8px 0 0');
    if (c.items.length) uit += lijst(c.items.map((i) => itemHtml(i, s)));
    else if (c.gecontroleerd) uit += zacht('Geen nieuwe berichten.', s);
  }
  if (blok.landelijk.length) {
    uit += categorieKop('Landelijke bronnen', blok.landelijk.length, s);
    uit += lijst(blok.landelijk.map((l) => landelijkHtml(l, s)));
  }
  if (blok.kamerTermen?.length) {
    uit += categorieKop('Kamerstukken', blok.kamerstukken.length, s);
    uit += blok.kamerstukken.length
      ? lijst(blok.kamerstukken.map((t) => trefferHtml(t, s)))
      : zacht(`Geen nieuwe kamerstukken met ${html(blok.kamerTermen.join(', '))}.`, s);
    if (blok.kamerstukken.meer) uit += zacht(`${html(meerKamerstukken(blok.kamerstukken.meer))}${site ? ` ${link('Bekijk ze in de Regiochecker', `${site}/#/feed?groep=kamerstuk`, s)}.` : ''}`, s);
  }
  for (const [kop, l] of audioPerSoort(blok.audio)) {
    uit += categorieKop(kop, l.length, s);
    uit += lijst(l.map((x) => audioHtml(x, s)));
  }
  if (site && n) uit += `<p style="margin:16px 0 0;${letter(600, 14, 1.4)}">${link(`Alle ${stukken(n)} uit ${regio.naam} →`, `${site}/#/feed?regio=${encodeURIComponent(regio.id)}`, s, 'font-weight:600;')}</p>`;
  return rij(uit, '28px 28px 4px');
}

const duurTekst = (s) => (s ? `${Math.floor(s / 3600) ? `${Math.floor(s / 3600)} u ` : ''}${Math.round((s % 3600) / 60)} min` : '');

function landelijkHtml({ item, bron, gevonden }, s) {
  return itemRij({
    soort: ENKELVOUD[item.soort] || bron.naam,
    datum: korteDatum(item.datum),
    labels: [...new Set(gevonden.map((g) => g.term))],
    titel: item.titel,
    url: item.url,
    kenmerken: bron.naam,
    fragmenten: gevonden[0]?.fragment ? [{ fragment: gevonden[0].fragment, bij: gevonden[0].aantal > 1 ? `(${gevonden[0].aantal}× ${gevonden[0].term})` : '' }] : [],
  }, s);
}

// Audio per soort een eigen kop (Raadsvergaderingen, Kamerdebatten, …), zoals
// de tabbladen van de feed: [[kop, lijst], …].
const audioPerSoort = (lijst) => Object.entries(GROEPEN)
  .map(([id, kop]) => [kop, lijst.filter((x) => groepVan(x.aflevering.soort) === id)])
  .filter(([, l]) => l.length);

function audioHtml({ aflevering: a, bron, gevonden, samenvatting, samenvattingFout }, s) {
  const eerste = gevonden?.[0]?.treffers[0];
  let na = '';
  // Een raadsvergadering: per onderwerp een kop met de punten.
  for (const o of samenvatting?.onderwerpen || []) {
    na += `<h4 style="margin:14px 0 4px;${FAMILIE}${letter(600, 14, 1.4)}color:${s.inkt};">${html(o.kop)}</h4><ul style="margin:0 0 6px;padding:0 0 0 18px;list-style-type:square;${letter(400, 14, 1.5)}color:${s.inkt};">${o.punten.map((p) => `<li style="margin:0 0 4px;">${html(p)}</li>`).join('')}</ul>`;
  }
  if (samenvattingFout) na += zacht(`Geen samenvatting van de vergadering: ${html(samenvattingFout)}.`, s, '8px 0 0');
  return itemRij({
    soort: ENKELVOUD[a.soort],
    datum: [korteDatum(String(a.gepubliceerd || '').slice(0, 10)), eerste && tijdcode(eerste.tijd)].filter(Boolean).join(' · '),
    labels: [...new Set((gevonden || []).map((g) => g.term))],
    titel: a.titel,
    url: a.url,
    kenmerken: [bron.naam, duurTekst(a.duur)].filter(Boolean).join(' · '),
    fragmenten: (gevonden || []).slice(0, 2).map((g) => ({ fragment: g.treffers[0].fragment, tijd: g.treffers[0].tijd, bij: g.aantal > 1 ? `(${g.aantal}× ${g.term})` : '' })),
    tijdcode,
    na,
  }, s);
}

function regioTekst(blok, opslag) {
  const { regio, items, samenvatting, samenvattingFout } = blok;
  const perSleutel = new Map(items.map((i) => [i.sleutel, i]));
  const n = aantalVan(blok);
  const r = [`== ${regio.naam.toUpperCase()} ==`, n ? stukken(n) : 'Niets nieuws gevonden.', ''];
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
  for (const [kop, lijst] of audioPerSoort(blok.audio)) {
    r.push(`-- ${kop} (${lijst.length}) --`);
    for (const { aflevering: a, bron, gevonden, samenvatting } of lijst) {
      r.push(`* ${korteDatum(String(a.gepubliceerd || '').slice(0, 10)) || 'z.d.'}  ${a.titel}`, `  ${bron.naam}`);
      for (const g of gevonden || []) r.push(`  ${tijdcode(g.treffers[0].tijd)} "${g.treffers[0].fragment.tekst}"`);
      for (const o of samenvatting?.onderwerpen || []) r.push(`  ${o.kop}`, ...o.punten.map((p) => `   - ${p}`));
      r.push(`  ${a.url}`);
    }
    r.push('');
  }
  return r.join('\n');
}

// ISO-weeknummer (maandag eerst, week 1 bevat de eerste donderdag).
export function isoWeek(datum) {
  const d = new Date(Date.UTC(datum.getFullYear(), datum.getMonth(), datum.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  return Math.ceil(((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAG_MS + 1) / 7);
}

const opsomming = (namen) => (namen.length > 1 ? `${namen.slice(0, -1).join(', ')} en ${namen.at(-1)}` : namen[0] || '');

// "Week 44: 52 nieuwe stukken in Smallingerland, Heerenveen en Leeuwarden". Meer
// dan drie regio's: de eerste twee en "en 38 andere". Een periode van meer dan
// een week (er ging eerder geen mail uit): de datums erachter, zonder weeknummer.
function onderwerp(blokken, sinds, nu) {
  const totaal = blokken.reduce((n, b) => n + aantalVan(b), 0);
  const aantal = totaal ? `${totaal} nieuw${totaal === 1 ? ' stuk' : 'e stukken'}` : 'niets nieuws';
  const namen = blokken.map((b) => b.regio.naam);
  const waar = namen.length > 3 ? `${namen.slice(0, 2).join(', ')} en ${namen.length - 2} andere` : opsomming(namen);
  if (langePeriode(sinds, nu)) return `${aantal[0].toUpperCase()}${aantal.slice(1)} in ${waar} (${korteDatum(lokaleDatum(new Date(sinds)))} – ${korteDatum(lokaleDatum(nu))})`;
  return `Week ${weekVan(sinds, nu)}: ${aantal} in ${waar}`;
}

const langePeriode = (sinds, nu) => nu - Date.parse(sinds) > 7.5 * DAG_MS;
// De week waar de periode het meest in valt: die van het midden.
const weekVan = (sinds, nu) => isoWeek(new Date((Date.parse(sinds) + nu.getTime()) / 2));

function groet(nu, gebruiker) {
  const uur = Number(new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: 'numeric', hourCycle: 'h23' }).format(nu));
  const voornaam = String(gebruiker.naam || '').trim().split(/\s+/)[0];
  const dag = uur < 12 ? 'Goedemorgen' : uur < 18 ? 'Goedemiddag' : 'Goedenavond';
  return voornaam ? `${dag} ${voornaam}, dit kwam er binnen in je regio’s.` : 'Dit kwam er binnen in je regio’s.';
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
    const kamerstukken = kamerTermen.length ? opslag.kamer.treffers(kamerTermen, { sinds, tot, minDatum: minDatum(sinds), hoofdletters: true }) : [];
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

  const s = stijl(gebruiker.titel);
  const sindsTekst = new Date(sinds).toLocaleString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const totTekst = nu.toLocaleString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const titel = langePeriode(sinds, nu) ? `${korteDatum(lokaleDatum(new Date(sinds)))} – ${korteDatum(lokaleDatum(nu))}` : `Week ${weekVan(sinds, nu)}`;
  const periode = `${sindsTekst} – ${totTekst}`;
  const welkom = groet(nu, gebruiker);
  const wie = regios.length > 5 ? `${regios.length} regio’s` : regios.map((r) => r.naam).join(', ');
  const voet = `Je krijgt deze mail omdat je ${wie} volgt. Nieuw = voor het eerst gezien tussen ${sindsTekst} en ${totTekst}.`;
  const site = process.env.REGIOCHECKER_SITE_URL;
  const punten = blokken.flatMap((b) => b.samenvatting?.punten || []).slice(0, 3).map((p) => kort(p.zin, 60));

  // De tellers: per regio het aantal stukken, drie per rij (op mobiel onder elkaar).
  const tellers = [];
  for (let i = 0; i < blokken.length; i += 3) {
    const cellen = blokken.slice(i, i + 3).map((b) => `<td width="33%" valign="top" style="width:33%;padding:10px 12px 10px 0;${FAMILIE}color:${s.inkt};${i ? `border-top:1px solid ${s.lijn};` : ''}"><div style="${letter(800, 25, 1.1)}font-variant-numeric:tabular-nums;">${aantalVan(b)}</div><div style="margin-top:2px;${letter(600, 13, 1.3)}">${html(b.regio.naam)}</div></td>`);
    while (cellen.length < 3) cellen.push(`<td width="33%" style="width:33%;${i ? `border-top:1px solid ${s.lijn};` : ''}">&nbsp;</td>`);
    tellers.push(`<tr>${cellen.join('')}</tr>`);
  }

  const htmlMail = mailHtml({
    s,
    titel: onderwerp(blokken, sinds, nu),
    preheader: punten.length ? punten.join(', ') : onderwerp(blokken, sinds, nu),
    rechts: 'Weekoverzicht',
    rijen: [
      rij(`<h1 style="margin:0;${FAMILIE}${letter(800, 32, 1.1)}color:${s.inkt};">${html(titel)}</h1><p style="margin:8px 0 0;${letter(400, 14, 1.5)}color:${s.n800};">${html(periode)} · ${html(welkom)}</p>`, '28px 28px 20px'),
      ...(tellers.length ? [rij(`<table role="presentation" class="rc-stapel" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;border-top:2px solid ${s.inkt};border-bottom:2px solid ${s.inkt};">${tellers.join('')}</table>`)] : []),
      ...blokken.map((b) => regioHtml(b, opslag, s)),
      ...(site ? [rij(knoppen([{ tekst: 'Naar je feed', url: `${site}/#/feed` }], s), '28px 28px 28px')] : [rij('&nbsp;', '8px 28px')]),
    ],
    voet: `De samenvattingen zijn automatisch gemaakt; controleer altijd het stuk zelf. ${html(voet)}${site ? ` ${link('Weekmail aanpassen', `${site}/#/meldingen`, s)} · ${link('Uitzetten', `${site}/#/meldingen`, s)}` : ''}`,
  });

  const tekst = [
    `Regiochecker · ${titel}`, `${periode} · ${welkom}`, '',
    ...blokken.map((b) => regioTekst(b, opslag)),
    'De samenvattingen zijn automatisch gemaakt; controleer altijd het stuk zelf.',
    voet,
    ...(site ? [`Je feed: ${site}/#/feed`, `Weekmail aanpassen of uitzetten: ${site}/#/meldingen`] : []),
  ].join('\n');

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
