// ============================================================
// ALPHA EXPERIENCES — SAVE SELECTIONS API
// Vercel Serverless Function — Service Account Auth
// POST /api/save-selections
// Body: { token, selections: ['session_0', 'session_2'] }
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
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600
  }));
  const data = hdr + '.' + pay;
  const sig  = crypto.createSign('RSA-SHA256').update(data).sign(sa.private_key, 'base64')
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  return data + '.' + sig;
}

function post(url, body, headers) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body);
    const isJson = headers['Content-Type'] === 'application/json';
    const opts = { method: 'POST', headers: { ...headers, 'Content-Length': buf.length } };
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) return res.status(500).json({ error: 'Server configuration error' });

  let body = '';
  await new Promise(resolve => { req.on('data', c => body += c); req.on('end', resolve); });

  let token, selections;
  try {
    const parsed = JSON.parse(body);
    token = (parsed.token || '').trim();
    selections = parsed.selections || [];
  } catch(e) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  if (!token || !selections.length) {
    return res.status(400).json({ error: 'Missing token or selections' });
  }

  try {
    const sa = JSON.parse(saJson);
    const jwt = makeJWT(sa);

    const tokenRes = await post(
      'https://oauth2.googleapis.com/token',
      'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt,
      { 'Content-Type': 'application/x-www-form-urlencoded' }
    );

    const accessToken = tokenRes.access_token;
    if (!accessToken) return res.status(500).json({ error: 'Auth failed' });

    // Find the row with this token
    const sheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(RANGE)}`;
    const data = await getSheet(sheetUrl, accessToken);
    const rows = data.values || [];

    let rowIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i][6] || '').trim() === token) {
        rowIndex = i + 1; // 1-indexed for Sheets API
        break;
      }
    }

    if (rowIndex === -1) {
      return res.status(404).json({ error: 'Token not found' });
    }

    // Write selections to columns J and K (indices 9 and 10)
    // J = selections locked (YES), K = selected session IDs (comma separated)
    const updateRange = `Sheet1!J${rowIndex}:K${rowIndex}`;
    const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(updateRange)}?valueInputOption=RAW`;
    await putSheet(updateUrl, {
      range: updateRange,
      majorDimension: 'ROWS',
      values: [['YES', selections.join(',')]]
    }, accessToken);

    return res.status(200).json({ saved: true });
  } catch(err) {
    console.error('save-selections error:', err.message);
    return res.status(500).json({ error: 'Failed to save selections' });
  }
};
