// De regio's en hun bronnen. Per regio drie soorten: nieuws, ingekomen stukken
// en Woo-publicaties. Waar een gemeente iets niet (vindbaar) online zet, staat
// hier een bron van het type 'ontbreekt' met de toelichting die de webUI en de
// mail tonen. Zo is het gat zichtbaar in plaats van stil weggelaten.
//
// `inhoud: false` betekent dat er achter de link niets te lezen valt; dan krijgt
// de samenvatting alleen de titel (zie src/inhoud.mjs).
//
// Een bron toevoegen: kies een type uit src/bronnen/index.mjs, geef een uniek id
// en zet hem bij de juiste regio. Het id is ook de sleutel in data/items.json;
// verander het niet voor een bestaande bron, anders komt alles opnieuw binnen.

export const SOORTEN = {
  nieuws: 'Gemeentenieuws',
  ingekomen: 'Ingekomen stukken',
  woo: 'Woo-publicaties',
};

// Alle soorten stukken in de feed, met de naam van één stuk ("Ingekomen stuk")
// en het tabblad waar ze onder vallen. Audio en video komen uit audioscraper
// (src/audio/), kamerstukken uit de Tweede Kamer (src/kamer/).
export const ENKELVOUD = {
  nieuws: 'Gemeentenieuws',
  ingekomen: 'Ingekomen stuk',
  woo: 'Woo-publicatie',
  kamerstuk: 'Kamerstuk',
  raadsvergadering: 'Raadsvergadering',
  youtube: 'YouTube',
  podcast: 'Podcast',
  aardbeving: 'Aardbeving',
  weerwaarschuwing: 'Weerwaarschuwing',
  uitspraak: 'Uitspraak Raad van State',
  ransomware: 'Ransomware',
};

export const GROEPEN = {
  nieuws: 'Gemeentenieuws',
  ingekomen: 'Ingekomen',
  woo: 'Woo',
  kamerstuk: 'Kamerstukken',
  audio: 'Audio & video',
  signaal: 'Signalen',
};

export const AUDIOSOORTEN = ['raadsvergadering', 'youtube', 'podcast'];

// Aardbevingen, weerwaarschuwingen, uitspraken en ransomware: landelijke
// signalen uit de vroegere checker (src/bronnen/signalen.mjs).
export const SIGNAALSOORTEN = ['aardbeving', 'weerwaarschuwing', 'uitspraak', 'ransomware'];
export const groepVan = (soort) => (AUDIOSOORTEN.includes(soort) ? 'audio' : SIGNAALSOORTEN.includes(soort) ? 'signaal' : soort);

