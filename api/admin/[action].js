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

  // Verify the trip + session exist (and that the session belongs to the trip)
  try {
    const sheet = await batchGet(token, ['FT_Catalog!A:A', 'FT_Sessions!A:B', 'FT_Purchases!A:I']);
    const ranges = (sheet && sheet.valueRanges) || [];
    const catalogRows  = (ranges[0] && ranges[0].values) || [];
    const sessionRows  = (ranges[1] && ranges[1].values) || [];
    const purchaseRows = (ranges[2] && ranges[2].values) || [];

    let tripExists = false;
    for (let i = 1; i < catalogRows.length; i++) {
      if ((catalogRows[i][0] || '').toString().trim() === tripId) { tripExists = true; break; }
    }
    if (!tripExists) return res.status(400).json({ error: 'unknown_trip' });

    let sessionMatch = false;
    for (let i = 1; i < sessionRows.length; i++) {
      const r = sessionRows[i];
      if ((r[0] || '').toString().trim() === sessionId &&
          (r[1] || '').toString().trim() === tripId) { sessionMatch = true; break; }
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

  return res.status(200).json({ ok: true });
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
    const sheet = await batchGet(token, ['FT_Submissions!A:G', 'FT_Catalog!A:E']);
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
        submitted_at:  (r[6] || '').toString()
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
      blackout_start: (r[9]  || '').toString(),
      blackout_end:   (r[10] || '').toString()
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
    case 'admins-list':           return handleAdminsList(req, res);
    case 'admin-add':             return handleAdminAdd(req, res);
    case 'admin-remove':          return handleAdminRemove(req, res);
    case 'lounge-sessions-list':  return handleLoungeSessionsList(req, res);
    case 'lounge-session-save':   return handleLoungeSessionSave(req, res);
    default:                      return res.status(404).json({ error: 'not_found', detail: action });
  }
};
