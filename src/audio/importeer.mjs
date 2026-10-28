// Het archief van de losse audioscraper overnemen (oktober 2026): projecten
// worden audiobronnen, afleveringen houden hun transcript, sprekers en namen,
// en telefoonnummers met hun beoordelingen gaan mee. Mediabestanden niet:
// audioscraper bewaarde die toch niet na het transcriberen.
//
// Een project krijgt als bereik de regio waarvan de naam in de projectnaam of
// het adres staat (zoals "Gemeente Opsterland"); anders landelijk. Dat is na
// het importeren aan te passen bij Beheer › Bronnen.
//
// Alles komt binnen als nulmeting: in de feed op de eigen datum, niet als
// "nieuw vandaag". Wat al eerder is geïmporteerd, wordt overgeslagen.

import { alleRegios, alleBronnen, maakId } from '../register.mjs';
import { normaliseer } from '../termen.mjs';

const SOORT = {
  companywebcast: 'raadsvergadering', notubiz: 'raadsvergadering', gemeenteoplossingen: 'raadsvergadering',
  youtube: 'youtube', 'youtube-videos': 'youtube', 'youtube-streams': 'youtube', 'youtube-shorts': 'youtube', 'youtube-playlist': 'youtube', video: 'youtube',
  rss: 'podcast',
};
const VORM = { youtube: 'youtube', rss: 'rss', meeting: 'vergadering' };
const STATUS = { queued: 'wacht', downloading: 'wacht', transcribing: 'wacht', transcribed: 'getranscribeerd', analyzing: 'getranscribeerd', completed: 'klaar', failed: 'mislukt' };
const BEOORDELING = { confirmed: 'bevestigd', rejected: 'afgewezen' };

function regioVoor(regios, tekst) {
  const plat = normaliseer(tekst).replace(/[^a-z0-9]+/g, ' ');
  const plat2 = plat.replaceAll(' ', '');
  return regios.find((r) => {
    const naam = normaliseer(r.naam).replace(/[^a-z0-9]+/g, ' ').trim();
    return plat.includes(naam) || plat2.includes(naam.replaceAll(' ', ''));
  }) || null;
}

const iso = (seconden) => (seconden ? new Date(seconden * 1000).toISOString() : null);

