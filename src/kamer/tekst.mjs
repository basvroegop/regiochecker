// Tekst uit een kamerstuk. De Tweede Kamer levert ongeveer de helft als pdf en
// de helft als Word (docx). Een docx is een zip; de tekst staat in
// word/document.xml. Andere formaten (oude .doc, afbeeldingen) slaan we over.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pdfNaarTekst, isPdf } from '../pdf.mjs';
import { ontsnap } from '../html.mjs';

const voerUit = promisify(execFile);
// Een begroting of een bijlage met tabellen kan honderden pagina's tekst zijn;
// meer dan dit indexeren levert niets meer op en maakt de database log.
export const MAX_TEKST = 1_500_000;

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function docxXmlNaarTekst(xml) {
  return ontsnap(String(xml)
    .replace(/<w:tab\/>/g, ' ')
    .replace(/<w:br\/>|<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

async function docxNaarTekst(buffer) {
  const map = await mkdtemp(path.join(tmpdir(), 'kamerstuk-'));
  const bestand = path.join(map, 'stuk.docx');
  try {
    await writeFile(bestand, buffer);
    const { stdout } = await voerUit('unzip', ['-p', bestand, 'word/document.xml'], { maxBuffer: 100 * 1024 * 1024, timeout: 60_000 });
    return docxXmlNaarTekst(stdout);
  } finally {
    await rm(map, { recursive: true, force: true });
  }
}

const isZip = (buffer) => buffer.subarray(0, 2).toString('latin1') === 'PK';

// Geeft de tekst, of null als het formaat niet te lezen is.
export async function stukNaarTekst(buffer, contentType) {
  let tekst = null;
  if (isPdf(buffer)) tekst = await pdfNaarTekst(buffer);
  else if (contentType === DOCX || isZip(buffer)) tekst = await docxNaarTekst(buffer);
  if (tekst === null) return null;
  // Witregels blijven staan: in een pdf zijn dat vaak de grenzen tussen alinea's.
  return tekst.replace(/[ \t]+/g, ' ').replace(/\n[ \t]*\n\s*/g, '\n\n').trim().slice(0, MAX_TEKST);
}
