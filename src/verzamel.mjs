// Eén verzamelronde: alle bronnen langs, nieuwe items opslaan met het moment
// waarop we ze voor het eerst zagen. De mail kijkt alleen naar dat moment, niet
// naar de datum op het stuk zelf: een Woo-besluit van augustus dat pas in
// oktober online komt, is in oktober nieuws.
//
// Twee vangnetten tegen een mail vol oud nieuws:
//  - De allereerste ronde van een bron is een nulmeting. Wat er dan al staat,
//    telt niet als nieuw, behalve stukken van de laatste twee dagen.
//  - Daarna telt een "nieuw" nieuwsbericht of ingekomen stuk met een datum van
//    meer dan drie weken oud ook niet mee. Dat vangt het geval op waarin een
//    site wordt omgebouwd en ineens alle links veranderen. Voor Woo geldt die
//    grens niet, om de reden hierboven.

import { teVerzamelen, alleBronnen, alleRegios } from './register.mjs';
import { gemeente, afstandKm } from './geo.mjs';
import { haalBron } from './bronnen/index.mjs';
import { dagenGeleden, lokaleDatum } from './datum.mjs';
import { vulInhoud } from './inhoud.mjs';
import { vindVestiging } from './locatie.mjs';
import { gooiMediaWeg } from './telegram.mjs';

const MAX_LEEFTIJD_DAGEN = { nieuws: 21, ingekomen: 21, woo: null };
const NULMETING_RECENT_DAGEN = 2;
const ARCHIEF_IN_FEED_DAGEN = 30;
const OPRUIMEN_NA_DAGEN = 60;
const GELIJKTIJDIG = 4;

export function telAlsNieuw(item, soort, eersteKeer, nu) {
  const leeftijd = dagenGeleden(item.datum, nu);
  if (eersteKeer) return leeftijd !== null && leeftijd <= NULMETING_RECENT_DAGEN && leeftijd > -60;
  const max = MAX_LEEFTIJD_DAGEN[soort];
  return !(max && leeftijd !== null && leeftijd > max);
}

// Een landelijke bron met stukken per gemeente (`perGemeente`, de
// bekendmakingen van de provincie): een stuk voor een gemeente die een regio is,
// wordt een stuk van die regio, zoals van de eigen bronnen van de gemeente. Bij
// twee regio's (een bekendmaking voor "Leeuwarden en Tytsjerksteradiel") een stuk per regio.
// `basis`: de sleutel zonder regio, voor een stuk dat al binnen was voordat de
// tweede regio bestond (zie verdeelOverRegio).
function perRegio(opslag, gevonden) {
  const regioVan = new Map(alleRegios(opslag).map((r) => [gemeente(r.naam)?.naam, r.id]).filter(([naam]) => naam));
  return gevonden.flatMap((g) => {
    const ids = [...new Set((g.gemeenten || []).map((n) => regioVan.get(n)).filter(Boolean))];
    if (ids.length <= 1) return [{ ...g, regio: ids[0] || null }];
    return ids.map((id) => ({ ...g, sleutel: `${g.sleutel}@${id}`, basis: g.sleutel, regio: id }));
  });
}

const perGemeenteBronnen = (opslag) => new Set(alleBronnen(opslag).filter((b) => b.perGemeente).map((b) => b.id));
const zonderRegio = (sleutel) => sleutel.replace(/@[^@:]*$/, '');

// Een nieuwe regio: wat een bron met `perGemeente` al voor die gemeente vond
// (toen nog een landelijk stuk), wordt een stuk van die regio. Was het al van
// een andere regio (een bekendmaking voor twee gemeenten), dan een kopie.
// Geeft het aantal stukken.
export function verdeelOverRegio(opslag, regioId) {
  const regio = alleRegios(opslag).find((r) => r.id === regioId);
  const naam = regio && gemeente(regio.naam)?.naam;
  if (!naam) return 0;
  const bronnen = perGemeenteBronnen(opslag);
  let n = 0;
  for (const item of Object.values(opslag.items)) {
    if (!bronnen.has(item.bron) || !item.gemeenten?.includes(naam) || item.regio === regioId) continue;
    if (!item.regio) {
      item.regio = regioId;
      n++;
      continue;
    }
    const sleutel = `${zonderRegio(item.sleutel)}@${regioId}`;
    if (!opslag.items[sleutel]) {
      opslag.items[sleutel] = { ...item, sleutel, regio: regioId };
      n++;
    }
  }
  return n;
}

