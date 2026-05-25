// ============================================================
// ALPHA EXPERIENCES — LEVEL UP LOUNGE (student-facing dispatcher)
// One Vercel function for all student-facing /api/lul/* endpoints.
// Same single-segment dynamic-route pattern as api/admin/[action].js.
//
// Reads the existing LUL Sheet1 + Sessions tabs by signed-in EMAIL
// (not by token). The legacy token-based flow at /lul?token=... keeps
// working in parallel — these endpoints add a Google-sign-in path.
//
// Sheet1 columns (per validate-token.js + email-sender.gs):
//   A: experience_type ("2 Sessions Pass" / "Full Week" / "Friday Coaching Celebration")
//   B: name
//   C: student email
//   D: parent email
//   E: email_sent
//   F: fulfilled
//   G: token
//   H: active (boolean checkbox; Apps Script flips to FALSE after 30 days)
//   I: date_sent
//   J: locked ("YES" once student saves selections)
//   K: saved_selections (comma-separated session slugs)
//   M: date_first_clicked (written by api/track-join.js)
//
// Sessions tab columns (verified against the live get-sessions.js):
//   A: name             B: emoji             C: coach
//   D: day              E: time              F: description
//   G: zoom_link        H: session_id (slug) I: active (YES/NO)
//   J: blackout_start   K: blackout_end
// ============================================================

const https  = require('https');
const crypto = require('crypto');
const { getSession, httpsGet } = require('../_lib/session.js');

const SHEET_ID    = '1aQYysCOOR-mYG8Myrl1BSU2PF8wMl-si8pgNG89sRto';
const PASS_RANGE       = 'Sheet1!A:M';
const SESSIONS_RANGE   = 'Sessions!A:K';
const ATTENDANCE_RANGE = 'LUL_Attendance!A:H';

// ── Sheets access (same JWT pattern as the rest of the app) ──
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

// ── Helpers ────────────────────────────────────────────────
// Pass mode derived from col A's text — same logic as validate-token.js
function passModeFromExpType(expType) {
  const t = (expType || '').toLowerCase();
  if (t.indexOf('2 sessions') !== -1)                return 'two';
  if (t.indexOf('friday coaching celebration') !== -1) return 'celebration';
  return 'full';
}

function passLabelFromMode(mode) {
  if (mode === 'two')         return '2-Session Pass';
  if (mode === 'celebration') return 'Friday Coaching Celebration';
  return 'Full Week Pass';
}

// Expects sheet date strings like "5/15/2026" or ISO. Returns Date or null.
function parseSheetDate(s) {
  if (!s) return null;
  const v = String(s).trim();
  if (!v) return null;
  const d = new Date(v);
  if (!isNaN(d.getTime())) return d;
  // Try M/D/YYYY explicitly
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const dd = new Date(parseInt(m[3],10), parseInt(m[1],10) - 1, parseInt(m[2],10));
    if (!isNaN(dd.getTime())) return dd;
  }
  return null;
}

// 30-day expiry window matching apps-script-email-sender.gs expireOldTokens()
const EXPIRY_DAYS = 30;
function daysRemainingFromSent(dateSent) {
  const d = parseSheetDate(dateSent);
  if (!d) return null;
  const ms = (d.getTime() + EXPIRY_DAYS * 24 * 60 * 60 * 1000) - Date.now();
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

// ── Time-lock helpers (mirror api/get-sessions.js) ────────────
const LUL_TZ = 'America/Chicago';
const DAY_MAP_LUL = {
  SUN:0, SUNDAY:0, MON:1, MONDAY:1,
  TUE:2, TUES:2, TUESDAY:2, WED:3, WEDS:3, WEDNESDAY:3,
  THU:4, THUR:4, THURS:4, THURSDAY:4,
  FRI:5, FRIDAY:5, SAT:6, SATURDAY:6
};
function tzOffsetMsLul(utcMs, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = fmt.formatToParts(new Date(utcMs));
  const g = (t, def) => {
    const p = parts.find(x => x.type === t);
    if (!p) return def;
    const n = parseInt(p.value, 10);
    return isNaN(n) ? def : n;
  };
  let h = g('hour', 0);
  if (h === 24) h = 0;
  const fakeUtcMs = Date.UTC(g('year', 1970), g('month', 1) - 1, g('day', 1), h, g('minute', 0), g('second', 0));
  return fakeUtcMs - utcMs;
}
function parseTimeWithCT(s) {
  if (!s) return null;
  const str = String(s).trim().replace(/\s*(CT|CST|CDT)\s*$/i, '').trim();
  const m = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ap = (m[3] || '').toUpperCase();
  if (ap === 'PM' && hh < 12) hh += 12;
  if (ap === 'AM' && hh === 12) hh = 0;
  if (hh > 23 || mm > 59 || hh < 0 || mm < 0) return null;
  return { hh, mm };
}
function nextOccurrenceUtcMs(dayStr, timeStr) {
  const targetDay = DAY_MAP_LUL[String(dayStr || '').toUpperCase().trim()];
  if (targetDay === undefined) return null;
  const t = parseTimeWithCT(timeStr);
  if (!t) return null;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: LUL_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
  });
  const parts = fmt.formatToParts(new Date());
  const g = type => parts.find(p => p.type === type).value;
  const Y = parseInt(g('year'), 10);
  const M = parseInt(g('month'), 10);
  const D = parseInt(g('day'), 10);
  const todayDay = DAY_MAP_LUL[g('weekday').toUpperCase()];
  const daysAhead = (targetDay - todayDay + 7) % 7;
  const LOCK_AFTER_MS_LUL = 45 * 60 * 1000;
  function buildUtc(off) {
    const naive = Date.UTC(Y, M - 1, D + off, t.hh, t.mm, 0);
    return naive - tzOffsetMsLul(naive, LUL_TZ);
  }
  let startUtc = buildUtc(daysAhead);
  if (startUtc + LOCK_AFTER_MS_LUL < Date.now()) startUtc = buildUtc(daysAhead + 7);
  return startUtc;
}

