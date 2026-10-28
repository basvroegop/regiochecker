// Teams-kanalen: wat er binnenkomt voor de gekozen regio's en bronnen, als
// kaartje in een kanaal van Microsoft Teams. Overgenomen uit de checker
// (/opt/checker/backend/services/notifier.py). Een kanaal krijgt berichten via
// een workflow in Teams ("Post to a channel when a webhook request is
// received"); de oude Office 365-connectors bestaan niet meer. Die workflow
// verwacht een bericht met een Adaptive Card als bijlage.
//
// Per kanaal (data/kanalen.json, in te stellen door een admin):
//   naam, url       het adres van de workflow; dat is een sleutel, dus het gaat
//                   nooit terug naar de browser en staat nergens in het logboek
//   regios          [] = alle regio's
//   soorten         tabbladen van de feed ('ransomware', 'woo', …), met de
//                   bronnen die er later bij komen
//   bronnen         losse bronnen; soorten en bronnen allebei leeg = alles
//
// Na elke ronde (websites, kamerstukken, audio) gaat wat er sinds de vorige
// keer binnenkwam naar het kanaal: elk stuk een eigen kaartje. Zijn het er in
// één keer meer dan tien, dan krijgen de tien nieuwste een eigen kaartje en
// staan de oudere samen in één overzicht, dat eerst komt.

import { randomUUID } from 'node:crypto';
import { fetch } from 'undici';
import { controleerUrl, openbaarDispatcher } from './netwerk.mjs';
import { maakKader, kanaalRegels } from './feed.mjs';
import { GROEPEN, groepVan } from './regios.mjs';
import { alleBronnen } from './register.mjs';
import { korteDatum } from './datum.mjs';
import { InvoerFout } from './gebruikers.mjs';
import { stukUrl } from './kamer/db.mjs';

const LOS = 10;
const IN_OVERZICHT = 30;
const TIJDLIMIET_MS = 20_000;
const tussenpoos = () => Number(process.env.TEAMS_TUSSENPOOS_MS ?? 400);
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- instellen ----------

