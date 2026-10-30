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
import { haalHtmlLijst } from './htmllijst.mjs';
import { haalIbabsAgenda } from './ibabsagenda.mjs';
import * as woo from './woo.mjs';

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
  'html-lijst': haalHtmlLijst,
  'ibabs-agenda': haalIbabsAgenda,
  edataloket: woo.haalEdataloket,
  divault: woo.haalDivault,
  publicaties: woo.haalPublicaties,
  stack: woo.haalStack,
  djuma: woo.haalDjuma,
  mozard: woo.haalMozard,
  recentjson: woo.haalRecentJson,
};

// `opties.eersteKeer`: de allereerste ronde van de bron (een archief kan dan verder terug).
export async function haalBron(bron, opties = {}) {
  const haal = TYPES[bron.type];
  if (!haal) throw new Error(`Onbekend brontype "${bron.type}"`);
  return haal(bron, opties);
}