// True if today falls between blackout_start and blackout_end (inclusive)
function inBlackoutWindow(start, end) {
  const s = parseSheetDate(start);
  const e = parseSheetDate(end);
  if (!s && !e) return false;
  const now = new Date();
  // Normalize "today" to midnight local for date-only comparison
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (s && today < s) return false;
  if (e && today > e) return false;
  return !!(s || e);
}

// ── handleLoungeData ──────────────────────────────────────
// Returns the signed-in user's pass(es) + this week's session catalog.
// Multiple passes possible — Eddie confirmed students can hold more
// than one (e.g. a 2-Session pass + a Celebration pass). Each renders
// as its own card on the /lounge page.
async function handleLoungeData(req, res) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'not_authenticated' });

  const myEmail = (session.email || '').toLowerCase().trim();
  if (!myEmail) return res.status(401).json({ error: 'not_authenticated' });

  let passes = [];
  let sessions = [];
  let pageCopy = {};
  try {
    const token = await getAccessToken();
    const sheet = await batchGet(token, [PASS_RANGE, SESSIONS_RANGE]);
    const ranges = (sheet && sheet.valueRanges) || [];
    const passRows    = (ranges[0] && ranges[0].values) || [];
    const sessionRows = (ranges[1] && ranges[1].values) || [];

    // Page copy: fetched separately so a missing LUL_Page_Copy tab doesn't
    // break the page (defaults already live in the HTML as fallback).
    try {
      const copyResult = await batchGet(token, ['LUL_Page_Copy!A:C']);
      const copyRows   = (copyResult && copyResult.valueRanges && copyResult.valueRanges[0] && copyResult.valueRanges[0].values) || [];
      for (let i = 1; i < copyRows.length; i++) {
        const r = copyRows[i] || [];
        const key = (r[0] || '').toString().trim();
        const val = (r[1] || '').toString();
        if (key && val) pageCopy[key] = val;
      }
    } catch (_) { /* tab may not exist; leave pageCopy empty */ }

    // Build session list (filtered to active + not in blackout for the lounge page)
    for (let i = 1; i < sessionRows.length; i++) {
      const r = sessionRows[i];
      const sid = (r[7] || '').toString().trim();
      if (!sid) continue;
      const active = (r[8] || '').toString().toUpperCase().trim();
      if (active && active !== 'YES') continue;
      if (inBlackoutWindow(r[9], r[10])) continue;
      const day  = (r[3] || '').toString();
      const time = (r[4] || '').toString();
      const startUtc = nextOccurrenceUtcMs(day, time);
      sessions.push({
        session_id:  sid,
        name:        (r[0] || '').toString(),
        emoji:       (r[1] || '').toString(),     // col B = emoji
        coach:       (r[2] || '').toString(),
        day:         day,
        time:        time,
        description: (r[5] || '').toString(),     // col F = description
        // ISO of next occurrence — client formats into local TZ
        session_start_iso: startUtc !== null ? new Date(startUtc).toISOString() : null
      });
    }
    // Stable order: by day-of-week then by time. Best effort with string sort.
    const dayOrder = { 'mon':1,'monday':1,'tue':2,'tuesday':2,'wed':3,'wednesday':3,'thu':4,'thursday':4,'fri':5,'friday':5,'sat':6,'saturday':6,'sun':7,'sunday':7 };
    sessions.sort((a, b) => {
      const ao = dayOrder[a.day.toLowerCase()] || 9;
      const bo = dayOrder[b.day.toLowerCase()] || 9;
      if (ao !== bo) return ao - bo;
      return (a.time || '').localeCompare(b.time || '');
    });

    // Sessions index for resolving saved selections (slug → display)
    const byId = {};
    sessions.forEach(s => { byId[s.session_id] = s; });

    // Build passes for this email — INCLUDE expired (Eddie wants to show them)
    for (let i = 1; i < passRows.length; i++) {
      const r = passRows[i];
      const rowEmail = (r[2] || '').toString().toLowerCase().trim();
      if (rowEmail !== myEmail) continue;

      const expType  = (r[0] || '').toString();
      const name     = (r[1] || '').toString();
      const token    = (r[6] || '').toString().trim();
      const activeRaw = r[7];
      const dateSent = (r[8] || '').toString();
      const locked   = (r[9] || '').toString().toUpperCase().trim() === 'YES';
      const savedRaw = (r[10] || '').toString().trim();
      const firstClicked = (r[12] || '').toString().trim();

      const isActive = activeRaw === true || activeRaw === 'TRUE' || activeRaw === 'true' || activeRaw === 1 || activeRaw === '1';
      const daysLeft = daysRemainingFromSent(dateSent);
      const expired  = !isActive || (daysLeft !== null && daysLeft < 0);

      const savedIds = savedRaw ? savedRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

      passes.push({
        // Identifiers
        token:           token,                 // used for the bridge link to /lul?token=
        // Pass info
        experience_type: expType,
        pass_mode:       passModeFromExpType(expType),
        pass_label:      passLabelFromMode(passModeFromExpType(expType)),
        // Person
        name:            name,
        first_name:      (name.split(/\s+/)[0] || '').trim(),
        // Status
        active:          isActive,
        expired:         expired,
        date_sent:       dateSent,
        days_remaining:  daysLeft,
        // Session selection state
        locked:          locked,
        saved_selections: savedIds.map(id => {
          const s = byId[id];
          return s ? { session_id: id, name: s.name, day: s.day, time: s.time, emoji: s.emoji } : { session_id: id, name: id };
        }),
        first_clicked_at: firstClicked
      });
    }

    // Newest pass first (by date_sent desc)
    passes.sort((a, b) => {
      const da = parseSheetDate(a.date_sent); const db = parseSheetDate(b.date_sent);
      const ta = da ? da.getTime() : 0;
      const tb = db ? db.getTime() : 0;
      return tb - ta;
    });
  } catch (err) {
    console.error('lul lounge-data error:', err.message);
    passes = []; sessions = [];
  }

  return res.status(200).json({ passes, sessions, page_copy: pageCopy });
}

