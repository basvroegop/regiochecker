// Verbinding met machines in het tailnet (Ollama, de Whisper-worker). Deze server
// zit zelf niet in het tailnet; daarvoor draait naast de dienst een
// Tailscale-container (zie docker-compose.yml) met een HTTP-proxy. Alleen het
// verkeer naar die machines gaat door die proxy (REGIOCHECKER_TAILNET_PROXY);
// de gemeentesites niet.

import net from 'node:net';
import { Agent, ProxyAgent } from 'undici';

// Gewone verzoeken, en verzoeken die lang op een antwoord wachten: een
// transcriptie van een raadsvergadering van drie uur, of een samenvatting door
// een lokaal model. undici geeft standaard na vijf minuten zonder antwoord op;
// de lange variant wacht zo lang als de aanvrager zelf toestaat.
const agenten = new Map();
export function tailnetDispatcher({ lang = false } = {}) {
  const adres = process.env.REGIOCHECKER_TAILNET_PROXY;
  if (!adres) return undefined;
  const sleutel = `${adres}|${lang}`;
  if (!agenten.has(sleutel)) {
    agenten.set(sleutel, new ProxyAgent(lang ? { uri: adres, headersTimeout: 0, bodyTimeout: 0 } : adres));
  }
  return agenten.get(sleutel);
}

// Zonder Tailscale-proxy, maar wel met lang geduld.
let direct = null;
export function langDispatcher() {
  direct ||= new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  return direct;
}

// Bij een mislukte tunnel zet de Tailscale-proxy de reden in de kop
// Tailscale-Connect-Error, maar undici geeft alleen de statuscode door. Dus
// vragen we het zelf nog een keer, kaal, en lezen we die kop.
export function proxyReden(doelUrl) {
  return new Promise((klaar) => {
    let adres;
    let doel;
    try {
      adres = new URL(process.env.REGIOCHECKER_TAILNET_PROXY);
      const u = new URL(doelUrl);
      doel = `${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`;
    } catch {
      return klaar(null);
    }
    const sok = net.connect(Number(adres.port) || 80, adres.hostname);
    const stop = (reden) => { sok.destroy(); klaar(reden); };
    sok.setTimeout(10_000, () => stop(null));
    sok.on('error', () => stop(null));
    sok.on('connect', () => sok.write(`CONNECT ${doel} HTTP/1.1\r\nHost: ${doel}\r\n\r\n`));
    sok.on('data', (d) => stop(String(d).match(/Tailscale-Connect-Error: ([^\r\n]+)/i)?.[1] || null));
  });
}
