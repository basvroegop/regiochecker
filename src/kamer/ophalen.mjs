// Kamerstukken binnenhalen uit het Gegevensmagazijn van de Tweede Kamer
// (opendata.tweedekamer.nl, OData v4). Twee stappen per ronde:
//
//  1. Metadata: alles wat sinds het synchronisatiepunt is gewijzigd
//     (ApiGewijzigdOp), vanaf KAMERSTUKKEN_VANAF. Verwijderde documenten gaan
//     eruit, nieuwe versies krijgen hun tekst opnieuw.
//  2. Tekst: het document zelf (pdf of docx) downloaden en indexeren, nieuwste
//     eerst, een beperkt aantal per ronde. De eerste keer (ruim 6.000 stukken
//     sinds Prinsjesdag) duurt dat zo een halve dag; daarna is het bijhouden.

import { haalJson, haalBestand } from '../ophalen.mjs';
import { stukNaarTekst } from './tekst.mjs';

// Instelbaar voor de tests (nagebootste API).
const api = () => process.env.KAMERSTUKKEN_API || 'https://gegevensmagazijn.tweedekamer.nl/OData/v4/2.0';
// Begin van het vergaderjaar 2026-2027 (Prinsjesdag). Verder terug kan, via de
// omgeving; dan haalt de dienst die stukken er geleidelijk bij. Elke keer
// opnieuw gelezen, zodat de tests het kunnen wijzigen.
export const vanaf = () => process.env.KAMERSTUKKEN_VANAF || '2026-09-15';
// Per ronde hooguit MAX_PAGINAS pagina's; instelbaar voor de tests.
const pagina = () => Number(process.env.KAMERSTUKKEN_PAGINA) || 250;
const maxPaginas = () => Number(process.env.KAMERSTUKKEN_MAX_PAGINAS) || 40;
const TEKSTEN_PER_RONDE = 600;
const POGINGEN = 3;
const GELIJKTIJDIG = 3;

export function zetOm(d) {
  const dossier = d.Kamerstukdossier?.[0];
  const actoren = (d.DocumentActor || [])
    .map((a) => [a.ActorNaam, a.Functie || a.ActorFractie].filter(Boolean).join(', '))
    .filter(Boolean);
  return {
    id: d.Id,
    nummer: d.DocumentNummer || null,
    soort: d.Soort || null,
    titel: (d.Titel || '').trim(),
    onderwerp: (d.Onderwerp || '').trim(),
    datum: (d.Datum || '').slice(0, 10) || null,
    vergaderjaar: d.Vergaderjaar || null,
    dossier: dossier ? `${dossier.Nummer}${dossier.Toevoeging ? `-${dossier.Toevoeging}` : ''}` : null,
    dossiertitel: dossier?.Titel || null,
    zaak: d.Zaak?.[0]?.Nummer || null,
    afzender: actoren.slice(0, 3).join('; ') || null,
    contenttype: d.ContentType || null,
    gewijzigd: d.GewijzigdOp || d.ApiGewijzigdOp,
  };
}

