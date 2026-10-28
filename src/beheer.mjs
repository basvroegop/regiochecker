// Beheer (alleen voor admins): regio's met hun bronnen, sleutelwoorden en
// volgers; het bronnenregister met een proefronde voor een nieuwe bron; en de
// gebruikers. Aangeroepen vanuit src/api.mjs; geeft true als het verzoek hier hoort.

import { SOORTEN, ENKELVOUD, AUDIOSOORTEN } from './regios.mjs';
import {
  alleRegios, alleBronnen, bronnenVanRegio, landelijkeBronnen, TWEEDE_KAMER,
  geldtVoor, actieveTermen, maakId, sleutelOntbreekt,
} from './register.mjs';
import { haalBron } from './bronnen/index.mjs';
import { schoneTermen, vindTermen, vindInSegmenten } from './termen.mjs';
import { maakKader, routeerItem, routeerAflevering, tekstVan } from './feed.mjs';
import { herkenBron, ontdek as ontdekCatalogus, YOUTUBE_SOORTEN } from './audio/catalogus.mjs';
import { PLATFORMS } from './audio/vergaderingen.mjs';
import { worker as audioWorker } from './audio/worker.mjs';
import { gooiAudioWeg } from './audio/ophalen.mjs';
import { isAudio } from './audio/verwerking.mjs';
import { nieuweGebruiker, werkGebruikerBij, voorClient, InvoerFout } from './gebruikers.mjs';
import { volgendeWeekmail } from './planning.mjs';
import { controleerKanaal, nieuwKanaal, kanaalVoorClient, kanaalKeuzes, stuurNaarTeams, testKaart } from './kanalen.mjs';

const DAG_MS = 86400000;
const RUIS = 25;

export const LEZERS = {
  rss: 'RSS',
  ibabs: 'iBabs',
  'notubiz-ingekomen': 'Notubiz-API',
  'smallingerland-nieuws': 'HTML',
  'smallingerland-woo': 'HTML, zonder datums',
  'swf-nieuws': 'HTML',
  'swf-ingekomen': 'Pdf-weeklijst',
  'swf-woo': 'HTML-tabel',
  'gpp-woo': 'Woo-platform (GPP)',
  'groningen-bw-besluiten': 'HTML',
  ontbreekt: 'Niet online',
  'tweede-kamer': 'Gegevensmagazijn OData',
};

// Hoe een audiobron gelezen wordt, voor op het scherm.
const AUDIO_LEZER = {
  ...Object.fromEntries(Object.entries(PLATFORMS).map(([k, v]) => [k, `${v}-archief`])),
  rss: 'Podcast-RSS',
  video: 'YouTube-video',
  ...Object.fromEntries(Object.entries(YOUTUBE_SOORTEN).map(([k, [naam]]) => [k, `YouTube · ${naam.toLowerCase()}`])),
};

const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const geleden = (dagen) => new Date(Date.now() - dagen * DAG_MS).toISOString();

// ---------- status en tellingen ----------

export function bronStatus(opslag, bron) {
  if (bron.type === 'ontbreekt') return { staat: 'ontbreekt', tekst: 'Niet gevonden' };
  if (sleutelOntbreekt(bron)) return { staat: 'ontbreekt', tekst: 'Sleutel nodig', fout: `Zet ${bron.sleutel} in .env om deze bron te gebruiken.` };
  const s = bron.id === TWEEDE_KAMER.id ? opslag.status.kamer : opslag.status.bronnen[bron.id];
  if (!s) return { staat: 'wacht', tekst: 'Nog niet gecontroleerd' };
  const tijd = s.laatsteRonde || s.tijd || null;
  if (s.ok === false) return { staat: 'fout', tekst: 'Fout', fout: s.fout, tijd };
  if (bron.vervangend) return { staat: 'vervangend', tekst: 'Vervangend', tijd, waarschuwing: s.waarschuwing || null };
  return { staat: 'werkt', tekst: 'Werkt', tijd, waarschuwing: s.waarschuwing || null };
}

// Nieuwe stukken in de afgelopen `dagen` per bron.
function nieuwPerBron(k, dagen = 7) {
  const grens = geleden(dagen);
  const uit = {};
  for (const item of Object.values(k.opslag.items)) {
    if (item.basislijn || item.eersteGezien <= grens) continue;
    uit[item.bron] = (uit[item.bron] || 0) + 1;
  }
  if (k.adb) {
    for (const r of k.adb.db.prepare('SELECT bron, count(*) n FROM afleveringen WHERE eerst_gezien > ? GROUP BY bron').all(grens)) uit[r.bron] = r.n;
  }
  if (k.kdb) {
    uit[TWEEDE_KAMER.id] = k.kdb.db.prepare('SELECT count(*) n FROM stukken WHERE binnen > ? AND datum >= ?').get(grens, grens.slice(0, 10)).n;
  }
  return uit;
}

