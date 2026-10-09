// api/tiingo.js  —  Vercel serverless function (Node 18+ runtime)
// ---------------------------------------------------------------------------
// Why this exists:
//   Tiingo does NOT send CORS headers, so a browser will block any direct
//   fetch() to api.tiingo.com from bullrunim.com. This proxy calls Tiingo
//   server-side (no CORS in server-to-server land), adds the header the browser
//   needs, and keeps your API token OFF the client (it lives in an env var).
//
// MUTUAL FUNDS (Oct 9 2026):
//   Tiingo's adjusted prices are right for stocks and ETFs (checked against
//   Yahoo on 13 ETFs, 2009-2025: every year within 0.61 points, most within
//   0.05). They are NOT right for mutual funds. Tiingo's distribution records
//   miss some payments, double count others and put some on the wrong day, so
//   its adjClose is off by whole points in some years:
//     T. Rowe Blue Chip Growth (TRBCX) 2024: Tiingo 46.54%, the fund's SEC
//       filing 35.63% (a $16.91 capital gain recorded as $33.82)
//     MFS Growth (MFEGX) 2024: Tiingo 46.87%, published 31.33%
//     Fidelity Growth Company (FDGRX) 2024: Tiingo 26.38%, published 37.20%
//   So for a mutual fund this rebuilds the total return from the fund's daily
//   NAV and its distributions (income and capital gains), reinvested at the
//   ex-date NAV, the way a fund reports its own total return:
//       r(t) = (NAV(t) + distribution(t)) / NAV(t-1) - 1
//   NAV and distributions come from Yahoo Finance. Rebuilt this way TRBCX
//   matches its SEC-filed returns for 2021-2024 to the hundredth
//   (17.70 / -38.60 / 49.36 / 35.63), and MFEGX, FDGRX and VTSAX match their
//   published years.
//
//   The response keeps Tiingo's exact shape ([{date, close, adjClose, divCash,
//   ...}]), so every consumer on the site (proposal engine, the canonical
//   chart, the Innovation page compare, the Portfolio Simulator) gets the fix
//   with no code change. A header says which method produced the series:
//       X-BRIM-Price-Source: nav-plus-distributions | tiingo | money-market
//
//   Money market funds cannot be rebuilt this way: Yahoo carries no
//   distributions for them (SWVXX shows none), and Tiingo's history starts in
//   May 2021 and misses most dividends before 2025 (VMFXX 2023: Tiingo 0.43%,
//   the fund paid about 5%). They still return Tiingo's series, but the header
//   says 'money-market' so a consumer can model them on Treasury bills
//   instead. Stocks and ETFs stay on Tiingo, unchanged. If Yahoo fails, is
//   sparse, or returns anything implausible, a fund falls back to Tiingo,
//   exactly as before.
// ---------------------------------------------------------------------------

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// US mutual fund symbols are five letters ending in X (the NASDAQ fund
// suffix). Only these are considered for the rebuild, and Yahoo's own
// instrumentType must then say MUTUALFUND before anything changes.
const MUTUAL_FUND = /^[A-Z]{4}X$/;

const NY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
});
const nyDate = (sec) => NY.format(new Date(sec * 1000));   // 'YYYY-MM-DD'
const dayOf = (bar) => String(bar.date).slice(0, 10);

async function fetchWithTimeout(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, Object.assign({}, opts, { signal: ac.signal })); }
  finally { clearTimeout(t); }
}

async function yahooChart(symbol, startDate) {
  const p1 = Math.floor(Date.parse(startDate + 'T00:00:00Z') / 1000);
  const p2 = Math.floor(Date.now() / 1000) + 86400;
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}` +
               `&interval=1d&events=div%2Csplits%2CcapitalGains&includeAdjustedClose=true`;
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetchWithTimeout(`https://${host}.finance.yahoo.com${path}`,
        { headers: { 'User-Agent': UA, Accept: 'application/json' } }, 7000);
      if (!r.ok) continue;
      const d = await r.json();
      const res = d && d.chart && d.chart.result && d.chart.result[0];
      if (res && res.timestamp && res.timestamp.length) return res;
    } catch (e) { /* try the other host */ }
  }
  return null;
}