// Alleen het begin van het adres, om het kanaal te herkennen.
export function adresVoorClient(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname.length > 1 ? '/…' : ''}`;
  } catch {
    return '';
  }
}

export function kanaalVoorClient(kanaal) {
  const { url, verzonden, ...rest } = kanaal;
  return { ...rest, adres: adresVoorClient(url) };
}

export function controleerKanaal(invoer, bestaand, { regioIds, bronIds }) {
  const naam = String(invoer.naam ?? bestaand?.naam ?? '').trim().slice(0, 80);
  if (!naam) throw new InvoerFout('Geef het kanaal een naam');
  // Leeg bij wijzigen: het adres blijft wat het was.
  const url = String(invoer.url || '').trim() || bestaand?.url || '';
  let adres;
  try {
    adres = new URL(url);
  } catch {
    throw new InvoerFout('Plak het adres van de workflow in Teams (begint met https://)');
  }
  if (adres.protocol !== 'https:') throw new InvoerFout('Het adres moet met https:// beginnen');
  const lijst = (veld, toegestaan, wat) => {
    const waarde = invoer[veld] ?? bestaand?.[veld] ?? [];
    if (!Array.isArray(waarde)) throw new InvoerFout(`Geef de ${wat} als lijst`);
    const onbekend = waarde.find((x) => !toegestaan.includes(x));
    if (onbekend) throw new InvoerFout(`Onbekende ${wat}: ${onbekend}`);
    return [...new Set(waarde)];
  };
  return {
    naam,
    url: adres.href,
    regios: lijst('regios', regioIds, "regio's"),
    soorten: lijst('soorten', Object.keys(GROEPEN), 'soorten'),
    bronnen: lijst('bronnen', bronIds, 'bronnen'),
    actief: Boolean(invoer.actief ?? bestaand?.actief ?? true),
  };
}

export function nieuwKanaal(gegevens, nu = new Date()) {
  // Vanaf nu: een nieuw kanaal krijgt geen achterstand.
  return { id: randomUUID(), ...gegevens, aangemaakt: nu.toISOString(), laatsteVerzending: nu.toISOString(), laatsteFout: null, verzonden: [] };
}

// Wat er te kiezen valt: regio's, en de bronnen per tabblad van de feed.
export function kanaalKeuzes(ctx) {
  const k = ctx.regios ? ctx : maakKader(ctx);
  const perSoort = new Map(Object.entries(GROEPEN).map(([id, naam]) => [id, { id, naam, bronnen: [] }]));
  for (const b of alleBronnen(k.opslag)) {
    if (b.type === 'ontbreekt') continue;
    const groep = perSoort.get(groepVan(b.soort));
    groep?.bronnen.push({ id: b.id, naam: b.naam, regio: b.regio || null });
  }
  return { regios: k.regios.map((r) => ({ id: r.id, naam: r.naam })), soorten: [...perSoort.values()].filter((s) => s.bronnen.length) };
}

// ---------- het kaartje ----------

const site = () => (process.env.REGIOCHECKER_SITE_URL || '').replace(/\/$/, '');
const kort = (t, n) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s;
};

const mediaTelling = (media) => {
  const fotos = media.filter((m) => m.soort === 'foto').length;
  const videos = media.length - fotos;
  return [fotos && `${fotos} foto${fotos === 1 ? '' : "'s"}`, videos && `${videos} video${videos === 1 ? '' : "'s"}`].filter(Boolean).join(' en ');
};

// De kern van een regel: waar het over gaat, en waar het staat.
function inhoudVan(k, regel) {
  const [soort, ...rest] = regel.id.split(':');
  const id = rest.join(':');
  if (soort === 'i') {
    const item = k.opslag.items[id] || {};
    const v = item.vestiging;
    return {
      url: item.url,
      tekst: item.tekst,
      feiten: [
        item.afzender && [item.inzender ? 'Inzender' : 'Afzender', item.afzender],
        // Een inzending: hoe de redactie de inzender bereikt, en wat er bij zit.
        // De foto's zelf staan achter de inlog; Teams kan ze niet ophalen.
        item.inzender?.telefoon && ['Telefoon', item.inzender.telefoon],
        item.inzender?.username && ['Telegram', `@${item.inzender.username}`],
        item.media?.length && ['Bij de inzending', mediaTelling(item.media)],
        v && ['Vestiging', `${v.plaats || v.gemeente}${v.plaats && v.plaats !== v.gemeente ? ` (gemeente ${v.gemeente})` : ''}`],
      ],
    };
  }
  if (soort === 'k') {
    const stuk = k.kdb?.stuk(id);
    return { url: stuk ? stukUrl(stuk) : null, tekst: stuk?.onderwerp, feiten: [] };
  }
  const a = k.adb?.aflevering(id);
  return { url: a?.url, tekst: a?.samenvatting?.tekst, feiten: [] };
}

function kaart(lichaam, acties = []) {
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        type: 'AdaptiveCard',
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.4',
        body: lichaam,
        ...(acties.length ? { actions: acties } : {}),
      },
    }],
  };
}

export function stukKaart(k, regel) {
  const { url, tekst, feiten } = inhoudVan(k, regel);
  const bron = k.bronnen.get(regel.bron);
  const regioNamen = regel.regios.map((r) => k.regioMap.get(r)?.naam).filter(Boolean);
  const lichaam = [
    { type: 'TextBlock', text: kort(regel.titel, 300), weight: 'Bolder', size: 'Medium', wrap: true },
    { type: 'TextBlock', text: [regioNamen.join(', ') || 'Landelijk', regel.soortNaam].filter(Boolean).join(' · '), isSubtle: true, spacing: 'None', wrap: true },
  ];
  if (tekst) lichaam.push({ type: 'TextBlock', text: kort(tekst, 500), wrap: true });
  const rijen = [
    regel.datum && ['Datum', korteDatum(regel.datum)],
    // Waarom bij deze regio: de plek (een aardbeving, een file) of een sleutelwoord.
    regel.match?.term && regel.match.regio && !regel.match.plek && ['Gevonden', regel.match.term],
    regel.match?.plek && regel.match.term !== 'plaats onbekend' && !feiten.some((f) => f?.[0] === 'Vestiging') && ['Waar', regel.match.term],
    ...feiten,
    bron?.naam && ['Bron', bron.naam],
  ].filter(Boolean);
  if (rijen.length) lichaam.push({ type: 'FactSet', facts: rijen.map(([title, value]) => ({ title, value: String(value) })) });
  const acties = [
    site() && { type: 'Action.OpenUrl', title: 'Openen in de Regiochecker', url: `${site()}/#/feed?stuk=${encodeURIComponent(regel.id)}` },
    url && /^https?:\/\//.test(url) && { type: 'Action.OpenUrl', title: 'Naar de bron', url },
  ].filter(Boolean);
  return kaart(lichaam, acties);
}

export function overzichtKaart(k, regels, kanaal) {
  const lijst = regels.slice(0, IN_OVERZICHT).map((r) => {
    const link = site() ? `${site()}/#/feed?stuk=${encodeURIComponent(r.id)}` : inhoudVan(k, r).url;
    const titel = kort(r.titel, 140).replace(/[[\]]/g, '');
    return `- ${link ? `[${titel}](${link})` : titel} · ${r.soortNaam}`;
  });
  if (regels.length > IN_OVERZICHT) lijst.push(`- en nog ${regels.length - IN_OVERZICHT}`);
  return kaart([
    { type: 'TextBlock', text: `Nog ${regels.length} nieuw${regels.length === 1 ? ' stuk' : 'e stukken'} voor ${kanaal.naam}`, weight: 'Bolder', size: 'Medium', wrap: true },
    { type: 'TextBlock', text: lijst.join('\n'), wrap: true },
  ], site() ? [{ type: 'Action.OpenUrl', title: 'Naar de feed', url: `${site()}/#/feed` }] : []);
}

