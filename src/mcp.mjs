// Een kleine MCP-client (Model Context Protocol) over "streamable HTTP": één
// adres waar JSON-RPC-berichten heen gaan; het antwoord komt als JSON of als
// een server-sent-eventsstroom. Genoeg om tools op te vragen en aan te roepen,
// voor een bron die alleen via een MCP-server te lezen is (gehoord.de,
// src/gehoord.mjs). Het toegangstoken komt van de aanroeper en komt nooit in
// een foutmelding.

import { fetch } from 'undici';
import { controleerUrl, openbaarDispatcher } from './netwerk.mjs';

const PROTOCOL = '2025-06-18';
const TIJDLIMIET_MS = 60_000;

export class McpFout extends Error {
  constructor(bericht, { status = null, code = null } = {}) {
    super(bericht);
    this.status = status;
    this.code = code;
  }
}

// De berichten uit een server-sent-eventsstroom: elk `data:`-blok is JSON.
export function leesStroom(tekst) {
  const uit = [];
  for (const blok of String(tekst).split(/\r?\n\r?\n/)) {
    const data = blok.split(/\r?\n/).filter((r) => r.startsWith('data:')).map((r) => r.slice(5).trimStart()).join('\n');
    if (!data) continue;
    try {
      uit.push(JSON.parse(data));
    } catch { /* een keepalive of iets anders dan JSON */ }
  }
  return uit;
}

export class McpKlant {
  // `token`: een functie die een geldig toegangstoken geeft (vernieuwd zo nodig).
  constructor(adres, { token, naam = 'regiochecker', versie = '1.0' } = {}) {
    this.adres = adres;
    this.token = token;
    this.klant = { name: naam, version: versie };
    this.sessie = null;
    this.protocol = null;
    this.volgnummer = 0;
  }

  async post(bericht) {
    controleerUrl(this.adres);
    const koppen = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'User-Agent': `Regiochecker/1.0 (+https://github.com/basvroegop/regiochecker)`,
      ...(this.token ? { Authorization: `Bearer ${await this.token()}` } : {}),
      ...(this.sessie ? { 'Mcp-Session-Id': this.sessie } : {}),
      ...(this.protocol ? { 'MCP-Protocol-Version': this.protocol } : {}),
    };
    let antwoord;
    try {
      antwoord = await fetch(this.adres, {
        method: 'POST', headers: koppen, body: JSON.stringify(bericht),
        dispatcher: openbaarDispatcher, redirect: 'error', signal: AbortSignal.timeout(TIJDLIMIET_MS),
      });
    } catch (fout) {
      throw new McpFout(`${new URL(this.adres).host} niet bereikbaar: ${fout.cause?.code || fout.message}`);
    }
    const sessie = antwoord.headers.get('mcp-session-id');
    if (sessie) this.sessie = sessie;
    const tekst = await antwoord.text();
    if (!antwoord.ok) {
      let melding = '';
      try { melding = JSON.parse(tekst)?.error?.message || ''; } catch { /* geen JSON */ }
      throw new McpFout(`${new URL(this.adres).host} gaf HTTP ${antwoord.status}${melding ? `: ${melding.slice(0, 300)}` : ''}`, { status: antwoord.status });
    }
    if (!('id' in bericht)) return null; // een notificatie: 202 zonder inhoud
    const berichten = /text\/event-stream/i.test(antwoord.headers.get('content-type') || '') ? leesStroom(tekst) : [JSON.parse(tekst || 'null')];
    const eigen = berichten.find((b) => b && b.id === bericht.id);
    if (!eigen) throw new McpFout('De MCP-server gaf geen antwoord op het verzoek.');
    if (eigen.error) throw new McpFout(`MCP-fout: ${String(eigen.error.message || eigen.error.code).slice(0, 300)}`, { code: eigen.error.code });
    return eigen.result;
  }

  verzoek(method, params = {}) {
    return this.post({ jsonrpc: '2.0', id: ++this.volgnummer, method, params });
  }

  async open() {
    const r = await this.verzoek('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: this.klant });
    this.protocol = r?.protocolVersion || PROTOCOL;
    this.server = r?.serverInfo || null;
    this.instructies = r?.instructions || null;
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return r;
  }

  // Alle tools, ook over meerdere pagina's.
  async tools() {
    const uit = [];
    let cursor;
    for (let i = 0; i < 20; i++) {
      const r = await this.verzoek('tools/list', cursor ? { cursor } : {});
      uit.push(...(r?.tools || []));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return uit;
  }

  // Een tool aanroepen. Geeft { tekst, data }: de tekstdelen samen, en de
  // gestructureerde inhoud (of de tekst als JSON, als die dat is).
  async roep(naam, args = {}) {
    const r = await this.verzoek('tools/call', { name: naam, arguments: args });
    const tekst = (r?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r?.isError) throw new McpFout(`${naam}: ${tekst.slice(0, 300) || 'mislukt'}`);
    let data = r?.structuredContent ?? null;
    if (data === null && tekst) {
      try { data = JSON.parse(tekst); } catch { /* gewone tekst */ }
    }
    return { tekst, data };
  }

  async sluit() {
    if (!this.sessie) return;
    try {
      await fetch(this.adres, {
        method: 'DELETE',
        headers: { 'Mcp-Session-Id': this.sessie, ...(this.token ? { Authorization: `Bearer ${await this.token()}` } : {}) },
        dispatcher: openbaarDispatcher, signal: AbortSignal.timeout(10_000),
      });
    } catch { /* niet erg */ }
    this.sessie = null;
  }
}
