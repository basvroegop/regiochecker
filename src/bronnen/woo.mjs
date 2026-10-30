// Woo-publicaties op de platforms die gemeenten in Noord-Nederland gebruiken
// (overzicht van 28 oktober 2026). Elk platform heeft een eigen, openbare
// manier om de lijst op te halen; de pagina's zelf zijn apps.
//
//   edataloket   eData-loket (Midden-Drenthe, Westerveld, Hoogeveen, De Wolden):
//                /api/search, nieuwste eerst; een publicatie is een dossier
//   divault      Divault Woo-portaal (Oldambt): /woo/<organisatie>/diwoo_requests
//   publicaties  publicatieplatform met een "publicationbackend" (Stadskanaal)
//   stack        een openbare map bij STACK (Aa en Hunze, Assen): een map per verzoek
//   djuma        Djuma open-info (Midden-Groningen): alleen zoeken, dus een paar
//                brede zoekvragen over dit jaar, per dossier samengevoegd
//   mozard       Mozard zaakloket (Ameland, Vlieland, Tynaarlo): met een
//                sessiecookie de selectie, dan de regels
//   recentjson   een statische site met per jaar recent.json (Coevorden)

import { fetch } from 'undici';
import { controleerUrl, openbaarDispatcher } from '../netwerk.mjs';
import { haalJson } from '../ophalen.mjs';
import { platteTekst, ontsnap } from '../html.mjs';
import { leesDatum, lokaleDatum } from '../datum.mjs';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 Regiochecker/1.0';
const AANTAL = 50;
const datumVan = (iso) => (iso ? leesDatum(String(iso).slice(0, 10)) : null);
const kort = (t, n) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s;
};

// Een verzoek met eigen koppen en een cookie; geeft { status, kop, tekst }.
// Zonder automatische doorverwijzing: die volgen we zelf, met de cookies erbij.
async function verzoek(url, { methode = 'GET', koppen = {}, lijf, koekjes } = {}) {
  let adres = url;
  for (let hop = 0; hop < 6; hop++) {
    controleerUrl(adres);
    const antwoord = await fetch(adres, {
      method: methode,
      headers: { 'User-Agent': UA, Accept: 'application/json, text/html;q=0.9, */*;q=0.8', ...koppen, ...(koekjes?.size ? { Cookie: [...koekjes].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) },
      body: lijf,
      redirect: 'manual',
      dispatcher: openbaarDispatcher,
      signal: AbortSignal.timeout(45_000),
    });
    for (const c of antwoord.headers.getSetCookie?.() || []) {
      const [paar] = c.split(';');
      const i = paar.indexOf('=');
      if (i > 0 && koekjes) koekjes.set(paar.slice(0, i).trim(), paar.slice(i + 1).trim());
    }
    const naar = antwoord.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(antwoord.status) && naar) {
      await antwoord.body?.cancel();
      adres = new URL(naar, adres).href;
      methode = 'GET';
      lijf = undefined;
      continue;
    }
    const tekst = await antwoord.text();
    if (!antwoord.ok) throw new Error(`${new URL(adres).hostname} gaf HTTP ${antwoord.status}`);
    return { status: antwoord.status, kop: antwoord.headers, tekst, adres };
  }
  throw new Error('Te veel doorverwijzingen');
}

// ---------- eData-loket ----------

export function leesEdataloket(data, basis) {
  return (data?.hits || []).map((h) => ({
    sleutel: h.id,
    titel: kort(h.name || h.subject, 300),
    url: `${basis}/dossier/${h.id}`,
    datum: datumVan(h.publicationDate),
    tekst: h.description && h.description !== h.name ? kort(h.description, 600) : null,
    soortStuk: h.category?.description || null,
  })).filter((i) => i.sleutel && i.titel);
}

export async function haalEdataloket(bron) {
  const basis = new URL(bron.url).origin;
  return leesEdataloket(await haalJson(`${basis}/api/search?sort=publicationDate:desc&page=1&size=${AANTAL}`), basis);
}

// ---------- Divault ----------

export function leesDivault(data) {
  return (data?.records || []).map((r) => {
    const d = r.Document?.DiWoo || {};
    const titel = d.titelcollectie?.officieleTitel || d.aggregatiekenmerk;
    return {
      sleutel: d.aggregatiekenmerk || r.loc,
      titel: kort(titel, 300),
      url: r.loc ? encodeURI(r.loc) : null,
      datum: datumVan(r.divault_publication_date || d.creatiedatum),
      tekst: d.omschrijvingen?.map?.((o) => o.omschrijving).filter(Boolean).join(' ') || null,
      soortStuk: d.classificatiecollectie?.informatiecategorieen?.[0]?.informatiecategorie || null,
    };
  }).filter((i) => i.sleutel && i.titel);
}

export async function haalDivault(bron) {
  const basis = new URL(bron.url).origin;
  const q = new URLSearchParams({ ...(bron.categorie ? { category: bron.categorie } : {}), page_size: String(AANTAL), page_nr: '1', sort: 'publication_date.desc' });
  return leesDivault(await haalJson(`${basis}/woo/${encodeURIComponent(bron.organisatie)}/diwoo_requests?${q}`));
}

