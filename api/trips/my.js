// ============================================================
// ALPHA EXPERIENCES — STUDENT'S PURCHASED TRIPS
// GET /api/trips/my
//   200 → { trips: [{ trip_id, title, emoji, trip_date, status,
//                     session_id, session_start, session_end }] }
//   401 → { error: "not_authenticated" }
//
// Joins three tabs in the sheet:
//   FT_Purchases (filter rows where col B = logged-in email
//                 AND col G = "active")
//   FT_Catalog   (look up trip metadata by trip_id)
//   FT_Sessions  (look up session start/end by session_id)
//
// Defensive: if any tab is missing or unreadable (e.g. Eddie
// hasn't created them yet) the endpoint returns an empty array
// rather than a 500, so the empty state renders.
// ============================================================

const {
  getSession,
  httpsGet,
  // getServiceAccountAccessToken is internal to session.js,
  // re-exposed here through the same token-fetching pattern below.
} = require('../_lib/session.js');

const https  = require('https');
const crypto = require('crypto');

const SHEET_ID = '1aQYysCOOR-mYG8Myrl1BSU2PF8wMl-si8pgNG89sRto';
const RANGES   = ['FT_Purchases!A:I', 'FT_Catalog!A:I', 'FT_Sessions!A:F'];

// ── Sheets access (same JWT pattern as validate-token.js) ───
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

function postForm(url, body) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body);
    const opts = {
      method: 'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': buf.length
      }
    };
    const req = https.request(url, opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end',  () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

async function getAccessToken() {
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');
  const sa  = JSON.parse(saJson);
  const jwt = makeJWT(sa);
  const res = await postForm(
    'https://oauth2.googleapis.com/token',
    'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
  );
  if (!res.access_token) throw new Error('no access token from Google');
  return res.access_token;
}

// batchGet: one round trip for all three ranges.
async function fetchSheet(token) {
  const params = RANGES.map(r => 'ranges=' + encodeURIComponent(r)).join('&');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchGet?${params}`;
  return httpsGet(url, { Authorization: 'Bearer ' + token });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'not_authenticated' });
  }

  const myEmail = (session.email || '').toLowerCase().trim();

  let trips = [];
  try {
    const token = await getAccessToken();
    const sheet = await fetchSheet(token);
    const ranges = (sheet && sheet.valueRanges) || [];

    const purchaseRows = (ranges[0] && ranges[0].values) || [];
    const catalogRows  = (ranges[1] && ranges[1].values) || [];
    const sessionRows  = (ranges[2] && ranges[2].values) || [];

    // Build lookup maps (skip header row)
    const tripsById    = {};
    const sessionsById = {};

    for (let i = 1; i < catalogRows.length; i++) {
      const r = catalogRows[i];
      const id = (r[0] || '').toString().trim();
      if (!id) continue;
      tripsById[id] = {
        trip_id:     id,
        title:       (r[1] || '').toString(),
        description: (r[2] || '').toString(),
        emoji:       (r[3] || '').toString(),
        trip_date:   (r[4] || '').toString(),
        status:      (r[5] || '').toString().toLowerCase()
      };
    }

    for (let i = 1; i < sessionRows.length; i++) {
      const r = sessionRows[i];
      const id = (r[0] || '').toString().trim();
      if (!id) continue;
      sessionsById[id] = {
        session_id: id,
        trip_id:    (r[1] || '').toString().trim(),
        start_time: (r[2] || '').toString(),
        end_time:   (r[3] || '').toString()
      };
    }

    // Filter purchases for this student
    for (let i = 1; i < purchaseRows.length; i++) {
      const r = purchaseRows[i];
      const email     = (r[1] || '').toString().toLowerCase().trim();
      const sessionId = (r[3] || '').toString().trim();
      const tripId    = (r[4] || '').toString().trim();
      const status    = (r[6] || '').toString().toLowerCase().trim();

      if (email !== myEmail) continue;
      if (status && status !== 'active') continue;

      const trip    = tripsById[tripId];
      const sessRow = sessionsById[sessionId];
      if (!trip) continue;

      trips.push({
        trip_id:       trip.trip_id,
        title:         trip.title,
        emoji:         trip.emoji,
        trip_date:     trip.trip_date,
        status:        trip.status === 'completed' ? 'completed' : 'registered',
        session_id:    sessionId,
        session_start: sessRow ? sessRow.start_time : '',
        session_end:   sessRow ? sessRow.end_time   : ''
      });
    }

    // Soonest trip first
    trips.sort((a, b) => (a.trip_date || '').localeCompare(b.trip_date || ''));
  } catch (err) {
    // Tab missing, sheet error, etc. — log, return empty so the
    // page still renders the empty state instead of erroring out.
    console.error('trips/my error:', err.message);
    trips = [];
  }

  return res.status(200).json({ trips: trips });
};
