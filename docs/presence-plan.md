# Presence data from Overture Maps: plan and phase 3 proposal

Status, 16 Nov 2026: phases 1 and 2 are built. Phase 3 is being piloted (decided 16 Nov: Europe pilot on option A, Vercel Blob, spend limit $10 a month): DE, IT, ES, NL, BE and AT. See [Phase 3 pilot: as built](#phase-3-pilot-as-built) at the end.

## How it fits the existing code

- **Same flow as the company card.** `lib/handlers.js` gains a `presence` handler next to `search` and `company`. It is served at `/api/presence`, exposed as the MCP tool `get_presence_card` and the library method `lookup.presence()`, as the existing handlers are.
- **Tiers.** Search results gain a `tier` field: `register` for national registers, `gleif` for GLEIF. Presence records carry `tier: "presence"` and the fixed notice. Nothing existing is renamed or removed; all changes add fields.
- **No flags.** Presence cards have no verdict, flags or status. They don't go through `lib/card.js`. `lib/presence.js` builds them as pure functions, so they're easy to test, the same way `card.js` is.
- **Names** use the existing `gleif.normName()`, plus legal-form words it doesn't drop yet (Tbk, PT, S.L.U., Ltda and others). GLEIF ranking itself is unchanged.
- **Storage** follows the hosted-index pattern. Links live in the project's Vercel Blob store as `presence/index.json`, written through the existing `lib/blob.js` (OIDC or a token). Without a store, everything still works: links are worked out on each lookup and not kept.
- **Sources.** Each presence fact names its Overture source dataset, licence and update time. Presence data never overwrites a register fact. A company card only gains a separate `presence.locations` block.

## Phase 1: reading Overture

**DuckDB was checked and not used.** The `duckdb` Node package is a native binary of about 60 to 100 MB. It also downloads the `httpfs` and `spatial` extensions at runtime. That is a large cold start on a Vercel function, and an extra download that can fail.

**Instead: `hyparquet`.** It is pure JavaScript, about 300 KB, and has no native code. It reads the GeoParquet files over HTTP range requests, and Node's built-in zlib handles zstd. Measured from Vercel `iad1` on release 2026-10-21.0:

| Request | Time |
| --- | --- |
| With lon/lat, warm | 0.4–1.6 s |
| With lon/lat, cold function | about 5 s (one 1.6 s footer read of a 725 MB file) |
| By ID only, through the GERS registry | 4–8 s |

How a lookup works:

1. Get the release from `stac.overturemaps.org/catalog.json` (`latest`), cached for 1 hour. This step also gives the registry manifest.
2. **With lon/lat:** use the STAC items to find the place files whose bbox covers the point. Within those files, read only the row groups whose bbox statistics contain the point. Row groups hold about 15,000 rows each. Read the `id` column first, then the one matching row.
3. **Without lon/lat, or when the point misses:**
   - Use the manifest to pick the right registry file out of the 50, sorted by ID.
   - Read the one row group that holds the ID, which gives the place's `path` and `bbox`.
   - Then do step 2 on that file.
4. Cache the row in memory by release and ID. The CDN caches responses for 1 hour.

**Schema note.** Overture removed `categories` in September 2026. The card's `categories` comes from `taxonomy` (primary, hierarchy, alternates) plus `basic_category`.

## Phase 2: linking

The rules are in `lib/presence.js` (`classify`, `bestMatch`):

- **Candidates.** The top 3 results of `search_companies(name, country)` in the same country, each with its card's website and registered address.
- **Strong match.** The same registrable domain and a similar name. These are linked automatically.
  - Social and listing platforms (facebook.com, instagram.com, whatsapp and the like) are never domain evidence.
  - If two different entities both match strongly, neither is linked; both are shown as probable.
- **Probable match.** Shown as "possibly the same as…" and never merged. A match is probable when either:
  - the name is similar and the postcode or street is the same, or
  - the domain is the same but the name is very different.
- **Brand is never used.**
- **What a link stores.** Links are keyed by GERS ID, so they survive releases. Each link records:
  - the entity id and its other ids (register id, LEI)
  - the level
  - the evidence
  - the date
  - its status (`active`, or `reported`).
- **Checks and reports.**
  - Each record is checked again after 30 days.
  - A reported link stays held out until a reviewer changes it.
  - Entities in `rejected` are never linked again.
- **Search.**
  - Legal entities come first.
  - Linked places sit under their entity as `locations`.
  - Other known places follow in `presence`, labelled "Not an official record".
  - Until phase 3, "known" means places that have been looked up before.

**Known limit.** The index is one JSON file, written read-modify-write. Two writes at the same moment can lose one record, which is then worked out again on its next lookup. That is fine at today's volume; phase 3 replaces it.

## Phase 3 proposal: name search in countries without a register

**Problem.** Map tiles can't be searched by name. To find a place by name, Company Lookup needs its own extract of Overture places for the countries where no register is connected.

**Countries and row counts.** Estimated by sampling every 16th row group (5.6 M of the 88.4 M places) in release 2026-10-21.0, by `addresses[0].country`:

| Region | Countries (places, millions) | Total |
| --- | --- | --- |
| Europe | DE 5.2, IT 4.6, ES 2.8, NL 1.4, BE 0.9, AT 0.7, DK 0.7, GR 0.4, PT 0.4, SE 0.4, LT 0.2, HU 0.2, HR 0.2 | about 18 M |
| Rest of world | MX 3.6, ID 3.0, JP 3.0, VN 1.8, TR 1.5, TH 1.5, ZA 1.1, PH 0.9, SA 0.8, MY 0.7, EG 0.4, LK 0.4, KR 0.3, NG 0.3 | about 19 M |

Dropping non-business categories (parks, landmarks, places of worship, transit stops) should remove roughly a quarter. This still needs measuring.

**Storage.** For each row, keep the GERS ID, name, normalised name, country, address, point, websites, phones, category and release. That is about 250 bytes as JSON and about 100 bytes gzipped.

| Option | Size | Cost and notes |
| --- | --- | --- |
| **A. Vercel Blob shards** (recommended) | All countries about 3–4 GB, Europe pilot about 1.5 GB | Gzipped JSON shards by country and name prefix, the same pattern as the hosted register indexes (`lib/bulk`). A few dollars a month for storage. One upload per shard per month. No new service. Supports exact and prefix name search, not fuzzy. |
| B. Supabase Postgres with `pg_trgm` | About 15 GB with indexes for all countries; the Europe pilot about 6 GB fits the 8 GB Pro disk | Fuzzy search. Supabase is already in the CreditPilot stack. About $25–30 a month on Pro. |
| C. BigQuery public `overture_maps` dataset | No storage of our own | Billed by bytes scanned on every search. Too expensive and slow per query. Not recommended. |

Check current Vercel Blob and Supabase pricing before deciding. These figures are estimates.

**Refresh.**

1. A monthly GitHub Actions workflow (free for this public repo) runs after Overture's release.
2. It uses DuckDB with `httpfs` on the runner to filter places by country and category straight from S3, then writes the shards.
3. It uploads them under a new release prefix.
4. It switches a small manifest to the new release, then deletes the previous one.
5. GERS IDs are stable, so stored links stay valid.

The expected run time is 15–30 minutes.

**Suggested first step.** A Europe pilot on option A for DE, IT, ES, NL, BE and AT, about 15 M places before category filtering. Measure search quality against the probable-match rules. Then decide on the rest of the world, and on whether fuzzy search (option B) is worth the cost.

## Phase 3 pilot: as built

- **Countries:** DE, IT, ES, NL, BE, AT (`PILOT` in `lib/places.js`). Release 2026-10-21.0 has 13.7 M places there before filtering (DE 4.87 M, IT 3.76 M, ES 2.45 M, NL 1.30 M, BE 0.79 M, AT 0.57 M).
- **Kept:** places with a name, not `permanently_closed`, outside the `geographic_entities` and `cultural_and_historic` top-level categories. In a Hamburg sample, about 4% were permanently closed and about 1% were in the dropped categories.
- **Extract:** `scripts/places/extract.sql` (DuckDB on a GitHub Actions runner, reading Overture's public S3 GeoParquet; no keys).
- **Index:** the hosted-register word index (`lib/bulk/index.js`) with a place row: GERS ID, name, category, address, point, confidence, and source datasets with licences. Search matches whole words by prefix, accents ignored. Files live under `places/<cc>/<version>/` in the Blob store, with `places/<cc>/manifest.json`.
- **Getting it into Blob without a token:** `.github/workflows/places-monthly.yml` (26th of each month, after Overture's release) attaches the packs to a GitHub release (`places-<release>`). `POST /api/places-import` then copies each pack into Blob with the site's own OIDC sign-in and switches the manifest. Finalising refuses until every file is in, and refuses a build with under 80% of the live count. Older releases and versions are removed.
- **Search:** with `country` set to a pilot country, `search` adds matching stored places to the `presence` list (after linked places, up to 10, labelled "Not an official record", `linked_entity: null`). They never appear in `results`, and a slow or missing index never breaks search (4 s limit).
- **Health:** `/v1/health` shows `places`: per country `{ release, count, built_at }`, or `null` when not built.
- **Cost (Vercel Pro, checked 16 Nov 2026):** storage $0.023 per GB-month, writes $5 per million. The pilot is about 5 GB and some thousands of writes a month: well under $1 a month.
- **Not yet:** fuzzy matching (option B), other countries, and linking stored places to legal entities before someone opens their presence card.