// Een regio weg: de stukken die hij zo kreeg, worden weer landelijk (een kopie verdwijnt).
export function haalRegioWeg(opslag, regioId) {
  const bronnen = perGemeenteBronnen(opslag);
  for (const [sleutel, item] of Object.entries(opslag.items)) {
    if (!bronnen.has(item.bron) || item.regio !== regioId) continue;
    if (sleutel.endsWith(`@${regioId}`)) delete opslag.items[sleutel];
    else item.regio = null;
  }
}

// Legt de gevonden items van één bron vast. Geeft de nieuwe items terug.
export function verwerk(opslag, bron, gevonden, nu = new Date()) {
  const eersteKeer = !opslag.status.bronnen[bron.id]?.laatsteSucces;
  const tijd = nu.toISOString();
  const nieuw = [];
  for (const g of bron.perGemeente ? perRegio(opslag, gevonden) : gevonden) {
    const sleutel = `${bron.id}:${g.sleutel}`;
    // Een stuk voor twee regio's dat al binnen was toen er nog maar één regio was.
    const basis = g.basis && opslag.items[`${bron.id}:${g.basis}`];
    const bestaand = opslag.items[sleutel] || (basis?.regio === g.regio ? basis : null);
    if (bestaand) {
      Object.assign(bestaand, {
        titel: g.titel || bestaand.titel,
        url: g.url || bestaand.url,
        datum: g.datum ?? bestaand.datum,
        laatstGezien: tijd,
        // Een file groeit, een storing krijgt een nieuwe prognose.
        ...(bron.bijwerken ? { tekst: g.tekst ?? bestaand.tekst, ...(g.plek ? { plek: g.plek } : {}), ...(g.punten ? { punten: g.punten } : {}) } : {}),
      });
      continue;
    }
    const item = {
      sleutel,
      bron: bron.id,
      // Een landelijk stuk hoort bij geen regio; het gaat naar de regio's
      // waarvan een sleutelwoord erin staat (src/feed.mjs). Behalve als de bron
      // het stuk zelf bij een regio zet (`perGemeente`, hierboven).
      regio: bron.bereik === 'landelijk' ? g.regio || null : bron.regio,
      ...(g.gemeenten?.length ? { gemeenten: g.gemeenten } : {}),
      soort: bron.soort,
      titel: g.titel,
      url: g.url,
      // Een pagina zonder datums (`datumBijEersteZicht`): de dag dat we het stuk
      // voor het eerst zagen. Niet bij de eerste ronde, want wat er dan al
      // stond, kan van veel eerder zijn.
      datum: g.datum ?? (bron.datumBijEersteZicht && !eersteKeer ? lokaleDatum(nu) : null),
      tekst: g.tekst ?? null,
      afzender: g.afzender ?? null,
      soortStuk: g.soortStuk ?? null,
      advies: g.advies ?? null,
      document: g.document ?? null,
      // Waar het gebeurde, voor de routering naar regio's (src/geo.mjs).
      ...(g.plek ? { plek: g.plek } : {}),
      ...(g.punten ? { punten: g.punten } : {}),
      ...(g.provincies ? { provincies: g.provincies } : {}),
      ...(g.slachtoffer ? { slachtoffer: g.slachtoffer } : {}),
      eersteGezien: tijd,
      laatstGezien: tijd,
      basislijn: !telAlsNieuw(g, bron.soort, eersteKeer, nu),
    };
    // Een archiefbron (`archief`) haalt bij de eerste ronde ook oudere weken op.
    // Wat van de laatste dertig dagen is, staat dan gewoon in de feed, op de
    // datum van het stuk in plaats van als nieuw van vandaag; ouder is nulmeting.
    const leeftijd = eersteKeer && bron.archief ? dagenGeleden(g.datum, nu) : null;
    if (leeftijd !== null && leeftijd >= 0 && leeftijd <= ARCHIEF_IN_FEED_DAGEN) {
      Object.assign(item, { basislijn: false, eersteGezien: new Date(Math.min(+nu, Date.parse(`${g.datum}T12:00:00Z`))).toISOString() });
    }
    opslag.items[sleutel] = item;
    if (!item.basislijn) nieuw.push(item);
  }
  return { nieuw, eersteKeer };
}

