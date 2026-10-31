// De Whisper-worker: een eigen machine met GPU in het thuisnetwerk (de
// "Plaud Whisper Worker", die ook Plaud en Storyteller bedient). Hij doet het
// zware werk: transcriberen met Whisper large-v3, stemmen herkennen
// (pyannote, met stemprofielen die over alle opnames heen gelden), namen
// vinden en telefoonnummers duiden met een lokaal taalmodel (Ollama).
// Bereikbaar via de Tailscale-container (src/tailnet.mjs); het token staat
// in de instellingen of in WORKER_TOKEN en gaat nooit naar de browser.
//
//   GET   /health                         status; inference_phase = GPU bezig;
//                                         status 'paused' + reason 'game': Spelwacht
//   POST  /v1/media/transcriptions        multipart: file, response_format=verbose_json,
//                                         recording_id, diarize=true
//   POST  /v1/entities                    { text } → { entities: [{ name, type }] }
//   POST  /v1/phone-context               { text, nearby_entities } → duiding van een nummer
//   GET   /v1/speakers                    stemprofielen
//   PATCH /v1/speakers/{id}               { name } → profiel met display_name
//   GET   /v1/speakers/{id}/sample        kort fragment van die stem (wav)

import { openAsBlob } from 'node:fs';
import { fetch, FormData } from 'undici';
import { tailnetDispatcher, langDispatcher, proxyReden } from '../tailnet.mjs';

const KORT_MS = 30_000;
// Een raadsvergadering van vier uur transcriberen, terwijl Plaud misschien
// ook nog de GPU gebruikt: ruim nemen, net als audioscraper deed.
const TRANSCRIPTIE_MS = 4 * 3600_000;
const ENTITEITEN_MS = 22 * 60_000;
const CONTEXT_MS = 11 * 60_000;

export class WorkerFout extends Error {
  constructor(bericht, { status = 502, tijdelijk = false, httpStatus = null } = {}) {
    super(bericht);
    this.status = status;
    this.tijdelijk = tijdelijk;
    this.httpStatus = httpStatus;
  }
}

export function workerToken(instellingen) {
  return instellingen.audio?.workerToken || process.env.WORKER_TOKEN || '';
}

function onbereikbaar(fout, viaTailnet) {
  const keten = [];
  for (let f = fout; f; f = f.cause) keten.push(f);
  if (keten.some((f) => f.name === 'TimeoutError')) return 'De worker gaf geen antwoord binnen de tijd';
  const proxyStatus = keten.map((f) => String(f.message).match(/Proxy response \((\d+)\)/)?.[1]).find(Boolean);
  if (proxyStatus) return `De worker is niet bereikbaar via Tailscale (proxy gaf HTTP ${proxyStatus})`;
  const diepste = keten.at(-1);
  return `De worker is niet bereikbaar${viaTailnet ? ' via Tailscale' : ''} (${diepste.code || diepste.message})`;
}

// Speelt er een spel op de GPU-machine? Dan heeft Spelwacht
// (scripts/windows/spelwacht.ps1) de worker gestopt en antwoordt het zelf op
// /health: { status: 'paused', reason: 'game', game, since }. Geeft het spel
// ({ naam, sinds }) of null.
export function spelUit(health) {
  if (health?.status !== 'paused' || health.reason !== 'game') return null;
  // PowerShell schrijft zeven decimalen ("…18:00:00.0000000+01:00"); niet elke
  // browser leest dat, dus netjes als ISO.
  const sinds = Date.parse(health.since);
  return { naam: health.game ? String(health.game).slice(0, 100) : null, sinds: Number.isNaN(sinds) ? null : new Date(sinds).toISOString() };
}

