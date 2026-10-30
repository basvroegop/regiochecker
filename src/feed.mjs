// De feed van een journalist: één chronologische lijst met alles uit de
// gevolgde regio's. Daarin komen samen:
//   - gemeentelijke bronnen (items.json, bereik regio): alles van die regio;
//   - landelijke bronnen (items.json, bereik landelijk), kamerstukken en
//     landelijke audio: alleen als een sleutelwoord van de regio erin staat;
//   - audio en video van een regio (raadsvergaderingen; src/audio/);
//   - stukken met een zoekterm uit een melding van deze journalist.
// Bij elk stuk dat via een sleutelwoord of melding binnenkwam, staat waarom:
// de term en de zin eromheen, bij audio met de tijd.
//
// De volgorde is die van "eerst gezien": wanneer de Regiochecker het stuk voor
// het eerst zag. Een kamerstuk dat we pas later binnenhaalden dan het verscheen
// (de eerste keer inhalen), staat op de datum van het stuk.

import { createHash } from 'node:crypto';
import { alleRegios, alleBronnen, TWEEDE_KAMER, geldtVoor, actieveTermen } from './register.mjs';
import { ENKELVOUD, GROEPEN, groepVan } from './regios.mjs';
import { vindTermen, vindInSegmenten, maakZoeker } from './termen.mjs';
import { stukUrl, downloadUrl, minDatum } from './kamer/db.mjs';
import { stukTitel } from './kamer/weergave.mjs';
import { lokaleDatum } from './datum.mjs';
import { tekstBlokken, begrens, MAX_DOCUMENT } from './document.mjs';
import { samenvattingAanbieder } from './samenvatting.mjs';
import { gemeente, afstandKm, plaatsenIn } from './geo.mjs';

export const FEED_DAGEN = 30;
const MAX_LIJST = 500;
const DAG_MS = 86400000;
const GEMEENTELIJK = ['nieuws', 'ingekomen', 'woo'];

// ---------- hulpjes ----------

// Uitkomsten van het zoeken naar termen, per stuk en per versie van de
// sleutelwoorden. Klein genoeg om in het geheugen te houden.
const geheugen = new Map();
function onthoud(sleutel, maak) {
  if (geheugen.has(sleutel)) return geheugen.get(sleutel);
  const waarde = maak();
  if (geheugen.size > 20000) geheugen.clear();
  geheugen.set(sleutel, waarde);
  return waarde;
}

const kort = (t) => createHash('sha1').update(t).digest('hex').slice(0, 12);

// Alles wat een verzoek nodig heeft, één keer opgezocht.
export function maakKader({ opslag, kdb, fdb, adb }) {
  const regios = alleRegios(opslag);
  return {
    opslag,
    kdb,
    fdb,
    adb: adb || opslag.audiodb || null,
    regios,
    regioMap: new Map(regios.map((r) => [r.id, r])),
    bronnen: new Map(alleBronnen(opslag).map((b) => [b.id, b])),
    termVersie: kort(JSON.stringify(opslag.regios)),
    kamerVersie: kdb ? JSON.stringify(kdb.versie()) : '',
  };
}

// Wat er van een stuk doorzocht wordt (sleutelwoorden, meldingen, zoeken): titel,
// beschrijving en het hele document; zonder document de korte inhoud. Het
// document blijft staan zolang het stuk bestaat, de korte inhoud maar vijf weken.
export function tekstVan(k, item) {
  const doc = k.fdb?.documentTekst?.(item.sleutel);
  return [item.titel, item.tekst, doc?.tekst || item.inhoud].filter(Boolean).join('\n');
}
const tekstVersie = (k, item) => `${(item.inhoud || '').length}|${k.fdb?.documentTekst?.(item.sleutel)?.versie || ''}`;
const segmentTekst = (a) => a.segmenten;

// Naar welke regio's gaat een stuk uit een landelijke bron? Per regio de
// gevonden sleutelwoorden.
function routeer(k, bronId, zoek) {
  const uit = [];
  for (const r of k.regios) {
    if (!geldtVoor(r, bronId)) continue;
    const termen = actieveTermen(r);
    if (!termen.length) continue;
    const gevonden = zoek(termen);
    if (gevonden.length) uit.push({ regio: r.id, gevonden });
  }
  return uit;
}

export function routeerItem(k, item, bron) {
  return onthoud(`ri|${item.sleutel}|${tekstVersie(k, item)}|${item.vestiging?.gemeente || ''}|${k.termVersie}`, () => {
    // `alleenSamenvatting`: de volledige tekst noemt ook wat er niet over gaat
    // (bij een uitspraak: "advocaat in Heerenveen").
    const tekst = bron.alleenSamenvatting ? [item.titel, item.tekst].filter(Boolean).join('\n') : tekstVan(k, item);
    const viaTermen = routeer(k, bron.id, (termen) => vindTermen(tekst, termen));
    if (!bron.geo && !bron.plaatsen && !bron.vestiging) return viaTermen;
    // Eerst de plek, dan de sleutelwoorden; per regio samen.
    const samen = new Map();
    for (const r of [...routeerOpPlek(k, item, bron), ...viaTermen]) {
      const bestaand = samen.get(r.regio);
      if (!bestaand) samen.set(r.regio, { regio: r.regio, gevonden: [...r.gevonden] });
      else for (const g of r.gevonden) if (!bestaand.gevonden.some((x) => x.term === g.term)) bestaand.gevonden.push(g);
    }
    return [...samen.values()];
  });
}

