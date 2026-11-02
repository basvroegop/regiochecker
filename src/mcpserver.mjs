// MCP-server: een AI-app (Claude, …) zoekt en leest in de Regiochecker,
// namens een gebruiker. (De MCP-client voor gehoord.de staat in src/mcp.mjs.) Streamable HTTP zonder sessies: elk verzoek is een POST
// met een JSON-RPC-bericht en krijgt één JSON-antwoord (geen SSE). Inloggen
// gaat met OAuth (src/oauth.mjs); het token hoort bij één gebruiker.
//
// Alleen lezen, met dezelfde selectie als de webUI (src/feed.mjs). Ingezonden
// tips (Telegram) blijven erbuiten: daarin staan de gegevens van de inzender,
// en die horen niet bij een taalmodel.

import { maakKader, zoekFeed, kanaalRegels, detail, tekstVan } from './feed.mjs';
import { GROEPEN } from './regios.mjs';
import { maakZoeker, normaliseer, patroon } from './termen.mjs';
import { stukUrl, MARK_BEGIN, MARK_EIND } from './kamer/db.mjs';
import { stukTitel } from './kamer/weergave.mjs';
import { documentOpVraag } from './inhoud.mjs';
import { platVan } from './document.mjs';
import { basisUrl, CORS, leesLijf } from './oauth.mjs';

const VERSIES = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const VERBORGEN = new Set(['ingezonden']);
const MAX_LIJF = 1_000_000;
const DAG_MS = 86400000;

class RpcFout extends Error {
  constructor(code, bericht) { super(bericht); this.code = code; }
}
// Een fout die de AI moet lezen (verkeerde regio, onbekend stuk): geen
// protocolfout, maar een antwoord met isError.
class ToolFout extends Error {}

const INSTRUCTIES = `De Regiochecker volgt voor regionale journalisten van de Leeuwarder Courant en het Dagblad van het Noorden 40 gemeenten in Fryslân, Groningen en Drenthe: nieuws, ingekomen stukken, Woo-besluiten en bekendmakingen van gemeenten (met een archief dat jaren teruggaat), Kamerstukken van de Tweede Kamer (vanaf 2008), landelijke signalen (KNMI, Raad van State, ransomware, verkeer) en automatische transcripten van raadsvergaderingen, Kamerdebatten, YouTube-video's en podcasts.

- zoeken: door alles tegelijk, nieuwste eerst; filter op regio, soort en datum.
- kamerstukken_zoeken: alleen Kamerstukken, op relevantie, met FTS5-syntax en het totale aantal.
- nieuwste: wat er de afgelopen dagen binnenkwam voor een of meer regio's, zonder zoekwoord.
- stuk_lezen: de hele tekst van een stuk (of transcript) met het id uit de resultaten; lange stukken in delen, of alleen de passages rond een zoekwoord.
- regios_en_soorten: de regio-ids, soorten en archieven.

Noem bij elk feit het stuk en de link. Transcripten zijn automatisch gemaakt en kunnen fouten bevatten (vooral namen): geef bij een citaat de tijd, zodat de journalist het in de opname kan nakijken.`;

// ---------- hulpjes ----------

