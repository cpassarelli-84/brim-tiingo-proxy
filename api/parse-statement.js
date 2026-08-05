/* ==========================================================================
   BRIM — STATEMENT PARSER PROXY
   Deploy to Vercel as  /api/parse-statement  beside the existing Tiingo proxy.

   WHY THIS EXISTS AT ALL: the API key cannot live in the browser. Anyone can
   read a key out of a page in about four seconds. The Cloudflare Worker that
   serves the proposal is a STATIC-ASSETS worker — POST / returns 405 and every
   other path 404 — so there is nowhere on it to put server code. Vercel already
   runs the Tiingo proxy for exactly this reason and already has the CORS
   allowlist, so this sits next to it.

   ENV VAR REQUIRED:  ANTHROPIC_API_KEY

   WHAT IT SENDS: extracted TEXT only, never the file. Faster, cheaper, and one
   less copy of a client's statement in transit. Statements must be digital
   PDFs, CSV or text — a scan has no text layer and there is nothing to send.
   ========================================================================== */

const ALLOWED = [
  'https://bullrunim.com',
  'https://www.bullrunim.com',
  'https://brim-proposal.cpassarelli.workers.dev'
];

const MODEL = 'claude-sonnet-4-6';

const SYSTEM = `You read brokerage and retirement account statements and return structured holdings.

Return ONLY a JSON object, no prose, no markdown fences:
{
  "accounts": [
    {
      "registration": "brokerage" | "trad" | "roth" | "k401",
      "title": "<account title as printed, or null>",
      "accountNumberLast4": "<last 4 digits only, or null>",
      "statedTotal": <number or null>,
      "positions": [
        { "ticker": "<symbol>", "name": "<security name>", "value": <market value as a number> }
      ]
    }
  ],
  "confidence": "high" | "medium" | "low",
  "notes": "<one short sentence if anything was ambiguous, else null>"
}

RULES, all of which matter more than being helpful:
- Report ONLY what the statement says. Never estimate, never fill a gap, never infer a value that is not printed.
- If a market value is unreadable, omit that position rather than guessing it.
- registration: map Roth IRA to "roth"; Traditional, Rollover, SEP, SIMPLE and Inherited IRA to "trad"; 401(k), Roth 401(k), 403(b), 457 and TSP to "k401"; individual, joint, trust and taxable to "brokerage". If the statement does not say, use null and lower the confidence.
- One statement may contain several accounts. Return each separately.
- NEVER include an account number beyond the last four digits.
- Cash and money-market balances are positions; use the ticker if printed, otherwise "CASH".
- If you cannot read the document at all, return {"accounts": [], "confidence": "low", "notes": "<why>"}.`;

function cors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return ALLOWED.includes(origin);
}

/* Validate before anything reaches a dollar figure in a client document. A
   hallucinated ticker in a proposal is a different class of problem from a
   hallucinated sentence, so nothing is trusted structurally: every field is
   re-typed here and anything that does not survive is dropped. */
function clean(raw) {
  const REG = ['brokerage', 'trad', 'roth', 'k401'];
  const out = { accounts: [], confidence: 'low', notes: null };
  if (!raw || typeof raw !== 'object') return out;

  out.confidence = ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'low';
  out.notes = typeof raw.notes === 'string' ? raw.notes.slice(0, 240) : null;

  (Array.isArray(raw.accounts) ? raw.accounts : []).slice(0, 24).forEach((a) => {
    if (!a || typeof a !== 'object') return;
    const positions = (Array.isArray(a.positions) ? a.positions : []).slice(0, 400).map((p) => {
      if (!p || typeof p !== 'object') return null;
      const value = Number(p.value);
      if (!isFinite(value) || value <= 0) return null;                 // no value, no position
      const ticker = String(p.ticker || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 12);
      if (!ticker) return null;
      return { ticker, name: String(p.name || '').slice(0, 60), value: Math.round(value * 100) / 100 };
    }).filter(Boolean);
    if (!positions.length) return;

    const sum = positions.reduce((s, p) => s + p.value, 0);
    const stated = Number(a.statedTotal);
    out.accounts.push({
      registration: REG.includes(a.registration) ? a.registration : null,
      title: a.title ? String(a.title).slice(0, 60) : null,
      last4: /^\d{4}$/.test(String(a.accountNumberLast4 || '')) ? String(a.accountNumberLast4) : null,
      statedTotal: isFinite(stated) && stated > 0 ? Math.round(stated * 100) / 100 : null,
      positionsTotal: Math.round(sum * 100) / 100,
      positions
    });
  });

  /* A statement that prints its own total is a free check on our own arithmetic.
     Flag a mismatch rather than silently preferring one — the caller shows it. */
  out.accounts.forEach((a) => {
    a.totalsAgree = a.statedTotal == null ? null : Math.abs(a.statedTotal - a.positionsTotal) <= Math.max(1, a.statedTotal * 0.005);
  });
  return out;
}

export default async function handler(req, res) {
  const allowed = cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!allowed) return res.status(403).json({ error: 'origin not allowed' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'parser not configured' });

  let text = '';
  try { text = String((req.body && req.body.text) || ''); } catch (e) { text = ''; }
  text = text.replace(/\r/g, '').trim();

  if (text.length < 40) {
    return res.status(200).json({
      accounts: [], confidence: 'low',
      notes: 'No readable text. Statements must be digital PDFs, CSV or text \u2014 a scan or a photograph has no text to read.'
    });
  }
  /* Hard ceiling. A statement that runs past this is almost always a full
     annual package; the holdings pages are at the front. */
  if (text.length > 180000) text = text.slice(0, 180000);

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        temperature: 0,                 // extraction, not writing
        system: SYSTEM,
        messages: [{ role: 'user', content: 'Statement text follows.\n\n' + text }]
      })
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return res.status(502).json({ error: 'parser upstream error', status: r.status, detail: detail.slice(0, 300) });
    }

    const data = await r.json();
    const body = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const jsonText = body.replace(/```json|```/g, '').trim();

    let parsed = null;
    try { parsed = JSON.parse(jsonText); }
    catch (e) {
      const a = jsonText.indexOf('{'), b = jsonText.lastIndexOf('}');
      if (a >= 0 && b > a) { try { parsed = JSON.parse(jsonText.slice(a, b + 1)); } catch (e2) { parsed = null; } }
    }
    if (!parsed) return res.status(200).json({ accounts: [], confidence: 'low', notes: 'The parser did not return readable structure.' });

    return res.status(200).json(clean(parsed));
  } catch (e) {
    return res.status(502).json({ error: 'parser failed', detail: String(e && e.message).slice(0, 200) });
  }
}