export async function importeerAudioscraper({ opslag, adb }, pad) {
  const { DatabaseSync } = await import('node:sqlite');
  const bron = new DatabaseSync(pad, { readOnly: true });
  const heeft = (tabel) => Boolean(bron.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tabel));
  const regios = alleRegios(opslag);
  const uit = { bronnen: 0, afleveringen: 0, overgeslagen: 0, nummers: 0, beoordelingen: 0 };
  const bronVan = new Map();
  const ids = new Set(alleBronnen(opslag).map((b) => b.id));

  for (const p of bron.prepare('SELECT * FROM sources ORDER BY priority, created DESC').all()) {
    const bestaand = opslag.bronnen.find((b) => b.audio && b.url === p.url);
    if (bestaand) {
      bronVan.set(p.id, bestaand);
      continue;
    }
    const soort = SOORT[p.kind];
    if (!soort) continue;
    const label = p.name || p.title || new URL(p.url).hostname;
    const regio = regioVoor(regios, `${p.name || ''} ${p.title || ''} ${p.url}`);
    const id = maakId(`${regio?.id || 'landelijk'}-${label}`, ids);
    ids.add(id);
    const nieuw = {
      id, soort, bereik: regio ? 'regio' : 'landelijk', ...(regio ? { regio: regio.id } : {}), type: 'audio', url: p.url,
      label, naam: regio ? `${regio.naam} · ${label}` : label, aangemaakt: iso(p.created) || new Date().toISOString(),
      audio: {
        kind: p.kind, eersteImport: p.initial_limit ?? 3, actief: p.enabled !== 0, geinitialiseerd: p.initialized === 1,
        prioriteit: p.priority ?? 0, titel: p.title || null,
      },
      geimporteerd: 'audioscraper',
    };
    opslag.bronnen.push(nieuw);
    bronVan.set(p.id, nieuw);
    if (p.checked) {
      opslag.status.bronnen[id] = { ok: !p.error, fout: p.error || null, laatsteRonde: iso(p.checked), laatsteSucces: p.error ? null : iso(p.checked), bezig: false };
    }
    uit.bronnen++;
  }

  const zet = adb.db.prepare(`INSERT OR IGNORE INTO afleveringen (id, bron, extern, soort, vorm, titel, url, media_url, auteur, gepubliceerd, gepubliceerd_op, duur, afbeelding,
      status, stap, pogingen, opnieuw_op, fout, transcript, segmenten, taal, entiteiten, entiteit_delen, sprekers_gevraagd, spreker_fout, nulmeting, eerst_gezien, aangemaakt, bijgewerkt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`);
  for (const e of bron.prepare('SELECT * FROM episodes').iterate()) {
    const b = bronVan.get(e.source_id);
    if (!b) {
      uit.overgeslagen++;
      continue;
    }
    const status = STATUS[e.status] || 'wacht';
    const r = zet.run(e.id, b.id, e.external_id, b.soort, VORM[e.kind] || 'rss', e.title || 'Aflevering', e.url, e.media_url, e.author,
      e.published, e.published_at, e.duration, e.thumbnail_url,
      // Wat halverwege was, begint opnieuw aan die stap.
      e.transcript ? (status === 'wacht' ? 'getranscribeerd' : status) : (status === 'mislukt' ? 'mislukt' : 'wacht'),
      e.stage, e.attempts || 0, e.retry_at || 0, e.error, e.transcript, e.segments, e.language, e.entities, e.entity_chunks,
      e.speaker_requested || 0, e.speaker_error,
      e.transcript ? iso(e.published_at || e.created) : null, e.created, e.updated);
    if (r.changes) uit.afleveringen++;
  }

  if (heeft('seen')) {
    const gezien = adb.db.prepare('INSERT OR IGNORE INTO audio_gezien (bron, extern) VALUES (?, ?)');
    for (const s of bron.prepare('SELECT * FROM seen').iterate()) {
      const b = bronVan.get(s.source_id);
      if (b) gezien.run(b.id, s.external_id);
    }
  }

  if (heeft('phone_mentions')) {
    const zetNummer = adb.db.prepare('INSERT OR IGNORE INTO telefoon_vermeldingen (nummer, aflevering, segment, start, ruw, weergave, categorie, context) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const m of bron.prepare('SELECT * FROM phone_mentions').iterate()) {
      if (zetNummer.run(m.phone, m.episode_id, m.segment, m.start, m.raw, m.display, m.category, m.context).changes) uit.nummers++;
    }
  }
  if (heeft('phone_verifications')) {
    for (const v of bron.prepare('SELECT * FROM phone_verifications').iterate()) {
      adb.zetVerificatie(v.phone, { bedrijf: v.company, kvk: v.kvk_number, locatie: v.location, bronUrl: v.source_url, bronLabel: v.source_label, gecontroleerd: v.verified });
    }
  }
  if (heeft('phone_attributions')) {
    const zetK = adb.db.prepare(`INSERT OR IGNORE INTO telefoon_koppelingen (nummer, staat, soort, relatie, label, omschrijving, zekerheid, bewijs, aflevering, segment, bron, beoordeeld)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const k of bron.prepare('SELECT * FROM phone_attributions').iterate()) {
      const staat = BEOORDELING[k.state];
      if (staat && zetK.run(k.phone, staat, k.subject_type, k.relation, k.label, k.description, k.confidence, k.evidence, k.episode_id, k.segment, k.source === 'manual' ? 'handmatig' : k.source, k.reviewed).changes) uit.beoordelingen++;
    }
  }
  if (heeft('phone_context_analyses')) {
    const zetC = adb.db.prepare(`INSERT OR IGNORE INTO telefoon_context (nummer, aflevering, segment, status, pogingen, soort, relatie, label, omschrijving, zekerheid, bewijs, model, geanalyseerd)
      VALUES (?, ?, ?, 'klaar', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const c of bron.prepare("SELECT * FROM phone_context_analyses WHERE status = 'completed'").iterate()) {
      zetC.run(c.phone, c.episode_id, c.segment, c.attempts || 0, c.subject_type, c.relation, c.label, c.description, c.confidence, c.evidence, c.model, c.analyzed);
    }
  }
  if (heeft('app_settings') && bron.prepare("SELECT value FROM app_settings WHERE key = 'processing_paused'").get()?.value === '1') adb.zetStaat('gepauzeerd', '1');

  bron.close();
  opslag.bewaar('bronnen', 'status');
  return uit;
}
