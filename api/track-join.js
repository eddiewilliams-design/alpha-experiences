// ============================================================
// ALPHA EXPERIENCES — TRACK JOIN API
// Vercel Serverless Function — Service Account Auth
// GET /api/track-join?token=XXXXXXXX&dest=ENCODED_ZOOM_URL
//
// What it does:
//   1. Resolves token → student row in Sheet1.
//   2. Writes "Date First Clicked" to col M (once only — preserved
//      for backward compat with existing reports).
//   3. NEW: Appends a row to LUL_Attendance for EVERY click — so
//      admins can see exactly which sessions each student joined,
//      and how often. Matches the dest URL against the Sessions
//      tab to resolve session_id + session_name when possible.
//   4. Always redirects to the Zoom link — a logging failure never
//      blocks the student.
//
// Required tab: LUL_Attendance with header row in row 1:
//   A: clicked_at | B: student_email | C: student_name
//   D: session_id | E: session_name  | F: zoom_url | G: token
//   H: in_picks   (YES if this session was one the student had
//                  locked in via Sheet1 col K; NO if outside their
//                  picks; blank if they had no saved selections)
// If the tab doesn't exist yet, the append fails silently and is
// logged to Vercel — the student is still redirected normally.
// ============================================================
const https = require('https');
const crypto = require('crypto');

const SHEET_ID = '1aQYysCOOR-mYG8Myrl1BSU2PF8wMl-si8pgNG89sRto';

function b64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

function makeJWT(sa) {
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const pay = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const data = hdr + '.' + pay;
  const sig = crypto.createSign('RSA-SHA256').update(data).sign(sa.private_key, 'base64')
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  return data + '.' + sig;
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body);
    const opts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
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

function postSheet(url, body, token) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(body));
    const opts = {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Length': buf.length
      }
    };
    const req = https.request(url, opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        // Surface non-2xx so the outer try/catch can log a useful message
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('append HTTP ' + res.statusCode + ': ' + d));
        }
        try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

function escHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

