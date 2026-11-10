// Reading ZIP archives over HTTP without downloading them whole: the central directory comes from a
// Range request on the end of the file, and each entry is fetched by range and inflated as a stream.
'use strict';
const { userAgent } = require('../ua');

const zlib = require('zlib');

async function range(fetchFn, url, start, end) {
  const r = await fetchFn(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (r.status !== 206 && !(r.status === 200 && start === 0)) throw new Error(`Range request not supported (HTTP ${r.status})`);
  return { buf: Buffer.from(await r.arrayBuffer()), total: Number(String(r.headers.get('content-range') || '').split('/')[1]) || null };
}

// List entries: [{ name, method, compressedSize, size, offset }]
async function entries(fetchFn, url) {
  const head = await fetchFn(url, { headers: { Range: 'bytes=0-0' } });
  const total = Number(String(head.headers.get('content-range') || '').split('/')[1]);
  if (!total) throw new Error('Could not read the archive size');
  const tailLen = Math.min(total, 70000);
  const { buf } = await range(fetchFn, url, total - tailLen, total - 1);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a ZIP archive');
  let count = buf.readUInt16LE(eocd + 10); let cdSize = buf.readUInt32LE(eocd + 12); let cdOffset = buf.readUInt32LE(eocd + 16);
  // ZIP64
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
      const z64 = Number(buf.readBigUInt64LE(loc + 8)); const r = await range(fetchFn, url, z64, z64 + 55);
      count = Number(r.buf.readBigUInt64LE(32)); cdSize = Number(r.buf.readBigUInt64LE(40)); cdOffset = Number(r.buf.readBigUInt64LE(48));
    }
  }
  const cd = cdOffset >= total - tailLen ? buf.subarray(cdOffset - (total - tailLen)) : (await range(fetchFn, url, cdOffset, cdOffset + cdSize - 1)).buf;
  const out = []; let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const method = cd.readUInt16LE(p + 10); let csize = cd.readUInt32LE(p + 20); let size = cd.readUInt32LE(p + 24);
    const nlen = cd.readUInt16LE(p + 28); const xlen = cd.readUInt16LE(p + 30); const clen = cd.readUInt16LE(p + 32);
    let offset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nlen).toString('utf8');
    // ZIP64 extra field
    let x = p + 46 + nlen; const xend = x + xlen;
    while (x + 4 <= xend) {
      const id = cd.readUInt16LE(x); const len = cd.readUInt16LE(x + 2);
      if (id === 0x0001) { let q = x + 4; if (size === 0xffffffff) { size = Number(cd.readBigUInt64LE(q)); q += 8; } if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; } if (offset === 0xffffffff) { offset = Number(cd.readBigUInt64LE(q)); } }
      x += 4 + len;
    }
    out.push({ name, method, compressedSize: csize, size, offset });
    p = xend + clen;
  }
  return out;
}

// Stream one entry's text (inflated). Yields strings. encoding: 'utf-8' (default) or 'utf-16le'.
async function* text(fetchFn, url, entry, encoding = 'utf-8') {
  const { buf: lh } = await range(fetchFn, url, entry.offset, entry.offset + 29);
  const start = entry.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  // The download is cancelled if the reader stops early (e.g. a peek), so nothing is left running unhandled.
  const ac = new AbortController();
  const r = await fetchFn(url, { headers: { Range: `bytes=${start}-${start + entry.compressedSize - 1}` }, signal: ac.signal });
  if (r.status !== 206) throw new Error(`Range request for ${entry.name} failed (HTTP ${r.status})`);
  const dec = new TextDecoder(encoding);
  if (entry.method === 0) {
    try { for await (const c of r.body) yield dec.decode(c, { stream: true }); } finally { ac.abort(); }
    return;
  }
  if (entry.method !== 8) throw new Error(`Unsupported compression method ${entry.method}`);
  const inflate = zlib.createInflateRaw();
  let pumpErr = null; let stopped = false;
  const pump = (async () => {
    for await (const c of r.body) { if (stopped) return; if (!inflate.write(c)) await new Promise((ok) => { const done = () => { inflate.off('drain', done); inflate.off('close', done); ok(); }; inflate.on('drain', done); inflate.on('close', done); }); }
    inflate.end();
  })().catch((e) => { if (!stopped) { pumpErr = e; inflate.destroy(e); } });
  try {
    for await (const c of inflate) yield dec.decode(c, { stream: true });
  } finally {
    stopped = true; ac.abort(); inflate.destroy(); await pump;
  }
  if (pumpErr) throw pumpErr;
  const tail = dec.decode(); if (tail) yield tail;
}

