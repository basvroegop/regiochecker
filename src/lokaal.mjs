// De API aanroepen op de server zelf, zonder het wachtwoord te kennen: een
// sessie van een minuut, ondertekend met het geheim uit de datamap (alleen
// leesbaar in de container en voor root). Voor beheer vanaf de commandoregel,
// zoals de audio pauzeren voor een deploy.
//
//   docker exec regiochecker node src/lokaal.mjs GET /api/beheer/audio
//   docker exec regiochecker node src/lokaal.mjs PUT /api/beheer/audio '{"gepauzeerd":true}'

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sessies, sessieGeheim, KOEKJE } from './inloggen.mjs';

const [methode = 'GET', pad = '/api/ik', lijf] = process.argv.slice(2);
const map = process.env.REGIOCHECKER_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const koekje = `${KOEKJE}=${new Sessies(sessieGeheim(map)).maak(60_000)}`;
const antwoord = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}${pad}`, {
  method: methode,
  headers: { Cookie: koekje, ...(lijf ? { 'Content-Type': 'application/json' } : {}) },
  body: lijf,
});
console.log(await antwoord.text());
if (!antwoord.ok) process.exitCode = 1;
