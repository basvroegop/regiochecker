import { haalRss } from './rss.mjs';
import { haalIbabs } from './ibabs.mjs';
import { haalNotubiz } from './notubiz.mjs';
import * as smallingerland from './smallingerland.mjs';
import * as swf from './sudwestfryslan.mjs';
import { haalGppWoo } from './gppwoo.mjs';
import { haalBwBesluiten } from './groningen.mjs';
import { haalAardbevingen, haalWaarschuwingen, haalUitspraken, haalRansomware } from './signalen.mjs';
import { haalFiles, haalStoringen } from './verkeer.mjs';
import { haalBekendmakingen } from './provincie.mjs';

// type in src/regios.mjs → functie die een lijst items teruggeeft.
export const TYPES = {
  rss: haalRss,
  ibabs: haalIbabs,
  'notubiz-ingekomen': haalNotubiz,
  'smallingerland-nieuws': smallingerland.haalNieuws,
  'smallingerland-woo': smallingerland.haalWoo,
  'swf-nieuws': swf.haalNieuws,
  'swf-ingekomen': swf.haalIngekomen,
  'swf-woo': swf.haalWoo,
  'gpp-woo': haalGppWoo,
  'groningen-bw-besluiten': haalBwBesluiten,
  'knmi-aardbevingen': haalAardbevingen,
  'knmi-waarschuwingen': haalWaarschuwingen,
  'raad-van-state': haalUitspraken,
  ransomware: haalRansomware,
  'ndw-files': haalFiles,
  'ns-storingen': haalStoringen,
  'provincie-bekendmakingen': haalBekendmakingen,
};

// `opties.eersteKeer`: de allereerste ronde van de bron (een archief kan dan verder terug).
export async function haalBron(bron, opties = {}) {
  const haal = TYPES[bron.type];
  if (!haal) throw new Error(`Onbekend brontype "${bron.type}"`);
  return haal(bron, opties);
}
