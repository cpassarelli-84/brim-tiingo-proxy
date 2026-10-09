// api/search.js  —  Vercel serverless function (Node 18+ runtime)
// ---------------------------------------------------------------------------
// Symbol search for the site's ticker pickers (the portfolio proposal's fund
// editor and the Portfolio Simulator's compare box).
//
// Why this exists (Oct 9 2026):
//   The pickers called api.stockanalysis.com straight from the browser. That
//   site now answers 403, with no CORS header, to any page that is not its
//   own, so the dropdowns stopped showing anything. The search runs here
//   instead, server-side, on Yahoo Finance's public search, which also labels
//   mutual funds and money market funds.
//
// GET /api/search?q=growth%20fund%20of%20america
//   -> { source: 'Yahoo Finance', data: [{ symbol, name, kind }] }
//      kind: 'Stock' | 'ETF' | 'Mutual fund' | 'Money market'
//   US listings only: anything with a dot (foreign listing), = (future) or ^
//   (index) is left out, because the price proxy cannot price it.
// ---------------------------------------------------------------------------

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const KINDS = {
  EQUITY: 'Stock',
  ETF: 'ETF',
  MUTUALFUND: 'Mutual fund',
  MONEY_MARKET: 'Money market',
  MONEYMARKET: 'Money market'
};

async function fetchWithTimeout(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, Object.assign({}, opts, { signal: ac.signal })); }
  finally { clearTimeout(t); }
}

export default async function handler(req, res) {
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

  const q = String(req.query.q || '').trim();
  if (!q || q.length > 60 || !/^[A-Za-z0-9 .,&'\-]+$/.test(q)) {
    res.status(400).json({ detail: 'Invalid query', data: [] }); return;
  }

  const path = '/v1/finance/search?q=' + encodeURIComponent(q) +
               '&quotesCount=12&newsCount=0&listsCount=0';
  let quotes = null;
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetchWithTimeout(`https://${host}.finance.yahoo.com${path}`,
        { headers: { 'User-Agent': UA, Accept: 'application/json' } }, 6000);
      if (!r.ok) continue;
      const d = await r.json();
      if (d && Array.isArray(d.quotes)) { quotes = d.quotes; break; }
    } catch (e) { /* try the other host */ }
  }
  if (!quotes) { res.status(502).json({ detail: 'Search unavailable', data: [] }); return; }

  const seen = {};
  const data = [];
  for (const x of quotes) {
    const symbol = String((x && x.symbol) || '').toUpperCase();
    const kind = KINDS[x && x.quoteType];
    if (!kind || !/^[A-Z0-9\-]{1,10}$/.test(symbol) || seen[symbol]) continue;
    seen[symbol] = 1;
    data.push({ symbol, name: String(x.longname || x.shortname || ''), kind });
    if (data.length >= 8) break;
  }
  // Names and symbols change rarely: a day at the edge, a week stale.
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
  res.status(200).json({ source: 'Yahoo Finance', data });
}
