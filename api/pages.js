// Shared page store: GET returns {pages, meta}; POST (with the edit PIN) replaces or deletes one page.
// Storage: Vercel Blob (BLOB_READ_WRITE_TOKEN is injected when a Blob store is connected to the project).
// Until a store is connected, GET serves the list bundled with the deployment and POST reports 503.
const { put, list } = require('@vercel/blob');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BLOB_PATH = 'weapon-pages/pages.json';

function bundled() {
  try {
    const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
    const m = html.match(/<script id="pages-data" type="application\/json">([\s\S]*?)<\/script>/);
    if (m) return JSON.parse(m[1]);
  } catch (e) {}
  return { pages: {}, meta: {} };
}

async function readStore() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return { state: bundled(), source: 'bundled' };
  const { blobs } = await list({ prefix: BLOB_PATH, limit: 1 });
  if (!blobs.length) return { state: bundled(), source: 'bundled' };
  const res = await fetch(blobs[0].url + '?t=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error('blob read failed ' + res.status);
  const state = await res.json();
  return { state: { pages: state.pages || {}, meta: state.meta || {} }, source: 'blob' };
}

async function writeStore(state) {
  await put(BLOB_PATH, JSON.stringify(state), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json', cacheControlMaxAge: 60,
  });
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
      const { state, source } = await readStore();
      return res.status(200).json({ ...state, source, writable: !!(process.env.BLOB_READ_WRITE_TOKEN && process.env.EDIT_PIN) });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!pinOk(body.pin)) return res.status(401).json({ error: 'pin' });
    if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(503).json({ error: 'no_store' });
    const page = norm(body.page);
    if (!page) return res.status(400).json({ error: 'page' });
    const { state } = await readStore();
    if (body.action === 'delete') {
      delete state.pages[page]; delete state.meta[page];
    } else {
      const serials = (Array.isArray(body.serials) ? body.serials : []).map(norm).filter(Boolean);
      if (!serials.length) return res.status(400).json({ error: 'serials' });
      if (serials.length > 500) return res.status(400).json({ error: 'too_many' });
      state.pages[page] = serials;
      state.meta[page] = { added: new Date().toISOString().slice(0, 10), src: body.src === 'photo' ? 'photo' : 'manual' };
    }
    await writeStore(state);
    return res.status(200).json({ ...state, source: 'blob', writable: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server', message: String(e && e.message || e) });
  }
};
