// Reads handwritten weapon serial numbers from a photo of an inventory form.
// Auth: ANTHROPIC_API_KEY (direct) if set; otherwise Vercel AI Gateway with AI_GATEWAY_API_KEY or the
// deployment's OIDC token (billed to the Vercel account). Requires the edit PIN.
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');
let getVercelOidcToken = null;
try { getVercelOidcToken = require('@vercel/oidc').getVercelOidcToken; } catch (e) {}

async function oidcToken(req) {
  if (getVercelOidcToken) { try { const t = await getVercelOidcToken(); if (t) return t; } catch (e) {} }
  const h = req && req.headers && req.headers['x-vercel-oidc-token'];
  return h || process.env.VERCEL_OIDC_TOKEN || null;
}

async function client(req) {
  if (process.env.ANTHROPIC_API_KEY) return { c: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }), model: 'claude-opus-5', via: 'anthropic' };
  const key = process.env.AI_GATEWAY_API_KEY || await oidcToken(req);
  if (key) return { c: new Anthropic({ apiKey: key, baseURL: 'https://ai-gateway.vercel.sh' }), model: 'anthropic/claude-opus-5', via: process.env.AI_GATEWAY_API_KEY ? 'gateway-key' : 'gateway-oidc' };
  return null;
}

function pinOk(given) {
  const want = process.env.EDIT_PIN || '';
  if (!want || typeof given !== 'string') return false;
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const PROMPT = [
  'This is a photo of an Israeli military inventory form (טופס לדיווח ארוע מלאי).',
  'The column headed זיהוי פריט (צ\'/מסד/סדרה/ע"מ) holds handwritten weapon serial numbers, one per row, top to bottom, usually 7 digits each.',
  'A page number is usually written in large orange marker near the top of the form.',
  'Handwriting conventions in this hand: the digit 1 is drawn like a tall Greek lambda (Λ) with a short leading upstroke; the digit 4 looks like a Cyrillic ч (open at the top); 7 has a horizontal bar through its stem; 9 may look like g; 5 may look like S.',
  'Skip rows that are crossed out with a line through the whole number. Ignore highlighter marks, dots and check marks beside the numbers.',
  'Transcribe every serial in row order, exactly as written. Do not invent digits.',
  'Reply with only JSON of this shape, no prose: {"page": "<page number written in orange, as a string, or null if not visible>", "serials": [{"s": "<digits>", "sure": true}, {"s": "<digits>", "sure": false}]}',
  'Set "sure": false when any digit is ambiguous (especially 1 vs 4, 0 vs 6, 3 vs 8, 5 vs 6).',
].join('\n');

function extractJson(text) {
  try { return JSON.parse(text); } catch (e) {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch (e) {} }
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (e) {} }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const cfg = await client(req);
  if (req.method === 'GET') {
    return res.status(200).json({ ocr: !!cfg, via: cfg ? cfg.via : null, store: !!process.env.BLOB_READ_WRITE_TOKEN, pin: !!process.env.EDIT_PIN });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!pinOk(body.pin)) return res.status(401).json({ error: 'pin' });
    if (!cfg) return res.status(503).json({ error: 'no_ocr' });
    const mediaType = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(body.mediaType) ? body.mediaType : 'image/jpeg';
    const data = String(body.image || '').replace(/^data:[^,]*,/, '');
    if (!data || data.length > 6_000_000) return res.status(400).json({ error: 'image' });

    const response = await cfg.c.messages.create({
      model: cfg.model,
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
          { type: 'text', text: PROMPT },
        ],
      }],
    });
    if (response.stop_reason === 'refusal') return res.status(422).json({ error: 'refused' });
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const out = extractJson(text);
    if (!out || !Array.isArray(out.serials)) return res.status(422).json({ error: 'invalid_json', text: text.slice(0, 2000) });
    return res.status(200).json({ page: out.page == null ? null : String(out.page), serials: out.serials, via: cfg.via, usage: response.usage });
  } catch (e) {
    const status = e && e.status;
    console.error('ocr error', status, e && e.message);
    if (status === 401 || status === 403) return res.status(502).json({ error: 'auth', message: e.message });
    if (status === 429) return res.status(429).json({ error: 'rate_limited' });
    if (status === 402) return res.status(502).json({ error: 'credits', message: e.message });
    return res.status(502).json({ error: 'upstream', message: String(e && e.message || e).slice(0, 300) });
  }
};
