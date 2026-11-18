# Changelog

Changes to the HTTP API, the MCP server and the library. The `/v1/` contract is in [docs/api-v1.md](docs/api-v1.md): within v1, fields are only added. A breaking change means `/v2/`, announced here and in the README at least 6 months before v1 stops.

## 2026-11-18: search ranking

- Funds (GLEIF category FUND, `kind: "fund"`) now rank after every company across all sources, not only within GLEIF: a search for a ticker no longer opens with ETFs named after it.
- US: an SEC filer whose EDGAR ticker equals the query goes first, labelled `ticker` (e.g. `eose` → Eos Energy Enterprises, `ticker: "EOSE"`).
- Names that only contain the query inside a word ("eose" in "Geosearch") are dropped from registers searched by "contains" (New York, Colorado, Connecticut). Number searches and GLEIF's fuzzy matches are unchanged.

## 2026-11-16: sanctions screening

- **New:** `GET`/`POST /v1/sanctions` and `/api/sanctions`, the MCP tool `screen_sanctions` and `lookup.sanctions()`. They screen company names against the US OFAC (SDN and non-SDN), EU, UN and UK sanctions lists, entities only, refreshed daily by `/api/sanctions-import` (Vercel Cron).
- **New on company cards:** `sanctions` (screening of the company's names and its parents), a `sources` line, and the flags `Possible sanctions match: review` (Stop or Check), `Similar name on a sanctions list` (Note) and `Parent company: possible sanctions match` (Check). A match is a prompt to review, never a finding.

## 2026-11-16: name search over stored places (pilot)

- In DE, IT, ES, NL, BE and AT, search's `presence` list also includes matching Overture places from a monthly extract (labelled "Not an official record", `linked_entity: null`). `/v1/health` gains `places`. New `POST /api/places-import` (internal: loads the monthly index into Blob).

## 2026-11-16: VIES results trimmed

- `identity.vat.vies.name` is now always `null` (the field stays), and `identity.vat.vies.url` links to the VIES check. Company Lookup no longer passes on the name or address VIES returns, because the VIES terms limit retransmitting its results. Validity and the date checked are unchanged.

## 2026-11-16: `/v1/` API

- **New:** stable `/v1/` routes (`search`, `company`, `presence`, `presence-report`, `coverage`) on the same handlers as `/api/*`. Every v1 response has `"api_version": "1"`.
- **New:** `GET /v1/health`: status, version, commit, Overture release, Blob store reachability.
- **New:** one v1 error shape, `{ "api_version": "1", "error": { "code", "message" } }`, with codes `bad_request`, `not_found`, `method_not_allowed`, `rate_limited` (with `retry_after` and `Retry-After`), `internal`, `upstream_unavailable`, `upstream_busy` and `not_configured`.
- **New:** optional API keys for trusted callers (`Authorization: Bearer` or `X-Api-Key`; `COMPANY_LOOKUP_API_KEYS`, `COMPANY_LOOKUP_KEY_RATE_LIMIT`; `scripts/new-api-key.js`).
- **New:** `COMPANY_LOOKUP_PUBLIC_URL` sets the base URL of links in v1 responses (e.g. `linked_entity.report.url`, a full URL on v1).
- **Unchanged:** `/api/*` responses, errors and limits; the MCP server; the library.

## 2026-11-15: presence data

- Overture Maps presence cards (`/api/presence`, `get_presence_card`, `lookup.presence()`), links to legal entities, `POST /api/presence-report`, and `tier` on search results.
