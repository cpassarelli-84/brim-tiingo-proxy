// api/tiingo.js  —  Vercel serverless function (Node 18+ runtime)
// ---------------------------------------------------------------------------
// Why this exists:
//   Tiingo does NOT send CORS headers, so a browser will block any direct
//   fetch() to api.tiingo.com from bullrunim.com. This proxy calls Tiingo
//   server-side (no CORS in server-to-server land), adds the header the browser
//   needs, and keeps your API token OFF the client (it lives in an env var).
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  // ----- CORS: only let YOUR site read the response -----
  // Add staging origins here if you test on Webflow's *.webflow.io domain.
  const ALLOWED = [
    'https://bullrunim.com',
    'https://www.bullrunim.com',
    'https://brim-proposal.cpassarelli.workers.dev',
  ];
  const origin = req.headers.origin;
  if (ALLOWED.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ detail: 'Method not allowed' }); return; }
  // ----- Validate the symbol so this public endpoint can't be abused -----
  const symbol = String(req.query.symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) {
    res.status(400).json({ detail: 'Invalid symbol' }); return;
  }
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.startDate || '')
    ? req.query.startDate
    : '2008-01-01';
  const token = process.env.TIINGO_TOKEN;
  if (!token) { res.status(500).json({ detail: 'Server not configured: TIINGO_TOKEN missing' }); return; }
  const url = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(symbol)}/prices`
            + `?startDate=${startDate}&format=json&token=${token}`;
  try {
    const upstream = await fetch(url);
    const body = await upstream.text(); // pass Tiingo's JSON straight through
    // EOD prices change once a day — cache at Vercel's edge to slash Tiingo calls.
    if (upstream.ok) {
      res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
    }
    res.status(upstream.status)
       .setHeader('Content-Type', 'application/json')
       .send(body);
  } catch (e) {
    res.status(502).json({ detail: 'Upstream fetch failed' });
  }
}
