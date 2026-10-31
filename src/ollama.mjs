// Ollama op een eigen machine, bereikbaar via Tailscale. Deze server zit zelf
// niet in het tailnet; daarvoor draait naast de dienst een Tailscale-container
// (zie docker-compose.yml) met een HTTP-proxy. Alleen het verkeer naar Ollama
// gaat door die proxy (REGIOCHECKER_TAILNET_PROXY); de gemeentesites niet.
//
// Zonder proxy-instelling praten we rechtstreeks met de opgegeven URL, voor het
// geval Tailscale ooit op de server zelf komt te draaien.

import { spelOpOllama, spelTekst } from './audio/spel.mjs';
import { fetch } from 'undici';
import { tailnetDispatcher, langDispatcher, proxyReden } from './tailnet.mjs';

const VERBINDEN_MS = 15_000;
// Een lokaal model op gewone hardware doet over een week aan berichten zo een
// paar minuten. Ruim nemen: het gaat om een wekelijkse mail, niet om een klik.
const ANTWOORD_MS = 15 * 60_000;

function basis(url) {
  const schoon = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+/.test(schoon)) throw new Error('Vul de Ollama-URL in, bijvoorbeeld http://naam-van-machine:11434');
  return schoon;
}

function vertaalProxyReden(reden, url) {
  const poort = (() => { try { return new URL(url).port || '80'; } catch { return '11434'; } })();
  if (/refused/i.test(reden)) {
    return `De machine is bereikbaar via Tailscale, maar weigert poort ${poort}. Draait Ollama daar, en luistert het op het netwerk (OLLAMA_HOST=0.0.0.0)?`;
  }
  if (/no such host|lookup|not found/i.test(reden)) return 'Die machinenaam bestaat niet in je tailnet; controleer de naam of gebruik het 100.x-adres.';
  if (/timeout|timed out|unreachable/i.test(reden)) return 'De machine reageert niet via Tailscale; staat hij aan en is hij online in je tailnet?';
  return `Ollama niet bereikbaar via Tailscale: ${reden}`;
}

// undici verstopt de echte reden een paar lagen diep in `cause`.
function onbereikbaar(fout) {
  const keten = [];
  for (let f = fout; f; f = f.cause) keten.push(f);
  const diepste = keten.at(-1);
  if (keten.some((f) => f.name === 'TimeoutError')) {
    // Via Tailscale betekent een time-out meestal dat de machine (of de subnet
    // router die zijn netwerk in het tailnet aanbiedt) niet online is.
    return process.env.REGIOCHECKER_TAILNET_PROXY
      ? 'Ollama reageert niet via Tailscale. Staat de machine aan? Gaat het om een adres op een lokaal netwerk (zoals 192.168.x.x), dan moet ook de machine die dat netwerk in je tailnet aanbiedt (de subnet router) online zijn.'
      : 'Ollama niet bereikbaar (geen antwoord binnen de tijd)';
  }
  const proxyStatus = keten.map((f) => String(f.message).match(/Proxy response \((\d+)\)/)?.[1]).find(Boolean);
  if (proxyStatus) {
    return `Ollama niet bereikbaar via Tailscale (proxy gaf HTTP ${proxyStatus}). Is de Tailscale-container al gekoppeld aan je tailnet, en klopt de machinenaam of het 100.x-adres?`;
  }
  if (process.env.REGIOCHECKER_TAILNET_PROXY && /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(`${diepste.code} ${diepste.message}`) && keten.some((f) => /regiochecker-tailscale|1055/.test(String(f.message)))) {
    return 'De Tailscale-container is niet bereikbaar; draait hij? (docker compose ps)';
  }
  const via = process.env.REGIOCHECKER_TAILNET_PROXY ? ' via Tailscale' : '';
  return `Ollama niet bereikbaar${via} (${diepste.code || diepste.message})`;
}