// Een regio heet naar een gemeente (src/geo.mjs). Een stuk met een plek gaat
// naar de regio als die plek erin ligt (of binnen `straalKm`), of als de
// provincie klopt; een stuk met plaatsnamen als een van die plaatsen erin ligt.
function routeerOpPlek(k, item, bron) {
  // Plaatsnamen alleen in titel en samenvatting: in de volledige tekst van een
  // uitspraak staat ook "advocaat te Heerenveen".
  const tekst = bron.plaatsen ? [item.titel, item.tekst].filter(Boolean).join('\n') : '';
  const plaatsen = bron.plaatsen ? plaatsenIn(tekst) : [];
  const punten = [item.plek, ...(item.punten || [])].filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  const uit = [];
  for (const r of k.regios) {
    if (!geldtVoor(r, bron.id)) continue;
    const g = gemeente(r.naam);
    if (!g) continue;
    const gevonden = [];
    // De plek, of een van de punten: het traject van een file, de stations van
    // een treinstoring. Het dichtstbijzijnde punt telt.
    if (bron.geo && punten.length) {
      const [km, p] = punten.map((x) => [afstandKm(x, g), x]).reduce((a, b) => (b[0] < a[0] ? b : a));
      const naam = p.naam || 'deze plek';
      if (km <= (bron.straalKm ?? 0)) {
        gevonden.push({ term: naam, aantal: 1, fragment: { tekst: km ? `${naam}, ${km.toFixed(1).replace('.', ',')} km buiten de gemeente ${g.naam}` : `${naam}, in de gemeente ${g.naam}`, treffer: naam } });
      }
    }
    if (bron.geo && item.provincies?.includes(g.provincie)) {
      gevonden.push({ term: `provincie ${g.provincie}`, aantal: 1, fragment: { tekst: item.titel, treffer: '' } });
    }
    // De vestigingsplaats (src/locatie.mjs): de sterkste aanwijzing.
    const v = bron.vestiging && item.vestiging;
    if (v?.gemeente === g.naam) {
      const plaats = v.plaats || v.gemeente;
      gevonden.push({ term: plaats, aantal: 1, fragment: { tekst: `Gevestigd in ${plaats}${v.plaats && v.plaats !== g.naam ? ` (gemeente ${g.naam})` : ''}${v.postcode ? `, ${v.postcode}` : ''}; volgens ${v.bron}.`, treffer: plaats } });
    }
    const hier = plaatsen.filter((p) => p.gemeenten.includes(g.naam)).map((p) => p.plaats);
    if (hier.length) gevonden.push(...vindTermen(tekst, hier));
    if (gevonden.length) uit.push({ regio: r.id, gevonden: gevonden.map((g) => ({ ...g, plek: true })) });
  }
  // Een inzending zonder plek of plaatsnaam: naar alle regio's, zoals in de checker.
  if (bron.overalZonderPlek && !uit.length && !punten.length && !plaatsen.length) {
    const fragment = { tekst: 'De inzending noemt geen plaats en heeft geen locatie, en staat daarom bij alle regio\'s.', treffer: '' };
    return k.regios.filter((r) => geldtVoor(r, bron.id)).map((r) => ({ regio: r.id, gevonden: [{ term: 'plaats onbekend', aantal: 1, fragment, plek: true }] }));
  }
  return uit;
}

export function routeerAflevering(k, a) {
  return onthoud(`ra|${a.id}|${a.bijgewerkt}|${k.termVersie}`,
    () => routeer(k, a.bron, (termen) => vindInSegmenten(segmentTekst(a), termen)));
}

const zoekInItem = (k, item, termen) => onthoud(`zi|${item.sleutel}|${tekstVersie(k, item)}|${termen.join('\u0000')}`,
  () => vindTermen(tekstVan(k, item), termen));

const zoekInAflevering = (a, termen) => onthoud(`za|${a.id}|${a.bijgewerkt}|${termen.join('\u0000')}`,
  () => vindInSegmenten(a.segmenten, termen));

function kamerTreffers(k, termen, opties) {
  if (!k.kdb || !termen.length) return [];
  const sleutel = `kt|${termen.join('\u0000')}|${opties.ookTermen?.join('\u0000') || ''}|${opties.sinds}|${opties.tot || ''}|${k.kamerVersie}`;
  return onthoud(sleutel, () => k.kdb.feedTreffers(termen, { ...opties, tot: opties.tot || '9999' }));
}

// Een kamerstuk dat we binnenhaalden op (ongeveer) de dag van het stuk, staat
// op het moment van binnenkomst; een ouder stuk op de datum van het stuk.
export function kamerTijd(stuk) {
  if (!stuk.binnen) return { tijd: `${stuk.datum}T12:00:00.000Z`, tijdBekend: false };
  const binnenDag = lokaleDatum(new Date(stuk.binnen));
  if (!stuk.datum || Date.parse(binnenDag) - Date.parse(stuk.datum) <= DAG_MS) return { tijd: stuk.binnen, tijdBekend: true };
  return { tijd: new Date(`${stuk.datum}T23:59:00`).toISOString(), tijdBekend: false };
}

// ---------- regels in de lijst ----------

// Een stuk van een landelijke bron, tenzij de bron het zelf bij een regio zette
// (de bekendmakingen van de provincie per gemeente, src/verzamel.mjs).
const isLandelijk = (item, bron) => bron.bereik === 'landelijk' && !item.regio;