// ── readJsonBody helper ───────────────────────────────────
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

// ── PUT helper for writing to Sheets ───────────────────────
function putSheet(url, body, accessToken) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(body));
    const req = https.request(url, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type':  'application/json',
        'Content-Length': buf.length
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end',  () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('PUT ' + res.statusCode + ': ' + d));
        }
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject); req.write(buf); req.end();
  });
}

// ── Find a Sheet1 row by token (col G). Returns { row, rowIndex } or null. ─
function findPassByToken(passRows, passToken) {
  for (let i = 1; i < passRows.length; i++) {
    if ((passRows[i][6] || '').toString().trim() === passToken) {
      return { row: passRows[i], rowIndex: i + 1 };  // 1-indexed for Sheets
    }
  }
  return null;
}

// ── Build a session object with time-lock state — used by pick-data ─
function buildSessionWithLock(r, includeRegardless) {
  const sid = (r[7] || '').toString().trim();
  if (!sid) return null;
  const active = (r[8] || '').toString().toUpperCase().trim();
  const blackedOut = inBlackoutWindow(r[9], r[10]);
  if (!includeRegardless) {
    if (active && active !== 'YES') return null;
    if (blackedOut) return null;
  }

  const day  = (r[3] || '').toString();
  const time = (r[4] || '').toString();
  const link = (r[6] || '').toString().trim();
  const startUtc = nextOccurrenceUtcMs(day, time);
  // Matches the 5/35-min unlock window used by get-sessions.js and
  // track-join.js (was previously 15/45 here; bumped 2026-05-25 for
  // consistency).
  const UNLOCK_BEFORE_MS = 5  * 60 * 1000;
  const LOCK_AFTER_MS    = 35 * 60 * 1000;
  const nowMs = Date.now();
  // Blacked-out sessions never count as unlocked, even if the time
  // window happens to be open. We also strip the link from the
  // response so the client literally can't render a clickable link.
  const inTimeWindow = startUtc !== null
    && nowMs >= (startUtc - UNLOCK_BEFORE_MS)
    && nowMs <= (startUtc + LOCK_AFTER_MS);
  const isUnlocked = inTimeWindow && !blackedOut;

  return {
    session_id:  sid,
    name:        (r[0] || '').toString(),
    emoji:       (r[1] || '').toString(),
    coach:       (r[2] || '').toString(),
    day:         day,
    time:        time,
    description: (r[5] || '').toString(),
    link:        isUnlocked ? link : '',
    is_unlocked: isUnlocked,
    session_start_iso: startUtc !== null ? new Date(startUtc).toISOString() : null,
    blacked_out: blackedOut
  };
}

