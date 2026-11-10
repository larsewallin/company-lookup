# Countries

Company Lookup searches these national registers, plus the global LEI register (GLEIF), Wikidata, the EU VAT check (VIES) and domain records (RDAP) for every country.

- **Live API:** searched at the official source on each lookup. Works with no setup (the UK needs a free key).
- **Hosted index:** the register publishes only bulk files, so a monthly import turns them into a search index in your own Vercel Blob store. See [Hosted-index countries](README.md#hosted-index-countries).

| Country | Code | Register | How | Code files |
|---|---|---|---|---|
| Argentina | AR | Registro Nacional de Sociedades (Argentina) | Hosted index | `lib/registers/ar.js` (search), `lib/bulk/ar.js` (import) |
| Australia | AU | ASIC (Australia) | Live API | `lib/registers/au.js` |
| Brazil | BR | CNPJ (Brazil) | Live API | `lib/registers/br.js` |
| Canada | CA | Corporations Canada (federal); Registraire des entreprises (Quebec) | Hosted index | `lib/registers/ca.js` (search), `lib/bulk/ca.js`, `lib/bulk/qc.js` (import) |
| Chile | CL | Registro de Empresas y Sociedades (Chile) | Hosted index | `lib/registers/cl.js` (search), `lib/bulk/cl.js` (import) |
| Colombia | CO | RUES (Colombia) | Live API | `lib/registers/co.js` |
| Cyprus | CY | Registrar of Companies (Cyprus) | Hosted index | `lib/registers/cy.js` (search), `lib/bulk/cy.js` (import) |
| Czechia | CZ | ARES (Czechia) | Live API | `lib/registers/cz.js` |
| Dominican Republic | DO | DGII taxpayer register (Dominican Republic) | Hosted index | `lib/registers/do.js` (search), `lib/bulk/do.js` (import) |
| Ecuador | EC | SRI RUC register (Ecuador) | Hosted index | `lib/registers/ec.js` (search), `lib/bulk/ec.js` (import) |
| Estonia | EE | Äriregister (Estonia) | Live API | `lib/registers/ee.js` |
| Finland | FI | PRH (Finland) | Live API | `lib/registers/fi.js` |
| France | FR | French business register | Live API | `lib/registers/fr.js` |
| Hong Kong | HK | Companies Registry (Hong Kong) | Live API | `lib/registers/hk.js` |
| India | IN | Ministry of Corporate Affairs (India) | Hosted index | `lib/registers/in.js` (search), `lib/bulk/in.js` (import) |
| Ireland | IE | CRO (Ireland) | Live API | `lib/registers/ie.js` |
| Israel | IL | Israeli Companies Registrar | Live API | `lib/registers/il.js` |
| Latvia | LV | Latvian Register of Enterprises | Live API | `lib/registers/lv.js` |
| Luxembourg | LU | RCS annual accounts (Luxembourg) | Hosted index | `lib/registers/lu.js` (search), `lib/bulk/lu.js` (import) |
| Moldova | MD | State Register of legal units (Moldova) | Hosted index | `lib/registers/md.js` (search), `lib/bulk/md.js` (import) |
| New Caledonia | NC | RIDET (New Caledonia) | Live API | `lib/registers/nc.js` |
| Norway | NO | Brønnøysund (Norway) | Live API | `lib/registers/no.js` |
| Paraguay | PY | DNIT RUC register (Paraguay) | Hosted index | `lib/registers/py.js` (search), `lib/bulk/py.js` (import) |
| Peru | PE | SUNAT RUC register (Peru) | Hosted index | `lib/registers/pe.js` (search), `lib/bulk/pe.js` (import) |
| Poland | PL | KRS (Poland) | Live API | `lib/registers/pl.js` |
| Romania | RO | ONRC trade register (Romania) | Hosted index | `lib/registers/ro.js` (search), `lib/bulk/ro.js` (import) |
| Russia | RU | Federal Tax Service open data (Russia) | Hosted index | `lib/registers/ru.js` (search), `lib/bulk/ru.js` (import) |
| Singapore | SG | ACRA (Singapore) | Live API | `lib/registers/sg.js` |
| Slovakia | SK | RPO (Slovakia) | Live API | `lib/registers/sk.js` |
| Slovenia | SI | AJPES business register (Slovenia) | Hosted index | `lib/registers/si.js` (search), `lib/bulk/si.js` (import) |
| Switzerland | CH | Zefix (Switzerland) | Live API | `lib/registers/ch.js` |
| Taiwan | TW | Company register (Taiwan) | Live API | `lib/registers/tw.js` |
| Ukraine | UA | Unified State Register (Ukraine) | Hosted index | `lib/registers/ua.js` (search), `lib/bulk/ua.js` (import) |
| United Kingdom | GB | Companies House | Live API (free key) | `lib/sources.js` |
| United States | US | US sources (SEC, NY, CO, CT, TX, OR, PA) | Live API | `lib/registers/us.js` |

## Not covered yet

Some large economies have no free, machine-readable register: for example Germany, Italy, Spain, Portugal, Mexico, Turkey, the UAE, South Africa and most of Africa and the Middle East. Companies there are still found when they hold an LEI.

Free registers that need a sign-up, and could be added with your own key: Austria, Belgium, Croatia, Denmark, Greece, Japan, Kazakhstan, New Zealand, South Korea and Sweden.

Pull requests for new countries are welcome: copy an adapter in `lib/registers/` (each exports `country`, `name`, `search`, `get` and `normalise`) and add it to `lib/registers/index.js`.
