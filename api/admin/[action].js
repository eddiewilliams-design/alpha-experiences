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
// URL pattern: /api/admin/<single-segment-action>
// File is api/admin/[action].js — Vercel's single-segment dynamic
// route. We tried [...path].js (catch-all) first but it doesn't
// reliably bind req.query for single-segment URLs. We use dash-joined
// names like "trips-list" / "trips-create" instead of nested paths.
//
// Adds a new endpoint = new case in the switch below.
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

function httpsRequest(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const buf = body ? Buffer.from(body) : null;
    const opts = {
      method,
      hostname: u.hostname,
      path:     u.pathname + u.search,
      headers:  Object.assign({}, headers || {}, buf ? { 'Content-Length': buf.length } : {})
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

async function sheetsClear(token, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:clear`;
  const r = await httpsRequest('POST', url, {
    'Authorization': 'Bearer ' + token,
    'Content-Type':  'application/json'
  }, '{}');
  if (r.status < 200 || r.status >= 300) throw new Error('clear failed: ' + r.status + ' ' + r.body);
}

async function sheetsUpdate(token, range, values) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const r = await httpsRequest('PUT', url, {
    'Authorization': 'Bearer ' + token,
    'Content-Type':  'application/json'
  }, JSON.stringify({ range, majorDimension: 'ROWS', values }));
  if (r.status < 200 || r.status >= 300) throw new Error('update failed: ' + r.status + ' ' + r.body);
}

async function sheetsAppend(token, range, values) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}` +
              `:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const r = await httpsRequest('POST', url, {
    'Authorization': 'Bearer ' + token,
    'Content-Type':  'application/json'
  }, JSON.stringify({ range, majorDimension: 'ROWS', values }));
  if (r.status < 200 || r.status >= 300) throw new Error('append failed: ' + r.status + ' ' + r.body);
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

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'trip';
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

// ── handleTripGet: load one trip + its sessions + prep ─────
async function handleTripGet(req, res) {
  const tripId = (req.query.trip_id || '').toString().trim();
  if (!tripId) return res.status(400).json({ error: 'bad_request', detail: 'trip_id required' });

  try {
    const token = await getAccessToken();
    const sheet = await batchGet(token, ['FT_Catalog!A:K', 'FT_Sessions!A:F', 'FT_Prep!A:F']);
    const ranges = (sheet && sheet.valueRanges) || [];
    const catalogRows = (ranges[0] && ranges[0].values) || [];
    const sessionRows = (ranges[1] && ranges[1].values) || [];
    const prepRows    = (ranges[2] && ranges[2].values) || [];

    let trip = null;
    for (let i = 1; i < catalogRows.length; i++) {
      const r = catalogRows[i];
      if ((r[0] || '').toString().trim() === tripId) {
        trip = {
          trip_id:               tripId,
          title:                 (r[1]  || '').toString(),
          description:           (r[2]  || '').toString(),
          emoji:                 (r[3]  || '').toString(),
          trip_date:             (r[4]  || '').toString(),
          status:                (r[5]  || '').toString().toLowerCase(),
          max_seats_per_session: (r[6]  || '').toString(),
          reflection_prompt:     (r[7]  || '').toString(),
          thumbnail_url:         (r[8]  || '').toString(),
          what_to_bring:         (r[9]  || '').toString(),
          format:                (r[10] || '').toString()
        };
        break;
      }
    }
    if (!trip) return res.status(404).json({ error: 'not_found' });

    const sessions = [];
    for (let i = 1; i < sessionRows.length; i++) {
      const r = sessionRows[i];
      if ((r[1] || '').toString().trim() !== tripId) continue;
      sessions.push({
        session_id:   (r[0] || '').toString(),
        start_time:   (r[2] || '').toString(),
        end_time:     (r[3] || '').toString(),
        zoom_link:    (r[4] || '').toString(),
        nearpod_link: (r[5] || '').toString()
      });
    }

    const prep = [];
    for (let i = 1; i < prepRows.length; i++) {
      const r = prepRows[i];
      if ((r[1] || '').toString().trim() !== tripId) continue;
      prep.push({
        prep_id:  (r[0] || '').toString(),
        title:    (r[2] || '').toString(),
        type:     (r[3] || '').toString().toLowerCase(),
        url:      (r[4] || '').toString(),
        duration: (r[5] || '').toString()
      });
    }

    return res.status(200).json({ trip, sessions, prep });
  } catch (err) {
    console.error('trip-get error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }
}

// ── handleTripSave: create or update a trip + replace its sessions/prep ──
async function handleTripSave(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const title = (body.title || '').toString().trim();
  if (!title) return res.status(400).json({ error: 'bad_request', detail: 'title required' });

  const VALID_STATUS = ['draft', 'open', 'closed', 'completed'];
  let status = (body.status || 'draft').toString().toLowerCase().trim();
  if (VALID_STATUS.indexOf(status) === -1) status = 'draft';

  const incoming = {
    trip_id:               (body.trip_id || '').toString().trim(),
    title:                 title,
    description:           (body.description       || '').toString(),
    emoji:                 (body.emoji             || '').toString(),
    trip_date:             (body.trip_date         || '').toString(),
    status:                status,
    max_seats_per_session: (body.max_seats_per_session || '').toString(),
    reflection_prompt:     (body.reflection_prompt || '').toString(),
    what_to_bring:         (body.what_to_bring     || '').toString(),
    format:                (body.format            || '').toString()
  };

  const incomingSessions = Array.isArray(body.sessions) ? body.sessions : [];
  const incomingPrep     = Array.isArray(body.prep)     ? body.prep     : [];

  let token;
  try {
    token = await getAccessToken('https://www.googleapis.com/auth/spreadsheets');
  } catch (err) {
    console.error('getAccessToken (write) failed:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  // 1. Read existing data
  let catalogRows, sessionRows, prepRows;
  try {
    const sheet = await batchGet(token, ['FT_Catalog!A:K', 'FT_Sessions!A:F', 'FT_Prep!A:F']);
    const ranges = (sheet && sheet.valueRanges) || [];
    catalogRows = (ranges[0] && ranges[0].values) || [];
    sessionRows = (ranges[1] && ranges[1].values) || [];
    prepRows    = (ranges[2] && ranges[2].values) || [];
  } catch (err) {
    console.error('trip-save read error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  // 2. Resolve trip_id (preserve existing on edit; generate unique slug on create)
  const existingIds = new Set();
  let existingRowIndex = -1;
  for (let i = 1; i < catalogRows.length; i++) {
    const id = (catalogRows[i][0] || '').toString().trim();
    if (id) existingIds.add(id);
  }
  let tripId = incoming.trip_id;
  if (tripId) {
    for (let i = 1; i < catalogRows.length; i++) {
      if ((catalogRows[i][0] || '').toString().trim() === tripId) {
        existingRowIndex = i; break;
      }
    }
    if (existingRowIndex === -1) {
      // Caller passed a trip_id that doesn't exist — refuse to silently create
      return res.status(404).json({ error: 'not_found' });
    }
  } else {
    // Generate from title, ensure unique
    const base = slugify(title);
    let candidate = base;
    let n = 2;
    while (existingIds.has(candidate)) candidate = `${base}-${n++}`;
    tripId = candidate;
  }

  // 3. Build the catalog row
  const catalogRow = [
    tripId,
    incoming.title,
    incoming.description,
    incoming.emoji,
    incoming.trip_date,
    incoming.status,
    incoming.max_seats_per_session,
    incoming.reflection_prompt,
    '',                       // thumbnail_url (col I) — unused for now
    incoming.what_to_bring,
    incoming.format
  ];

  try {
    if (existingRowIndex >= 0) {
      const rowNum = existingRowIndex + 1; // 1-indexed
      await sheetsUpdate(token, `FT_Catalog!A${rowNum}:K${rowNum}`, [catalogRow]);
    } else {
      await sheetsAppend(token, 'FT_Catalog!A:K', [catalogRow]);
    }
  } catch (err) {
    console.error('trip-save catalog write error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  // 4. Replace sessions for this trip:
  //    keep header + other-trip rows, append the form's session rows.
  try {
    const sessionsHeader = sessionRows[0] || ['session_id', 'trip_id', 'start_time', 'end_time', 'zoom_link', 'nearpod_link'];
    const otherSessions  = sessionRows.slice(1).filter(r => (r[1] || '').toString().trim() !== tripId);
    const newSessions    = incomingSessions.map((s, i) => [
      (s.session_id && String(s.session_id).trim()) || `${tripId}-${Date.now()}-${i}`,
      tripId,
      (s.start_time   || '').toString(),
      (s.end_time     || '').toString(),
      (s.zoom_link    || '').toString(),
      (s.nearpod_link || '').toString()
    ]);
    const allSessions = [sessionsHeader].concat(otherSessions).concat(newSessions);
    await sheetsClear(token, 'FT_Sessions!A:F');
    await sheetsUpdate(token, 'FT_Sessions!A1', allSessions);
  } catch (err) {
    console.error('trip-save sessions write error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  // 5. Replace prep for this trip — same pattern
  try {
    const prepHeader  = prepRows[0] || ['prep_id', 'trip_id', 'title', 'type', 'url', 'duration'];
    const otherPrep   = prepRows.slice(1).filter(r => (r[1] || '').toString().trim() !== tripId);
    const newPrep     = incomingPrep.map((p, i) => [
      (p.prep_id && String(p.prep_id).trim()) || `${tripId}-prep-${Date.now()}-${i}`,
      tripId,
      (p.title    || '').toString(),
      (p.type     || '').toString().toLowerCase(),
      (p.url      || '').toString(),
      (p.duration || '').toString()
    ]);
    const allPrep = [prepHeader].concat(otherPrep).concat(newPrep);
    await sheetsClear(token, 'FT_Prep!A:F');
    await sheetsUpdate(token, 'FT_Prep!A1', allPrep);
  } catch (err) {
    console.error('trip-save prep write error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(200).json({ ok: true, trip_id: tripId });
}

// ── Dispatch ────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'not_authenticated' });
  if (!session.isAdmin) return res.status(403).json({ error: 'forbidden' });

  // Single-segment dynamic route: [action].js gives req.query.action
  const action = (req.query.action || '').toString();

  switch (action) {
    case 'trips-list': return handleTripsList(req, res);
    case 'trip-get':   return handleTripGet(req, res);
    case 'trip-save':  return handleTripSave(req, res);
    default:           return res.status(404).json({ error: 'not_found', detail: action });
  }
};
