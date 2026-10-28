// API voor de kamerstukken: status en de zoekmachine over alle stukken.
// Sleutelwoorden per regio staan bij de regio's (src/beheer.mjs), meldingen
// bij de gebruiker (src/meldingen.mjs). Geeft true als het verzoek hier hoort.

import { stukUrl, downloadUrl } from './db.mjs';
import { vanaf } from './ophalen.mjs';

const DATUM = /^\d{4}-\d{2}-\d{2}$/;

function stukVoorClient(s) {
  return {
    id: s.id, nummer: s.nummer, soort: s.soort, titel: s.titel, onderwerp: s.onderwerp, datum: s.datum,
    dossier: s.dossier, dossiertitel: s.dossiertitel, afzender: s.afzender,
    url: stukUrl(s), download: downloadUrl(s), fragment: s.fragment || '', tekststatus: s.tekststatus,
  };
}

export async function kamerApi(req, res, url, { opslag, kdb, stuur, Fout }) {
  const deel = url.pathname.split('/').filter(Boolean); // ['api', 'kamer', ...]
  if (deel[1] !== 'kamer') return false;
  if (!kdb) throw new Fout(503, 'De kamerstukkendatabase is niet beschikbaar');
  const route = `${req.method} /${deel.slice(2).join('/')}`;
  const z = url.searchParams;

  if (route === 'GET /status') {
    return stuur({ ...kdb.status(), vanaf: vanaf(), ronde: opslag.status.kamer || null, soorten: kdb.soorten() }), true;
  }

  if (route === 'GET /zoek') {
    const van = z.get('van') || '';
    const tot = z.get('tot') || '';
    if ((van && !DATUM.test(van)) || (tot && !DATUM.test(tot))) throw new Fout(400, 'Datum als JJJJ-MM-DD');
    const r = kdb.zoek({
      vraag: (z.get('q') || '').slice(0, 500),
      soort: z.get('soort') || '',
      van, tot,
      sorteer: z.get('sorteer') === 'datum' ? 'datum' : 'relevantie',
      pagina: Math.max(1, Number(z.get('pagina')) || 1),
      perPagina: 20,
    });
    return stuur({ totaal: r.totaal, vraag: r.vraag, aangepast: Boolean(r.aangepast), resultaten: r.rijen.map(stukVoorClient) }), true;
  }
  throw new Fout(404, 'Onbekende route');
}
