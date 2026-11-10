# Hosted-index countries

Some registers publish only downloadable files, with no search API. To search them, the files are turned into a small search index in your **Vercel Blob** store (`BLOB_READ_WRITE_TOKEN`). The countries are listed in [COUNTRIES.md](../../COUNTRIES.md).

## How it works
1. **Vercel Cron** (or you, with `curl`) calls `/api/bulk-import?country=CY`. The job runs only if the index is missing, more than 20 days old or built with an older layout, and no other run holds the lock. Extra calls do nothing.
2. The country's importer (`lib/bulk/<cc>.js`) downloads the official files and turns them into normalised records: `number, name, legal_form, status, status_label, flag, incorporated, status_date, registered_address, officers`.
   - ZIPs are read over HTTP ranges where the server allows it (`zip.js`), so whole archives are not downloaded.
   - UTF-8, UTF-16 and Latin-1 are supported, as are CSV, pipe-separated text, XLSX (`xlsx.js`) and XML.
   - Individuals and sole traders are left out.
3. `index.js` writes a new version: a word index in word buckets (`s/`, with crowded prefixes split into `t/`) and full records in record buckets (`d/`). Large countries are built in two passes (word index, then records) so they fit in memory. Every file stays under about 1 MB.
4. `manifest.json` is pointed at the new version, and older versions are deleted. If the new build has under 80% of the previous count, the old index is kept.
5. `lib/registers/<cc>.js` reads the manifest and buckets. Search matches whole words by prefix ("bank cyp" finds Bank of Cyprus).

## Checking a source layout
`/api/bulk-import?country=CY&peek=1` returns the first few KB of a country's source files without building anything. Use it when a publisher changes its file layout.