function itemRegel(item, regios, match) {
  return { id: `i:${item.sleutel}`, soort: item.soort, titel: item.titel, regios, tijd: item.eersteGezien, tijdBekend: true, datum: item.datum || null, bron: item.bron, match, ...(item.verdwenen ? { verdwenen: item.verdwenen } : {}) };
}

function kamerRegel(stuk, regios, match) {
  return { id: `k:${stuk.id}`, soort: 'kamerstuk', titel: stukTitel(stuk), regios, ...kamerTijd(stuk), datum: stuk.datum || null, bron: TWEEDE_KAMER.id, match };
}

function audioRegel(a, regios, match) {
  return { id: `a:${a.id}`, soort: a.soort, titel: a.titel, regios, tijd: a.eersteGezien, tijdBekend: true, datum: (a.gepubliceerd || '').slice(0, 10) || null, bron: a.bron, match };
}

function voegToe(lijst, regel) {
  const bestaand = lijst.get(regel.id);
  if (!bestaand) {
    lijst.set(regel.id, { ...regel, regios: [...regel.regios] });
    return;
  }
  for (const r of regel.regios) if (!bestaand.regios.includes(r)) bestaand.regios.push(r);
  // Een sleutelwoord van de regio gaat voor een melding: dat is de hoofdreden.
  if (!bestaand.match || (bestaand.match.melding && regel.match?.regio)) bestaand.match = regel.match;
}

// ---------- meldingen ----------

// Stukken met de termen van een melding, binnengekomen tussen `sinds` en `tot`.
// Elke regel heeft `gevonden` (termen met fragment) en `url`, voor de mail.
//   bereik:  'overal', 'mijn' (de regio's van de gebruiker) of een regio-id
//   bronnen: 'alle', 'gemeente' (gemeentelijke en landelijke bronnen),
//            'kamerstuk' of 'audio'
// Zonder termen: alles binnen bereik en bronnen, zoals de feed het voor die
// regio's toont (kamerstukken dus via de sleutelwoorden van de regio). Nooit
// 'overal' zonder termen: dat is alles wat binnenkomt (controleerMelding).
export function meldingTreffers(k, gebruiker, melding, { sinds, tot }) {
  const termen = melding.termen || [];
  const scope = melding.bereik === 'overal' ? null : new Set(melding.bereik === 'mijn' ? gebruiker.regios : [melding.bereik]);
  const alles = !termen.length;
  if (alles && !scope) return [];
  const wil = (groep) => !melding.bronnen || melding.bronnen === 'alle' || melding.bronnen === groep;
  const match = (term) => ({ ...(term ? { term } : {}), melding: melding.id });
  const uit = [];

  if (wil('gemeente')) {
    for (const item of Object.values(k.opslag.items)) {
      if (item.basislijn || item.eersteGezien <= sinds || (tot && item.eersteGezien > tot)) continue;
      const bron = k.bronnen.get(item.bron);
      if (!bron) continue;
      const regios = isLandelijk(item, bron) ? routeerItem(k, item, bron).map((r) => r.regio) : [item.regio];
      if (scope && !regios.some((r) => scope.has(r))) continue;
      const gevonden = alles ? [] : zoekInItem(k, item, termen);
      if (alles || gevonden.length) uit.push({ ...itemRegel(item, scope ? regios.filter((r) => scope.has(r)) : regios, match(gevonden[0]?.term)), gevonden, url: item.url });
    }
  }

  if (wil('kamerstuk') && k.kdb) {
    let ookTermen = null;
    if (scope) {
      ookTermen = [...new Set([...scope].map((id) => k.regioMap.get(id))
        .filter((r) => r && geldtVoor(r, TWEEDE_KAMER.id))
        .flatMap(actieveTermen))];
    }
    if (!scope || ookTermen.length) {
      const kt = alles
        ? kamerTreffers(k, ookTermen, { sinds, tot, minDatum: minDatum(sinds) })
        : kamerTreffers(k, termen, { sinds, tot, minDatum: minDatum(sinds), ookTermen });
      for (const t of kt) {
        uit.push({ ...kamerRegel(t.stuk, [], match(t.term)), gevonden: [{ term: t.term, fragment: t.fragment }], url: stukUrl(t.stuk), stuk: t.stuk });
      }
      // Meer dan er in één keer opgehaald worden: hoeveel nog (zie kamer/db.mjs).
      if (kt.meer) uit.meerKamerstukken = kt.meer;
    }
  }

  if (wil('audio') && k.adb) {
    for (const a of k.adb.metTranscriptSinds(sinds, tot || '9999')) {
      const bron = k.bronnen.get(a.bron);
      if (!bron) continue;
      const regios = bron.bereik === 'landelijk' ? routeerAflevering(k, a).map((r) => r.regio) : [bron.regio];
      if (scope && !regios.some((r) => scope.has(r))) continue;
      const gevonden = alles ? [] : zoekInAflevering(a, termen);
      if (alles || gevonden.length) {
        uit.push({
          ...audioRegel(a, scope ? regios.filter((r) => scope.has(r)) : regios, { ...match(gevonden[0]?.term), tijd: gevonden[0]?.treffers[0]?.tijd }),
          gevonden: gevonden.map((g) => ({ term: g.term, aantal: g.aantal, fragment: g.treffers[0].fragment, tijd: g.treffers[0].tijd })),
          url: a.url,
        });
      }
    }
  }
  return uit;
}

// ---------- de feed ----------

