// ============================================================
// ALPHA EXPERIENCES — GET SESSIONS API  v2
// Vercel Serverless Function — Service Account Auth
// GET /api/get-sessions
// GET /api/get-sessions?include=blooket,improv
//   → ?include= forces those session IDs to appear even if
//     inactive or within a coach blackout window.
//     Used by lul.html for students who already locked in.
//
// Sessions tab column layout (A–K):
//   A (0)  Name
//   B (1)  Emoji
//   C (2)  Coach
//   D (3)  Day
//   E (4)  Time
//   F (5)  Description
//   G (6)  Link
//   H (7)  Session ID  ← stable unique slug, e.g. "blooket"
//   I (8)  Active      ← YES / NO
//   J (9)  Blackout Start  ← date (leave blank if not needed)
//   K (10) Blackout End    ← date (leave blank if not needed)
// ============================================================

const https  = require('https');
const crypto = require('crypto');

const SHEET_ID      = '1aQYysCOOR-mYG8Myrl1BSU2PF8wMl-si8pgNG89sRto';
const SESSIONS_RANGE = 'Sessions!A:K';

// ── JWT helpers ─────────────────────────────────────────────

function b64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
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
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return data + '.' + sig;
}

// ── HTTP helpers ─────────────────────────────────────────────

function post(url, body) {
  return new Promise((resolve, reject) => {
    const buf  = Buffer.from(body);
    const opts = {
      method:  'POST',
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

function getSheet(url, token) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: 'Bearer ' + token } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

// ── Date helper ───────────────────────────────────────────────
// Google Sheets can return dates as serial numbers (days since 1899-12-30)
// or as formatted strings like "5/12/2026". Handle both.

function parseSheetDate(val) {
  if (!val && val !== 0) return null;
  // Serial number
  if (typeof val === 'number' || /^\d+(\.\d+)?$/.test(String(val).trim())) {
    const serial = parseFloat(val);
    const epoch  = Date.UTC(1899, 11, 30); // Dec 30, 1899
    return new Date(epoch + serial * 86400000);
  }
  // String date
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

// ── Handler ───────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ?include=id1,id2 — always show these session IDs regardless of active/blackout
  // Used when a student has already locked in, so their picks always appear.
  const includeParam  = (req.query.include || '').trim();
  const alwaysInclude = includeParam
    ? new Set(includeParam.split(',').map(s => s.trim()).filter(Boolean))
    : new Set();

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) return res.status(500).json({ error: 'server_config_error' });

  try {
    const sa  = JSON.parse(saJson);
    const jwt = makeJWT(sa);

    const tokenRes = await post(
      'https://oauth2.googleapis.com/token',
      'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
    );
    const accessToken = tokenRes.access_token;
    if (!accessToken) return res.status(500).json({ error: 'auth_failed' });

    const url  = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(SESSIONS_RANGE)}`;
    const data = await getSheet(url, accessToken);
    const rows = data.values || [];

    // Today at midnight CT for blackout comparison
    const now   = new Date();
    const today = new Date(now.toLocaleDateString('en-US', { timeZone: 'America/Chicago' }));

    const sessions = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row[0]) continue; // skip blank rows

      const name        = (row[0] || '').trim();
      const emoji       = (row[1] || '🎮').trim();
      const coach       = (row[2] || '').trim();
      const day         = (row[3] || '').trim();
      const time        = (row[4] || '').trim();
      const description = (row[5] || '').trim();
      const link        = (row[6] || '').trim();
      const sessionId   = (row[7] || '').trim();
      const active      = (row[8] || 'YES').trim().toUpperCase(); // default YES for old rows
      const blackoutStart = parseSheetDate(row[9]);
      const blackoutEnd   = parseSheetDate(row[10]);

      // Stable ID: use col H if present, else fall back to positional for old rows
      const id = sessionId || ('session_' + (i - 1));

      // If this ID is in the ?include= list, always show it (locked student's pick)
      const forceInclude = alwaysInclude.has(id);

      if (!forceInclude) {
        // Skip inactive sessions
        if (active === 'NO') continue;

        // Skip sessions within a coach blackout window
        if (blackoutStart && blackoutEnd) {
          const start = new Date(blackoutStart); start.setHours(0,  0,  0,   0);
          const end   = new Date(blackoutEnd);   end.setHours(  23, 59, 59, 999);
          if (today >= start && today <= end) continue;
        }
      }

      sessions.push({ id, name, emoji, coach, day, time, description, link });
    }

    return res.status(200).json({ sessions });

  } catch (err) {
    console.error('get-sessions error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }
};
