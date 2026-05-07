// ============================================================
// ALPHA EXPERIENCES — EXPERIENCE SUGGESTION INTAKE
// POST /api/experience-suggest
//
// Accepts a student-submitted suggestion for a future experience
// (Virtual Field Trip / Workshop / Talk / Other) and appends a row
// to the Experience_Suggestions tab in the spreadsheet.
//
// Required tab (admin must create once):
//   Experience_Suggestions with header row:
//   A Submitted At | B Student Name | C Student Email
//   D Type         | E Title        | F Description
//   G Status       | H Admin Notes
//
// Status defaults to 'New' on submission. Admin reviews in the sheet.
// ============================================================

const https  = require('https');
const crypto = require('crypto');
const { getSession } = require('./_lib/session.js');

const SHEET_ID = '1aQYysCOOR-mYG8Myrl1BSU2PF8wMl-si8pgNG89sRto';
const VALID_TYPES = ['Virtual Field Trip', 'Workshop', 'Talk', 'Other'];

// ── JWT / token helpers ────────────────────────────────────────
function b64url(str) {
  return Buffer.from(str).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function makeJWT(sa, scope) {
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const pay = b64url(JSON.stringify({
    iss: sa.client_email, scope: scope,
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
async function getAccessToken() {
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');
  const sa  = JSON.parse(saJson);
  const jwt = makeJWT(sa, 'https://www.googleapis.com/auth/spreadsheets');
  const r = await postForm(
    'https://oauth2.googleapis.com/token',
    'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
  );
  if (!r.access_token) throw new Error('no access token from Google');
  return r.access_token;
}

function sheetsAppend(token, range, values) {
  return new Promise((resolve, reject) => {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}` +
                `:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    const buf = Buffer.from(JSON.stringify({ range, majorDimension: 'ROWS', values }));
    const u = new URL(url);
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Length': buf.length
      }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('append HTTP ' + res.statusCode + ': ' + d));
        }
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    if (typeof req.body === 'string') { try { return resolve(JSON.parse(req.body)); } catch (e) {} }
    let d = '';
    req.on('data', c => d += c);
    req.on('end',  () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// ── Handler ────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'not_authenticated' });

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const type        = (body.type        || '').toString().trim();
  const title       = (body.title       || '').toString().trim();
  const description = (body.description || '').toString().trim();

  if (VALID_TYPES.indexOf(type) === -1) {
    return res.status(400).json({ error: 'bad_request', detail: 'type must be one of: ' + VALID_TYPES.join(' / ') });
  }
  if (!title)               return res.status(400).json({ error: 'bad_request', detail: 'title required' });
  if (title.length > 200)   return res.status(400).json({ error: 'bad_request', detail: 'title too long (max 200 chars)' });
  if (description.length > 4000) return res.status(400).json({ error: 'bad_request', detail: 'description too long (max 4000 chars)' });

  const submittedAt  = new Date().toISOString();
  const studentName  = (session.name  || '').toString();
  const studentEmail = (session.email || '').toString();

  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    console.error('experience-suggest token:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  try {
    await sheetsAppend(accessToken, 'Experience_Suggestions!A:H', [[
      submittedAt,
      studentName,
      studentEmail,
      type,
      title,
      description,
      'New',
      ''
    ]]);
  } catch (err) {
    console.error('experience-suggest append:', err.message);
    return res.status(500).json({
      error:  'server_error',
      detail: 'Could not record suggestion. Make sure the Experience_Suggestions tab exists.'
    });
  }

  return res.status(200).json({ ok: true });
};
