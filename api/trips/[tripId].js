// ============================================================
// ALPHA EXPERIENCES — TRIP DETAIL
// GET /api/trips/[trip-id]
//
// Returns the trip, all sessions for it, prep items, and which
// session belongs to the logged-in student. Computes lock state
// server-side using America/Chicago wall-clock times → UTC.
//
// Zoom/Nearpod links are NEVER sent to the browser unless the
// student is the owner AND the unlock window has opened
// (15 minutes before their session start). This is the only
// thing protecting links from being shared.
//
// 200 → { trip, sessions[], prep[], my_session_id, now_iso }
// 401 → { error: "not_authenticated" }
// 404 → { error: "not_purchased" }   (also returned when the
//                                      trip doesn't exist, so we
//                                      don't leak existence)
// ============================================================

const { getSession, httpsGet } = require('../_lib/session.js');
const https  = require('https');
const crypto = require('crypto');

const SHEET_ID  = '1aQYysCOOR-mYG8Myrl1BSU2PF8wMl-si8pgNG89sRto';
const TZ        = 'America/Chicago';
const RANGES    = ['FT_Catalog!A:M', 'FT_Sessions!A:F', 'FT_Prep!A:F', 'FT_Purchases!A:I'];
// Unlock window: [start − UNLOCK_BEFORE_MS, end + GRACE_AFTER_MS].
// If end_time is missing or unparseable we assume FALLBACK_LEN_MS after start.
const UNLOCK_BEFORE_MS = 15 * 60 * 1000;       // open 15 min before start
const GRACE_AFTER_MS   = 60 * 60 * 1000;       // re-lock 1 hour after end_time
const FALLBACK_LEN_MS  = 90 * 60 * 1000;       // assume 90-min session if no end_time

