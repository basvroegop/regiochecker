// Tekst uit een pdf, met pdftotext (poppler). Gebruikt voor de weeklijsten van
// Súdwest-Fryslân en voor de inhoud van raadsstukken en Woo-besluiten.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const voerUit = promisify(execFile);

// layout: true behoudt kolommen (nodig voor tabellen); paginas: alleen de eerste
// N pagina's, zodat een rapport van 200 pagina's geen minuten kost.
export async function pdfNaarTekst(buffer, { layout = false, paginas } = {}) {
  const map = await mkdtemp(path.join(tmpdir(), 'regiochecker-'));
  const bestand = path.join(map, 'stuk.pdf');
  try {
    await writeFile(bestand, buffer);
    const opties = ['-enc', 'UTF-8'];
    if (layout) opties.push('-layout');
    if (paginas) opties.push('-l', String(paginas));
    const { stdout } = await voerUit('pdftotext', [...opties, bestand, '-'], { maxBuffer: 20 * 1024 * 1024, timeout: 60_000 });
    return stdout;
  } finally {
    await rm(map, { recursive: true, force: true });
  }
}

export const isPdf = (buffer) => buffer.subarray(0, 5).toString('latin1') === '%PDF-';
