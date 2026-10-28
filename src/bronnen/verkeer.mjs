// Verkeer, overgenomen uit de checker (/opt/checker): files van de NDW en
// storingen van de NS. Beide zijn vluchtig; de Regiochecker kijkt elke vijf
// minuten (`intervalMinuten` in src/register.mjs) en werkt een stuk bij zolang
// het er is (`bijwerken`). Ze gaan naar een regio als de file of een station
// van de storing in de gemeente ligt (src/feed.mjs, met src/geo.mjs).
//
//   files          open DATEX II-feed van de NDW (actueel_beeld.xml.gz, geen
//                  sleutel): situatierecords van het soort AbnormalTraffic, met
//                  lengte, vertraging en het traject als lijn. Het wegnummer
//                  staat er niet in; dat komt van de PDOK Locatieserver.
//   NS-storingen   NS Reisinformatie API v3 (/disruptions), met een gratis
//                  sleutel (NS_API_KEY, aan te vragen op apiportal.ns.nl).

import { gunzipSync } from 'node:zlib';
import { haalBuffer, haalJson } from '../ophalen.mjs';
import { ontsnap } from '../html.mjs';

const PDOK = process.env.PDOK_LOCATIESERVER || 'https://api.pdok.nl/bzk/locatieserver/search/v3_1';
const getal = (n, cijfers = 1) => Number(n).toLocaleString('nl-NL', { minimumFractionDigits: cijfers, maximumFractionDigits: cijfers });
const klok = (iso) => new Date(iso).toLocaleTimeString('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' });
const dag = (iso) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });

// ---------- files ----------

const FILESOORT = { stationaryTraffic: 'Stilstaand verkeer', queuingTraffic: 'Aansluitende file', slowTraffic: 'Langzaam rijdend verkeer' };
const RECORD = /<(?:\w+:)?situationRecord\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?situationRecord>/g;
const veld = (xml, naam) => new RegExp(`<(?:\\w+:)?${naam}>([^<]*)</(?:\\w+:)?${naam}>`).exec(xml)?.[1]?.trim() || null;

// Files uit de feed, met hun traject (hooguit twaalf punten, voor de routering).
export function leesFiles(xml, { minVertragingMin = 10 } = {}) {
  const uit = [];
  for (const [, attributen, inhoud] of String(xml).matchAll(RECORD)) {
    if (!/xsi:type="(?:\w+:)?AbnormalTraffic"/.test(attributen)) continue;
    const id = /\bid="([^"]+)"/.exec(attributen)?.[1];
    const vertraging = Number(veld(inhoud, 'delayTimeValue'));
    if (!id || !(vertraging >= minVertragingMin * 60)) continue;
    const lijn = (veld(inhoud, 'posList') || '').split(/\s+/).map(Number);
    const punten = [];
    for (let i = 0; i + 1 < lijn.length; i += 2) if (Number.isFinite(lijn[i]) && Number.isFinite(lijn[i + 1])) punten.push({ lat: lijn[i], lon: lijn[i + 1] });
    if (!punten.length) {
      const lat = Number(veld(inhoud, 'latitude'));
      const lon = Number(veld(inhoud, 'longitude'));
      if (Number.isFinite(lat) && Number.isFinite(lon)) punten.push({ lat, lon });
    }
    if (!punten.length) continue;
    const stap = Math.max(1, Math.ceil(punten.length / 12));
    uit.push({
      id,
      soort: veld(inhoud, 'abnormalTrafficType'),
      lengte: Number(veld(inhoud, 'queueLength')) || null,
      vertraging,
      sinds: veld(inhoud, 'situationRecordCreationTime'),
      midden: punten[Math.floor(punten.length / 2)],
      punten: punten.filter((_, i) => i % stap === 0 || i === punten.length - 1),
    });
  }
  return uit;
}

// "A7" of "N31" uit "A7", "Rijksweg A7", "Rijksweg 7".
const wegnummer = (naam) => {
  const m = /\b([AN])\s?(\d{1,3})\b/.exec(naam || '') || /\bRijksweg\s+(\d{1,3})\b/i.exec(naam || '');
  return m ? (m.length === 3 ? `${m[1]}${m[2]}` : `A${m[1]}`) : null;
};

// Welke weg en welke plaats, via de PDOK Locatieserver. Per file één keer.
const wegen = new Map();
async function wegBij({ lat, lon }, id) {
  if (wegen.has(id)) return wegen.get(id);
  let weg = null;
  try {
    const d = await haalJson(`${PDOK}/reverse?lat=${lat}&lon=${lon}&type=weg&rows=5&fl=straatnaam,woonplaatsnaam,gemeentenaam`);
    const docs = d?.response?.docs || [];
    const nummer = docs.map((x) => wegnummer(x.straatnaam)).find(Boolean);
    const eerste = docs[0];
    if (eerste) weg = { weg: nummer || eerste.straatnaam || null, snelweg: Boolean(nummer), plaats: eerste.woonplaatsnaam || eerste.gemeentenaam || null, gemeente: eerste.gemeentenaam || null };
  } catch {
    return null; // volgende ronde opnieuw
  }
  if (wegen.size > 5000) wegen.clear();
  wegen.set(id, weg);
  return weg;
}

