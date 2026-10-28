// Notubiz, module "Ingekomen stukken" (Smallingerland), via de openbare API op
// api.notubiz.nl. De portalpagina zelf (smallingerland.notubiz.nl) zit achter
// een Cloudflare-botcontrole die automatische verzoeken tegenhoudt; de API is
// juist bedoeld voor dit soort gebruik.
//
// De API geeft de stukken op volgorde van invoer, oudste eerst, en kent
// `start` en `limit`. We vragen eerst het totaal op en dan de laatste 150.

import { haalJson } from '../ophalen.mjs';
import { leesDatum } from '../datum.mjs';
import { platteTekst } from '../html.mjs';

const API = 'https://api.notubiz.nl';
const AANTAL = 150;

const lijst = (x) => (Array.isArray(x) ? x : x ? [x] : []);

export function leesNotubizApi(json, portaal) {
  return lijst(json?.item).map((item) => {
    const id = item['@attributes']?.id;
    const velden = {};
    for (const a of lijst(item.attributes?.attribute)) velden[String(a.label).toLowerCase()] = a.value;
    const titel = platteTekst(velden.onderwerp);
    if (!id || !titel) return null;
    const nummer = platteTekst(velden.nummer);
    const advies = platteTekst(velden.advies);
    return {
      sleutel: String(id),
      titel,
      url: `${portaal}/modules/1/Ingekomen%20stukken/${id}`,
      datum: leesDatum(velden['datum brief'] || velden.datum),
      document: velden.hoofddocument?.url || null,
      soortStuk: nummer ? `Nr. ${nummer}` : null,
      advies: advies && advies !== 'Geen' ? advies : null,
    };
  }).filter(Boolean);
}

export async function haalNotubiz(bron) {
  const pad = `${API}/organisations/${bron.organisatie}/modules/${bron.module || 1}/items?format=json&version=1.10.8`;
  const totaal = (await haalJson(`${pad}&limit=1`))?.pagination?.['@attributes']?.total_results;
  if (!Number.isFinite(totaal)) throw new Error('Notubiz-API gaf geen aantal terug');
  const start = Math.max(0, totaal - AANTAL);
  return leesNotubizApi(await haalJson(`${pad}&start=${start}&limit=${AANTAL}`), bron.basis.replace(/\/$/, ''));
}
