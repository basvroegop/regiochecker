# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Regiochecker is a news-monitoring platform for regional journalists (LC and DVHN). It shows one feed per journalist of municipal sources, Tweede Kamer documents, national "signals" (KNMI, Raad van State, ransomware, traffic, Telegram tips) and transcribed council meetings, videos and podcasts. It also sends a weekly mail, keyword alerts and Teams messages. Node 22 ESM, no framework, no build step. `README.md` is the detailed functional spec: read the relevant section before changing behaviour, and update it with every feature.

**Language:** everything is Dutch — identifiers, comments, UI text, commit messages and README. Keep it that way. Comments explain *why*.

## Commands

The host runs Node 20, and `node:sqlite` needs Node 22. Run the tests in the container, with `src/` and `test/` mounted so the image doesn't need a rebuild:

```sh
# all tests
docker compose run --rm --no-deps -T -v /opt/regiochecker/src:/app/src:ro -v /opt/regiochecker/test:/app/test:ro regiochecker npm test
# one file, or one test by name
docker compose run --rm --no-deps -T -v /opt/regiochecker/src:/app/src:ro -v /opt/regiochecker/test:/app/test:ro regiochecker node --test test/feed.test.mjs
docker compose run --rm --no-deps -T -v /opt/regiochecker/src:/app/src:ro -v /opt/regiochecker/test:/app/test:ro regiochecker node --test --test-name-pattern "Teams" test/kanalen.test.mjs
```

- **Build and deploy:** `docker compose build && docker compose up -d`, then wait until `docker inspect -f '{{.State.Health.Status}}' regiochecker` says `healthy`. `public/` and `src/` are baked into the image, so frontend changes also need a rebuild.
- **Calling the live API:** the app listens on `127.0.0.1:3056` and trusts the `Remote-User` header that Traefik/Authelia sets, e.g. `curl -H 'Remote-User: <admin-login>' http://127.0.0.1:3056/api/beheer/status`.
- **Trial collection round:** `npm run verzamel` (`src/verzamel-eenmalig.mjs`) runs on a temporary copy of `data/`.
- There is no linter configured.

## Operational rules

- **Deploying with audio running.** The Whisper worker's GPU is shared with other services, so never restart during a transcription part:
  1. pause audio: `PUT /api/beheer/audio {"gepauzeerd":true}`;
  2. wait until `GET /api/beheer/audio` shows nothing `transcriberen` or `analyseren`;
  3. deploy;
  4. unpause.
  
  A running *download* may be interrupted; it simply restarts.
- **Editing `data/` by hand.** The service keeps all JSON data in memory and overwrites it, so edit `data/*.json` only with the container stopped (`docker compose stop regiochecker`). `data/` must stay owned by uid 1000.
- **Bot protection.** Don't bypass bot protection such as Cloudflare challenges or Anubis. The one exception is the existing Anubis pass for GemeenteOplossingen meeting audio. Since 2026-10-28 the Notubiz portals (`*.raadsinformatie.nl`) are behind a Cloudflare challenge: use `api.notubiz.nl` and never scrape around it.
- **Public repo.** The GitHub repo is public. Keep out of committed files: secrets (`data/`, `.env`, `tailscale/`), home-network IPs, tailnet names and Authelia usernames.
- **Shared infrastructure.** Ask before changing it (`/opt/authelia`, Traefik).

## Architecture

**Entry point.** `src/dienst.mjs` runs:
- the HTTP server: static `public/`, `/api/*` → `src/api.mjs`, admin routes → `src/beheer.mjs`;
- a planner tick every minute: the hourly `verzamelAlles`, `verzamelSnel` for sources with `intervalMinuten`, weekly mails, then `meldingen()` (mail alerts and Teams channels);
- the Kamerstukken sync;
- the audio queue (`Verwerking`);
- the Telegram bot.

**Storage.**
- `src/opslag.mjs` holds the JSON files in `data/` (the `BESTANDEN` map) in memory; `opslag.bewaar('items', …)` writes them. `src/migratie.mjs` runs data migrations at startup.
- `data/regiochecker.sqlite` (via `node:sqlite`) holds per-user read/saved/note state and the document cache (`src/feeddb.mjs`), and the audio archive (`src/audio/db.mjs`, table `afleveringen`).
- `data/kamerstukken.sqlite` holds Tweede Kamer documents with FTS5 (`src/kamer/`).

**Sources.** `src/register.mjs` `alleBronnen(opslag)` combines five sets:
- built-in municipal sources (`REGIOS` in `src/regios.mjs`);
- `TWEEDE_KAMER`;
- `SIGNAALBRONNEN`, national sources ported from the old "checker" app;
- `PROVINCIEBRONNEN`, the province of Fryslân's weekly announcements;
- sources added in the UI (`data/bronnen.json`).

