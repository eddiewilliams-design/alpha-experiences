// ============================================================
// ALPHA EXPERIENCES — TRACK JOIN API
// Vercel Serverless Function — Service Account Auth
// GET /api/track-join?token=XXXXXXXX&dest=ENCODED_ZOOM_URL
//
// What it does:
//   1. Resolves token → student row in Sheet1.
//   2. Writes "Date First Clicked" to col M (once only — preserved
//      for backward compat with existing reports).
//   3. NEW: Appends a row to LUL_Attendance for EVERY click — so
//      admins can see exactly which sessions each student joined,
//      and how often. Matches the dest URL against the Sessions
//      tab to resolve session_id + session_name when possible.
//   4. Always redirects to the Zoom link — a logging failure never
//      blocks the student.
//
// Required tab: LUL_Attendance with header row in row 1:
//   A: clicked_at | B: student_email | C: student_name
//   D: session_id | E: session_name  | F: zoom_url | G: token
//   H: in_picks   (YES if this session was one the student had
//                  locked in via Sheet1 col K; NO if outside their
//                  picks; blank if they had no saved selections)
// If the tab doesn't exist yet, the append fails silently and is
// logged to Vercel — the student is still redirected normally.
// ============================================================
const https = require('https');
const crypto = require('crypto');

const SHEET_ID = '1aQYysCOOR-mYG8Myrl1BSU2PF8wMl-si8pgNG89sRto';

function b64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

function makeJWT(sa) {
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const pay = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const data = hdr + '.' + pay;
  const sig = crypto.createSign('RSA-SHA256').update(data).sign(sa.private_key, 'base64')
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  return data + '.' + sig;
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body);
    const opts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': buf.length
      }
    };
    const req = https.request(url, opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

function getSheet(url, token) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: 'Bearer ' + token } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function putSheet(url, body, token) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(body));
    const opts = {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Length': buf.length
      }
    };
    const req = https.request(url, opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

function postSheet(url, body, token) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(body));
    const opts = {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Length': buf.length
      }
    };
    const req = https.request(url, opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        // Surface non-2xx so the outer try/catch can log a useful message
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('append HTTP ' + res.statusCode + ': ' + d));
        }
        try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = (req.query.token || '').trim();
  const dest  = (req.query.dest  || '').trim();

  // Always need a destination — if missing, fall back to the app home
  const redirectTo = dest ? decodeURIComponent(dest) : 'https://alpha-experiences.vercel.app';

  // If no token or no service account, just redirect immediately
  if (!token || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return res.redirect(302, redirectTo);
  }

  try {
    const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const jwt = makeJWT(sa);

    const tokenRes = await post(
      'https://oauth2.googleapis.com/token',
      'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
    );
    const accessToken = tokenRes.access_token;
    if (!accessToken) return res.redirect(302, redirectTo);

    // batchGet: pull Sheet1 (token row) AND Sessions (URL → session match)
    // in one round trip.
    const ranges = ['Sheet1!A:M', 'Sessions!A:K'];
    const params = ranges.map(r => 'ranges=' + encodeURIComponent(r)).join('&');
    const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchGet?${params}`;
    const batch = await getSheet(batchUrl, accessToken);
    const valueRanges = (batch && batch.valueRanges) || [];
    const passRows    = (valueRanges[0] && valueRanges[0].values) || [];
    const sessionRows = (valueRanges[1] && valueRanges[1].values) || [];

    // Find the token row in Sheet1
    let matched = null;
    for (let i = 1; i < passRows.length; i++) {
      const rowToken = (passRows[i][6] || '').toString().trim(); // col G
      if (rowToken === token) {
        matched = { row: passRows[i], rowIndex: i + 1 };
        break;
      }
    }

    if (matched) {
      const studentName    = (matched.row[1] || '').toString();   // col B
      const studentEmail   = (matched.row[2] || '').toString();   // col C
      const alreadySet     = (matched.row[12] || '').toString().trim(); // col M
      // col K = comma-separated locked-in session slugs
      const savedSelections = (matched.row[10] || '').toString().trim()
        .split(',').map(s => s.trim()).filter(Boolean);

      // Existing behavior: write Date First Clicked to col M (once only)
      if (!alreadySet) {
        const clickedAt  = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
        const writeRange = `Sheet1!M${matched.rowIndex}`;
        const writeUrl   = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(writeRange)}?valueInputOption=RAW`;
        try {
          await putSheet(writeUrl, {
            range: writeRange,
            majorDimension: 'ROWS',
            values: [[clickedAt]]
          }, accessToken);
        } catch (err) {
          console.error('track-join: col M write failed:', err.message);
        }
      }

      // NEW: append every click to LUL_Attendance
      // Match the dest URL against Sessions col G to resolve session_id + name.
      let sessionId = '';
      let sessionName = '';
      for (let i = 1; i < sessionRows.length; i++) {
        const link = (sessionRows[i][6] || '').toString().trim(); // col G
        if (link && link === redirectTo) {
          sessionName = (sessionRows[i][0] || '').toString(); // col A
          sessionId   = (sessionRows[i][7] || '').toString(); // col H
          break;
        }
      }

      // in_picks: was this clicked session one the student locked in?
      // YES if their saved selections include this session slug.
      // NO if they have selections but this isn't one of them.
      // Blank if they have no saved selections at all (e.g. unconfirmed pass).
      let inPicks = '';
      if (savedSelections.length) {
        inPicks = (sessionId && savedSelections.indexOf(sessionId) !== -1) ? 'YES' : 'NO';
      }

      const clickedAtIso = new Date().toISOString();
      const appendUrl =
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/` +
        `${encodeURIComponent('LUL_Attendance!A:H')}` +
        `:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
      try {
        await postSheet(appendUrl, {
          range: 'LUL_Attendance!A:H',
          majorDimension: 'ROWS',
          values: [[
            clickedAtIso,
            studentEmail,
            studentName,
            sessionId,
            sessionName,
            redirectTo,
            token,
            inPicks
          ]]
        }, accessToken);
      } catch (err) {
        // Most likely cause: the LUL_Attendance tab doesn't exist yet.
        // Don't block the student — just log so admin sees it in Vercel logs.
        console.error('track-join: LUL_Attendance append failed (does the tab exist?):', err.message);
      }
    }
  } catch(err) {
    // Log but never block the redirect
    console.error('track-join error:', err.message);
  }

  return res.redirect(302, redirectTo);
};
