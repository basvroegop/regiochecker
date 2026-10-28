# Regiochecker

Een bronnenplatform voor de regioredactie (LC en DVHN). Een journalist logt in
en ziet één chronologische **feed** van alles uit de regio's die hij of zij volgt:
gemeentenieuws, ingekomen stukken, Woo-publicaties, Kamerstukken waarin een
sleutelwoord van de regio staat, en audio en video: raadsvergaderingen,
YouTube-kanalen en podcasts, getranscribeerd met sprekers en genoemde namen.
Daarnaast een **weekmail** per journalist met per gemeente een samenvatting van
wat er speelt, en **directe meldingen** op zoektermen.

Draait op https://regiochecker.vroeg.app. Inloggen via de Authelia op deze
server (authelia.vroeg.app). Het ontwerp volgt de overdracht uit Claude Design
(Modernist-ontwerpsysteem, `public/modernist.css`), met per titel een eigen
signaalkleur: LC paars (#482AA5), DVHN blauw (#006ED1).

Audio en video kwamen tot oktober 2026 uit de losse dienst audioscraper; die
functionaliteit zit nu in de Regiochecker zelf (`src/audio/`). Het zware werk
(Whisper, stemherkenning, namen zoeken) doet de bestaande Whisper-worker in het
thuisnetwerk, via Tailscale.

## Voor journalisten

### Feed

Links de lijst, rechts het leespaneel. Bovenaan de gevolgde regio's (klik er een
om alleen die te tonen; met **+** volg je er meer) en tabbladen per soort met
aantallen, plus **Alleen ongelezen**. Een stuk openen markeert het als gelezen;
**j**/**k** of de pijltjes lopen door de lijst, **s** bewaart.

- Elk stuk dat via een sleutelwoord of een melding binnenkwam, heeft het blok
  **Waarom staat dit in je feed?**: de term, hoe vaak hij voorkomt en de zin
  eromheen (bij audio met de tijd).
- Een raadsvergadering, video of podcast opent met speler (als de audio bewaard
  is), de treffers als streepjes op de tijdbalk, en het transcript per beurt. De
  beurt die nu speelt licht op; een tijd aanklikken springt erheen. Een spreker
  zonder naam heeft een ▶ (kort fragment van die stem) en een veld **Naam
  invullen**; zo'n naam geldt voor die stem in alle opnames, ook in Plaud. Valt
  vlak voor de eerste beurt een naam ("het woord is aan wethouder Kramer"), dan
  staat die erbij als suggestie. Tabblad **Namen** toont de genoemde personen,
  organisaties en plaatsen en de telefoonnummers.
- **Bewaren** (ster) zet het stuk onder Bewaard; een **notitie** bij een stuk is
  alleen voor jou zichtbaar.

### Zoeken en audio-archief

**Zoeken** (rechtsboven) doorzoekt alles: alle regio's, kamerstukken en
transcripten. Woorden moeten allemaal voorkomen, `"woordgroep"` als geheel, `OR`
voor alternatieven.

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
   van de regio (met de zin waarin het staat), en **Raadsvergaderingen, audio en
   video**. Bij een raadsvergadering van de gemeente zelf staat een samenvatting
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

## Bronnen

| Gemeente | Nieuws | Ingekomen stukken | Woo-publicaties |
|---|---|---|---|
| Smallingerland | `/Nieuwsarchief` (HTML) | Notubiz-module Ingekomen stukken | Subpagina's van de Woo-pagina (geen datums) |
| Opsterland | RSS | **Vervangend:** iBabs Raadsinformatiebrieven | **Niet gevonden** |
| Heerenveen | RSS `/nieuws/feed/` | iBabs Ingekomen stukken 2026-2030 | **Niet gevonden** (gemeente publiceert ze nog niet) |
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

Deze ingebouwde bronnen staan in `src/regios.mjs`, de lezers per brontype in
`src/bronnen/`. Een bron met een standaardlezer (RSS-feed, iBabs-overzicht,
Woo-platform) of een audio- of videobron voeg je toe in de webUI (Beheer ›
Bronnen); die staan in `data/bronnen.json`. Een site met een eigen opbouw vraagt
een nieuwe lezer in de code. Verander het `id` van een bestaande bron niet,
anders komt alles opnieuw binnen (al vangt de nulmeting dat op).

## Landelijke bronnen en sleutelwoorden

Elke bron heeft een **bereik**: één regio (alles gaat naar die regio) of
landelijk (een stuk gaat naar elke regio waarvan een **sleutelwoord** erin
voorkomt). Sleutelwoorden stel je per regio in (Beheer › Regio's): plaatsen,
dorpen, wijken, gebouwen. Hoofdletters en accenten tellen niet, alleen hele
woorden; een woordgroep moet als geheel voorkomen. Per sleutelwoord zie je hoeveel
stukken uit landelijke bronnen het de afgelopen 30 dagen opleverde ("Veel ruis"
bij 25 of meer). Per regio kun je een landelijke bron uitzetten ("Geldt voor").

De Tweede Kamer is de ingebouwde landelijke bron; een RSS-feed, Woo-platform of
podcast voeg je als landelijke bron toe in Beheer › Bronnen, met een
proefronde die laat zien hoeveel stukken er naar welke regio zouden gaan. Bij
audio wordt het transcript doorzocht en staat bij elke treffer de tijd.

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

## Audio en video

Overgenomen uit audioscraper; de code staat in `src/audio/`.

| Soort | Adres | Hoe |
|---|---|---|
| Raadsvergadering, Company Webcast | `channel.royalcast.com/<gemeente>/` | archief via de portaal-API; de mp3 (of mp4) van de vergadering |
| Raadsvergadering, Notubiz | `<gemeente>.raadsinformatie.nl` (of `<gemeente>.notubiz.nl`, dat naar hetzelfde archief wijst) | agenda via api.notubiz.nl; ffmpeg haalt alleen het geluid uit de HLS-stream |
| Raadsvergadering, iBabs | `<gemeente>.bestuurlijkeinformatie.nl` | agenda uit de kalender van het portaal, de opname uit de openbare babscast-API (HLS, alleen het geluid) |
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
stemherkenning, en namen zoeken in delen van het transcript. De volgorde van de
bronnen stel je in bij Beheer › Audio; een bron wordt helemaal afgemaakt voordat
de volgende aan de beurt is, binnen een bron gaat een transcript altijd vóór het
zoeken naar namen, en het nieuwste eerst. Namen zoeken wacht als de GPU bezig is
(Plaud, Storyteller). Tijdelijke storingen blijven herkansen met een oplopende
wachttijd; een echte fout drie keer, daarna "mislukt" met een knop **Opnieuw**.
**Pauzeer alles** legt de verwerking stil; een bron pauzeren stopt alleen het
zoeken naar nieuwe afleveringen.

**Lange opnames** gaan in delen van 45 minuten naar de worker (met een paar
seconden overlap; het laatste deel neemt de rest mee, dus pas vanaf zo'n 56
minuten). Een vergadering van ruim drie uur in één keer liet de worker crashen.
Elk deel wordt meteen bewaard (`transcript_delen`), zodat het na een storing
verdergaat bij het volgende deel; daarna worden de delen één transcript met
tijden vanaf het begin. Een stem zonder profiel geldt alleen binnen zijn deel;
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
keuze van de opdrachtgever (eerder gemaakt voor audioscraper).

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

Het Authelia-account zelf, en toegang tot deze site, regel je in Authelia
(`/opt/authelia/config/configuration.yml`, de regel voor `regiochecker.vroeg.app`).

### Regio's, bronnen en audio

- **Regio's**: per regio de lokale bronnen met hun status, de sleutelwoorden (met
  een live voorbeeld bij het intypen) en wie de regio volgt. Een eigen regio
  toevoegen kan; de zeven ingebouwde staan in de code.
- **Bronnen**: het register van alle bronnen, landelijk en gemeentelijk, met
  status en het aantal nieuwe stukken in zeven dagen. **Bron toevoegen**: bereik,
  soort, type, adres, proefronde, opslaan. Zelf toegevoegde bronnen zijn te
  wijzigen (naam, bereik, bij audio pauzeren) en te verwijderen.
- **Audio**: workerstatus, wat er nu gebeurt, de wachtrij, mislukte afleveringen
  en de volgorde van de bronnen.
- **Instellingen**: controle-interval, standaard weekmail, SMTP, samenvatting
  (Claude of Ollama), de Whisper-worker en hoe lang audio bewaard blijft.
  Wachtwoorden, sleutels en tokens gaan nooit terug naar de browser.

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

- Inloggen gaat via de gedeelde Authelia in `/opt/authelia`, met de Traefik-
  middleware `authelia@docker`. Voor deze site zijn daar op 26 oktober 2026
  drie dingen toegevoegd: een sessiecookie voor `vroeg.app` met inlogpagina
  `authelia.vroeg.app`, een Traefik-router voor die inlogpagina, en een
  toegangsregel voor `regiochecker.vroeg.app`. De bestaande domeinen zijn
  ongewijzigd. Terugdraaien: de bestanden uit `/opt/authelia/backups/regiochecker-*`
  terugzetten en daar `docker compose up -d`.
- Vóór Authelia haalt Traefik de `Authorization`-kop weg (middleware
  `regiochecker-zonder-basic`), anders kreeg een browser met oude basic-auth-
  gegevens een wachtwoord-pop-up in plaats van het inlogscherm.
- De API weigert verzoeken zonder de `Remote-User`-koptekst die Traefik na het
  inloggen meestuurt (`REGIOCHECKER_AUTH_KOP`); de middleware overschrijft wat een
  browser zelf meestuurt (ook `Remote-Email` en `Remote-Name`). Journalisten zien
  alleen hun eigen meldingen, notities en bewaarde stukken; Beheer is alleen
  voor admins.
- Adressen die een beheerder als audiobron invult, en elke doorverwijzing van
  een mediaserver, moeten openbare internetadressen zijn: nooit iets in het eigen
  netwerk. ffmpeg leest een stream alleen via HTTPS-HLS zonder doorverwijzingen.
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
