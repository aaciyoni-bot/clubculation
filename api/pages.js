// Shared page store: GET returns {pages, meta}; POST (with the edit PIN) replaces or deletes one page.
// Storage: Vercel Blob (BLOB_READ_WRITE_TOKEN is injected when a Blob store is connected to the project).
// Until a store is connected, GET serves the list bundled with the deployment and POST reports 503.
const { put, list, del } = require('@vercel/blob');
const crypto = require('crypto');
const { PagesModel } = require('../src/model.js');
let getVercelOidcToken = null;
try { getVercelOidcToken = require('@vercel/oidc').getVercelOidcToken; } catch (e) {}

// Blob credentials: a store-scoped read/write token, or the deployment's OIDC token + BLOB_STORE_ID.
function storeConfigured() { return !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID); }
async function blobOpts(req) {
  if (process.env.BLOB_READ_WRITE_TOKEN) return {};
  let t = null;
  if (getVercelOidcToken) { try { t = await getVercelOidcToken(); } catch (e) {} }
  if (!t && req && req.headers) t = req.headers['x-vercel-oidc-token'] || null;
  if (!t) t = process.env.VERCEL_OIDC_TOKEN || null;
  return t ? { oidcToken: t, storeId: process.env.BLOB_STORE_ID } : {};
}

// Every write goes to a NEW versioned path: public blob URLs are CDN-cached (60 s minimum), so re-reading
// the same URL right after a write can return stale data and a later save would then drop the earlier one.
// A fresh URL per version is never cached; list() (an API call) finds the newest.
const BLOB_PREFIX = 'weapon-pages/pages-';
const LEGACY_PATH = 'weapon-pages/pages.json';
const KEEP_VERSIONS = 5;

let SEED = null;
try { SEED = require('../src/seed.json'); } catch (e) { SEED = null; }
// The series bundled with this deployment (src/seed.json), as a v2 state.
function bundled() {
  const st = PagesModel.empty();
  if (SEED && SEED.id && SEED.pages) {
    st.series[SEED.id] = { name: SEED.name, created: SEED.created };
    for (const pg of Object.keys(SEED.pages)) {
      st.pages[SEED.id + '/' + pg] = SEED.pages[pg];
      st.meta[SEED.id + '/' + pg] = { added: SEED.created, src: SEED.src || 'manual' };
    }
  }
  return st;
}

async function latestBlob(req) {
  const opts = await blobOpts(req);
  const { blobs } = await list({ prefix: BLOB_PREFIX, limit: 1000, ...opts });
  if (blobs.length) return blobs.reduce((x, y) => (x.pathname > y.pathname ? x : y));
  const legacy = await list({ prefix: LEGACY_PATH, limit: 1, ...opts });
  return legacy.blobs[0] || null;
}

async function readStore(req) {
  if (!storeConfigured()) return { state: bundled(), source: 'bundled' };
  const blob = await latestBlob(req);
  if (!blob) return { state: bundled(), source: 'bundled' };
  const res = await fetch(blob.url + '?t=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error('blob read failed ' + res.status);
  const state = PagesModel.upgrade(await res.json());
  return { state, source: 'blob' };
}

// Series bundled with the deployment are merged into the store once each (by series id).
// Deleting such a series afterwards is final: the id stays listed in state.seeds.
function mergeSeeds(state) {
  const b = PagesModel.upgrade(bundled());
  state.seeds = Array.isArray(state.seeds) ? state.seeds : [];
  let changed = false;
  for (const sid of Object.keys(b.series)) {
    if (state.seeds.includes(sid)) continue;
    if (!state.series[sid]) {
      state.series[sid] = b.series[sid];
      for (const k of Object.keys(b.pages)) if (k.startsWith(sid + '/')) { state.pages[k] = b.pages[k]; state.meta[k] = b.meta[k] || {}; }
    }
    state.seeds.push(sid); changed = true;
  }
  return changed;
}

async function writeStore(state, req) {
  const opts = await blobOpts(req);
  const name = BLOB_PREFIX + String(Date.now()).padStart(14, '0') + '.json';
  await put(name, JSON.stringify(state), {
    access: 'public', addRandomSuffix: false, allowOverwrite: false,
    contentType: 'application/json', cacheControlMaxAge: 60, ...opts,
  });
  // best-effort cleanup of old versions (a few are kept as a safety net)
  try {
    const { blobs } = await list({ prefix: BLOB_PREFIX, limit: 1000, ...opts });
    const old = blobs.map((x) => x.pathname).sort().slice(0, -KEEP_VERSIONS);
    if (old.length) await del(old, opts);
  } catch (e) { console.warn('cleanup failed', e && e.message); }
}

function pinOk(given) {
  const want = process.env.EDIT_PIN || '';
  if (!want || typeof given !== 'string') return false;
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const norm = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^0-9A-Zא-ת]/g, '');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://x');
      if (storeConfigured()) {
        const cur = await readStore(req);
        if (cur.source === 'blob' && mergeSeeds(cur.state)) await writeStore(cur.state, req);
      }
      const selftest = url.searchParams.get('selftest');
      if (selftest != null) {
        // diagnostics: with the PIN, re-write the current state and read it back
        if (!pinOk(selftest)) return res.status(401).json({ error: 'pin' });
        if (!storeConfigured()) return res.status(503).json({ error: 'no_store' });
        const before = await readStore(req);
        await writeStore(PagesModel.upgrade(before.state), req);
        const after = await readStore(req);
        const n = Object.keys(after.state.pages).length;
        return res.status(200).json({ ok: after.source === 'blob', before: before.source, after: after.source, pages: n });
      }
      const { state, source } = await readStore(req);
      return res.status(200).json({ ...PagesModel.upgrade(state), source, writable: !!(storeConfigured() && process.env.EDIT_PIN) });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!pinOk(body.pin)) return res.status(401).json({ error: 'pin' });
    if (!storeConfigured()) return res.status(503).json({ error: 'no_store' });
    const { state: current } = await readStore(req);
    mergeSeeds(current);
    const today = new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
    const r = PagesModel.apply(current, body, today);
    if (r.error) return res.status(400).json({ error: r.error });
    const state = r.state;
    await writeStore(state, req);
    return res.status(200).json({ ...state, source: 'blob', writable: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server', message: String(e && e.message || e) });
  }
};