export function fileStuk(f, weg) {
  const km = f.lengte ? getal(f.lengte / 1000) : null;
  const minuten = Math.round(f.vertraging / 60);
  const waar = [weg?.weg && `op de ${weg.weg}`, weg?.plaats && `bij ${weg.plaats}`].filter(Boolean).join(' ');
  const naam = [weg?.weg, weg?.plaats && `bij ${weg.plaats}`].filter(Boolean).join(' ') || 'deze plek';
  return {
    sleutel: f.id,
    titel: `File${waar ? ` ${waar}` : ''}: ${[km && `${km} km`, `${minuten} minuten vertraging`].filter(Boolean).join(', ')}`,
    url: `https://www.openstreetmap.org/?mlat=${f.midden.lat}&mlon=${f.midden.lon}#map=13/${f.midden.lat}/${f.midden.lon}`,
    datum: f.sinds ? dag(f.sinds) : null,
    tekst: `${FILESOORT[f.soort] || 'File'}${km ? ` over ${km} km` : ''}${waar ? ` ${waar}` : ''}, ${minuten} minuten vertraging${f.sinds ? `; sinds ${klok(f.sinds)}` : ''}. Bron: NDW.`,
    plek: { ...f.midden, naam },
    punten: f.punten.map((p) => ({ ...p, naam })),
  };
}

export async function haalFiles(bron) {
  let ruw = await haalBuffer(bron.url);
  if (ruw[0] === 0x1f && ruw[1] === 0x8b) ruw = gunzipSync(ruw);
  const files = leesFiles(ruw.toString('utf8'), { minVertragingMin: bron.minVertragingMin });
  const uit = [];
  for (const f of files) uit.push(fileStuk(f, await wegBij(f.midden, f.id)));
  return uit;
}

// ---------- NS-storingen ----------

const NS_SOORT = { DISRUPTION: 'Treinstoring', CALAMITY: 'Calamiteit op het spoor', MAINTENANCE: 'Werkzaamheden op het spoor' };

export function leesStoringen(data, { werkzaamheden = true } = {}) {
  const lijst = Array.isArray(data) ? data : data?.payload || data?.disruptions || [];
  const uit = [];
  for (const d of lijst) {
    if (!d?.id || !NS_SOORT[d.type] || (d.type === 'MAINTENANCE' && !werkzaamheden)) continue;
    const stations = new Map();
    for (const s of d.publicationSections || []) {
      for (const st of [...(s.section?.stations || []), ...(s.consequence?.section?.stations || [])]) {
        if (st?.name && !stations.has(st.name)) stations.set(st.name, st);
      }
    }
    const spannen = d.timespans || [];
    const span = spannen[0] || {};
    const situatie = ontsnap(span.situation?.label || d.description || '').trim();
    const oorzaak = ontsnap(spannen.map((t) => t.cause?.label).find(Boolean) || '').trim();
    const extra = span.additionalTravelTime?.label || d.summaryAdditionalTravelTime?.label || '';
    const tot = d.expectedDuration?.description || '';
    const advies = (span.advices || []).map((a) => ontsnap(a).trim()).filter(Boolean);
    const titel = String(d.title || d.topic || '').trim() || [...stations.keys()].slice(0, 2).join(' - ') || 'onbekend traject';
    const begin = span.start || d.start || null;
    uit.push({
      // Werkzaamheden krijgen elke dag een nieuw id, met dezelfde titel: op titel
      // samenvoegen, anders komen dezelfde werkzaamheden elke dag terug.
      sleutel: d.type === 'MAINTENANCE' ? `w:${titel.toLowerCase()}` : String(d.id),
      titel: `${NS_SOORT[d.type]}: ${titel}`,
      url: d.type === 'CALAMITY' && d.url ? d.url : 'https://www.ns.nl/reisinformatie/actuele-situatie-op-het-spoor',
      datum: begin ? dag(begin) : null,
      tekst: [situatie && `${situatie.replace(/\.?$/, '.')}`, oorzaak && `Oorzaak: ${oorzaak}.`, extra && `${extra.replace(/\.?$/, '.')}`, tot && `${tot.replace(/\.?$/, '.')}`, ...advies.slice(0, 2).map((a) => a.replace(/\.?$/, '.')), 'Bron: NS.'].filter(Boolean).join(' '),
      punten: [...stations.values()]
        .filter((st) => Number.isFinite(st.coordinate?.lat) && Number.isFinite(st.coordinate?.lng))
        .map((st) => ({ lat: st.coordinate.lat, lon: st.coordinate.lng, naam: `station ${st.name}` })),
    });
  }
  return uit;
}

export async function haalStoringen(bron) {
  const sleutel = process.env.NS_API_KEY;
  if (!sleutel) throw new Error('Geen sleutel voor de NS-API: zet NS_API_KEY in .env (gratis via apiportal.ns.nl).');
  const data = await haalJson(bron.url, { headers: { 'Ocp-Apim-Subscription-Key': sleutel, 'Cache-Control': 'no-cache' } });
  return leesStoringen(data, { werkzaamheden: bron.werkzaamheden !== false });
}
