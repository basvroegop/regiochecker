// iBabs-publieksportaal (*.bestuurlijkeinformatie.nl): de "overzichten" onder
// /ReportCategories, zoals "Ingekomen stukken 2026-2030". De pagina zelf is leeg;
// de tabel haalt zijn regels met een DataTables-verzoek op. Welke kolommen er zijn
// verschilt per gemeente en staat in het data-columns-attribuut van de tabel, dus
// dat lezen we eerst.

import { haalTekst, postFormulier } from '../ophalen.mjs';
import { ontsnap, platteTekst, kort } from '../html.mjs';
import { leesDatum } from '../datum.mjs';

const DATUMKOLOMMEN = ['registrationdate', 'datum', 'invoerdatum', 'date'];
const TITELKOLOMMEN = ['title', 'titel', 'onderwerp'];

export function leesKolommen(pagina) {
  const m = String(pagina).match(/data-columns='([^']*)'/);
  if (!m) throw new Error('iBabs-overzicht zonder data-columns: is de pagina veranderd?');
  return JSON.parse(ontsnap(m[1])).map((k) => k.data);
}

export function dataTablesVelden(kolommen, aantal) {
  const datumKolom = kolommen.findIndex((k) => DATUMKOLOMMEN.includes(k));
  const velden = {
    draw: '1', start: '0', length: String(aantal),
    'search[value]': '', 'search[regex]': 'false',
  };
  // Zonder sortering geeft iBabs de regels in willekeurige volgorde terug
  // (gezien bij Ooststellingwerf); daarom altijd op datum, nieuwste eerst.
  if (datumKolom >= 0) {
    velden['order[0][column]'] = String(datumKolom);
    velden['order[0][dir]'] = 'desc';
  }
  kolommen.forEach((naam, i) => {
    velden[`columns[${i}][data]`] = naam;
    velden[`columns[${i}][name]`] = naam;
    velden[`columns[${i}][searchable]`] = 'true';
    velden[`columns[${i}][orderable]`] = 'true';
    velden[`columns[${i}][search][value]`] = '';
    velden[`columns[${i}][search][regex]`] = 'false';
  });
  return velden;
}

const tekst = (w) => (typeof w === 'string' ? platteTekst(w) : '');

export function leesRegels(json, basis) {
  return (json?.data || []).map((r) => {
    const titel = tekst(TITELKOLOMMEN.map((k) => r[k]).find(Boolean));
    const datumVeld = DATUMKOLOMMEN.map((k) => r[k]).find(Boolean);
    const extra = [r.toelichting, r.locatie && `Locatie: ${r.locatie}`]
      .map(tekst).filter(Boolean).join(' — ');
    return {
      sleutel: r.DT_RowId,
      titel,
      url: `${basis}/Reports/Item/${r.DT_RowId}`,
      datum: leesDatum(datumVeld),
      afzender: tekst(r.afzender) || tekst(r.portefeuillehouder) || null,
      soortStuk: tekst(r.soortstuk) || null,
      tekst: extra ? kort(extra, 600) : null,
    };
  }).filter((r) => r.sleutel && r.titel);
}

export async function haalIbabs(bron) {
  const basis = bron.basis.replace(/\/$/, '');
  const pagina = await haalTekst(`${basis}/Reports/Details/${bron.overzicht}`);
  const kolommen = leesKolommen(pagina);
  const json = await postFormulier(
    `${basis}/Reports/GetReportData/${bron.overzicht}`,
    dataTablesVelden(kolommen, bron.aantal || 50),
    { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
  );
  return leesRegels(json, basis);
}
