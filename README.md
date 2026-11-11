# Company Lookup

[![Tests](https://github.com/larsewallin/company-lookup/actions/workflows/test-and-deploy.yml/badge.svg)](https://github.com/larsewallin/company-lookup/actions/workflows/test-and-deploy.yml) [![MIT licence](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

**An open-source library of the world's publicly available company registers.** Give it a company name, registration number, LEI, ISIN or stock ticker. It searches official national registers, the global LEI register (GLEIF), Wikidata, the EU VAT check (VIES) and domain records. Then it returns one **company card**: legal name, status, address, incorporation date, officers where the register publishes them, parent companies, VAT validity, website age and warning flags. Every fact carries its source and the date it was checked.

Built for credit, finance, procurement and compliance teams who need to know whether a new customer or supplier is real and in good standing.

- **35 national registers** in [COUNTRIES.md](COUNTRIES.md), plus every company worldwide that holds an LEI.
- **No dependencies.** Plain Node.js 20+, no database required.
- **Three ways to use it:** as a library in your own app, as an HTTP API, or as an MCP server for Claude, ChatGPT and other AI assistants.
- **Try it:** [larsewallin.com/lookup](https://larsewallin.com/lookup)

> For information only. Company Lookup is not advice, a credit rating or a credit report, and must not be used for decisions about individuals. Flags are prompts to check, not findings. Data comes from third-party sources that can be incomplete or out of date: confirm anything important at the source.

## Quick start

```bash
git clone https://github.com/larsewallin/company-lookup.git
cd company-lookup
cp .env.example .env      # optional: add keys and your contact details
node server.js            # then open http://localhost:3000
```

There is nothing to install. The live-API countries, GLEIF, Wikidata, VIES and RDAP work straight away.

## Use it in your own application

### As a library

```js
const { createLookup } = require('company-lookup'); // or require('./path/to/company-lookup')

const lookup = createLookup();
const { results } = await lookup.search('Siemens', { country: 'DE' });
const card = await lookup.company(results[0].id, { website: 'siemens.com' });

console.log(card.verdict);                               // 'stop' | 'check' | 'clear'
console.log(card.flags.map((f) => `${f.level}: ${f.label}`));
```

Install it straight from GitHub with `npm install github:larsewallin/company-lookup`, or copy the folder into your project. Errors are thrown as `LookupError` with an HTTP-style `status` and a readable message.

### As an HTTP API

Run `node server.js`, or deploy the repo to Vercel as it is (the `api/` folder becomes serverless functions).

| Route | What it does |
|---|---|
| `GET /api/search?q=Tesco&country=GB` | Up to 20 matches, each with an `id` |
| `GET /api/company?id=gb:00445790&website=tesco.com` | The full company card |
| `GET /api/coverage` | How many companies each source holds |
| `POST /api/mcp` | MCP server (see below) |

Country codes are ISO 3166-1 alpha-2. Giving a country adds that country's national register to the search.

### As an MCP server for AI assistants

`/api/mcp` is a remote MCP server (Streamable HTTP, no sign-in) with two read-only tools: `search_companies` and `get_company_card`. Add its URL as a custom connector in Claude or ChatGPT, or in any MCP client. A hosted copy runs at `https://larsewallin.com/api/mcp`.

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

## Configuration

Every setting is optional. Put them in `.env` (read by `server.js`) or in your hosting provider's environment variables.

| Variable | What it is for |
|---|---|
| `COMPANY_LOOKUP_USER_AGENT` | Identifies your app to the registers. **Set it** to your app name and a contact e-mail, e.g. `Acme credit-tools (credit@acme.com)`. SEC EDGAR requires a contact. |
| `COMPANIES_HOUSE_API_KEY` | UK lookups. A free key from the [Companies House developer hub](https://developer.company-information.service.gov.uk/). Without it, UK companies are found only through GLEIF. |
| `DATA_GOV_SG_API_KEY` | Optional higher rate limits for Singapore. |
| `BLOB_READ_WRITE_TOKEN` | Your Vercel Blob store, for the hosted-index countries. |
| `SEC_USER_AGENT` | Overrides the User-Agent for SEC EDGAR only. |

## Hosted-index countries

Fifteen registers publish only bulk files (Argentina, Canada, Chile, Cyprus, the Dominican Republic, Ecuador, India, Luxembourg, Moldova, Paraguay, Peru, Romania, Russia, Slovenia and Ukraine). For these, an import job downloads the files and builds a small search index in **your own** Vercel Blob store:

1. Create a Blob store in Vercel (Storage → Blob, public access) and copy its `BLOB_READ_WRITE_TOKEN`.
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
lib/mcp.js          MCP server
api/                Vercel functions (also served by server.js)
index.html          the demo page
tests/              offline tests with fixtures from real responses
```

Run the tests with `npm test`. They are offline and need no network.

## Data sources and licences

Company Lookup only reads public sources, and each card names the source of every fact. When you reuse the data, follow each publisher's terms. Among them: GLEIF and Wikidata (CC0), UK Companies House (Open Government Licence v3.0), Finland PRH (CC BY 4.0), Norway Brønnøysund (NLOD), Taiwan GCIS (Open Government Data License 1.0), Cyprus (CC BY 4.0) and India Data Portal (ODC-By). The EU VAT check (VIES) is meant for checking your own trading partners. Respect each source's rate limits; the HTTP API has a per-address limit built in.

Officers' names are shown only where a register publishes them. Birth dates, personal e-mail addresses and private individuals' records are left out. Do not use the tool to profile people.

## Contributing

Pull requests are welcome, especially new countries. Each adapter in `lib/registers/` exports `country`, `name`, `search`, `get` and `normalise`. Add yours to `lib/registers/index.js` with a test using a fixture from a real response.

## Licence

[MIT](LICENSE) © 2026 Latiluco, LLC. Built by [Lars E. Wallin](https://larsewallin.com).