// Voor bronnen met `vestiging` (ransomware): de vestigingsplaats van nieuwe
// stukken opzoeken. Hooguit 25 per ronde, twee pogingen per stuk; OpenStreetMap
// wil niet meer dan één verzoek per seconde.
const VESTIGINGEN_PER_RONDE = 25;
export async function vulVestigingen(opslag) {
  const bronnen = new Map(alleBronnen(opslag).filter((b) => b.vestiging).map((b) => [b.id, b]));
  const wachtrij = Object.values(opslag.items)
    .filter((i) => bronnen.has(i.bron) && i.slachtoffer && !i.vestiging && (i.vestigingPogingen || 0) < 2)
    .sort((a, b) => b.eersteGezien.localeCompare(a.eersteGezien))
    .slice(0, VESTIGINGEN_PER_RONDE);
  let gevonden = 0;
  for (const item of wachtrij) {
    try {
      const v = await vindVestiging({ ...item.slachtoffer, hint: item.vestigingHint || {} });
      if (v && !v.onzeker) {
        item.vestiging = v;
        gevonden++;
      } else {
        item.vestigingPogingen = (item.vestigingPogingen || 0) + 1;
        if (v?.onzeker) item.vestigingKandidaten = v.kandidaten.map((k) => `${k.plaats || k.gemeente} (${k.bron})`);
      }
    } catch {
      item.vestigingPogingen = (item.vestigingPogingen || 0) + 1;
    }
  }
  return { gezocht: wachtrij.length, gevonden };
}

function ruimOp(opslag, nu) {
  const bronnen = new Map(alleBronnen(opslag).map((b) => [b.id, b]));
  for (const [sleutel, item] of Object.entries(opslag.items)) {
    // Alleen opruimen wat een werkende bron niet meer toont. Bij een bron die al
    // weken stuk is blijft alles staan, anders komt het bij herstel terug als nieuw.
    // Een bron die alleen het nieuwste toont (ransomware, aardbevingen) bewaart
    // langer: daar is uit beeld raken normaal (`bewaarDagen`).
    const grens = new Date(nu - (bronnen.get(item.bron)?.bewaarDagen || OPRUIMEN_NA_DAGEN) * 86400000).toISOString();
    if (item.laatstGezien < grens && opslag.status.bronnen[item.bron]?.ok) {
      if (item.mediaUid) gooiMediaWeg(opslag.map, item);
      delete opslag.items[sleutel];
    }
  }
}

// Bij files en treinstoringen (`alleenInRegio`) alleen wat in of bij een van
// de regio's ligt: het hele land telt er honderden per dag.
export function inEenRegio(opslag, bron, stuk) {
  const punten = [stuk.plek, ...(stuk.punten || [])].filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  return alleRegios(opslag).some((r) => {
    const g = gemeente(r.naam);
    return g && punten.some((p) => afstandKm(p, g) <= (bron.straalKm ?? 0));
  });
}

