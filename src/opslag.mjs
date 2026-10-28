// Alle toestand staat in een paar JSON-bestanden in data/. Klein genoeg om in
// het geheugen te houden; elke wijziging wordt meteen weggeschreven (eerst naar
// een tijdelijk bestand, dan hernoemd, zodat een crash nooit een half bestand
// achterlaat). Back-up = de map data/ kopiëren.
//
//   instellingen.json  schema, SMTP, Claude-sleutel en Ollama-adres
//   ontvangers.json    wie welke regio's krijgt
//   items.json         alles wat de bronnen ooit opleverden, met eersteGezien
//   status.json        per bron de laatste ronde, de laatste mailronde en
//                      planningVanaf (zie planning.mjs)
//   logboek.json       verzonden mails en fouten (laatste 300)
//   samenvattingen.json  cache van Claude-/Ollama-antwoorden, zodat twee
//                      verslaggevers met dezelfde regio geen dubbele aanroep kosten
//   kamertermen.json   termen per regio voor kamerstukken
//   meldingen.json     meldingen op termen (e-mail, termen, frequentie)
//   kamerstukken.sqlite  de kamerstukken zelf, met zoekindex (src/kamer/db.mjs)

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

export const STANDAARD_INSTELLINGEN = {
  // Verstuurmoment: tijd (24-uurs) en dagen (1 = maandag … 7 = zondag).
  // Standaard één keer per week; de mail bevat alles sinds de vorige mail.
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
  ollama: { url: '', model: '', maxContext: 32768 },
};

const BESTANDEN = {
  instellingen: {},
  ontvangers: [],
  items: {},
  status: { bronnen: {}, laatsteVerzamelronde: null, laatsteMailronde: null, planningVanaf: null },
  logboek: [],
  samenvattingen: {},
  // Kamerstukken: termen per regio ({ opsterland: ['Bakkeveen', …] }) en
  // meldingen op termen (src/kamer/meldingen.mjs).
  kamertermen: {},
  meldingen: [],
};

export class Opslag {
  constructor(map) {
    this.map = map;
    mkdirSync(map, { recursive: true });
    for (const [naam, leeg] of Object.entries(BESTANDEN)) {
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
    };
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