// Servers without Range support: read a whole (small) archive from memory.
function entriesFromBuffer(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a ZIP archive');
  const count = buf.readUInt16LE(eocd + 10); const cdOffset = buf.readUInt32LE(eocd + 16);
  const out = []; let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nlen = buf.readUInt16LE(p + 28); const xlen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32);
    out.push({ name: buf.subarray(p + 46, p + 46 + nlen).toString('utf8'), method: buf.readUInt16LE(p + 10), compressedSize: buf.readUInt32LE(p + 20), size: buf.readUInt32LE(p + 24), offset: buf.readUInt32LE(p + 42) });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

async function* textFromBuffer(buf, entry, encoding = 'utf-8') {
  const start = entry.offset + 30 + buf.readUInt16LE(entry.offset + 26) + buf.readUInt16LE(entry.offset + 28);
  const raw = buf.subarray(start, start + entry.compressedSize);
  const dec = new TextDecoder(encoding);
  if (entry.method === 0) { yield dec.decode(raw); return; }
  if (entry.method !== 8) throw new Error(`Unsupported compression method ${entry.method}`);
  const inflate = zlib.createInflateRaw(); inflate.end(raw);
  for await (const c of inflate) yield dec.decode(c, { stream: true });
  const tail = dec.decode(); if (tail) yield tail;
}

// Download a whole archive (refuses anything over maxBytes).
async function fetchWhole(fetchFn, url, maxBytes = 200e6) {
  const r = await fetchFn(url, { headers: { 'User-Agent': userAgent() } });
  if (!r.ok) throw new Error(`Download failed (HTTP ${r.status}): ${url.split('/').pop()}`);
  const len = Number(r.headers.get('content-length') || 0);
  if (len > maxBytes) throw new Error(`${url.split('/').pop()} is ${len} bytes, over the ${maxBytes}-byte limit`);
  return Buffer.from(await r.arrayBuffer());
}

// Read every entry of a ZIP in one sequential download (for archives with thousands of small files, where a range
// request per entry would be too slow). onEntry(entry, text) is awaited for each entry in archive order.
async function eachEntry(fetchFn, url, list, onEntry, encoding = 'utf-8') {
  const sorted = list.filter((e) => e.compressedSize > 0).sort((a, b) => a.offset - b.offset);
  const UA = { 'User-Agent': userAgent() };
  // A dropped connection is resumed with a Range request from the first byte not yet received (up to 5 times).
  let it = null; let retries = 0;
  const open = async (from) => {
    const r = await fetchFn(url, { headers: from ? { ...UA, Range: `bytes=${from}-` } : UA });
    if (!(r.ok || r.status === 206)) throw new Error(`Download failed (HTTP ${r.status}): ${url.split('/').pop()}`);
    if (from && r.status !== 206) throw new Error('Server did not resume the download (no Range support)');
    it = r.body[Symbol.asyncIterator]();
  };
  await open(0);
  let buf = Buffer.alloc(0); let pos = 0; // pos = archive offset of buf[0]
  const next = async () => {
    for (;;) {
      try { return await it.next(); } catch (e) {
        if (++retries > 5) throw e;
        try { if (it.return) await it.return(); } catch (x) { /* ignore */ }
        await open(pos + buf.length);
      }
    }
  };
  const need = async (end) => { while (pos + buf.length < end) { const { value, done } = await next(); if (done) throw new Error('ZIP ended early'); buf = buf.length ? Buffer.concat([buf, Buffer.from(value)]) : Buffer.from(value); } };
  const drop = (to) => { if (to > pos) { buf = buf.subarray(to - pos); pos = to; } };
  try {
    for (const e of sorted) {
      await need(e.offset + 30); drop(e.offset);
      const start = e.offset + 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
      await need(start + e.compressedSize);
      const raw = buf.subarray(start - pos, start - pos + e.compressedSize);
      const data = e.method === 0 ? raw : e.method === 8 ? zlib.inflateRawSync(raw) : null;
      if (!data) throw new Error(`Unsupported compression method ${e.method}`);
      drop(start + e.compressedSize);
      await onEntry(e, new TextDecoder(encoding).decode(data));
    }
  } finally { try { if (it.return) await it.return(); } catch (x) { /* ignore */ } }
}

module.exports = { entries, text, entriesFromBuffer, textFromBuffer, fetchWhole, eachEntry };