function bronVoorClient(k, bron, nieuw) {
  const regio = bron.regio ? k.regioMap.get(bron.regio) : null;
  return {
    id: bron.id,
    naam: bron.naam,
    label: bron.label || null,
    soort: bron.soort,
    soortNaam: SOORTEN[bron.soort] || ENKELVOUD[bron.soort] || bron.soort,
    bereik: bron.bereik,
    regio: bron.regio || null,
    regioNaam: regio?.naam || null,
    url: bron.url,
    host: host(bron.url),
    lezer: bron.audio ? AUDIO_LEZER[bron.audio.kind] || 'Audio' : LEZERS[bron.type] || bron.type,
    ingebouwd: Boolean(bron.ingebouwd),
    toelichting: bron.toelichting || null,
    status: bronStatus(k.opslag, bron),
    nieuw7: bron.type === 'ontbreekt' ? null : (nieuw[bron.id] || 0),
    termen: bron.bereik === 'landelijk' ? k.regios.filter((r) => geldtVoor(r, bron.id)).reduce((n, r) => n + actieveTermen(r).length, 0) : null,
    // Signalen gaan (ook) via hun plek naar een regio (src/feed.mjs).
    viaPlek: bron.geo ? (bron.soort === 'weerwaarschuwing' ? 'provincie' : 'plek') : bron.plaatsen ? 'plaatsnaam' : null,
    audio: bron.audio ? {
      kind: bron.audio.kind,
      eersteImport: bron.audio.eersteImport,
      actief: bron.audio.actief !== false,
      prioriteit: bron.audio.prioriteit ?? 0,
      titel: bron.audio.titel || null,
      catalogus: k.opslag.status.bronnen[bron.id]?.aantal ?? null,
      bezig: Boolean(k.opslag.status.bronnen[bron.id]?.bezig),
      tellingen: k.audioTellingen?.[bron.id] || { totaal: 0, klaar: 0, bezig: 0, mislukt: 0, transcripten: 0 },
    } : null,
  };
}

// Hoeveel stukken uit landelijke bronnen bevatten deze term (afgelopen `dagen`)?
function telTerm(k, term, regio, dagen = 30) {
  const grens = geleden(dagen);
  let n = 0;
  if (k.kdb && (!regio || geldtVoor(regio, TWEEDE_KAMER.id))) n += k.kdb.telStukken([term], grens.slice(0, 10));
  for (const item of Object.values(k.opslag.items)) {
    if (item.regio || item.basislijn || item.eersteGezien <= grens) continue;
    const bron = k.bronnen.get(item.bron);
    if (bron?.bereik !== 'landelijk' || (regio && !geldtVoor(regio, bron.id))) continue;
    if (vindTermen(tekstVan(k, item), [term]).length) n++;
  }
  if (k.adb) {
    for (const a of k.adb.metTranscriptSinds(grens)) {
      const bron = k.bronnen.get(a.bron);
      if (bron?.bereik !== 'landelijk' || (regio && !geldtVoor(regio, bron.id))) continue;
      if (vindInSegmenten(a.segmenten, [term]).length) n++;
    }
  }
  return n;
}

const weekmailTekst = (g) => {
  const w = g.weekmail;
  if (!w?.aan || !g.email) return 'alleen feed';
  const dagen = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'];
  return `weekmail ${w.dagen.map((d) => dagen[d - 1]).join(', ')} ${w.tijd}`;
};

function regioOverzicht(k) {
  return k.regios.map((r) => {
    const bronnen = bronnenVanRegio(k.opslag, r.id);
    const statussen = bronnen.map((b) => bronStatus(k.opslag, b));
    const fouten = statussen.filter((s) => s.staat === 'fout').length;
    const ontbreekt = bronnen.filter((b) => b.type === 'ontbreekt').map((b) => SOORTEN[b.soort]?.split(/[ -]/)[0] || b.soort);
    let let_ = null;
    if (fouten) let_ = `${fouten} fout`;
    else if (ontbreekt.length) let_ = `${ontbreekt.join(', ')} ontbreekt`;
    else if (bronnen.some((b) => b.vervangend)) let_ = 'Vervangend';
    return {
      id: r.id,
      naam: r.naam,
      eigen: r.eigen,
      bronnen: bronnen.filter((b) => b.type !== 'ontbreekt').length,
      termen: actieveTermen(r).length,
      waarschuwing: let_,
    };
  });
}