// Rebuild the total-return series from NAV + distributions. Returns bars in
// Tiingo's shape, or null when the Yahoo data is not good enough to trust.
function navTotalReturn(yres, tiingoBars) {
  const meta = yres.meta || {};
  if (meta.instrumentType !== 'MUTUALFUND') return null;

  const q = (yres.indicators && yres.indicators.quote && yres.indicators.quote[0]) || {};
  const closes = q.close || [];
  const ts = yres.timestamp;

  const ev = yres.events || {};
  const divs = {}, gains = {};
  Object.values(ev.dividends || {}).forEach(e => {
    if (e && isFinite(e.amount) && e.amount > 0) { const k = nyDate(e.date); divs[k] = (divs[k] || 0) + e.amount; }
  });
  Object.values(ev.capitalGains || {}).forEach(e => {
    if (e && isFinite(e.amount) && e.amount > 0) { const k = nyDate(e.date); gains[k] = (gains[k] || 0) + e.amount; }
  });

  // One NAV per trading day. A day with no NAV is skipped; a distribution on
  // that day is carried to the next real NAV so it is never lost.
  const rows = [];
  let pending = 0;
  for (let i = 0; i < ts.length; i++) {
    const day = nyDate(ts[i]);
    const dv = divs[day] || 0, cg = gains[day] || 0;
    // Yahoo has so far put capital gains INSIDE its dividend figure
    // (capitalGains came back empty on every fund tested). If it ever reports
    // both on one day, the total the NAV drop supports is used (resolved below).
    const dist = (dv && cg) ? { d: dv, g: cg } : (dv || cg);
    const c = closes[i];
    if (c == null || !isFinite(c) || c <= 0) {
      pending += (typeof dist === 'number') ? dist : dist.d;
      continue;
    }
    if (rows.length && rows[rows.length - 1].day === day) continue;   // duplicate stamp
    rows.push({ day, close: c, dist, carried: pending });
    pending = 0;
  }
  // A short window is fine when Tiingo agrees it is short; with nothing to
  // compare against, ask for a month of NAVs before trusting Yahoo alone.
  if (rows.length < 2 || (!tiingoBars && rows.length < 30)) return null;

  // Coverage gate: Yahoo must carry at least 95% of the trading days Tiingo
  // has over the same span, or gaps would blur the daily returns.
  if (tiingoBars) {
    const first = rows[0].day, last = rows[rows.length - 1].day;
    const tiCount = tiingoBars.filter(b => { const d = dayOf(b); return d >= first && d <= last; }).length;
    if (tiCount && rows.length < 0.95 * tiCount) return null;
  }

  // Total-return index, reinvesting at the ex-date NAV.
  const idx = [1], paid = [0];
  for (let i = 1; i < rows.length; i++) {
    const p = rows[i - 1].close, c = rows[i].close, x = rows[i].dist;
    let d = rows[i].carried;
    if (typeof x === 'number') d += x;
    else {
      const a = (c + x.d) / p - 1, b = (c + x.d + x.g) / p - 1;
      d += Math.abs(b) < Math.abs(a) ? x.d + x.g : x.d;
    }
    const r = (c + d) / p - 1;
    // A mutual fund does not move half its value in a day. If the rebuilt
    // series says it did, something in the Yahoo data is wrong: use Tiingo.
    if (!isFinite(r) || r > 0.5 || r < -0.5) return null;
    idx.push(idx[i - 1] * (1 + r));
    paid.push(d);
  }

  let out = rows.map((row, i) => ({
    date: row.day + 'T00:00:00.000Z',
    close: row.close, high: row.close, low: row.close, open: row.close, volume: 0,
    adjClose: idx[i], adjHigh: idx[i], adjLow: idx[i], adjOpen: idx[i], adjVolume: 0,
    divCash: paid[i], splitFactor: 1
  }));

  if (tiingoBars) {
    // Yahoo can start later than Tiingo, or trail it by a day at the end. Any
    // Tiingo days outside Yahoo's span are joined on Tiingo's own day-to-day
    // change, so the series never covers less than it did before this fix.
    const firstDay = rows[0].day, lastDay = rows[rows.length - 1].day;
    const head = tiingoBars.filter(b => dayOf(b) < firstDay && b.adjClose > 0);
    const joinHead = tiingoBars.find(b => dayOf(b) >= firstDay && b.adjClose > 0);
    if (head.length && joinHead) {
      const k = out[0].adjClose / joinHead.adjClose;
      out = head.map(b => Object.assign({}, b, {
        adjClose: b.adjClose * k, adjHigh: b.adjClose * k, adjLow: b.adjClose * k, adjOpen: b.adjClose * k
      })).concat(out);
    }
    const tail = tiingoBars.filter(b => dayOf(b) > lastDay && b.adjClose > 0);
    const joinTail = tiingoBars.filter(b => dayOf(b) <= lastDay && b.adjClose > 0).pop();
    if (tail.length && joinTail) {
      let prev = joinTail.adjClose, cur = out[out.length - 1].adjClose;
      tail.forEach(b => {
        cur = cur * (b.adjClose / prev); prev = b.adjClose;
        out.push(Object.assign({}, b, { adjClose: cur, adjHigh: cur, adjLow: cur, adjOpen: cur }));
      });
    }
  }

  // Tiingo's convention: the most recent adjClose equals the most recent close.
  const scale = out[out.length - 1].close / out[out.length - 1].adjClose;
  if (!isFinite(scale) || scale <= 0) return null;
  out.forEach(o => { o.adjClose *= scale; o.adjHigh = o.adjLow = o.adjOpen = o.adjClose; });
  return out;
}

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
  res.setHeader('Access-Control-Expose-Headers', 'X-BRIM-Price-Source');
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

  const isFund = MUTUAL_FUND.test(symbol);
  // A mutual fund asks Yahoo at the same time, so the rebuild adds no waiting.
  const [upstream, yres] = await Promise.all([
    fetch(url).catch(() => null),
    isFund ? yahooChart(symbol, startDate).catch(() => null) : Promise.resolve(null)
  ]);
  let body = null;
  if (upstream) { try { body = await upstream.text(); } catch (e) { body = null; } }

  if (isFund && yres) {
    let tiingoBars = null;
    if (upstream && upstream.ok && body) { try { tiingoBars = JSON.parse(body); } catch (e) { tiingoBars = null; } }
    if (!Array.isArray(tiingoBars) || !tiingoBars.length) tiingoBars = null;
    let rebuilt = null;
    try { rebuilt = navTotalReturn(yres, tiingoBars); } catch (e) { rebuilt = null; }
    if (rebuilt && rebuilt.length) {
      res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
      res.setHeader('X-BRIM-Price-Source', 'nav-plus-distributions');
      res.status(200).setHeader('Content-Type', 'application/json').send(JSON.stringify(rebuilt));
      return;
    }
  }

  // Yahoo's own label: a money market fund keeps Tiingo's series but is flagged.
  const isMoneyMarket = !!(yres && yres.meta && yres.meta.instrumentType === 'MONEYMARKET');

  if (!upstream || body == null) { res.status(502).json({ detail: 'Upstream fetch failed' }); return; }
  // EOD prices change once a day — cache at Vercel's edge to slash Tiingo calls.
  if (upstream.ok) {
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
  }
  res.setHeader('X-BRIM-Price-Source', isMoneyMarket ? 'money-market' : 'tiingo');
  res.status(upstream.status)
     .setHeader('Content-Type', 'application/json')
     .send(body); // Tiingo's JSON, passed straight through
}