A source's `type` maps to a reader in `src/bronnen/index.mjs` `TYPES`. A reader returns `[{ sleutel, titel, url, datum, tekst, … }]`. `src/verzamel.mjs` `verwerk()` stores these as items keyed `${bron.id}:${sleutel}`.

What counts as "new" is `eersteGezien`, the moment of first sight, never the document date. A source's first round is a baseline (`basislijn`), and old stories are filtered out. Behaviour is driven by flags on the source object:
- `bereik` (`regio` or `landelijk`);
- `geo`, `straalKm`, `plaatsen`, `vestiging`, `alleenSamenvatting`;
- `intervalMinuten`, `alleenInRegio`, `bijwerken`, `inMail`, `bewaarDagen`;
- `perGemeente`: a national source whose items carry `gemeenten`; an item for a municipality that is a region becomes that region's item (`item.regio`), everything else stays national. Check national-ness with `isLandelijk(item, bron)`, not `bron.bereik` alone;
- `archief`: on the first round, items from the last 30 days go into the feed at their own date;
- `leegKan`, `sleutel` (name of an env var; the source is skipped without it), `inhoud`.

**Routing to regions** (`src/feed.mjs`). A region is a municipality, matched by name.
- Regional items belong to `item.regio`.
- National items go through `routeerItem`, which combines two routes:
  - the region's keywords (`data/regios.json`);
  - `routeerOpPlek`: points or tracks within the municipality polygon, province, company location (`src/locatie.mjs`), or place names found by `plaatsenIn`.
- `plaatsenIn` uses a strict "pointer word before the place name" rule. Polygons and place names come from `src/geo/nl.json`, PDOK + CBS data, rebuilt with `scripts/maak-geo.mjs`.

**One selection, many consumers.** The feed, weekly mail (`src/mail.mjs`), alerts (`src/meldingen.mjs`) and Teams channels (`src/kanalen.mjs`) share their selection logic in `src/feed.mjs` (`regioRegels`, `meldingTreffers`, `kanaalRegels`). Change selection there, not in the consumers.

**Feed tabs.** A tab is defined in `src/regios.mjs` (`ENKELVOUD`, `GROEPEN`, `SIGNAALGROEP` / `groepVan`) *and* in the `GROEPEN` list in `public/feed.js`. Keep both in sync; tests assert the tab counts.

**Audio** (`src/audio/`).
- `catalogus.mjs` and `vergaderingen.mjs` discover episodes from YouTube (yt-dlp), podcast RSS, Company Webcast, Notubiz, iBabs/babscast and GemeenteOplossingen.
- `verwerking.mjs` is a queue that finishes one episode at a time:
  1. transcript (recordings over about 56 minutes are sent to the worker in 45-minute parts, with checkpoints);
  2. names (off by default);
  3. a 100-word AI summary.
- `worker.mjs` talks to an external Whisper worker through a Tailscale sidecar proxy.
- Voice profiles and their names live in the worker and apply across all recordings.
- Meeting-platform data (agenda, who spoke when) is stored per episode as `platform`. Raise `PLATFORM_VERSIE` to refresh it for finished episodes.

**Networking.**
- All outbound HTTP goes through `src/ophalen.mjs` and `src/netwerk.mjs` `openbaarDispatcher`, an undici Agent that rejects private IPs. Redirects are followed manually.
- Secrets in URLs (Teams webhooks, the Telegram token) use their own fetch, so the URL never ends up in error messages.
- Readers parse HTML with regexes and the helpers in `src/html.mjs`; there is no parser library.

**Auth and secrets.**
- Users are in `data/gebruikers.json`; the Authelia login arrives as the `Remote-User` header. The first login becomes admin.
- Secrets never go back to the browser: SMTP, the Claude key, the worker token, Teams webhook URLs and the Telegram token. See `publiekeInstellingen`, `kanaalVoorClient` and `telegramVoorClient`.

**Frontend.** A vanilla ESM single-page app in `public/`:
- `app.js`: hash router and header;
- `feed.js`: feed and reading panel;
- `beheer.js`: admin pages;
- `archief.js`: audio archive;
- `meldingen.js`: alerts.

Styling comes from `modernist.css` (the design system) plus `stijl.css`.

## Testing conventions

- **Runner and fixtures.** Tests use `node:test`. Readers are tested against real pages in `test/fixtures/`.
- **No real network.** Swap the dispatcher with `zetOpenbaarDispatcher(new MockAgent())`, or use local servers with `REGIOCHECKER_PRIVE_ADRESSEN=1`. `test/nep-worker.mjs` fakes the Whisper worker.
- **API tests.** Call the API without a server via `roep(ctx, gebruiker, methode, pad, body)` in `test/api-hulp.mjs`.
- **Lazy environment variables.** Read env vars at call time, not at import time: test files set `process.env` after their static imports have already run.
