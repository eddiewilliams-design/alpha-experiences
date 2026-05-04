// ============================================================
// ALPHA EXPERIENCES — RECORD A SUBMISSION
// POST /api/submissions/create
//   body: { trip_id, display_name, location, file_url, file_type }
//   200 → { ok: true }
//   401 → not_authenticated
//   403 → not_purchased
//   400 → bad_request
//
// Appends a row to FT_Submissions:
//   A: student_email
//   B: trip_id
//   C: student_name (display name from the form)
//   D: location
//   E: file_url    (Supabase public URL)
//   F: file_type   ("image" or "video")
//   G: submitted_at (ISO 8601 UTC)
//
// Re-validates ownership of the trip on the server — even if a
// student crafts the request manually, they can only post under
// a trip they purchased.
// ============================================================

const https  = require('https');
const crypto = require('crypto');
const { getSession } = require('../_lib/session.js');

const SHEET_ID = '1aQYysCOOR-mYG8Myrl1BSU2PF8wMl-si8pgNG89sRto';
const APPEND_RANGE = 'FT_Submissions!A:G';

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
  const sig = crypto.createSign('RSA-SHA256').update(data).sign(sa.private_key, 'base64')
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
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(buf); req.end();
  });
}

function httpsRequest(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const buf = body ? Buffer.from(body) : null;
    const opts = {
      method,
      hostname: u.hostname,
      path:     u.pathname + u.search,
      headers:  Object.assign({}, headers, buf ? { 'Content-Length': buf.length } : {})
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end',  () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    if (buf) req.write(buf);
    req.end();
  });
}

async function getAccessToken(scope) {
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');
  const sa  = JSON.parse(saJson);
  const jwt = makeJWT(sa, scope);
  const r = await postForm(
    'https://oauth2.googleapis.com/token',
    'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
  );
  if (!r.access_token) throw new Error('no access token from Google');
  return r.access_token;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end',  () => resolve(d));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'not_authenticated' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body) {
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (e) { body = {}; }
  }

  const tripId       = (body.trip_id      || '').toString().trim();
  const displayName  = (body.display_name || '').toString().trim().slice(0, 80);
  const location     = (body.location     || '').toString().trim().slice(0, 80);
  const fileUrl      = (body.file_url     || '').toString().trim();
  const fileTypeRaw  = (body.file_type    || '').toString().toLowerCase().trim();

  if (!tripId || !displayName || !location || !fileUrl) {
    return res.status(400).json({ error: 'bad_request', detail: 'all fields required' });
  }
  // Only allow file_url that points to our Supabase public bucket
  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!SUPABASE_URL || fileUrl.indexOf(SUPABASE_URL + '/storage/v1/object/public/vft-submissions/') !== 0) {
    return res.status(400).json({ error: 'bad_file_url' });
  }
  const fileType = fileTypeRaw === 'video' ? 'video' : 'image';

  // Purchase check + append happen with one access token (write scope).
  let accessToken;
  try {
    accessToken = await getAccessToken('https://www.googleapis.com/auth/spreadsheets');
  } catch (err) {
    console.error('getAccessToken failed:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  const myEmail = (session.email || '').toLowerCase().trim();

  // Verify ownership
  try {
    const purchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent('FT_Purchases!A:I')}`;
    const r = await httpsRequest('GET', purchUrl, { Authorization: 'Bearer ' + accessToken });
    if (r.status !== 200) throw new Error('purchase read failed: ' + r.status);
    const data = JSON.parse(r.body || '{}');
    const rows = data.values || [];
    let owns = false;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const email     = (row[1] || '').toString().toLowerCase().trim();
      const purchTrip = (row[4] || '').toString().trim();
      const status    = (row[6] || '').toString().toLowerCase().trim();
      if (email === myEmail && purchTrip === tripId && (!status || status === 'active')) {
        owns = true; break;
      }
    }
    if (!owns) return res.status(403).json({ error: 'not_purchased' });
  } catch (err) {
    console.error('purchase check failed:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  // Append the row
  const submittedAt = new Date().toISOString();
  const appendUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(APPEND_RANGE)}` +
    `:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const payload = JSON.stringify({
    range:          APPEND_RANGE,
    majorDimension: 'ROWS',
    values: [[
      myEmail,
      tripId,
      displayName,
      location,
      fileUrl,
      fileType,
      submittedAt
    ]]
  });

  try {
    const r = await httpsRequest('POST', appendUrl, {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type':  'application/json'
    }, payload);
    if (r.status < 200 || r.status >= 300) {
      console.error('sheet append failed:', r.status, r.body);
      return res.status(500).json({ error: 'server_error' });
    }
  } catch (err) {
    console.error('sheet append error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(200).json({ ok: true });
};
