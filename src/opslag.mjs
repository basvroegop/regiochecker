// Alle toestand staat in een paar JSON-bestanden in data/. Klein genoeg om in
// het geheugen te houden; elke wijziging wordt meteen weggeschreven (eerst naar
// een tijdelijk bestand, dan hernoemd, zodat een crash nooit een half bestand
// achterlaat). Back-up = de map data/ kopiëren.
//
//   instellingen.json  SMTP, Claude-sleutel, Ollama, de Whisper-worker, en
//                      het standaardschema voor de weekmail van nieuwe gebruikers
//   gebruikers.json    journalisten en beheerders: rol, titel (LC/DVHN), regio's,
//                      weekmail (src/gebruikers.mjs)
//   regios.json        per regio de sleutelwoorden en welke landelijke bronnen
//                      gelden, plus regio's die een beheerder zelf toevoegde
//   bronnen.json       bronnen die een beheerder via de webUI toevoegde
//                      (src/register.mjs; de ingebouwde staan in src/regios.mjs)
//   items.json         alles wat de bronnen ooit opleverden, met eersteGezien
//   status.json        per bron de laatste ronde, de laatste mailronde en
//                      planningVanaf (zie planning.mjs)
//   logboek.json       verzonden mails en fouten (laatste 300)
//   samenvattingen.json  cache van Claude-/Ollama-antwoorden, zodat twee
//                      verslaggevers met dezelfde regio geen dubbele aanroep kosten
//   meldingen.json     directe meldingen op zoektermen, per gebruiker (src/meldingen.mjs)
//   kamerstukken.sqlite  de kamerstukken zelf, met zoekindex (src/kamer/db.mjs)
//   regiochecker.sqlite  per gebruiker gelezen/bewaard/notitie, en de afleveringen
//                      uit audioscraper (src/feeddb.mjs)
//
// Tot oktober 2026 stonden de ontvangers in ontvangers.json en de termen voor
// kamerstukken in kamertermen.json; src/migratie.mjs zet die eenmalig om.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { migreer } from './migratie.mjs';

export const STANDAARD_INSTELLINGEN = {
  // Weekmail voor nieuwe gebruikers: tijd (24-uurs) en dagen (1 = maandag …
  // 7 = zondag). Elke gebruiker kan het daarna zelf aanpassen bij Meldingen.
  mailTijd: '07:00',
  mailDagen: [1],
  // Ook een mail sturen als er niets nieuws is ("niets gevonden").
  mailBijNiets: false,
  controleIntervalMinuten: 60,
  smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '' },
  // Wie de samenvatting per gemeente schrijft: 'claude', 'ollama' of 'uit'.
  samenvattingVia: 'claude',
  claude: { apiKey: '', model: 'claude-opus-5-5' },
  // Eigen Ollama-installatie, bereikbaar via Tailscale (zie src/ollama.mjs).
  // maxContext: grootste contextvenster (tokens) dat we het model laten openen.
  // modelOpnames: voor de samenvattingen van opnames (lange transcripten). Een
  // klein model dat helemaal op de GPU past, is daar tientallen keren sneller
  // dan een groot dat deels op de processor draait. Leeg: hetzelfde als `model`.
  ollama: { url: '', model: '', maxContext: 32768, modelOpnames: '' },
  // Audio en video (src/audio/): de Whisper-worker in het thuisnetwerk doet
  // transcriptie, stemmen en namen; bereikbaar via de Tailscale-proxy als
  // viaTailnet aan staat. Het token mag ook in WORKER_TOKEN, het adres in WORKER_URL.
  // bewaarAudio: 'vergaderingen' (om terug te luisteren), 'alles' of 'niets';
  // bewaarDagen: daarna gaat ook bewaarde audio weg (het transcript blijft).
  // namenZoeken: personen, plaatsen en organisaties laten zoeken door het
  // taalmodel van de worker. Standaard uit: het kost veel GPU-tijd, en namen van
  // sprekers komen uit de gegevens van het vergaderplatform.
  audio: { workerUrl: '', workerToken: '', viaTailnet: true, bewaarAudio: 'vergaderingen', bewaarDagen: 180, namenZoeken: false },
};

const BESTANDEN = {
  instellingen: {},
  gebruikers: [],
  regios: {},
  bronnen: [],
  items: {},
  status: { bronnen: {}, laatsteVerzamelronde: null, laatsteMailronde: null, planningVanaf: null },
  logboek: [],
  samenvattingen: {},
  meldingen: [],
  kanalen: [],
};

export class Opslag {
  constructor(map) {
    this.map = map;
    mkdirSync(map, { recursive: true });
    const nieuw = [];
    for (const [naam, leeg] of Object.entries(BESTANDEN)) {
      if (!existsSync(this.#pad(naam))) nieuw.push(naam);
      this[naam] = this.#lees(naam, leeg);
    }
    // Tot 26 oktober 2026 heette de samenvatting "speerpunten".
    if (this.instellingen.speerpuntenVia && !this.instellingen.samenvattingVia) {
      this.instellingen.samenvattingVia = this.instellingen.speerpuntenVia;
    }
    delete this.instellingen.speerpuntenVia;
    this.instellingen = {
      ...STANDAARD_INSTELLINGEN,
      ...this.instellingen,
      smtp: { ...STANDAARD_INSTELLINGEN.smtp, ...this.instellingen.smtp },
      claude: { ...STANDAARD_INSTELLINGEN.claude, ...this.instellingen.claude },
      ollama: { ...STANDAARD_INSTELLINGEN.ollama, ...this.instellingen.ollama },
      audio: { ...STANDAARD_INSTELLINGEN.audio, ...this.instellingen.audio },
    };
    if (!this.instellingen.audio.workerUrl && process.env.WORKER_URL) this.instellingen.audio.workerUrl = process.env.WORKER_URL;
    // Tot oktober 2026 kwam audio uit een aparte audioscraper.
    delete this.instellingen.audioscraper;
    // Oude bestanden alleen lezen voor de omzetting; ze blijven staan als back-up.
    const oud = (naam, leeg) => this.#lees(naam, leeg);
    const gewijzigd = migreer(this, { nieuw, oud });
    if (gewijzigd.length) this.bewaar(...gewijzigd);
  }

  #pad(naam) {
    return path.join(this.map, `${naam}.json`);
  }

  #lees(naam, leeg) {
    const pad = this.#pad(naam);
    if (!existsSync(pad)) return structuredClone(leeg);
    try {
      return JSON.parse(readFileSync(pad, 'utf8'));
    } catch (fout) {
      // Liever stoppen dan een kapot bestand stilletjes overschrijven met leeg.
      throw new Error(`${pad} is geen geldige JSON (${fout.message}). Herstel of verwijder het bestand.`);
    }
  }

  bewaar(...namen) {
    for (const naam of namen) {
      const pad = this.#pad(naam);
      writeFileSync(`${pad}.tmp`, JSON.stringify(this[naam], null, 2));
      renameSync(`${pad}.tmp`, pad);
    }
  }

  log(regel) {
    this.logboek.unshift({ tijd: new Date().toISOString(), ...regel });
    this.logboek.length = Math.min(this.logboek.length, 300);
    this.bewaar('logboek');
  }
}
