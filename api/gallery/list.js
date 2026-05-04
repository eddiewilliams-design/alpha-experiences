// ============================================================
// ALPHA EXPERIENCES — GALLERY LIST
// GET /api/gallery/list
//   200 → { submissions: [...], trips: [{ trip_id, title, emoji }] }
//   401 → not_authenticated
//
// Open to any signed-in user with an allowed domain (the session
// cookie's existence already guarantees that). Returns ALL
// submissions across ALL trips, joined to trip titles/emojis,
// sorted newest-first.
//
// Student emails are intentionally NOT included in the response.
// `name` is the display name they typed at submission time, not
// their account email.
// ============================================================

const https  = require('https');
const crypto = require('crypto');
const { getSession, httpsGet } = require('../_lib/session.js');

const SHEET_ID = '1aQYysCOOR-mYG8Myrl1BSU2PF8wMl-si8pgNG89sRto';
const RANGES   = ['FT_Submissions!A:G', 'FT_Catalog!A:E'];

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

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'not_authenticated' });

  let submissions = [];
  let tripPills   = [];

  try {
    const token = await getAccessToken();
    const sheet = await fetchSheet(token);
    const ranges = (sheet && sheet.valueRanges) || [];
    const subRows  = (ranges[0] && ranges[0].values) || [];
    const tripRows = (ranges[1] && ranges[1].values) || [];

    // trip_id → { title, emoji }
    const tripsById = {};
    for (let i = 1; i < tripRows.length; i++) {
      const r = tripRows[i];
      const id = (r[0] || '').toString().trim();
      if (!id) continue;
      tripsById[id] = {
        trip_id: id,
        title:   (r[1] || '').toString(),
        emoji:   (r[3] || '').toString()
      };
    }

    const seenTripIds = new Set();
    for (let i = 1; i < subRows.length; i++) {
      const r = subRows[i];
      const tripId      = (r[1] || '').toString().trim();
      const displayName = (r[2] || '').toString();
      const location    = (r[3] || '').toString();
      const fileUrl     = (r[4] || '').toString().trim();
      const fileType    = (r[5] || '').toString().toLowerCase().trim();
      const submittedAt = (r[6] || '').toString().trim();
      if (!fileUrl) continue;

      const trip = tripsById[tripId] || { trip_id: tripId, title: tripId, emoji: '' };
      if (tripId) seenTripIds.add(tripId);

      submissions.push({
        trip_id:      tripId,
        trip_title:   trip.title,
        trip_emoji:   trip.emoji,
        name:         displayName,
        location:     location,
        file_url:     fileUrl,
        file_type:    fileType === 'video' ? 'video' : 'image',
        submitted_at: submittedAt
      });
    }

    // Newest first — string sort works for ISO 8601 UTC timestamps
    submissions.sort((a, b) => (b.submitted_at || '').localeCompare(a.submitted_at || ''));

    // Filter pills: only trips that have at least one submission, ordered by trip title
    tripPills = Array.from(seenTripIds).map(id => tripsById[id] || { trip_id: id, title: id, emoji: '' });
    tripPills.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  } catch (err) {
    console.error('gallery/list error:', err.message);
    submissions = [];
    tripPills   = [];
  }

  return res.status(200).json({ submissions, trips: tripPills });
};