// ---------- publicatieplatform (publicationbackend) ----------

export function leesPublicaties(data, basis) {
  return (data?.items || []).map((p) => ({
    sleutel: p.id,
    titel: kort(p.title, 300),
    url: p.isExternalUrl && p.externalUrl ? p.externalUrl : `${basis}/publication/${p.id}`,
    datum: datumVan(p.publicationDate),
    tekst: [p.accompanyingText, p.totalDocuments ? `${p.totalDocuments} documenten.` : null].filter(Boolean).join(' ') || null,
    soortStuk: p.category || null,
  })).filter((i) => i.sleutel && i.titel);
}

export async function haalPublicaties(bron) {
  const basis = new URL(bron.url).origin;
  const q = new URLSearchParams({ SubDomainId: bron.subdomein, PageNumber: '1', PageSize: String(AANTAL), PropertyName: 'publicationDate', Ascending: 'false' });
  return leesPublicaties(await haalJson(`${basis}/publicationbackend/Publication/list?${q}`), basis);
}

// ---------- STACK (openbare map) ----------

// "2025-01-28 omgevingsvergunning Marwijksoord 2" → datum en titel.
export function leesStack(nodes, pagina) {
  return (nodes || []).map((n) => {
    const m = /^(\d{4}-\d{2}-\d{2})\s+(.*)$/.exec(n.name || '');
    return {
      sleutel: String(n.id),
      titel: kort(m ? m[2] : n.name, 300),
      url: pagina,
      datum: m ? m[1] : n.created ? lokaleDatum(new Date(n.created * 1000)) : null,
      tekst: n.dir && n.childCount ? `Map met ${n.childCount} ${n.childCount === 1 ? 'bestand' : 'bestanden'}.` : null,
    };
  }).filter((i) => i.titel);
}

export async function haalStack(bron) {
  const u = new URL(bron.url);
  const code = u.pathname.split('/').filter(Boolean)[1];
  if (!code) throw new Error('Geen deelcode in het STACK-adres');
  const api = `${u.origin}/api/v2/share/${encodeURIComponent(code)}`;
  const sessie = await verzoek(api, { methode: 'POST', koppen: { 'Content-Type': 'application/json', 'x-setcookie': 'true' }, lijf: '{}' });
  const token = sessie.kop.get('x-sharetoken');
  if (!token) throw new Error('STACK gaf geen sessie');
  const koppen = { 'x-sharetoken': token };
  const map = JSON.parse((await verzoek(api, { koppen })).tekst);
  const lijst = JSON.parse((await verzoek(`${api}/nodes?limit=${AANTAL}&offset=0&orderBy=mtime&reverse=true&parentID=${map.id}`, { koppen })).tekst);
  return leesStack(lijst.nodes, bron.url);
}

// ---------- Djuma open-info ----------

const ZOEK = ['woo', 'besluit', 'verzoek', 'rapport'];
const zonderMarkering = (t) => String(t || '').replace(/\{\[\/?hl\]\}/g, '');
const ALGEMEEN = /^(woo|wob)[- ]?(verzoek|besluit)( geanonimiseerd)?$|^(inventaris(lijst)?|bijlage|besluit|verzoek)$/i;

// Een dossier: de beste titel, de laatste datum, en de stukken erin.
export function leesDjuma(hits, basis) {
  const dossiers = new Map();
  for (const h of hits) {
    const sleutel = h.dossier || h.reference;
    const titel = zonderMarkering(h.title).replace(/_/g, ' ').trim();
    const d = dossiers.get(sleutel) || { sleutel, titels: [], datum: null, soort: h.categorie?.trim() || null };
    if (titel && !d.titels.includes(titel)) d.titels.push(titel);
    const datum = datumVan(h.datumActueel);
    if (datum && (!d.datum || datum > d.datum)) d.datum = datum;
    dossiers.set(sleutel, d);
  }
  return [...dossiers.values()].map((d) => {
    const titel = d.titels.find((t) => !ALGEMEEN.test(t)) || d.titels[0] || 'Woo-dossier';
    return {
      sleutel: String(d.sleutel),
      titel: kort(ALGEMEEN.test(titel) ? `${titel} (dossier ${d.sleutel})` : titel, 300),
      url: `${basis}/o/search?q=${encodeURIComponent(d.sleutel)}`,
      datum: d.datum,
      tekst: d.titels.length > 1 ? `Stukken: ${d.titels.slice(0, 8).join('; ')}.` : null,
      soortStuk: d.soort,
    };
  });
}

export async function haalDjuma(bron, { nu = new Date() } = {}) {
  const basis = new URL(bron.url).origin;
  const jaren = [...new Set([nu.getFullYear(), new Date(nu - 31 * 86400000).getFullYear()])].map(String);
  const hits = [];
  for (const zoek of ZOEK) {
    const r = await verzoek(`${basis}/api/openInfo/search`, {
      methode: 'POST',
      koppen: { 'Content-Type': 'application/json', 'djuma-app': 'eloket', Origin: basis },
      lijf: JSON.stringify({ searchQuery: zoek, pageSize: AANTAL, pageNumber: 1, dossierNumber: null, yearsFilter: jaren, categoriesFilter: [], themesFilter: [] }),
    });
    hits.push(...(JSON.parse(r.tekst)?.data?.documentSearchHits || []));
  }
  return leesDjuma(hits, basis);
}

