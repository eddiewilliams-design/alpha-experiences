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
      'FT_Catalog!A:N',
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
        thumbnail_url:      (r[8]  || '').toString().trim(),
        thumbnail_focus:    (r[13] || '').toString().trim(),
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
    const sheet = await batchGet(token, ['FT_Catalog!A:N', 'FT_Sessions!A:F', 'FT_Prep!A:F']);
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
          format:                (r[10] || '').toString(),
          hero_image_url:        (r[11] || '').toString(),
          theme_emojis:          (r[12] || '').toString(),
          thumbnail_focus:       (r[13] || '').toString()
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
    thumbnail_url:         (body.thumbnail_url     || '').toString().trim(),
    what_to_bring:         (body.what_to_bring     || '').toString(),
    format:                (body.format            || '').toString(),
    hero_image_url:        (body.hero_image_url    || '').toString().trim(),
    theme_emojis:          (body.theme_emojis      || '').toString().trim(),
    thumbnail_focus:       (body.thumbnail_focus   || '').toString().trim()
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
    const sheet = await batchGet(token, ['FT_Catalog!A:M', 'FT_Sessions!A:F', 'FT_Prep!A:F']);
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
    incoming.thumbnail_url,    // col I — small image for trip cards
    incoming.what_to_bring,
    incoming.format,
    incoming.hero_image_url,   // col L — wide hero background
    incoming.theme_emojis,     // col M — decorative emojis
    incoming.thumbnail_focus   // col N — object-position for thumbnail crop
  ];

  try {
    if (existingRowIndex >= 0) {
      const rowNum = existingRowIndex + 1; // 1-indexed
      await sheetsUpdate(token, `FT_Catalog!A${rowNum}:N${rowNum}`, [catalogRow]);
    } else {
      await sheetsAppend(token, 'FT_Catalog!A:N', [catalogRow]);
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

// ── handleTripDelete: remove trip + its sessions + its prep ─
// Leaves FT_Purchases and FT_Submissions intact so we don't
// silently destroy records of past registrations / submissions.
// If the trip has active registrations and the caller didn't pass
// { force: true }, we 409 with the count so the UI can re-confirm.
async function handleTripDelete(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const tripId = (body.trip_id || '').toString().trim();
  const force  = body.force === true;
  if (!tripId) return res.status(400).json({ error: 'bad_request', detail: 'trip_id required' });

  let token;
  try { token = await getAccessToken('https://www.googleapis.com/auth/spreadsheets'); }
  catch (err) {
    console.error('trip-delete token error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  let catalogRows, sessionRows, prepRows, purchaseRows;
  try {
    const sheet = await batchGet(token, [
      'FT_Catalog!A:N', 'FT_Sessions!A:F', 'FT_Prep!A:F', 'FT_Purchases!A:I'
    ]);
    const ranges = (sheet && sheet.valueRanges) || [];
    catalogRows  = (ranges[0] && ranges[0].values) || [];
    sessionRows  = (ranges[1] && ranges[1].values) || [];
    prepRows     = (ranges[2] && ranges[2].values) || [];
    purchaseRows = (ranges[3] && ranges[3].values) || [];
  } catch (err) {
    console.error('trip-delete read error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  // Verify the trip exists
  let exists = false;
  for (let i = 1; i < catalogRows.length; i++) {
    if ((catalogRows[i][0] || '').toString().trim() === tripId) { exists = true; break; }
  }
  if (!exists) return res.status(404).json({ error: 'not_found' });

  // Count active registrations
  let regCount = 0;
  for (let i = 1; i < purchaseRows.length; i++) {
    const r = purchaseRows[i];
    if ((r[4] || '').toString().trim() !== tripId) continue;
    const status = (r[6] || '').toString().toLowerCase().trim();
    if (!status || status === 'active') regCount += 1;
  }

  if (regCount > 0 && !force) {
    return res.status(409).json({ error: 'has_registrations', registration_count: regCount });
  }

  // Catalog: keep header + every row except this trip's
  const catalogHeader = catalogRows[0] || [
    'trip_id','title','description','emoji','trip_date','status',
    'max_seats_per_session','reflection_prompt','thumbnail_url','what_to_bring','format',
    'hero_image_url','theme_emojis','thumbnail_focus'
  ];
  const remainingCatalog = catalogRows.slice(1).filter(r => (r[0] || '').toString().trim() !== tripId);
  const newCatalog = [catalogHeader].concat(remainingCatalog);

  // Sessions: keep header + every row whose trip_id !== this
  const sessionsHeader = sessionRows[0] || ['session_id','trip_id','start_time','end_time','zoom_link','nearpod_link'];
  const remainingSessions = sessionRows.slice(1).filter(r => (r[1] || '').toString().trim() !== tripId);
  const newSessions = [sessionsHeader].concat(remainingSessions);

  // Prep: same idea
  const prepHeader = prepRows[0] || ['prep_id','trip_id','title','type','url','duration'];
  const remainingPrep = prepRows.slice(1).filter(r => (r[1] || '').toString().trim() !== tripId);
  const newPrep = [prepHeader].concat(remainingPrep);

  try {
    await sheetsClear(token,  'FT_Catalog!A:N');
    await sheetsUpdate(token, 'FT_Catalog!A1', newCatalog);
    await sheetsClear(token,  'FT_Sessions!A:F');
    await sheetsUpdate(token, 'FT_Sessions!A1', newSessions);
    await sheetsClear(token,  'FT_Prep!A:F');
    await sheetsUpdate(token, 'FT_Prep!A1', newPrep);
  } catch (err) {
    console.error('trip-delete write error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(200).json({
    ok: true,
    trip_id: tripId,
    orphaned_registrations: regCount  // FT_Purchases rows we left alone for record
  });
}

// ── handleRegsList: registrations + trips/sessions for the dropdowns ─
async function handleRegsList(req, res) {
  let registrations = [];
  let trips = [];

  try {
    const token = await getAccessToken();
    const sheet = await batchGet(token, ['FT_Catalog!A:K', 'FT_Sessions!A:F', 'FT_Purchases!A:I']);
    const ranges = (sheet && sheet.valueRanges) || [];
    const catalogRows  = (ranges[0] && ranges[0].values) || [];
    const sessionRows  = (ranges[1] && ranges[1].values) || [];
    const purchaseRows = (ranges[2] && ranges[2].values) || [];

    // Build trips with their sessions for the form dropdown
    const tripsById = {};
    for (let i = 1; i < catalogRows.length; i++) {
      const r  = catalogRows[i];
      const id = (r[0] || '').toString().trim();
      if (!id) continue;
      tripsById[id] = {
        trip_id:   id,
        title:     (r[1] || '').toString(),
        emoji:     (r[3] || '').toString(),
        trip_date: (r[4] || '').toString(),
        status:    (r[5] || '').toString().toLowerCase(),
        sessions:  []
      };
    }

    const sessionsById = {};
    for (let i = 1; i < sessionRows.length; i++) {
      const r  = sessionRows[i];
      const id = (r[0] || '').toString().trim();
      if (!id) continue;
      const sess = {
        session_id: id,
        trip_id:    (r[1] || '').toString().trim(),
        start_time: (r[2] || '').toString(),
        end_time:   (r[3] || '').toString()
      };
      sessionsById[id] = sess;
      if (tripsById[sess.trip_id]) tripsById[sess.trip_id].sessions.push(sess);
    }

    trips = Object.values(tripsById).sort((a, b) =>
      (a.trip_date || '').localeCompare(b.trip_date || '') ||
      (a.title || '').localeCompare(b.title || '')
    );

    // Build registrations — skip cancelled rows (they're soft-deleted
    // and shouldn't appear in the admin table or CSV)
    for (let i = 1; i < purchaseRows.length; i++) {
      const r = purchaseRows[i];
      const studentEmail = (r[1] || '').toString().trim();
      if (!studentEmail) continue;
      const status = (r[6] || '').toString().toLowerCase().trim();
      if (status === 'cancelled') continue;

      const sessionId = (r[3] || '').toString().trim();
      const tripId    = (r[4] || '').toString().trim();
      const trip      = tripsById[tripId];
      const session   = sessionsById[sessionId];

      registrations.push({
        student_name:  (r[0] || '').toString(),
        student_email: studentEmail,
        parent_email:  (r[2] || '').toString(),
        session_id:    sessionId,
        trip_id:       tripId,
        purchase_date: (r[5] || '').toString(),
        status:        status || 'active',
        attended:      (r[7] || '').toString().toUpperCase().trim(),
        // Col I — stamped by handleRegCreate after the Intercom send
        // (Yes / FAILED / blank for legacy rows). Drives the
        // Confirmation chip on /admin/registrations.
        email_sent:    (r[8] || '').toString().trim(),
        // Joined for convenience on the client
        trip_title:    trip ? trip.title : tripId,
        trip_emoji:    trip ? trip.emoji : '',
        session_time:  session ? [session.start_time, session.end_time].filter(Boolean).join(' – ') : ''
      });
    }

    // Newest registrations first
    registrations.sort((a, b) => (b.purchase_date || '').localeCompare(a.purchase_date || ''));
  } catch (err) {
    console.error('regs-list error:', err.message);
    registrations = [];
    trips = [];
  }

  return res.status(200).json({ registrations, trips });
}

// ── handleRegCreate: append a row to FT_Purchases ──────────
async function handleRegCreate(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const studentName  = (body.student_name  || '').toString().trim();
  const studentEmail = (body.student_email || '').toString().toLowerCase().trim();
  const parentEmail  = (body.parent_email  || '').toString().toLowerCase().trim();
  const tripId       = (body.trip_id       || '').toString().trim();
  const sessionId    = (body.session_id    || '').toString().trim();
  let   purchaseDate = (body.purchase_date || '').toString().trim();
  if (!purchaseDate) purchaseDate = new Date().toISOString().slice(0, 10);

  if (!studentName || !studentEmail || !tripId || !sessionId) {
    return res.status(400).json({ error: 'bad_request', detail: 'student_name, student_email, trip_id, session_id required' });
  }

  // Light email-shape sanity check
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(studentEmail)) {
    return res.status(400).json({ error: 'bad_email', field: 'student_email' });
  }
  if (parentEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(parentEmail)) {
    return res.status(400).json({ error: 'bad_email', field: 'parent_email' });
  }

  let token;
  try { token = await getAccessToken('https://www.googleapis.com/auth/spreadsheets'); }
  catch (err) {
    console.error('reg-create token error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  // Verify the trip + session exist (and that the session belongs to the trip).
  // We pull wider ranges than strict validation needs so we can pass trip title
  // + session date/time into the confirmation email below.
  //   FT_Catalog: A trip_id, B title, C description, D emoji, E trip_date
  //   FT_Sessions: A session_id, B trip_id, C start_time, D end_time, E zoom, F nearpod
  let tripTitle = '';
  let tripDate  = '';
  let sessionStartTime = '';
  try {
    const sheet = await batchGet(token, ['FT_Catalog!A:E', 'FT_Sessions!A:F', 'FT_Purchases!A:I']);
    const ranges = (sheet && sheet.valueRanges) || [];
    const catalogRows  = (ranges[0] && ranges[0].values) || [];
    const sessionRows  = (ranges[1] && ranges[1].values) || [];
    const purchaseRows = (ranges[2] && ranges[2].values) || [];

    let tripExists = false;
    for (let i = 1; i < catalogRows.length; i++) {
      const r = catalogRows[i];
      if ((r[0] || '').toString().trim() === tripId) {
        tripExists = true;
        tripTitle  = (r[1] || '').toString();
        tripDate   = (r[4] || '').toString().trim();
        break;
      }
    }
    if (!tripExists) return res.status(400).json({ error: 'unknown_trip' });

    let sessionMatch = false;
    for (let i = 1; i < sessionRows.length; i++) {
      const r = sessionRows[i];
      if ((r[0] || '').toString().trim() === sessionId &&
          (r[1] || '').toString().trim() === tripId) {
        sessionMatch     = true;
        sessionStartTime = (r[2] || '').toString().trim();
        break;
      }
    }
    if (!sessionMatch) return res.status(400).json({ error: 'unknown_session' });

    // Reject duplicate active registration for same email + trip + session
    for (let i = 1; i < purchaseRows.length; i++) {
      const r = purchaseRows[i];
      const sameEmail   = (r[1] || '').toString().toLowerCase().trim() === studentEmail;
      const sameSession = (r[3] || '').toString().trim() === sessionId;
      const sameTrip    = (r[4] || '').toString().trim() === tripId;
      const status      = (r[6] || '').toString().toLowerCase().trim();
      if (sameEmail && sameSession && sameTrip && (!status || status === 'active')) {
        return res.status(409).json({ error: 'already_registered' });
      }
    }
  } catch (err) {
    console.error('reg-create validate error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  // Append row: A name, B student_email, C parent_email, D session_id, E trip_id,
  // F purchase_date, G status, H attended, I email_sent
  try {
    await sheetsAppend(token, 'FT_Purchases!A:I', [[
      studentName,
      studentEmail,
      parentEmail,
      sessionId,
      tripId,
      purchaseDate,
      'active',
      '',
      ''
    ]]);
  } catch (err) {
    console.error('reg-create append error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  // Fire registration confirmation email via Intercom (best-effort).
  // We never block the registration on email failure — the row is
  // already written; a failed send just logs server-side and stamps
  // col I = FAILED so admins can see it on /admin/registrations.
  let emailStatus = 'sent';
  let emailError  = null;
  try {
    const { sendRegistrationEmail } = require('../_lib/vft-email.js');
    const sessionDateCt = formatSessionDateCt(tripDate, sessionStartTime);
    await sendRegistrationEmail({
      studentName,
      studentEmail,
      parentEmail,
      tripId,
      tripTitle,
      sessionDateCt
    });
  } catch (err) {
    emailStatus = 'failed';
    emailError  = err.message || String(err);
    console.error('reg-create email:', emailError);
  }

  // Stamp FT_Purchases col I with the outcome so admins can see it
  // in the sheet AND on /admin/registrations. Find the row we just
  // appended by composite key (student_email + trip_id + session_id),
  // which we know is unique among active rows (enforced above).
  // Wrapped in try/catch — a stamping failure should never bubble
  // up as a registration failure.
  try {
    const sheet = await batchGet(token, ['FT_Purchases!A:I']);
    const rows = (sheet && sheet.valueRanges && sheet.valueRanges[0] && sheet.valueRanges[0].values) || [];
    let appendedRowNum = -1;
    for (let i = rows.length - 1; i >= 1; i--) {
      const r = rows[i];
      if ((r[1] || '').toString().toLowerCase().trim() === studentEmail &&
          (r[3] || '').toString().trim() === sessionId &&
          (r[4] || '').toString().trim() === tripId) {
        appendedRowNum = i + 1;
        break;
      }
    }
    if (appendedRowNum > 0) {
      const stamp = (emailStatus === 'sent') ? 'Yes' : 'FAILED';
      await sheetsUpdate(token, `FT_Purchases!I${appendedRowNum}`, [[stamp]]);
    }
  } catch (err) {
    console.error('reg-create email_sent stamp error:', err.message);
  }

  return res.status(200).json({ ok: true, email_status: emailStatus, email_error: emailError });
}

// Format a trip date ("2026-05-21") + session start time ("1:00 PM" or
// "13:00") into a human-readable string in America/Chicago — e.g.
// "Thu, May 21 at 1:00 PM CT". Used by the registration confirmation
// email. Falls back gracefully when fields are missing or malformed.
function formatSessionDateCt(tripDate, startTime) {
  const TZ = 'America/Chicago';

  function normalizeTime(s) {
    if (!s) return '';
    const t = String(s).trim();
    const m12 = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (m12) {
      const hh = parseInt(m12[1], 10);
      const mm = m12[2];
      const ap = m12[3].toUpperCase();
      return `${hh}:${mm} ${ap}`;
    }
    const m24 = t.match(/^(\d{1,2}):(\d{2})$/);
    if (m24) {
      let hh = parseInt(m24[1], 10);
      const mm = m24[2];
      const ap = hh >= 12 ? 'PM' : 'AM';
      hh = hh % 12; if (hh === 0) hh = 12;
      return `${hh}:${mm} ${ap}`;
    }
    return t;
  }

  const timeDisplay = normalizeTime(startTime);
  const dm = String(tripDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dm) {
    return timeDisplay ? `${timeDisplay} CT` : '';
  }
  const y = parseInt(dm[1], 10);
  const m = parseInt(dm[2], 10);
  const d = parseInt(dm[3], 10);

  const utcMs = Date.UTC(y, m - 1, d, 12, 0, 0);
  let datePart;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      weekday:  'short',
      month:    'short',
      day:      'numeric'
    });
    datePart = fmt.format(new Date(utcMs));
  } catch (_) {
    datePart = `${m}/${d}`;
  }

  return timeDisplay ? `${datePart} at ${timeDisplay} CT` : `${datePart} CT`;
}

// ── handleRegUpdate: edit an existing registration in place ──
// Identified by ORIGINAL composite key (email + trip + session) so
// any of those three fields can be edited.
async function handleRegUpdate(req, res) {
  if (req.method !== 'POST' && req.method !== 'PUT') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const orig = {
    student_email: (body.original_student_email || '').toString().toLowerCase().trim(),
    trip_id:       (body.original_trip_id       || '').toString().trim(),
    session_id:    (body.original_session_id    || '').toString().trim()
  };
  if (!orig.student_email || !orig.trip_id || !orig.session_id) {
    return res.status(400).json({ error: 'bad_request', detail: 'original key required' });
  }

  const updated = {
    student_name:  (body.student_name  || '').toString().trim(),
    student_email: (body.student_email || '').toString().toLowerCase().trim(),
    parent_email:  (body.parent_email  || '').toString().toLowerCase().trim(),
    trip_id:       (body.trip_id       || '').toString().trim(),
    session_id:    (body.session_id    || '').toString().trim(),
    purchase_date: (body.purchase_date || '').toString().trim()
  };
  if (!updated.student_name || !updated.student_email || !updated.trip_id || !updated.session_id) {
    return res.status(400).json({ error: 'bad_request', detail: 'name, email, trip, session required' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(updated.student_email)) {
    return res.status(400).json({ error: 'bad_email', field: 'student_email' });
  }
  if (updated.parent_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(updated.parent_email)) {
    return res.status(400).json({ error: 'bad_email', field: 'parent_email' });
  }

  let token;
  try { token = await getAccessToken('https://www.googleapis.com/auth/spreadsheets'); }
  catch (err) {
    console.error('reg-update token error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  // Validate the new trip/session and find the row to update
  let rowNum = -1, currentRow = null;
  let purchaseRows;
  try {
    const sheet = await batchGet(token, ['FT_Catalog!A:A', 'FT_Sessions!A:B', 'FT_Purchases!A:I']);
    const ranges = (sheet && sheet.valueRanges) || [];
    const catalogRows = (ranges[0] && ranges[0].values) || [];
    const sessionRows = (ranges[1] && ranges[1].values) || [];
    purchaseRows      = (ranges[2] && ranges[2].values) || [];

    let tripExists = false;
    for (let i = 1; i < catalogRows.length; i++) {
      if ((catalogRows[i][0] || '').toString().trim() === updated.trip_id) { tripExists = true; break; }
    }
    if (!tripExists) return res.status(400).json({ error: 'unknown_trip' });

    let sessionMatch = false;
    for (let i = 1; i < sessionRows.length; i++) {
      const r = sessionRows[i];
      if ((r[0] || '').toString().trim() === updated.session_id &&
          (r[1] || '').toString().trim() === updated.trip_id) { sessionMatch = true; break; }
    }
    if (!sessionMatch) return res.status(400).json({ error: 'unknown_session' });

    for (let i = 1; i < purchaseRows.length; i++) {
      const r = purchaseRows[i];
      if ((r[1] || '').toString().toLowerCase().trim() === orig.student_email &&
          (r[3] || '').toString().trim() === orig.session_id &&
          (r[4] || '').toString().trim() === orig.trip_id) {
        rowNum     = i + 1;
        currentRow = r;
        break;
      }
    }
    if (rowNum < 0) return res.status(404).json({ error: 'registration_not_found' });

    // If the composite key changed, make sure we don't collide with another active row
    const keyChanged =
      updated.student_email !== orig.student_email ||
      updated.trip_id       !== orig.trip_id       ||
      updated.session_id    !== orig.session_id;
    if (keyChanged) {
      for (let i = 1; i < purchaseRows.length; i++) {
        if (i + 1 === rowNum) continue;
        const r = purchaseRows[i];
        const status = (r[6] || '').toString().toLowerCase().trim();
        if (status && status !== 'active') continue;
        if ((r[1] || '').toString().toLowerCase().trim() === updated.student_email &&
            (r[3] || '').toString().trim() === updated.session_id &&
            (r[4] || '').toString().trim() === updated.trip_id) {
          return res.status(409).json({ error: 'already_registered' });
        }
      }
    }
  } catch (err) {
    console.error('reg-update validate error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  // Preserve the existing values for status/attended/email_sent (cols G/H/I)
  const status     = (currentRow[6] || 'active').toString();
  const attended   = (currentRow[7] || '').toString();
  const emailSent  = (currentRow[8] || '').toString();
  const newRow = [
    updated.student_name,
    updated.student_email,
    updated.parent_email,
    updated.session_id,
    updated.trip_id,
    updated.purchase_date,
    status,
    attended,
    emailSent
  ];

  try {
    await sheetsUpdate(token, `FT_Purchases!A${rowNum}:I${rowNum}`, [newRow]);
  } catch (err) {
    console.error('reg-update write error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }
  return res.status(200).json({ ok: true });
}

// ── handleRegCancel: soft-delete a registration ────────────
// Sets FT_Purchases column G to "cancelled". Row stays in the
// sheet so we keep a record, but it disappears from the admin
// table and the student's /trips home (which only shows active).
async function handleRegCancel(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const studentEmail = (body.student_email || '').toString().toLowerCase().trim();
  const tripId       = (body.trip_id       || '').toString().trim();
  const sessionId    = (body.session_id    || '').toString().trim();
  if (!studentEmail || !tripId || !sessionId) {
    return res.status(400).json({ error: 'bad_request' });
  }

  let token;
  try { token = await getAccessToken('https://www.googleapis.com/auth/spreadsheets'); }
  catch (err) {
    console.error('reg-cancel token error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  let rowNum = -1;
  try {
    const sheet = await batchGet(token, ['FT_Purchases!A:I']);
    const rows = (sheet && sheet.valueRanges && sheet.valueRanges[0] && sheet.valueRanges[0].values) || [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if ((r[1] || '').toString().toLowerCase().trim() === studentEmail &&
          (r[3] || '').toString().trim() === sessionId &&
          (r[4] || '').toString().trim() === tripId) {
        rowNum = i + 1; break;
      }
    }
  } catch (err) {
    console.error('reg-cancel read error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }
  if (rowNum < 0) return res.status(404).json({ error: 'registration_not_found' });

  try {
    await sheetsUpdate(token, `FT_Purchases!G${rowNum}`, [['cancelled']]);
  } catch (err) {
    console.error('reg-cancel write error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }
  return res.status(200).json({ ok: true });
}

// ── handleRegAttendance: cycle Pending → YES → NO → Pending ──
async function handleRegAttendance(req, res) {
  if (req.method !== 'POST' && req.method !== 'PUT') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const studentEmail = (body.student_email || '').toString().toLowerCase().trim();
  const tripId       = (body.trip_id       || '').toString().trim();
  const sessionId    = (body.session_id    || '').toString().trim();
  let   attended     = (body.attended      || '').toString().toUpperCase().trim();

  if (!studentEmail || !tripId || !sessionId) {
    return res.status(400).json({ error: 'bad_request' });
  }
  if (attended !== 'YES' && attended !== 'NO' && attended !== '') {
    return res.status(400).json({ error: 'bad_attended', detail: 'must be YES, NO, or empty' });
  }

  let token;
  try { token = await getAccessToken('https://www.googleapis.com/auth/spreadsheets'); }
  catch (err) {
    console.error('reg-attendance token error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  let rowNum = -1;
  try {
    const sheet = await batchGet(token, ['FT_Purchases!A:I']);
    const rows = (sheet && sheet.valueRanges && sheet.valueRanges[0] && sheet.valueRanges[0].values) || [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if ((r[1] || '').toString().toLowerCase().trim() === studentEmail &&
          (r[3] || '').toString().trim() === sessionId &&
          (r[4] || '').toString().trim() === tripId) {
        rowNum = i + 1; // 1-indexed for Sheets
        break;
      }
    }
  } catch (err) {
    console.error('reg-attendance read error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  if (rowNum < 0) return res.status(404).json({ error: 'registration_not_found' });

  try {
    await sheetsUpdate(token, `FT_Purchases!H${rowNum}`, [[attended]]);
  } catch (err) {
    console.error('reg-attendance write error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(200).json({ ok: true, attended });
}

// ── handleSubsList: every submission, admin-info shape ─────
async function handleSubsList(req, res) {
  let submissions = [];
  let trips = [];
  try {
    const token = await getAccessToken();
    const sheet = await batchGet(token, ['FT_Submissions!A:H', 'FT_Catalog!A:E']);
    const ranges = (sheet && sheet.valueRanges) || [];
    const subRows  = (ranges[0] && ranges[0].values) || [];
    const tripRows = (ranges[1] && ranges[1].values) || [];

    const tripsById = {};
    for (let i = 1; i < tripRows.length; i++) {
      const r  = tripRows[i];
      const id = (r[0] || '').toString().trim();
      if (!id) continue;
      tripsById[id] = { trip_id: id, title: (r[1] || '').toString(), emoji: (r[3] || '').toString() };
    }

    const seenTrips = new Set();
    for (let i = 1; i < subRows.length; i++) {
      const r = subRows[i];
      const fileUrl = (r[4] || '').toString().trim();
      if (!fileUrl) continue;
      const tripId  = (r[1] || '').toString().trim();
      const trip    = tripsById[tripId] || { trip_id: tripId, title: tripId, emoji: '' };
      if (tripId) seenTrips.add(tripId);
      submissions.push({
        student_email: (r[0] || '').toString(),
        trip_id:       tripId,
        trip_title:    trip.title,
        trip_emoji:    trip.emoji,
        name:          (r[2] || '').toString(),
        location:      (r[3] || '').toString(),
        file_url:      fileUrl,
        file_type:     ((r[5] || '').toString().toLowerCase() === 'video') ? 'video' : 'image',
        submitted_at:  (r[6] || '').toString(),
        reviewed:      ((r[7] || '').toString().toUpperCase().trim() === 'YES')
      });
    }
    submissions.sort((a, b) => (b.submitted_at || '').localeCompare(a.submitted_at || ''));
    trips = Array.from(seenTrips).map(id => tripsById[id] || { trip_id:id, title:id, emoji:'' });
    trips.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  } catch (err) {
    console.error('subs-list error:', err.message);
    submissions = []; trips = [];
  }
  return res.status(200).json({ submissions, trips });
}

// ── handleSubDelete: remove sheet row AND Supabase file ────
async function handleSubDelete(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const fileUrl = (body.file_url || '').toString().trim();
  if (!fileUrl) return res.status(400).json({ error: 'bad_request', detail: 'file_url required' });

  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('Supabase env vars missing for sub-delete');
    return res.status(500).json({ error: 'server_config_error' });
  }

  // Parse the bucket path out of the public URL.
  // Expected: {SUPABASE_URL}/storage/v1/object/public/vft-submissions/{path}
  const prefix = `${SUPABASE_URL}/storage/v1/object/public/vft-submissions/`;
  if (fileUrl.indexOf(prefix) !== 0) {
    return res.status(400).json({ error: 'bad_file_url' });
  }
  const objectPath = fileUrl.slice(prefix.length);

  // Sheets token (we'll need this regardless of storage outcome)
  let sheetsToken;
  try { sheetsToken = await getAccessToken('https://www.googleapis.com/auth/spreadsheets'); }
  catch (err) {
    console.error('sub-delete token error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  // 1. Read FT_Submissions, find the row by file_url
  let subRows;
  try {
    const sheet = await batchGet(sheetsToken, ['FT_Submissions!A:G']);
    subRows = (sheet && sheet.valueRanges && sheet.valueRanges[0] && sheet.valueRanges[0].values) || [];
  } catch (err) {
    console.error('sub-delete read error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  let foundIndex = -1;
  for (let i = 1; i < subRows.length; i++) {
    if ((subRows[i][4] || '').toString().trim() === fileUrl) { foundIndex = i; break; }
  }
  if (foundIndex < 0) return res.status(404).json({ error: 'submission_not_found' });

  // 2. Delete the Supabase object (best effort — capture but don't abort)
  let storageError = null;
  try {
    const delUrl = `${SUPABASE_URL}/storage/v1/object/vft-submissions/${objectPath}`;
    const r = await httpsRequest('DELETE', delUrl, {
      'Authorization': 'Bearer ' + SERVICE_KEY
    }, null);
    if (r.status < 200 || r.status >= 300 && r.status !== 404) {
      // 404 is fine — file was already gone
      storageError = `supabase ${r.status}: ${r.body}`;
      console.error('sub-delete storage error:', storageError);
    }
  } catch (err) {
    storageError = err.message;
    console.error('sub-delete storage exception:', storageError);
  }

  // 3. Remove the sheet row (rebuild content without that row, clear + update)
  try {
    const header = subRows[0] || ['student_email','trip_id','student_name','location','file_url','file_type','submitted_at'];
    const remaining = subRows.slice(1).filter((_, idx) => idx !== (foundIndex - 1));
    const newContent = [header].concat(remaining);
    await sheetsClear(sheetsToken,  'FT_Submissions!A:G');
    await sheetsUpdate(sheetsToken, 'FT_Submissions!A1', newContent);
  } catch (err) {
    console.error('sub-delete sheet write error:', err.message);
    return res.status(500).json({
      error: 'sheet_delete_failed',
      storage_error: storageError,
      detail: 'File may have been deleted from storage but sheet row could not be removed.'
    });
  }

  if (storageError) {
    // Sheet row gone, but file delete had trouble
    return res.status(207).json({
      ok: false,
      sheet_deleted: true,
      storage_error: storageError,
      detail: 'Sheet row deleted, but the file in Supabase storage may still be there. Check Storage and remove manually if needed.'
    });
  }

  return res.status(200).json({ ok: true });
}

// ── handlePrepUploadUrl: mint a signed Supabase upload URL for a
// prep-materials file (videos, 360 videos, PDFs). Admin-only — auth
// is enforced by the dispatcher at the top of this file, no per-row
// purchase check needed (unlike student-side submissions/upload-url.js).
//
// Bucket: ft-prep (admin creates in Supabase dashboard with public read
//   + ~500MB file size limit + service-key writes).
// Allowed extensions: video (mp4/webm/mov/m4v/ogv), PDF, image fallback.
// Size cap: 500 MB enforced client-side; server reports the cap so the
//   admin UI can validate before initiating the upload.
//
// Body (JSON): { trip_id, filename, content_length? }
// Response (200): { upload_url, public_url, path, max_bytes }
async function handlePrepUploadUrl(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const BUCKET      = 'ft-prep';
  const MAX_BYTES   = 50 * 1024 * 1024;         // 50 MB — matches Supabase
                                                //   global file-size limit
                                                //   under the default Pro
                                                //   spend cap. Raise here
                                                //   AND in Supabase if you
                                                //   ever turn off the cap.
  const ALLOWED_EXT = ['mp4', 'webm', 'mov', 'm4v', 'ogv', 'pdf', 'jpg', 'jpeg', 'png'];

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const tripId       = (body.trip_id  || '').toString().trim();
  const filenameRaw  = (body.filename || '').toString().trim();
  const contentLength = parseInt(body.content_length, 10);

  if (!tripId)      return res.status(400).json({ error: 'bad_request', detail: 'trip_id required' });
  if (!filenameRaw) return res.status(400).json({ error: 'bad_request', detail: 'filename required' });

  const ext = (filenameRaw.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
  if (ALLOWED_EXT.indexOf(ext) === -1) {
    return res.status(400).json({ error: 'bad_extension', detail: 'allowed: ' + ALLOWED_EXT.join(', ') });
  }
  if (!isNaN(contentLength) && contentLength > MAX_BYTES) {
    return res.status(400).json({ error: 'file_too_large', detail: 'max ' + MAX_BYTES + ' bytes', max_bytes: MAX_BYTES });
  }

  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('Supabase env vars missing for prep-upload-url');
    return res.status(500).json({ error: 'server_config_error' });
  }

  // Sanitize filename and build path: {trip_id}/{ISO}-{rand}-{safe_filename}
  const safeName = (filenameRaw.split(/[\\/]/).pop() || 'upload')
    .replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'upload';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rand  = crypto.randomBytes(3).toString('hex');
  const path  = `${tripId}/${stamp}-${rand}-${safeName}`;

  // Mint signed upload URL from Supabase Storage.
  const signEndpoint = `${SUPABASE_URL}/storage/v1/object/upload/sign/${BUCKET}/${path}`;
  let signRes;
  try {
    signRes = await httpsRequest('POST', signEndpoint, {
      'Authorization': 'Bearer ' + SERVICE_KEY,
      'Content-Type':  'application/json'
    }, '{}');
  } catch (err) {
    console.error('prep-upload-url supabase request failed:', err.message);
    return res.status(502).json({ error: 'upstream_error' });
  }
  if (signRes.status < 200 || signRes.status >= 300) {
    console.error('prep-upload-url supabase returned', signRes.status, signRes.body);
    return res.status(502).json({ error: 'upstream_error', detail: signRes.body });
  }

  let signed;
  try { signed = JSON.parse(signRes.body || '{}'); }
  catch (e) {
    console.error('prep-upload-url supabase non-JSON:', signRes.body);
    return res.status(502).json({ error: 'upstream_error' });
  }

  // Supabase API has shifted shapes over the years — try them all.
  let uploadUrl = '';
  if (signed.signedUrl) {
    uploadUrl = signed.signedUrl.startsWith('http')
      ? signed.signedUrl
      : `${SUPABASE_URL}/storage/v1${signed.signedUrl}`;
  } else if (signed.url) {
    uploadUrl = signed.url.startsWith('http')
      ? signed.url
      : `${SUPABASE_URL}/storage/v1${signed.url}`;
  } else if (signed.token) {
    uploadUrl = `${SUPABASE_URL}/storage/v1/object/upload/sign/${BUCKET}/${path}?token=${encodeURIComponent(signed.token)}`;
  } else {
    console.error('prep-upload-url supabase missing url/token:', signed);
    return res.status(502).json({ error: 'upstream_error' });
  }

  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;

  return res.status(200).json({
    upload_url: uploadUrl,
    public_url: publicUrl,
    path:       path,
    max_bytes:  MAX_BYTES
  });
}

// ── Admin access list / add / remove ───────────────────────
const ALLOWED_ADMIN_DOMAINS = ['2hourlearning.com', 'alpha.school'];
function isAllowedDomainEmail(email) {
  const m = String(email || '').toLowerCase().match(/^[^@\s]+@([^@\s]+\.[^@\s]+)$/);
  if (!m) return false;
  return ALLOWED_ADMIN_DOMAINS.indexOf(m[1]) !== -1;
}

async function handleAdminsList(req, res) {
  let admins = [];
  try {
    const token = await getAccessToken();
    const sheet = await batchGet(token, ['FT_Admins!A:A']);
    const rows = (sheet && sheet.valueRanges && sheet.valueRanges[0] && sheet.valueRanges[0].values) || [];
    for (let i = 1; i < rows.length; i++) {
      const e = (rows[i][0] || '').toString().toLowerCase().trim();
      if (e) admins.push(e);
    }
    // Dedupe + sort
    admins = Array.from(new Set(admins)).sort();
  } catch (err) {
    console.error('admins-list error:', err.message);
    admins = [];
  }
  return res.status(200).json({ admins });
}

async function handleAdminAdd(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const email = (body.email || '').toString().toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'bad_request', detail: 'email required' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'bad_email' });
  }
  if (!isAllowedDomainEmail(email)) {
    return res.status(400).json({ error: 'bad_domain', detail: 'email must be @2hourlearning.com or @alpha.school' });
  }

  let token;
  try { token = await getAccessToken('https://www.googleapis.com/auth/spreadsheets'); }
  catch (err) {
    console.error('admin-add token error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  // Check for duplicate
  try {
    const sheet = await batchGet(token, ['FT_Admins!A:A']);
    const rows = (sheet && sheet.valueRanges && sheet.valueRanges[0] && sheet.valueRanges[0].values) || [];
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i][0] || '').toString().toLowerCase().trim() === email) {
        return res.status(409).json({ error: 'already_admin' });
      }
    }
  } catch (err) {
    console.error('admin-add read error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  try {
    await sheetsAppend(token, 'FT_Admins!A:A', [[email]]);
  } catch (err) {
    console.error('admin-add write error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }
  return res.status(200).json({ ok: true });
}

async function handleAdminRemove(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const email = (body.email || '').toString().toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'bad_request', detail: 'email required' });

  let token;
  try { token = await getAccessToken('https://www.googleapis.com/auth/spreadsheets'); }
  catch (err) {
    console.error('admin-remove token error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  let rows;
  try {
    const sheet = await batchGet(token, ['FT_Admins!A:A']);
    rows = (sheet && sheet.valueRanges && sheet.valueRanges[0] && sheet.valueRanges[0].values) || [];
  } catch (err) {
    console.error('admin-remove read error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  const header = rows[0] || ['email'];
  const remaining = rows.slice(1).filter(r => (r[0] || '').toString().toLowerCase().trim() !== email);
  if (remaining.length === rows.length - 1) {
    return res.status(404).json({ error: 'not_found' });
  }

  try {
    await sheetsClear(token,  'FT_Admins!A:A');
    await sheetsUpdate(token, 'FT_Admins!A1', [header].concat(remaining));
  } catch (err) {
    console.error('admin-remove write error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }
  return res.status(200).json({ ok: true });
}

// ── LUL shared helpers (Phase 2a + 2b) ─────────────────────

function generateToken() {
  // 16 hex chars (8 random bytes), URL-safe, plenty of uniqueness for our scale
  return crypto.randomBytes(8).toString('hex');
}

function isYesish(v) {
  if (v === true)  return true;
  if (v === false) return false;
  const s = String(v == null ? '' : v).trim().toUpperCase();
  return s === 'YES' || s === 'TRUE';
}

function todayYMD() {
  return new Date().toISOString().slice(0, 10);
}

function chicagoYMD() {
  // YYYY-MM-DD in CT — used for human-readable Notes timestamps
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(new Date());
}

// Returns ms by which America/Chicago is ahead of UTC at the given instant.
// (Same trick used by get-sessions.js — handles DST automatically.)
function chicagoTzOffsetMs(utcMs) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = fmt.formatToParts(new Date(utcMs));
  const g = (t) => {
    const p = parts.find(x => x.type === t);
    return p ? parseInt(p.value, 10) : 0;
  };
  let h = g('hour'); if (h === 24) h = 0;
  const fakeUtc = Date.UTC(g('year'), g('month') - 1, g('day'), h, g('minute'), g('second'));
  return fakeUtc - utcMs;
}

// UTC ms of Monday 00:00:00 in Chicago for the week N weeks back.
// weeksBack=0 → Monday of this week; weeksBack=1 → last Monday.
function weekStartMs(weeksBack) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
  });
  const parts = fmt.formatToParts(new Date());
  const g = (t) => parts.find(p => p.type === t).value;
  const Y = parseInt(g('year'), 10);
  const M = parseInt(g('month'), 10);
  const D = parseInt(g('day'), 10);
  const dayMap = { SUN:0, MON:1, TUE:2, WED:3, THU:4, FRI:5, SAT:6 };
  const dow = dayMap[g('weekday').toUpperCase()];
  const daysFromMonday = (dow + 6) % 7; // 0=Mon..6=Sun
  const naive = Date.UTC(Y, M - 1, D - daysFromMonday - 7 * weeksBack, 0, 0, 0);
  return naive - chicagoTzOffsetMs(naive);
}

function parseSheetDateMs(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  }
  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = parseFloat(s);
    return Date.UTC(1899, 11, 30) + serial * 86400000;
  }
  const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m1) return Date.UTC(+m1[3], +m1[1] - 1, +m1[2]);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.getTime();
}

// ── LUL Sessions admin (Phase 2a) ───────────────────────────
//
// Sessions tab schema (used by api/get-sessions.js too):
//   A Name | B Emoji | C Coach | D Day | E Time | F Description
//   G Link (Zoom URL) | H Session ID (slug) | I Active (YES/NO)
//   J Blackout Start  | K Blackout End
//
// Admin sees ALL rows including inactive ones. The Active toggle
// flips col I; get-sessions.js will then hide it from students.

const VALID_DAYS = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

// Sheets returns dates in whatever format the cell uses (e.g.
// "5/25/2026", or a serial number like 46172, or already
// "2026-05-25" for text-formatted cells). Normalize to YYYY-MM-DD
// so HTML <input type="date"> can populate from it.
function toYMD(val) {
  if (val === null || val === undefined) return '';
  const s = String(val).trim();
  if (!s) return '';

  // Already YYYY-MM-DD?
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // Serial number (days since 1899-12-30)?
  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = parseFloat(s);
    const ms = Date.UTC(1899, 11, 30) + serial * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }

  // M/D/YYYY or MM/DD/YYYY (US format Sheets often returns)?
  const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m1) {
    const mm = String(m1[1]).padStart(2, '0');
    const dd = String(m1[2]).padStart(2, '0');
    return `${m1[3]}-${mm}-${dd}`;
  }

  // Last-resort Date parse — emit UTC date components to avoid TZ drift
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

async function handleLoungeSessionsList(req, res) {
  let rows;
  try {
    const token = await getAccessToken();
    const sheet = await batchGet(token, ['Sessions!A:K']);
    rows = (sheet && sheet.valueRanges && sheet.valueRanges[0] && sheet.valueRanges[0].values) || [];
  } catch (err) {
    console.error('lounge-sessions-list error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  const sessions = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    sessions.push({
      row_index:      i + 1, // 1-based for sheets ranges
      name:           (r[0]  || '').toString(),
      emoji:          (r[1]  || '').toString(),
      coach:          (r[2]  || '').toString(),
      day:            (r[3]  || '').toString(),
      time:           (r[4]  || '').toString(),
      description:    (r[5]  || '').toString(),
      link:           (r[6]  || '').toString(),
      session_id:     (r[7]  || '').toString(),
      active:         ((r[8] || 'YES').toString().toUpperCase() !== 'NO'),
      blackout_start: toYMD(r[9]),
      blackout_end:   toYMD(r[10])
    });
  }
  return res.status(200).json({ sessions });
}

async function handleLoungeSessionSave(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const name = (body.name || '').toString().trim();
  const day  = (body.day  || '').toString().trim().toUpperCase();
  const time = (body.time || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'bad_request', detail: 'name required' });
  if (VALID_DAYS.indexOf(day) === -1) return res.status(400).json({ error: 'bad_request', detail: 'day must be SUN-SAT' });
  if (!time) return res.status(400).json({ error: 'bad_request', detail: 'time required' });

  const incoming = {
    name,
    emoji:          (body.emoji || '').toString(),
    coach:          (body.coach || '').toString(),
    day,
    time,
    description:    (body.description || '').toString(),
    link:           (body.link || '').toString(),
    session_id:     (body.session_id || '').toString().trim(),
    active:         (body.active === false || String(body.active).toUpperCase() === 'NO') ? 'NO' : 'YES',
    blackout_start: (body.blackout_start || '').toString().trim(),
    blackout_end:   (body.blackout_end   || '').toString().trim()
  };

  let token;
  try { token = await getAccessToken('https://www.googleapis.com/auth/spreadsheets'); }
  catch (err) {
    console.error('lounge-session-save token error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  let rows;
  try {
    const sheet = await batchGet(token, ['Sessions!A:K']);
    rows = (sheet && sheet.valueRanges && sheet.valueRanges[0] && sheet.valueRanges[0].values) || [];
  } catch (err) {
    console.error('lounge-session-save read error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  // Resolve session_id: keep existing for edit; generate unique slug for new
  const existingIds = new Set();
  let existingRowIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    const id = (rows[i][7] || '').toString().trim();
    if (id) existingIds.add(id);
  }
  let sid = incoming.session_id;
  if (sid) {
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i][7] || '').toString().trim() === sid) {
        existingRowIndex = i; break;
      }
    }
    if (existingRowIndex === -1) {
      // session_id supplied but no row matches — refuse rather than silently create
      return res.status(404).json({ error: 'not_found' });
    }
  } else {
    // Generate a unique slug from the name
    const base = slugify(name);
    let candidate = base;
    let n = 2;
    while (existingIds.has(candidate)) candidate = `${base}-${n++}`;
    sid = candidate;
  }

  const row = [
    incoming.name,
    incoming.emoji,
    incoming.coach,
    incoming.day,
    incoming.time,
    incoming.description,
    incoming.link,
    sid,
    incoming.active,
    incoming.blackout_start,
    incoming.blackout_end
  ];

  try {
    if (existingRowIndex >= 0) {
      const rowNum = existingRowIndex + 1; // 1-indexed
      await sheetsUpdate(token, `Sessions!A${rowNum}:K${rowNum}`, [row]);
    } else {
      await sheetsAppend(token, 'Sessions!A:K', [row]);
    }
  } catch (err) {
    console.error('lounge-session-save write error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(200).json({ ok: true, session_id: sid, created: existingRowIndex < 0 });
}

// ── LUL Pass Types config (Phase 2b) ────────────────────────
//
// LUL_Pass_Types tab schema:
//   A Experience Type | B Mode | C Pick Count | D Description | E Active
//
// Mode is one of: 'pick' (pick N sessions), 'celebration' (single
// Friday slot), 'full' (all weekly sessions auto-locked, no picker).

const VALID_PASS_MODES = ['pick', 'celebration', 'full'];

async function readPassTypes(token) {
  const sheet = await batchGet(token, ['LUL_Pass_Types!A:E']);
  const rows = (sheet && sheet.valueRanges && sheet.valueRanges[0] && sheet.valueRanges[0].values) || [];
  const types = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    const expType  = (r[0] || '').toString().trim();
    const mode     = ((r[1] || 'pick').toString().toLowerCase().trim()) || 'pick';
    const pickRaw  = (r[2] == null ? '' : r[2]).toString().trim();
    const pickCnt  = pickRaw && /^\d+$/.test(pickRaw) ? parseInt(pickRaw, 10) : null;
    const descr    = (r[3] || '').toString();
    const active   = isYesish(r[4] == null || r[4] === '' ? 'YES' : r[4]);
    types.push({
      row_index:   i + 1,
      exp_type:    expType,
      mode:        mode,
      pick_count:  pickCnt,
      description: descr,
      active:      active
    });
  }
  return types;
}

// Resolve mode for a given Experience Type, with legacy-string fallback
// (matches Apps Script's hardcoded detection so old sheet rows still work
// even if the LUL_Pass_Types tab is empty or missing the entry).
function modeForType(types, expType) {
  const t = (expType || '').toString();
  const tLower = t.toLowerCase();
  const cfg = (types || []).find(x => (x.exp_type || '').toLowerCase() === tLower);
  if (cfg) return { mode: cfg.mode, pick_count: cfg.pick_count };
  if (tLower.includes('friday coaching celebration')) return { mode: 'celebration', pick_count: 1 };
  if (tLower.includes('2 sessions'))                  return { mode: 'pick',        pick_count: 2 };
  return { mode: 'full', pick_count: null };
}

async function handleLoungePassTypesList(req, res) {
  let types;
  try {
    const token = await getAccessToken();
    types = await readPassTypes(token);
  } catch (err) {
    console.error('lounge-pass-types-list:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }
  return res.status(200).json({ types });
}

async function handleLoungePassTypeSave(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const expType  = (body.exp_type || '').toString().trim();
  const mode     = (body.mode || '').toString().toLowerCase().trim();
  const pickRaw  = (body.pick_count == null ? '' : body.pick_count).toString().trim();
  const pickCnt  = pickRaw && /^\d+$/.test(pickRaw) ? parseInt(pickRaw, 10) : null;
  const descr    = (body.description || '').toString();
  const active   = (body.active === false || String(body.active).toUpperCase() === 'NO') ? 'NO' : 'YES';
  const original = (body.original_exp_type || '').toString().trim() || expType;

  if (!expType) return res.status(400).json({ error: 'bad_request', detail: 'exp_type required' });
  if (VALID_PASS_MODES.indexOf(mode) === -1) {
    return res.status(400).json({ error: 'bad_request', detail: 'mode must be pick / celebration / full' });
  }
  if (mode === 'pick' && (!pickCnt || pickCnt < 1)) {
    return res.status(400).json({ error: 'bad_request', detail: 'pick mode requires pick_count >= 1' });
  }

  let token, rows;
  try {
    token = await getAccessToken('https://www.googleapis.com/auth/spreadsheets');
    const sheet = await batchGet(token, ['LUL_Pass_Types!A:E']);
    rows = (sheet && sheet.valueRanges && sheet.valueRanges[0] && sheet.valueRanges[0].values) || [];
  } catch (err) {
    console.error('lounge-pass-type-save read:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  let existingRow = -1;
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][0] || '').toString().trim().toLowerCase() === original.toLowerCase()) {
      existingRow = i; break;
    }
  }
  // Detect collision if creating or renaming
  for (let i = 1; i < rows.length; i++) {
    if (i === existingRow) continue;
    if ((rows[i][0] || '').toString().trim().toLowerCase() === expType.toLowerCase()) {
      return res.status(409).json({ error: 'duplicate_exp_type' });
    }
  }

  const row = [
    expType,
    mode,
    pickCnt == null ? '' : String(pickCnt),
    descr,
    active
  ];

  try {
    if (existingRow >= 0) {
      const rowNum = existingRow + 1;
      await sheetsUpdate(token, `LUL_Pass_Types!A${rowNum}:E${rowNum}`, [row]);
    } else {
      await sheetsAppend(token, 'LUL_Pass_Types!A:E', [row]);
    }
  } catch (err) {
    console.error('lounge-pass-type-save write:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(200).json({ ok: true, exp_type: expType, created: existingRow < 0 });
}

// ── LUL Pass Holders admin (Phase 2b) ───────────────────────
//
// Sheet1 schema (from existing Apps Script):
//   A Experience Type | B Name | C Email | D Parent Email
//   E Email Sent | F Fulfilled | G Token | H Active? (checkbox)
//   I Date Sent | J Selections Locked | K Selected Sessions
//   L Date Locked | M Date First Clicked | N Notes
//
// Status computation:
//   - Active=NO              → cancelled
//   - Active=YES, Locked=NO  → active   (issued, no selections yet)
//   - Active=YES, Locked=YES, attendance < required → locked-in
//   - Active=YES, Locked=YES, attendance >= required → used (attended all)
//
// "Attended" = unique session_ids in LUL_Attendance (col D) for the
// student's email (col B) that match one of the student's selected
// session ids (Sheet1 col K), with the click attributed to THIS pass.
//
// Attribution rule (primary → fallback):
//   1. PRIMARY: LUL_Attendance col G (token) === pass token. track-join.js
//      stamps the pass token on every click row, so a click that came
//      through THIS pass's email link is definitively this pass's click.
//      This solves the overlap case where a student picks the same
//      session on two active passes (e.g. Friday Celebration as one of
//      their 2-session picks + a separate Friday Celebration pass) —
//      the click only consumes the pass whose link they actually used.
//   2. FALLBACK: when col G is blank (legacy rows from before the token
//      was logged), count the click if its timestamp falls in this pass's
//      30-day window. Same logic that fixed the Elsie prior-pass-rollover
//      bug on 2026-05-19.

async function readSheet1(token) {
  const sheet = await batchGet(token, ['Sheet1!A:O']);
  return (sheet && sheet.valueRanges && sheet.valueRanges[0] && sheet.valueRanges[0].values) || [];
}

async function readAttendance(token) {
  const sheet = await batchGet(token, ['LUL_Attendance!A:H']);
  return (sheet && sheet.valueRanges && sheet.valueRanges[0] && sheet.valueRanges[0].values) || [];
}

async function findRowByToken(token, passToken) {
  const rows = await readSheet1(token);
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][6] || '').toString().trim() === passToken) {
      return { row: rows[i], rowIndex: i, allRows: rows };
    }
  }
  return { row: null, rowIndex: -1, allRows: rows };
}

function computePassStatus(pass, types, attendanceByEmail) {
  if (!pass.active) return { status: 'cancelled', days_left: null };

  let daysLeft = null;
  if (pass.date_sent_ms != null) {
    const expiresMs = pass.date_sent_ms + 30 * 86400000;
    daysLeft = Math.ceil((expiresMs - Date.now()) / 86400000);
  }

  // Manual override: if admin marked the pass as fulfilled, show Used.
  // Mirrors the "Netflix model" — a paid pass counts as used at expiry / when admin says.
  if ((pass.fulfilled || '').toString().trim().toLowerCase() === 'yes') {
    return { status: 'used', days_left: daysLeft };
  }

  if (!pass.selections_locked) return { status: 'active', days_left: daysLeft };

  const cfg = modeForType(types, pass.exp_type);
  const required = cfg.pick_count != null
    ? cfg.pick_count
    : (pass.selected_session_ids.length || 1);

  const emailKey   = (pass.email || '').toLowerCase();
  const passToken  = (pass.token || '').toString().trim();
  const passSentMs = pass.date_sent_ms;
  const passEndMs  = passSentMs != null ? passSentMs + 30 * 86400000 : null;
  const attended = (attendanceByEmail[emailKey] || []).filter(rec => {
    if (pass.selected_session_ids.indexOf(rec.sid) < 0) return false;
    // PRIMARY: prefer the token attribution when available. If the click
    // row has a token (col G), it MUST match this pass to count. This
    // prevents a click from one pass spilling into another pass's status
    // even when both passes have the same session in their selections.
    if (rec.token) {
      return passToken && rec.token === passToken;
    }
    // FALLBACK: legacy rows without a token. Only count if the click is
    // inside this pass's 30-day window.
    if (passSentMs != null && rec.clicked_at_ms != null) {
      return rec.clicked_at_ms >= passSentMs && rec.clicked_at_ms < passEndMs;
    }
    // Both pieces of metadata missing — count it (avoid under-marking).
    return true;
  });
  const attendedUnique = Array.from(new Set(attended.map(rec => rec.sid)));

  if (attendedUnique.length >= required) return { status: 'used',     days_left: daysLeft };
  return                                          { status: 'locked-in', days_left: daysLeft };
}

async function handleLoungePassesList(req, res) {
  let token, sheet1Rows, attendanceRows, types, sessionsBatch;
  try {
    token = await getAccessToken();
    [sheet1Rows, attendanceRows, types, sessionsBatch] = await Promise.all([
      readSheet1(token),
      readAttendance(token),
      readPassTypes(token),
      // Sessions tab: A=name, B=emoji, C=coach, D=day, E=time, F=desc, G=zoom, H=id.
      // Used to resolve session_id → human-readable label for each pass's picks.
      batchGet(token, ['Sessions!A:K'])
    ]);
  } catch (err) {
    console.error('lounge-passes-list:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  // sessionsById[id] = { id, name, emoji, day, time }
  const sessionsById = {};
  const sessRows = (sessionsBatch && sessionsBatch.valueRanges && sessionsBatch.valueRanges[0] && sessionsBatch.valueRanges[0].values) || [];
  for (let i = 1; i < sessRows.length; i++) {
    const r  = sessRows[i] || [];
    const id = (r[7] || '').toString().trim();
    if (!id) continue;
    sessionsById[id] = {
      id:    id,
      name:  (r[0] || '').toString(),
      emoji: (r[1] || '').toString(),
      day:   (r[3] || '').toString(),
      time:  (r[4] || '').toString()
    };
  }

  // attendanceByEmail[email] = [{ sid, clicked_at_ms, token }, ...]
  // - token (LUL_Attendance col G) is the pass the click came through.
  //   It's the primary signal computePassStatus uses to attribute a
  //   click to a specific pass — solves the "student picks the same
  //   session on two passes" overlap case.
  // - clicked_at_ms is the fallback for legacy rows where col G is
  //   empty: filter by "click happened in the pass's date window."
  const attendanceByEmail = {};
  for (let i = 1; i < attendanceRows.length; i++) {
    const r = attendanceRows[i] || [];
    const clickedAtIso = (r[0] || '').toString().trim();
    const emailKey     = (r[1] || '').toString().toLowerCase().trim();
    const sid          = (r[3] || '').toString().trim();
    const clickToken   = (r[6] || '').toString().trim();   // col G — pass token
    if (!emailKey || !sid) continue;
    const ms = clickedAtIso ? new Date(clickedAtIso).getTime() : NaN;
    (attendanceByEmail[emailKey] = attendanceByEmail[emailKey] || []).push({
      sid:           sid,
      clicked_at_ms: isNaN(ms) ? null : ms,
      token:         clickToken
    });
  }

  const passes = [];
  for (let i = 1; i < sheet1Rows.length; i++) {
    const r = sheet1Rows[i] || [];
    const expType    = (r[0] || '').toString().trim();
    const name       = (r[1] || '').toString().trim();
    const email      = (r[2] || '').toString().trim();
    if (!expType && !name && !email) continue;

    const dateSentRaw = (r[8] || '').toString();
    const selected    = (r[10] || '').toString().trim();
    const selectedIds = selected ? selected.split(/[,\s]+/).map(s => s.trim()).filter(Boolean) : [];

    // Joined session objects for the picks this pass has saved. If a saved id
    // doesn't match a current session (renamed/deleted), keep the id as the
    // name so the admin sees something rather than a blank row.
    const selectedSessions = selectedIds.map(function(sid){
      const s = sessionsById[sid];
      return s ? { id: sid, name: s.name, emoji: s.emoji, day: s.day, time: s.time }
               : { id: sid, name: sid, emoji: '', day: '', time: '' };
    });

    const pass = {
      row_index:           i + 1,
      exp_type:            expType,
      name:                name,
      email:               email,
      parent_email:        (r[3] || '').toString().trim(),
      email_sent:          (r[4] || '').toString().trim(),
      fulfilled:           (r[5] || '').toString().trim(),
      token:               (r[6] || '').toString().trim(),
      active:              isYesish(r[7]),
      date_sent:           toYMD(dateSentRaw),
      date_sent_ms:        parseSheetDateMs(dateSentRaw),
      selections_locked:   isYesish(r[9]),
      selected_session_ids: selectedIds,
      selected_sessions:   selectedSessions,    // joined view of the picks
      date_locked:         toYMD(r[11]),
      first_clicked:       toYMD(r[12]),
      notes:               (r[13] || '').toString(),
      reminder_sent:       toYMD(r[14])           // col O — stamped by cron when expiry email sent
    };

    const computed = computePassStatus(pass, types, attendanceByEmail);
    pass.status     = computed.status;
    pass.days_left  = computed.days_left;
    // Resolve the pass mode ('pick' | 'full' | 'celebration') so the UI
    // can decide whether to render the picks line — only 'pick' modes
    // have meaningful student choices to display.
    const modeCfg   = modeForType(types, pass.exp_type);
    pass.mode       = modeCfg.mode;
    pass.pick_count = modeCfg.pick_count;
    passes.push(pass);
  }

  return res.status(200).json({ passes, types });
}

async function handleLoungePassCreate(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const name        = (body.name || '').toString().trim();
  const email       = (body.email || '').toString().trim();
  const parentEmail = (body.parent_email || '').toString().trim();
  const expType     = (body.exp_type || '').toString().trim();
  const notes       = (body.notes || '').toString();

  if (!name)    return res.status(400).json({ error: 'bad_request', detail: 'name required' });
  if (!email)   return res.status(400).json({ error: 'bad_request', detail: 'email required' });
  if (!expType) return res.status(400).json({ error: 'bad_request', detail: 'exp_type required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'bad_request', detail: 'invalid email' });
  }
  if (parentEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parentEmail)) {
    return res.status(400).json({ error: 'bad_request', detail: 'invalid parent email' });
  }

  let accessToken, types, sessionsBatch;
  try {
    accessToken = await getAccessToken('https://www.googleapis.com/auth/spreadsheets');
    [types, sessionsBatch] = await Promise.all([
      readPassTypes(accessToken),
      // Need Sessions for Full Week auto-lock (collect all active session ids).
      // Small read; safe to always do.
      batchGet(accessToken, ['Sessions!A:K'])
    ]);
  } catch (err) {
    console.error('pass-create init:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  const cfg      = modeForType(types, expType);
  const newToken = generateToken();
  const today    = todayYMD();

  // ── Auto-lock for Full Week + Celebration modes ──
  // These pass types have no real "choice" — Full Week covers every
  // session, Celebration covers the single Friday session. So we skip
  // the picker ceremony and write selections at pass creation, leaving
  // the student to land on the confirmed view directly.
  //
  // For 'full': snapshot of all currently-active session ids (Sessions
  //   col I === YES). If new sessions are added later, existing Full
  //   Week passes won't auto-include them — acceptable trade-off for now;
  //   computePassStatus could later special-case 'full' to count any
  //   active session if this becomes a problem.
  // For 'celebration': hardcoded to the 'celebration' session id (the
  //   Friday Coaching Celebration row in Sessions).
  // For 'pick' (2-session): unchanged — student picks via the picker.
  let lockedFlag    = 'NO';
  let lockedSesIds  = '';
  let dateLockedVal = '';
  if (cfg.mode === 'full') {
    const sessRows = (sessionsBatch && sessionsBatch.valueRanges && sessionsBatch.valueRanges[0] && sessionsBatch.valueRanges[0].values) || [];
    const activeIds = [];
    for (let i = 1; i < sessRows.length; i++) {
      const r  = sessRows[i] || [];
      const id = (r[7] || '').toString().trim();          // col H
      const on = (r[8] || '').toString().trim().toUpperCase(); // col I
      if (id && on === 'YES') activeIds.push(id);
    }
    lockedFlag    = 'YES';
    lockedSesIds  = activeIds.join(',');
    dateLockedVal = today;
  } else if (cfg.mode === 'celebration') {
    lockedFlag    = 'YES';
    lockedSesIds  = 'celebration';
    dateLockedVal = today;
  }

  // Apps Script's onSheetEdit doesn't fire for API writes, but we still
  // mark Email Sent='Yes' so a later USER edit on a different row can't
  // make sendPendingEmails() re-send this one.
  const row = [
    expType,         // A
    name,            // B
    email,           // C
    parentEmail,     // D
    'Yes',           // E Email Sent
    'Pending',       // F Fulfilled — auto-flips to 'Yes' by track-join.js once the
                     //               student attends all picked sessions
    newToken,        // G Token
    true,            // H Active (boolean checkbox)
    today,           // I Date Sent
    lockedFlag,      // J Selections Locked
    lockedSesIds,    // K Selected Sessions
    dateLockedVal,   // L Date Locked
    '',              // M Date First Clicked
    notes            // N Notes
  ];

  try {
    await sheetsAppend(accessToken, 'Sheet1!A:N', [row]);
  } catch (err) {
    console.error('pass-create write:', err.message);
    return res.status(500).json({ error: 'server_error', detail: 'sheet write failed' });
  }

  // Send the welcome email via Intercom
  try {
    const { sendWelcomeEmail } = require('../_lib/lul-email.js');
    await sendWelcomeEmail({
      name, email, parentEmail, expType,
      mode: cfg.mode, pickCount: cfg.pick_count,
      token: newToken
    });
  } catch (err) {
    const msg = err.message || String(err);
    console.error('pass-create email:', msg);

    // Best-effort: stamp Email Sent = FAILED so admin sees it in the sheet
    // even after refresh. (We deliberately don't append to Notes — that
    // column is now reserved for admin's free-form notes.)
    try {
      const { row: foundRow, rowIndex } = await findRowByToken(accessToken, newToken);
      if (foundRow && rowIndex >= 0) {
        await sheetsUpdate(accessToken, `Sheet1!E${rowIndex + 1}`, [['FAILED']]);
      }
    } catch (_) { /* swallow secondary failure */ }

    return res.status(502).json({
      error: 'email_failed',
      detail: msg,
      token: newToken,
      hint: 'The pass row was created, but the welcome email did not send. Click Resend to retry.'
    });
  }

  return res.status(200).json({ ok: true, token: newToken });
}

async function handleLoungePassExtend(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const passToken = (body.token || '').toString().trim();
  const newExpiry = (body.new_expiry || '').toString().trim();
  if (!passToken) return res.status(400).json({ error: 'bad_request', detail: 'token required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newExpiry)) {
    return res.status(400).json({ error: 'bad_request', detail: 'new_expiry must be YYYY-MM-DD' });
  }

  // Apps Script's expireOldTokens kills passes >30 days since Date Sent.
  // To make a pass expire on `newExpiry`, set Date Sent = newExpiry − 30 days.
  const expMs   = Date.UTC(+newExpiry.slice(0, 4), +newExpiry.slice(5, 7) - 1, +newExpiry.slice(8, 10));
  const newSent = new Date(expMs - 30 * 86400000).toISOString().slice(0, 10);

  let accessToken;
  try { accessToken = await getAccessToken('https://www.googleapis.com/auth/spreadsheets'); }
  catch (err) { console.error('pass-extend token:', err.message); return res.status(500).json({ error: 'server_error' }); }

  let foundRow, rowIndex;
  try {
    const r = await findRowByToken(accessToken, passToken);
    foundRow = r.row; rowIndex = r.rowIndex;
  } catch (err) {
    console.error('pass-extend read:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!foundRow) return res.status(404).json({ error: 'not_found' });

  const rowNum = rowIndex + 1;
  try {
    // Reactivate (in case it was previously expired) AND bump Date Sent.
    // Date Sent column already records the new expiry baseline, so no
    // separate Notes-column audit line is written.
    await sheetsUpdate(accessToken, `Sheet1!H${rowNum}:I${rowNum}`, [[true, newSent]]);
  } catch (err) {
    console.error('pass-extend write:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(200).json({ ok: true, new_expiry: newExpiry, new_date_sent: newSent });
}

async function handleLoungePassResend(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const passToken = (body.token || '').toString().trim();
  if (!passToken) return res.status(400).json({ error: 'bad_request', detail: 'token required' });

  let accessToken, types;
  try {
    accessToken = await getAccessToken('https://www.googleapis.com/auth/spreadsheets');
    types = await readPassTypes(accessToken);
  } catch (err) {
    console.error('pass-resend init:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  const { row: foundRow, rowIndex } = await findRowByToken(accessToken, passToken);
  if (!foundRow) return res.status(404).json({ error: 'not_found' });

  const expType     = (foundRow[0] || '').toString().trim();
  const name        = (foundRow[1] || '').toString().trim();
  const email       = (foundRow[2] || '').toString().trim();
  const parentEmail = (foundRow[3] || '').toString().trim();
  if (!email) return res.status(400).json({ error: 'bad_request', detail: 'no email on row' });

  const cfg = modeForType(types, expType);

  try {
    const { sendWelcomeEmail } = require('../_lib/lul-email.js');
    await sendWelcomeEmail({
      name, email, parentEmail, expType,
      mode: cfg.mode, pickCount: cfg.pick_count,
      token: passToken
    });
  } catch (err) {
    console.error('pass-resend email:', err.message);
    return res.status(502).json({ error: 'email_failed', detail: err.message });
  }

  // Stamp Email Sent='Yes' (in case it was 'FAILED' or empty)
  try {
    await sheetsUpdate(accessToken, `Sheet1!E${rowIndex + 1}`, [['Yes']]);
  } catch (_) { /* secondary; ignore */ }

  return res.status(200).json({ ok: true });
}

async function handleLoungePassUpdate(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const passToken = (body.token || '').toString().trim();
  if (!passToken) return res.status(400).json({ error: 'bad_request', detail: 'token required' });

  // Supports updating Fulfilled (col F) and/or Notes (col N).
  const fulfilledRaw = body.fulfilled;
  let fulfilled = null;
  if (fulfilledRaw !== undefined) {
    fulfilled = String(fulfilledRaw || '').trim();
    if (fulfilled.toLowerCase() === 'yes')          fulfilled = 'Yes';
    else if (fulfilled.toLowerCase() === 'no')      fulfilled = 'No';
    else if (fulfilled.toLowerCase() === 'pending') fulfilled = 'Pending';
    else if (fulfilled === '')                      fulfilled = '';
    else return res.status(400).json({ error: 'bad_request', detail: 'fulfilled must be Yes / No / Pending / blank' });
  }

  let notes = null;
  if (body.notes !== undefined) {
    notes = String(body.notes == null ? '' : body.notes);
    if (notes.length > 4000) {
      return res.status(400).json({ error: 'bad_request', detail: 'notes too long (max 4000 chars)' });
    }
  }

  if (fulfilled === null && notes === null) {
    return res.status(400).json({ error: 'bad_request', detail: 'no fields to update' });
  }

  let accessToken;
  try { accessToken = await getAccessToken('https://www.googleapis.com/auth/spreadsheets'); }
  catch (err) { console.error('pass-update token:', err.message); return res.status(500).json({ error: 'server_error' }); }

  const { row: foundRow, rowIndex } = await findRowByToken(accessToken, passToken);
  if (!foundRow) return res.status(404).json({ error: 'not_found' });

  const rowNum = rowIndex + 1;
  try {
    if (fulfilled !== null) {
      await sheetsUpdate(accessToken, `Sheet1!F${rowNum}`, [[fulfilled]]);
    }
    if (notes !== null) {
      await sheetsUpdate(accessToken, `Sheet1!N${rowNum}`, [[notes]]);
    }
  } catch (err) {
    console.error('pass-update write:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(200).json({ ok: true });
}

async function handleLoungeAttendanceList(req, res) {
  // Two modes:
  //   1. PASS-SCOPED (default): caller passes ?token=<pass_token>. Returns
  //      only clicks made within that pass's window (date_sent → +30 days)
  //      for the pass's student email. Used by the attendance modal on
  //      /admin/lounge/passes to verify a single pass's usage. (Prior-pass
  //      rollover was the original bug — same fix as computePassStatus.)
  //   2. STUDENT-SCOPED: caller passes ?email=<student_email>. Returns ALL
  //      clicks ever logged for that email across every pass. No time filter,
  //      no "in_picks" context (since picks belong to a specific pass).
  //      Used by the "Show all clicks for this student" escape hatch.
  const passToken    = (req.query.token || '').toString().trim();
  const emailQueryIn = (req.query.email || '').toString().trim().toLowerCase();
  if (!passToken && !emailQueryIn) {
    return res.status(400).json({ error: 'bad_request', detail: 'token or email required' });
  }

  let accessToken;
  try { accessToken = await getAccessToken(); }
  catch (err) { return res.status(500).json({ error: 'server_error' }); }

  // Resolve the email we'll filter by, plus (in pass mode) the time window
  // and the selection set used to flag in-picks vs not.
  let studentEmail   = '';
  let selectedSet    = new Set();
  let windowStartMs  = null;
  let windowEndMs    = null;
  let scope          = '';

  if (passToken) {
    const { row: foundRow } = await findRowByToken(accessToken, passToken);
    if (!foundRow) return res.status(404).json({ error: 'pass_not_found' });
    studentEmail = (foundRow[2] || '').toString().toLowerCase().trim();
    const selectedRaw = (foundRow[10] || '').toString().trim();
    selectedSet = new Set(selectedRaw ? selectedRaw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean) : []);
    // Pass window = [date_sent, date_sent + 30 days). Used as the FALLBACK
    // filter for legacy attendance rows where col G (pass token) is empty.
    // Modern rows are filtered by exact token match (see below) — this
    // matches the attribution rule in computePassStatus.
    const dateSentMs = parseSheetDateMs((foundRow[8] || '').toString());
    if (dateSentMs != null) {
      windowStartMs = dateSentMs;
      windowEndMs   = dateSentMs + 30 * 86400000;
    }
    scope = 'pass';
  } else {
    studentEmail = emailQueryIn;
    scope = 'student';
  }

  // Read attendance + sessions for nice display
  let attRows, sessRows;
  try {
    const sheet = await batchGet(accessToken, ['LUL_Attendance!A:H', 'Sessions!A:K']);
    attRows  = (sheet && sheet.valueRanges && sheet.valueRanges[0] && sheet.valueRanges[0].values) || [];
    sessRows = (sheet && sheet.valueRanges && sheet.valueRanges[1] && sheet.valueRanges[1].values) || [];
  } catch (err) {
    console.error('attendance-list read:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  // Build session id → name lookup
  const sessionNameById = {};
  for (let i = 1; i < sessRows.length; i++) {
    const r = sessRows[i] || [];
    const id = (r[7] || '').toString().trim();
    if (id) sessionNameById[id] = (r[0] || '').toString().trim();
  }

  const entries = [];
  for (let i = 1; i < attRows.length; i++) {
    const r = attRows[i] || [];
    const email = (r[1] || '').toString().toLowerCase().trim();
    if (email !== studentEmail) continue;
    const clickedAtIso = (r[0] || '').toString();
    const rowToken     = (r[6] || '').toString().trim();
    // Pass-scoped mode: filter by exact pass-token match when col G is
    // present; fall back to the date window for legacy rows with no token.
    // Mirrors computePassStatus attribution so the modal and the Status
    // column always agree on which clicks "belong to" this pass.
    if (scope === 'pass') {
      if (rowToken) {
        if (rowToken !== passToken) continue;
      } else if (windowStartMs != null) {
        const ms = clickedAtIso ? new Date(clickedAtIso).getTime() : NaN;
        if (!isNaN(ms) && (ms < windowStartMs || ms >= windowEndMs)) continue;
      }
    }
    const sid = (r[3] || '').toString().trim();
    entries.push({
      row_index:    i + 1,
      clicked_at:   clickedAtIso,
      session_id:   sid,
      session_name: sessionNameById[sid] || (r[4] || '').toString(),
      zoom_url:     (r[5] || '').toString(),
      token:        rowToken,
      in_picks:     selectedSet.has(sid)  // always false in student-scope (selectedSet is empty)
    });
  }
  // Newest first
  entries.sort((a, b) => (b.clicked_at || '').localeCompare(a.clicked_at || ''));

  return res.status(200).json({
    scope:                scope,                    // 'pass' or 'student'
    student_email:        studentEmail,
    selected_session_ids: Array.from(selectedSet),  // empty in student-scope
    window_start_ms:      windowStartMs,            // null in student-scope
    window_end_ms:        windowEndMs,              // null in student-scope
    entries:              entries
  });
}

async function handleLoungeAttendanceDelete(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const rowIdxRaw = body.row_index;
  const rowIdx = parseInt(rowIdxRaw, 10);
  if (!rowIdx || rowIdx < 2) {
    return res.status(400).json({ error: 'bad_request', detail: 'row_index must be a number >= 2' });
  }

  let accessToken, rows;
  try {
    accessToken = await getAccessToken('https://www.googleapis.com/auth/spreadsheets');
    const sheet = await batchGet(accessToken, ['LUL_Attendance!A:H']);
    rows = (sheet && sheet.valueRanges && sheet.valueRanges[0] && sheet.valueRanges[0].values) || [];
  } catch (err) {
    console.error('attendance-delete read:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  // rowIdx is 1-based (row 1 = header). Bounds check + safety: don't allow header.
  if (rowIdx > rows.length) return res.status(404).json({ error: 'not_found' });

  // Rewrite the tab without the target row. Brief gap during clear→update,
  // but admin actions are infrequent and this is the simplest reliable way.
  const header    = rows[0] || ['clicked_at','student_email','student_name','session_id','session_name','zoom_url','token','in_picks'];
  const remaining = rows.slice(1).filter((_, i) => (i + 2) !== rowIdx);
  if (remaining.length === rows.length - 1) {
    return res.status(404).json({ error: 'not_found' });
  }

  try {
    await sheetsClear(accessToken,  'LUL_Attendance!A:H');
    await sheetsUpdate(accessToken, 'LUL_Attendance!A1', [header].concat(remaining));
  } catch (err) {
    console.error('attendance-delete write:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(200).json({ ok: true });
}

async function handleLoungePassMarkUsed(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const passToken = (body.token || '').toString().trim();
  if (!passToken) return res.status(400).json({ error: 'bad_request', detail: 'token required' });

  // Toggle: Yes ↔ Pending. Explicit `used` boolean in body wins if provided.
  let newValue;
  if (body.used === true || String(body.used).toLowerCase() === 'yes')      newValue = 'Yes';
  else if (body.used === false || String(body.used).toLowerCase() === 'no') newValue = 'Pending';
  else newValue = null; // auto-toggle based on current state

  let accessToken;
  try { accessToken = await getAccessToken('https://www.googleapis.com/auth/spreadsheets'); }
  catch (err) { console.error('pass-mark-used token:', err.message); return res.status(500).json({ error: 'server_error' }); }

  const { row: foundRow, rowIndex } = await findRowByToken(accessToken, passToken);
  if (!foundRow) return res.status(404).json({ error: 'not_found' });

  if (newValue === null) {
    const current = (foundRow[5] || '').toString().trim().toLowerCase();
    newValue = (current === 'yes') ? 'Pending' : 'Yes';
  }

  try {
    await sheetsUpdate(accessToken, `Sheet1!F${rowIndex + 1}`, [[newValue]]);
  } catch (err) {
    console.error('pass-mark-used write:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }
  return res.status(200).json({ ok: true, fulfilled: newValue });
}

async function handleLoungePassCancel(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const passToken = (body.token || '').toString().trim();
  if (!passToken) return res.status(400).json({ error: 'bad_request', detail: 'token required' });

  let accessToken;
  try { accessToken = await getAccessToken('https://www.googleapis.com/auth/spreadsheets'); }
  catch (err) { console.error('pass-cancel token:', err.message); return res.status(500).json({ error: 'server_error' }); }

  const { row: foundRow, rowIndex } = await findRowByToken(accessToken, passToken);
  if (!foundRow) return res.status(404).json({ error: 'not_found' });

  const rowNum = rowIndex + 1;
  try {
    // Active=FALSE + Fulfilled=No together communicate the cancelled state.
    // Notes column is reserved for admin's free-form notes (no audit line).
    await sheetsUpdate(accessToken, `Sheet1!F${rowNum}`, [['No']]);
    await sheetsUpdate(accessToken, `Sheet1!H${rowNum}`, [[false]]);
  } catch (err) {
    console.error('pass-cancel write:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(200).json({ ok: true });
}

// ── handleLoungePassUnlock ──
// Clears a pass row's saved selections so the student can re-pick from
// scratch. Used when a student needs to change which sessions they're
// attending (e.g. picked the wrong one, or got blocked by an old
// attendance entry that confused the system).
//
// Writes blanks to cols J (Selections Locked), K (Selected Sessions),
// and L (Date Locked). Leaves col M (First Clicked) alone — that's
// historical and shouldn't be wiped by re-picking. Active/cancelled/
// fulfilled/notes are also untouched.
async function handleLoungePassUnlock(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const passToken = (body.token || '').toString().trim();
  if (!passToken) return res.status(400).json({ error: 'bad_request', detail: 'token required' });

  let accessToken;
  try { accessToken = await getAccessToken('https://www.googleapis.com/auth/spreadsheets'); }
  catch (err) { console.error('pass-unlock token:', err.message); return res.status(500).json({ error: 'server_error' }); }

  const { row: foundRow, rowIndex } = await findRowByToken(accessToken, passToken);
  if (!foundRow) return res.status(404).json({ error: 'not_found' });

  const rowNum = rowIndex + 1;
  try {
    // Clear J:L (Selections Locked, Selected Sessions, Date Locked) in a
    // single range write. Empty strings render as blank in the sheet and
    // are correctly handled by all readers (isYesish → false for col J,
    // empty selections array for col K, blank date for col L).
    await sheetsUpdate(accessToken, `Sheet1!J${rowNum}:L${rowNum}`, [['', '', '']]);
  } catch (err) {
    console.error('pass-unlock write:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(200).json({ ok: true });
}

// ── LUL Attendance dashboard (Phase 2c) ─────────────────────
//
// One endpoint that aggregates everything the dashboard needs:
//   - 4 KPIs for the selected period (with deltas vs prior period)
//   - Per-session attendance for the selected period (in-picks vs outside)
//   - Weekly trend (last 8 weeks, always — independent of period)
//   - Pass type breakdown (active passes, snapshot)
//   - Recent activity (last 50 clicks)
//
// Period values:
//   - 'this-week'    (default) → Mon→Sun in CT, prior = last Mon→Sun
//   - 'last-4-weeks' → last 4 weeks ending this week, prior = the 4 before
//   - 'all'          → everything; no delta

async function handleLoungeAttendanceStats(req, res) {
  const period = (req.query.period || 'this-week').toString();

  let token;
  try { token = await getAccessToken(); }
  catch (err) {
    console.error('attendance-stats token:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  let sheet1Rows, attendanceRows, sessionRows, typeRows;
  try {
    const sheet = await batchGet(token, [
      'Sheet1!A:N', 'LUL_Attendance!A:H', 'Sessions!A:K', 'LUL_Pass_Types!A:E'
    ]);
    const ranges = (sheet && sheet.valueRanges) || [];
    sheet1Rows     = (ranges[0] && ranges[0].values) || [];
    attendanceRows = (ranges[1] && ranges[1].values) || [];
    sessionRows    = (ranges[2] && ranges[2].values) || [];
    typeRows       = (ranges[3] && ranges[3].values) || [];
  } catch (err) {
    console.error('attendance-stats read:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  // Session id → name lookup
  const sessionNameById = {};
  for (let i = 1; i < sessionRows.length; i++) {
    const r = sessionRows[i] || [];
    const id = (r[7] || '').toString().trim();
    if (id) sessionNameById[id] = (r[0] || '').toString().trim();
  }

  // Pass types
  const passTypes = [];
  for (let i = 1; i < typeRows.length; i++) {
    const r = typeRows[i] || [];
    if (!r[0]) continue;
    const pcRaw = (r[2] == null ? '' : r[2]).toString().trim();
    passTypes.push({
      exp_type:   (r[0] || '').toString().trim(),
      mode:       ((r[1] || 'pick').toString().toLowerCase().trim()) || 'pick',
      pick_count: pcRaw && /^\d+$/.test(pcRaw) ? parseInt(pcRaw, 10) : null
    });
  }

  // Passes
  const passes = [];
  for (let i = 1; i < sheet1Rows.length; i++) {
    const r = sheet1Rows[i] || [];
    if (!r[0] && !r[1] && !r[2]) continue;
    const dateSentMs = parseSheetDateMs(r[8]);
    const selectedRaw = (r[10] || '').toString().trim();
    const selectedIds = selectedRaw ? selectedRaw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean) : [];
    passes.push({
      exp_type:    (r[0] || '').toString().trim(),
      name:        (r[1] || '').toString().trim(),
      email:       (r[2] || '').toString().toLowerCase().trim(),
      token:       (r[6] || '').toString().trim(),
      active:      isYesish(r[7]),
      date_sent_ms: dateSentMs,
      selections_locked: isYesish(r[9]),
      selected_session_ids: selectedIds
    });
  }

  // Clicks
  const clicks = [];
  const attendedByEmail = {}; // email → array of session ids ever attended (for Used calc)
  for (let i = 1; i < attendanceRows.length; i++) {
    const r = attendanceRows[i] || [];
    const email = (r[1] || '').toString().toLowerCase().trim();
    const sid   = (r[3] || '').toString().trim();
    const ts    = (r[0] || '').toString();
    const tsMs  = ts ? new Date(ts).getTime() : null;
    if (!email) continue;
    clicks.push({
      ts_ms:        isNaN(tsMs) ? null : tsMs,
      ts_iso:       ts,
      email:        email,
      session_id:   sid,
      session_name: (r[4] || '').toString().trim(),
      in_picks:     (r[7] || '').toString().toUpperCase().trim() === 'YES'
    });
    if (sid) (attendedByEmail[email] = attendedByEmail[email] || []).push(sid);
  }

  // Period boundaries (UTC ms)
  const thisWeek  = weekStartMs(0);
  const nextWeek  = thisWeek + 7 * 86400000;
  const lastWeek  = weekStartMs(1);
  const fourWk    = weekStartMs(4);
  const eightWk   = weekStartMs(8);

  let curStart, curEnd, priorStart, priorEnd, hasDelta, periodLabel;
  if (period === 'last-4-weeks') {
    curStart = fourWk;   curEnd = nextWeek;
    priorStart = eightWk; priorEnd = fourWk;
    hasDelta = true;
    periodLabel = 'vs prior 4 weeks';
  } else if (period === 'all') {
    curStart = 0;        curEnd = nextWeek;
    priorStart = priorEnd = null;
    hasDelta = false;
    periodLabel = 'all time';
  } else {
    curStart = thisWeek; curEnd = nextWeek;
    priorStart = lastWeek; priorEnd = thisWeek;
    hasDelta = true;
    periodLabel = 'vs last week';
  }

  function inRange(ms, start, end) {
    if (ms == null) return false;
    if (start === 0) return ms < end; // 'all' lower bound
    return ms >= start && ms < end;
  }

  function kpisForRange(start, end) {
    let passHolders = 0, activePasses = 0, used = 0;
    const attendedEmails = new Set();

    for (const p of passes) {
      if (start === 0 || inRange(p.date_sent_ms, start, end)) {
        passHolders++;
        if (p.active) activePasses++;

        // Used: passes whose attendance has crossed the pick-count threshold
        if (p.active && p.selections_locked) {
          const cfg = modeForType(passTypes, p.exp_type);
          const required = cfg.pick_count != null ? cfg.pick_count : (p.selected_session_ids.length || 1);
          const sids     = (attendedByEmail[p.email] || []).filter(s => p.selected_session_ids.indexOf(s) >= 0);
          const unique   = new Set(sids);
          if (required > 0 && unique.size >= required) used++;
        }
      }
    }
    for (const c of clicks) {
      if (c.ts_ms == null) continue;
      if (start === 0 ? c.ts_ms < end : (c.ts_ms >= start && c.ts_ms < end)) {
        attendedEmails.add(c.email);
      }
    }
    return {
      pass_holders:  passHolders,
      active_passes: activePasses,
      attended:      attendedEmails.size,
      used:          used
    };
  }

  const current = kpisForRange(curStart, curEnd);
  const prior   = hasDelta ? kpisForRange(priorStart, priorEnd) : null;

  // Per-session attendance (current period)
  const perSessionMap = {};
  for (const c of clicks) {
    if (c.ts_ms == null) continue;
    const inCur = curStart === 0 ? c.ts_ms < curEnd : (c.ts_ms >= curStart && c.ts_ms < curEnd);
    if (!inCur) continue;
    const key = c.session_id || ('name:' + c.session_name);
    if (!perSessionMap[key]) {
      perSessionMap[key] = {
        session_id:   c.session_id || '',
        session_name: c.session_name || sessionNameById[c.session_id] || c.session_id || '(unknown)',
        in_picks:     new Set(),
        outside:      new Set()
      };
    }
    if (c.in_picks) perSessionMap[key].in_picks.add(c.email);
    else            perSessionMap[key].outside.add(c.email);
  }
  const perSession = Object.values(perSessionMap)
    .map(s => ({
      session_id:    s.session_id,
      session_name:  s.session_name,
      in_picks:      s.in_picks.size,
      outside_picks: s.outside.size,
      total:         s.in_picks.size + s.outside.size
    }))
    .sort((a, b) => b.total - a.total);

  // Weekly trend: last 8 weeks (always)
  const weeklyTrend = [];
  for (let w = 7; w >= 0; w--) {
    const ws = weekStartMs(w);
    const we = weekStartMs(w - 1);
    const emails = new Set();
    for (const c of clicks) {
      if (c.ts_ms != null && c.ts_ms >= ws && c.ts_ms < we) emails.add(c.email);
    }
    weeklyTrend.push({
      week_start: new Date(ws).toISOString().slice(0, 10),
      attendees:  emails.size,
      is_current: w === 0
    });
  }

  // Pass type breakdown (active passes, snapshot)
  const typeMap = {};
  for (const p of passes) {
    if (!p.active) continue;
    const t = p.exp_type || '(unspecified)';
    typeMap[t] = (typeMap[t] || 0) + 1;
  }
  const typeBreakdown = Object.entries(typeMap)
    .map(([exp_type, count]) => ({ exp_type, count }))
    .sort((a, b) => b.count - a.count);

  // Recent activity: last 50 unique student/session/day combos.
  // Multiple clicks on the same session by the same student on the same
  // day collapse into one row with a click_count badge — keeps the
  // dashboard signal-dense (per-click detail lives in Pass Holders → Click log).
  const recentMap = new Map();
  clicks
    .filter(c => c.ts_ms != null)
    .sort((a, b) => b.ts_ms - a.ts_ms)
    .forEach(c => {
      const day = new Date(c.ts_ms).toISOString().slice(0, 10);
      const key = c.email + '|' + (c.session_id || c.session_name || '?') + '|' + day;
      if (recentMap.has(key)) {
        recentMap.get(key).click_count++;
      } else {
        recentMap.set(key, {
          clicked_at:   c.ts_iso,
          email:        c.email,
          session_id:   c.session_id,
          session_name: c.session_name || sessionNameById[c.session_id] || c.session_id || '(unknown)',
          in_picks:     c.in_picks,
          click_count:  1
        });
      }
    });
  const recent = Array.from(recentMap.values()).slice(0, 50);

  return res.status(200).json({
    period,
    period_label:   periodLabel,
    current,
    prior,
    has_delta:      hasDelta,
    per_session:    perSession,
    weekly_trend:   weeklyTrend,
    type_breakdown: typeBreakdown,
    recent
  });
}

// ── LUL Page Copy admin ─────────────────────────────────────
//
// LUL_Page_Copy tab schema:
//   A Key | B Value | C Description
//
// Each row represents one editable string on the /lounge page.
// The student-facing API picks these up automatically; lounge.html
// falls back to its default in-HTML text if the tab is missing.

async function readLulPageCopy(token) {
  try {
    const sheet = await batchGet(token, ['LUL_Page_Copy!A:C']);
    return (sheet && sheet.valueRanges && sheet.valueRanges[0] && sheet.valueRanges[0].values) || [];
  } catch (_) { return []; }
}

async function handleLoungeCopyList(req, res) {
  let token;
  try { token = await getAccessToken(); }
  catch (err) { return res.status(500).json({ error: 'server_error' }); }

  const rows = await readLulPageCopy(token);
  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const key = (r[0] || '').toString().trim();
    if (!key) continue;
    items.push({
      row_index:   i + 1,
      key:         key,
      value:       (r[1] || '').toString(),
      description: (r[2] || '').toString()
    });
  }
  return res.status(200).json({ copy: items });
}

async function handleLoungeCopySave(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const key   = (body.key || '').toString().trim();
  const value = (body.value == null ? '' : body.value).toString();
  const descr = (body.description == null ? '' : body.description).toString();
  if (!key) return res.status(400).json({ error: 'bad_request', detail: 'key required' });
  if (value.length > 4000) return res.status(400).json({ error: 'bad_request', detail: 'value too long (max 4000 chars)' });

  let token;
  try { token = await getAccessToken('https://www.googleapis.com/auth/spreadsheets'); }
  catch (err) { return res.status(500).json({ error: 'server_error' }); }

  const rows = await readLulPageCopy(token);
  let existingRow = -1;
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][0] || '').toString().trim() === key) { existingRow = i; break; }
  }

  // Preserve description when only value is being updated and caller didn't pass one
  let finalDescr = descr;
  if (body.description === undefined && existingRow >= 0) {
    finalDescr = (rows[existingRow][2] || '').toString();
  }

  const row = [key, value, finalDescr];

  try {
    if (existingRow >= 0) {
      const rowNum = existingRow + 1;
      await sheetsUpdate(token, `LUL_Page_Copy!A${rowNum}:C${rowNum}`, [row]);
    } else {
      await sheetsAppend(token, 'LUL_Page_Copy!A:C', [row]);
    }
  } catch (err) {
    console.error('lounge-copy-save write:', err.message);
    return res.status(500).json({ error: 'server_error', detail: 'Make sure the LUL_Page_Copy tab exists.' });
  }
  return res.status(200).json({ ok: true, key, created: existingRow < 0 });
}

// ── Experience Suggestions admin (Phase 2d) ─────────────────
//
// Experience_Suggestions tab schema:
//   A Submitted At | B Student Name | C Student Email
//   D Type         | E Title        | F Description
//   G Status       | H Admin Notes
//
// Status: New / Reviewing / Approved / Declined

const VALID_SUGGESTION_STATUS = ['New', 'Reviewing', 'Approved', 'Declined'];

async function readSuggestions(token) {
  const sheet = await batchGet(token, ['Experience_Suggestions!A:H']);
  return (sheet && sheet.valueRanges && sheet.valueRanges[0] && sheet.valueRanges[0].values) || [];
}

async function handleSuggestionsList(req, res) {
  const statusFilter = (req.query.status || '').toString().trim();

  let token;
  try { token = await getAccessToken(); }
  catch (err) { console.error('suggestions-list token:', err.message); return res.status(500).json({ error: 'server_error' }); }

  let rows;
  try { rows = await readSuggestions(token); }
  catch (err) {
    console.error('suggestions-list read:', err.message);
    return res.status(500).json({ error: 'server_error', detail: 'Make sure the Experience_Suggestions tab exists.' });
  }

  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (!r[0] && !r[2] && !r[4]) continue;
    const status = (r[6] || 'New').toString().trim() || 'New';
    if (statusFilter && status.toLowerCase() !== statusFilter.toLowerCase()) continue;
    items.push({
      row_index:     i + 1,
      submitted_at:  (r[0] || '').toString(),
      student_name:  (r[1] || '').toString(),
      student_email: (r[2] || '').toString(),
      type:          (r[3] || '').toString(),
      title:         (r[4] || '').toString(),
      description:   (r[5] || '').toString(),
      status:        status,
      admin_notes:   (r[7] || '').toString()
    });
  }
  items.sort((a, b) => (b.submitted_at || '').localeCompare(a.submitted_at || ''));
  return res.status(200).json({ suggestions: items });
}

async function handleSuggestionUpdate(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const rowIdx = parseInt(body.row_index, 10);
  if (!rowIdx || rowIdx < 2) {
    return res.status(400).json({ error: 'bad_request', detail: 'row_index must be >= 2' });
  }

  let status = null;
  if (body.status !== undefined) {
    const s = String(body.status).trim();
    const match = VALID_SUGGESTION_STATUS.find(v => v.toLowerCase() === s.toLowerCase());
    if (!match) return res.status(400).json({ error: 'bad_request', detail: 'status must be New / Reviewing / Approved / Declined' });
    status = match;
  }
  let notes = null;
  if (body.admin_notes !== undefined) {
    notes = String(body.admin_notes == null ? '' : body.admin_notes);
    if (notes.length > 4000) return res.status(400).json({ error: 'bad_request', detail: 'admin_notes too long' });
  }
  if (status === null && notes === null) {
    return res.status(400).json({ error: 'bad_request', detail: 'no fields to update' });
  }

  let token;
  try { token = await getAccessToken('https://www.googleapis.com/auth/spreadsheets'); }
  catch (err) { return res.status(500).json({ error: 'server_error' }); }

  try {
    if (status !== null) {
      await sheetsUpdate(token, `Experience_Suggestions!G${rowIdx}`, [[status]]);
    }
    if (notes !== null) {
      await sheetsUpdate(token, `Experience_Suggestions!H${rowIdx}`, [[notes]]);
    }
  } catch (err) {
    console.error('suggestion-update write:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }
  return res.status(200).json({ ok: true });
}

// ── Notifications feed (admin) ──────────────────────────────
//
// Aggregates everything the admin should be aware of:
//   - New experience suggestions (Status = New)
//   - Pass welcome emails that failed to send (Email Sent = FAILED)
//
// Returns counts (for the nav badge) + recent items (for the
// /admin/notifications page). Cheap enough that every admin page
// can hit it on load to update its badge.

async function handleNotificationsFeed(req, res) {
  let token;
  try { token = await getAccessToken(); }
  catch (err) {
    return res.status(200).json({ counts: { new_suggestions: 0, failed_emails: 0, new_submissions: 0, total: 0 }, items: [] });
  }

  let suggestionRows = [], sheet1Rows = [], submissionRows = [], catalogRows = [];
  try {
    const sheet = await batchGet(token, [
      'Experience_Suggestions!A:H',
      'Sheet1!A:N',
      'FT_Submissions!A:H',
      'FT_Catalog!A:E'
    ]);
    const ranges = (sheet && sheet.valueRanges) || [];
    suggestionRows = (ranges[0] && ranges[0].values) || [];
    sheet1Rows     = (ranges[1] && ranges[1].values) || [];
    submissionRows = (ranges[2] && ranges[2].values) || [];
    catalogRows    = (ranges[3] && ranges[3].values) || [];
  } catch (_) { /* tab may not exist; skip silently */ }

  // Trip id → title lookup for nicer submission notifications
  const tripsById = {};
  for (let i = 1; i < catalogRows.length; i++) {
    const r = catalogRows[i] || [];
    const id = (r[0] || '').toString().trim();
    if (id) tripsById[id] = { title: (r[1] || '').toString(), emoji: (r[3] || '').toString() };
  }

  const items = [];

  for (let i = 1; i < suggestionRows.length; i++) {
    const r = suggestionRows[i] || [];
    if (!r[4]) continue;
    const status = (r[6] || 'New').toString().trim() || 'New';
    if (status !== 'New') continue;
    items.push({
      kind:          'suggestion',
      submitted_at:  (r[0] || '').toString(),
      student_name:  (r[1] || '').toString(),
      student_email: (r[2] || '').toString(),
      type:          (r[3] || '').toString(),
      title:         (r[4] || '').toString(),
      href:          '/admin/suggestions'
    });
  }

  for (let i = 1; i < sheet1Rows.length; i++) {
    const r = sheet1Rows[i] || [];
    const emailSent = (r[4] || '').toString().toUpperCase().trim();
    if (emailSent !== 'FAILED') continue;
    items.push({
      kind:          'failed_email',
      submitted_at:  (r[8] || '').toString(),
      student_name:  (r[1] || '').toString(),
      student_email: (r[2] || '').toString(),
      type:          (r[0] || '').toString(),
      title:         'Welcome email failed to send',
      pass_token:    (r[6] || '').toString(),
      href:          '/admin/lounge/passes'
    });
  }

  // FT_Submissions schema: A email | B trip_id | C name | D location
  //                        E file_url | F file_type | G submitted_at | H Reviewed (YES/blank)
  for (let i = 1; i < submissionRows.length; i++) {
    const r = submissionRows[i] || [];
    if (!r[4]) continue; // no file_url = empty row
    const reviewed = (r[7] || '').toString().toUpperCase().trim();
    if (reviewed === 'YES') continue;
    const tripId = (r[1] || '').toString().trim();
    const trip   = tripsById[tripId] || { title: tripId, emoji: '' };
    items.push({
      kind:          'submission',
      submitted_at:  (r[6] || '').toString(),
      student_name:  (r[2] || '').toString(),
      student_email: (r[0] || '').toString(),
      type:          trip.title || tripId,
      title:         (trip.emoji ? trip.emoji + ' ' : '') + 'New gallery submission',
      file_type:     ((r[5] || '').toString().toLowerCase() === 'video') ? 'video' : 'image',
      href:          '/admin/submissions'
    });
  }

  items.sort((a, b) => (b.submitted_at || '').localeCompare(a.submitted_at || ''));

  const newSuggCount    = items.filter(x => x.kind === 'suggestion').length;
  const failedMailCount = items.filter(x => x.kind === 'failed_email').length;
  const newSubsCount    = items.filter(x => x.kind === 'submission').length;

  return res.status(200).json({
    counts: {
      new_suggestions: newSuggCount,
      failed_emails:   failedMailCount,
      new_submissions: newSubsCount,
      total:           newSuggCount + failedMailCount + newSubsCount
    },
    items
  });
}

// ── Toggle a single submission's Reviewed flag ─────────────
// Reviewed=YES means: visible in /gallery + cleared from notifications.
// Anything else means: hidden from /gallery + counts as a notification.
//
// Called from admin-submissions.html when the admin clicks the
// "Mark as reviewed" / "Reviewed ✓" toggle on a card.

async function handleSubToggleReviewed(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const fileUrl = (body.file_url || '').toString().trim();
  if (!fileUrl) return res.status(400).json({ error: 'bad_request', detail: 'file_url required' });
  const newValue = (body.reviewed === true || String(body.reviewed).toLowerCase() === 'yes') ? 'YES' : '';

  let token, rows;
  try {
    token = await getAccessToken('https://www.googleapis.com/auth/spreadsheets');
    const sheet = await batchGet(token, ['FT_Submissions!A:H']);
    rows = (sheet && sheet.valueRanges && sheet.valueRanges[0] && sheet.valueRanges[0].values) || [];
  } catch (err) {
    console.error('sub-toggle-reviewed read:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  let foundRow = -1;
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][4] || '').toString().trim() === fileUrl) { foundRow = i; break; }
  }
  if (foundRow < 0) return res.status(404).json({ error: 'not_found' });

  try {
    await sheetsUpdate(token, `FT_Submissions!H${foundRow + 1}`, [[newValue]]);
  } catch (err) {
    console.error('sub-toggle-reviewed write:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }
  return res.status(200).json({ ok: true, reviewed: newValue === 'YES' });
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
    case 'trips-list':            return handleTripsList(req, res);
    case 'trip-get':              return handleTripGet(req, res);
    case 'trip-save':             return handleTripSave(req, res);
    case 'trip-delete':           return handleTripDelete(req, res);
    case 'regs-list':             return handleRegsList(req, res);
    case 'reg-create':            return handleRegCreate(req, res);
    case 'reg-update':            return handleRegUpdate(req, res);
    case 'reg-cancel':            return handleRegCancel(req, res);
    case 'reg-attendance':        return handleRegAttendance(req, res);
    case 'subs-list':             return handleSubsList(req, res);
    case 'sub-delete':            return handleSubDelete(req, res);
    case 'prep-upload-url':       return handlePrepUploadUrl(req, res);
    case 'admins-list':           return handleAdminsList(req, res);
    case 'admin-add':             return handleAdminAdd(req, res);
    case 'admin-remove':          return handleAdminRemove(req, res);
    case 'lounge-sessions-list':  return handleLoungeSessionsList(req, res);
    case 'lounge-session-save':   return handleLoungeSessionSave(req, res);
    case 'lounge-pass-types-list':return handleLoungePassTypesList(req, res);
    case 'lounge-pass-type-save': return handleLoungePassTypeSave(req, res);
    case 'lounge-passes-list':    return handleLoungePassesList(req, res);
    case 'lounge-pass-create':    return handleLoungePassCreate(req, res);
    case 'lounge-pass-extend':    return handleLoungePassExtend(req, res);
    case 'lounge-pass-resend':    return handleLoungePassResend(req, res);
    case 'lounge-pass-cancel':    return handleLoungePassCancel(req, res);
    case 'lounge-pass-unlock':    return handleLoungePassUnlock(req, res);
    case 'lounge-pass-mark-used': return handleLoungePassMarkUsed(req, res);
    case 'lounge-pass-update':    return handleLoungePassUpdate(req, res);
    case 'lounge-attendance-list':   return handleLoungeAttendanceList(req, res);
    case 'lounge-attendance-delete': return handleLoungeAttendanceDelete(req, res);
    case 'lounge-attendance-stats':  return handleLoungeAttendanceStats(req, res);
    case 'suggestions-list':         return handleSuggestionsList(req, res);
    case 'suggestion-update':        return handleSuggestionUpdate(req, res);
    case 'notifications-feed':       return handleNotificationsFeed(req, res);
    case 'sub-toggle-reviewed':      return handleSubToggleReviewed(req, res);
    case 'lounge-copy-list':         return handleLoungeCopyList(req, res);
    case 'lounge-copy-save':         return handleLoungeCopySave(req, res);
    default:                      return res.status(404).json({ error: 'not_found', detail: action });
  }
};