function regioDetail(k, id) {
  const r = k.regioMap.get(id);
  if (!r) return null;
  const nieuw = nieuwPerBron(k);
  const grens7 = geleden(7);
  const lokaal = bronnenVanRegio(k.opslag, id);
  let stukken = Object.values(k.opslag.items).filter((i) => i.regio === id && !i.basislijn && i.eersteGezien > grens7).length;
  for (const item of Object.values(k.opslag.items)) {
    if (item.regio || item.basislijn || item.eersteGezien <= grens7) continue;
    const bron = k.bronnen.get(item.bron);
    if (bron?.bereik === 'landelijk' && routeerItem(k, item, bron).some((x) => x.regio === id)) stukken++;
  }
  if (k.adb) {
    for (const a of k.adb.metTranscriptSinds(grens7)) {
      const bron = k.bronnen.get(a.bron);
      if (!bron) continue;
      if (bron.bereik === 'regio' ? bron.regio === id : routeerAflevering(k, a).some((x) => x.regio === id)) stukken++;
    }
  }
  if (k.kdb && geldtVoor(r, TWEEDE_KAMER.id) && actieveTermen(r).length) {
    stukken += k.kdb.feedTreffers(actieveTermen(r), { sinds: grens7, minDatum: grens7.slice(0, 10), max: 1000 }).length;
  }
  const volgers = k.opslag.gebruikers.filter((g) => g.regios.includes(id));
  return {
    id: r.id,
    naam: r.naam,
    eigen: r.eigen,
    site: r.site,
    stukken7: stukken,
    lokaleBronnen: lokaal.map((b) => bronVoorClient(k, b, nieuw)),
    landelijk: landelijkeBronnen(k.opslag).map((b) => ({ id: b.id, naam: b.naam.replace(/ · Kamerstukken$/, ''), aan: geldtVoor(r, b.id) })),
    sleutelwoorden: (r.sleutelwoorden || []).map((s) => {
      const n = telTerm(k, s.term, r);
      return { term: s.term, actief: s.actief !== false, aantal: n, ruis: n >= RUIS };
    }),
    volgers: volgers.map((g) => ({ id: g.id, naam: g.naam || g.email, mail: weekmailTekst(g) })),
  };
}

// ---------- bronnen toevoegen ----------

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LEZERS_TOEVOEGEN = ['rss', 'ibabs', 'gpp-woo', 'audio'];

function bronNaam(regio, label, url, eigenNaam) {
  return regio ? `${regio.naam} · ${label}` : `${label}${eigenNaam ? '' : ` · ${host(url)}`}`;
}