function renderAlreadyAttendedPage({ studentName, sessionName }) {
  const name = escHtml(studentName);
  const session = escHtml(sessionName);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Already attended — Alpha Experiences</title>
<link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;700;800&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Be Vietnam Pro',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#FAFAFA;color:#072256;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
  .card{max-width:480px;width:100%;background:#fff;border-radius:20px;border:1.5px solid #DADFE7;padding:36px 32px;text-align:center;box-shadow:0 4px 20px rgba(7,34,86,0.08);}
  .icon{font-size:48px;margin-bottom:14px;}
  .pre{font-size:11px;font-weight:800;color:#E59500;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:8px;}
  h1{font-size:22px;font-weight:800;line-height:1.2;letter-spacing:-0.01em;margin-bottom:10px;}
  p{font-size:14px;line-height:1.6;color:#072256;margin-bottom:8px;}
  p.sub{color:#8291AA;font-size:13px;}
  .cta{display:inline-block;margin-top:18px;padding:14px 32px;background:#006FF9;color:#fff;font-size:15px;font-weight:800;text-decoration:none;border-radius:999px;letter-spacing:0.02em;}
</style>
</head>
<body>
  <div class="card">
    <div class="icon">🎟️</div>
    <div class="pre">One-time use link</div>
    <h1>You've already attended this session</h1>
    <p>Each Zoom link is one-time use, ${name}. It looks like you already joined <strong>${session}</strong> earlier.</p>
    <p class="sub">If you think this is a mistake, reply to your welcome email and we'll take a look.</p>
    <a class="cta" href="/lounge">← Back to my Lounge passes</a>
  </div>
</body>
</html>`;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = (req.query.token || '').trim();
  const dest  = (req.query.dest  || '').trim();

  // Always need a destination — if missing, fall back to the app home
  const redirectTo = dest ? decodeURIComponent(dest) : 'https://alpha-experiences.vercel.app';

  // If no token or no service account, just redirect immediately
  if (!token || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return res.redirect(302, redirectTo);
  }

  try {
    const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const jwt = makeJWT(sa);

    const tokenRes = await post(
      'https://oauth2.googleapis.com/token',
      'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
    );
    const accessToken = tokenRes.access_token;
    if (!accessToken) return res.redirect(302, redirectTo);

    // batchGet: pull Sheet1 + Sessions (URL → session match) + LUL_Attendance
    // (so we can compute Fulfilled threshold after this click) + LUL_Pass_Types
    // (gives us the pick count for this row's pass mode) — one round trip.
    const ranges = ['Sheet1!A:N', 'Sessions!A:K', 'LUL_Attendance!A:H', 'LUL_Pass_Types!A:E'];
    const params = ranges.map(r => 'ranges=' + encodeURIComponent(r)).join('&');
    const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchGet?${params}`;
    const batch = await getSheet(batchUrl, accessToken);
    const valueRanges    = (batch && batch.valueRanges) || [];
    const passRows       = (valueRanges[0] && valueRanges[0].values) || [];
    const sessionRows    = (valueRanges[1] && valueRanges[1].values) || [];
    const attendanceRows = (valueRanges[2] && valueRanges[2].values) || [];
    const passTypesRows  = (valueRanges[3] && valueRanges[3].values) || [];

    // Find the token row in Sheet1
    let matched = null;
    for (let i = 1; i < passRows.length; i++) {
      const rowToken = (passRows[i][6] || '').toString().trim(); // col G
      if (rowToken === token) {
        matched = { row: passRows[i], rowIndex: i + 1 };
        break;
      }
    }

    if (matched) {
      const studentName    = (matched.row[1] || '').toString();   // col B
      const studentEmail   = (matched.row[2] || '').toString();   // col C
      const alreadySet     = (matched.row[12] || '').toString().trim(); // col M
      // col K = comma-separated locked-in session slugs
      const savedSelections = (matched.row[10] || '').toString().trim()
        .split(',').map(s => s.trim()).filter(Boolean);

      // Existing behavior: write Date First Clicked to col M (once only)
      if (!alreadySet) {
        const clickedAt  = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
        const writeRange = `Sheet1!M${matched.rowIndex}`;
        const writeUrl   = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(writeRange)}?valueInputOption=RAW`;
        try {
          await putSheet(writeUrl, {
            range: writeRange,
            majorDimension: 'ROWS',
            values: [[clickedAt]]
          }, accessToken);
        } catch (err) {
          console.error('track-join: col M write failed:', err.message);
        }
      }

      // NEW: append every click to LUL_Attendance
      // Match the dest URL against Sessions col G to resolve session_id + name.
      let sessionId = '';
      let sessionName = '';
      for (let i = 1; i < sessionRows.length; i++) {
        const link = (sessionRows[i][6] || '').toString().trim(); // col G
        if (link && link === redirectTo) {
          sessionName = (sessionRows[i][0] || '').toString(); // col A
          sessionId   = (sessionRows[i][7] || '').toString(); // col H
          break;
        }
      }

      // ── One-time use enforcement ──
      // If this student has already clicked this same session_id more than
      // 90 minutes ago THROUGH THIS SAME PASS, treat it as a re-use attempt
      // and block. The 90-min grace covers double-clicks + the full unlock
      // window (15 min before start to 45 min after) + safety margin.
      //
      // Important: we filter by col G (pass token) so an old click made on
      // a PRIOR pass doesn't block a new pass. Without that filter, a
      // student who attended Themed Blooket Bash on their old pass could
      // never re-attend it on a future pass — the system would think
      // they already used the one-time link. Legacy rows with no token
      // in col G fall through to the original behavior (block on any
      // prior click) so we don't lose the safety net for old data.
      if (sessionId) {
        const GRACE_MS = 90 * 60 * 1000;
        const nowMs = Date.now();
        const emailLower = studentEmail.toLowerCase();
        for (let i = 1; i < attendanceRows.length; i++) {
          const ar = attendanceRows[i] || [];
          const ae = (ar[1] || '').toString().toLowerCase().trim();
          const asid = (ar[3] || '').toString().trim();
          if (ae !== emailLower || asid !== sessionId) continue;
          // Only block on clicks that came through THIS pass. Skip rows
          // tagged with a different pass token. Empty token = legacy row
          // → fall through to keep the original safety behavior.
          const arToken = (ar[6] || '').toString().trim();
          if (arToken && arToken !== token) continue;
          const ts = (ar[0] || '').toString();
          const tsMs = ts ? new Date(ts).getTime() : null;
          if (tsMs == null || isNaN(tsMs)) continue;
          if (nowMs - tsMs > GRACE_MS) {
            // Block — already used this session in a prior occurrence
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.status(200).send(renderAlreadyAttendedPage({
              studentName: studentName || 'there',
              sessionName: sessionName || 'this session'
            }));
          }
        }
      }

      // in_picks: was this clicked session one the student locked in?
      // YES if their saved selections include this session slug.
      // NO if they have selections but this isn't one of them.
      // Blank if they have no saved selections at all (e.g. unconfirmed pass).
      let inPicks = '';
      if (savedSelections.length) {
        inPicks = (sessionId && savedSelections.indexOf(sessionId) !== -1) ? 'YES' : 'NO';
      }

      const clickedAtIso = new Date().toISOString();
      const appendUrl =
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/` +
        `${encodeURIComponent('LUL_Attendance!A:H')}` +
        `:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
      try {
        await postSheet(appendUrl, {
          range: 'LUL_Attendance!A:H',
          majorDimension: 'ROWS',
          values: [[
            clickedAtIso,
            studentEmail,
            studentName,
            sessionId,
            sessionName,
            redirectTo,
            token,
            inPicks
          ]]
        }, accessToken);
      } catch (err) {
        // Most likely cause: the LUL_Attendance tab doesn't exist yet.
        // Don't block the student — just log so admin sees it in Vercel logs.
        console.error('track-join: LUL_Attendance append failed (does the tab exist?):', err.message);
      }

      // ── Auto-stamp Fulfilled='Yes' if this click crosses the threshold ──
      // The threshold is the pick count from LUL_Pass_Types (with legacy
      // fallback if the row's Experience Type isn't configured). This keeps
      // Sheet1 col F in sync with reality without admin needing to edit it.
      try {
        const expTypeLower = (matched.row[0] || '').toString().toLowerCase().trim();

        let mode = '';
        let pickCount = null;
        for (let i = 1; i < passTypesRows.length; i++) {
          const r = passTypesRows[i] || [];
          if ((r[0] || '').toString().toLowerCase().trim() === expTypeLower) {
            mode = (r[1] || '').toString().toLowerCase().trim();
            const pcRaw = (r[2] == null ? '' : r[2]).toString().trim();
            pickCount = pcRaw && /^\d+$/.test(pcRaw) ? parseInt(pcRaw, 10) : null;
            break;
          }
        }
        // Legacy fallback (matches Apps Script's hardcoded detection)
        if (!mode) {
          if (expTypeLower.indexOf('friday coaching celebration') !== -1) {
            mode = 'celebration'; pickCount = 1;
          } else if (expTypeLower.indexOf('2 sessions') !== -1) {
            mode = 'pick';        pickCount = 2;
          } else {
            mode = 'full';        pickCount = null;
          }
        }

        // How many sessions does this pass need attended to be 'Used'?
        // - pick / celebration: pickCount (or savedSelections length, or 1)
        // - full: # of sessions saved (if any) — admin doesn't pick for full passes,
        //         so attendance count vs. saved is the best proxy.
        let required;
        if (mode === 'pick' || mode === 'celebration') {
          required = pickCount || savedSelections.length || 1;
        } else {
          required = savedSelections.length;
        }

        if (required > 0) {
          // Count UNIQUE attended sessions (in THIS pass's picks) for this
          // student — but ONLY clicks that came through THIS pass's token.
          //
          // Without the token filter, an old click from a PRIOR pass whose
          // session_id happens to be in the NEW pass's selections would
          // count toward this pass's "attended" total and incorrectly
          // trigger Fulfilled=Yes on the new pass (same cross-pass leakage
          // pattern fixed in computePassStatus and handleLoungeAttendanceList).
          // Legacy rows with no token in col G fall through to count, so we
          // don't lose accounting for clicks logged before the token column
          // was wired up.
          const studentEmailLower = studentEmail.toLowerCase();
          const attended = new Set();
          for (let i = 1; i < attendanceRows.length; i++) {
            const ar = attendanceRows[i] || [];
            const ae = (ar[1] || '').toString().toLowerCase().trim();
            const sid = (ar[3] || '').toString().trim();
            if (ae !== studentEmailLower || !sid) continue;
            if (savedSelections.indexOf(sid) === -1) continue;
            // Token attribution: skip clicks tagged with a different pass.
            const arToken = (ar[6] || '').toString().trim();
            if (arToken && arToken !== token) continue;
            attended.add(sid);
          }
          // Include this current click (just appended above with this pass's token)
          if (sessionId && savedSelections.indexOf(sessionId) !== -1) {
            attended.add(sessionId);
          }

          if (attended.size >= required) {
            const currentFulfilled = (matched.row[5] || '').toString().trim().toLowerCase();
            if (currentFulfilled !== 'yes') {
              const writeRange = `Sheet1!F${matched.rowIndex}`;
              const writeUrl   = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(writeRange)}?valueInputOption=USER_ENTERED`;
              await putSheet(writeUrl, {
                range: writeRange,
                majorDimension: 'ROWS',
                values: [['Yes']]
              }, accessToken);
            }
          }
        }
      } catch (err) {
        console.error('track-join: Fulfilled auto-stamp failed:', err.message);
      }
    }
  } catch(err) {
    // Log but never block the redirect
    console.error('track-join error:', err.message);
  }

  return res.redirect(302, redirectTo);
};
