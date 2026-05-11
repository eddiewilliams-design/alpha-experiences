// ============================================================
// ALPHA EXPERIENCES — LUL EXPIRY REMINDER CRON
//
// Runs daily (Vercel cron — see vercel.json `crons`). Scans
// Sheet1 for active passes nearing expiry and emails students
// (and parents on file) a "your pass expires in N days" nudge.
//
// Eligibility per row:
//   • Active = YES (col H)
//   • Fulfilled ≠ 'Yes' (don't pester someone who already used it)
//   • Date Sent (col I) is between 23 and 30 days ago
//     (7 or fewer days left under the 30-day expiry rule)
//   • Reminder Sent (col O) is blank — admin creates this column
//   • Token (col G) and Email (col C) are populated
//
// Sends via Intercom (sendExpiryReminderEmail) and stamps col O
// with today's ISO date so the same pass is never reminded twice.
//
// Auth: if CRON_SECRET env var is set, the endpoint accepts EITHER
// (a) Authorization: Bearer <CRON_SECRET> — used by Vercel cron, OR
// (b) a signed-in admin session — used for manual on-demand runs.
// Admins can therefore visit the URL in a browser while signed in
// and trigger reminders any time (useful for testing or send-now).
// If CRON_SECRET is not set, the endpoint is open (dev mode).
// ============================================================

const https = require('https');
const crypto = require('crypto');
const { getSession } = require('../_lib/session.js');

const SHEET_ID = '1aQYysCOOR-mYG8Myrl1BSU2PF8wMl-si8pgNG89sRto';
const SHEET1_RANGE = 'Sheet1!A:O';

// ── Sheets access (read + write, same JWT pattern used elsewhere) ──
function b64url(str) {
  return Buffer.from(str).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function makeJWT(sa, scope) {
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const pay = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  }));
  const data = hdr + '.' + pay;
  const sig  = crypto.createSign('RSA-SHA256').update(data).sign(sa.private_key, 'base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return data + '.' + sig;
}
function postForm(url, body) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body);
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': buf.length }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end',  () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(buf); req.end();
  });
}
async function getAccessToken(scope) {
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');
  const sa  = JSON.parse(saJson);
  const jwt = makeJWT(sa, scope || 'https://www.googleapis.com/auth/spreadsheets');
  const r = await postForm(
    'https://oauth2.googleapis.com/token',
    'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
  );
  if (!r.access_token) throw new Error('no access token');
  return r.access_token;
}
function getSheet(url, token) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: 'Bearer ' + token } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end',  () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
function putSheet(url, body, token) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(body));
    const req = https.request(url, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': buf.length }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end',  () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('PUT ' + res.statusCode + ': ' + d));
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject); req.write(buf); req.end();
  });
}

// ── Date helpers (same parsing used elsewhere) ──
function parseSheetDateMs(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  }
  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = parseFloat(s);
    return Date.UTC(1899, 11, 30) + serial * 86400000;
  }
  const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m1) return Date.UTC(+m1[3], +m1[1] - 1, +m1[2]);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.getTime();
}

function isYesish(v) {
  if (v === true)  return true;
  if (v === false) return false;
  const s = String(v == null ? '' : v).trim().toUpperCase();
  return s === 'YES' || s === 'TRUE';
}

// ── Handler ──
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  // Auth — accept either the cron secret OR an admin session
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    const fromCron = (auth === `Bearer ${secret}`);
    let fromAdmin = false;
    try {
      const session = getSession(req);
      fromAdmin = !!(session && session.isAdmin);
    } catch (_) { /* no session = not admin */ }
    if (!fromCron && !fromAdmin) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  let token, rows;
  try {
    token = await getAccessToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(SHEET1_RANGE)}`;
    const data = await getSheet(url, token);
    rows = (data && data.values) || [];
  } catch (err) {
    console.error('lul-expiry-reminders: read failed:', err.message);
    return res.status(500).json({ error: 'server_error', detail: err.message });
  }

  const nowMs = Date.now();
  const LIFESPAN_DAYS = 30;
  const REMIND_WITHIN_DAYS = 7;

  const sent = [];
  const skipped = { not_active: 0, already_fulfilled: 0, no_email: 0, no_token: 0, no_date: 0, not_in_window: 0, already_reminded: 0 };

  // Walk every pass row. We need to call sendExpiryReminderEmail
  // (which dynamic-imports lul-email.js below), so loop async.
  let lulEmail;
  try { lulEmail = require('../_lib/lul-email.js'); }
  catch (err) { return res.status(500).json({ error: 'email_module_load_failed', detail: err.message }); }

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const name        = (r[1] || '').toString().trim();
    const email       = (r[2] || '').toString().trim();
    const parentEmail = (r[3] || '').toString().trim();
    const fulfilled   = (r[5] || '').toString().trim();
    const passToken   = (r[6] || '').toString().trim();
    const active      = isYesish(r[7]);
    const dateSent    = (r[8] || '').toString();
    const remindedAt  = (r[14] || '').toString().trim(); // col O

    if (!active)                        { skipped.not_active++;        continue; }
    if (fulfilled.toLowerCase() === 'yes') { skipped.already_fulfilled++; continue; }
    if (!email)                         { skipped.no_email++;          continue; }
    if (!passToken)                     { skipped.no_token++;          continue; }
    if (remindedAt)                     { skipped.already_reminded++;  continue; }

    const sentMs = parseSheetDateMs(dateSent);
    if (sentMs == null)                 { skipped.no_date++;           continue; }

    const ageMs = nowMs - sentMs;
    const ageDays = ageMs / 86400000;
    const daysLeft = Math.ceil(LIFESPAN_DAYS - ageDays);
    if (daysLeft < 0 || daysLeft > REMIND_WITHIN_DAYS) {
      skipped.not_in_window++;
      continue;
    }

    try {
      await lulEmail.sendExpiryReminderEmail({
        name, email, parentEmail, token: passToken, daysLeft
      });
      // Stamp col O with ISO date so we never resend
      const rowNum = i + 1;
      const writeRange = `Sheet1!O${rowNum}`;
      const writeUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(writeRange)}?valueInputOption=USER_ENTERED`;
      await putSheet(writeUrl, {
        range: writeRange, majorDimension: 'ROWS',
        values: [[new Date().toISOString().slice(0, 10)]]
      }, token);
      sent.push({ name, email, daysLeft });
    } catch (err) {
      console.error('lul-expiry-reminders: send failed for', email, err.message);
      // Don't stamp on failure — let next run retry
    }
  }

  return res.status(200).json({
    ok: true,
    sent_count: sent.length,
    sent: sent,
    skipped: skipped
  });
};