const tijdcode = (s) => {
  const t = Math.max(0, Math.floor(Number(s) || 0));
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const getal = (waarde, { standaard, min, max }) => {
  const n = Math.floor(Number(waarde));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : standaard;
};
const DATUM = /^\d{4}-\d{2}-\d{2}$/;
function datum(waarde, veld) {
  if (waarde === undefined || waarde === null || waarde === '') return null;
  if (!DATUM.test(String(waarde))) throw new ToolFout(`${veld}: een datum als JJJJ-MM-DD`);
  return String(waarde);
}
const lijstVan = (waarde) => (waarde === undefined || waarde === null || waarde === '' ? [] : Array.isArray(waarde) ? waarde : String(waarde).split(','));

// Regio's op id of naam; "mijn" zijn de regio's die de gebruiker volgt.
function regiosUit(k, gebruiker, waarde) {
  const uit = new Set();
  const onbekend = [];
  for (const x of lijstVan(waarde)) {
    const s = normaliseer(String(x).trim());
    if (!s) continue;
    if (s === 'mijn') {
      for (const id of gebruiker.regios || []) if (k.regioMap.has(id)) uit.add(id);
      continue;
    }
    const r = k.regios.find((r) => r.id === String(x).trim() || normaliseer(r.naam) === s);
    if (r) uit.add(r.id);
    else onbekend.push(x);
  }
  if (onbekend.length) throw new ToolFout(`Onbekende regio: ${onbekend.join(', ')}. Kies uit: ${k.regios.map((r) => r.naam).join(', ')} (of "mijn").`);
  return [...uit];
}

const zichtbaar = () => Object.entries(GROEPEN).filter(([id]) => !VERBORGEN.has(id));

// Soorten (de tabbladen van de feed) op id of naam; leeg: alle behalve de verborgen.
function soortenUit(waarde) {
  const uit = new Set();
  const onbekend = [];
  for (const x of lijstVan(waarde)) {
    const s = normaliseer(String(x).trim());
    if (!s) continue;
    const g = zichtbaar().find(([id, naam]) => id === s || normaliseer(naam) === s);
    if (g) uit.add(g[0]);
    else onbekend.push(x);
  }
  if (onbekend.length) throw new ToolFout(`Onbekende soort: ${onbekend.join(', ')}. Kies uit: ${zichtbaar().map(([id]) => id).join(', ')}.`);
  return uit.size ? [...uit] : zichtbaar().map(([id]) => id);
}

const regioNamen = (k, ids) => (ids?.length ? ids.map((id) => k.regioMap.get(id)?.naam || id).join(', ') : 'landelijk');
// In een kop: veertig namen zijn geen kop meer.
const regioKop = (k, ids) => (ids.length > 6 ? `${ids.length} regio's` : regioNamen(k, ids));

// Link, bron en (bij zoeken) een fragment rond de treffer, voor één resultaat.
function kenmerken(k, regel, zoeker) {
  const soort = regel.id.slice(0, 2);
  const rest = regel.id.slice(2);
  if (soort === 'i:') {
    const item = k.opslag.items[rest] || k.opslag.archief?.item(rest);
    if (!item) return {};
    const doc = item.archief ? platVan(k.opslag.archief.documentVan(rest)?.blokken) : '';
    return {
      url: item.url,
      bron: k.bronnen.get(item.bron)?.naam || item.bron,
      fragment: zoeker?.(`${tekstVan(k, item)}\n${doc}`)?.fragment.tekst,
    };
  }
  if (soort === 'k:') {
    const stuk = k.kdb?.stuk(rest);
    if (!stuk) return {};
    return {
      url: stukUrl(stuk),
      bron: `Tweede Kamer · ${stuk.soort}${stuk.nummer ? ` ${stuk.nummer}` : ''}`,
      fragment: zoeker?.(`${stuk.titel || ''}\n${stuk.onderwerp || ''}\n${k.kdb.tekstVan(stuk)}`)?.fragment.tekst,
    };
  }
  const a = k.adb?.aflevering(rest);
  if (!a) return {};
  const seg = zoeker && a.segmenten.find((s) => zoeker(s.text));
  return {
    url: a.url,
    bron: k.bronnen.get(a.bron)?.naam || a.bron,
    fragment: seg ? `[${tijdcode(seg.start)}] ${zoeker(seg.text).fragment.tekst}` : undefined,
  };
}

function regelTekst(k, regel, n, zoeker) {
  const x = kenmerken(k, regel, zoeker);
  const datumStuk = regel.datum || (regel.tijd ? regel.tijd.slice(0, 10) : 'zonder datum');
  const delen = [
    `${n}. ${regel.titel || '(zonder titel)'}`,
    `   id: ${regel.id} · ${datumStuk} · ${regel.soortNaam || regel.soort} · ${regioNamen(k, regel.regios)}${x.bron ? ` · ${x.bron}` : ''}`,
  ];
  if (regel.match?.term && regel.match.regio && !zoeker) delen.push(`   via sleutelwoord "${regel.match.term}"`);
  if (x.url) delen.push(`   link: ${x.url}`);
  if (x.fragment) delen.push(`   «${x.fragment.replace(/\s+/g, ' ').trim()}»`);
  return delen.join('\n');
}

function pagineer(lijst, args) {
  const aantal = getal(args.aantal, { standaard: 20, min: 1, max: 50 });
  const pagina = getal(args.pagina, { standaard: 1, min: 1, max: 1000 });
  const begin = (pagina - 1) * aantal;
  return { deel: lijst.slice(begin, begin + aantal), begin, aantal, pagina, meer: lijst.length > begin + aantal };
}

// ---------- tools ----------

function zoeken(args, c) {
  const vraag = String(args.vraag || '').trim().slice(0, 300);
  if (!vraag) throw new ToolFout('Geef een zoekvraag (vraag).');
  const regios = regiosUit(c.k, c.gebruiker, args.regios);
  const groepen = soortenUit(args.soorten);
  const van = datum(args.van, 'van');
  const tot = datum(args.tot, 'tot');
  const r = zoekFeed(c.k, c.gebruiker, vraag, { regios, groepen, van, tot });
  const lijst = r.items.filter((i) => !VERBORGEN.has(i.groep));
  const zoeker = maakZoeker(vraag);
  const p = pagineer(lijst, args);
  const filters = [regios.length ? `regio's: ${regioKop(c.k, regios)}` : 'alle regio\'s', args.soorten ? `soorten: ${groepen.join(', ')}` : null, van && `vanaf ${van}`, tot && `tot en met ${tot}`].filter(Boolean).join('; ');
  if (!lijst.length) return `Niets gevonden voor ${vraag} (${filters}). Probeer minder of andere woorden, of kamerstukken_zoeken voor Kamerstukken.`;
  const kop = `${r.totaal > r.items.length ? `Meer dan ${lijst.length}` : lijst.length} resultaten voor ${vraag} (${filters}), nieuwste eerst. Resultaten ${p.begin + 1}–${p.begin + p.deel.length}:`;
  const voet = [
    p.meer ? `Meer: pagina=${p.pagina + 1}.` : null,
    r.totaal > r.items.length ? 'Alleen de nieuwste 500 zijn op te vragen: verfijn de zoekvraag of filter op datum.' : null,
    'Lees een stuk met stuk_lezen en het id.',
  ].filter(Boolean).join(' ');
  return [kop, '', ...p.deel.map((regel, i) => regelTekst(c.k, regel, p.begin + i + 1, zoeker)), '', voet].join('\n');
}

function kamerstukkenZoeken(args, c) {
  if (!c.k.kdb) throw new ToolFout('De Kamerstukken zijn nu niet beschikbaar.');
  const vraag = String(args.vraag || '').trim().slice(0, 500);
  const aantal = getal(args.aantal, { standaard: 20, min: 1, max: 50 });
  const pagina = getal(args.pagina, { standaard: 1, min: 1, max: 500 });
  const r = c.k.kdb.zoek({
    vraag,
    soort: args.soort ? String(args.soort) : undefined,
    van: datum(args.van, 'van') || undefined,
    tot: datum(args.tot, 'tot') || undefined,
    sorteer: args.sorteer === 'datum' ? 'datum' : 'relevantie',
    pagina,
    perPagina: aantal,
  });
  if (!r.totaal) return `Geen Kamerstukken gevonden voor ${vraag || '(alles)'}${args.soort ? ` (soort ${args.soort})` : ''}.`;
  const begin = (pagina - 1) * aantal;
  const regels = r.rijen.map((s, i) => [
    `${begin + i + 1}. ${stukTitel(s)}`,
    `   id: k:${s.id} · ${s.datum || 'zonder datum'} · ${s.soort}${s.nummer ? ` ${s.nummer}` : ''}${s.dossier ? ` · dossier ${s.dossier}` : ''}${s.afzender ? ` · ${s.afzender}` : ''}`,
    `   link: ${stukUrl(s)}`,
    s.fragment ? `   «${s.fragment.replaceAll(MARK_BEGIN, '**').replaceAll(MARK_EIND, '**').replace(/\s+/g, ' ').trim()}»` : null,
  ].filter(Boolean).join('\n'));
  return [
    `${r.totaal} Kamerstukken${vraag ? ` voor ${r.vraag}` : ''}${r.aangepast ? ' (de zoekvraag is vereenvoudigd tot losse woorden)' : ''}, ${args.sorteer === 'datum' ? 'nieuwste' : 'meest relevante'} eerst. Resultaten ${begin + 1}–${begin + r.rijen.length}:`,
    '',
    ...regels,
    '',
    `${r.totaal > begin + r.rijen.length ? `Meer: pagina=${pagina + 1}. ` : ''}Lees een stuk met stuk_lezen en het id.`,
  ].join('\n');
}

function nieuwste(args, c) {
  const regios = regiosUit(c.k, c.gebruiker, args.regios);
  const groepen = soortenUit(args.soorten);
  const dagen = getal(args.dagen, { standaard: 7, min: 1, max: 30 });
  const nu = Date.now();
  const lijst = kanaalRegels(c.k, { regios, soorten: groepen }, { sinds: new Date(nu - dagen * DAG_MS).toISOString(), tot: new Date(nu).toISOString() })
    .filter((r) => !VERBORGEN.has(r.groep))
    .reverse();
  const waar = regios.length ? regioKop(c.k, regios) : 'alle regio\'s';
  if (!lijst.length) return `Niets nieuws in de afgelopen ${dagen} dagen voor ${waar}.`;
  const p = pagineer(lijst, args);
  return [
    `${lijst.length} stukken binnengekomen in de afgelopen ${dagen} dagen voor ${waar}, nieuwste eerst (op het moment dat de Regiochecker ze zag). Resultaten ${p.begin + 1}–${p.begin + p.deel.length}:`,
    '',
    ...p.deel.map((regel, i) => regelTekst(c.k, regel, p.begin + i + 1, null)),
    '',
    `${p.meer ? `Meer: pagina=${p.pagina + 1}. ` : ''}Lees een stuk met stuk_lezen en het id.`,
  ].join('\n');
}

// Blokken (src/document.mjs) als platte tekst met koppen.
function blokkenTekst(blokken) {
  return (blokken || []).map(([soort, t]) => (soort === 'k' ? `\n## ${t}\n` : soort === 'l' ? `- ${t}` : soort === 'd' ? `\n=== ${t || 'Bijlage'} ===\n` : `${t}\n`)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Een transcript: per beurt de tijd en de spreker; opeenvolgende stukjes van
// dezelfde spreker samen.
function transcriptTekst(d) {
  const delen = [];
  if (d.samenvatting?.tekst) delen.push(`Samenvatting (AI): ${d.samenvatting.tekst}`);
  if (d.agenda?.length) delen.push(`Agenda:\n${d.agenda.map((p) => `- [${tijdcode(p.start)}] ${p.titel}`).join('\n')}`);
  const beurten = [];
  for (const s of d.segmenten || []) {
    const spreker = s.spreker || '';
    const vorige = beurten.at(-1);
    if (vorige && vorige.spreker === spreker) vorige.tekst.push(s.tekst);
    else beurten.push({ start: s.start, spreker, tekst: [s.tekst] });
  }
  if (beurten.length) {
    delen.push(`Transcript (automatisch; kan fouten bevatten, vooral in namen):\n${beurten.map((b) => `[${tijdcode(b.start)}]${b.spreker ? ` ${b.spreker}:` : ''} ${b.tekst.join(' ').replace(/\s+/g, ' ').trim()}`).join('\n')}`);
  } else {
    delen.push(`Nog geen transcript (status: ${d.verwerking?.status || 'onbekend'}).`);
  }
  return delen.join('\n\n');
}

const metTijdslimiet = (belofte, ms) => Promise.race([belofte, new Promise((_, nee) => setTimeout(() => nee(new Error('duurde te lang')), ms).unref())]);

// Passages rond een zoekwoord: per treffer een stuk tekst, met de positie
// om daar verder te lezen.
function passages(tekst, zoek, breedte = 700, max = 12) {
  const termen = [...String(zoek).matchAll(/"([^"]+)"|(\S+)/g)].map((m) => m[1] || m[2]);
  const norm = normaliseer(tekst);
  const posities = [];
  for (const term of termen) {
    const re = patroon(term);
    if (!re) continue;
    for (const m of norm.matchAll(re)) posities.push(m.index);
  }
  posities.sort((a, b) => a - b);
  const vakken = [];
  for (const p of posities) {
    const begin = Math.max(0, p - breedte / 2);
    const eind = Math.min(tekst.length, p + breedte / 2);
    const vorige = vakken.at(-1);
    if (vorige && begin <= vorige.eind) vorige.eind = Math.max(vorige.eind, eind);
    else vakken.push({ begin, eind });
  }
  return { totaal: posities.length, vakken: vakken.slice(0, max) };
}

async function leesStuk(args, c) {
  const id = String(args.id || '').trim();
  if (!/^[ika]:./.test(id)) throw new ToolFout('Geef een id zoals in de zoekresultaten: i:…, k:… of a:….');
  let d = detail(c.k, c.gebruiker, id);
  if (!d) throw new ToolFout('Dit stuk bestaat niet (meer).');
  if (VERBORGEN.has(d.groep)) throw new ToolFout('Ingezonden tips zijn niet beschikbaar via deze koppeling.');
  let opmerking = null;
  let tekst;
  if (id.startsWith('a:')) {
    tekst = transcriptTekst(d);
  } else if (id.startsWith('k:')) {
    // De hele tekst, niet de ingekorte van het leespaneel.
    const stuk = c.k.kdb.stuk(id.slice(2));
    tekst = c.k.kdb.tekstVan(stuk) || blokkenTekst(d.document.blokken);
    if (!tekst) opmerking = 'Van dit Kamerstuk is (nog) geen tekst; open de link.';
  } else {
    if (d.documentOphalen) {
      try {
        const doc = await metTijdslimiet(documentOpVraag(c.opslag, id.slice(2)), 45_000);
        if (doc) d = detail(c.k, c.gebruiker, id);
      } catch (fout) {
        opmerking = `Het document kon niet bij de bron worden opgehaald (${fout.message}); hieronder wat de Regiochecker er al van had.`;
      }
    }
    tekst = blokkenTekst(d.document.blokken);
    if (d.verdwenen) opmerking = 'Dit stuk is bij de bron weggehaald; hieronder wat de Regiochecker ervan bewaarde.';
    if (!tekst) opmerking = opmerking || 'Van dit stuk is geen tekst beschikbaar; open de link.';
  }
  const meta = d.meta.filter((m) => !['Telefoon', 'Telegram'].includes(m.k)).map((m) => `${m.k}: ${m.v}`).join(' · ');
  const kop = [d.titel, meta, d.url ? `Link: ${d.url}` : null, opmerking].filter(Boolean);

  if (args.zoek && tekst) {
    const { totaal, vakken } = passages(tekst, args.zoek);
    if (!totaal) return [...kop, '', `"${args.zoek}" staat niet in de tekst (${tekst.length} tekens). Lees het stuk met vanaf/lengte.`].join('\n');
    return [
      ...kop,
      '',
      `${totaal}× gevonden: ${args.zoek}. ${vakken.length < totaal ? `De eerste ${vakken.length} passages` : 'De passages'} (positie = vanaf om daar verder te lezen):`,
      '',
      ...vakken.map((v) => `[positie ${Math.floor(v.begin)}] …${tekst.slice(Math.floor(v.begin), Math.ceil(v.eind)).trim()}…`),
    ].join('\n');
  }
  const vanaf = getal(args.vanaf, { standaard: 0, min: 0, max: Math.max(0, tekst.length) });
  const lengte = getal(args.lengte, { standaard: 15_000, min: 1000, max: 50_000 });
  const deel = tekst.slice(vanaf, vanaf + lengte);
  const rest = tekst.length - (vanaf + deel.length);
  return [
    ...kop,
    tekst.length > deel.length ? `Tekens ${vanaf}–${vanaf + deel.length} van ${tekst.length}.${rest > 0 ? ` Vervolg: vanaf=${vanaf + deel.length}.` : ''}` : null,
    '',
    deel,
  ].filter((x) => x !== null).join('\n');
}

let kamerSoorten = { tijd: 0, lijst: [] };
function regiosEnSoorten(args, c) {
  // Een telling over alle Kamerstukken duurt even: eens per zes uur.
  if (c.k.kdb && Date.now() - kamerSoorten.tijd > 6 * 3600_000) kamerSoorten = { tijd: Date.now(), lijst: c.k.kdb.soorten() };
  const mijn = (c.gebruiker.regios || []).filter((id) => c.k.regioMap.has(id));
  return [
    'Regio\'s (gemeenten), id: naam. Gebruik id of naam; "mijn" zijn de regio\'s die jij volgt.',
    ...c.k.regios.map((r) => `- ${r.id}: ${r.naam}`),
    '',
    `Jouw regio's: ${mijn.length ? regioNamen(c.k, mijn) : 'geen'}.`,
    '',
    'Soorten (voor zoeken en nieuwste), id: naam:',
    ...zichtbaar().map(([id, naam]) => `- ${id}: ${naam}`),
    '',
    'Archieven: Kamerstukken vanaf 2008; ingekomen stukken en Woo-besluiten van gemeenten zo ver terug als hun platforms ze aanbieden; gemeentenieuws, bekendmakingen en signalen sinds de Regiochecker de bron volgt; transcripten sinds de opname is verwerkt.',
    ...(kamerSoorten.lijst.length ? ['', 'Soorten Kamerstukken (voor kamerstukken_zoeken, met aantal):', ...kamerSoorten.lijst.slice(0, 40).map((s) => `- ${s.soort} (${s.aantal})`)] : []),
  ].join('\n');
}

const DATUM_SCHEMA = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const REGIO_SCHEMA = { type: 'array', items: { type: 'string' }, description: 'Gemeenten, op id of naam (zie regios_en_soorten); "mijn" voor de regio\'s die de gebruiker volgt. Leeg: alle.' };
const SOORT_SCHEMA = () => ({ type: 'array', items: { type: 'string', enum: zichtbaar().map(([id]) => id) }, description: 'Soorten stukken (zoals de tabbladen van de feed). Leeg: alle.' });
const LEZEN = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const TOOLS = () => [
  {
    name: 'zoeken',
    title: 'Zoeken in de Regiochecker',
    description: 'Zoek door alles van de Regiochecker tegelijk: gemeentelijke stukken (ook het archief van ingekomen stukken en Woo-besluiten), Kamerstukken, landelijke signalen en de transcripten van raadsvergaderingen, debatten, video\'s en podcasts. Nieuwste eerst, met per resultaat id, datum, soort, regio, link en een fragment rond de treffer. Een landelijk stuk telt bij een regio als het daarheen gaat (sleutelwoord of plek); een Kamerstuk als er een sleutelwoord van de regio in staat.',
    inputSchema: {
      type: 'object',
      properties: {
        vraag: { type: 'string', description: 'Zoekwoorden; alle woorden moeten erin staan. "Tussen aanhalingstekens" voor een woordgroep, OR (hoofdletters) tussen alternatieven. Hoofdletters en accenten maken niet uit.' },
        regios: REGIO_SCHEMA,
        soorten: SOORT_SCHEMA(),
        van: { ...DATUM_SCHEMA, description: 'Vanaf deze datum van het stuk (JJJJ-MM-DD).' },
        tot: { ...DATUM_SCHEMA, description: 'Tot en met deze datum van het stuk (JJJJ-MM-DD).' },
        pagina: { type: 'integer', minimum: 1, default: 1 },
        aantal: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: 'Resultaten per pagina.' },
      },
      required: ['vraag'],
    },
    annotations: LEZEN,
    doe: zoeken,
  },
  {
    name: 'kamerstukken_zoeken',
    title: 'Kamerstukken zoeken',
    description: 'Zoek alleen in de Kamerstukken van de Tweede Kamer (vanaf 2008, honderdduizenden stukken), op relevantie of datum, met het totale aantal treffers. Zoekvraag in SQLite FTS5-syntax: woorden (allemaal), "woordgroep", OR, NOT, voorvoegsel* (bijvoorbeeld: gaswinning NOT Groningen, "Nedersaksische Energie Maatschappij", windpark*). Geen regiofilter: zet de plaatsnaam in de vraag.',
    inputSchema: {
      type: 'object',
      properties: {
        vraag: { type: 'string', description: 'FTS5-zoekvraag. Leeg: alle stukken (met sorteer=datum de nieuwste).' },
        soort: { type: 'string', description: 'Soort Kamerstuk, precies zoals in regios_en_soorten (bijvoorbeeld "Motie", "Schriftelijke vragen").' },
        van: { ...DATUM_SCHEMA, description: 'Vanaf deze datum (JJJJ-MM-DD).' },
        tot: { ...DATUM_SCHEMA, description: 'Tot en met deze datum (JJJJ-MM-DD).' },
        sorteer: { type: 'string', enum: ['relevantie', 'datum'], default: 'relevantie' },
        pagina: { type: 'integer', minimum: 1, default: 1 },
        aantal: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
    },
    annotations: LEZEN,
    doe: kamerstukkenZoeken,
  },
  {
    name: 'nieuwste',
    title: 'Nieuw binnengekomen',
    description: 'Wat er de afgelopen dagen binnenkwam voor een of meer regio\'s, zonder zoekwoord: zoals de feed van de Regiochecker (eigen bronnen van de gemeente, landelijke stukken en Kamerstukken via de sleutelwoorden van de regio, vergaderingen en audio). Nieuwste eerst.',
    inputSchema: {
      type: 'object',
      properties: {
        regios: REGIO_SCHEMA,
        soorten: SOORT_SCHEMA(),
        dagen: { type: 'integer', minimum: 1, maximum: 30, default: 7 },
        pagina: { type: 'integer', minimum: 1, default: 1 },
        aantal: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
    },
    annotations: LEZEN,
    doe: nieuwste,
  },
  {
    name: 'stuk_lezen',
    title: 'Stuk lezen',
    description: 'De tekst van één stuk met het id uit de resultaten (i:…, k:…, a:…): het document met bijlagen, de tekst van een Kamerstuk, of bij audio en video de samenvatting, agenda en het transcript met tijden en sprekers. Lange teksten in delen (vanaf, lengte). Met zoek alleen de passages rond die woorden, met hun positie. Haalt het document zo nodig bij de bron op.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Het id uit de resultaten.' },
        zoek: { type: 'string', description: 'Alleen de passages rond deze woorden ("woordgroep" mag).' },
        vanaf: { type: 'integer', minimum: 0, default: 0, description: 'Teken waar het deel begint.' },
        lengte: { type: 'integer', minimum: 1000, maximum: 50000, default: 15000, description: 'Aantal tekens.' },
      },
      required: ['id'],
    },
    annotations: { ...LEZEN, openWorldHint: true },
    doe: leesStuk,
  },
  {
    name: 'regios_en_soorten',
    title: 'Regio\'s en soorten',
    description: 'De regio\'s (gemeenten) met hun id, de regio\'s die de gebruiker volgt, de soorten stukken, hoe ver de archieven teruggaan en de soorten Kamerstukken.',
    inputSchema: { type: 'object', properties: {} },
    annotations: LEZEN,
    doe: regiosEnSoorten,
  },
];

// ---------- JSON-RPC ----------

async function methode(naam, params, c) {
  if (naam === 'initialize') {
    const gevraagd = params?.protocolVersion;
    return {
      protocolVersion: VERSIES.includes(gevraagd) ? gevraagd : VERSIES[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'regiochecker', title: 'Regiochecker', version: '1.0.0' },
      instructions: INSTRUCTIES,
    };
  }
  if (naam === 'ping') return {};
  if (naam === 'tools/list') return { tools: TOOLS().map(({ doe, ...t }) => t) };
  if (naam === 'tools/call') {
    const tool = TOOLS().find((t) => t.name === params?.name);
    if (!tool) throw new RpcFout(-32602, `Onbekende tool: ${params?.name}`);
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    try {
      const tekst = await tool.doe(args, c);
      return { content: [{ type: 'text', text: tekst }] };
    } catch (fout) {
      if (fout instanceof ToolFout) return { content: [{ type: 'text', text: fout.message }], isError: true };
      console.error(`MCP ${tool.name}:`, fout);
      return { content: [{ type: 'text', text: `Er ging iets mis: ${fout.message}` }], isError: true };
    }
  }
  throw new RpcFout(-32601, `Onbekende methode: ${naam}`);
}

async function verwerk(bericht, c) {
  if (!bericht || typeof bericht !== 'object' || bericht.jsonrpc !== '2.0') return { jsonrpc: '2.0', id: bericht?.id ?? null, error: { code: -32600, message: 'Ongeldig JSON-RPC-bericht' } };
  // Een melding (notifications/…) of een antwoord van de client: niets terug.
  if (typeof bericht.method !== 'string' || bericht.id === undefined || bericht.id === null) return null;
  try {
    return { jsonrpc: '2.0', id: bericht.id, result: await methode(bericht.method, bericht.params, c) };
  } catch (fout) {
    if (fout instanceof RpcFout) return { jsonrpc: '2.0', id: bericht.id, error: { code: fout.code, message: fout.message } };
    console.error('MCP:', fout);
    return { jsonrpc: '2.0', id: bericht.id, error: { code: -32603, message: 'Interne fout' } };
  }
}

function stuurJson(res, status, data, kop = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS, ...kop });
  res.end(data === undefined ? '' : JSON.stringify(data));
}

