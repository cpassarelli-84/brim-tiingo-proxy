// api/sendproposal.js  —  Vercel serverless function (Node 18+ runtime)
// ---------------------------------------------------------------------------
// Why this exists:
//   Formspree stores uploaded files on its dashboard and puts a LINK in the
//   notification email — it does not attach them. That is true even on paid
//   plans. If you want the actual PDF in your inbox, something has to send it,
//   so this does: it takes the generated proposal and emails it as a real
//   attachment via Resend.
//
//   Formspree is left in place and still receives every submission. This runs
//   alongside it, so the record-keeping and the attachment are independent —
//   if one fails the other is unaffected.
//
// SETUP (one time):
//   1. resend.com → create an account → API Keys → create one
//   2. Vercel → brim-tiingo-proxy-1 → Settings → Environment Variables:
//        RESEND_API_KEY   = re_xxxxxxxx
//        PROPOSAL_TO      = cpassarelli@bullrunim.com
//        PROPOSAL_FROM    = onboarding@resend.dev      (see note below)
//   3. Redeploy
//
//   PROPOSAL_FROM: Resend's onboarding@resend.dev works with no domain setup,
//   but will ONLY deliver to the email address on the Resend account. That is
//   fine here, since the only recipient is Chris. To send from
//   proposals@bullrunim.com instead, verify the domain in Resend first — which
//   also keeps these out of spam, since they would then be SPF/DKIM signed.
//
// ADD AS api/sendproposal.js IN github.com/cpassarelli-84/brim-tiingo-proxy
// ---------------------------------------------------------------------------

export const config = { api: { bodyParser: false } };   // we read the raw multipart ourselves

const ALLOWED = [
  'https://bullrunim.com',
  'https://www.bullrunim.com',
  'https://brim-proposal.cpassarelli.workers.dev',
];

/* Minimal multipart reader. No dependency: Vercel functions have no node_modules
   beyond what is committed, and pulling in a parser for one endpoint is not
   worth it. Handles exactly what the app sends — text fields plus one file. */
function parseMultipart(buf, boundary) {
  const out = { fields: {}, file: null };
  const sep = Buffer.from('--' + boundary);
  let pos = 0;
  while (pos < buf.length) {
    const start = buf.indexOf(sep, pos);
    if (start < 0) break;
    const headEnd = buf.indexOf('\r\n\r\n', start);
    if (headEnd < 0) break;
    const head = buf.slice(start, headEnd).toString('utf8');
    const next = buf.indexOf(sep, headEnd);
    if (next < 0) break;
    const body = buf.slice(headEnd + 4, next - 2);           // trim the trailing CRLF
    const nameM = /name="([^"]+)"/.exec(head);
    const fileM = /filename="([^"]*)"/.exec(head);
    if (nameM) {
      if (fileM && fileM[1]) out.file = { field: nameM[1], filename: fileM[1], data: body };
      else out.fields[nameM[1]] = body.toString('utf8');
    }
    pos = next;
  }
  return out;
}

function readRaw(req) {
  return new Promise((res, rej) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => res(Buffer.concat(chunks)));
    req.on('error', rej);
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ detail: 'Method not allowed' }); return; }
  if (!ALLOWED.includes(origin)) { res.status(403).json({ detail: 'Origin not allowed' }); return; }

  const key = process.env.RESEND_API_KEY;
  const to = process.env.PROPOSAL_TO;
  const from = process.env.PROPOSAL_FROM || 'onboarding@resend.dev';
  if (!key || !to) { res.status(500).json({ detail: 'Mailer not configured: RESEND_API_KEY or PROPOSAL_TO missing' }); return; }

  try {
    const ct = req.headers['content-type'] || '';
    const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
    if (!bm) { res.status(400).json({ detail: 'Expected multipart/form-data' }); return; }
    const raw = await readRaw(req);
    if (raw.length > 9 * 1024 * 1024) { res.status(413).json({ detail: 'Too large' }); return; }
    const { fields, file } = parseMultipart(raw, bm[1] || bm[2]);

    const rows = Object.keys(fields)
      .filter(k => k[0] !== '_')
      .map(k => `<tr><td style="padding:4px 14px 4px 0;color:#5A6871;font-size:13px;white-space:nowrap">${esc(k.replace(/_/g, ' '))}</td>` +
                `<td style="padding:4px 0;color:#02131F;font-size:13px">${esc(fields[k])}</td></tr>`)
      .join('');

    const subject = fields._subject || ('Portfolio proposal — ' + (fields.client_name || 'Client'));
    const body = {
      from, to: [to], subject,
      html: `<div style="font-family:system-ui,-apple-system,sans-serif">
        <p style="font-size:14px;color:#02131F">${file ? 'Proposal attached.' : '<b>No PDF was attached to this submission.</b>'}</p>
        <table style="border-collapse:collapse">${rows}</table>
        <p style="font-size:11px;color:#8A93A0;margin-top:18px">Sent by the Bull Run portfolio proposal generator.</p>
      </div>`
    };
    if (fields.client_email) body.reply_to = fields.client_email;
    if (file) {
      body.attachments = [{
        filename: file.filename || 'Bull Run Portfolio Proposal.pdf',
        content: file.data.toString('base64')
      }];
    }

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const txt = await r.text();
    if (!r.ok) { res.status(502).json({ detail: 'Mail provider rejected it', upstream: txt.slice(0, 300) }); return; }
    res.status(200).json({ ok: true, attached: !!file, bytes: file ? file.data.length : 0 });
  } catch (e) {
    res.status(500).json({ detail: 'Send failed', error: String(e && e.message).slice(0, 200) });
  }
}