async function vraag(url, pad, { body, tijd } = {}) {
  let antwoord;
  try {
    antwoord = await fetch(`${basis(url)}${pad}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      // Een antwoord van het model kan langer dan vijf minuten duren.
      dispatcher: tijd ? (tailnetDispatcher({ lang: true }) || langDispatcher()) : tailnetDispatcher(),
      signal: AbortSignal.timeout(tijd || VERBINDEN_MS),
    });
  } catch (fout) {
    const melding = onbereikbaar(fout);
    if (melding.includes('proxy gaf HTTP')) {
      const reden = await proxyReden(`${basis(url)}${pad}`);
      if (reden) throw new Error(vertaalProxyReden(reden, url));
    }
    throw new Error(melding);
  }
  const tekst = await antwoord.text();
  if (!antwoord.ok) {
    let melding = tekst;
    try { melding = JSON.parse(tekst).error || tekst; } catch { /* geen JSON */ }
    throw new Error(`Ollama gaf HTTP ${antwoord.status}: ${String(melding).slice(0, 300)}`);
  }
  try {
    return JSON.parse(tekst);
  } catch {
    throw new Error('Ollama gaf geen JSON terug; klopt de URL (poort 11434)?');
  }
}

// Voor de knop "Verbinding testen": versie en geïnstalleerde modellen.
export async function ollamaInfo(url) {
  const [versie, tags] = await Promise.all([vraag(url, '/api/version'), vraag(url, '/api/tags')]);
  return {
    versie: versie.version || null,
    modellen: (tags.models || []).map((m) => ({
      naam: m.name,
      grootte: m.size || null,
      parameters: m.details?.parameter_size || null,
    })).sort((a, b) => a.naam.localeCompare(b.naam)),
  };
}

// Kan dit model "nadenken" (qwen3, gemma4, deepseek-r1 …)? Zo ja, dan zetten we
// dat uit: anders schrijft het eerst duizenden tokens denkwerk, loopt het
// contextvenster vol en komt het nooit aan het JSON-antwoord toe (gezien met
// qwen3.6 na drie minuten). Alleen meesturen bij modellen die het kennen; andere
// modellen kunnen er een fout op geven. Per URL en model één keer opvragen.
const denkers = new Map();
async function kanDenken(url, model) {
  const sleutel = `${url}|${model}`;
  if (!denkers.has(sleutel)) {
    const info = await vraag(url, '/api/show', { body: { model } });
    denkers.set(sleutel, (info.capabilities || []).includes('thinking'));
  }
  return denkers.get(sleutel);
}

// Eén aanvraag tegelijk. Twee tegelijk (twee mensen die op "Met samenvatting"
// klikken, of een klik tijdens de mailronde) laten Ollama het model twee keer
// laden met een groot contextvenster; daar had de machine op 26 oktober 2026 te
// weinig geheugen voor ("failed to allocate buffer").
let wachtrij = Promise.resolve();
function eenTegelijk(werk) {
  const resultaat = wachtrij.then(werk, werk);
  wachtrij = resultaat.catch(() => {});
  return resultaat;
}

// Eén chatbeurt met een JSON-schema als `format` (structured outputs, Ollama
// 0.5 en nieuwer). Geeft het geparste JSON-object terug.
export function ollamaJson(opties) {
  return eenTegelijk(() => chat(opties));
}

async function chat({ url, model, systeem, vraag: vraagTekst, schema, context, vrijgeven = false }) {
  if (!model) throw new Error('Kies in de instellingen een Ollama-model');
  // Draait Ollama op de GPU-machine en wordt daar gegamed (Spelwacht), dan
  // nu niet: de weekmail zegt dan waarom er geen samenvatting is, de wachtrij
  // probeert het na het spel opnieuw.
  const spel = await spelOpOllama(url);
  if (spel) throw new Error(`${spelTekst(spel)}; samenvatten kan daarna weer`);
  const denken = await kanDenken(url, model);
  const antwoord = await vraag(url, '/api/chat', {
    tijd: ANTWOORD_MS,
    body: {
      model,
      stream: false,
      ...(denken ? { think: false } : {}),
      format: schema,
      // Op een GPU die ook Whisper draait: het model meteen weer uit het geheugen.
      ...(vrijgeven ? { keep_alive: 0 } : {}),
      messages: [
        { role: 'system', content: systeem },
        { role: 'user', content: vraagTekst },
      ],
      // Zonder num_ctx gebruikt Ollama een klein standaardcontextvenster en kapt
      // het de vraag stilletjes af; dan mist het model juist berichten.
      options: { temperature: 0.2, num_ctx: context },
    },
  });
  if (antwoord.done_reason === 'length') throw new Error('het antwoord van Ollama was afgekapt (contextvenster te klein?)');
  const inhoud = antwoord.message?.content;
  if (!inhoud) throw new Error('Ollama gaf een leeg antwoord');
  try {
    return { json: JSON.parse(inhoud), model: antwoord.model || model };
  } catch {
    throw new Error('Ollama gaf geen geldige JSON terug; probeer een groter model');
  }
}
