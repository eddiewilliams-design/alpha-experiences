// ============================================================
// ALPHA EXPERIENCES — VFT ATTENDANCE TRACKER
// GET /api/vft-track-join?trip=<trip_id>&session=<session_id>&dest=<encoded_url>
//
// Student-facing redirect endpoint. When a student clicks their Zoom
// or Nearpod link from /trips/<trip-id>, the link is actually wrapped
// through this endpoint. The handler:
//   1. Resolves the student from the signed-in session cookie.
//   2. Finds their FT_Purchases row matching email + trip + session.
//   3. Stamps col H (Attended) = "YES" if not already.
//   4. Redirects (302) to the dest URL.
//
// First click stamps; subsequent clicks no-op (col H stays YES).
// Admin can still override manually via the cycle Pending → Yes → No
// on /admin/registrations.
//
// Logging failure NEVER blocks the redirect — students always reach
// their session even if the sheet write hiccups.
// ============================================================

const https  = require('https');
const crypto = require('crypto');
const { getSession } = require('./_lib/session.js');

const SHEET_ID = '1aQYysCOOR-mYG8Myrl1BSU2PF8wMl-si8pgNG89sRto';

// ── Google Sheets access ────────────────────────────────────
function b64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function makeJWT(sa) {
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const pay = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  }));
  const data = hdr + '.' + pay;
  const sig = crypto.createSign('RSA-SHA256').update(data).sign(sa.private_key, 'base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return data + '.' + sig;
}
function post(url, body) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body);
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': buf.length }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(buf); req.end();
  });
}
function getSheet(url, accessToken) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: 'Bearer ' + accessToken } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
function putSheet(url, body, accessToken) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(body));
    const req = https.request(url, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        'Content-Length': buf.length
      }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({}); } });
    });
    req.on('error', reject); req.write(buf); req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const trip    = (req.query.trip    || '').toString().trim();
  const session = (req.query.session || '').toString().trim();
  const dest    = (req.query.dest    || '').toString().trim();

  // Always need a destination — if missing, bounce to portal home.
  const redirectTo = dest ? decodeURIComponent(dest) : 'https://alpha-experiences.vercel.app/trips';

  // If anything required is missing, just redirect — don't block the student.
  if (!trip || !session || !dest) {
    return res.redirect(302, redirectTo);
  }

  // Identify the student via session cookie. If not signed in, redirect
  // anyway — Zoom/Nearpod will challenge them if they're not logged in
  // to those services either.
  const sess = getSession(req);
  if (!sess || !sess.email) {
    return res.redirect(302, redirectTo);
  }
  const studentEmail = sess.email.toLowerCase().trim();

  // Best-effort attendance stamp. Wrapped in try/catch so a sheet
  // failure never delays the student's redirect to Zoom.
  try {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');
    }
    const sa  = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const jwt = makeJWT(sa);
    const tokenRes = await post(
      'https://oauth2.googleapis.com/token',
      'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
    );
    const accessToken = tokenRes.access_token;
    if (!accessToken) throw new Error('no access token');

    // Read FT_Purchases to find the student's row for this trip + session.
    //   Cols: A name, B email, C parent_email, D session_id, E trip_id,
    //         F purchase_date, G status, H attended, I email_sent
    const readUrl =
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/` +
      `${encodeURIComponent('FT_Purchases!A:I')}`;
    const data = await getSheet(readUrl, accessToken);
    const rows = (data && data.values) || [];

    let rowNum = -1;
    let alreadyAttended = false;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const email = (r[1] || '').toString().toLowerCase().trim();
      const sid   = (r[3] || '').toString().trim();
      const tid   = (r[4] || '').toString().trim();
      const stat  = (r[6] || '').toString().toLowerCase().trim();
      // Only stamp on active rows. Cancelled rows are ignored so a
      // late click on a cancelled registration doesn't revive it.
      if (email === studentEmail && sid === session && tid === trip &&
          (!stat || stat === 'active')) {
        rowNum = i + 1;
        const att = (r[7] || '').toString().toUpperCase().trim();
        if (att === 'YES') alreadyAttended = true;
        break;
      }
    }

    if (rowNum > 0 && !alreadyAttended) {
      const writeRange = `FT_Purchases!H${rowNum}`;
      const writeUrl   =
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/` +
        `${encodeURIComponent(writeRange)}?valueInputOption=USER_ENTERED`;
      await putSheet(writeUrl, {
        range: writeRange,
        majorDimension: 'ROWS',
        values: [['YES']]
      }, accessToken);
    }
  } catch (err) {
    // Log + redirect anyway. Never block the student.
    console.error('vft-track-join attendance stamp failed:', err.message);
  }

  return res.redirect(302, redirectTo);
};
