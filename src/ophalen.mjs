// Alle netwerkverkeer naar de gemeentesites loopt hierdoor: vaste user-agent,
// een time-out en één nieuwe poging bij een netwerkfout of een 5xx.
//
// De user-agent lijkt op een browser omdat sommige portalen (Notubiz) een
// kaal "Mozilla/5.0" een uitgeklede pagina zonder lijst geven. Aan het eind staat
// wel wie we zijn, zodat een beheerder ons in de logs kan terugvinden.

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 Regiochecker/1.0';
const TIJDLIMIET_MS = 45_000;

async function verzoek(url, opties = {}, poging = 1) {
  let antwoord;
  try {
    antwoord = await fetch(url, {
      ...opties,
      headers: { 'User-Agent': UA, 'Accept-Language': 'nl-NL,nl;q=0.9', ...opties.headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIJDLIMIET_MS),
    });
  } catch (fout) {
    if (poging < 2) return verzoek(url, opties, poging + 1);
    throw new Error(`${url} niet bereikbaar: ${fout.cause?.code || fout.message}`);
  }
  if (antwoord.status >= 500 && poging < 2) return verzoek(url, opties, poging + 1);
  if (!antwoord.ok) throw new Error(`${url} gaf HTTP ${antwoord.status}`);
  return antwoord;
}

export async function haalTekst(url, opties) {
  return (await verzoek(url, opties)).text();
}

export async function haalJson(url) {
  return (await verzoek(url, { headers: { Accept: 'application/json' } })).json();
}

const MAX_BYTES = 30 * 1024 * 1024;

// Met de content-type erbij, zodat de inhoudsophaler pdf en HTML uit elkaar kan
// houden. Grote bestanden (bijlagen van honderden pagina's) laten we liggen.
export async function haalBestand(url) {
  const antwoord = await verzoek(url);
  const lengte = Number(antwoord.headers.get('content-length'));
  if (lengte > MAX_BYTES) {
    await antwoord.body?.cancel();
    throw new Error(`${url} is te groot (${Math.round(lengte / 1e6)} MB)`);
  }
  const buffer = Buffer.from(await antwoord.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw new Error(`${url} is te groot`);
  return { buffer, type: antwoord.headers.get('content-type') || '', url: antwoord.url || url };
}

export async function haalBuffer(url) {
  return (await haalBestand(url)).buffer;
}

export async function postJson(url, data) {
  const antwoord = await verzoek(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(data),
  });
  return antwoord.json();
}

export async function postFormulier(url, velden, headers = {}) {
  const antwoord = await verzoek(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', ...headers },
    body: new URLSearchParams(velden).toString(),
  });
  return antwoord.json();
}