function metadataUrl(punt, skip) {
  const filter = `Datum ge ${vanaf()}T00:00:00Z and ApiGewijzigdOp gt ${punt}`;
  const params = {
    $filter: filter,
    $orderby: 'ApiGewijzigdOp,Id',
    $top: String(pagina()),
    $skip: String(skip),
    $select: 'Id,DocumentNummer,Soort,Titel,Onderwerp,Datum,Vergaderjaar,ContentType,GewijzigdOp,ApiGewijzigdOp,Verwijderd',
    $expand: 'Kamerstukdossier($select=Nummer,Toevoeging,Titel),Zaak($select=Nummer),DocumentActor($select=ActorNaam,Functie,ActorFractie)',
  };
  // Zelf coderen: URLSearchParams maakt van een spatie een +, en OData wil %20.
  return `${api()}/Document?${Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

// Stap 1. Het synchronisatiepunt schuift pas op als alle pagina's van deze
// ronde binnen zijn; blijft er meer over, dan gaat de volgende ronde verder.
// Precies daar: het punt komt net vóór de laatst gelezen tijdstempel, en
// synchronisatieSkip zegt hoeveel stukken met die tijdstempel al binnen zijn.
// Zo valt er op de grens niets weg, ook niet bij gelijke tijdstempels, en
// komt een ronde ook verder als er meer dan een ronde vol dezelfde tijdstempel heeft.
export async function synchroniseer(kdb) {
  // Ander startpunt dan de vorige keer: opnieuw vanaf het begin synchroniseren.
  // Anders vraagt hij alleen wijzigingen na het oude punt op, en komen de oudere
  // stukken er nooit bij. Wat er al is, blijft staan; tekst wordt alleen opnieuw
  // opgehaald voor stukken die echt gewijzigd zijn.
  const vorigVanaf = kdb.staat('vanaf');
  if (vorigVanaf && vorigVanaf !== vanaf()) {
    kdb.zetStaat('synchronisatiepunt', '1900-01-01T00:00:00Z');
    kdb.zetStaat('synchronisatieSkip', '0');
  }
  kdb.zetStaat('vanaf', vanaf());
  const punt = kdb.staat('synchronisatiepunt') || '1900-01-01T00:00:00Z';
  const begin = Number(kdb.staat('synchronisatieSkip') || 0);
  const tijd = (t) => Date.parse(t) || 0;
  let hoogste = punt;
  let opHoogste = 0;
  let nieuw = 0;
  let bijgewerkt = 0;
  let verwijderd = 0;
  // Klaar als er een pagina komt die niet vol is (ook als dat de laatste van de ronde is).
  let klaar = false;
  for (let p = 0; p < maxPaginas() && !klaar; p++) {
    const { value = [] } = await haalJson(metadataUrl(punt, begin + p * pagina()));
    for (const d of value) {
      // Op volgorde van ApiGewijzigdOp: tel hoeveel er op de hoogste milliseconde staan.
      if (tijd(d.ApiGewijzigdOp) > tijd(hoogste)) {
        hoogste = d.ApiGewijzigdOp;
        opHoogste = 1;
      } else if (tijd(d.ApiGewijzigdOp) === tijd(hoogste)) {
        opHoogste++;
      }
      if (d.Verwijderd) {
        if (kdb.verwijderStuk(d.Id)) verwijderd++;
        continue;
      }
      if (kdb.bewaarStuk(zetOm(d)) === 'nieuw') nieuw++;
      else bijgewerkt++;
    }
    if (value.length < pagina()) klaar = true;
  }
  if (klaar) {
    kdb.zetStaat('synchronisatiepunt', hoogste);
    kdb.zetStaat('synchronisatieSkip', '0');
  } else {
    const netVoor = new Date(tijd(hoogste) - 1).toISOString();
    // Kwam deze ronde niet voorbij die milliseconde, dan tellen de eerder gelezen stukken mee.
    kdb.zetStaat('synchronisatieSkip', String((netVoor === punt ? begin : 0) + opHoogste));
    kdb.zetStaat('synchronisatiepunt', netVoor);
  }
  kdb.zetStaat('laatsteSync', new Date().toISOString());
  return { nieuw, bijgewerkt, verwijderd, klaar };
}

// Stap 2.
export async function haalTeksten(kdb, { max = TEKSTEN_PER_RONDE, voortgang } = {}) {
  const wachtrij = kdb.wachtrij(max, POGINGEN);
  let gelukt = 0;
  let mislukt = 0;
  const totaal = wachtrij.length;
  await Promise.all(Array.from({ length: GELIJKTIJDIG }, async () => {
    while (wachtrij.length) {
      const stuk = wachtrij.shift();
      try {
        const { buffer } = await haalBestand(`${api()}/Document(${stuk.id})/resource`);
        kdb.bewaarTekst(stuk.nr, await stukNaarTekst(buffer, stuk.contenttype));
        gelukt++;
      } catch (fout) {
        kdb.tekstMislukt(stuk.nr, fout.message);
        mislukt++;
      }
      voortgang?.({ stap: gelukt + mislukt, totaal, tekst: `kamerstukken: ${gelukt + mislukt} van ${totaal} teksten` });
    }
  }));
  return { gelukt, mislukt, over: kdb.status().wachtrij };
}
