# Regiochecker

Een bronnenplatform voor de regioredactie (LC en DVHN). Een journalist logt in
en ziet één chronologische **feed** van alles uit de regio's die hij of zij volgt:
gemeentenieuws, ingekomen stukken, Woo-publicaties, Kamerstukken waarin een
sleutelwoord van de regio staat, en audio en video: raadsvergaderingen,
YouTube-kanalen en podcasts, getranscribeerd met sprekers en genoemde namen.
Daarnaast een **weekmail** per journalist met per gemeente een samenvatting van
wat er speelt, en **directe meldingen** op zoektermen.

Draait op https://checker.mh-n.nl (sinds 30 oktober 2026; daarvoor
regiochecker.vroeg.app, dat nu doorverwijst). Inloggen via de Authelia op deze
server (authelia.mh-n.nl). Het ontwerp volgt de overdracht uit Claude Design
(Modernist-ontwerpsysteem, `public/modernist.css`), met per titel een eigen
signaalkleur: LC paars (#482AA5), DVHN blauw (#006ED1).

Audio en video kwamen tot oktober 2026 uit de losse dienst audioscraper; die
functionaliteit zit nu in de Regiochecker zelf (`src/audio/`). Het zware werk
(Whisper, stemherkenning, namen zoeken) doet de bestaande Whisper-worker in het
thuisnetwerk, via Tailscale.

## Voor journalisten

### Feed

Links de lijst, rechts het leespaneel; verder niets, zodat het rustig blijft.
Boven de lijst staat alleen de knop **Filters** (met het aantal filters dat
aanstaat en wat dat is, zoals "Opsterland · Kamerstukken"). Die klapt open met:
de gevolgde regio's (klik er een om alleen die te tonen; met **+ volgen** volg je
er meer), de soorten bron met aantallen (Gemeentenieuws, Ingekomen, Woo,
Bekendmakingen, Raadsvergaderingen, Kamerstukken, Kamerdebatten, YouTube,
Podcasts, KNMI, Raad van State, Ransomware, Verkeer, Ingezonden; alleen de
soorten waarvan er een bron is), **Alleen ongelezen** en **Wis filters**. Esc
klapt het weer dicht. Bij Zoeken staat naast de knop het aantal resultaten; het
Audio-archief heeft eigen filters. Een stuk openen markeert het als gelezen;
**j**/**k** of de pijltjes lopen door de lijst, **s** bewaart.

- Elk stuk dat via een sleutelwoord of een melding binnenkwam, heeft het blok
  **Waarom staat dit in je feed?**: de term, hoe vaak hij voorkomt en de zin
  eromheen (bij audio met de tijd).
- Een raadsvergadering, video of podcast opent met speler (als de audio bewaard
  is), streepjes op de tijdbalk, en het transcript per beurt. De streepjes zijn
  bij een vergadering met agenda het begin van elk agendapunt, anders (ook bij
  een Kamerdebat) de tijden uit **Waarom staat dit in je feed?**; erover zweven
  toont het punt of de term, erop klikken springt erheen. De beurt die nu speelt
  licht op, maar het scherm scrolt niet mee; een tijd aanklikken springt erheen. Een spreker
  zonder naam heeft een ▶ (kort fragment van die stem) en een veld **Naam
  invullen**; zo'n naam geldt voor die stem in alle opnames, ook in Plaud.
  Weet het vergaderplatform wie wanneer de microfoon had (Company Webcast,
  Notubiz), dan
  staat bij een stem die daar grotendeels mee samenvalt de naam als voorstel, met
  bij Sprekers een knop om alle voorstellen in één keer over te nemen. Andere
  naamvoorstellen zijn er niet meer: namen die het taalmodel vlak voor een beurt
  vond, klopten te vaak niet. Onder de speler staat de **AI-samenvatting**.
  Tabblad **Agenda** toont de agendapunten van het platform met hun tijd (ook als
  tussenkopjes in het transcript); tabblad **Namen** de telefoonnummers, en de
  genoemde personen, organisaties en plaatsen als namen zoeken aanstaat.
- **Bewaren** (ster) zet het stuk onder Bewaard; een **notitie** bij een stuk is
  alleen voor jou zichtbaar.

### Zoeken en audio-archief

**Zoeken** (rechtsboven) doorzoekt alles: alle regio's, kamerstukken en
transcripten, ook wat er bij de eerste ronde van een bron al stond (de
nulmeting; dat staat op de datum van het stuk). Woorden moeten allemaal
voorkomen, `"woordgroep"` als geheel, `OR` voor alternatieven.

**Audio-archief** is alles van audio en video, ook wat nog in de wachtrij staat:

- **Afleveringen**, te filteren op bron en status en te doorzoeken op titel en transcript;
- **Namen**: alle namen over het hele archief, op soort en gebied (Noord-Nederland,
  per provincie, Europa …), met per naam de plekken waar hij valt. Het gebied komt
  uit `src/audio/locaties.json`, gemaakt uit [GeoNames](https://www.geonames.org/)
  (CC BY 4.0) en de landnamen van [Unicode CLDR](https://cldr.unicode.org/);
- **Stemmen**: de herkende stemmen met hoe vaak ze te horen zijn en welke namen
  tijdens hun beurten vallen; hier een naam invullen geldt overal;
- **Telefoonnummers**: geschreven of uitgesproken nummers, met het bedrijf als dat
  openbaar bevestigd is, en anders een suggestie van de worker op basis van het
  transcript, die je bevestigt of afwijst.

### Meldingen

- **Weekoverzicht**: aan of uit, eigen dagen en tijd, en of hij ook komt als er
  niets nieuws is. Met een voorbeeld van de volgende mail.
- **Directe meldingen** op zoektermen (`"stikstof" OR natura2000`): waar
  (mijn regio's, overal, of één regio), welke bronnen (alles, alleen websites,
  alleen Kamerstukken, alleen audio en video) en hoe vaak (direct, of dagelijks
  op een vaste tijd).
- De zoekterm is optioneel. **Zonder zoekterm** komt alles wat er nieuw
  binnenkomt binnen die keuze, precies zoals de feed het voor die regio's toont:
  hun eigen bronnen, landelijke stukken via sleutelwoord of plek, Kamerstukken via
  de sleutelwoorden van de regio, en audio. De melding heet dan bijvoorbeeld
  "Alles uit Smallingerland, alleen Kamerstukken", en de mail heeft geen regel
  "Gevonden".
- Zonder zoekterm kan **Overal** niet: dat zou alles zijn wat er binnenkomt,
  waaronder honderden Kamerstukken per week.
- Zo'n melding zet ook niets extra in de feed. Een melding met zoekterm doet dat
  wel; zonder zoekterm zou dat hele regio's toevoegen, en welke regio's de feed
  toont, kies je met volgen.

## Hoe de mails eruitzien

Sinds 30 oktober 2026 hebben de mails de huisstijl van de website (Modernist,
Archivo), volgens de handover van Claude Design. De opmaak staat in
`src/mailstijl.mjs` en geldt voor alle mails: de meldingsmail, de weekmail, de
uitnodiging en de testmail.
- **Huisstijl per titel.** De accentkleur volgt de titel van de ontvanger: LC
  paars, DVHN blauw. De tinten zijn vaste waarden, want mailprogramma's kennen
  geen CSS-variabelen.
- **Bouw.** Tabellen met inline stijlen, zodat Outlook het ook goed toont. Er
  staat een verborgen voorbeeldtekst (preheader) in, en lichte kleuren zijn
  afgedwongen. Op mobiel worden de marges smaller en gaan tellers en knoppen
  onder elkaar.
- **Te lange woorden** (zoals een webadres) breken af, zodat een bron de mail
  nooit breder kan maken.

**Meldingsmail.**
- **Onderwerp**: bij één stuk "{zoekterm}: {titel}" (zonder zoekterm
  "{regio}: {titel}"); bij meer stukken zoals altijd: "Melding: 3 nieuwe
  stukken met …".
- **Opbouw per stuk**: waarom het erin staat, soort en regio, de titel, de
  kenmerken, het fragmentblok met de treffer, en de knoppen **Openen in
  Regiochecker** en **Bij {bron}**.
- **Tekst van het stuk.** Bij hooguit drie stukken staat ook de tekst van het
  stuk erin, met de zoektermen gemarkeerd:
  - Kamerstukken komen uit de kamerdatabase;
  - websites uit het opgehaalde document of de korte inhoud;
  - audio uit het transcript, twee minuten voor tot twee minuten na de eerste
    treffer, met per spreker een alinea en de tijd;
  - een aflevering zonder treffer (melding zonder zoekterm) krijgt de korte
    samenvatting.
- **Lengte.** Tot ongeveer 600 woorden, afgekapt op een alineagrens. Staat de
  eerste vondst verder in de tekst, dan het deel eromheen; de handover vroeg
  het begin, maar in een agenda van 6.000 woorden staat de vondst zelden in de
  eerste 600. Bij meer dan drie stukken alleen het fragment.

**Weekmail.**
- **Onderwerp**: "Week 44: 52 nieuwe stukken in Smallingerland, Heerenveen en
  Leeuwarden". Bij meer dan drie regio's de eerste twee en "en 38 andere". Het
  weeknummer is dat van het midden van de periode. Ging er langer dan een week
  geen mail uit, dan staan de datums erachter in plaats van een weeknummer.
- **Bovenaan**: "Week 44", de periode, een groet, en een rij tellers met per
  regio het aantal stukken, drie per rij.
- **Per regio**: alle stukken, niet alleen de nieuwste (keuze van de
  opdrachtgever), met onderaan "Alle {n} stukken uit {regio} →" naar de feed.
- **Omvang.** Met veel regio's wordt de mail groot: met veertig regio's ongeveer
  1 MB. Gmail laat boven ongeveer 100 kB een link "Volledig bericht weergeven"
  zien; Outlook toont alles.

**Voorbeeld zonder versturen**: `GET /api/beheer/mailvoorbeeld?soort=week` of
`?soort=melding`, met `&gebruiker=<id>`, `&titel=LC|DVHN`, `&aantal=1` (alleen
het nieuwste stuk, voor de mail met de tekst van het stuk), `&dagen=7` en
`&samenvatting=1` (alleen bij de weekmail).

## Wat er in de weekmail staat

Per gemeente een H2-kop. Daaronder:

1. **Samenvatting.** Een taalmodel (Claude of een eigen Ollama, zie hieronder)
   zet op een rij wat er deze week in de gemeente speelt: per onderwerp één
   opsommingspunt van één zin, op basis van de titel én de inhoud van elk nieuw
   bericht, met de bronnen erachter. Nieuwsbrieven, ledenbrieven en uitnodigingen
   van derden laat het weg (die staan wel in de lijst eronder). Is de gekozen
   aanbieder niet ingesteld of niet bereikbaar, dan valt dit blok weg en staat er
   waarom.
2. **Drie H3-koppen, altijd in deze volgorde:** Gemeentenieuws, Ingekomen
   stukken, Woo-publicaties, met de nieuwe berichten eronder. Ook een lege
   categorie krijgt zijn kop ("Geen nieuwe berichten"), zodat alles elke week op
   dezelfde plek staat. Kon een categorie niet gecontroleerd worden (niet online,
   vervangende bron, of een fout bij de laatste ronde), dan staat dat onder die kop.
3. Als er iets is: **Landelijke bronnen** en **Kamerstukken** met een sleutelwoord
   van de regio (met de zin waarin het staat), en audio per soort:
   **Raadsvergaderingen**, **Kamerdebatten**, **YouTube**, **Podcasts**. Bij een raadsvergadering van de gemeente zelf staat een samenvatting
   van wat er besproken is: per onderwerp een tussenkop met punten
   (`src/vergadering.mjs`).

### Welke periode?

De mail bevat altijd alles wat **sinds de vorige mail aan die journalist** voor
het eerst is gezien, tot het moment van versturen. Een week zonder mail (niets
nieuws, een fout, of de weekmail stond uit) valt dus nooit weg: die zit in de
volgende mail. Wie nog nooit een mail kreeg, krijgt de afgelopen week.

- Verstuurmoment: per journalist (Meldingen). Nieuwe gebruikers krijgen het
  standaardschema uit Beheer › Instellingen (maandag 07:00).
- Stond de dienst uit op het verstuurmoment, dan gaat de mail zodra hij weer
  draait. Na het wijzigen van het schema wordt een moment dat al voorbij is niet
  alsnog verstuurd.
- Mislukt het versturen (SMTP onbereikbaar), dan probeert de dienst het die dag
  elk half uur opnieuw. Lukt het niet, dan blijft de vorige-mail-tijd staan en
  komt alles in de volgende mail.
- Vlak voor het versturen doet de dienst altijd een verse controleronde.

### Wat telt als nieuw?

De bronnen worden elk uur gecontroleerd. Een item is nieuw op het moment dat de
Regiochecker het voor het eerst ziet, niet op de datum die erop staat. Een
Woo-besluit van augustus dat pas in oktober online komt, is in oktober nieuws.

Twee vangnetten tegen een mail vol oud nieuws:

- De eerste ronde van een bron is een **nulmeting**: wat er dan al staat, telt
  niet als nieuw (behalve stukken van de laatste twee dagen). Bij audio komen de
  eerste paar afleveringen wel binnen, maar op hun eigen datum.
- Een "nieuw" nieuwsbericht of ingekomen stuk met een datum van meer dan drie
  weken oud telt ook niet mee. Dat vangt een omgebouwde site op waarbij ineens
  alle links veranderen. Voor Woo geldt deze grens niet.

Sommige overzichten hebben geen datums (Westerveld, het iBabs-overzicht van
Meppel en Stadskanaal, de Woo-pagina's van onder meer Leeuwarden en Meppel). Een
stuk daarvan krijgt de dag waarop de Regiochecker het voor het eerst zag
(`datumBijEersteZicht`). Wat er bij de nulmeting al stond, kan van veel eerder
zijn en houdt geen datum; in de zoekresultaten staat het onderaan, met een
streepje in plaats van een datum.

## Bronnen

| Gemeente | Nieuws | Ingekomen stukken | Woo-publicaties |
|---|---|---|---|
| Smallingerland | `/Nieuwsarchief` (HTML) | Notubiz-module Ingekomen stukken | Subpagina's van de Woo-pagina (geen datums) |
| Opsterland | RSS | **Vervangend:** iBabs Raadsinformatiebrieven | **Niet gevonden** |
| Heerenveen | RSS `/nieuws/feed/` | iBabs Ingekomen stukken 2026-2030 | **Vervangend:** de pdf's die de gemeente zelf op de Woo-pagina zet (vooral over het azc; geen datums) |
| Súdwest-Fryslân | `/publicaties/nieuws` (HTML) | Weeklijst als pdf (alleen datum, indiener, onderwerp) | Tabel op `/onderwerp/woo-verzoeken/` (alleen datum en onderwerp) |
| Ooststellingwerf | RSS | iBabs Ingekomen stukken 2026-2030 | **Niet gevonden** |
| Weststellingwerf | RSS | iBabs Ingekomen stukken extern + intern | **Niet gevonden** |
| Groningen | RSS `/feed/rss/nieuws/2` (gemeente.groningen.nl) | **Vervangend:** B&W-besluiten met collegebrieven | GPP-Woo-portaal open.groningen.nl (API) |

"Niet gevonden" betekent: de Woo-pagina van de gemeente legt alleen uit hoe je
een verzoek indient, en ook op open.overheid.nl staan geen Woo-besluiten van die
gemeente (gecontroleerd op 20 oktober 2026). Opsterland heeft in iBabs geen lijst
met ingekomen stukken van derden; de raadsinformatiebrieven (post van het college
aan de raad) staan er voorlopig voor in de plaats.

Groningen: groningen.nl is de citymarketingsite; de gemeente zelf zit op
gemeente.groningen.nl (gelinkt vanaf groningen.nl). De lijst ingekomen stukken
staat op gemeenteraad.groningen.nl (GemeenteOplossingen), maar die site zit
achter Anubis, een botcontrole die ook eerlijk geïdentificeerde automatische
verzoeken tegenhoudt. Open Raadsinformatie, dat die site normaal indexeert, is
voor Groningen sinds juli 2026 niet meer bijgewerkt. In de plaats staat de pagina
B&W-besluiten: de wekelijkse besluitenlijst van het college met de stukken voor
de raad (beantwoording raadsvragen, memo's, voortgangsbrieven). Toegang tot de
echte lijst vraagt een uitzondering in de botcontrole, aan te vragen bij de
griffie. (Voor de opnames van raadsvergaderingen op datzelfde portaal gaat de
Regiochecker wél langs de poort; zie Audio en video.)

Voor sites zonder feed zijn er lezers die je per bron instelt, in plaats van
een lezer per site:

- `html-lijst` (`src/bronnen/htmllijst.mjs`): de links op een gewone pagina, met
  een patroon voor het pad (`link`). De titel is de linktekst of de kop erbij,
  de datum de datum die het dichtst bij de link staat. Opties: `inKop`,
  `vanaf`/`tot`, `zonderDatum`, `extern`, `via` (eerst de pagina's per jaar) en
  `perKop` (een stuk per kop). Zo lezen we het nieuws van Leeuwarden, De Fryske
  Marren, De Wolden, Westerveld, Tynaarlo en Coevorden, en de Woo-pagina's van
  Leeuwarden, Dantumadiel, Noardeast-Fryslân, Terschelling, Heerenveen, Meppel,
  Veendam, Westerkwartier en Het Hogeland (Woogle).
- `ibabs-agenda` (`src/bronnen/ibabsagenda.mjs`): ingekomen stukken die alleen
  in een iBabs-agenda staan. Borger-Odoorn heeft bij elke raad een vergadering
  "Lijst ingekomen stukken" met een agendapunt per brief (het kopje erboven,
  zoals "Ter kennisname", is het advies); Schiermonnikoog zet de brieven als
  bijlagen bij het agendapunt "Lijst van Ingekomen Stukken" van de
  raadsvergadering. We lezen de vergaderingen van twee maanden terug tot
  anderhalve maand vooruit; de lijst groeit tot de vergadering.
- Woo-platforms (`src/bronnen/woo.mjs`): eData-loket (Midden-Drenthe,
  Westerveld, Hoogeveen, De Wolden), Divault (Oldambt), het publicatieplatform
  van Stadskanaal, een STACK-map (Aa en Hunze), Djuma (Midden-Groningen), het
  Mozard-zaakloket (Ameland, Vlieland, Tynaarlo) en de statische site van
  Coevorden. Per platform staat in het bestand hoe de lijst op te halen is.

Coevorden weerde ons eerst: de site zit achter een firewall (Azure Front Door)
die korte of onbekende user-agents tegenhoudt. Met de gewone user-agent van de
Regiochecker (een browser-UA met "Regiochecker/1.0" erachter) komen we er gewoon
in; er wordt niets omzeild.

Deze ingebouwde bronnen staan in `src/regios.mjs`, de lezers per brontype in
`src/bronnen/`. Een bron met een standaardlezer (RSS-feed, iBabs-overzicht,
Woo-platform) of een audio- of videobron voeg je toe in de webUI (Beheer ›
Bronnen); die staan in `data/bronnen.json`. Een site met een eigen opbouw lukt
vaak met `html-lijst` (via de API, zie Beheer); anders vraagt die een nieuwe
lezer in de code. Verander het `id` van een bestaande bron niet,
anders komt alles opnieuw binnen (al vangt de nulmeting dat op).

## Landelijke bronnen en sleutelwoorden

Elke bron heeft een **bereik**: één regio (alles gaat naar die regio) of
landelijk (een stuk gaat naar elke regio waarvan een **sleutelwoord** erin
voorkomt). Sleutelwoorden stel je per regio in (Beheer › Regio's): plaatsen,
dorpen, wijken, gebouwen. Hoofdletters en accenten tellen niet, alleen hele
woorden; een woordgroep moet als geheel voorkomen.

**Uitzondering: Kamerstukken** (sinds 30 oktober 2026). Daar moet elke
hoofdletter van het sleutelwoord ook in de tekst een hoofdletter zijn: "Assen"
vindt de stad (ook ASSEN in een kop), niet "de assen van een vrachtwagen".
- Kleine letters mogen allebei: "in Witteveen" vindt ook "In Witteveen" aan het
  begin van een zin. Een sleutelwoord in kleine letters blijft dus ongevoelig.
- Een lidwoord vooraan telt niet mee ("het Hogeland" is Het Hogeland), en een
  webadres ook niet: `dvhn.nl/regio/groningen/…` in Kamervragen gaat over
  Groningen.
- Het geldt in de feed, de weekmail, een melding beperkt tot regio's, het blok
  "Waarom staat dit in je feed?" en de tellingen in Beheer › Regio's.
- Zoektermen van meldingen en de zoekbalk blijven ongevoelig voor hoofdletters.
- Effect over de 30 dagen ervoor: Assen ging van 37 naar 19 Kamerstukken, Aa en
  Hunze van 17 naar 8 ("gieten", "amen"); in totaal 756 → 725.
- SQLite (FTS5) kent geen hoofdletters. Daarom controleren we eerst het fragment
  dat SQLite markeert, en lezen we pas de hele tekst als dat niet klopt (zie
  `src/termen.mjs` en `src/kamer/db.mjs`).

Per sleutelwoord zie je hoeveel
stukken uit landelijke bronnen het de afgelopen 30 dagen opleverde ("Veel ruis"
bij 25 of meer). Per regio kun je een landelijke bron uitzetten ("Geldt voor").

Sinds 30 oktober 2026 heeft elke regio als sleutelwoorden de naam van de
gemeente en alle woonplaatsen erin (CBS, `src/geo/nl.json`; 917 aan, 57 uit; met
de Nederlandse namen hieronder samen 1039 aan, 67 uit).
Vooraf geteld in de Kamerstukken sinds 15 september; wat daar vooral iets anders
betekende, staat uit:
- gewone woorden, of een grotere plaats elders: "Een", "Anderen", "Oranje",
  "Loon", "Boer", "de Wijk", "De Punt", "Sloten", "Noordwijk", "Hoorn",
  "Steenbergen", "Zurich" en dergelijke, zonder varianten;
- echte plaatsen die ook een achternaam of woord zijn (Kamerleden Westerveld en
  Hoogeveen, de rapporteur Sneek, Witteveen+Bos; "haren", "leek", "vries",
  "balk", "dalen"): de kale naam uit, met varianten aan als "in Hoogeveen", "uit
  Hoogeveen", "te Hoogeveen", "naar Hoogeveen", "bij Hoogeveen" en "gemeente
  Hoogeveen". Varianten die zelf botsten ("uit leek te rollen", "in wier
  verkiezingsprogramma", "bestaande uit Witteveen+Bos") ontbreken.
Een plaatsnaam die in twee regio's ligt (Oudega, Zuidwolde, Winsum, Alteveer),
staat bij allebei. "Groningen" levert de meeste treffers (stad én provincie,
zo'n 45 Kamerstukken per week). De officiële namen zijn in een deel van Fryslân
Fries (Burgum, Damwâld); landelijke stukken gebruiken vaak de Nederlandse naam.
Die staan er ook bij (122 aan), uit Wikidata: bij een plaats waarvan de officiële
naam de Friese naam is, de Nederlandse naam en de andere namen ("Burgum" →
"Bergum", "Grou" → "Grouw", "De Westereen" → "Zwaagwesteinde", "Warten" →
"Wartena"), en de Nederlandse namen van de gemeenten (Tietjerksteradeel,
Dantumadeel, Noordoost-Friesland, Zuidwest-Friesland). Uit staan namen die elders
een officiële plaats zijn (Oosterend, Beers, Oostrum, Waaxens) of in de
Kamerstukken iets anders betekenden ("Kaart", "De Pomp", "de Friese meren");
achternamen (Edens, Boxum) alleen met "in", "uit", "te", "naar" of "bij" ervoor.

De Tweede Kamer is de ingebouwde landelijke bron; een RSS-feed, Woo-platform of
podcast voeg je als landelijke bron toe in Beheer › Bronnen, met een
proefronde die laat zien hoeveel stukken er naar welke regio zouden gaan. Bij
audio wordt het transcript doorzocht en staat bij elke treffer de tijd.

### Bekendmakingen van de provincie Fryslân

De provincie zet elke zaterdag een pagina met bekendmakingen op fryslan.frl
(`/24-oktober-2026`, index per jaar op `/bekendmakingen-2026`;
`src/bronnen/provincie.mjs`). Bovenaan staat nieuws van de provincie zelf
("Vastgoed – bekendmaking", "Brug Warns afgesloten …"), sinds eind mei 2026
gevolgd door een uitklapblok per gemeente ("Gemeente Smallingerland", ook
"Gemeente Leeuwarden en Tytsjerksteradiel") of per onderwerp ("Provincie
Fryslân", "Diverse Natura 2000-gebieden"), met daarin de omgevingsvergunningen,
beschikkingen, kennisgevingen en meldingen van die week.

Elke bekendmaking wordt een stuk onder het tabblad **Bekendmakingen**, met een
kop van soort, onderwerp en plek ("Aanvraag vergunning Omgevingswet: het
uitvoeren van kadewerk (Troelstraweg te Idskenhuizen)"), de volledige tekst, en
een link naar het blok op de pagina. De bron is landelijk, maar met
`perGemeente`: een bekendmaking voor een gemeente die een regio is, wordt een stuk
van die regio, zoals de eigen bronnen van de gemeente (in de feed zonder
"Waarom", in de weekmail onder een eigen kopje **Bekendmakingen**). Voor twee
regio's tegelijk komt hij bij allebei. Al het andere (andere gemeenten, de
provincie zelf, het nieuws bovenaan) is landelijk en gaat via de sleutelwoorden.

De eerste ronde haalt alle zaterdagen sinds 3 januari 2026 op (van eerder bestaan
er geen pagina's), een seconde tussen de pagina's; daarna elk uur de index en de
drie nieuwste weken. Wat die eerste ronde vindt van de laatste dertig dagen, staat
meteen in de feed op de datum van de bekendmaking (`archief`); het oudere is
nulmeting, alleen te vinden via Zoeken. De stukken blijven tien jaar bewaard
(`bewaarDagen`).

## Signalen

De landelijke bronnen uit de checker (`/opt/checker`) zijn overgenomen
(`src/bronnen/signalen.mjs` en `src/bronnen/verkeer.mjs`), onder eigen
tabbladen in de feed: **KNMI** (aardbevingen en weerwaarschuwingen), **Raad van
State**, **Ransomware** en **Verkeer** (files en NS). Ze hebben een plek, en gaan
daarmee rechtstreeks naar de goede regio, naast de gewone sleutelwoorden:

| Bron | Waar het vandaan komt | Naar een regio als |
|---|---|---|
| KNMI · Aardbevingen | openbare FDSN-dienst `rdsa.knmi.nl` (geen sleutel), vanaf kracht 1,0, de laatste 60 dagen | het epicentrum in de gemeente ligt of tot 5 km erbuiten |
| KNMI · Weerwaarschuwingen | RSS per provincie, alleen code oranje en rood | de gemeente in die provincie ligt |
| Raad van State · Uitspraken | de 100 nieuwste uitspraken van de Afdeling bestuursrechtspraak | de gemeente of een plaats erin in de titel of samenvatting staat |
| Ransomware · Nederlandse slachtoffers | ransomlook.io (de 100 nieuwste wereldwijd, alleen met een `.nl`-website of Nederland in de beschrijving); met `RANSOMWARE_LIVE_API_KEY` ook ransomware.live Pro | het bedrijf in de gemeente gevestigd is (zie hieronder) |
| NDW · Files | open DATEX II-feed `opendata.ndw.nu/actueel_beeld.xml.gz` (geen sleutel), files vanaf 10 minuten vertraging | een stuk van het traject in de gemeente ligt |
| NS · Storingen en werkzaamheden | NS Reisinformatie API v3, met `NS_API_KEY` (gratis via apiportal.ns.nl); zonder sleutel staat de bron uit ("Sleutel nodig" bij Beheer › Bronnen) | een station op het traject in de gemeente ligt |

**Verkeer** is vluchtig. Files en NS komen elke vijf minuten binnen
(`intervalMinuten`), los van de gewone ronde, en alleen wat in een regio ligt
wordt bewaard (`alleenInRegio`; het land telt honderden files per dag). Een
file die groeit, houdt hetzelfde stuk met een bijgewerkte kop ("File op de A7
bij Heerenveen: 4,9 km, 13 minuten vertraging"); het wegnummer en de plaats
komen van de PDOK Locatieserver, want de NDW-feed noemt ze niet. NS-werkzaamheden
krijgen elke dag een nieuw id, en worden daarom op hun traject samengevoegd.
Verkeer gaat niet mee in de weekmail, wel naar meldingen en Teams-kanalen.

Aardbevingen, weerwaarschuwingen en ransomware blijven twee jaar bewaard
(`bewaarDagen` bij de bron), ook als de bron ze niet meer toont: die toont alleen
het nieuwste.

**Waar een ransomwareslachtoffer gevestigd is** (`src/locatie.mjs`, overgenomen
uit de locator van de checker): een lekwebsite noemt alleen naam, soms website
en een beschrijving. Van sterk naar zwak bewijs: een postcode die al bekend is;
een plaats in de beschrijving ("based in Heerenveen"); OpenStreetMap (Nominatim,
hooguit één verzoek per seconde) op de bedrijfsnaam, alleen treffers die echt op
de naam lijken, en met `OPENCORPORATES_API_KEY` ook OpenCorporates; de eigen
website, de postcode die op de contactpagina of homepage het vaakst staat (live,
anders via het Internet Archive), of de paginatitel als nieuwe zoeknaam; als
laatste de plaats die de checker vond. Een postcode gaat via de PDOK
Locatieserver naar woonplaats en gemeente. Wijzen de kandidaten naar
verschillende gemeenten (Makro), dan is de vestiging onzeker en gaat het stuk
naar geen regio. Elke verzamelronde zoekt hooguit 25 nieuwe slachtoffers op,
twee pogingen per stuk. De vestiging staat bij het stuk, met waar die vandaan
komt. De 202 slachtoffers die de checker sinds juni 2026 vond, zijn overgenomen
met `scripts/importeer-checker.mjs`.

Een regio heet naar een gemeente. Welke plekken daarin liggen, staat in
`src/geo/nl.json`: de gemeentegrenzen (Kadaster, Bestuurlijke Gebieden via PDOK,
vereenvoudigd tot zo'n 100 meter) en de woonplaatsen met hun gemeente (CBS,
Woonplaatsen in Nederland 2026), beide open data onder CC BY 4.0. Opnieuw maken,
bijvoorbeeld na een gemeentelijke herindeling: `node scripts/maak-geo.mjs`.

Een plaatsnaam telt alleen met een woord ervoor dat op een plek wijst ("in
Sneek", "gemeente Opsterland", "based in Heerenveen", "burgemeester en
wethouders van Smallingerland"), en alleen in de titel en samenvatting, niet in
de volledige tekst van een uitspraak, waar ook "advocaat te Heerenveen" staat.
Om dezelfde reden zoeken ook de sleutelwoorden bij de Raad van State alleen in
titel en samenvatting; zelf zoeken doorzoekt wel de hele uitspraak.
Plaatsnamen die ook gewone woorden of achternamen zijn ("Een", "Best", "Vries")
tellen nooit. Kamerstukken en andere landelijke bronnen gaan niet op
plaatsnaam, alleen op sleutelwoord: "Groningen" staat in te veel kamerstukken.

De NS-storingen en de DVHN-bot (112-inzendingen via Telegram) hebben in de
checker nooit gedraaid: daar stonden geen NS-sleutel en geen bottoken. De
aardbevingen in de checker liepen via de KNMI
Open Data API met een gedeelde anonieme sleutel die op 1 juli 2026 verliep; de
FDSN-dienst heeft geen sleutel nodig.

## Kamerstukken

Alle stukken van de Tweede Kamer (brieven, moties, Kamervragen, bijlagen …) sinds
Prinsjesdag 2026 (`KAMERSTUKKEN_VANAF`, standaard 2026-09-15), met volledige tekst,
uit het open-data-Gegevensmagazijn (opendata.tweedekamer.nl, OData v4).

- **Bijhouden** (`src/kamer/`): elk half uur wat er in de API gewijzigd is
  (metadata, `ApiGewijzigdOp`), daarna per document de pdf of docx downloaden en de
  tekst indexeren, nieuwste eerst, maximaal 600 per ronde. Verwijderde stukken
  gaan eruit; een nieuwe versie wordt opnieuw ingelezen.
- **Opslag**: `data/kamerstukken.sqlite`, SQLite met een FTS5-index op titel,
  onderwerp en tekst.
- **In de feed en de weekmail**: stukken met een sleutelwoord van een gevolgde
  regio, met de zin waarin het staat. Een stuk dat we pas later binnenhaalden dan
  het verscheen, staat in de feed op de datum van het stuk.
- **Zoeken**: de zoekbalk doorzoekt ook alle kamerstukken (FTS5: woorden,
  `"woordgroep"`, `OR`, `NOT`, `voorvoegsel*`).

## Kamerdebatten (gehoord.de)

[gehoord.de/beraadslagingen](https://gehoord.de/beraadslagingen) transcribeert
de debatten in de Tweede en Eerste Kamer terwijl ze plaatsvinden, met tijd,
spreker en fractie; gratis na registratie. De gegevens zijn te lezen via hun
MCP-server (`https://gehoord.de/api/mcp`, `src/mcp.mjs`). Inloggen gaat met
OAuth (autorisatiecode met PKCE, dynamische registratie; `src/gehoord.mjs`):

1. Beheer › Instellingen › Kamerdebatten › **Koppelen met gehoord.de**.
2. Je logt bij gehoord.de zelf in en geeft toestemming (`transcripts:read`).
3. gehoord.de stuurt je terug naar `/api/beheer/gehoord/terug` (op
   `REGIOCHECKER_SITE_URL`); de Regiochecker bewaart het toegangs- en
   verversingstoken in `data/instellingen.json` en vernieuwt het zelf.

Het wachtwoord ziet de Regiochecker nooit, en de tokens gaan niet naar de
browser. Trekt gehoord.de de koppeling in, dan staat dat bij Instellingen en
koppel je opnieuw. Na het koppelen toont het blok welke functies de server
aanbiedt (`search_debates`, `get_debate`, `get_transcript`, `search_transcripts`).

**De bron Kamerdebatten** (landelijk, soort `kamerdebat`, `audio.kind`
`gehoord`) is een bron in het audioarchief, maar zonder download en zonder
Whisper: elk uur de afgelopen debatten (`search_debates`, status `ended`), en
per debat het hele transcript (`get_transcript`, in pagina's van 100.000
tekens). De tools geven tekst, geen JSON; `src/gehoord.mjs` leest de regels
"#id · datum tijd · titel · zaal · status · n fragmenten" en per fragment
"[tijd] Spreker (fractie) — link". Elk fragment wordt een segment met spreker,
de tijd vanaf het begin van het debat (ook na middernacht), en het fragment-id.
Zo werkt alles van audio mee: zoeken in het transcript, een debat naar een regio
als een sleutelwoord valt (met het tijdstip), de AI-samenvatting, de weekmail.
In het leespaneel staat de video van het debat (Tweede Kamer, via Debat Direct)
en springt een klik op een tijd daarheen; de tabs zijn Transcript, Sprekers (wie
van gehoord.de, met fractie of functie, beurten en spreektijd) en Notitie. Bij
het debat staan ook de soort ("Plenair debat") en de waarschuwingen van
gehoord.de ("Let op"). **De video**: gehoord.de noemt bij een debat de pagina
op Debat Direct; de openbare API daarvan (`cdn.debatdirect.tweedekamer.nl/api`,
`/agenda/<datum>` en `/debates/<id>`) geeft de HLS-stream van de zaal op die dag,
die je met `start` en `end` (de tijden van het debat) tot het debat beperkt,
zoals hun eigen speler doet. De stream heeft kloktijden, de fragmenten van
gehoord.de ook (die kloppen op de seconde met de sprekerswissels van Debat
Direct). Bij een debat met video staan alle tijden (transcript, sprekers,
treffers, feed en mail) daarom op de klok van de video: 0:00 is het eerste beeld
(de eerste EXT-X-PROGRAM-DATE-TIME), en een klik op 2:42 zet de video op 2:42.
Dat gebeurt bij het binnenhalen; een debat van daarvoor is één keer omgezet
(`platform.tijdbasis`). Wat gehoord.de al had vóór het eerste beeld, staat op
0:00. De browser speelt de stream met hls.js (`public/vendor/`,
Apache-2.0, pas geladen als er een debat opengaat), ook als de browser zegt dat
hij HLS zelf kan: Chrome antwoordt "maybe" maar speelt deze stream (fMP4 met een
apart geluidsspoor) niet af. Alleen zonder Media Source Extensions (iPhone) de
eigen speler van de browser. Een
debat van de Eerste Kamer heeft geen Debat Direct; dan openen de tijden het
fragment bij gehoord.de. Het opzoeken gebeurt één keer per debat
(`GET /api/stuk/video`), daarna staat het bij de aflevering. Debatten met minder dan twee fragmenten ("Regeling van werkzaamheden")
slaan we over. De eerste import nam alle debatten mee (vanaf 30 maart 2026, toen
ruim 1000) als archief. Een debat kost geen GPU: in het archief gaat het voor de
opnames die door Whisper moeten, maar een nieuwe vergadering gaat altijd voor. gehoord.de waarschuwt: automatische
transcriptie, sprekers soms een paar seconden ernaast; niet citeren als
officieel verslag (dat zijn de Handelingen). Dat staat ook bij het transcript.

## Audio en video

Overgenomen uit audioscraper; de code staat in `src/audio/`.

| Soort | Adres | Hoe |
|---|---|---|
| Raadsvergadering, Company Webcast | `channel.royalcast.com/<gemeente>/` | archief via de portaal-API; de mp3 (of mp4) van de vergadering |
| Raadsvergadering, Notubiz | `<gemeente>.raadsinformatie.nl` (of `<gemeente>.notubiz.nl`, dat naar hetzelfde archief wijst) | agenda via api.notubiz.nl; ffmpeg haalt alleen het geluid uit de HLS-stream |
| Raadsvergadering, iBabs | `<gemeente>.bestuurlijkeinformatie.nl` | agenda uit de kalender van het portaal, de opname uit de openbare babscast-API (HLS, alleen het geluid), of de mp3's bij de agendapunten, samengevoegd (Westerwolde) |
| Raadsvergadering, GemeenteOplossingen | eigen domein, bijv. `gemeenteraad.groningen.nl` | agenda via de open API `/api/v2/`; de mp3 van de open mediaserver |
| YouTube | kanaal, tab (video's, live, Shorts), afspeellijst of losse video | yt-dlp (lijst, daarna audio) |
| Podcast | RSS-feed | de audiobijlage |

Toont een iBabs-portaal bij de vergaderingen een Company Webcast-speler
(Ooststellingwerf), dan wordt de bron dat Company Webcast-kanaal. Een andere
pagina, zoals de raadspagina van een gemeentesite, mag ook: daarin wordt een link
naar een van deze platforms gezocht (een videokanaal gaat voor een documentportaal).
Of een iBabs-vergadering een opname heeft, staat alleen op haar eigen pagina; het
portaal vraagt 5 seconden tussen verzoeken (robots.txt). Daarom onthoudt de
Regiochecker welke pagina's hij al zag en slaat hij agendasoorten zonder speler
over (zoals "Openbaarmaking collegevergadering"); de eerste import kijkt minstens
120 dagen terug, een vervolgcontrole precies zo ver.

**Verwerking** (`src/audio/verwerking.mjs`): bronnen worden elk uur gecontroleerd.
De eerste keer gaan alleen de nieuwste paar afleveringen in de wachtrij (bij het
toevoegen te kiezen, of "alle beschikbare"); de rest van de catalogus telt als
gezien. Daarna, één aflevering tegelijk (één gedeelde GPU): downloaden en omzetten
naar een mono-mp3 (64 kbit/s, zo'n 29 MB per uur), transcriberen met
stemherkenning, namen zoeken in delen van het transcript (alleen als dat aanstaat,
zie hieronder), en de AI-samenvatting.
Die drie gebeuren per aflevering direct na elkaar: een begonnen aflevering wordt
eerst helemaal afgemaakt, daarna komt de volgende, in de volgorde van de bronnen
(in te stellen bij Beheer › Audio) en het nieuwste eerst. Namen zoeken en
samenvatten wachten als de GPU bezig is (Plaud, Storyteller); de verwerking
begint dan niet intussen aan een volgende aflevering. Afleveringen die al klaar
waren en alleen nog een samenvatting missen, komen als laatste. Tijdelijke storingen blijven herkansen met een oplopende
wachttijd; een echte fout drie keer, daarna "mislukt" met een knop **Opnieuw**.
**Pauzeer alles** legt de verwerking stil; een bron pauzeren stopt alleen het
zoeken naar nieuwe afleveringen. Een deel dat al naar de worker is, maakt de
worker nog af (tot ongeveer vier minuten GPU); de worker kent geen afbreken.

**Spelwacht: niet transcriberen als er gegamed wordt.** De GPU-machine is ook een
spel-pc. Het script `scripts/windows/spelwacht.ps1` draait daar en kijkt om de
vijf seconden of er een spel draait. Een spel is:
- een programma met een venster uit een spelbibliotheek (Steam, Epic, GOG,
  Xbox-app, EA, Ubisoft, Riot);
- of een programma dat langer dan 20 seconden meer dan 40% van de GPU voor 3D
  gebruikt.

Browsers, OBS, Discord, launchers en Wallpaper Engine tellen nooit.

Start er een spel, dan gebeurt dit:
1. Spelwacht stopt de worker meteen, ook midden in een deel, zodat de GPU
   direct vrij is.
2. Spelwacht haalt de modellen uit het geheugen van Ollama.
3. Spelwacht antwoordt zelf op de poort van de worker: `/health` geeft
   `{ status: "paused", reason: "game", game, since }`.

De Regiochecker leest dat antwoord (`src/audio/spel.mjs`) en doet zolang:
- **Niets nieuws**: geen transcriptie, stemmen of namen.
- **Geen Ollama**: geen samenvatting, omdat Ollama op dezelfde machine draait.
  De weekmail noemt dan de reden.
- **Geen mislukte poging**: een afgebroken deel staat weer in de wachtrij, en de
  delen die al klaar waren, blijven bewaard.

Beheer › Audio toont "Gepauzeerd: er wordt gegamed". Is het spel drie minuten
dicht, dan start Spelwacht de worker weer via diens geplande taak, en gaat de
Regiochecker vanzelf verder.

Spelwacht installeren op de GPU-machine:
- **Kopiëren**: zet `spelwacht.ps1` en `installeer-spelwacht.ps1` in één map,
  bijvoorbeeld bij de worker.
- **Proberen**: `powershell -ExecutionPolicy Bypass -File spelwacht.ps1 -Proef`
  laat elke vijf seconden zien wat Spelwacht ziet, zonder iets te doen.
- **Installeren**: start PowerShell als administrator en voer uit:
  `powershell -ExecutionPolicy Bypass -File installeer-spelwacht.ps1`. Dat maakt
  de geplande taak "Spelwacht" (bij het aanmelden, verborgen, met de hoogste
  rechten) en een firewallregel voor poort 8765, en start de taak.
- **Weghalen**: hetzelfde met `-Verwijder`.
- **Logboek**: `%LOCALAPPDATA%\Spelwacht\spelwacht.log`.
- **Aanpassen** (bovenaan het script): spellen buiten de bibliotheken
  (`$ExtraProgrammas`, `$ExtraMappen`), programma's die nooit tellen
  (`$GeenSpel`), en de drempel en tijden.

De herkenning en het antwoord zijn getest zonder Windows:
`docker run --rm -v "$PWD/scripts/windows:/s" mcr.microsoft.com/powershell pwsh -File /s/spelwacht.tests.ps1`.

**AI-samenvatting**: na de namen maakt het taalmodel van Instellingen ›
Samenvatting (Claude of Ollama) een samenvatting van de hele opname in hooguit
100 woorden (`vatKortSamen` in `src/vergadering.mjs`). Die staat in het
leespaneel onder de speler, boven het transcript, met het kopje
"AI-samenvatting". De worker heeft zelf geen route om samen te vatten. Daarom
gebeurt dit in de Regiochecker, als derde stap per aflevering: nooit
tegelijk met een eigen transcriptie, bij Ollama alleen als de GPU van de worker
vrij is, en het model gaat daarna meteen uit het geheugen (`keep_alive: 0`).
Bij Ollama gebruikt dit het **model voor opnames** (Instellingen › Samenvatting,
`ollama.modelOpnames`), met een contextvenster van hooguit 16k tokens. Een klein
model dat helemaal op de GPU past, is hier tientallen keren sneller dan een groot
dat deels op de processor draait: qwen3.5:9b (het model van de worker) deed een
stuk transcript van 4.000 tokens in 11 seconden, qwen3.6:35b in 277. Een
transcript dat niet in het contextvenster past, wordt eerst per deel tot
aantekeningen teruggebracht. Lukt een samenvatting drie keer niet, dan blijft de
aflevering zonder; de aflevering zelf mislukt daar nooit door.

**Video in het leespaneel.** Heeft het platform beeld, dan staat de video van
de vergadering in het leespaneel, met de spelerbalk eronder (afspelen, −15 s,
tempo, beeldvullend, de agendapunten of treffers als streepjes, wie er spreekt); een klik op een
tijd in het transcript, bij Sprekers of bij een treffer zet de video daar, en de
lopende beurt licht op. Company Webcast geeft een mp4 (ondertekende link van een
dag, dus elke keer opnieuw opgezocht), Notubiz en iBabs (babscast) een HLS-stream
die met hls.js speelt (`public/vendor/`). Het transcript komt uit dezelfde opname,
dus de tijden zijn dezelfde (bij Company Webcast zijn de mp3 en de mp4 even lang).
GemeenteOplossingen en de mp3's per agendapunt (Westerwolde) hebben alleen
geluid: daar blijft de eigen audio (zolang die bewaard is). Bij een Kamerdebat
werkt het net zo, met de video van Debat Direct (zie Kamerdebatten).

**Agenda en sprekers van het vergaderplatform** (`platform` bij de aflevering):
Company Webcast geeft de agendapunten (topics) en per spreker de spreekmomenten,
in kloktijd vanaf `actualStart`; Notubiz de agendapunten met `start_offset` in
seconden (via `api.notubiz.nl/events/meetings/<id>`) en de spreekmomenten onder
"Nu aan het woord" op de vergaderpagina (`speaker_index` met `start_offset` en
`end_offset`; de API geeft die niet; "Vries de, Jannewietske" wordt "Jannewietske
de Vries"); babscast de tijdlijn (`TimelineEvents` van het soort Topic).
GemeenteOplossingen geeft via de open API geen agenda met tijden.

**Een mp3 per agendapunt** (Westerwolde). Het iBabs-portaal heeft daar geen
speler, maar zet bij elk agendapunt een bijlage "Geluidsbestand agendapunt 1 -
Opening" (`/Document/View/<id>`). Die bestanden samen zijn de vergadering: bij het
downloaden halen we ze op volgorde op (met de Crawl-delay van het portaal),
voegen ze met ffmpeg samen tot één opname, en maken de agenda met tijden uit de
lengte van elk deel. Een opname kan er tot een week na de vergadering bij komen;
tot dan kijken we bij elke controle opnieuw.

Sinds 28 oktober 2026 zitten de Notubiz-portalen (`*.raadsinformatie.nl`)
achter een Cloudflare-controle; de API (`api.notubiz.nl`) niet. Daar gaan we
niet omheen: de opname komt uit de API (`/media?event_id=…`, streamer en
streamnaam), net als de agenda, en de catalogus gebruikt de organisatie die bij
de bron is onthouden (`audio.organisatie`). Alleen de spreekmomenten staan
uitsluitend op de pagina: die komen pas als de pagina weer te lezen is (een
recente vergadering wordt dertig dagen lang elke dag opnieuw bekeken). Een
nieuwe Notubiz-bron toevoegen lukt zolang de controle er staat niet, want de
organisatie staat alleen op het portaal.

De platformgegevens worden opgehaald bij het downloaden; voor een opname die al binnen was, in de stap na
het transcript. Haalt de Regiochecker meer uit een platform dan eerst
(`PLATFORM_VERSIE` in `src/audio/vergaderingen.mjs`), dan krijgen afgeronde
vergaderingen dat alsnog, één tegelijk vóór ander werk (het is maar een
paginabezoek), met de namen voor de stemmen. Notubiz vult de spreekmomenten vaak
pas dagen na de vergadering in: ontbreken ze bij een vergadering van de laatste
dertig dagen, dan kijkt de Regiochecker elke dag opnieuw.

**Namen zoeken met AI** (personen, plaatsen, organisaties via `/v1/entities` van
de worker) staat standaard uit, bij Instellingen › Audio en video aan te zetten.
Het kost bij een lange vergadering een kwartier GPU-tijd, en de namen van
sprekers komen uit de gegevens van het vergaderplatform.

**De eerste import** (`audio.eersteImport`): de zoveel nieuwste afleveringen,
0 voor alles, of -1 ("Geen: alleen nieuwe afleveringen") voor niets uit het
archief, alleen wat er daarna bij komt. **Nieuw na de eerste import** is alleen
wat niet ouder is dan de oudste aflevering uit die eerste catalogus
(`audio.ondergrens` bij de bron). Een
catalogus van "de nieuwste honderd" kan een stukje terugschuiven, bijvoorbeeld
als een vergadering van vandaag nog niet is geweest. Wat daardoor alsnog
opduikt, is achterstand en gaat niet in de wachtrij.

**Het hele archief** (vinkje in het bewerkvenster van een audiobron, of `PUT
/api/beheer/bronnen/<id>` met `archief: true`): de catalogus wordt gelezen zoals
bij een eerste import van alles, en wat nog niet in de database staat, gaat
alsnog als archief (nulmeting) in de wachtrij; ook wat bij "alleen nieuwe" als
gezien was gemarkeerd. Na de gewone controles, hooguit één bron per kwartier (het
lezen van een iBabs-archief duurt met vijf seconden per pagina een paar uur);
mislukt het drie keer, dan stopt het en staat de fout bij de bron. **Volgorde in
de wachtrij:** eerst wat nieuw is, in de volgorde van de bronnen; het archief
daarna, het nieuwste eerst over alle bronnen heen, zodat van elke gemeente eerst
het recente verleden binnenkomt. Binnen het archief gaat wat geen GPU kost (een
Kamerdebat) voor. Een archiefopname die al ouder is dan de
bewaartermijn van de audio, verliest haar audio direct na het transcriberen (het
transcript blijft); anders zou een heel archief de schijf vullen.

Sinds 30 oktober 2026 staat voor alle raadsvergaderingen het hele archief aan, op
verzoek van de opdrachtgever.

**Lange opnames** gaan in delen van 45 minuten naar de worker (met een paar
seconden overlap; het laatste deel neemt de rest mee, dus pas vanaf zo'n 56
minuten). Een vergadering van ruim drie uur in één keer liet de worker crashen.
Elk deel wordt meteen bewaard (`transcript_delen`), zodat het na een storing
verdergaat bij het volgende deel; daarna worden de delen één transcript met
tijden vanaf het begin. Een sprekersbeurt die in de overlap begint en daarna
doorloopt, blijft staan; de woorden die letterlijk al aan het eind van het
vorige deel stonden, gaan eruit. Een stem zonder profiel geldt alleen binnen zijn deel;
een stemprofiel geldt in de hele opname. De lengte van een deel is in te stellen
met `AUDIO_DEEL_S` (seconden).

**Audio bewaren**: standaard alleen van raadsvergaderingen (om terug te luisteren
in het leespaneel), 180 dagen; daarna blijft het transcript. YouTube speelt af bij
YouTube (tijden openen de video op dat moment), een podcast bij de bron.

**Telefoonnummers**: herkend in elk transcript (ook uitgesproken: "nul zes …",
alleen met "bel" of "nummer" in de buurt; geen IBAN's). Wie erachter zit komt uit
een vaste lijst openbaar gecontroleerde bedrijfsnummers, uit een beoordeling door
de redactie, of als suggestie van de worker op basis van het transcript (alleen
als er verder niets te doen is). Audioscraper zocht daarnaast via DuckDuckGo en
Bing naar bedrijfspagina's; dat doet de Regiochecker niet, omdat die zoekmachines
zulk automatisch zoeken niet toestaan.

**GemeenteOplossingen en Anubis.** De vergaderpagina's van gemeenteraad.groningen.nl
staan achter Anubis, een proof-of-work-poort tegen automatische bezoekers. De
agenda komt uit de open API; alleen het opzoeken van de bestandsnaam van de
opname gaat langs de poort, zoals audioscraper deed: één pagina per vergadering,
met een eerlijke user-agent (`Regiochecker/1.0`), de Crawl-delay uit de robots.txt
van het portaal, en de verkregen cookie hergebruikt. Dat is een uitdrukkelijke
keuze van de opdrachtgever (eerder gemaakt voor audioscraper), op 30 oktober 2026
ook voor Tynaarlo (raad.tynaarlo.nl). Alleen voor de opnames: de stukken op die
portalen (zoals de ingekomen stukken) halen we niet langs de poort.

**De Whisper-worker** (de Plaud Whisper Worker met de audio-uitbreiding, zie
`deploy/` in de audioscraper-repository) draait in het thuisnetwerk en is via de
Tailscale-container bereikbaar. Adres en token vul je in bij Beheer › Instellingen
(of `WORKER_URL` en `WORKER_TOKEN` in `.env`); **Verbinding testen** controleert ook
het token. Zonder worker blijft alles in de wachtrij staan.

## Inhoud achter de links

De samenvatting gaat niet alleen over titels, en het leespaneel toont onder
**Uit het document** het hele stuk. Na elke controleronde haalt de dienst het
document op van nieuwe berichten van de afgelopen twee weken, en van berichten tot
twee maanden oud die er nog geen hebben (`src/inhoud.mjs`, maximaal 80 per ronde,
drie pogingen per bericht). Opent iemand een ouder stuk, dan haalt het leespaneel
het document alsnog op (`GET /api/stuk/document`).

| Bron | Wat we lezen |
|---|---|
| Nieuws (alle gemeenten) | de tekst van het artikel, plus pdf-bijlagen in het artikel |
| iBabs (Heerenveen, Opsterland, Oost- en Weststellingwerf) | de brief en de bijlagen (pdf via `/Document/View/<id>`); zonder leesbare pdf de gegevens van de pagina |
| Notubiz (Smallingerland) | het hoofddocument via de API; brieven van inwoners hebben er geen |
| B&W-besluiten Groningen | de pdf |
| Woo Groningen | omschrijving plus het besluit (pdf), via de API van het portaal |
| Woo Smallingerland | de pagina plus de pdf's erop |
| Súdwest-Fryslân, ingekomen en Woo | niets: alleen het onderwerp staat online |
| iBabs-agenda (Borger-Odoorn, Schiermonnikoog) | de pdf van de brief (`/Document/View/<id>`) |
| HTML-lijst (nieuws en Woo-pagina's) | de pagina of de pdf achter de link |
| Woo via eData-loket, publicatieplatform, STACK, Djuma, Mozard | niets: de link gaat naar een app, niet naar het stuk (`inhoud: false`) |

Het document (`src/document.mjs`) is een lijst blokken: koppen, alinea's,
opsommingen en het begin van elke bijlage, tot 300.000 tekens en vijf bijlagen
(pdf's tot 150 pagina's). HTML heeft zijn eigen structuur; een pdf niet, want
pdftotext geeft de regels zoals ze op de pagina staan. Een regel die duidelijk
korter is dan de rest en een zin afsluit, sluit daar een alinea af; een korte
losse regel boven een lange alinea is een kop; korte regels na elkaar (een adres,
de kop van een brief) blijven bij elkaar. Kamerstukken gaan op dezelfde manier.
Het document staat in `regiochecker.sqlite` zolang het bericht bestaat.

Geeft het stuk zelf een 404 of 410, dan heeft de bron het weggehaald. Het blijft
in de feed staan met het label "Verwijderd bij de bron", de tekst zoals die eerder
is opgehaald, en een knop naar het Internet Archive in plaats van naar de bron.

Voor de samenvatting gaan de eerste 6000 tekens daarvan als platte tekst mee
(`inhoud` in `data/items.json`); die gaat er na vijf weken weer af. Een mislukte
poging staat als `inhoudFout` bij het bericht.

## Samenvatting: Claude of Ollama

Onder Instellingen → Samenvatting kies je Claude, een eigen Ollama, of uit.
Beide krijgen dezelfde instructie en hetzelfde JSON-schema (`src/samenvatting.mjs`).
Per bericht gaan titel, kenmerken en maximaal 3000 tekens inhoud mee. Eén aanroep
per regio per verstuurmoment; twee verslaggevers op dezelfde regio delen die
aanroep (cache in `data/samenvattingen.json`).

Lange acties (voorbeeld met samenvatting, versturen, mailronde, controleren)
draaien in de webUI als taak op de achtergrond, met voortgang. Een gewoon verzoek
breekt Cloudflare na 100 seconden af, en een samenvatting via Ollama duurt per
gemeente al gauw een paar minuten.

**Claude** (`claude-opus-5-5`, effort `medium`). Met de inhoud erbij gaat het om
zo'n 20.000 tot 40.000 tokens per gemeente per week; grove schatting: tien tot
twintig dollarcent per gemeente per week. Meet het in de Anthropic-console.

**Ollama** draait op een eigen machine in het tailnet. Deze server zit zelf niet
in het tailnet; daarvoor draait naast de Regiochecker de container
`regiochecker-tailscale` (userspace-modus, geen extra rechten), met een HTTP-proxy
op een eigen Docker-netwerk. Alleen het verkeer naar Ollama en de Whisper-worker
gaat daardoorheen.

Eenmalig koppelen:

1. **Tailscale.** Of: maak in https://login.tailscale.com/admin/settings/keys een
   auth-key, zet die als `TS_AUTHKEY=…` in `tailscale.env` (zie
   `tailscale.env.example`, `chmod 600`) en `docker compose up -d`. Of: draai
   `./tailscale-inloggen.sh` en open de link die het geeft. (De link uit
   `docker compose logs tailscale` werkt niet: de container geeft een
   interactieve login maar 60 seconden en herstart dan met een nieuwe link.)
   De machine heet `regiochecker`
   in je tailnet; de status blijft bewaard in `./tailscale`. Wie het strak wil:
   een ACL die `regiochecker` alleen toegang geeft tot poort 11434 (Ollama) en
   8765 (Whisper-worker) van die machine.
2. **Ollama luistert standaard alleen op localhost.** Zet op de Ollama-machine
   `OLLAMA_HOST=0.0.0.0` (of het 100.x-adres van die machine) en herstart Ollama.
   Ollama heeft geen eigen inlog; via het tailnet is dat geen probleem, maar zet
   poort 11434 niet open naar het internet.
3. **In de webUI** de URL invullen (`http://<machinenaam>:11434` of het
   100.x-adres), op "Verbinding testen" klikken, een model kiezen, bewaren.

Een model met structured outputs is nodig (Ollama 0.5 of nieuwer). De vraag per
gemeente bevat een week aan berichten; het contextvenster (`num_ctx`) groeit
mee tot het ingestelde maximum (standaard 32.768 tokens). Past het niet, dan
worden de artikelteksten ingekort; titels en kenmerken blijven altijd staan.
Een lokaal model doet er al gauw minuten over; de dienst wacht maximaal een
kwartier per regio.

## Beheer

Code: https://github.com/basvroegop/regiochecker (openbaar; geheimen staan alleen
in `data/`, `.env` en `tailscale.env`, die buiten git blijven). Pushen gaat met een
eigen deploy key: `Host github-regiochecker` in `/root/.ssh/config`.

```sh
cd /opt/regiochecker
docker compose up -d --build          # bouwen en (her)starten
docker compose logs -f                # meekijken
docker compose exec regiochecker npm test
docker compose exec regiochecker npm run verzamel   # proefronde: wat levert elke bron op (slaat niets op)
```

Eerste keer, na het aanmaken van de hostnaam: `docker restart traefik-companion`,
zodat het DNS-record wordt aangemaakt.

### Gebruikers en inloggen

Beheer › Gebruikers: per persoon rol (journalist of admin), **titel** (LC of DVHN:
bepaalt de huisstijl), regio's en weekmail. **+ Uitnodigen** zet iemand erin met
e-mailadres (en eventueel inlognaam); bij de eerste keer inloggen koppelt de
Regiochecker de inlog van Authelia aan die uitnodiging (op e-mailadres of
inlognaam). Wie niet is uitgenodigd, krijgt een nette weigering. Is er nog geen
beheerder, dan wordt de eerste die inlogt beheerder. Iemand zonder inlog kan
alleen de weekmail krijgen.

**Authelia-accounts bij uitnodigen** (sinds 30 oktober 2026, aan met
`REGIOCHECKER_AUTHELIA_ACCOUNTS=1`). Uitnodigen maakt ook het account in
Authelia aan en mailt daarna de uitnodiging (afzender: de SMTP onder
Instellingen). Vul je geen inlognaam in, dan komt die uit het e-mailadres
(`anneke.de.wit@…` → `anneke.de.wit`, bezet → `anneke.de.wit2`). Heeft iemand met
dat e-mailadres al een Authelia-account, dan wordt dat gebruikt en zegt de mail
dat. Het wachtwoord kiest de nieuwe gebruiker zelf: de mail legt uit hoe, via
**Wachtwoord opnieuw instellen?** op het inlogscherm (Authelia mailt dan een
link die vijf minuten werkt). Bij de gebruiker staat hoe ver het is (account
wordt aangemaakt, uitnodiging gemaild, of de fout); de knop **Uitnodigen** in de
rij doet het opnieuw. Verwijderen zet het Authelia-account uit, maar alleen als
het in de groep `checker` zit; opnieuw uitnodigen zet het weer aan. Een
gewijzigd e-mailadres of een andere naam gaat niet mee naar Authelia.

Zo werkt het. De Regiochecker schrijft zelf niet in het gebruikersbestand van
Authelia: daar logt ook de wiki op in, en wie de Regiochecker zou overnemen,
kan dan elk account maken of wijzigen. De app zet een aanvraag in
`data/authelia/aanvragen/` (`src/accounts.mjs`). Een systemd-pad-unit op de
server start dan `scripts/authelia-accounts.py` (als root, zonder netwerk, en
alleen met schrijfrecht op `/opt/authelia/config` en `data/authelia`). Dat
script doet bewust weinig:
- het maakt alleen nieuwe accounts, altijd in de groep `checker`, met een
  willekeurig wachtwoord dat niemand kent;
- het zet alleen `checker`-accounts uit of weer aan;
- het controleert de aanvraag streng en volgt geen symlinks.

Het script leest en schrijft het hele YAML-bestand, zoals Authelia zelf doet na
een nieuw wachtwoord (opmerkingen in dat bestand verdwijnen dus), en laat de
vorige versie staan als `users_database.yml.vorige`. Authelia leest het bestand
vanzelf opnieuw in (`watch: true`). De uitslag komt in `data/authelia/klaar/`;
de Regiochecker haalt die elke 15 seconden op. Installeren of bijwerken:

```sh
cp scripts/systemd/regiochecker-accounts.* /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now regiochecker-accounts.path
journalctl -u regiochecker-accounts.service   # wat het script deed
```

Authelia zelf staat in `/opt/authelia/config/`: `users_database.yml` voor de
accounts, `configuration.yml` met de regel voor `checker.mh-n.nl` en de SMTP
voor de mails van Authelia (afzender Regiochecker, wachtwoord in
`/opt/authelia/.env`). Elk Authelia-account mag op de site; binnen komt alleen
wie hier ook een account heeft. Op 30 oktober 2026 kreeg iedereen met een
Authelia-account er een, ook de gebruikers van de Verhalenplanner
(verhalen.mh-n.nl): die zijn met hun wachtwoord van daar in Authelia gezet (de
scrypt-hash van de Verhalenplanner, omgeschreven naar het `$scrypt$`-formaat dat
Authelia leest), in de groep `checker`. Wie daar nog geen wachtwoord had
gekozen, kreeg geen account. Een wachtwoord dat iemand later in de
Verhalenplanner wijzigt, gaat niet vanzelf mee.

### Regio's, bronnen en audio

- **Regio's**: per regio de lokale bronnen met hun status, de sleutelwoorden (met
  een live voorbeeld bij het intypen) en wie de regio volgt. Een eigen regio
  toevoegen kan; de zeven ingebouwde staan in de code, met hun eigen bronnen.
  Sinds 30 oktober 2026 zijn alle gemeenten van Fryslân, Groningen en Drenthe
  een regio (40). De 33 toegevoegde staan niet in de code maar in
  `data/regios.json` en `data/bronnen.json` (toegevoegd via Beheer): nieuws bij
  alle 33 (27 via RSS, 6 via `html-lijst`), ingekomen stukken (of als
  vervangende bron raadsinformatiebrieven en memo's) uit iBabs of Notubiz bij
  32, Woo bij 22, en de vergaderingen van alle 33 (22 Company Webcast, 8
  Notubiz, Stadskanaal en Westerwolde via iBabs, Tynaarlo via
  GemeenteOplossingen); eerst met "alleen nieuwe", sinds 30 oktober met het
  hele archief (zie Audio en video). Pekela zendt niet live uit maar zet de
  video achteraf in Notubiz; zo'n vergadering telt mee als `/media` iets heeft.
  Daarnaast
  krijgen ze de bekendmakingen van de provincie Fryslân voor hun gemeente, de
  signalen met een plek (KNMI, ransomware, Raad van State, verkeer,
  inzendingen) en wat via hun sleutelwoorden binnenkomt. Een regio heet naar de gemeente: hernoem hem niet,
  anders vindt de routering de gemeentegrens niet meer. Een nieuwe regio krijgt
  meteen de bekendmakingen die al voor die gemeente binnen waren.
- **Bronnen**: het register van alle bronnen, landelijk en gemeentelijk, met
  status en het aantal nieuwe stukken in zeven dagen. **Bron toevoegen**: bereik,
  soort, type, adres, proefronde, opslaan. Zelf toegevoegde bronnen zijn te
  wijzigen (naam, bereik, bij audio pauzeren) en te verwijderen. Via de API
  (`POST /api/beheer/bronnen`) kan ook een Notubiz-module (`lezer:
  'notubiz-ingekomen'` met `organisatie`, `module` en `moduleNaam`, uit
  `api.notubiz.nl/organisations/<id>/modules`), een vervangende bron
  (`vervangend: true`) en een Notubiz-vergaderarchief met de organisatie vooraf
  (`organisatie`; het portaal zelf zit achter een Cloudflare-controle). Ook de
  lezers voor sites zonder feed gaan alleen via de API: `html-lijst` (met
  `link` en de opties hierboven bij Bronnen), `ibabs-agenda` (`agendatype`, de
  id uit `agendatype-<id>` in de iBabs-kalender, en eventueel `punt`),
  `divault` (`organisatie`, `categorie`), `publicaties` (`subdomein`) en
  `edataloket`, `stack`, `djuma`, `mozard`, `recentjson` (alleen het adres).
  `datumBijEersteZicht: true` geeft stukken zonder datum de dag waarop ze
  verschijnen; dat kan ook achteraf, met `PUT /api/beheer/bronnen/<id>`.
- **Audio**: workerstatus, wat er nu gebeurt, de wachtrij, mislukte afleveringen
  en de volgorde van de bronnen.
- **Teams**: kanalen in Microsoft Teams die meekrijgen wat er binnenkomt (zie
  hieronder).
- **Telegram**: de bot voor tipgevers, met de chats die op goedkeuring wachten
  (zie hieronder).
- **Instellingen**: controle-interval, standaard weekmail, SMTP, samenvatting
  (Claude of Ollama), de Whisper-worker en hoe lang audio bewaard blijft.
  Wachtwoorden, sleutels en tokens gaan nooit terug naar de browser.

### Teams-kanalen

Overgenomen uit de checker (`src/kanalen.mjs`). Een admin koppelt bij Beheer ›
Teams een kanaal en kiest wat erheen gaat:

- **Regio's**: geen vinkje is alle regio's. Een landelijke bron stuurt alleen
  wat via een sleutelwoord of plek bij een van die regio's hoort, net als in de
  feed.
- **Bronnen**: per soort (de tabbladen van de feed: Gemeentenieuws, Ingekomen,
  Woo, Raadsvergaderingen, Kamerstukken, Kamerdebatten, KNMI, Raad van State,
  Ransomware, …) "Alles uit",
  wat ook geldt voor bronnen die er later bij komen; of losse bronnen. Niets
  aangevinkt is alle bronnen.

Na elke ronde (websites, kamerstukken, audio) gaat wat er sinds de vorige keer
binnenkwam als Adaptive Card naar het kanaal: titel, regio en soort, het begin
van de tekst (bij audio de AI-samenvatting), datum, bron, bij ransomware de
vestiging, en knoppen naar de Regiochecker en de bron. Zijn het er in één
keer meer dan tien, dan krijgen de tien nieuwste een eigen kaartje en staan de
oudere samen in één overzicht. Een nieuw kanaal, of een kanaal dat weer aan
gaat, begint vanaf dat moment. Lukt het versturen niet, dan probeert de
volgende ronde het opnieuw, zonder wat al was aangekomen; de fout staat bij het
kanaal en één keer in het logboek. **Proef** stuurt een proefbericht.

Koppelen gaat via een workflow in Teams (de oude Office 365-connectors bestaan
niet meer): bij het kanaal ••• › Workflows › *Post to a channel when a webhook
request is received*, team en kanaal kiezen, en het adres aan het eind
kopiëren. Wie dat adres heeft, kan in het kanaal berichten zetten. Het staat
daarom alleen in `data/kanalen.json`, gaat nooit terug naar de browser en komt
niet in het logboek; bij Wijzig leeg laten houdt het oude adres.

### Telegram: inzendingen van tipgevers

De DVHN-bot uit de checker (`src/telegram.mjs`). 112-fotografen en andere
tipgevers sturen foto's, video's, tekst of een locatie naar een Telegram-bot,
1-op-1 of in een groep waar de bot in zit. In de checker heeft de bot nooit
gedraaid (er stond geen token).

- **Instellen** bij Beheer › Telegram: een bot maken via @BotFather en het token
  plakken (of `TELEGRAM_BOT_TOKEN` in `.env`). De Regiochecker haalt de
  berichten zelf op (long polling); de site zit achter Authelia, en een webhook
  zou een openbare uitzondering vragen. Heeft de bot al een webhook (de checker,
  of een andere server), dan neemt de Regiochecker hem niet over maar meldt dat.
- **Goedkeuren**: een nieuwe chat wacht. De inzender krijgt daar een bericht
  over, met (1-op-1) een knop om het telefoonnummer te delen. Een admin keurt
  goed of blokkeert; @gebruikersnamen en nummers van personen of groepen kunnen
  ook vooraf. Berichten van vóór de goedkeuring worden niet bewaard.
- **Inzendingen** worden stukken onder het tabblad **Ingezonden**: de eerste
  regel van het bericht als kop, de foto's en video's in het leespaneel
  (`data/ingezonden/`, alleen voor wie is ingelogd), en telefoon en
  @gebruikersnaam van de inzender bij de gegevens. Een album wordt één stuk; een
  aangepast bijschrift werkt het stuk bij. De bot zet een duim omhoog bij een
  inzending die binnen is (uit te zetten).
- **Regio**: een gedeelde locatie, of een plaatsnaam met een woord ervoor ("brand
  in Gorredijk"). Zonder plaats staat een inzending bij alle regio's, zoals in de
  checker. Inzendingen gaan naar meldingen en Teams-kanalen (met inzender en
  telefoon, zonder de foto's zelf: die staan achter de inlog), niet in de
  weekmail. Ze blijven twee jaar bewaard, de foto's ook.

Niet overgenomen: het insturen via een eigen API met een token (in de checker
`POST /api/inbound/submit`, nooit gebruikt). Dat vraagt een openbare route langs
Authelia.

### Van audioscraper naar de Regiochecker

Het archief van audioscraper (projecten, afleveringen met transcripten, sprekers
en namen, gezien-lijsten, telefoonnummers met beoordelingen) neem je eenmalig
over. Mediabestanden niet; die bewaarde audioscraper toch niet.

```sh
docker compose stop regiochecker
cp /pad/naar/audioscraper/data/audioscraper.sqlite3 data/   # van de machine waar audioscraper draait
docker compose run --rm regiochecker node src/importeer-audioscraper.mjs /app/data/audioscraper.sqlite3
docker compose up -d regiochecker
```

Een project wordt een audiobron met als bereik de regio waarvan de naam in de
projectnaam of het adres staat, en anders landelijk; pas dat zo nodig aan bij
Beheer › Bronnen. Wat al eerder is overgenomen, wordt overgeslagen. Stemnamen
staan in de worker zelf en blijven dus gelden.

### Data

Alles staat in `data/`. Back-up = die map kopiëren (de `.sqlite`-bestanden bij
voorkeur met de dienst gestopt).

| Bestand | Inhoud |
|---|---|
| `instellingen.json` | SMTP, Claude-sleutel, Ollama, Whisper-worker, standaard weekmail |
| `gebruikers.json` | journalisten en beheerders: rol, titel, regio's, weekmail, vorige mail |
| `regios.json` | per regio sleutelwoorden en uitgezette landelijke bronnen; eigen regio's |
| `bronnen.json` | via de webUI toegevoegde bronnen (ook audio en video) |
| `items.json` | alles wat de websites opleverden, met `eersteGezien` |
| `status.json` | per bron de laatste ronde; laatste mailronde |
| `meldingen.json` | directe meldingen per gebruiker |
| `kanalen.json` | Teams-kanalen: workflowadres, regio's, bronnen, laatste verzending |
| `telegram.json` | Telegram-bot: chats met hun status, inzenders (telefoon), vooraf goedgekeurd |
| `ingezonden/` | foto's en video's van inzendingen, per stuk |
| `logboek.json` | verzonden mails, meldingen en fouten |
| `samenvattingen.json` | cache van Claude- en Ollama-antwoorden |
| `kamerstukken.sqlite` | de kamerstukken met zoekindex |
| `regiochecker.sqlite` | gelezen/bewaard/notities per gebruiker; het hele document achter elk bericht; het audioarchief (afleveringen, transcripten, namen, telefoonnummers) |
| `audio/` | bewaarde audio (mp3), per aflevering |
| `youtube-cookies.txt` | optioneel: als YouTube om een inlog vraagt, gebruikt yt-dlp dit |

Tot oktober 2026 stonden de ontvangers in `ontvangers.json` en de termen voor
kamerstukken in `kamertermen.json`; die zijn bij de eerste start omgezet naar
`gebruikers.json` en `regios.json` en blijven staan als back-up.

De Tailscale-identiteit van de sidecar staat apart in `./tailscale`.

### Beveiliging

- Inloggen gaat via de gedeelde Authelia in `/opt/authelia` (authelia.mh-n.nl,
  sessiecookie voor `mh-n.nl`), met de Traefik-middleware `authelia@docker`. Op 30
  oktober 2026 (de verhuizing naar checker.mh-n.nl) is daar de toegangsregel voor
  `checker.mh-n.nl` gekomen, zijn de accounts uit de Verhalenplanner toegevoegd
  (groep `checker`), en zijn de cookie en inlogpagina voor `vroeg.app` van 26
  oktober weer weggehaald. Wiki.js logt via OIDC in op dezelfde Authelia en maakt
  bij elke inlog zelf een account aan; een eigen OIDC-beleid (`wiki`) houdt de
  groep `checker` daarom buiten de wiki. Daarna kwamen `watch: true` op het
  gebruikersbestand en SMTP voor 'wachtwoord opnieuw instellen' erbij (het
  accountscript hierboven). Terugdraaien: de bestanden uit
  `/opt/authelia/backups/accounts-smtp-*` (of eerder `checker-mhn-*`)
  terugzetten en daar `docker compose up -d --force-recreate`.
- Vóór Authelia haalt Traefik de `Authorization`-kop weg (middleware
  `regiochecker-zonder-basic`), anders kreeg een browser met oude basic-auth-
  gegevens een wachtwoord-pop-up in plaats van het inlogscherm.
- De API weigert verzoeken zonder de `Remote-User`-koptekst die Traefik na het
  inloggen meestuurt (`REGIOCHECKER_AUTH_KOP`); de middleware overschrijft wat een
  browser zelf meestuurt (ook `Remote-Email` en `Remote-Name`). Journalisten zien
  alleen hun eigen meldingen, notities en bewaarde stukken; Beheer is alleen
  voor admins.
- Alles wat de Regiochecker zelf ophaalt (bronnen, de links in een feed, bijlagen,
  opnames) gaat alleen naar openbare internetadressen, nooit naar iets in het eigen
  netwerk (`src/netwerk.mjs`). Dat wordt gecontroleerd in de URL, bij elke
  doorverwijzing, en bij het verbinden zelf (de DNS-uitkomst), zodat ook een naam
  die naar binnen wijst niet werkt. ffmpeg leest een stream alleen via HTTPS-HLS
  zonder doorverwijzingen. Alleen de tests mogen naar 127.0.0.1
  (`REGIOCHECKER_PRIVE_ADRESSEN=1`).
- "De eerste die inlogt, wordt beheerder" geldt alleen bij een verse installatie.
  Zodra er een beheerder is geweest (`beheerGestart` in `data/status.json`), gaat
  die deur niet meer open, ook niet als de beheerders wegvallen; de inlognaam van
  de laatste beheerder kan niet leeg. Herstellen kan dan alleen op de server, in
  `data/gebruikers.json`.
- De Tailscale-proxy staat op een eigen Docker-netwerk (`regiochecker-intern`),
  niet op het gedeelde `traefik`-netwerk.
- Schrijfacties accepteren alleen `application/json`, wat formulieren van andere
  sites tegenhoudt.
- Tekst uit de bronnen wordt overal ontsnapt (webUI en mail). Het taalmodel
  krijgt de instructie om opdrachten in de stukken te negeren.

### Als een bron stuk gaat

Gemeentesites veranderen. Een bron die faalt of ineens niets meer oplevert,
staat met "Fout" in Beheer › Bronnen (en de kop van Beheer telt ze) en onderaan
de regio in de mail. De tests in `test/parsers.test.mjs` draaien op pagina's die
op 20 oktober 2026 zijn opgeslagen in `test/fixtures/`. Sla de nieuwe pagina op
naast de oude, vergelijk, en pas de lezer in `src/bronnen/` aan. Voor audio:
YouTube verandert vaak; een nieuwe build haalt de nieuwste yt-dlp op.
