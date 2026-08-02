// api/fundmeta.js  —  Vercel serverless function (Node 18+ runtime)
// ---------------------------------------------------------------------------
// Why this exists:
//   Expense ratios are NOT on brokerage statements — they are deducted inside
//   fund NAV before the price a client sees, so there is nothing to parse. But
//   they ARE public per ticker. This looks them up so nobody has to type a
//   number they do not know.
//
//   Yahoo will not answer a browser: no CORS header, and it rate-limits. So the
//   call happens here, server-side, exactly like the Tiingo proxy next door.
//
//   Yahoo now requires a cookie + "crumb" handshake before quoteSummary will
//   answer. Both are cached in module scope for the life of the warm instance.
//
// ADD THIS FILE AS api/fundmeta.js IN github.com/cpassarelli-84/brim-tiingo-proxy
// ---------------------------------------------------------------------------

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let CRUMB = null, COOKIE = null, CRUMB_AT = 0;

async function getCrumb() {
  // Re-handshake every 30 min; Yahoo rotates these.
  if (CRUMB && COOKIE && Date.now() - CRUMB_AT < 30 * 60 * 1000) return;
  const seed = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA } });
  const setCookie = seed.headers.get('set-cookie') || '';
  COOKIE = setCookie.split(';')[0] || '';
  const r = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, Cookie: COOKIE }
  });
  CRUMB = (await r.text()).trim();
  CRUMB_AT = Date.now();
}

async function lookupOne(symbol) {
  const url = 'https://query2.finance.yahoo.com/v10/finance/quoteSummary/' +
    encodeURIComponent(symbol) + '?modules=fundProfile,quoteType&crumb=' + encodeURIComponent(CRUMB);
  const r = await fetch(url, { headers: { 'User-Agent': UA, Cookie: COOKIE } });
  if (!r.ok) return { symbol, status: 'lookup_failed' };
  const d = await r.json();
  const res = d && d.quoteSummary && d.quoteSummary.result;
  if (!res || !res.length) {
    // Yahoo says "no fundamentals data" for ETNs and for anything it does not
    // treat as a fund. That is NOT the same as a 0% expense ratio, and must
    // never be reported as one.
    return { symbol, status: 'not_found' };
  }
  const qt = res[0].quoteType || {};
  const fp = res[0].fundProfile || {};
  const fees = fp.feesExpensesInvestment || {};
  const raw = (fees.netExpRatio && fees.netExpRatio.raw) != null
    ? fees.netExpRatio.raw
    : (fees.annualReportExpenseRatio && fees.annualReportExpenseRatio.raw);

  // A directly-held stock genuinely has no expense ratio. Say so explicitly
  // rather than returning nothing — the caller needs to tell "0 because it is
  // a share of Apple" apart from "unknown because the lookup failed".
  if (qt.quoteType === 'EQUITY') return { symbol, status: 'equity', er: 0, name: qt.longName || qt.shortName || '' };
  if (raw == null) return { symbol, status: 'no_ratio_published', kind: qt.quoteType || null, name: qt.longName || qt.shortName || '' };

  return {
    symbol, status: 'ok',
    er: Math.round(raw * 10000) / 100,      // 0.0049 -> 0.49 (percent)
    kind: qt.quoteType || null,
    family: fp.family || null,
    name: qt.longName || qt.shortName || ''
  };
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

  const raw = String(req.query.symbols || '').trim().toUpperCase();
  if (!raw) { res.status(400).json({ detail: 'No symbols' }); return; }

  // Validate and cap. This endpoint is public, so it should not become a
  // general-purpose Yahoo relay.
  const symbols = raw.split(',')
    .map(s => s.trim())
    .filter(s => /^[A-Z0-9.\-]{1,12}$/.test(s))
    .slice(0, 40);
  if (!symbols.length) { res.status(400).json({ detail: 'No valid symbols' }); return; }

  try {
    await getCrumb();
    const out = {};
    // Sequential on purpose — Yahoo rate-limits parallel bursts, and 40 lookups
    // still return well inside the function timeout.
    for (const s of symbols) {
      try { out[s] = await lookupOne(s); }
      catch (e) { out[s] = { symbol: s, status: 'lookup_failed' }; }
    }
    // Expense ratios change at most once a year. Cache hard at the edge.
    res.setHeader('Cache-Control', 's-maxage=604800, stale-while-revalidate=2592000');
    res.status(200).setHeader('Content-Type', 'application/json').json({ source: 'Yahoo Finance', data: out });
  } catch (e) {
    res.status(502).json({ detail: 'Upstream lookup failed' });
  }
}
