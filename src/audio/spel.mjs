// Wordt er gegamed op de GPU-machine? Daar draaien de Whisper-worker en Ollama,
// en daar draait ook Spelwacht (scripts/windows/spelwacht.ps1). Start er een
// spel, dan stopt Spelwacht de worker meteen (ook midden in een deel) en
// antwoordt het zelf op de poort van de worker: /health zegt dan
// { status: 'paused', reason: 'game' } (zie spelUit in worker.mjs). Zolang dat
// zo is, begint de Regiochecker niets dat die GPU gebruikt: geen transcriptie,
// stemmen of namen (src/audio/verwerking.mjs) en geen samenvatting via Ollama
// als Ollama op dezelfde machine draait (src/ollama.mjs).

import { worker, spelUit } from './worker.mjs';

// Hooguit eens per vijftien seconden navragen; de wachtrij vraagt het vaak.
const VERS_MS = 15_000;
let opslagRef = null;
let laatst = { tijd: 0, spel: null };

// Bij het starten (src/dienst.mjs), en in tests.
export function koppelSpel(opslag) {
  opslagRef = opslag;
  laatst = { tijd: 0, spel: null };
}

// Het spel ({ naam, sinds }) of null. Is de worker niet bereikbaar, dan weten
// we van geen spel: dat is een gewone storing.
export async function spelBezig({ vers = false } = {}) {
  const w = opslagRef && worker(opslagRef.instellingen);
  if (!w) return null;
  if (!vers && Date.now() - laatst.tijd < VERS_MS) return laatst.spel;
  let spel = null;
  try {
    spel = spelUit(await w.gezond({ tijd: 3000 }));
  } catch { /* niet bereikbaar */ }
  laatst = { tijd: Date.now(), spel };
  return spel;
}

// Draait Ollama (`url`) op dezelfde machine als de worker? Dan het spel daar.
export async function spelOpOllama(url) {
  const w = opslagRef && worker(opslagRef.instellingen);
  if (!w) return null;
  let ollama;
  let gpu;
  try {
    ollama = new URL(url).hostname;
    gpu = new URL(w.basis).hostname;
  } catch {
    return null;
  }
  return ollama === gpu ? spelBezig() : null;
}

export const spelTekst = (spel) => `Er wordt gegamed op de GPU-machine${spel?.naam ? ` (${spel.naam})` : ''}`;