function beginVanDag(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Wat er voor deze regio's binnenkwam na `sinds` (en tot `tot`): stukken van
// hun eigen bronnen, landelijke stukken met een sleutelwoord of plek van de
// regio, kamerstukken met een sleutelwoord, en afleveringen met een transcript.
function regioRegels(k, volg, { sinds, tot = null, vanaf = sinds.slice(0, 10) }) {
  const grens = sinds;
  const lijst = new Map();

  for (const item of Object.values(k.opslag.items)) {
    if (item.basislijn || item.eersteGezien <= grens || (tot && item.eersteGezien > tot)) continue;
    const bron = k.bronnen.get(item.bron);
    if (!bron) continue;
    if (isLandelijk(item, bron)) {
      for (const r of routeerItem(k, item, bron)) {
        if (volg.has(r.regio)) voegToe(lijst, itemRegel(item, [r.regio], { term: r.gevonden[0].term, regio: r.regio, ...(r.gevonden[0].plek ? { plek: true } : {}) }));
      }
    } else if (volg.has(item.regio)) {
      voegToe(lijst, itemRegel(item, [item.regio], null));
    }
  }

  for (const id of volg) {
    const regio = k.regioMap.get(id);
    if (!geldtVoor(regio, TWEEDE_KAMER.id)) continue;
    for (const t of kamerTreffers(k, actieveTermen(regio), { sinds: grens, tot, minDatum: vanaf })) {
      voegToe(lijst, kamerRegel(t.stuk, [id], { term: t.term, regio: id }));
    }
  }

  if (k.adb) {
    for (const a of k.adb.metTranscriptSinds(grens, tot || undefined)) {
      const bron = k.bronnen.get(a.bron);
      if (!bron) continue;
      if (bron.bereik === 'landelijk') {
        for (const r of routeerAflevering(k, a)) {
          const g = r.gevonden[0];
          if (volg.has(r.regio)) voegToe(lijst, audioRegel(a, [r.regio], { term: g.term, regio: r.regio, tijd: g.treffers[0]?.tijd }));
        }
      } else if (volg.has(bron.regio)) {
        voegToe(lijst, audioRegel(a, [bron.regio], null));
      }
    }
  }
  return lijst;
}

// Alle regels voor deze gebruiker vanaf `grens`, zonder filters.
function verzamel(k, gebruiker, grens) {
  const lijst = regioRegels(k, new Set(gebruiker.regios.filter((id) => k.regioMap.has(id))), { sinds: grens });
  // Een melding zonder zoekterm zet niets extra in de feed: dat zou hele regio's
  // toevoegen, en welke regio's de feed toont, kies je met volgen.
  for (const melding of k.opslag.meldingen.filter((m) => m.gebruiker === gebruiker.id && m.actief !== false && m.termen?.length)) {
    for (const regel of meldingTreffers(k, gebruiker, melding, { sinds: grens })) {
      const { gevonden, url, stuk, ...rest } = regel;
      voegToe(lijst, rest);
    }
  }
  return [...lijst.values()].filter((r) => r.tijd > grens);
}

// Voor een Teams-kanaal (src/kanalen.mjs): wat er tussen `sinds` en `tot`
// binnenkwam voor de regio's van het kanaal (geen regio's: alle), van de
// gekozen soorten (de tabbladen van de feed) en losse bronnen (niets gekozen:
// alles). Een kamerstuk telt zoals bij een melding alleen als het niet al
// weken oud was toen het binnenkwam. Oudste eerst.
export function kanaalRegels(ctx, kanaal, { sinds, tot }) {
  const k = ctx.regios ? ctx : maakKader(ctx);
  const volg = new Set((kanaal.regios?.length ? kanaal.regios : k.regios.map((r) => r.id)).filter((id) => k.regioMap.has(id)));
  const soorten = new Set(kanaal.soorten || []);
  const bronnen = new Set(kanaal.bronnen || []);
  const alles = !soorten.size && !bronnen.size;
  return [...regioRegels(k, volg, { sinds, tot, vanaf: minDatum(sinds) }).values()]
    .map((r) => voorClient(k, r, null, volg))
    .filter((r) => alles || soorten.has(r.groep) || bronnen.has(r.bron))
    .sort((a, b) => a.tijd.localeCompare(b.tijd));
}

function voorClient(k, regel, status, volg) {
  const zichtbaar = regel.regios.filter((r) => volg.has(r));
  const regioId = zichtbaar[0] || regel.regios[0] || null;
  return {
    ...regel,
    groep: groepVan(regel.soort),
    soortNaam: ENKELVOUD[regel.soort] || regel.soort,
    regioNaam: regioId ? k.regioMap.get(regioId)?.naam || regioId : 'Landelijk',
    gelezen: Boolean(status?.gelezen),
    bewaard: Boolean(status?.bewaard),
    notitie: Boolean(status?.notitie),
  };
}

function tel(regels) {
  const tellingen = { alles: regels.length };
  for (const g of Object.keys(GROEPEN)) tellingen[g] = 0;
  for (const r of regels) tellingen[r.groep] = (tellingen[r.groep] || 0) + 1;
  return tellingen;
}

// opties: { dagen, regio, groep, ongelezen }
export function bouwFeed(ctx, gebruiker, opties = {}) {
  const k = ctx.regios ? ctx : maakKader(ctx);
  const dagen = Math.min(90, Math.max(1, Number(opties.dagen) || FEED_DAGEN));
  const grens = beginVanDag(Date.now() - dagen * DAG_MS).toISOString();
  const volg = new Set(gebruiker.regios);
  const statussen = k.fdb ? k.fdb.statussen(gebruiker.id) : new Map();
  let regels = verzamel(k, gebruiker, grens).map((r) => voorClient(k, r, statussen.get(r.id), volg));
  if (opties.regio) regels = regels.filter((r) => r.regios.includes(opties.regio));
  if (opties.ongelezen) regels = regels.filter((r) => !r.gelezen);
  const tellingen = tel(regels);
  if (opties.groep && opties.groep !== 'alles') regels = regels.filter((r) => r.groep === opties.groep);
  regels.sort((a, b) => b.tijd.localeCompare(a.tijd));
  return { items: regels.slice(0, MAX_LIJST), tellingen, totaal: regels.length, dagen };
}

// Bewaard: alles wat deze gebruiker bewaarde, met de momentopname van toen.
export function bewaardeFeed(ctx, gebruiker, opties = {}) {
  const k = ctx.regios ? ctx : maakKader(ctx);
  const volg = new Set(gebruiker.regios);
  let regels = k.fdb.bewaarde(gebruiker.id)
    .filter((r) => r.momentopname)
    .map((r) => voorClient(k, r.momentopname, r, volg));
  if (opties.regio) regels = regels.filter((r) => r.regios.includes(opties.regio));
  if (opties.ongelezen) regels = regels.filter((r) => !r.gelezen);
  const tellingen = tel(regels);
  if (opties.groep && opties.groep !== 'alles') regels = regels.filter((r) => r.groep === opties.groep);
  return { items: regels, tellingen, totaal: regels.length };
}

// De zoekbalk: alle regio's en bronnen, niet alleen de gevolgde.
export function zoekFeed(ctx, gebruiker, vraag) {
  const k = ctx.regios ? ctx : maakKader(ctx);
  const zoeker = maakZoeker(vraag);
  if (!zoeker) return { items: [], tellingen: tel([]), totaal: 0 };
  const lijst = new Map();
  for (const item of Object.values(k.opslag.items)) {
    const bron = k.bronnen.get(item.bron);
    if (!bron) continue;
    const t = zoeker(tekstVan(k, item));
    if (!t) continue;
    const regios = isLandelijk(item, bron) ? routeerItem(k, item, bron).map((r) => r.regio) : [item.regio];
    const regel = itemRegel(item, regios, { term: t.term, zoek: true });
    // Ook wat bij de eerste ronde van een bron al bestond (de nulmeting): niet
    // nieuw, wel archief. Op de datum van het stuk, niet op die eerste ronde;
    // een stuk zonder datum (Meppel, Westerveld) onderaan, met een streepje.
    if (item.basislijn) Object.assign(regel, { tijd: item.datum ? `${item.datum}T12:00:00.000Z` : '', tijdBekend: false });
    voegToe(lijst, regel);
  }
  if (k.kdb) {
    try {
      for (const s of k.kdb.zoek({ vraag, sorteer: 'datum', perPagina: 100 }).rijen) {
        voegToe(lijst, kamerRegel(s, [], { term: vraag.replace(/"/g, '').split(/\s+/)[0], zoek: true }));
      }
    } catch {
      // Een zoekvraag die SQLite niet snapt: dan alleen de andere bronnen.
    }
  }
  if (k.adb) {
    for (const a of k.adb.alleMetTranscript()) {
      const bron = k.bronnen.get(a.bron);
      if (!bron) continue;
      const i = a.segmenten.findIndex((s) => zoeker(s.text));
      if (i < 0 && !zoeker(a.titel)) continue;
      const regios = bron.bereik === 'landelijk' ? routeerAflevering(k, a).map((r) => r.regio) : [bron.regio];
      voegToe(lijst, audioRegel(a, regios, { term: vraag, zoek: true, tijd: i >= 0 ? a.segmenten[i].start : undefined }));
    }
  }
  const statussen = k.fdb ? k.fdb.statussen(gebruiker.id) : new Map();
  const volg = new Set(gebruiker.regios);
  const regels = [...lijst.values()].map((r) => voorClient(k, r, statussen.get(r.id), volg))
    .sort((a, b) => b.tijd.localeCompare(a.tijd));
  return { items: regels.slice(0, MAX_LIJST), tellingen: tel(regels), totaal: regels.length };
}

// ---------- één stuk in het leespaneel ----------

const HOSTS = [
  [/notubiz|raadsinformatie\.nl/, 'Notubiz'],
  [/bestuurlijkeinformatie\.nl|ibabs/, 'iBabs'],
  [/tweedekamer\.nl/, 'Tweede Kamer'],
  [/youtube\.com|youtu\.be/, 'YouTube'],
  [/companywebcast|royalcast/, 'Company Webcast'],
];

export function openenBij(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return HOSTS.find(([re]) => re.test(host))?.[1] || host;
  } catch {
    return 'bron';
  }
}

const meta = (k, v) => (v ? { k, v } : null);

// Waarom staat dit stuk in de feed? Per regio de sleutelwoorden, en de termen
// van de meldingen van deze gebruiker.
// `route`: voor een landelijk stuk de uitkomst van routeerItem (sleutelwoorden
// en plek samen); anders zoeken met de sleutelwoorden van elke regio.
function redenen(k, gebruiker, zoek, { bronId, regioIds, route = null }) {
  const uit = [];
  for (const id of regioIds) {
    const regio = k.regioMap.get(id);
    if (!regio || (bronId && !geldtVoor(regio, bronId))) continue;
    const gevonden = route ? route.find((r) => r.regio === id)?.gevonden || [] : zoek(actieveTermen(regio));
    for (const g of gevonden) uit.push({ ...g, regio: id, regioNaam: regio.naam });
  }
  for (const m of k.opslag.meldingen.filter((x) => x.gebruiker === gebruiker.id && x.actief !== false)) {
    for (const g of zoek(m.termen || [])) uit.push({ ...g, melding: m.id });
  }
  return uit;
}

function itemDetail(k, gebruiker, sleutel) {
  const item = k.opslag.items[sleutel];
  if (!item) return null;
  const bron = k.bronnen.get(item.bron) || {};
  const landelijk = isLandelijk(item, bron);
  const regios = landelijk ? routeerItem(k, item, bron).map((r) => r.regio) : [item.regio];
  // Het hele document als het al is opgehaald; anders voorlopig de platte
  // inhoud, en haalt het leespaneel het document op (GET /api/stuk/document).
  const opgehaald = k.fdb?.document(sleutel);
  const plat = item.inhoud || item.tekst || '';
  // In de platte inhoud staan bijlagen achter " || ".
  const platBlokken = () => plat.split(/\s\|\|\s/).flatMap((deel, i) => [...(i ? [['d', 'Bijlage']] : []), ...tekstBlokken(deel)]);
  const document = opgehaald?.blokken.length ? opgehaald : { blokken: plat ? platBlokken() : [], volledig: Boolean(opgehaald) && !item.inhoud };
  // De titel staat al boven het leespaneel.
  const gelijk = (a, b) => a.toLowerCase().replace(/\s+/g, ' ').trim() === String(b || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (document.blokken[0]?.[0] === 'k' && gelijk(document.blokken[0][1], item.titel)) document.blokken = document.blokken.slice(1);
  return {
    id: `i:${sleutel}`,
    soort: item.soort,
    titel: item.titel,
    regios,
    landelijk,
    url: item.url,
    openenBij: openenBij(item.url),
    bronNaam: bron.naam || item.bron,
    toelichting: bron.toelichting || null,
    meta: [
      meta('Bron', bron.naam || item.bron),
      meta('Afzender', item.afzender),
      meta('Soort stuk', item.soortStuk),
      meta('Advies', item.advies),
      meta('Datum stuk', item.datum),
      meta('Vestiging', item.vestiging && vestigingTekst(item.vestiging)),
      // Een inzending via Telegram: hoe de redactie de inzender bereikt.
      meta('Telefoon', item.inzender?.telefoon),
      meta('Telegram', item.inzender?.username && `@${item.inzender.username}`),
      meta('Eerst gezien', item.eersteGezien),
      meta('Regio', regios.map((r) => k.regioMap.get(r)?.naam || r).join(', ')),
    ].filter(Boolean),
    document,
    media: (item.media || []).map((m) => ({ soort: m.soort, url: `/api/ingezonden/${m.pad}` })),
    documentOphalen: !opgehaald && !item.verdwenen && bron.inhoud !== false && Boolean(k.fdb),
    verdwenen: item.verdwenen || null,
    // Bij een gemeentelijk stuk tellen alleen de termen van de meldingen; bij een
    // landelijk stuk ook de sleutelwoorden van de gevolgde regio's.
    treffers: redenen(k, gebruiker, (termen) => vindTermen(tekstVan(k, item), termen), {
      bronId: bron.id,
      regioIds: landelijk ? gebruiker.regios : [],
      route: landelijk ? routeerItem(k, item, bron) : null,
    // Bij ransomware staan vestiging en regio al bij de gegevens van het stuk.
    }).filter((t) => !(bron.vestiging && t.plek)),
  };
}

// "Gorredijk (gemeente Opsterland), 8401 AB · volgens …"
const vestigingTekst = (v) => `${v.plaats || v.gemeente}${v.plaats && v.plaats !== v.gemeente ? ` (gemeente ${v.gemeente})` : ''}${v.postcode ? `, ${v.postcode}` : ''} · volgens ${v.bron}`;

function kamerDetail(k, gebruiker, id) {
  if (!k.kdb) return null;
  const stuk = k.kdb.stuk(id);
  if (!stuk) return null;
  const tekst = k.kdb.tekst(stuk.nr);
  const volledig = `${stuk.titel || ''}\n${stuk.onderwerp || ''}\n${tekst}`;
  const treffers = redenen(k, gebruiker, (termen) => vindTermen(volledig, termen), { bronId: TWEEDE_KAMER.id, regioIds: gebruiker.regios });
  return {
    id: `k:${id}`,
    soort: 'kamerstuk',
    titel: stukTitel(stuk),
    regios: [...new Set(treffers.filter((t) => t.regio).map((t) => t.regio))],
    landelijk: true,
    kicker: stuk.soort,
    url: stukUrl(stuk),
    download: downloadUrl(stuk),
    openenBij: 'Tweede Kamer',
    bronNaam: TWEEDE_KAMER.naam,
    meta: [
      meta('Bron', 'Tweede Kamer'),
      meta('Kenmerk', stuk.nummer),
      meta('Soort', stuk.soort),
      meta('Indiener', stuk.afzender),
      meta('Dossier', stuk.dossier && `${stuk.dossier}${stuk.dossiertitel ? ` · ${stuk.dossiertitel}` : ''}`),
      meta('Datum stuk', stuk.datum),
      meta('Eerst gezien', stuk.binnen),
      meta('Regio', [...new Set(treffers.filter((t) => t.regio).map((t) => t.regioNaam))].join(', ')),
    ].filter(Boolean),
    // De tekst staat per regel van de pdf; tekstBlokken maakt er weer alinea's van.
    document: tekst ? (() => {
      const b = begrens(tekstBlokken(tekst.slice(0, MAX_DOCUMENT + 20_000)));
      return { blokken: b.blokken, volledig: b.volledig && tekst.length <= MAX_DOCUMENT + 20_000 };
    })() : { blokken: stuk.onderwerp ? [['p', stuk.onderwerp]] : [], volledig: false },
    treffers,
    tekststatus: stuk.tekststatus,
  };
}

// Wie is deze stem volgens het vergaderplatform? Company Webcast noteert per
// spreker wanneer de microfoon aan stond. Een stem hoort bij de persoon met wie
// de beurten het meest samenvallen, als dat het grootste deel van de
// spreektijd van die stem is (60%) en minstens 20 seconden.
export function platformSpreker(beurten, sprekers) {
  const totaal = beurten.reduce((n, [a, b]) => n + Math.max(0, b - a), 0);
  if (!totaal || !sprekers?.length) return null;
  let beste = null;
  for (const p of sprekers) {
    let samen = 0;
    for (const [a, b] of beurten) for (const [c, d] of p.momenten) samen += Math.max(0, Math.min(b, d) - Math.max(a, c));
    if (!beste || samen > beste.samen) beste = { p, samen };
  }
  if (!beste || beste.samen < 20 || beste.samen / totaal < 0.6) return null;
  return { naam: beste.p.naam, rol: beste.p.rol, deel: Math.round((beste.samen / totaal) * 100) };
}

// Sprekers in een transcript: per stem het aantal beurten, de eerste beurt en,
// als er nog geen naam is, een voorstel van het vergaderplatform (wie had de
// microfoon). Alleen dat: namen die het taalmodel vlak voor een beurt vond,
// klopten te vaak niet (oktober 2026).
export function sprekersVan(a) {
  const sprekers = new Map();
  a.segmenten.forEach((s, i) => {
    if (!s.speaker && !s.speaker_id) return;
    const sleutel = s.speaker_id || s.speaker;
    const sp = sprekers.get(sleutel) || { id: s.speaker_id || null, label: s.speaker || 'Spreker', beurten: 0, eerste: i, duur: 0, langste: null, tijden: [] };
    sp.beurten++;
    sp.tijden.push([Number(s.start) || 0, Number(s.end) || 0]);
    const lengte = (Number(s.end) || 0) - (Number(s.start) || 0);
    sp.duur += Math.max(0, lengte);
    if (!sp.langste || lengte > sp.langste.lengte) sp.langste = { start: s.start, lengte };
    sprekers.set(sleutel, sp);
  });
  for (const sp of sprekers.values()) {
    // "Spreker 3", "SPEAKER_02" en dergelijke zijn geen namen.
    sp.heeftNaam = !/^(spreker|speaker)[\s_]*\d+$/i.test(sp.label);
    const platform = sp.id ? platformSpreker(sp.tijden, a.platform?.sprekers) : null;
    delete sp.tijden;
    if (sp.heeftNaam) continue;
    if (platform) sp.suggestie = { naam: platform.naam, bron: 'platform', deel: platform.deel };
  }
  return [...sprekers.values()].sort((x, y) => x.eerste - y.eerste);
}

const isAudioUrl = (url) => /\.(mp3|m4a|aac|ogg|opus|wav)(\?|$)/i.test(url || '');

// Namen in één aflevering, per soort, met de eerste plek waar ze vallen.
function namenVan(a) {
  return (a.entiteiten || []).map((e) => ({
    naam: e.name, soort: e.type, aantal: e.count,
    plekken: (e.occurrences || []).map((o) => ({ segment: o.segment, start: o.start, spans: o.spans })),
  }));
}

function nummersVan(k, a) {
  if (!k.adb) return [];
  return k.adb.db.prepare(`SELECT v.nummer, v.weergave, v.categorie, v.segment, v.start, v.context, b.bedrijf, kp.staat, kp.label
    FROM telefoon_vermeldingen v LEFT JOIN telefoon_verificaties b ON b.nummer = v.nummer LEFT JOIN telefoon_koppelingen kp ON kp.nummer = v.nummer
    WHERE v.aflevering = ? ORDER BY v.start`).all(a.id).map((r) => ({
    nummer: r.nummer, weergave: r.weergave, categorie: r.categorie, segment: r.segment, start: r.start, context: r.context,
    wie: r.bedrijf || (r.staat === 'bevestigd' ? r.label : null),
  }));
}

function audioDetail(k, gebruiker, id) {
  if (!k.adb) return null;
  const a = k.adb.aflevering(id);
  if (!a) return null;
  const bron = k.bronnen.get(a.bron) || {};
  const landelijk = bron.bereik === 'landelijk';
  const regios = !a.transcript ? (landelijk ? [] : [bron.regio]) : landelijk ? routeerAflevering(k, a).map((r) => r.regio) : [bron.regio];
  // Bij audio ook de sleutelwoorden van de eigen regio ("In dit stuk: Drachten 12×").
  const treffers = redenen(k, gebruiker, (termen) => vindInSegmenten(a.segmenten, termen).map((g) => ({
    term: g.term, aantal: g.aantal, fragment: g.treffers[0].fragment, tijd: g.treffers[0].tijd, tijden: g.treffers.map((t) => t.tijd),
  })), { bronId: landelijk ? bron.id : null, regioIds: landelijk ? gebruiker.regios : regios.filter(Boolean) });
  // Afspelen: de eigen kopie zolang die bewaard is (standaard bij
  // raadsvergaderingen), anders bij een podcast het originele bestand;
  // YouTube opent op de juiste tijd bij YouTube zelf.
  let speler = null;
  if (a.audio) speler = `/api/audio/afleveringen/${encodeURIComponent(a.id)}/audio`;
  else if (a.soort === 'podcast' && isAudioUrl(a.mediaUrl || a.url)) speler = a.mediaUrl || a.url;
  return {
    id: `a:${id}`,
    soort: a.soort,
    titel: a.titel,
    regios: regios.filter(Boolean),
    landelijk,
    url: a.url,
    openenBij: openenBij(a.url),
    bronNaam: bron.naam || a.bron,
    episode: a.id,
    duur: a.duur,
    gepubliceerd: a.gepubliceerd,
    eersteGezien: a.eersteGezien,
    getranscribeerd: a.transcript && a.bijgewerkt ? new Date(a.bijgewerkt * 1000).toISOString() : null,
    verwerking: { status: a.status, stap: a.stap, fout: a.fout, sprekerFout: a.sprekerFout },
    // De AI-samenvatting (src/vergadering.mjs), of `volgt` zolang die gemaakt wordt.
    samenvatting: a.samenvatting?.tekst
      ? { tekst: a.samenvatting.tekst, model: a.samenvatting.model || null, tijd: a.samenvatting.tijd || null }
      : (a.transcript && (a.samenvatting?.pogingen || 0) < 3 && samenvattingAanbieder(k.opslag).klaar ? { volgt: true } : null),
    youtube: a.vorm === 'youtube',
    // Een Kamerdebat van gehoord.de: geen audio hier; een tijd opent dat fragment daar.
    gehoord: a.vorm === 'gehoord',
    // Een video om erbij te tonen (/api/stuk/video): een Kamerdebat (Debat
    // Direct) of een vergadering op een platform met beeld.
    video: a.vorm === 'gehoord' || (a.vorm === 'vergadering' && /^(cwc|ntb|ibabs):/.test(a.extern || '')),
    speler,
    meta: [
      meta('Bron', bron.naam || a.bron),
      meta('Aflevering', a.auteur),
      meta('Gepubliceerd', a.gepubliceerd),
      meta('Eerst gezien', a.eersteGezien),
      meta('Soort debat', a.platform?.debat?.soort),
      meta('Let op', a.platform?.debat?.letOp?.join(' ') || null),
      meta('Transcript', a.transcript ? (a.vorm === 'gehoord' ? 'Automatisch, door gehoord.de; niet citeren als officieel verslag (dat zijn de Handelingen)' : `Automatisch${a.taal ? ` · ${a.taal.toUpperCase()}` : ''}`) : null),
      meta('Regio', regios.filter(Boolean).map((r) => k.regioMap.get(r)?.naam || r).join(', ') || null),
    ].filter(Boolean),
    segmenten: a.segmenten.map((s) => ({ start: s.start, eind: s.end, tekst: s.text, spreker: s.speaker || null, sprekerId: s.speaker_id || null, ...(s.fragment ? { link: `${a.url}?segment=${s.fragment}` } : {}) })),
    sprekers: sprekersVan(a),
    // De agenda van het vergaderplatform, met de tijd waarop elk punt begint.
    agenda: a.platform?.agenda || [],
    namenUit: !a.entiteiten && !k.opslag.instellingen.audio?.namenZoeken,
    stemmenHerkend: a.segmenten.some((s) => s.speaker_id),
    namen: namenVan(a),
    nummers: nummersVan(k, a),
    treffers,
  };
}

export function detail(ctx, gebruiker, id) {
  const k = ctx.regios ? ctx : maakKader(ctx);
  const soort = id.slice(0, 2);
  const rest = id.slice(2);
  let d = null;
  if (soort === 'i:') d = itemDetail(k, gebruiker, rest);
  else if (soort === 'k:') d = kamerDetail(k, gebruiker, rest);
  else if (soort === 'a:') d = audioDetail(k, gebruiker, rest);
  if (!d) return null;
  const regio = d.regios.find((r) => gebruiker.regios.includes(r)) || d.regios[0];
  return {
    ...d,
    soortNaam: ENKELVOUD[d.soort] || d.soort,
    groep: groepVan(d.soort),
    // Audio en video (vergadering, debat, YouTube, podcast): het leespaneel met transcript.
    audio: soort === 'a:',
    regioNaam: regio ? k.regioMap.get(regio)?.naam || regio : 'Landelijk',
    status: k.fdb ? k.fdb.status(gebruiker.id, id) : { gelezen: null, bewaard: null, notitie: '' },
  };
}

// De regel zoals hij in de lijst staat, om te bewaren als momentopname.
export function momentopname(ctx, gebruiker, id) {
  const d = detail(ctx, gebruiker, id);
  if (!d) return null;
  const t = d.treffers?.[0];
  const tijd = d.meta.find((m) => m.k === 'Eerst gezien')?.v || new Date().toISOString();
  return {
    id,
    soort: d.soort,
    titel: d.titel,
    regios: d.regios,
    tijd,
    tijdBekend: true,
    datum: d.meta.find((m) => m.k === 'Datum stuk')?.v || null,
    match: t ? { term: t.term, regio: t.regio, melding: t.melding } : null,
  };
}

export { GEMEENTELIJK };