export function testKaart(kanaal, keuzes) {
  const regios = kanaal.regios.length ? kanaal.regios.map((id) => keuzes.regios.find((r) => r.id === id)?.naam || id).join(', ') : "alle regio's";
  const soorten = keuzes.soorten.filter((s) => kanaal.soorten.includes(s.id)).map((s) => s.naam);
  const bronnen = keuzes.soorten.flatMap((s) => s.bronnen).filter((b) => kanaal.bronnen.includes(b.id)).map((b) => b.naam);
  return kaart([
    { type: 'TextBlock', text: `Regiochecker: proefbericht voor ${kanaal.naam}`, weight: 'Bolder', size: 'Medium', wrap: true },
    { type: 'TextBlock', text: 'Dit kanaal is goed ingesteld. Hier verschijnt voortaan wat er binnenkomt:', wrap: true },
    { type: 'FactSet', facts: [{ title: "Regio's", value: regios }, { title: 'Bronnen', value: [...soorten, ...bronnen].join(', ') || 'alle bronnen' }] },
  ]);
}

// ---------- versturen ----------

// Rechtstreeks, zonder de doorverwijzingen en herkansingen van src/ophalen.mjs:
// een tweede poging kan een dubbel bericht geven, en het adres hoort niet in
// een foutmelding.
export async function stuurNaarTeams(url, bericht) {
  let antwoord;
  try {
    controleerUrl(url);
    antwoord = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Regiochecker/1.0' },
      body: JSON.stringify(bericht),
      redirect: 'manual',
      dispatcher: openbaarDispatcher,
      signal: AbortSignal.timeout(TIJDLIMIET_MS),
    });
  } catch (fout) {
    throw new Error(`Teams niet bereikbaar (${fout.cause?.code || fout.name || 'netwerkfout'})`);
  }
  const tekst = await antwoord.text().catch(() => '');
  if (!antwoord.ok) {
    const uitleg = antwoord.status === 404 || antwoord.status === 401 || antwoord.status === 403
      ? 'Bestaat de workflow in Teams nog, en staat die aan?'
      : kort(tekst.replace(/https?:\/\/[^\s"'<>]+/g, '…'), 160);
    throw new Error(`Teams gaf HTTP ${antwoord.status}${uitleg ? `: ${uitleg}` : ''}`);
  }
}

// Na elke ronde. Nooit twee tegelijk, net als de meldingen.
let wachtrij = Promise.resolve();
export function verwerkKanalen(ctx, opties = {}) {
  const resultaat = wachtrij.then(() => verwerk(ctx, opties));
  wachtrij = resultaat.catch(() => {});
  return resultaat;
}

async function verwerk(ctx, { nu = new Date() } = {}) {
  const { opslag } = ctx;
  const kanalen = (opslag.kanalen || []).filter((c) => c.actief !== false && c.url);
  if (!kanalen.length) return [];
  const k = maakKader(ctx);
  const resultaten = [];
  for (const kanaal of kanalen) {
    const tot = nu.toISOString();
    // Wat bij een vorige, half gelukte poging al aankwam.
    const al = new Set(kanaal.verzonden || []);
    const regels = kanaalRegels(k, kanaal, { sinds: kanaal.laatsteVerzending || kanaal.aangemaakt, tot }).filter((r) => !al.has(r.id));
    if (!regels.length) {
      Object.assign(kanaal, { laatsteVerzending: tot, verzonden: [] });
      continue;
    }
    let gelukt = 0;
    try {
      const los = regels.slice(-LOS);
      const samen = regels.slice(0, regels.length - los.length);
      if (samen.length) {
        await stuurNaarTeams(kanaal.url, overzichtKaart(k, samen, kanaal));
        for (const r of samen) al.add(r.id);
        gelukt += samen.length;
      }
      for (const r of los) {
        if (gelukt) await slaap(tussenpoos());
        await stuurNaarTeams(kanaal.url, stukKaart(k, r));
        al.add(r.id);
        gelukt++;
      }
      Object.assign(kanaal, { laatsteVerzending: tot, verzonden: [], laatsteFout: null, laatsteAantal: regels.length, laatsteSucces: tot });
      opslag.log({ soort: 'teams', aan: kanaal.naam, tekst: `${regels.length} ${regels.length === 1 ? 'stuk' : 'stukken'} naar Teams` });
      resultaten.push({ id: kanaal.id, verstuurd: regels.length });
    } catch (fout) {
      // De volgende ronde probeert het opnieuw, zonder wat al aankwam.
      // Alleen een nieuwe fout in het logboek, niet elke ronde dezelfde.
      if (kanaal.laatsteFout !== fout.message) {
        opslag.log({ soort: 'teamsfout', aan: kanaal.naam, tekst: `${fout.message}${gelukt ? ` (${gelukt} van ${regels.length} wel verstuurd)` : ''}` });
      }
      Object.assign(kanaal, { verzonden: [...al], laatsteFout: fout.message });
      resultaten.push({ id: kanaal.id, verstuurd: gelukt, fout: fout.message });
    }
  }
  opslag.bewaar('kanalen');
  return resultaten;
}