// ── Sheets access ───────────────────────────────────────────
function b64url(str) {
  return Buffer.from(str).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function makeJWT(sa) {
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const pay = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
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
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(buf); req.end();
  });
}
async function getAccessToken() {
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');
  const sa  = JSON.parse(saJson);
  const jwt = makeJWT(sa);
  const r = await postForm(
    'https://oauth2.googleapis.com/token',
    'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
  );
  if (!r.access_token) throw new Error('no access token from Google');
  return r.access_token;
}
async function fetchSheet(token) {
  const params = RANGES.map(r => 'ranges=' + encodeURIComponent(r)).join('&');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchGet?${params}`;
  return httpsGet(url, { Authorization: 'Bearer ' + token });
}

// ── Time helpers (no external libs — uses Intl for DST) ─────
// Returns the offset in milliseconds that `tz` is ahead of UTC at the given UTC instant.
// For America/Chicago: -18000000 (CST) or -21600000 (CDT).
function tzOffsetMs(utcMs, tz) {
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
  if (h === 24) h = 0; // some locales return "24" for midnight
  const fakeUtcMs = Date.UTC(g('year', 1970), g('month', 1) - 1, g('day', 1), h, g('minute', 0), g('second', 0));
  return fakeUtcMs - utcMs;
}

function parseTime12(s) {
  // "2:00 PM" / "2:00PM" / "14:00" → { hh, mm }
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ap = (m[3] || '').toUpperCase();
  if (ap === 'PM' && hh < 12) hh += 12;
  if (ap === 'AM' && hh === 12) hh = 0;
  if (hh > 23 || mm > 59 || hh < 0 || mm < 0) return null;
  return { hh, mm };
}

function sessionStartUtcMs(tripDate, startTime) {
  const dm = String(tripDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dm) return null;
  const t = parseTime12(startTime);
  if (!t) return null;
  const Y = parseInt(dm[1], 10), M = parseInt(dm[2], 10), D = parseInt(dm[3], 10);
  // Naive UTC-interpretation of the wall time
  const naive = Date.UTC(Y, M - 1, D, t.hh, t.mm, 0);
  // Correct by the tz's offset at that instant
  return naive - tzOffsetMs(naive, TZ);
}

// ── Handler ─────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'not_authenticated' });

  const tripId = (req.query.tripId || '').toString().trim();
  if (!tripId) return res.status(404).json({ error: 'not_purchased' });

  const myEmail = (session.email || '').toLowerCase().trim();

  let token, sheet;
  try {
    token = await getAccessToken();
    sheet = await fetchSheet(token);
  } catch (err) {
    console.error('trips/[tripId] sheet error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }

  const ranges       = (sheet && sheet.valueRanges) || [];
  const catalogRows  = (ranges[0] && ranges[0].values) || [];
  const sessionRows  = (ranges[1] && ranges[1].values) || [];
  const prepRows     = (ranges[2] && ranges[2].values) || [];
  const purchaseRows = (ranges[3] && ranges[3].values) || [];

  // 1. Find the trip
  let trip = null;
  for (let i = 1; i < catalogRows.length; i++) {
    const r = catalogRows[i];
    if ((r[0] || '').toString().trim() === tripId) {
      trip = {
        trip_id:           tripId,
        title:             (r[1] || '').toString(),
        description:       (r[2] || '').toString(),
        emoji:             (r[3] || '').toString(),
        trip_date:         (r[4] || '').toString(),
        status:            (r[5] || '').toString().toLowerCase(),
        reflection_prompt: (r[7] || '').toString(),
        what_to_bring:     (r[9]  || '').toString().trim() || 'Notebook, pencil, curiosity',
        format:            (r[10] || '').toString().trim() || 'Zoom + Nearpod',
        hero_image_url:    (r[11] || '').toString().trim(),
        theme_emojis:      (r[12] || '').toString().trim()
      };
      break;
    }
  }

  // 2. Verify the student purchased it (404 if not — don't leak trip existence)
  let mySessionId = '';
  for (let i = 1; i < purchaseRows.length; i++) {
    const r = purchaseRows[i];
    const email     = (r[1] || '').toString().toLowerCase().trim();
    const sessionId = (r[3] || '').toString().trim();
    const purchTrip = (r[4] || '').toString().trim();
    const status    = (r[6] || '').toString().toLowerCase().trim();
    if (email === myEmail && purchTrip === tripId && (!status || status === 'active')) {
      mySessionId = sessionId;
      break;
    }
  }

  if (!trip || !mySessionId) {
    return res.status(404).json({ error: 'not_purchased' });
  }
  // Drafts are admin-side only — even a registered student gets 404 here.
  // Publish (status=open) before students should see the detail page.
  if (trip.status === 'draft') {
    return res.status(404).json({ error: 'not_purchased' });
  }

  // 3. Sessions for this trip — with lock state
  const nowMs = Date.now();
  const sessions = [];
  for (let i = 1; i < sessionRows.length; i++) {
    const r = sessionRows[i];
    const sid     = (r[0] || '').toString().trim();
    const sTrip   = (r[1] || '').toString().trim();
    if (!sid || sTrip !== tripId) continue;

    const start    = (r[2] || '').toString();
    const end      = (r[3] || '').toString();
    const zoom     = (r[4] || '').toString().trim();
    const nearpod  = (r[5] || '').toString().trim();

    const isYours    = (sid === mySessionId);
    const startUtc   = sessionStartUtcMs(trip.trip_date, start);
    let   endUtc     = sessionStartUtcMs(trip.trip_date, end);
    // Handle sessions that wrap past midnight (e.g. 11:30 PM → 12:30 AM)
    if (endUtc !== null && startUtc !== null && endUtc <= startUtc) {
      endUtc += 24 * 60 * 60 * 1000;
    }
    if (endUtc === null && startUtc !== null) {
      endUtc = startUtc + FALLBACK_LEN_MS;
    }
    const isUnlocked =
      startUtc !== null &&
      nowMs >= (startUtc - UNLOCK_BEFORE_MS) &&
      nowMs <= (endUtc   + GRACE_AFTER_MS);

    const isPast =
      startUtc !== null &&
      endUtc   !== null &&
      nowMs > (endUtc + GRACE_AFTER_MS);

    const session_obj = {
      session_id:  sid,
      start_time:  start,
      end_time:    end,
      is_yours:    isYours,
      is_unlocked: isUnlocked,
      is_past:     isPast,
      zoom_link:   null,
      nearpod_link: null
    };

    // Only include links to the OWNER, AND only when unlocked.
    // Anyone inspecting the response for another session never sees them.
    if (isYours && isUnlocked) {
      session_obj.zoom_link    = zoom    || null;
      session_obj.nearpod_link = nearpod || null;
    }

    sessions.push(session_obj);
  }

  // Order sessions by start time
  sessions.sort((a, b) => {
    const aT = parseTime12(a.start_time); const bT = parseTime12(b.start_time);
    const aMin = aT ? aT.hh * 60 + aT.mm : 9999;
    const bMin = bT ? bT.hh * 60 + bT.mm : 9999;
    return aMin - bMin;
  });

  // 4. Prep items for this trip
  const prep = [];
  for (let i = 1; i < prepRows.length; i++) {
    const r = prepRows[i];
    const pid    = (r[0] || '').toString().trim();
    const pTrip  = (r[1] || '').toString().trim();
    if (!pid || pTrip !== tripId) continue;
    prep.push({
      prep_id:  pid,
      title:    (r[2] || '').toString(),
      type:     (r[3] || '').toString().toLowerCase(),
      url:      (r[4] || '').toString(),
      duration: (r[5] || '').toString()
    });
  }

  return res.status(200).json({
    trip:          trip,
    sessions:      sessions,
    prep:          prep,
    my_session_id: mySessionId,
    now_iso:       new Date(nowMs).toISOString()
  });
};
