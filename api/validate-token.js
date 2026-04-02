// ============================================================
// ALPHA EXPERIENCES — TOKEN VALIDATION API
// Vercel Serverless Function — Service Account Auth
// GET /api/validate-token?token=XXXXXXXX
// ============================================================

const https  = require('https');
const crypto = require('crypto');

const SHEET_ID = '1aQYysCOOR-mYG8Myrl1BSU2PF8wMl-si8pgNG89sRto';
const RANGE    = 'Sheet1!A:K';

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = (req.query.token || '').trim();
  if (!token) return res.status(400).json({ valid: false, reason: 'no_token' });

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) return res.status(500).json({ valid: false, reason: 'server_config_error' });

  try {
    const sa = JSON.parse(saJson);
    const jwt = makeJWT(sa);

    const tokenRes = await post('https://oauth2.googleapis.com/token',
      'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt);

    const accessToken = tokenRes.access_token;
    if (!accessToken) return res.status(500).json({ valid: false, reason: 'auth_failed' });

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(RANGE)}`;
    const data = await get(url, accessToken);
    const rows = data.values || [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const rowToken  = (row[6] || '').trim();
      const active    = row[7];
      const expType   = row[0] || '';
      const locked    = (row[9] || '').trim();
      const savedSels = (row[10] || '').trim();

      if (rowToken === token) {
        if (active !== 'TRUE') {
          return res.status(403).json({ valid: false, reason: 'inactive' });
        }
        const isFullWeek = expType.indexOf('2 Sessions') === -1;
        const response = {
          valid: true,
          mode: isFullWeek ? 'full' : 'two',
          name: (row[1] || '').split(' ')[0]
        };
        // If selections are locked, return them
        if (locked === 'YES' && savedSels) {
          response.locked = true;
          response.savedSelections = savedSels.split(',');
        }
        return res.status(200).json(response);
      }
    }

    return res.status(404).json({ valid: false, reason: 'not_found' });
  } catch(err) {
    console.error('validate-token error:', err.message);
    return res.status(500).json({ valid: false, reason: 'server_error' });
  }
};
