// Eén kamerronde: metadata bijwerken en teksten ophalen. Loopt los van de
// gemeentebronnen (elk half uur), zodat een lange inhaalslag de mail niet
// ophoudt. Nooit twee tegelijk. De meldingen gaan daarna (src/dienst.mjs).

import { synchroniseer, haalTeksten } from './ophalen.mjs';

let lopend = null;

export function kamerRonde(opslag, kdb, voortgang) {
  if (lopend) return lopend;
  lopend = (async () => {
    const begin = Date.now();
    const uitkomst = {};
    try {
      voortgang?.({ tekst: 'kamerstukken: metadata bijwerken' });
      uitkomst.metadata = await synchroniseer(kdb);
      uitkomst.teksten = await haalTeksten(kdb, { voortgang });
      uitkomst.ok = true;
    } catch (fout) {
      uitkomst.ok = false;
      uitkomst.fout = fout.message;
      // Alleen de eerste mislukte ronde in het logboek, niet elk half uur opnieuw.
      if (opslag.status.kamer?.ok !== false) opslag.log({ soort: 'bronfout', tekst: `Kamerstukken: ${fout.message}` });
    }
    opslag.status.kamer = { ...uitkomst, tijd: new Date().toISOString(), duurMs: Date.now() - begin };
    opslag.bewaar('status');
    return uitkomst;
  })().finally(() => { lopend = null; });
  return lopend;
}
