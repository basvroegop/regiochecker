# Regiochecker

Houdt de websites van zeven gemeenten in de gaten (zes Friese plus Groningen) en stuurt elke
regioverslaggever één keer per week een mail met per gemeente een **samenvatting**
van wat er speelt, gevolgd door de volledige lijst van wat er nieuw is. In de webUI stel je in
welk e-mailadres welke regio's krijgt.

Draait op https://regiochecker.vroeg.app. Inloggen via de Authelia op deze
server (authelia.vroeg.app); wie erin mag, staat in de toegangsregel voor deze
site in de Authelia-configuratie.

## Wat er in de mail staat

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

### Welke periode?

De mail bevat altijd alles wat **sinds de vorige mail aan dat adres** voor het
eerst is gezien, tot het moment van versturen. Een week zonder mail (niets
nieuws, een fout, of de ontvanger stond uit) valt dus nooit weg: die zit in de
volgende mail. Een nieuwe ontvanger krijgt de eerste keer de afgelopen week.

- Verstuurmoment: standaard **maandag 07:00**, in te stellen in de webUI (tijd
  plus een of meer dagen).
- Stond de dienst uit op het verstuurmoment, dan gaat de mail zodra hij weer
  draait. Na het wijzigen van het schema wordt een moment dat al voorbij is niet
  alsnog verstuurd.
- Mislukt het versturen (SMTP onbereikbaar), dan probeert de dienst het die dag
  elk half uur opnieuw. Lukt het niet, dan blijft de vorige-mail-tijd staan en
  komt alles in de mail van de week erna.
- Vlak voor het versturen doet de dienst altijd een verse controleronde.

### Wat telt als nieuw?

De bronnen worden elk uur gecontroleerd. Een item is nieuw op het moment dat de
Regiochecker het voor het eerst ziet, niet op de datum die erop staat. Een
Woo-besluit van augustus dat pas in oktober online komt, is in oktober nieuws.

Twee vangnetten tegen een mail vol oud nieuws:

- De eerste ronde van een bron is een **nulmeting**: wat er dan al staat, telt
  niet als nieuw (behalve stukken van de laatste twee dagen).
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
griffie; de botcontrole omzeilen doen we niet.

De configuratie staat in `src/regios.mjs`, de lezers per brontype in
`src/bronnen/`. Een bron toevoegen: kies een `type` uit `src/bronnen/index.mjs`
(of schrijf een nieuwe lezer), geef de bron een uniek `id` en zet hem bij de
juiste regio. Verander het `id` van een bestaande bron niet, anders komt alles
opnieuw binnen (al vangt de nulmeting dat op).

## Inhoud achter de links

De samenvatting gaat niet alleen over titels. Na elke controleronde haalt de
dienst de inhoud op van nieuwe berichten van de afgelopen twee weken
(`src/inhoud.mjs`, maximaal 80 per ronde, drie pogingen per bericht):

| Bron | Wat we lezen |
|---|---|
| Nieuws (alle gemeenten) | de tekst van het artikel, plus pdf-bijlagen in het artikel |
| iBabs (Heerenveen, Opsterland, Oost- en Weststellingwerf) | de brief en de eerste bijlage (pdf via `/Document/View/<id>`) |
| Notubiz (Smallingerland) | het hoofddocument via de API; brieven van inwoners hebben er geen |
| B&W-besluiten Groningen | de pdf |
| Woo Groningen | omschrijving plus het besluit (pdf), via de API van het portaal |
| Woo Smallingerland | de pagina plus de pdf's erop |
| Súdwest-Fryslân, ingekomen en Woo | niets: alleen het onderwerp staat online |

Per bericht maximaal 6000 tekens, uit de eerste acht pagina's van een pdf. Na vijf
weken gaat de inhoud er weer af. Of het gelukt is, staat per bericht in
`data/items.json` (`inhoud`, of `inhoudFout`).

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
op een eigen Docker-netwerk. Alleen het Ollama-verkeer gaat daardoorheen.

Eenmalig koppelen:

1. **Tailscale.** Of: maak in https://login.tailscale.com/admin/settings/keys een
   auth-key, zet die als `TS_AUTHKEY=…` in `tailscale.env` (zie
   `tailscale.env.example`, `chmod 600`) en `docker compose up -d`. Of: draai
   `./tailscale-inloggen.sh` en open de link die het geeft. (De link uit
   `docker compose logs tailscale` werkt niet: de container geeft een
   interactieve login maar 60 seconden en herstart dan met een nieuwe link.)
   De machine heet `regiochecker`
   in je tailnet; de status blijft bewaard in `./tailscale`. Wie het strak wil:
   een ACL die `regiochecker` alleen toegang geeft tot poort 11434 van de
   Ollama-machine.
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

## Kamerstukken

Alle stukken van de Tweede Kamer (brieven, moties, Kamervragen, bijlagen …) sinds
Prinsjesdag 2026 (`KAMERSTUKKEN_VANAF`, standaard 2026-09-15), met volledige tekst,
uit het open-data-Gegevensmagazijn (opendata.tweedekamer.nl, OData v4).

