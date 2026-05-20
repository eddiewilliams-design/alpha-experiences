// ============================================================
// ALPHA EXPERIENCES — GET SESSIONS API  v3
// Vercel Serverless Function — Service Account Auth
// GET /api/get-sessions
// GET /api/get-sessions?include=blooket,improv
//   → ?include= forces those session IDs to appear even if
//     inactive or within a coach blackout window.
//     Used by lul.html for students who already locked in.
//
// Time-lock (v3): Sessions are weekly (same day-of-week, same
// time). For each session we compute the NEXT occurrence in
// Chicago time and only include the actual `link` field when
// the current time is inside [start − 5 min, start + 35 min].
// Outside that window, link is omitted entirely (never sent to
// the browser). The picker re-polls /api/get-sessions every 30s
// so the link auto-appears when the unlock window opens.
//
// Sessions tab column layout (A–K):
//   A (0)  Name
//   B (1)  Emoji
//   C (2)  Coach
//   D (3)  Day             ← "MON"/"TUE"/etc. (case-insensitive)
//   E (4)  Time            ← "12:00 PM CT" (CT/CST/CDT suffix optional)
//   F (5)  Description
//   G (6)  Link
//   H (7)  Session ID  ← stable unique slug, e.g. "blooket"
//   I (8)  Active      ← YES / NO
//   J (9)  Blackout Start  ← date (leave blank if not needed)
//   K (10) Blackout End    ← date (leave blank if not needed)
// ============================================================

const TZ                  = 'America/Chicago';
const UNLOCK_BEFORE_MS    = 5  * 60 * 1000; // 5 min before start
const LOCK_AFTER_MS       = 35 * 60 * 1000; // 35 min after start (30 min session + 5 min grace)

const DAY_MAP = {
  SUN:0, SUNDAY:0,
  MON:1, MONDAY:1,
  TUE:2, TUES:2, TUESDAY:2,
  WED:3, WEDS:3, WEDNESDAY:3,
  THU:4, THUR:4, THURS:4, THURSDAY:4,
  FRI:5, FRIDAY:5,
  SAT:6, SATURDAY:6
};

// Returns ms by which the tz is ahead of UTC at the given UTC instant.
// Same trick used in api/trips/[tripId].js for the VFT time-lock.
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
  if (h === 24) h = 0;
  const fakeUtcMs = Date.UTC(g('year', 1970), g('month', 1) - 1, g('day', 1), h, g('minute', 0), g('second', 0));
  return fakeUtcMs - utcMs;
}

// "12:00 PM CT" / "12:00 PM" / "14:00" → { hh, mm }. Strips CT/CST/CDT suffix.
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

// Find current Chicago wall-time components (year, month, date, day-of-week).
function chicagoNowParts() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
  });
  const parts = fmt.formatToParts(new Date());
  const g = t => parts.find(p => p.type === t).value;
  return {
    Y: parseInt(g('year'), 10),
    M: parseInt(g('month'), 10),
    D: parseInt(g('day'), 10),
    weekday: DAY_MAP[g('weekday').toUpperCase()]
  };
}

// Returns UTC-ms of the next occurrence of (dayStr at timeStr) in Chicago,
// skipping forward by 7 days if this week's occurrence is past its lock window.
function nextOccurrenceUtcMs(dayStr, timeStr) {
  const targetDay = DAY_MAP[String(dayStr || '').toUpperCase().trim()];
  if (targetDay === undefined) return null;
  const t = parseTimeWithCT(timeStr);
  if (!t) return null;

  const todayCT = chicagoNowParts();
  const daysAhead = (targetDay - todayCT.weekday + 7) % 7;

  function buildUtc(daysOffset) {
    const naive = Date.UTC(todayCT.Y, todayCT.M - 1, todayCT.D + daysOffset, t.hh, t.mm, 0);
    return naive - tzOffsetMs(naive, TZ);
  }

  let startUtc = buildUtc(daysAhead);
  if (startUtc + LOCK_AFTER_MS < Date.now()) {
    // Today's window has closed — use next week's
    startUtc = buildUtc(daysAhead + 7);
  }
  return startUtc;
}

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

      // Compute time-lock state from the next weekly occurrence
      const startUtc = nextOccurrenceUtcMs(day, time);
      const nowMs    = Date.now();
      const isUnlocked = startUtc !== null
        && nowMs >= (startUtc - UNLOCK_BEFORE_MS)
        && nowMs <= (startUtc + LOCK_AFTER_MS);

      // Server is the gatekeeper: never send the link until unlock.
      const safeLink = isUnlocked ? link : '';

      sessions.push({
        id, name, emoji, coach, day, time, description,
        link: safeLink,
        is_unlocked:        isUnlocked,
        unlock_at_iso:      startUtc !== null ? new Date(startUtc - UNLOCK_BEFORE_MS).toISOString() : null,
        session_start_iso:  startUtc !== null ? new Date(startUtc).toISOString() : null
      });
    }

    return res.status(200).json({ sessions });

  } catch (err) {
    console.error('get-sessions error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }
};