// ---------- Mozard zaakloket ----------

// Regels van een Mozard-selectie, uit getObjectRegels of rechtstreeks uit de
// pagina: <a href="!suite92.scherm1007?mObj=…"> … <h3>2023-09-07 - Woo-verzoeken -
// Woo-verzoek beleidsinformatie</h3> of <h3>Woo-verzoek Holland Casino - 19-07-2024</h3>.
export function leesMozardRegels(html, basis) {
  const uit = [];
  const gezien = new Set();
  for (const m of String(html).matchAll(/<a\b[^>]*href="([^"]*scherm1007\?mObj=(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) {
    if (gezien.has(m[2])) continue;
    gezien.add(m[2]);
    const regel = platteTekst(/<h\d[^>]*>([\s\S]*?)<\/h\d>/.exec(m[3])?.[1] || m[3]);
    if (!regel) continue;
    const iso = /^(\d{4}-\d{2}-\d{2})\s*-\s*/.exec(regel);
    const nl = /\s*-\s*(\d{1,2}-\d{1,2}-\d{4})$/.exec(regel);
    const titel = regel.replace(iso?.[0] || '', '').replace(nl?.[0] || '', '').replace(/^Woo-(verzoeken|stukken)\s*-\s*/i, '').trim();
    uit.push({
      sleutel: m[2],
      titel: kort(titel || regel, 300),
      url: new URL(ontsnap(m[1]), basis).href,
      datum: iso ? iso[1] : nl ? leesDatum(nl[1]) : null,
    });
  }
  return uit;
}

export async function haalMozard(bron) {
  const koekjes = new Map();
  const start = await verzoek(bron.url, { koekjes, koppen: { Accept: 'text/html' } });
  const basis = start.adres.slice(0, start.adres.indexOf('/mozard/') + 8);
  // Sommige registraties zetten de regels meteen in de pagina (Tynaarlo).
  const selectie = /[?&]mSelod=(\d+)/.exec(start.adres)?.[1];
  if (!selectie) return leesMozardRegels(start.tekst, basis);
  const ids = JSON.parse((await verzoek(`${basis}!suite16.getObjectbakResultaat?mSelod=${selectie}&mMaxid=0&mNch=${Date.now()}`, { koekjes })).tekst)?.r || [];
  if (!ids.length) return leesMozardRegels(start.tekst, basis);
  const regels = JSON.parse((await verzoek(`${basis}!suite16.getObjectRegels?mObjecten=,${ids.slice(0, AANTAL).map((r) => r.obj).join(',')}&mNch=${Date.now()}&mSelod=${selectie}`, { koekjes })).tekst);
  return leesMozardRegels((regels?.objn || []).flatMap((o) => (o.htmlcd || []).map((x) => x.h)).join(' '), basis);
}

// ---------- statische site met recent.json per jaar ----------

// [{ date, title, url: "/woo-publicaties/2026/woo-verzoeken/<dossier>/<stuk>.html" }]:
// per dossier één stuk.
export function leesRecentJson(lijst, basis) {
  const dossiers = new Map();
  for (const d of lijst || []) {
    const pad = String(d.url || '');
    const m = /\/woo-verzoeken\/([^/]+)\//.exec(pad) || /\/([^/]+)\/[^/]+$/.exec(pad);
    const sleutel = m?.[1] || pad;
    const bestaand = dossiers.get(sleutel) || { sleutel, stukken: [], datum: null, url: new URL(pad.replace(/[^/]+$/, ''), basis).href };
    bestaand.stukken.push(String(d.title || '').trim());
    if (d.date && (!bestaand.datum || d.date > bestaand.datum)) bestaand.datum = d.date;
    dossiers.set(sleutel, bestaand);
  }
  return [...dossiers.values()].map((d) => {
    const naam = d.sleutel.replace(/-\d+-\d{4}$/, '').replace(/-/g, ' ');
    return {
      sleutel: d.sleutel,
      titel: kort(naam.charAt(0).toUpperCase() + naam.slice(1), 300),
      url: d.url,
      datum: datumVan(d.datum),
      tekst: `Stukken: ${d.stukken.slice(0, 8).join('; ')}.`,
    };
  });
}

export async function haalRecentJson(bron, { nu = new Date() } = {}) {
  const basis = new URL(bron.url).origin;
  const uit = [];
  for (const jaar of new Set([nu.getFullYear(), new Date(nu - 31 * 86400000).getFullYear()])) {
    try {
      uit.push(...leesRecentJson(await haalJson(`${basis}/woo-publicaties/${jaar}/recent.json`), basis));
    } catch (fout) {
      if (jaar === nu.getFullYear() && !/HTTP 404/.test(fout.message)) throw fout;
    }
  }
  return uit;
}