// /mcp. ctx: { opslag, kdb, fdb, adb, oauth }.
export async function mcpRoute(req, res, url, ctx) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...CORS, 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' });
    return res.end();
  }
  const basis = basisUrl(req);
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1];
  const toegang = token && ctx.oauth ? ctx.oauth.controleer(token) : null;
  const gebruiker = toegang && ctx.opslag.gebruikers.find((g) => g.id === toegang.gebruiker);
  if (!gebruiker) {
    return stuurJson(res, 401, { error: 'invalid_token', error_description: token ? 'Ongeldig of verlopen token' : 'Inloggen nodig' }, {
      'WWW-Authenticate': `Bearer resource_metadata="${basis}/.well-known/oauth-protected-resource/mcp"${token ? ', error="invalid_token"' : ''}`,
    });
  }
  // Geen sessies en geen stroom van de server naar de app.
  if (req.method !== 'POST') return stuurJson(res, 405, { error: 'Alleen POST' }, { Allow: 'POST, OPTIONS' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return stuurJson(res, 415, { error: 'Verwacht application/json' });
  let bericht;
  try {
    bericht = JSON.parse(await leesLijf(req, MAX_LIJF));
  } catch (fout) {
    if (fout.status === 413) return stuurJson(res, 413, { error: 'Verzoek te groot' });
    return stuurJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Ongeldige JSON' } });
  }
  const c = { opslag: ctx.opslag, k: maakKader(ctx), gebruiker, toegang };
  // Een lijst berichten (protocolversie 2025-03-26) kan nog; daarna niet meer.
  if (Array.isArray(bericht)) {
    if (!bericht.length) return stuurJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Lege lijst' } });
    const antwoorden = [];
    for (const b of bericht.slice(0, 20)) {
      const a = await verwerk(b, c);
      if (a) antwoorden.push(a);
    }
    return antwoorden.length ? stuurJson(res, 200, antwoorden) : stuurJson(res, 202);
  }
  const antwoord = await verwerk(bericht, c);
  return antwoord ? stuurJson(res, 200, antwoord) : stuurJson(res, 202);
}

export { TOOLS };
