# Changelog

Changes to the HTTP API, the MCP server and the library. The `/v1/` contract is in [docs/api-v1.md](docs/api-v1.md): within v1, fields are only added. A breaking change means `/v2/`, announced here and in the README at least 6 months before v1 stops.

## 2026-11-16: `/v1/` API

- **New:** stable `/v1/` routes (`search`, `company`, `presence`, `presence-report`, `coverage`) on the same handlers as `/api/*`. Every v1 response has `"api_version": "1"`.
- **New:** `GET /v1/health`: status, version, commit, Overture release, Blob store reachability.
- **New:** one v1 error shape, `{ "api_version": "1", "error": { "code", "message" } }`, with codes `bad_request`, `not_found`, `method_not_allowed`, `rate_limited` (with `retry_after` and `Retry-After`), `internal`, `upstream_unavailable`, `upstream_busy` and `not_configured`.
- **New:** optional API keys for trusted callers (`Authorization: Bearer` or `X-Api-Key`; `COMPANY_LOOKUP_API_KEYS`, `COMPANY_LOOKUP_KEY_RATE_LIMIT`; `scripts/new-api-key.js`).
- **New:** `COMPANY_LOOKUP_PUBLIC_URL` sets the base URL of links in v1 responses (e.g. `linked_entity.report.url`, a full URL on v1).
- **Unchanged:** `/api/*` responses, errors and limits; the MCP server; the library.

## 2026-11-15: presence data

- Overture Maps presence cards (`/api/presence`, `get_presence_card`, `lookup.presence()`), links to legal entities, `POST /api/presence-report`, and `tier` on search results.