// Een nieuwe bron uit het formulier; gooit bij ongeldige invoer.
async function maakBron(opslag, invoer) {
  const bereik = invoer.bereik === 'landelijk' ? 'landelijk' : 'regio';
  const regio = bereik === 'regio' ? alleRegios(opslag).find((r) => r.id === invoer.regio) : null;
  if (bereik === 'regio' && !regio) throw new InvoerFout('Kies de regio');
  const lezer = String(invoer.lezer || '');
  if (!LEZERS_TOEVOEGEN.includes(lezer)) throw new InvoerFout('Kies een type bron');
  const audio = lezer === 'audio';
  const soort = String(invoer.soort || '');
  if (audio ? !AUDIOSOORTEN.includes(soort) : !SOORTEN[soort]) throw new InvoerFout('Kies de soort stukken');
  let url;
  try {
    url = new URL(String(invoer.url || '').trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error();
  } catch {
    throw new InvoerFout('Vul een volledig adres in, beginnend met https://');
  }
  const bron = { soort, bereik, type: lezer, url: url.href };
  if (lezer === 'ibabs') {
    const overzicht = url.pathname.match(UUID)?.[0];
    if (!/\/Reports\/Details\//i.test(url.pathname) || !overzicht) {
      throw new InvoerFout('Gebruik de link van een iBabs-overzicht: https://<gemeente>.bestuurlijkeinformatie.nl/Reports/Details/<code>');
    }
    Object.assign(bron, { basis: url.origin, overzicht });
  }
  if (lezer === 'gpp-woo') Object.assign(bron, { basis: url.origin, url: url.origin });
  if (audio) {
    // Welk platform of welke YouTube-tab? Dit zoekt het adres ook na.
    let herkend;
    try {
      herkend = await herkenBron(url.href, soort, invoer.scope || 'auto');
    } catch (fout) {
      throw new InvoerFout(fout.message);
    }
    const eersteImport = Number(invoer.eersteImport ?? 3);
    bron.url = herkend.url;
    bron.audio = {
      kind: herkend.kind,
      // 0 = alles wat de bron nu aanbiedt (zoals in audioscraper, tot 5000).
      eersteImport: Number.isInteger(eersteImport) && eersteImport >= 0 && eersteImport <= 5000 ? eersteImport : 3,
      actief: true,
      geinitialiseerd: false,
    };
  }
  const label = String(invoer.naam || '').trim().slice(0, 120)
    || (audio ? (PLATFORMS[bron.audio.kind] ? `Raadsvergaderingen (${PLATFORMS[bron.audio.kind]})` : bron.audio.kind === 'video' ? 'YouTube-video' : ENKELVOUD[soort])
      : `${SOORTEN[soort]} (${LEZERS[lezer]})`);
  bron.label = label;
  bron.naam = bronNaam(regio, label, bron.url, invoer.naam);
  if (regio) bron.regio = regio.id;
  return bron;
}

const duurTekst = (s) => (s ? `${Math.floor(s / 3600) ? `${Math.floor(s / 3600)} u ` : ''}${Math.round((s % 3600) / 60)} min` : null);

// Proefronde: ophalen zonder op te slaan, en zeggen wat er zou gebeuren.
async function proef(k, invoer) {
  let bron;
  try {
    bron = await maakBron(k.opslag, invoer);
  } catch (fout) {
    if (fout instanceof InvoerFout && invoer.lezer === 'audio') return { tekst: fout.message, fout: true };
    throw fout;
  }
  if (bron.type === 'audio') {
    const w = audioWorker(k.opslag.instellingen);
    let catalogus;
    try {
      catalogus = await ontdekCatalogus({ ...bron, naam: bron.naam }, { map: k.opslag.map, proef: true });
    } catch (fout) {
      return { tekst: `De catalogus kon niet worden gelezen: ${fout.message}`, fout: true };
    }
    const n = catalogus.items.length;
    const nieuwste = catalogus.items[0];
    // Bij een deels gelezen catalogus (iBabs: een pagina per vergadering) alleen de eerste treffers.
    const aantal = `${catalogus.deels ? 'de eerste ' : ''}${n} ${n === 1 ? 'aflevering' : 'afleveringen'}`;
    const regels = [`${PLATFORMS[bron.audio.kind] ? `${PLATFORMS[bron.audio.kind]}-archief` : 'De bron'}${catalogus.titel ? ` "${catalogus.titel}"` : ''}: ${aantal} gevonden.`];
    if (nieuwste) regels.push(`De nieuwste: "${nieuwste.titel}"${nieuwste.gepubliceerdOp ? ` (${new Date(nieuwste.gepubliceerdOp * 1000).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' })})` : ''}${nieuwste.duur ? `, ${duurTekst(nieuwste.duur)}` : ''}.`);
    const eerste = catalogus.deels ? bron.audio.eersteImport || 'alle' : bron.audio.eersteImport ? Math.min(bron.audio.eersteImport, n) : n;
    regels.push(bron.audio.kind === 'video' ? 'Bij het opslaan wordt de video gedownload en getranscribeerd.'
      : `Bij het opslaan ${eerste === 1 ? 'wordt de nieuwste aflevering' : eerste === 'alle' ? 'worden alle afleveringen' : `worden de ${eerste} nieuwste afleveringen`} gedownload en getranscribeerd, met stemherkenning en namen; daarna komt elke nieuwe aflevering vanzelf binnen.`);
    if (bron.bereik === 'landelijk') regels.push('Het transcript wordt doorzocht op de sleutelwoorden van alle regio\'s; bij een treffer gaat de aflevering naar die regio, met de tijd waarop het woord valt.');
    if (!w) regels.push('Let op: de Whisper-worker is nog niet ingesteld (Instellingen › Audio en video); tot dan blijft alles in de wachtrij staan.');
    else if (!w.heeftToken) regels.push('Let op: het token van de Whisper-worker ontbreekt (Instellingen › Audio en video).');
    return {
      tekst: regels.join(' '),
      voorbeelden: catalogus.items.slice(0, 5).map((i) => ({ titel: i.titel, datum: i.gepubliceerdOp ? new Date(i.gepubliceerdOp * 1000).toISOString().slice(0, 10) : null, url: i.url })),
    };
  }
  let gevonden;
  try {
    gevonden = await haalBron(bron);
  } catch (fout) {
    return { tekst: `Ophalen mislukt: ${fout.message}`, fout: true };
  }
  const regels = [`Er ${gevonden.length === 1 ? 'is 1 stuk' : `zijn ${gevonden.length} stukken`} gevonden.`];
  if (!gevonden.length) regels.push('Klopt het adres en het type bron?');
  if (bron.bereik === 'landelijk' && gevonden.length) {
    const perRegio = [];
    for (const r of k.regios) {
      const termen = actieveTermen(r);
      if (!termen.length) continue;
      const n = gevonden.filter((g) => vindTermen(`${g.titel}\n${g.tekst || ''}`, termen).length).length;
      if (n) perRegio.push(`${n} naar ${r.naam}`);
    }
    regels.push(perRegio.length
      ? `Met de huidige sleutelwoorden gaan er ${perRegio.join(', ').replace(/, ([^,]*)$/, ' en $1')} (op titel en samenvatting; na het ophalen van de volledige tekst kunnen het er meer zijn).`
      : 'Met de huidige sleutelwoorden gaat er (op titel en samenvatting) nog niets naar een regio.');
  }
  return {
    tekst: regels.join(' '),
    nulmeting: 'Bij de eerste ronde wordt een nulmeting gedaan: wat er al staat, telt niet als nieuw.',
    voorbeelden: gevonden.slice(0, 5).map((g) => ({ titel: g.titel, datum: g.datum || null, url: g.url })),
  };
}

async function slaBronOp(k, invoer, verwerking) {
  const bron = await maakBron(k.opslag, invoer);
  const bestaand = new Set(alleBronnen(k.opslag).map((b) => b.id));
  if (alleBronnen(k.opslag).some((b) => b.url === bron.url && b.bereik === bron.bereik && b.regio === bron.regio)) {
    throw new InvoerFout('Deze bron staat er al in');
  }
  bron.id = maakId(`${bron.regio || 'landelijk'}-${bron.label}`, bestaand);
  bron.aangemaakt = new Date().toISOString();
  if (bron.audio) {
    // Een nieuwe audiobron komt vooraan in de wachtrij: daar wacht je op.
    const prioriteiten = k.opslag.bronnen.filter(isAudio).map((b) => b.audio.prioriteit ?? 0);
    bron.audio.prioriteit = prioriteiten.length ? Math.min(...prioriteiten) - 1 : 0;
  }
  k.opslag.bronnen.push(bron);
  k.opslag.bewaar('bronnen');
  // De eerste controle op de achtergrond: een groot YouTube-kanaal duurt even.
  if (bron.audio && verwerking) verwerking.synchroniseer(bron).catch(() => {});
  return bron;
}

async function verwijderBron(k, id) {
  const bron = k.opslag.bronnen.find((b) => b.id === id);
  if (!bron) throw new InvoerFout('Alleen zelf toegevoegde bronnen kunnen weg; de ingebouwde staan in de code (src/regios.mjs)');
  k.opslag.bronnen = k.opslag.bronnen.filter((b) => b.id !== id);
  for (const [sleutel, item] of Object.entries(k.opslag.items)) if (item.bron === id) delete k.opslag.items[sleutel];
  delete k.opslag.status.bronnen[id];
  for (const r of Object.values(k.opslag.regios)) if (r.landelijkUit) r.landelijkUit = r.landelijkUit.filter((x) => x !== id);
  if (isAudio(bron) && k.adb) {
    for (const af of k.adb.verwijderBron(id)) await gooiAudioWeg(k.opslag.map, af.audio_pad);
  }
  k.opslag.bewaar('bronnen', 'items', 'status', 'regios');
}

// Naam, bereik en regio aanpassen; bij audio ook pauzeren (geen nieuwe afleveringen meer zoeken).
function werkBronBij(k, id, invoer) {
  const bron = k.opslag.bronnen.find((b) => b.id === id);
  if (!bron) throw new InvoerFout('Alleen zelf toegevoegde bronnen kunnen worden aangepast');
  if (invoer.bereik !== undefined) {
    const bereik = invoer.bereik === 'landelijk' ? 'landelijk' : 'regio';
    const regio = bereik === 'regio' ? k.regioMap.get(invoer.regio ?? bron.regio) : null;
    if (bereik === 'regio' && !regio) throw new InvoerFout('Kies de regio');
    bron.bereik = bereik;
    if (regio) bron.regio = regio.id; else delete bron.regio;
    // Wat de bron al opleverde, verhuist mee: een stuk bewaart zijn regio zelf.
    // Landelijk: geen vaste regio meer, dan routeren de sleutelwoorden.
    let verhuisd = 0;
    for (const item of Object.values(k.opslag.items)) {
      if (item.bron !== bron.id) continue;
      const nieuw = regio ? regio.id : null;
      if (item.regio !== nieuw) {
        item.regio = nieuw;
        verhuisd++;
      }
    }
    if (verhuisd) k.opslag.bewaar('items');
  }
  if (invoer.label !== undefined) {
    const label = String(invoer.label).trim().slice(0, 120);
    if (!label) throw new InvoerFout('Vul een naam in');
    bron.label = label;
  }
  bron.naam = bronNaam(bron.regio ? k.regioMap.get(bron.regio) : null, bron.label, bron.url, true);
  if (isAudio(bron) && invoer.actief !== undefined) bron.audio.actief = Boolean(invoer.actief);
  k.opslag.bewaar('bronnen');
  return bron;
}

// ---------- regio's ----------

function werkRegioBij(k, id, invoer) {
  const r = k.regioMap.get(id);
  if (!r) throw new InvoerFout('Onbekende regio');
  const extra = k.opslag.regios[id] || {};
  if (invoer.naam !== undefined) {
    if (!r.eigen) throw new InvoerFout('De naam van een ingebouwde regio staat in de code');
    const naam = String(invoer.naam).trim().slice(0, 80);
    if (!naam) throw new InvoerFout('Vul een naam in');
    extra.naam = naam;
  }
  if (invoer.sleutelwoorden !== undefined) {
    const lijst = Array.isArray(invoer.sleutelwoorden) ? invoer.sleutelwoorden : [];
    const termen = schoneTermen(lijst.map((s) => (typeof s === 'string' ? s : s.term)));
    const actief = new Map(lijst.filter((s) => typeof s === 'object').map((s) => [schoneTermen([s.term])[0], s.actief !== false]));
    extra.sleutelwoorden = termen.map((term) => ({ term, actief: actief.get(term) ?? true }));
  }
  if (invoer.landelijkUit !== undefined) {
    const landelijk = new Set(landelijkeBronnen(k.opslag).map((b) => b.id));
    extra.landelijkUit = (invoer.landelijkUit || []).filter((b) => landelijk.has(b));
  }
  k.opslag.regios[id] = extra;
  k.opslag.bewaar('regios');
}

// ---------- de routes ----------

// De wachtrij voor de beheerpagina: wat er nu gebeurt, wat er komt, wat mislukte.
async function audioOverzicht(k, verwerking) {
  const adb = k.adb;
  const w = audioWorker(k.opslag.instellingen);
  let worker = { ingesteld: Boolean(w), token: Boolean(w?.heeftToken), viaTailnet: Boolean(w?.tailnet) };
  if (w) {
    try {
      const g = await w.gezond();
      worker = { ...worker, bereikbaar: true, model: g.model || null, gpu: g.device || null, bezig: Boolean(g.inference_phase), stemmen: Boolean(g.diarization_available) };
    } catch (fout) {
      worker = { ...worker, bereikbaar: false, fout: fout.message };
    }
  }
  const namen = new Map(alleBronnen(k.opslag).map((b) => [b.id, b.naam]));
  const regel = (a) => ({ id: a.id, titel: a.titel, bron: a.bron, bronNaam: namen.get(a.bron) || a.bron, status: a.status, stap: a.stap, fout: a.fout, pogingen: a.pogingen, opnieuwOp: a.opnieuwOp, gepubliceerd: a.gepubliceerd, duur: a.duur });
  const volgende = verwerking ? verwerking.volgende(Date.now() / 1000 + 365 * 86400) : [];
  const volgendeIds = volgende.slice(0, 25).map((r) => r.id);
  const perId = new Map(adb.lijst({ ids: volgendeIds, limiet: 25 }).map((a) => [a.id, a]));
  return {
    gepauzeerd: adb.gepauzeerd(),
    worker,
    bezig: adb.bezig().map(regel),
    wachtrij: volgendeIds.map((id) => perId.get(id)).filter(Boolean).map(regel),
    inWachtrij: volgende.length,
    mislukt: adb.lijst({ status: ['mislukt'], limiet: 50 }).map(regel),
    bronnen: (verwerking ? verwerking.bronVolgorde() : []).map((b) => bronVoorClient(k, b, {})),
  };
}

export async function beheerApi(req, url, { opslag, kdb, fdb, adb, verwerking, stuur, leesJson, Fout }) {
  const deel = url.pathname.split('/').filter(Boolean); // ['api', 'beheer', ...]
  const route = `${req.method} /${deel.slice(2).join('/')}`;
  const k = maakKader({ opslag, kdb, fdb, adb });
  k.audioTellingen = k.adb ? k.adb.tellingen() : {};

  if (route === 'GET /status') {
    const bronnen = alleBronnen(opslag);
    const fouten = bronnen.filter((b) => bronStatus(opslag, b).staat === 'fout');
    return stuur({
      fouten: fouten.map((b) => b.naam),
      laatsteVerzamelronde: opslag.status.laatsteVerzamelronde,
      intervalMinuten: Number(opslag.instellingen.controleIntervalMinuten) || 60,
      smtp: Boolean(opslag.instellingen.smtp.host),
    });
  }

  if (route === 'GET /regios') return stuur(regioOverzicht(k));
  if (route === 'POST /regios') {
    const { naam } = await leesJson(req);
    const schoon = String(naam || '').trim().slice(0, 80);
    if (!schoon) throw new Fout(400, 'Vul een naam in');
    if (k.regios.some((r) => r.naam.toLowerCase() === schoon.toLowerCase())) throw new Fout(400, `${schoon} bestaat al`);
    const id = maakId(schoon, new Set(k.regios.map((r) => r.id)));
    opslag.regios[id] = { naam: schoon, eigen: true, sleutelwoorden: [], landelijkUit: [] };
    opslag.bewaar('regios');
    return stuur({ id }, 201);
  }
  if (deel[2] === 'regios' && deel[3]) {
    const id = deel[3];
    if (req.method === 'GET') {
      const d = regioDetail(k, id);
      if (!d) throw new Fout(404, 'Regio niet gevonden');
      return stuur(d);
    }
    if (req.method === 'PUT') {
      werkRegioBij(k, id, await leesJson(req));
      return stuur(regioDetail(maakKader({ opslag, kdb, fdb, adb }), id));
    }
    if (req.method === 'DELETE') {
      const r = k.regioMap.get(id);
      if (!r?.eigen) throw new Fout(400, 'Alleen zelf toegevoegde regio\'s kunnen weg');
      if (bronnenVanRegio(opslag, id).length) throw new Fout(400, 'Verwijder eerst de bronnen van deze regio');
      delete opslag.regios[id];
      for (const g of opslag.gebruikers) g.regios = g.regios.filter((x) => x !== id);
      opslag.bewaar('regios', 'gebruikers');
      return stuur({ ok: true });
    }
  }
  // Live voorbeeld bij het intypen van een sleutelwoord.
  if (route === 'GET /termproef') {
    const term = schoneTermen([url.searchParams.get('term') || ''])[0];
    if (!term) return stuur({ term: null, aantal: 0 });
    const regio = k.regioMap.get(url.searchParams.get('regio')) || null;
    return stuur({ term, aantal: telTerm(k, term, regio) });
  }

  if (route === 'GET /bronnen') {
    const nieuw = nieuwPerBron(k);
    const w = audioWorker(opslag.instellingen);
    return stuur({
      bronnen: alleBronnen(opslag).map((b) => bronVoorClient(k, b, nieuw)),
      worker: { ingesteld: Boolean(w), token: Boolean(w?.heeftToken) },
    });
  }
  if (route === 'POST /bronnen/proef') return stuur(await proef(k, await leesJson(req)));
  if (route === 'POST /bronnen') {
    const bron = await slaBronOp(k, await leesJson(req), verwerking);
    return stuur(bronVoorClient(k, bron, {}), 201);
  }
  if (deel[2] === 'bronnen' && deel[3]) {
    if (req.method === 'DELETE' && deel.length === 4) {
      await verwijderBron(k, deel[3]);
      return stuur({ ok: true });
    }
    if (req.method === 'PUT' && deel.length === 4) {
      return stuur(bronVoorClient(k, werkBronBij(k, deel[3], await leesJson(req)), nieuwPerBron(k)));
    }
    // Eén audiobron nu controleren op nieuwe afleveringen.
    if (req.method === 'POST' && deel[4] === 'controleer') {
      const bron = opslag.bronnen.find((b) => b.id === deel[3] && isAudio(b));
      if (!bron || !verwerking) throw new Fout(404, 'Audiobron niet gevonden');
      return stuur(await verwerking.synchroniseer(bron));
    }
  }

  // ---------- audio en video: de verwerking ----------
  if (route === 'GET /audio') {
    if (!k.adb) throw new Fout(503, 'De database voor audio is niet beschikbaar');
    return stuur(await audioOverzicht(k, verwerking));
  }
  if (route === 'PUT /audio') {
    const { gepauzeerd } = await leesJson(req);
    k.adb.zetStaat('gepauzeerd', gepauzeerd ? '1' : '0');
    verwerking?.wek();
    return stuur(await audioOverzicht(k, verwerking));
  }
  if (route === 'PUT /audio/volgorde') {
    const { ids } = await leesJson(req);
    if (!Array.isArray(ids)) throw new Fout(400, 'Geef de volgorde als lijst');
    verwerking.zetVolgorde(ids.map(String));
    return stuur(await audioOverzicht(k, verwerking));
  }
  if (route === 'POST /audio/opnieuw') {
    const { id } = await leesJson(req);
    if (!verwerking?.opnieuw(String(id || ''))) throw new Fout(404, 'Aflevering niet gevonden');
    return stuur(await audioOverzicht(k, verwerking));
  }

  const regioIds = k.regios.map((r) => r.id);

  // ---------- Teams-kanalen (src/kanalen.mjs) ----------
  const bronIds = () => alleBronnen(opslag).map((b) => b.id);
  if (route === 'GET /kanalen') {
    return stuur({ kanalen: opslag.kanalen.map(kanaalVoorClient), keuzes: kanaalKeuzes(k), siteUrl: Boolean(process.env.REGIOCHECKER_SITE_URL) });
  }
  if (route === 'POST /kanalen') {
    const kanaal = nieuwKanaal(controleerKanaal(await leesJson(req), null, { regioIds, bronIds: bronIds() }));
    opslag.kanalen.push(kanaal);
    opslag.bewaar('kanalen');
    return stuur(kanaalVoorClient(kanaal), 201);
  }
  if (deel[2] === 'kanalen' && deel[3]) {
    const kanaal = opslag.kanalen.find((c) => c.id === deel[3]);
    if (!kanaal) throw new Fout(404, 'Kanaal niet gevonden');
    if (req.method === 'PUT' && deel.length === 4) {
      const was = kanaal.actief !== false;
      Object.assign(kanaal, controleerKanaal(await leesJson(req), kanaal, { regioIds, bronIds: bronIds() }));
      // Weer aan na een tijd uit: vanaf nu, niet alles wat intussen binnenkwam.
      if (!was && kanaal.actief) {
        Object.assign(kanaal, { laatsteVerzending: new Date(Math.max(Date.now(), Date.parse(kanaal.laatsteVerzending || 0))).toISOString(), verzonden: [] });
      }
      opslag.bewaar('kanalen');
      return stuur(kanaalVoorClient(kanaal));
    }
    if (req.method === 'DELETE' && deel.length === 4) {
      opslag.kanalen = opslag.kanalen.filter((c) => c.id !== kanaal.id);
      opslag.bewaar('kanalen');
      return stuur({ ok: true });
    }
    if (req.method === 'POST' && deel[4] === 'test') {
      try {
        await stuurNaarTeams(kanaal.url, testKaart(kanaal, kanaalKeuzes(k)));
      } catch (fout) {
        throw new Fout(502, fout.message);
      }
      kanaal.laatsteFout = null;
      opslag.bewaar('kanalen');
      return stuur({ ok: true });
    }
  }

  if (route === 'GET /gebruikers') {
    const nu = new Date();
    return stuur(opslag.gebruikers.map((g) => ({ ...voorClient(g), volgendeWeekmail: volgendeWeekmail(nu, g)?.toISOString() || null })));
  }
  if (route === 'POST /gebruikers') {
    const invoer = await leesJson(req);
    const g = nieuweGebruiker(opslag.instellingen, { weekmail: { aan: false } });
    werkGebruikerBij(opslag, g, { ...invoer, weekmail: invoer.weekmail || { aan: false } }, { beheer: true, regioIds });
    opslag.gebruikers.push(g);
    opslag.bewaar('gebruikers');
    return stuur(voorClient(g), 201);
  }
  if (deel[2] === 'gebruikers' && deel[3]) {
    const g = opslag.gebruikers.find((x) => x.id === deel[3]);
    if (!g) throw new Fout(404, 'Gebruiker niet gevonden');
    if (req.method === 'PUT') {
      werkGebruikerBij(opslag, g, await leesJson(req), { beheer: true, regioIds });
      opslag.bewaar('gebruikers');
      return stuur(voorClient(g));
    }
    if (req.method === 'DELETE') {
      if (g.rol === 'admin' && !opslag.gebruikers.some((x) => x.id !== g.id && x.rol === 'admin' && x.login)) {
        throw new Fout(400, 'Er moet minstens één beheerder overblijven');
      }
      opslag.gebruikers = opslag.gebruikers.filter((x) => x.id !== g.id);
      opslag.meldingen = opslag.meldingen.filter((m) => m.gebruiker !== g.id);
      fdb?.vergeetGebruiker(g.id);
      opslag.bewaar('gebruikers', 'meldingen');
      return stuur({ ok: true });
    }
  }
  throw new Fout(404, 'Onbekende route');
}