// ── handlePickData ────────────────────────────────────────
// GET /api/lul/pick-data?pass=<token>
// Returns the pass + this week's sessions for the picker UI.
// Token is a row LOCATOR, not a credential — auth still requires
// a signed-in session AND the row's email must match.
async function handlePickData(req, res) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'not_authenticated' });
  const myEmail = (session.email || '').toLowerCase().trim();

  const passToken = (req.query.pass || '').toString().trim();
  if (!passToken) return res.status(400).json({ error: 'bad_request', detail: 'pass token required' });

  try {
    const token = await getAccessToken();
    const sheet = await batchGet(token, [PASS_RANGE, SESSIONS_RANGE, ATTENDANCE_RANGE]);
    const ranges = (sheet && sheet.valueRanges) || [];
    const passRows       = (ranges[0] && ranges[0].values) || [];
    const sessionRows    = (ranges[1] && ranges[1].values) || [];
    const attendanceRows = (ranges[2] && ranges[2].values) || [];

    const found = findPassByToken(passRows, passToken);
    if (!found) return res.status(404).json({ error: 'not_found' });

    const rowEmail = (found.row[2] || '').toString().toLowerCase().trim();
    if (rowEmail !== myEmail) return res.status(403).json({ error: 'forbidden' });

    const r = found.row;
    const expType  = (r[0] || '').toString();
    const name     = (r[1] || '').toString();
    const dateSent = (r[8] || '').toString();
    const isActive =
      r[7] === true || r[7] === 'TRUE' || r[7] === 'true' || r[7] === 1 || r[7] === '1';
    const locked   = (r[9] || '').toString().toUpperCase().trim() === 'YES';
    const savedRaw = (r[10] || '').toString().trim();
    const savedSelections = savedRaw
      ? savedRaw.split(',').map(s => s.trim()).filter(Boolean)
      : [];
    const daysLeft = daysRemainingFromSent(dateSent);
    const expired  = !isActive || (daysLeft !== null && daysLeft < 0);
    const mode     = passModeFromExpType(expType);

    // Compute which of the saved picks the student has actually attended
    // (defined as: a LUL_Attendance row exists with this pass's token and
    // this session_id). Attended picks are immutable on the client; only
    // unattended picks can be swapped.
    const attendedSet = new Set();
    for (let i = 1; i < attendanceRows.length; i++) {
      const ar = attendanceRows[i] || [];
      const sid    = (ar[3] || '').toString().trim();
      const atok   = (ar[6] || '').toString().trim();
      if (sid && atok === passToken) attendedSet.add(sid);
    }
    const attendedSessionIds = Array.from(attendedSet);

    const pass = {
      pass_token:           passToken,
      experience_type:      expType,
      pass_mode:            mode,
      pass_label:           passLabelFromMode(mode),
      name:                 name,
      first_name:           (name.split(/\s+/)[0] || '').trim(),
      active:               isActive,
      expired:              expired,
      date_sent:            dateSent,
      days_remaining:       daysLeft,
      locked:               locked,
      saved_selections:     savedSelections,
      attended_session_ids: attendedSessionIds
    };

    // Build sessions list. If locked, force-include the student's
    // saved sessions even if inactive/blackout (so confirmed view
    // can still render them).
    const includeSet = new Set(locked ? savedSelections : []);
    const sessions = [];
    for (let i = 1; i < sessionRows.length; i++) {
      const sObj = buildSessionWithLock(sessionRows[i], includeSet.has((sessionRows[i][7] || '').toString().trim()));
      if (sObj) sessions.push(sObj);
    }

    // Order by day-of-week then by time string
    const dayOrder = { 'mon':1,'monday':1,'tue':2,'tuesday':2,'wed':3,'wednesday':3,'thu':4,'thursday':4,'fri':5,'friday':5,'sat':6,'saturday':6,'sun':7,'sunday':7 };
    sessions.sort((a, b) => {
      const ao = dayOrder[(a.day || '').toLowerCase()] || 9;
      const bo = dayOrder[(b.day || '').toLowerCase()] || 9;
      if (ao !== bo) return ao - bo;
      return (a.time || '').localeCompare(b.time || '');
    });

    return res.status(200).json({ pass, sessions });
  } catch (err) {
    console.error('lul pick-data error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }
}

// ── handleSavePick ────────────────────────────────────────
// POST /api/lul/save-pick
//   body: { pass: <token>, selections: [<session_id>...] }
// Writes Sheet1 cols J=YES, K=comma-joined selections, L=timestamp.
// Same shape as the legacy save-selections.js so data stays
// consistent across both flows.
async function handleSavePick(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'not_authenticated' });
  const myEmail = (session.email || '').toLowerCase().trim();

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  const passToken  = (body.pass || '').toString().trim();
  const selections = Array.isArray(body.selections) ? body.selections : [];
  if (!passToken)        return res.status(400).json({ error: 'bad_request', detail: 'pass required' });
  if (!selections.length) return res.status(400).json({ error: 'no_selections' });

  let writeToken;
  try { writeToken = await getAccessToken('https://www.googleapis.com/auth/spreadsheets'); }
  catch (err) {
    console.error('save-pick token error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  let passRows, attendanceRows;
  try {
    const sheet = await batchGet(writeToken, [PASS_RANGE, ATTENDANCE_RANGE]);
    const vr = (sheet && sheet.valueRanges) || [];
    passRows       = (vr[0] && vr[0].values) || [];
    attendanceRows = (vr[1] && vr[1].values) || [];
  } catch (err) {
    console.error('save-pick read error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  const found = findPassByToken(passRows, passToken);
  if (!found) return res.status(404).json({ error: 'not_found' });

  const rowEmail = (found.row[2] || '').toString().toLowerCase().trim();
  if (rowEmail !== myEmail) return res.status(403).json({ error: 'forbidden' });

  // Pass-mode-specific selection count validation
  const mode = passModeFromExpType((found.row[0] || '').toString());
  if (mode === 'two' && selections.length !== 2) {
    return res.status(400).json({ error: 'wrong_count', expected: 2, got: selections.length });
  }
  if (mode === 'celebration' && selections.length !== 1) {
    return res.status(400).json({ error: 'wrong_count', expected: 1, got: selections.length });
  }

  // Attended picks are immutable. Reject the save if the new selections
  // drop a session_id that the student has already attended (i.e. a row
  // in LUL_Attendance with this pass's token + that session_id).
  const newSet = new Set(selections.map(s => String(s).trim()).filter(Boolean));
  const attendedSet = new Set();
  for (let i = 1; i < attendanceRows.length; i++) {
    const ar = attendanceRows[i] || [];
    const sid  = (ar[3] || '').toString().trim();
    const atok = (ar[6] || '').toString().trim();
    if (sid && atok === passToken) attendedSet.add(sid);
  }
  const removedAttended = [];
  attendedSet.forEach(sid => { if (!newSet.has(sid)) removedAttended.push(sid); });
  if (removedAttended.length) {
    return res.status(409).json({
      error: 'attended_pick_removed',
      detail: 'You can\'t change a session you\'ve already attended.',
      attended_session_ids: removedAttended
    });
  }

  const cleaned = selections.map(s => String(s).trim()).filter(Boolean).join(',');
  const writeRange = `Sheet1!J${found.rowIndex}:L${found.rowIndex}`;
  const writeUrl   = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(writeRange)}?valueInputOption=USER_ENTERED`;

  try {
    await putSheet(writeUrl, {
      range: writeRange,
      majorDimension: 'ROWS',
      values: [[ 'YES', cleaned, new Date().toISOString() ]]
    }, writeToken);
  } catch (err) {
    console.error('save-pick write error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(200).json({ ok: true });
}

// ── Dispatch ────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const action = (req.query.action || '').toString();
  switch (action) {
    case 'lounge-data': return handleLoungeData(req, res);
    case 'pick-data':   return handlePickData(req, res);
    case 'save-pick':   return handleSavePick(req, res);
    default:            return res.status(404).json({ error: 'not_found', detail: action });
  }
};
