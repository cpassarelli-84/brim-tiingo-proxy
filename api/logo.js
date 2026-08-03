// api/logo.js  —  Vercel serverless function (Node 18+ runtime)
// ---------------------------------------------------------------------------
// Why this exists:
//   To place an image in a generated PDF the browser has to READ the file, and
//   that needs a CORS header from wherever the logo is hosted. Most advisor
//   sites do not send one — Schwab and Squarespace do not, Wix does — so
//   "paste your logo URL" would fail for most firms, at the moment they hit
//   Generate in front of a client.
//
//   Fetching it here sidesteps that entirely: server-to-server has no CORS.
//   Returns a data URI the PDF engine can embed directly.
//
// GUARDS: http(s) only, image content types only, 3 MB cap, and no redirects
// to private address space — this is a public endpoint and must not become a
// general-purpose fetch relay or an SSRF probe.
//
// ADD AS api/logo.js IN github.com/cpassarelli-84/brim-tiingo-proxy
// ---------------------------------------------------------------------------

const ALLOWED = [
  'https://bullrunim.com',
  'https://www.bullrunim.com',
  'https://brim-proposal.cpassarelli.workers.dev',
];

const OK_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
const MAX_BYTES = 3 * 1024 * 1024;

/* Block anything pointing at private or loopback space. A logo lives on the
   public internet; a URL resolving inside a network is either a mistake or an
   attempt to make this function probe somewhere it should not. */
function looksInternal(host) {
  const h = String(host || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const p = h.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true;   // cloud metadata
  }
  if (h === '::1' || h.startsWith('fd') || h.startsWith('fe80')) return true;
  return false;
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ detail: 'Method not allowed' }); return; }

  const raw = String(req.query.url || '').trim();
  if (!raw) { res.status(400).json({ detail: 'No url' }); return; }

  let u;
  try { u = new URL(raw); } catch (e) { res.status(400).json({ detail: 'Not a valid URL' }); return; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') { res.status(400).json({ detail: 'Only http and https' }); return; }
  if (looksInternal(u.hostname)) { res.status(400).json({ detail: 'Host not allowed' }); return; }

  try {
    const r = await fetch(u.toString(), {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BRIM proposal generator)' }
    });
    if (!r.ok) { res.status(502).json({ detail: 'Could not fetch that image (HTTP ' + r.status + ')' }); return; }

    const type = String(r.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (OK_TYPES.indexOf(type) < 0) {
      res.status(415).json({ detail: 'That URL is not an image' + (type ? ' (' + type + ')' : '') +
        '. Right-click the logo on your site and choose Copy image address.' });
      return;
    }

    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) { res.status(502).json({ detail: 'Empty file' }); return; }
    if (buf.length > MAX_BYTES) { res.status(413).json({ detail: 'Image is larger than 3 MB' }); return; }

    // Logos change about never. Cache hard at the edge.
    res.setHeader('Cache-Control', 's-maxage=604800, stale-while-revalidate=2592000');
    res.status(200).json({
      ok: true,
      type: type === 'image/jpg' ? 'image/jpeg' : type,
      bytes: buf.length,
      dataUri: 'data:' + type + ';base64,' + buf.toString('base64')
    });
  } catch (e) {
    res.status(502).json({ detail: 'Could not reach that URL' });
  }
}
