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

import { teVerzamelen } from './register.mjs';
import { haalBron } from './bronnen/index.mjs';
import { dagenGeleden } from './datum.mjs';
import { vulInhoud } from './inhoud.mjs';

const MAX_LEEFTIJD_DAGEN = { nieuws: 21, ingekomen: 21, woo: null };
const NULMETING_RECENT_DAGEN = 2;
const OPRUIMEN_NA_DAGEN = 60;
const GELIJKTIJDIG = 4;

export function telAlsNieuw(item, soort, eersteKeer, nu) {
  const leeftijd = dagenGeleden(item.datum, nu);
  if (eersteKeer) return leeftijd !== null && leeftijd <= NULMETING_RECENT_DAGEN && leeftijd > -60;
  const max = MAX_LEEFTIJD_DAGEN[soort];
  return !(max && leeftijd !== null && leeftijd > max);
}

// Legt de gevonden items van één bron vast. Geeft de nieuwe items terug.
export function verwerk(opslag, bron, gevonden, nu = new Date()) {
  const eersteKeer = !opslag.status.bronnen[bron.id]?.laatsteSucces;
  const tijd = nu.toISOString();
  const nieuw = [];
  for (const g of gevonden) {
    const sleutel = `${bron.id}:${g.sleutel}`;
    const bestaand = opslag.items[sleutel];
    if (bestaand) {
      Object.assign(bestaand, {
        titel: g.titel || bestaand.titel,
        url: g.url || bestaand.url,
        datum: g.datum ?? bestaand.datum,
        laatstGezien: tijd,
      });
      continue;
    }
    const item = {
      sleutel,
      bron: bron.id,
      // Een landelijk stuk hoort bij geen regio; het gaat naar de regio's
      // waarvan een sleutelwoord erin staat (src/feed.mjs).
      regio: bron.bereik === 'landelijk' ? null : bron.regio,
      soort: bron.soort,
      titel: g.titel,
      url: g.url,
      datum: g.datum ?? null,
      tekst: g.tekst ?? null,
      afzender: g.afzender ?? null,
      soortStuk: g.soortStuk ?? null,
      advies: g.advies ?? null,
      document: g.document ?? null,
      eersteGezien: tijd,
      laatstGezien: tijd,
      basislijn: !telAlsNieuw(g, bron.soort, eersteKeer, nu),
    };
    opslag.items[sleutel] = item;
    if (!item.basislijn) nieuw.push(item);
  }
  return { nieuw, eersteKeer };
}

function ruimOp(opslag, nu) {
  const grens = new Date(nu - OPRUIMEN_NA_DAGEN * 86400000).toISOString();
  for (const [sleutel, item] of Object.entries(opslag.items)) {
    // Alleen opruimen wat een werkende bron niet meer toont. Bij een bron die al
    // weken stuk is blijft alles staan, anders komt het bij herstel terug als nieuw.
    if (item.laatstGezien < grens && opslag.status.bronnen[item.bron]?.ok) delete opslag.items[sleutel];
  }
}

async function verzamelBron(opslag, bron) {
  const begin = Date.now();
  const vorige = opslag.status.bronnen[bron.id] || {};
  try {
    const gevonden = await haalBron(bron);
    const { nieuw, eersteKeer } = verwerk(opslag, bron, gevonden);
    opslag.status.bronnen[bron.id] = {
      ok: true,
      fout: null,
      // Een parser die ineens niets meer vindt, is vrijwel altijd een gewijzigde site.
      waarschuwing: gevonden.length === 0 ? 'De bron leverde niets op. Is de pagina veranderd?' : null,
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