export const REGIOS = [
  {
    id: 'smallingerland',
    naam: 'Smallingerland',
    site: 'https://smallingerland.nl',
    bronnen: [
      {
        id: 'smallingerland-nieuws', soort: 'nieuws', type: 'smallingerland-nieuws',
        url: 'https://www.smallingerland.nl/Nieuwsarchief',
        label: 'Nieuws op smallingerland.nl',
      },
      {
        id: 'smallingerland-ingekomen', soort: 'ingekomen', type: 'notubiz-ingekomen',
        organisatie: 1764, module: 1,
        basis: 'https://smallingerland.notubiz.nl',
        url: 'https://smallingerland.notubiz.nl/modules/1/ingekomen_stukken/view',
        label: 'Ingekomen stukken (Notubiz)',
      },
      {
        id: 'smallingerland-woo', soort: 'woo', type: 'smallingerland-woo',
        url: 'https://www.smallingerland.nl/Onderwerpen/Klacht_en_bezwaar/Verzoek_informatie_Wet_open_overheid_Woo',
        label: 'Woo-verzoeken op smallingerland.nl',
        toelichting: 'De lijst heeft geen datums: een verzoek telt als nieuw op de dag dat het op de pagina verschijnt.',
      },
    ],
  },
  {
    id: 'opsterland',
    naam: 'Opsterland',
    site: 'https://www.opsterland.nl',
    bronnen: [
      {
        id: 'opsterland-nieuws', soort: 'nieuws', type: 'rss',
        url: 'https://www.opsterland.nl/rss/content-list?type%5B%5D=news&type%5B%5D=linked_news_item&sort_by=published_at&sort_order=DESC',
        label: 'Nieuwsfeed opsterland.nl',
      },
      {
        id: 'opsterland-raadsbrieven', soort: 'ingekomen', type: 'ibabs',
        basis: 'https://opsterland.bestuurlijkeinformatie.nl',
        overzicht: '890c558f-fd59-4234-aa01-97c6e8f4c06c',
        url: 'https://opsterland.bestuurlijkeinformatie.nl/Reports/Details/890c558f-fd59-4234-aa01-97c6e8f4c06c',
        label: 'Raadsinformatiebrieven (iBabs)',
        vervangend: true,
        mailnotitie: 'post van inwoners en organisaties staat er niet in',
        toelichting: 'Vervangende bron. Opsterland publiceert in iBabs geen lijst met ingekomen stukken van derden; dit overzicht bevat de brieven van het college aan de raad. Post van inwoners en organisaties ontbreekt dus.',
      },
      {
        id: 'opsterland-woo', soort: 'woo', type: 'ontbreekt',
        url: 'https://www.opsterland.nl/wet-open-overheid',
        label: 'Woo-publicaties',
        toelichting: 'Niet gevonden. De Woo-pagina legt alleen uit hoe je een verzoek indient; ook op open.overheid.nl staan geen Woo-besluiten van Opsterland.',
      },
    ],
  },
  {
    id: 'heerenveen',
    naam: 'Heerenveen',
    site: 'https://www.heerenveen.nl',
    bronnen: [
      {
        id: 'heerenveen-nieuws', soort: 'nieuws', type: 'rss',
        url: 'https://www.heerenveen.nl/nieuws/feed/',
        label: 'Nieuwsfeed heerenveen.nl',
      },
      {
        id: 'heerenveen-ingekomen', soort: 'ingekomen', type: 'ibabs',
        basis: 'https://heerenveen.bestuurlijkeinformatie.nl',
        overzicht: '928dc4e7-abc3-4cdc-aee0-27dbfb608d9c',
        url: 'https://heerenveen.bestuurlijkeinformatie.nl/Reports/Details/928dc4e7-abc3-4cdc-aee0-27dbfb608d9c',
        label: 'Ingekomen stukken 2026-2030 (iBabs)',
      },
      {
        id: 'heerenveen-woo', soort: 'woo', type: 'ontbreekt',
        url: 'https://www.heerenveen.nl/gemeentebestuur/wet-open-overheid/',
        label: 'Woo-publicaties',
        toelichting: 'Niet gevonden. Heerenveen schrijft op de Woo-pagina dat het publiceren van Woo-besluiten "op dit moment nog niet aan de orde" is; ook open.overheid.nl heeft niets.',
      },
    ],
  },
  {
    id: 'sudwestfryslan',
    naam: 'Súdwest-Fryslân',
    site: 'https://sudwestfryslan.nl',
    bronnen: [
      {
        id: 'sudwestfryslan-nieuws', soort: 'nieuws', type: 'swf-nieuws',
        url: 'https://sudwestfryslan.nl/publicaties/nieuws',
        label: 'Nieuws op sudwestfryslan.nl',
      },
      {
        id: 'sudwestfryslan-ingekomen', soort: 'ingekomen', type: 'swf-ingekomen',
        url: 'https://sudwestfryslan.nl/onderwerp/ingekomen-stukken/',
        label: 'Weeklijst ingekomen stukken (pdf)',
        toelichting: 'De gemeente publiceert alleen datum, indiener en onderwerp; het stuk zelf vraag je op bij griffie@sudwestfryslan.nl.',
        // Geen inhoud op te halen: alleen datum, indiener en onderwerp staan online.
        inhoud: false,
      },
      {
        id: 'sudwestfryslan-woo', soort: 'woo', type: 'swf-woo',
        url: 'https://sudwestfryslan.nl/onderwerp/woo-verzoeken/',
        label: 'Openbaar gemaakte documenten (Woo)',
        toelichting: 'Alleen datum en onderwerp staan online; de documenten zelf vraag je op via het formulier op de pagina.',
        // Geen inhoud op te halen: alleen datum en onderwerp staan online.
        inhoud: false,
      },
    ],
  },
  {
    id: 'ooststellingwerf',
    naam: 'Ooststellingwerf',
    site: 'https://www.ooststellingwerf.nl',
    bronnen: [
      {
        id: 'ooststellingwerf-nieuws', soort: 'nieuws', type: 'rss',
        url: 'https://www.ooststellingwerf.nl/rss/content-list?type%5B%5D=news&sort_by=published_at&sort_order=DESC',
        label: 'Nieuwsfeed ooststellingwerf.nl',
      },
      {
        id: 'ooststellingwerf-ingekomen', soort: 'ingekomen', type: 'ibabs',
        basis: 'https://ooststellingwerf.bestuurlijkeinformatie.nl',
        overzicht: 'a886aa34-f081-4977-9677-b567aac6dba6',
        url: 'https://ooststellingwerf.bestuurlijkeinformatie.nl/Reports/Details/a886aa34-f081-4977-9677-b567aac6dba6',
        label: 'Ingekomen stukken 2026-2030 (iBabs)',
      },
      {
        id: 'ooststellingwerf-woo', soort: 'woo', type: 'ontbreekt',
        url: 'https://www.ooststellingwerf.nl/informatie-opvragen-en-wet-open-overheid',
        label: 'Woo-publicaties',
        toelichting: 'Niet gevonden. De Woo-pagina legt alleen uit hoe je een verzoek indient; ook op open.overheid.nl staan geen Woo-besluiten van Ooststellingwerf.',
      },
    ],
  },
  {
    id: 'weststellingwerf',
    naam: 'Weststellingwerf',
    site: 'https://www.weststellingwerf.nl',
    bronnen: [
      {
        id: 'weststellingwerf-nieuws', soort: 'nieuws', type: 'rss',
        url: 'https://www.weststellingwerf.nl/rss/content-list?type%5B%5D=news&sort_by=published_at&sort_order=DESC',
        label: 'Nieuwsfeed weststellingwerf.nl',
      },
      {
        id: 'weststellingwerf-ingekomen-extern', soort: 'ingekomen', type: 'ibabs',
        basis: 'https://weststellingwerf.bestuurlijkeinformatie.nl',
        overzicht: 'c2829de4-6962-4acc-94cf-2e2c46a00193',
        url: 'https://weststellingwerf.bestuurlijkeinformatie.nl/Reports/Details/c2829de4-6962-4acc-94cf-2e2c46a00193',
        label: 'Ingekomen stukken – extern (iBabs)',
      },
      {
        id: 'weststellingwerf-ingekomen-intern', soort: 'ingekomen', type: 'ibabs',
        basis: 'https://weststellingwerf.bestuurlijkeinformatie.nl',
        overzicht: '28b83cdc-f45d-407b-b3e2-b7b0105255e8',
        url: 'https://weststellingwerf.bestuurlijkeinformatie.nl/Reports/Details/28b83cdc-f45d-407b-b3e2-b7b0105255e8',
        label: 'Ingekomen stukken – intern, van het college (iBabs)',
      },
      {
        id: 'weststellingwerf-woo', soort: 'woo', type: 'ontbreekt',
        url: 'https://www.weststellingwerf.nl/informatie-opvragen-bij-gemeente-wet-open-overheid-woo',
        label: 'Woo-publicaties',
        toelichting: 'Niet gevonden. De Woo-pagina legt alleen uit hoe je een verzoek indient; ook op open.overheid.nl staan geen Woo-besluiten van Weststellingwerf.',
      },
    ],
  },
  {
    // groningen.nl is de citymarketingsite (bezoeken, wonen, studeren); de
    // gemeente zelf zit op gemeente.groningen.nl, waar groningen.nl naar linkt.
    id: 'groningen',
    naam: 'Groningen',
    site: 'https://gemeente.groningen.nl',
    bronnen: [
      {
        // Niet gelinkt vanaf de site, maar wel genoemd in de paginadata van
        // /nieuwsoverzicht (rssLink).
        id: 'groningen-nieuws', soort: 'nieuws', type: 'rss',
        url: 'https://gemeente.groningen.nl/feed/rss/nieuws/2',
        label: 'Nieuwsfeed gemeente.groningen.nl',
      },
      {
        id: 'groningen-bw-besluiten', soort: 'ingekomen', type: 'groningen-bw-besluiten',
        url: 'https://gemeente.groningen.nl/bw-besluiten',
        label: 'B&W-besluiten met collegebrieven (gemeente.groningen.nl)',
        vervangend: true,
        mailnotitie: 'brieven van inwoners en organisaties aan de raad staan er niet in',
        toelichting: 'Vervangende bron. De lijst ingekomen stukken staat op gemeenteraad.groningen.nl, maar die site zit achter een botcontrole (Anubis) die automatische verzoeken tegenhoudt; Open Raadsinformatie wordt voor Groningen sinds juli 2026 niet meer bijgewerkt. Deze pagina bevat de wekelijkse besluitenlijst van het college met de stukken voor de raad (raadsvragen, memo\'s, voortgangsbrieven). Post van inwoners en organisaties ontbreekt dus.',
      },
      {
        id: 'groningen-woo', soort: 'woo', type: 'gpp-woo',
        basis: 'https://open.groningen.nl',
        url: 'https://open.groningen.nl',
        label: 'Woo-publicaties (open.groningen.nl)',
      },
    ],
  },
];

export const regioOpId = (id) => REGIOS.find((r) => r.id === id);

// De ingebouwde bronnen. Wat een beheerder via de webUI toevoegt (en de
// landelijke bronnen) staat in src/register.mjs.
export const ingebouwdeBronnen = () => REGIOS.flatMap((r) => r.bronnen.map((b) => ({
  ...b,
  regio: r.id,
  bereik: 'regio',
  naam: `${r.naam} · ${b.label}`,
  ingebouwd: true,
})));
