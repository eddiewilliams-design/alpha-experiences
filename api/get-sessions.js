// ============================================================
// ALPHA EXPERIENCES — GET SESSIONS API
// Vercel Serverless Function — Service Account Auth
// GET /api/get-sessions
// ============================================================

const https  = require('https');
const crypto = require('crypto');

const SHEET_ID = '1aQYysCOOR-mYG8Myrl1BSU2PF8wMl-si8pgNG89sRto';
const RANGE    = 'Sessions!A:G';

function b64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

function makeJWT(sa) {
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const pay = b64url(JSON.stringify({
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600
  }));
  const data = hdr + '.' + pay;
  const sig  = crypto.createSign('RSA-SHA256').update(data).sign(sa.private_key, 'base64')
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  return data + '.' + sig;
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body);
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': buf.length }
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

function get(url, token) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: 'Bearer ' + token } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) return res.status(500).json({ error: 'Server configuration error' });

  try {
    const sa = JSON.parse(saJson);
    const jwt = makeJWT(sa);

    const tokenRes = await post('https://oauth2.googleapis.com/token',
      'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt);

    const accessToken = tokenRes.access_token;
    if (!accessToken) return res.status(500).json({ error: 'Auth failed' });

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(RANGE)}`;
    const data = await get(url, accessToken);
    const rows = (data.values || []).slice(1);

    const sessions = rows
      .filter(row => row[0])
      .map((row, i) => ({
        id:          'session_' + i,
        name:        row[0] || '',
        emoji:       row[1] || '🎯',
        coach:       row[2] || '',
        day:         row[3] || '',
        time:        row[4] || '',
        description: row[5] || '',
        link:        row[6] || ''
      }));

    return res.status(200).json({ sessions });
  } catch(err) {
    console.error('get-sessions error:', err.message);
    return res.status(500).json({ error: 'Failed to load sessions' });
  }
};
