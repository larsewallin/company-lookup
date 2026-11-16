# Company Lookup

[![Tests](https://github.com/larsewallin/company-lookup/actions/workflows/test-and-deploy.yml/badge.svg)](https://github.com/larsewallin/company-lookup/actions/workflows/test-and-deploy.yml) [![MIT licence](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

**An open-source library of the world's publicly available company registers.** Give it a company name, registration number, LEI, ISIN or stock ticker. It searches official national registers, the global LEI register (GLEIF), Wikidata, the EU VAT check (VIES) and domain records. Then it returns one **company card**: legal name, status, address, incorporation date, officers where the register publishes them, parent companies, VAT validity, website age and warning flags. Every fact carries its source and the date it was checked.

Built for credit, finance, procurement and compliance teams who need to know whether a new customer or supplier is real and in good standing.

- **35 national registers** in [COUNTRIES.md](COUNTRIES.md), plus every company worldwide that holds an LEI.
- **Presence data** from [Overture Maps](https://overturemaps.org) places: locations and contact details for businesses, including in countries without an open register. Always labelled: not an official record.
- **One small dependency** ([hyparquet](https://github.com/hyparam/hyparquet), pure JavaScript, for reading Overture's Parquet files). Node.js 20+, no database required; presence data needs Node 22.15+.
- **Three ways to use it:** as a library in your own app, as an HTTP API, or as an MCP server for Claude, ChatGPT and other AI assistants.
- **Try it:** [open-company-lookup.vercel.app](https://open-company-lookup.vercel.app), or add `https://open-company-lookup.vercel.app/api/mcp` to Claude or ChatGPT as a connector.

> For information only. Company Lookup is not advice, a credit rating or a credit report, and must not be used for decisions about individuals. Flags are prompts to check, not findings. Data comes from third-party sources that can be incomplete or out of date: confirm anything important at the source.

## Quick start

```bash
git clone https://github.com/larsewallin/company-lookup.git
cd company-lookup
cp .env.example .env      # optional: add keys and your contact details
node server.js            # then open http://localhost:3000
```

Run `npm install` once (it adds hyparquet). The live-API countries, GLEIF, Wikidata, VIES and RDAP work straight away.

## Use it in your own application

### As a library

```js
const { createLookup } = require('company-lookup'); // or require('./path/to/company-lookup')

const lookup = createLookup();
const { results } = await lookup.search('Siemens', { country: 'DE' });
const card = await lookup.company(results[0].id, { website: 'siemens.com' });

console.log(card.verdict);                               // 'stop' | 'check' | 'clear'
console.log(card.flags.map((f) => `${f.level}: ${f.label}`));

// Presence data: one Overture Maps place by its GERS ID (lon/lat optional, faster)
const place = await lookup.presence('6f8bce4f-a274-4494-9f2c-dd051bca0bb4', { lon: -0.20729, lat: 51.50255 });
console.log(place.tier, place.notice, place.linked_entity);
```

Install it straight from GitHub with `npm install github:larsewallin/company-lookup`, or copy the folder into your project. Errors are thrown as `LookupError` with an HTTP-style `status` and a readable message.

### As an HTTP API

Run `node server.js`, or deploy the repo to Vercel as it is (the `api/` folder becomes serverless functions).

**`/v1/` is the stable path for new integrations.** Its contract is in [docs/api-v1.md](docs/api-v1.md) ([OpenAPI](docs/openapi-v1.json)): within v1, fields are only added, never renamed or removed, and a breaking change means a new `/v2/`, with v1 kept running for at least 6 months after it is announced here and in the [changelog](CHANGELOG.md). Every v1 response has `"api_version": "1"`, and errors have one shape: `{ "api_version": "1", "error": { "code", "message" } }`.

| v1 route | What it does |
|---|---|
| `GET /v1/search?q=Tesco&country=GB` | Up to 20 matches, each with an `id` and a `tier`; known places in `presence` |
| `GET /v1/company?id=gb:00445790&website=tesco.com` | The full company card |
| `GET /v1/presence?id=<GERS ID>&lon=-0.20729&lat=51.50255` | Presence card for one Overture Maps place (`lon`/`lat` optional) |
| `POST /v1/presence-report` | Report a wrong link: JSON `{ "id": "<GERS ID>", "entity_id": "gb:…", "reason": "…" }` |
| `GET /v1/coverage` | How many companies each source holds |
| `GET /v1/health` | Status, version, Overture release and Blob store reachability (cheap, cached 10 s) |

```bash
curl -s "https://open-company-lookup.vercel.app/v1/search?q=Tesco&country=GB"
```

Anonymous callers get 40 requests per 5 minutes per IP address. Trusted server-to-server callers can send an API key (`Authorization: Bearer <key>` or `X-Api-Key: <key>`) for their own, higher limit (400 per 5 minutes by default); see [API keys](#api-keys). A missing or unknown key is simply treated as anonymous.

The original routes keep working exactly as before (no `api_version`, errors as `{ "error": "message" }`):

| Route | What it does |
|---|---|
| `GET /api/search?q=Tesco&country=GB` | Up to 20 matches, each with an `id` |
| `GET /api/company?id=gb:00445790&website=tesco.com` | The full company card |
| `GET /api/presence?id=<GERS ID>&lon=-0.20729&lat=51.50255` | Presence card for one Overture Maps place (`lon`/`lat` optional) |
| `POST /api/presence-report` | Report a wrong link: JSON `{ "id": "<GERS ID>", "entity_id": "gb:…", "reason": "…" }` |
| `GET /api/coverage` | How many companies each source holds |
| `POST /api/mcp` | MCP server (see below) |

Country codes are ISO 3166-1 alpha-2. Giving a country adds that country's national register to the search.

### As an MCP server for AI assistants

`/api/mcp` is a remote MCP server (Streamable HTTP, no sign-in) with three read-only tools: `search_companies`, `get_company_card` and `get_presence_card`. Add its URL as a custom connector in Claude or ChatGPT, or in any MCP client. A hosted copy runs at `https://open-company-lookup.vercel.app/api/mcp`.

## The company card

```text
verdict     stop | check | clear
flags       [{ level: 'stop' | 'check' | 'note', label, detail, source }]
identity    legal name, country, status, legal form, incorporated, addresses, VAT, industry …
ids         national register number, LEI, ISINs
group       direct and ultimate parent, subsidiaries, group size (from GLEIF)
people      officers and owners, where the register publishes them
filings     accounts and confirmation statements (UK)
charges     secured lending (UK)
web         domain and when it was registered
financials  key figures, where a register publishes them
about       Wikidata: headquarters, industry, employees, listings
sources     every source checked, with its result
gaps        what could not be checked, and why
next_step   a suggested next step
as_of       the date of the check
rules       the thresholds the flags used
```

**Flags** come from fixed, written rules in `lib/card.js`:
- **Stop:** something serious on the record, such as dissolved, struck off, insolvent or in liquidation.
- **Check:** worth a closer look, such as overdue accounts, a company younger than 24 months, a website domain registered in the last 12 months, a recent name change, an invalid VAT number or a parent that is not active.
- **Note:** context, such as a lapsed LEI or a parent that is not disclosed.

## Data tiers

Every result says which tier it comes from. When tiers disagree, the higher one wins: presence data never overwrites a register fact.

| Tier | `tier` value | Sources | What it is |
|---|---|---|---|
| 1. Official registers | `register` | National company registers ([COUNTRIES.md](COUNTRIES.md)), UK Companies House | Legal facts: name, number, status, address, officers |
| 2. Global and supporting records | `gleif` | GLEIF (LEI), EU VIES, Wikidata, RDAP | Identifiers, parents, VAT validity, listings, domain age |
| 3. Presence data | `presence` | Overture Maps places (Meta, Microsoft, Foursquare, BrightQuery, AllThePlaces and others, conflated) | A business appears to exist at an address. **Not an official record and not a legal identifier.** |

### Presence data (Overture Maps)

`get_presence_card` / `GET /api/presence` returns one place by its [GERS ID](https://docs.overturemaps.org/gers/), the stable ID Overture uses across releases (also the feature ID in Overture's PMTiles):

```text
tier              'presence'
notice            "Presence data from Overture Maps. Not an official record and not a legal identifier."
id                GERS ID
name, categories  { primary, basic, hierarchy, alternates } from Overture's taxonomy
address           { street, locality, postcode, region, country }
location          { lon, lat }
websites, phones, socials, brand     only where present
confidence        Overture's own score (0–1)
sources           [{ dataset, license, update_time, record_id, properties }]
attribution       "© Overture Maps Foundation. Sources: <dataset> (<licence>)…"
release           the Overture release the record came from, e.g. 2026-10-21.0
checked_at        when Company Lookup fetched it
linked_entity     the legal entity this place is linked to (strong match), or null
possible_matches  "possibly the same as…" entities (probable matches, never merged)
official_register "Search the official register": search_companies arguments, where the country has a register
```

A presence card has no verdict, flags or status. The current release is read from Overture's [STAC catalog](https://stac.overturemaps.org/catalog.json) every hour, never hard-coded (releases are removed after about 60 days). The place is read straight from the public GeoParquet files with HTTP range requests: with `lon`/`lat`, only the row groups around the point; without, the GERS registry gives its file and bounding box.

**Linking to legal entities.** Candidates come from `search_companies(name, country)`. A place is linked automatically only on a **strong match**: the same website domain (registrable domain; social and listing sites don't count) **and** a similar name (lower case, no punctuation, no legal suffixes such as Ltd, GmbH, SA, S.L., Tbk) in the same country. A **probable match** (similar name and the same street or postcode, or the same domain with a very different name) is shown as "possibly the same as…" and never merged. Brand alone never matches: franchise outlets are often separate companies. One entity can have many places. Links are kept in the Blob store (`presence/index.json`), keyed on the GERS ID with the entity ID, level, evidence and date.

In search, legal entities come first; places linked to one of them appear under it as `locations`, and other known places follow in a separate `presence` array, each labelled "Not an official record". A company card can carry `presence.locations`. Anyone can report a wrong link with `POST /api/presence-report`; it is held out until reviewed (to review, edit `presence/index.json` in the Blob store: set the link's `status` back to `active`, or remove it and add the entity ID to `rejected`).

Name search over all Overture places is not built yet: search only shows places that have been looked up before. See [docs/presence-plan.md](docs/presence-plan.md).

## Configuration

Every setting is optional. Put them in `.env` (read by `server.js`) or in your hosting provider's environment variables.

| Variable | What it is for |
|---|---|
| `COMPANY_LOOKUP_USER_AGENT` | Identifies your app to the registers. **Set it** to your app name and a contact e-mail, e.g. `Acme credit-tools (credit@acme.com)`. SEC EDGAR requires a contact. |
| `COMPANIES_HOUSE_API_KEY` | UK lookups: officers, owners, filings, secured lending and insolvency history. Free; see [Getting a Companies House key](#getting-a-companies-house-key). Without it, UK companies are found only through GLEIF. |
| `DATA_GOV_SG_API_KEY` | Optional higher rate limits for Singapore. |
| `BLOB_STORE_ID` or `BLOB_READ_WRITE_TOKEN` | Your Vercel Blob store, for the hosted-index countries. On Vercel, connecting the store sets `BLOB_STORE_ID` and the code signs in with Vercel's short-lived OIDC token. Outside Vercel (e.g. `node server.js`), use a read-write token. |
| `SEC_USER_AGENT` | Overrides the User-Agent for SEC EDGAR only. |
| `COMPANY_LOOKUP_API_KEYS` | API keys for trusted callers of `/v1/`: `name:sha256hash` pairs separated by commas, e.g. `trade-credit-monitor:3f1c…,other-app:9ab2…`. Only hashes, never raw keys. Make them with `node scripts/new-api-key.js <name>`; see [API keys](#api-keys). Without it, every caller is anonymous. |
| `COMPANY_LOOKUP_KEY_RATE_LIMIT` | Requests per 5 minutes for each keyed caller. Default 400 (10× the anonymous limit). |
| `COMPANY_LOOKUP_PUBLIC_URL` | The base URL for links the v1 API returns, e.g. `https://lookup.example.com`. Default: the address the request came to. |

### API keys

Keys are for trusted **server-to-server** callers (never put one in a web page or app). A key gives its own, higher rate limit and the caller's name in logs; it unlocks no extra data, and reports sent with it are labelled with the name.

1. Run `node scripts/new-api-key.js trade-credit-monitor` (any name: letters, digits, `.`, `_`, `-`).
2. It prints the key and a `name:hash` line. Give the key to the caller, who keeps it in their own environment variables (e.g. `COMPANY_LOOKUP_API_KEY`), marked sensitive.
3. Add the `name:hash` line to `COMPANY_LOOKUP_API_KEYS` (comma-separated with any others), then redeploy or restart.
4. To revoke a key, remove its line and redeploy.

Never commit a key, log it, or paste it into chat or tickets. Only the hash goes into Company Lookup's settings, so a leaked settings page doesn't leak keys.

### Getting a Companies House key

The key is free and works straight away.

1. Register at the [Companies House developer hub](https://developer.company-information.service.gov.uk/).
2. Create an application with the **Live** environment. Test applications are refused by the live API.
3. Add a key of type **REST**, not Stream, and leave its IP and domain restrictions empty: servers such as Vercel call from changing addresses.
4. Copy the key **by hand**, by selecting the text. The hub's copy button can fail and copy nothing.
5. Set it as `COMPANIES_HOUSE_API_KEY`, in `.env` or your hosting provider's settings, then restart or redeploy.
6. Check it: search for `Tesco` with country `GB`. Results should show `Source: Companies House`. If the key is refused, the search shows a warning that names `COMPANIES_HOUSE_API_KEY`.

## Hosted-index countries

Fifteen registers publish only bulk files (Argentina, Canada, Chile, Cyprus, the Dominican Republic, Ecuador, India, Luxembourg, Moldova, Paraguay, Peru, Romania, Russia, Slovenia and Ukraine). For these, an import job downloads the files and builds a small search index in **your own** Vercel Blob store:

1. Create a Blob store in Vercel (Storage → Blob, **public** access) and connect it to your project. Running outside Vercel, also create a read-write token and set it as `BLOB_READ_WRITE_TOKEN`.
2. Call the import once per country, e.g. `curl "http://localhost:3000/api/bulk-import?country=CY"`. It answers `{"ok": true, ...}` when the index is built. Small registers take a minute or two; the largest (Romania, Peru, Ukraine) take up to about 13 minutes, reading their files in several passes. Calls within 20 days of a successful build are skipped.
3. On Vercel, the `crons` in `vercel.json` refresh each country monthly. Romania runs from the Frankfurt endpoint `/api/bulk-import-eu`, because its portal refuses US servers.

Imports read whole national files (up to a few GB). Run them from a server or Vercel, not a laptop on a slow connection. How the index works is in [lib/bulk/README.md](lib/bulk/README.md).

## Project layout

```text
lib/index.js        library entry point (createLookup)
lib/handlers.js     search and company logic behind the HTTP API
lib/card.js         the company card and its flag rules
lib/gleif.js        GLEIF: LEI records, parents, subsidiaries
lib/registers/      one adapter per country: search, get, normalise
lib/bulk/           importers for the hosted-index countries, ZIP/XLSX/CSV readers
lib/sources.js      UK Companies House and RDAP domain records
lib/vies.js         EU VAT check
lib/wikidata.js     Wikidata enrichment and stock tickers
lib/overture.js     Overture Maps reader (STAC release, GERS registry, GeoParquet range reads)
lib/presence.js     presence card, name and domain normalisation, match rules
lib/presence-store.js links between places and legal entities (Blob store)
lib/mcp.js          MCP server
lib/keys.js         API keys for /v1/ (hashed, constant-time compare)
api/                Vercel functions (also served by server.js); api/v1/ serves /v1/ (vercel.json rewrites)
scripts/            new-api-key.js
docs/               api-v1.md (the v1 contract), openapi-v1.json, presence-plan.md
index.html          the demo page
tests/              offline tests with fixtures from real responses
```

Run the tests with `npm test`. They are offline and need no network.

## Data sources and licences

Company Lookup only reads public sources, and each card names the source of every fact. When you reuse the data, follow each publisher's terms. Among them: GLEIF and Wikidata (CC0), UK Companies House (Open Government Licence v3.0), Finland PRH (CC BY 4.0), Norway Brønnøysund (NLOD), Taiwan GCIS (Open Government Data License 1.0), Cyprus (CC BY 4.0) and India Data Portal (ODC-By). Overture Maps places carry a licence per record in `sources[].license`: mostly CDLA Permissive 2.0, Apache 2.0 for Foursquare-sourced records and CC0 for some (such as AllThePlaces); show "© Overture Maps Foundation" with the source dataset and licence, as the presence card's `attribution` does. The EU VAT check (VIES) is meant for checking your own trading partners. Respect each source's rate limits; the HTTP API has a per-address limit built in (per server instance, so approximate).

Officers' names are shown only where a register publishes them. Birth dates, personal e-mail addresses and private individuals' records are left out. Do not use the tool to profile people.

## Your own deployment

`privacy.html`, `terms.html` and `connector.html` describe the hosted instance at open-company-lookup.vercel.app, run by Latiluco, LLC. If you deploy your own copy, replace or remove them: they are not terms for your service.

## Contributing

Pull requests are welcome, especially new countries. Each adapter in `lib/registers/` exports `country`, `name`, `search`, `get` and `normalise`. Add yours to `lib/registers/index.js` with a test using a fixture from a real response.

## Licence

[MIT](LICENSE) © 2026 Latiluco, LLC. Built by [Lars E. Wallin](https://larsewallin.com).
