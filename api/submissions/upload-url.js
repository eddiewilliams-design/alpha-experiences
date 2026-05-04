// ============================================================
// ALPHA EXPERIENCES — SUPABASE SIGNED UPLOAD URL
// POST /api/submissions/upload-url
//   body: { trip_id, filename }
//   200 → { upload_url, public_url, path }
//   401 → not authenticated
//   403 → not_purchased (student didn't buy this trip)
//   400 → bad_request (missing/invalid fields, bad extension)
//
// The Supabase service-role key never leaves the server. The
// browser receives a one-shot signed URL it can PUT the file to
// directly, plus the eventual public URL we'll record in
// FT_Submissions after the upload completes.
// ============================================================

const https = require('https');
const crypto = require('crypto');
const { getSession } = require('../_lib/session.js');

const BUCKET = 'vft-submissions';
const ALLOWED_EXT = ['jpg', 'jpeg', 'png', 'mp4'];

// Same Sheets-access pattern used by other endpoints, just for the
// purchase check. Inlined here to keep this file self-contained.
const SHEET_ID = '1aQYysCOOR-mYG8Myrl1BSU2PF8wMl-si8pgNG89sRto';

function b64url(str) {
  return Buffer.from(str).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function makeJWT(sa) {
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const pay = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
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

async function fetchPurchases(token) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent('FT_Purchases!A:I')}`;
  const r = await httpsRequest('GET', url, { Authorization: 'Bearer ' + token });
  if (r.status !== 200) throw new Error('sheet read failed: ' + r.status);
  const data = JSON.parse(r.body || '{}');
  return data.values || [];
}

async function getSheetsAccessToken() {
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');
  const sa = JSON.parse(saJson);
  const jwt = makeJWT(sa);
  const r = await postForm(
    'https://oauth2.googleapis.com/token',
    'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
  );
  if (!r.access_token) throw new Error('no access token from Google');
  return r.access_token;
}

function sanitizeFilename(name) {
  if (!name) return 'upload';
  // Strip path separators, keep extension, replace anything weird with -
  const base = String(name).split(/[\\/]/).pop();
  return base.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'upload';
}

function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
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

  // Vercel may parse JSON automatically; otherwise parse body manually.
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

  const tripId   = (body.trip_id  || '').toString().trim();
  const filename = (body.filename || '').toString().trim();
  if (!tripId || !filename) {
    return res.status(400).json({ error: 'bad_request', detail: 'trip_id and filename required' });
  }

  const ext = extOf(filename);
  if (ALLOWED_EXT.indexOf(ext) === -1) {
    return res.status(400).json({ error: 'bad_extension', detail: 'allowed: ' + ALLOWED_EXT.join(', ') });
  }

  // Purchase check (same shape used elsewhere)
  const myEmail = (session.email || '').toLowerCase().trim();
  try {
    const sheetsToken = await getSheetsAccessToken();
    const rows = await fetchPurchases(sheetsToken);
    let owns = false;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const email     = (r[1] || '').toString().toLowerCase().trim();
      const purchTrip = (r[4] || '').toString().trim();
      const status    = (r[6] || '').toString().toLowerCase().trim();
      if (email === myEmail && purchTrip === tripId && (!status || status === 'active')) {
        owns = true; break;
      }
    }
    if (!owns) return res.status(403).json({ error: 'not_purchased' });
  } catch (err) {
    console.error('purchase check failed:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  // Build object path: {trip_id}/{ISO}-{rand}-{safe_filename}
  const safeName = sanitizeFilename(filename);
  const stamp    = new Date().toISOString().replace(/[:.]/g, '-');
  const rand     = crypto.randomBytes(3).toString('hex');
  const path     = `${tripId}/${stamp}-${rand}-${safeName}`;

  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('Supabase env vars missing');
    return res.status(500).json({ error: 'server_config_error' });
  }

  // Ask Supabase to mint a signed upload URL for that path.
  const signEndpoint = `${SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/upload/sign/${BUCKET}/${path}`;
  let signRes;
  try {
    signRes = await httpsRequest('POST', signEndpoint, {
      'Authorization': 'Bearer ' + SERVICE_KEY,
      'Content-Type':  'application/json'
    }, '{}');
  } catch (err) {
    console.error('supabase sign request failed:', err.message);
    return res.status(502).json({ error: 'upstream_error' });
  }

  if (signRes.status < 200 || signRes.status >= 300) {
    console.error('supabase sign returned', signRes.status, signRes.body);
    return res.status(502).json({ error: 'upstream_error' });
  }

  let signed;
  try { signed = JSON.parse(signRes.body || '{}'); }
  catch (e) {
    console.error('supabase sign returned non-JSON:', signRes.body);
    return res.status(502).json({ error: 'upstream_error' });
  }

  // Supabase has used a few response shapes over the years.
  // Build a full upload URL from whichever fields are present.
  let uploadUrl = '';
  if (signed.signedUrl) {
    uploadUrl = signed.signedUrl.startsWith('http')
      ? signed.signedUrl
      : `${SUPABASE_URL.replace(/\/$/, '')}/storage/v1${signed.signedUrl}`;
  } else if (signed.url) {
    uploadUrl = signed.url.startsWith('http')
      ? signed.url
      : `${SUPABASE_URL.replace(/\/$/, '')}/storage/v1${signed.url}`;
  } else if (signed.token) {
    uploadUrl = `${SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/upload/sign/${BUCKET}/${path}?token=${encodeURIComponent(signed.token)}`;
  } else {
    console.error('supabase sign response missing url/token:', signed);
    return res.status(502).json({ error: 'upstream_error' });
  }

  const publicUrl = `${SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/public/${BUCKET}/${path}`;

  return res.status(200).json({
    upload_url: uploadUrl,
    public_url: publicUrl,
    path:       path
  });
};
