// ============================================================
// ALPHA EXPERIENCES — TRACK JOIN API
// Vercel Serverless Function — Service Account Auth
// GET /api/track-join?token=XXXXXXXX&dest=ENCODED_ZOOM_URL
// Writes "Date First Clicked" to col M in Sheet1 (once only),
// then redirects the student to the Zoom link.
// Always redirects — a write failure never blocks the student.
// ============================================================
const https = require('https');
const crypto = require('crypto');

const SHEET_ID = '1aQYysCOOR-mYG8Myrl1BSU2PF8wMl-si8pgNG89sRto';
const READ_RANGE = 'Sheet1!A:M';

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

    // Fetch the sheet to find the token row
    const sheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(READ_RANGE)}`;
    const data = await getSheet(sheetUrl, accessToken);
    const rows = data.values || [];

    for (let i = 1; i < rows.length; i++) {
      const rowToken = (rows[i][6] || '').trim(); // col G = Token
      if (rowToken === token) {
        const rowIndex   = i + 1; // 1-indexed for Sheets API
        const alreadySet = (rows[i][12] || '').trim(); // col M = Date First Clicked

        // Only write on the very first click
        if (!alreadySet) {
          const clickedAt  = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
          const writeRange = `Sheet1!M${rowIndex}`;
          const writeUrl   = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(writeRange)}?valueInputOption=RAW`;

          await putSheet(writeUrl, {
            range: writeRange,
            majorDimension: 'ROWS',
            values: [[clickedAt]]
          }, accessToken);
        }
        break;
      }
    }
  } catch(err) {
    // Log but never block the redirect
    console.error('track-join error:', err.message);
  }

  return res.redirect(302, redirectTo);
};
