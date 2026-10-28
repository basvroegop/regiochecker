// Hulpjes om src/api.mjs aan te roepen zonder echte server: een nagebootst
// verzoek en antwoord, en dezelfde stuur/leesJson/Fout als in src/dienst.mjs.

import { Writable } from 'node:stream';
import { api } from '../src/api.mjs';

export class Fout extends Error {
  constructor(status, bericht) { super(bericht); this.status = status; }
}

function nepVerzoek(methode, pad, body, headers = {}) {
  const tekst = body === undefined ? '' : JSON.stringify(body);
  return {
    method: methode,
    url: pad,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    async *[Symbol.asyncIterator]() { if (tekst) yield Buffer.from(tekst); },
  };
}

// Een echte Writable, zodat ook een gestreamd bestand (pipeline) aankomt.
function nepAntwoord() {
  const stukken = [];
  const res = new Writable({ write(stuk, _codering, klaar) { stukken.push(Buffer.from(stuk)); klaar(); } });
  res.status = null;
  res.kop = {};
  res.writeHead = (status, kop = {}) => { res.status = status; res.kop = kop; return res; };
  Object.defineProperty(res, 'headersSent', { get: () => res.status !== null });
  res.lijf = () => Buffer.concat(stukken);
  res.json = () => JSON.parse(res.lijf().toString('utf8'));
  return res;
}

async function leesJson(req) {
  let ruw = '';
  for await (const stuk of req) ruw += stuk;
  return ruw ? JSON.parse(ruw) : {};
}

// Geeft { status, data } (data = JSON of Buffer), of gooit niet: fouten komen
// terug als { status, data: { fout } }, zoals de dienst ze zou sturen.
export async function roep(ctx, gebruiker, methode, pad, body, headers) {
  const req = nepVerzoek(methode, pad, body, headers);
  const res = nepAntwoord();
  const stuur = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };
  const taken = ctx.taken || { start: (soort, invoer) => ({ soort, invoer, status: 'bezig' }), status: () => { throw new Fout(404, 'Taak niet gevonden'); } };
  try {
    await api(req, res, new URL(pad, 'http://localhost'), { ...ctx, gebruiker, stuur, leesJson, Fout, taken });
  } catch (fout) {
    return { status: fout.status || 500, data: { fout: fout.message } };
  }
  const json = String(res.kop['Content-Type'] || res.kop['content-type'] || '').includes('json');
  return { status: res.status, data: json ? res.json() : res.lijf(), kop: res.kop };
}