- **Bijhouden** (`src/kamer/`): elk half uur wat er in de API gewijzigd is
  (metadata, `ApiGewijzigdOp`), daarna per document de pdf of docx downloaden en de
  tekst indexeren, nieuwste eerst, maximaal 600 per ronde. Verwijderde stukken
  gaan eruit; een nieuwe versie wordt opnieuw ingelezen. De eerste keer (ruim 5.600
  stukken) duurt dat een paar uur.
- **Opslag**: `data/kamerstukken.sqlite`, SQLite met een FTS5-index op titel,
  onderwerp en tekst. Back-up = het bestand kopiëren terwijl de dienst stilstaat,
  of gewoon opnieuw laten ophalen.
- **Termen per regio** (webUI, tabblad Termen kamerstukken): komt een term voor in
  een nieuw stuk, dan staat dat stuk in de weekmail van die regio onder het kopje
  Kamerstukken, met de zin waarin de term staat. Hoofdletters en accenten tellen
  niet, alleen hele woorden tellen. Per term zie je hoeveel stukken van de afgelopen
  30 dagen hem bevatten; een term als "Groningen" levert te veel op.
- **Zoekmachine**: `/kamerstukken.html`. FTS5-syntax: woorden (allemaal), `"woordgroep"`,
  `OR`, `NOT`, `voorvoegsel*`; filters op soort en datum; sorteren op relevantie of
  datum. Elk resultaat linkt naar tweedekamer.nl en naar het document.
- **Meldingen op termen** (zelfde pagina): e-mailadres, termen en frequentie
  (direct na de eerstvolgende controle, of hooguit één keer per dag op het
  verstuurmoment). Met een voorbeeld van de mail op basis van de afgelopen week.

"Nieuw" is: door ons binnengehaald na de vorige mail, en niet ouder dan twee weken.
Zo geven stukken die we de eerste keer inhalen geen stortvloed aan meldingen.

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

SMTP-gegevens, de Claude-sleutel en het Ollama-adres vul je in de webUI in
(Instellingen). Ze staan in `data/instellingen.json`; wachtwoord en sleutel gaan
nooit terug naar de browser. De Claude-sleutel mag ook als `ANTHROPIC_API_KEY` in
`.env`.

### Data

Alles staat in `data/` (JSON, leesbaar). Back-up = die map kopiëren.

| Bestand | Inhoud |
|---|---|
| `instellingen.json` | verstuurmoment, SMTP, Claude-sleutel, Ollama-adres en -model |
| `ontvangers.json` | e-mailadressen, regio's, tijd van de vorige mail |
| `items.json` | alles wat de bronnen opleverden, met `eersteGezien` |
| `status.json` | per bron de laatste ronde; laatste mailronde |
| `logboek.json` | verzonden mails en fouten |
| `samenvattingen.json` | cache van Claude- en Ollama-antwoorden (14 dagen) |
| `kamertermen.json` | termen per regio voor kamerstukken |
| `meldingen.json` | meldingen op termen |
| `kamerstukken.sqlite` | de kamerstukken met zoekindex |

De Tailscale-identiteit van de sidecar staat apart in `./tailscale`.

### Beveiliging

- Inloggen gaat via de gedeelde Authelia in `/opt/authelia`, met de Traefik-
  middleware `authelia@docker`. Voor deze site zijn daar op 26 oktober 2026
  drie dingen toegevoegd: een sessiecookie voor `vroeg.app` met inlogpagina
  `authelia.vroeg.app`, een Traefik-router voor die inlogpagina, en een
  toegangsregel voor `regiochecker.vroeg.app` (alleen de genoemde gebruiker, de
  rest: deny). De bestaande domeinen zijn ongewijzigd. Terugdraaien: de bestanden
  uit `/opt/authelia/backups/regiochecker-*` terugzetten en daar `docker compose up -d`.
- Vóór Authelia haalt Traefik de `Authorization`-kop weg (middleware
  `regiochecker-zonder-basic`). Authelia accepteert op forward-auth ook basic
  auth; een browser die de oude basic-auth-gegevens van deze site nog onthield,
  kreeg daardoor een wachtwoord-pop-up in plaats van het inlogscherm.
- De API weigert verzoeken zonder de `Remote-User`-koptekst die Traefik na het
  inloggen meestuurt (`REGIOCHECKER_AUTH_KOP`); de middleware overschrijft wat
  een browser zelf meestuurt. Is de sessie verlopen, dan laadt de webUI de pagina
  opnieuw en kom je bij het inlogscherm.
- De Tailscale-proxy staat op een eigen Docker-netwerk (`regiochecker-intern`),
  niet op het gedeelde `traefik`-netwerk.
- Schrijfacties accepteren alleen `application/json`, wat formulieren van andere
  sites tegenhoudt.
- Tekst uit de bronnen wordt overal ontsnapt (webUI en mail). Het taalmodel
  krijgt de instructie om opdrachten in de items te negeren.

### Als een bron stuk gaat

Gemeentesites veranderen. Een bron die faalt of ineens niets meer oplevert,
staat rood of oranje onder "Regio's en bronnen" en onderaan de regio in de mail.
De tests in `test/parsers.test.mjs` draaien op pagina's die op 20 oktober 2026
zijn opgeslagen in `test/fixtures/`. Sla de nieuwe pagina op naast de oude,
vergelijk, en pas de lezer in `src/bronnen/` aan.
