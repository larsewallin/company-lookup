# Company Lookup HTTP API, version 1

The stable API for applications that depend on Company Lookup. Machine-readable version: [openapi-v1.json](openapi-v1.json).

- **Base URL (hosted):** `https://open-company-lookup.vercel.app`. A self-hosted copy serves the same paths from its own address.
- **Format:** JSON (`application/json; charset=utf-8`), UTF-8. Dates are ISO 8601 (`2026-11-15`), times are ISO 8601 UTC.
- **Authentication:** none needed. Trusted server-to-server callers can send an API key for a higher rate limit (see [Rate limits and API keys](#rate-limits-and-api-keys)).
- **For information only.** Nothing here is advice, a credit rating or a credit report, and it must not be used for decisions about individuals. Flags are prompts to check, not findings.

| Route | What it does |
| --- | --- |
| [`GET /v1/search`](#get-v1search) | Find companies by name, number, LEI, ISIN or ticker |
| [`GET /v1/company`](#get-v1company) | One company card |
| [`GET /v1/presence`](#get-v1presence) | One presence card (an Overture Maps place) |
| [`POST /v1/presence-report`](#post-v1presence-report) | Report a wrong link between a place and a company |
| [`GET /v1/coverage`](#get-v1coverage) | How many companies each source holds |
| [`GET /v1/health`](#get-v1health) | Whether the service is up |

## Stability promise

- Within v1, fields are **only added**, never renamed or removed, and a field's type never changes. Ignore fields you don't know.
- Error `code` values are only added. Treat an unknown code by its HTTP status.
- A breaking change means a new `/v2/`. v1 keeps running for at least **6 months** after `/v2/` is announced in the [README](../README.md) and the [changelog](../CHANGELOG.md).
- Every v1 response has `"api_version": "1"` as its first field.
- The older `/api/*` routes keep working unchanged, but have no `api_version`, no API keys and the older error shape `{ "error": "message" }`. Use `/v1/` for new integrations.

## Conventions

- **null or missing.** In the tables below, *nullable* means the field is always there but can be `null`. *Optional* means the field can be missing altogether. Arrays are never null unless marked.
- **Sources and dates.** Every fact names its source; `as_of`, `checked_at` and `sources` say when and where it was checked. Confirm anything important at the source.
- **Tiers.** Each record says where it comes from: `register` (official national registers), `gleif` (GLEIF and other global records), or `presence` (Overture Maps places: **not an official record and not a legal identifier**). Presence data never overwrites a register fact.
- **Ids.** Company ids look like `gb:00445790`, `fr:552120222` or `lei:5493001KJTIIGC8Y1R12`: a lower-case ISO country code or `lei`, a colon, and the number. Treat them as opaque strings. Place ids are Overture [GERS IDs](https://docs.overturemaps.org/gers/) (UUIDs); search results write them as `overture:<GERS ID>`.
- **Country codes** are ISO 3166-1 alpha-2, upper case.

## Errors

Every v1 error has this shape, with the HTTP status below:

```json
{ "api_version": "1", "error": { "code": "rate_limited", "message": "Too many lookups. Try again in a few minutes.", "retry_after": 120 } }
```

| `code` | HTTP | When |
| --- | --- | --- |
| `bad_request` | 400 | A parameter is missing or not valid. `message` says which. |
| `not_found` | 404 | No such company, place or link. |
| `method_not_allowed` | 405 | Wrong HTTP method (e.g. POST to a GET route). |
| `rate_limited` | 429 | Too many requests. `retry_after` (seconds) and a `Retry-After` header say when to try again. |
| `internal` | 500 | Something went wrong on our side. |
| `upstream_unavailable` | 502 | A register or source could not be reached or refused the request. |
| `upstream_busy` | 503 | A source is busy (e.g. Companies House rate-limited us). Try again in a few minutes. |
| `not_configured` | 503 | This deployment has not set up what the request needs (e.g. no Companies House key for `gb:` ids, or no link store for reports). |

`error` fields:

| Field | Type | Notes |
| --- | --- | --- |
| `code` | string | One of the codes above. |
| `message` | string | A readable explanation, safe to show to people. Wording may change; don't parse it. |
| `retry_after` | integer | Optional. Seconds; only on `rate_limited`. |
| `flag` | string | Optional. On a company `not_found`: `"Not on the register"`. |
| `tier`, `notice` | string | Optional. On a presence `not_found`: `"presence"` and the presence notice. |

Error responses are not cached (`Cache-Control: no-store`), except `not_found` from `/v1/company` and `/v1/presence`, which is cached for an hour (`s-maxage=3600`).

## Rate limits and API keys

| Caller | Limit |
| --- | --- |
| Anonymous | 40 requests per 5 minutes per IP address |
| With a valid API key | 400 requests per 5 minutes per key (10× anonymous; the operator can change it with `COMPANY_LOOKUP_KEY_RATE_LIMIT`) |

- The window slides: the oldest request in it expires after 5 minutes. Requests refused with 429 also count.
- The limits are kept in memory **per server instance**, so they are approximate: a busy caller spread over several instances can get somewhat more. Don't rely on the exact number.
- Keyed callers have their own bucket, never shared with anonymous traffic from the same address.
- `/v1/health` and `/v1/coverage` have no rate limit (they are cached at the edge).

**Sending a key.** Either header works:

```http
Authorization: Bearer <key>
X-Api-Key: <key>
```

- Keys are for **trusted server-to-server callers only**. Never put one in a web page, a mobile app or a public repository.
- A missing, unknown or malformed key is not an error: the request is served exactly like an anonymous one.
- A key gives a higher limit and puts the caller's name in our logs. It unlocks no extra data or actions. Reports sent with a key are labelled with the caller's name.
- To get a key for the hosted service, ask the operator (see the [connector page](https://open-company-lookup.vercel.app/connector)). Self-hosters make their own with `node scripts/new-api-key.js <name>` (see the README's Configuration section).

## Caching

Responses carry `Cache-Control` headers, and the hosted service caches at Vercel's edge. Clients may cache for the same time.

| Route | Success | Cache-Control |
| --- | --- | --- |
| search | 200 | `public, max-age=300, s-maxage=3600, stale-while-revalidate=25200`; `no-store` when `warnings` is not empty |
| company | 200 | `public, max-age=300, s-maxage=21600, stale-while-revalidate=151200` |
| presence | 200 | `public, max-age=300, s-maxage=3600, stale-while-revalidate=25200` |
| presence-report | 200 | `no-store` |
| coverage | 200 | `public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400` |
| health | 200 | `public, max-age=5, s-maxage=10` |

---

## GET /v1/search

Up to 20 legal entities matching a name, registration number, LEI, ISIN or stock ticker, ranked by name match, then active status, then LEI holders. Legal entities come first; known places follow separately in `presence`.

**Parameters (query string)**

| Name | Required | Type | Notes |
| --- | --- | --- | --- |
| `q` | yes | string | 2 to 100 characters. |
| `country` | no | string | ISO 3166-1 alpha-2. Adds that country's national register to the search and keeps results to that country where the source allows. |

**Response**

| Field | Type | Notes |
| --- | --- | --- |
| `api_version` | string | `"1"` |
| `query` | string | The query, trimmed. |
| `country` | string, nullable | The country asked for. |
| `results` | array of [search result](#search-result) | Up to 20. Can be empty. |
| `presence` | array of [place summary](#place-summary) | Up to 10 known places not linked to any result. Can be empty. |
| `warnings` | array of string | Sources that could not be reached, so results may be incomplete. Empty when all went well. |

### Search result

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Pass to `/v1/company`. |
| `tier` | string | `register` or `gleif`. |
| `source` | string | Where the result came from, e.g. `Companies House`, `GLEIF`, a register's name. |
| `name` | string | Legal name as the source spells it. |
| `country` | string, nullable | ISO alpha-2. |
| `status` | string, nullable | As the source states it, lower case where normalised (e.g. `active`, `dissolved`, `inactive`). Not a verdict: use the company card. |
| `number` | string, nullable | National registration number. |
| `city` | string, optional, nullable | |
| `address` | string, optional, nullable | One line. |
| `incorporated` | string, optional, nullable | Date. |
| `lei` | string, optional | The entity's LEI, where known. |
| `kind` | string, optional | `fund` for investment funds (GLEIF), which sort after companies. |
| `ticker` | string, optional | e.g. `SIE on Xetra`, when the query matched a stock ticker (Wikidata). |
| `locations` | array of [place summary](#place-summary), optional | Places strongly linked to this entity (up to 10). Each also has `match`. |

### Place summary

The short form of a presence card, used in `results[].locations`, `presence` and `company.presence.locations`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | `overture:<GERS ID>`. Pass the GERS ID to `/v1/presence`. |
| `tier` | string | Always `presence`. |
| `label` | string | Always `Not an official record`. |
| `name` | string, nullable | |
| `address` | object | `street`, `locality`, `postcode`, `region`, `country`: each string, nullable. |
| `location` | object, nullable | `lon`, `lat`: numbers (WGS 84). |
| `category` | string, optional | Overture's primary category. |
| `websites`, `phones` | array of string, optional | Only where present. |
| `sources` | array | `dataset`, `license`, `update_time`. |
| `release` | string | The Overture release, e.g. `2026-10-21.0`. |
| `match` | object, optional | In `locations` only: `level` (`strong`), `evidence` (object), `linked_on` (date). |
| `linked_entity` | object, optional, nullable | In `presence` only: `id`, `name` of an entity it is linked to, else `null`. |

## GET /v1/company

The full company card for one id, from the national register (where one is connected), GLEIF, Wikidata, the EU VAT check (VIES) and domain records (RDAP).

**Parameters (query string)**

| Name | Required | Type | Notes |
| --- | --- | --- | --- |
| `id` | yes* | string | An id from search, e.g. `gb:00445790`, `fr:552120222`, `lei:5493001KJTIIGC8Y1R12`. |
| `number` | no | string | *Instead of `id`, for UK companies only: the Companies House number. |
| `website` | no | string | Up to 300 characters. A website the company gave you; its domain age is checked. |

**Errors:** `bad_request` (unknown id format, a presence id, a bad website), `not_found` (with `flag`), `upstream_unavailable`, `upstream_busy`, `not_configured` (a `gb:` id where no Companies House key is set), `rate_limited`.

**Response: the company card**

| Field | Type | Notes |
| --- | --- | --- |
| `api_version` | string | `"1"` |
| `id` | string | The card's canonical id. |
| `as_of` | string | Date of the check. |
| `verdict` | string | `stop`, `check` or `clear`: the most serious flag level. A prompt, not a decision. |
| `flags` | array | `{ level, label, detail, source }`, all strings. `level` is `stop`, `check` or `note`; Stop first. `label` values are stable names, e.g. `Not active`, `Insolvency history`, `Accounts overdue`, `Young company`, `New website domain`. |
| `identity` | object | See below. |
| `ids` | object | `lei` (string, nullable), `national` (string, nullable), `opencorporates` (URL string, nullable), `isins` (object `{ total: number, items: [string] }`, nullable: securities GLEIF links to the LEI). |
| `group` | object, nullable | From GLEIF. `lei` (nullable) always; with an LEI also `direct_parent`, `ultimate_parent` (each `{ lei, name, country, status }` or null), `no_parent_reason` (string, nullable), `subsidiaries` (object, nullable), `all_subsidiaries_total` (number, nullable), `group_size` (nullable). |
| `people` | object, nullable | `officers` (array of `{ name, role, appointed }`, nullable), `owners` (array of `{ name, kind, control }`, nullable), `owners_note` (string, optional). Only where the register publishes them. |
| `filings` | object, nullable | Register-specific. UK: `last_accounts_made_up_to`, `last_accounts_type`, `next_accounts_due`, `next_confirmation_statement_due` (strings, nullable), `accounts_overdue`, `confirmation_statement_overdue` (booleans). Other registers can give e.g. `last_accounts_year`. |
| `charges` | object, nullable | UK secured lending: `outstanding`, `total` (numbers), `recent`, `lenders` (arrays). |
| `web` | object, nullable | `domain` (string), `from` (`entered`, `register` or `Wikidata`), `registered` (date, nullable), `age` (string, optional). |
| `financials` | object, nullable | Key figures, where a register publishes them. Register-specific. |
| `about` | object, nullable | Wikidata: `wikipedia`, `founded`, `hq`, `industries`, `employees`, `listings`, `parents`, `subsidiaries`, `website`. |
| `presence` | object, optional | Only when places are linked: `notice` (string) and `locations` (array of [place summary](#place-summary), up to 25). Never replaces register facts. |
| `sources` | array | `{ name, result, url }` for every source checked. `url` nullable. |
| `gaps` | array of string | What could not be checked, and why. |
| `next_step` | string | A suggested next step. |
| `rules` | object | The thresholds flags used: `youngCompanyMonths`, `newDomainMonths`, `recentChangeMonths` (numbers). |

`identity` fields (all present; nullable unless stated):

| Field | Type | Notes |
| --- | --- | --- |
| `legal_name` | string | |
| `country` | string | ISO alpha-2. |
| `legal_form` | string | |
| `status`, `status_detail` | string | As the register words it, e.g. `Active`. |
| `incorporated`, `incorporated_source` | string | Date, and which source gave it. |
| `age` | string | e.g. `16 years, 8 months`. |
| `ceased` | string | Date. |
| `registered_address`, `hq_address` | string | One line. |
| `sic_codes`, `industry`, `other_names`, `extra` | array of string (`extra`: array) | Never null. |
| `former_names` | array | `{ name, from, to }`. Never null. |
| `employees`, `size`, `website`, `auditor`, `share_capital` | varies | Where the register publishes them. |
| `vat` | object | `number` and, after a VIES check, `vies: { valid, name, checked }`. |
| `sole_trader` | boolean | Never null. |
| `register` | object | `{ name, number, url }` (`url` nullable). |

## GET /v1/presence

One place from [Overture Maps](https://overturemaps.org), by its GERS ID. Presence data shows that a business **appears** to exist at an address. It is **not an official record and not a legal identifier**, and has no verdict, flags or status.

**Parameters (query string)**

| Name | Required | Type | Notes |
| --- | --- | --- | --- |
| `id` | yes | string | GERS ID (UUID). An `overture:` prefix is accepted. |
| `lon`, `lat` | no | number | Decimal degrees. Give both if you know them (e.g. from the map): the lookup is much faster. |
| `link` | no | string | `0` to skip matching the place to legal entities. |

**Errors:** `bad_request`, `not_found` (with `tier`, `notice`), `upstream_unavailable` (Overture could not be reached), `rate_limited`.

**Response: the presence card**

| Field | Type | Notes |
| --- | --- | --- |
| `api_version` | string | `"1"` |
| `tier` | string | `presence` |
| `notice` | string | `Presence data from Overture Maps. Not an official record and not a legal identifier.` Show it with the data. |
| `id` | string | GERS ID. |
| `name` | string, nullable | |
| `categories` | object, nullable | `primary` (string, nullable), `basic` (string, nullable), `hierarchy` (array of string), `alternates` (array of string). |
| `address` | object | `street`, `locality`, `postcode`, `region`, `country`: strings, nullable. |
| `location` | object, nullable | `lon`, `lat`. |
| `websites`, `phones`, `socials` | array of string, optional | Only where present. |
| `brand` | object, optional | `name` (string), `wikidata` (string, nullable). A brand never links a place to a company. |
| `confidence` | number, nullable | Overture's own score, 0 to 1. |
| `sources` | array | `{ dataset, license, update_time, record_id, properties }`: dataset string; license, update_time, record_id nullable strings; properties array of string. |
| `attribution` | string | `© Overture Maps Foundation. Sources: …`. Show it where you show the data. |
| `release` | string | The Overture release, e.g. `2026-10-21.0`. Read from Overture's STAC catalog every hour; releases are removed after about 60 days. |
| `checked_at` | string | When Company Lookup fetched it. |
| `linked_entity` | object, nullable | The legal entity this place is linked to on a **strong match** (same website domain, similar name, same country). See [link](#link). |
| `possible_matches` | array of [link](#link) | **Probable** matches, shown as "possibly the same as…", never merged. |
| `official_register` | object, nullable | `{ label, register, tool, arguments }`: where the country has a register, the search to run to check it (`arguments` are `/v1/search` parameters: `query`, `country`). |
| `link_note` | string, optional | e.g. when a link was reported and is held back, or matching didn't finish in time. |

### Link

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Company id; pass to `/v1/company`. |
| `name` | string | |
| `register` | string | |
| `number` | string, nullable | |
| `level` | string | `strong` or `probable`. |
| `evidence` | object | What matched, e.g. `domain`, `name`, `country`, `postcode`. |
| `linked_on` | string | Date. |
| `text` | string | A readable sentence, e.g. `This place is linked to … (Companies House, 06960521).` |
| `report` | object | `{ method: "POST", url, body: { id, entity_id } }`: how to report the link as wrong. On v1, `url` is a full URL to `/v1/presence-report`. |

## POST /v1/presence-report

Reports a link between a place and a company as wrong. The link is held back from cards and search until a person reviews it. An API key unlocks nothing extra here; reports sent with one are labelled with the caller's name.

**Body (JSON)**

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `id` | yes | string | GERS ID of the place. |
| `entity_id` | yes | string | The linked entity's id (from `linked_entity.id` or `possible_matches[].id`). |
| `reason` | no | string | Up to 500 characters. |

**Response:** `api_version`, `ok` (boolean, `true`), `status` (`reported`), `message` (string).

**Errors:** `bad_request`, `not_found` (no such link), `not_configured` (no link store on this deployment), `upstream_unavailable` (the store could not be written), `rate_limited`.

## GET /v1/coverage

How many companies each source holds. No parameters.

| Field | Type | Notes |
| --- | --- | --- |
| `api_version` | string | `"1"` |
| `as_of` | string | Date. |
| *other fields* | | As `/api/coverage`: per-source counts, where each count says whether it was asked today or comes from the register's published statistics. |

## GET /v1/health

Whether the service is up. Cheap: no register calls; cached for 10 seconds. Always HTTP 200 when the service answers; read `status`.

| Field | Type | Notes |
| --- | --- | --- |
| `status` | string | `ok` or `degraded` (Overture or the Blob store could not be reached). |
| `api_version` | string | `"1"` |
| `version` | string | The code's package version, e.g. `1.0.0`. |
| `commit` | string, nullable | The git commit deployed (on Vercel). |
| `overture_release` | string, nullable | The Overture release in use. |
| `blob` | object | `configured` (boolean), `reachable` (boolean, nullable when not configured). |
| `sources` | object | `companies_house` (`configured` or `not_configured`), `overture` (`ok` or `unreachable`), `blob` (`ok`, `unreachable` or `not_configured`), `registers` (number of national register adapters). Registers are not called; their live state shows in search `warnings` and card `gaps`. |
| `checked_at` | string | When this answer was worked out. |

## Example

```bash
curl -s "https://open-company-lookup.vercel.app/v1/search?q=Tesco&country=GB" \
  -H "Authorization: Bearer $COMPANY_LOOKUP_API_KEY"
```

```json
{ "api_version": "1", "query": "Tesco", "country": "GB",
  "results": [{ "id": "gb:00445790", "tier": "register", "source": "Companies House", "name": "TESCO PLC", "country": "GB", "status": "active", "number": "00445790" }],
  "presence": [], "warnings": [] }
```