// Geeft een client, of null als er geen worker is ingesteld.
export function worker(instellingen) {
  const a = instellingen.audio || {};
  if (!a.workerUrl) return null;
  const basis = String(a.workerUrl).trim().replace(/\/+$/, '');
  const tailnet = Boolean(a.viaTailnet !== false && process.env.REGIOCHECKER_TAILNET_PROXY);
  const token = workerToken(instellingen);

  async function verzoek(pad, { methode = 'GET', body, json, tijd = KORT_MS, signaal } = {}) {
    const lang = tijd > 5 * 60_000;
    try {
      return await fetch(`${basis}${pad}`, {
        method: methode,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(json ? { 'Content-Type': 'application/json' } : {}),
        },
        body: json ? JSON.stringify(json) : body,
        dispatcher: tailnet ? tailnetDispatcher({ lang }) : (lang ? langDispatcher() : undefined),
        signal: signaal || AbortSignal.timeout(tijd),
      });
    } catch (fout) {
      let melding = onbereikbaar(fout, tailnet);
      if (tailnet && melding.includes('proxy gaf HTTP')) {
        const reden = await proxyReden(`${basis}${pad}`);
        if (reden) melding = `De worker is niet bereikbaar via Tailscale: ${reden}`;
      }
      throw new WorkerFout(melding, { tijdelijk: true });
    }
  }

  async function lees(antwoord) {
    const tekst = await antwoord.text();
    let data = null;
    try { data = tekst ? JSON.parse(tekst) : null; } catch { /* geen JSON */ }
    if (antwoord.status === 401) throw new WorkerFout('De worker weigert het ingestelde token (Instellingen › Audio en video)', { status: 502 });
    if (antwoord.status === 404) throw new WorkerFout(data?.detail && data.detail !== 'Not Found' ? String(data.detail) : 'De worker kent deze opdracht niet; is de audio-uitbreiding geïnstalleerd?', { status: 404 });
    if (!antwoord.ok) {
      const detail = typeof data?.detail === 'string' ? data.detail : data?.detail?.[0]?.msg;
      const tijdelijk = [408, 409, 425, 429].includes(antwoord.status) || antwoord.status >= 500;
      throw new WorkerFout(`Worker: ${detail || `HTTP ${antwoord.status}`}`, { status: antwoord.status >= 500 ? 502 : antwoord.status, tijdelijk, httpStatus: antwoord.status });
    }
    if (data === null) throw new WorkerFout('De worker gaf geen JSON terug; klopt het adres (poort 8765)?');
    return data;
  }

  return {
    basis,
    tailnet,
    heeftToken: Boolean(token),
    gezond: async ({ tijd = 10_000 } = {}) => lees(await verzoek('/health', { tijd })),
    // Is de gedeelde GPU nu bezig (Plaud, Storyteller, onze eigen transcriptie,
    // of een spel: dan antwoordt Spelwacht in plaats van de worker)?
    gpuBezig: async () => {
      try {
        const h = await lees(await verzoek('/health', { tijd: 3000 }));
        return Boolean(h.inference_phase) || Boolean(spelUit(h));
      } catch {
        return false;
      }
    },
    transcribeer: async (pad, opname) => {
      const form = new FormData();
      form.append('file', await openAsBlob(pad, { type: 'audio/mpeg' }), 'audio.mp3');
      form.append('response_format', 'verbose_json');
      form.append('recording_id', `regiochecker:${opname}`);
      form.append('diarize', 'true');
      return lees(await verzoek('/v1/media/transcriptions', { methode: 'POST', body: form, tijd: TRANSCRIPTIE_MS }));
    },
    entiteiten: async (tekst) => lees(await verzoek('/v1/entities', { methode: 'POST', json: { text: tekst }, tijd: ENTITEITEN_MS })),
    telefoonContext: async (tekst, entiteiten) => lees(await verzoek('/v1/phone-context', { methode: 'POST', json: { text: tekst, nearby_entities: entiteiten }, tijd: CONTEXT_MS })),
    sprekers: async () => lees(await verzoek('/v1/speakers')),
    noemSpreker: async (profiel, naam) => lees(await verzoek(`/v1/speakers/${encodeURIComponent(profiel)}`, { methode: 'PATCH', json: { name: naam } })),
    // Ruw antwoord, om door te geven aan de browser.
    fragment: (profiel, signaal) => verzoek(`/v1/speakers/${encodeURIComponent(profiel)}/sample`, { signaal }),
  };
}
