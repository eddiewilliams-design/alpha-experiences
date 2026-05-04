// ============================================================
// ALPHA EXPERIENCES — ADMIN DISPATCHER
// One Vercel function that handles all /api/admin/* endpoints.
//
// Why: Vercel Hobby caps deploys at 12 serverless functions.
// We have many planned admin endpoints (trips list/create/update,
// registrations list + attendance toggle, admins list/add/remove,
// submissions delete). Routing them all through one catch-all
// keeps us comfortably under the limit forever.
//
// Adds a new endpoint = new case in the switch below + new
// `case 'foo/bar':` line. URL pattern is /api/admin/<segment>/<segment>.
//
// Every request goes through one place that:
//   1. Verifies session
//   2. Verifies session.isAdmin === true
//   3. Dispatches by path
// So no admin endpoint can accidentally skip the admin check.
// ============================================================

const https  = require('https');
const crypto = require('crypto');
const { getSession, httpsGet } = require('../_lib/session.js');

const SHEET_ID = '1aQYysCOOR-mYG8Myrl1BSU2PF8wMl-si8pgNG89sRto';

// ── Sheets access (read-only for now; add write scope when needed) ──
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
async function getAccessToken(scope) {
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');
  const sa  = JSON.parse(saJson);
  const jwt = makeJWT(sa, scope || 'https://www.googleapis.com/auth/spreadsheets.readonly');
  const r = await postForm(
    'https://oauth2.googleapis.com/token',
    'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
  );
  if (!r.access_token) throw new Error('no access token from Google');
  return r.access_token;
}
async function batchGet(token, ranges) {
  const params = ranges.map(r => 'ranges=' + encodeURIComponent(r)).join('&');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchGet?${params}`;
  return httpsGet(url, { Authorization: 'Bearer ' + token });
}

// ── Handlers ─────────────────────────────────────────────────

async function handleTripsList(req, res) {
  let trips = [];
  let stats = { total_trips: 0, open_trips: 0, total_registrations: 0 };

  try {
    const token = await getAccessToken();
    const sheet = await batchGet(token, [
      'FT_Catalog!A:K',
      'FT_Sessions!A:F',
      'FT_Prep!A:F',
      'FT_Purchases!A:I'
    ]);
    const ranges = (sheet && sheet.valueRanges) || [];
    const catalogRows  = (ranges[0] && ranges[0].values) || [];
    const sessionRows  = (ranges[1] && ranges[1].values) || [];
    const prepRows     = (ranges[2] && ranges[2].values) || [];
    const purchaseRows = (ranges[3] && ranges[3].values) || [];

    // session counts per trip
    const sessionsByTrip = {};
    for (let i = 1; i < sessionRows.length; i++) {
      const tripId = (sessionRows[i][1] || '').toString().trim();
      if (!tripId) continue;
      sessionsByTrip[tripId] = (sessionsByTrip[tripId] || 0) + 1;
    }
    // prep counts per trip
    const prepByTrip = {};
    for (let i = 1; i < prepRows.length; i++) {
      const tripId = (prepRows[i][1] || '').toString().trim();
      if (!tripId) continue;
      prepByTrip[tripId] = (prepByTrip[tripId] || 0) + 1;
    }
    // active registration counts per trip
    const regsByTrip = {};
    for (let i = 1; i < purchaseRows.length; i++) {
      const tripId = (purchaseRows[i][4] || '').toString().trim();
      const status = (purchaseRows[i][6] || '').toString().toLowerCase().trim();
      if (!tripId) continue;
      if (status && status !== 'active') continue;
      regsByTrip[tripId] = (regsByTrip[tripId] || 0) + 1;
    }

    let totalRegs = 0;
    let openCount = 0;
    for (let i = 1; i < catalogRows.length; i++) {
      const r = catalogRows[i];
      const id = (r[0] || '').toString().trim();
      if (!id) continue;
      const status      = (r[5] || '').toString().toLowerCase().trim();
      const maxPerSess  = parseInt((r[6] || '').toString(), 10);
      const sessionCnt  = sessionsByTrip[id] || 0;
      const prepCnt     = prepByTrip[id]     || 0;
      const regCnt      = regsByTrip[id]     || 0;
      const maxSeats    = (isFinite(maxPerSess) && maxPerSess > 0)
        ? maxPerSess * sessionCnt
        : 0;

      trips.push({
        trip_id:            id,
        title:              (r[1] || '').toString(),
        emoji:              (r[3] || '').toString(),
        trip_date:          (r[4] || '').toString(),
        status:             status,
        session_count:      sessionCnt,
        prep_count:         prepCnt,
        registration_count: regCnt,
        max_seats:          maxSeats
      });

      totalRegs += regCnt;
      if (status === 'open') openCount += 1;
    }

    // Sort: open trips first (by date asc), then drafts, then closed/completed
    const order = { open: 0, draft: 1, closed: 2, completed: 3 };
    trips.sort((a, b) => {
      const ao = order[a.status] != null ? order[a.status] : 9;
      const bo = order[b.status] != null ? order[b.status] : 9;
      if (ao !== bo) return ao - bo;
      return (a.trip_date || '').localeCompare(b.trip_date || '');
    });

    stats = { total_trips: trips.length, open_trips: openCount, total_registrations: totalRegs };
  } catch (err) {
    console.error('admin trips/list error:', err.message);
    trips = [];
  }

  return res.status(200).json({ trips, stats });
}

// ── Dispatch ────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'not_authenticated' });
  if (!session.isAdmin) return res.status(403).json({ error: 'forbidden' });

  // Vercel sets req.query.path to a string for single segment, array for multiple.
  const raw = req.query.path;
  const path = Array.isArray(raw) ? raw.join('/') : (raw || '');

  switch (path) {
    case 'trips/list': return handleTripsList(req, res);
    default:           return res.status(404).json({ error: 'not_found', detail: path });
  }
};