async function verzamelBron(opslag, bron) {
  const begin = Date.now();
  const vorige = opslag.status.bronnen[bron.id] || {};
  try {
    const opgehaald = await haalBron(bron, { eersteKeer: !vorige.laatsteSucces });
    const gevonden = bron.alleenInRegio ? opgehaald.filter((g) => inEenRegio(opslag, bron, g)) : opgehaald;
    const { nieuw, eersteKeer } = verwerk(opslag, bron, gevonden);
    opslag.status.bronnen[bron.id] = {
      ok: true,
      fout: null,
      // Een parser die ineens niets meer vindt, is vrijwel altijd een gewijzigde site.
      // Bij een bron waar niets vaak gewoon niets is (geen code oranje, geen
      // Nederlands slachtoffer), is een lege ronde geen waarschuwing waard.
      waarschuwing: gevonden.length === 0 && !bron.leegKan ? 'De bron leverde niets op. Is de pagina veranderd?' : null,
      laatsteRonde: new Date().toISOString(),
      laatsteSucces: new Date().toISOString(),
      aantal: gevonden.length,
      nieuw: nieuw.length,
      nulmeting: eersteKeer,
      duurMs: Date.now() - begin,
    };
    return { bron: bron.id, ok: true, aantal: gevonden.length, nieuw: nieuw.length };
  } catch (fout) {
    opslag.status.bronnen[bron.id] = {
      ...vorige,
      ok: false,
      fout: fout.message,
      laatsteRonde: new Date().toISOString(),
      duurMs: Date.now() - begin,
    };
    // Alleen de eerste mislukte ronde komt in het logboek, niet elk uur opnieuw.
    return { bron: bron.id, ok: false, fout: fout.message, nieuweFout: vorige.ok !== false };
  }
}

let lopend = null;

// Bronnen met een eigen, korter interval (`intervalMinuten`: files en
// treinstoringen) tussen de gewone rondes door. Geeft het aantal nieuwe stukken.
export async function verzamelSnel(opslag, nu = Date.now()) {
  if (lopend) return 0;
  const bronnen = teVerzamelen(opslag).filter((b) => b.intervalMinuten
    && nu - Date.parse(opslag.status.bronnen[b.id]?.laatsteRonde || 0) >= b.intervalMinuten * 60000);
  if (!bronnen.length) return 0;
  let nieuw = 0;
  for (const bron of bronnen) {
    const r = await verzamelBron(opslag, bron);
    nieuw += r.nieuw || 0;
    if (r.nieuweFout) opslag.log({ soort: 'bronfout', tekst: `${r.bron}: ${r.fout}` });
  }
  opslag.bewaar('items', 'status');
  return nieuw;
}

// Twee rondes tegelijk (de klok en iemand die op "Nu controleren" drukt) zouden
// elkaars items dubbel tellen; de tweede wacht gewoon op de eerste.
export function verzamelAlles(opslag, voortgang) {
  if (lopend) return lopend;
  lopend = (async () => {
    const bronnen = teVerzamelen(opslag);
    const resultaten = [];
    const wachtrij = [...bronnen];
    await Promise.all(Array.from({ length: GELIJKTIJDIG }, async () => {
      while (wachtrij.length) {
        resultaten.push(await verzamelBron(opslag, wachtrij.shift()));
        voortgang?.({ stap: resultaten.length, totaal: bronnen.length, tekst: `${resultaten.length} van ${bronnen.length} bronnen gecontroleerd` });
      }
    }));
    ruimOp(opslag, new Date());
    // De inhoud achter de links, voor de samenvatting (src/inhoud.mjs).
    opslag.status.inhoud = { ...(await vulInhoud(opslag, { voortgang })), tijd: new Date().toISOString() };
    // Waar ransomwareslachtoffers gevestigd zijn (src/locatie.mjs).
    opslag.status.vestigingen = { ...(await vulVestigingen(opslag)), tijd: new Date().toISOString() };
    opslag.status.laatsteVerzamelronde = new Date().toISOString();
    opslag.bewaar('items', 'status');
    const fouten = resultaten.filter((r) => r.nieuweFout);
    if (fouten.length) {
      opslag.log({ soort: 'bronfout', tekst: fouten.map((f) => `${f.bron}: ${f.fout}`).join('\n') });
    }
    return resultaten;
  })().finally(() => { lopend = null; });
  return lopend;
}
