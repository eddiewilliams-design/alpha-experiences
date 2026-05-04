// ============================================================
// ALPHA EXPERIENCES — SHARED AUTH HELPERS
// Used by every /api/auth/* function and any future API that
// needs to identify the signed-in user. No npm packages — only
// Node built-ins (https, crypto), same approach as validate-token.js.
// ============================================================

const https  = require('https');
const crypto = require('crypto');

// Sheet that stores admin emails (FT_Admins tab, column A).
const SHEET_ID         = '1aQYysCOOR-mYG8Myrl1BSU2PF8wMl-si8pgNG89sRto';
const ADMIN_RANGE      = 'FT_Admins!A:A';
const ALLOWED_DOMAINS  = ['2hourlearning.com', 'alpha.school'];
const SESSION_COOKIE   = 'ae_session';
const STATE_COOKIE     = 'ae_oauth_state';
const SESSION_MAX_AGE  = 60 * 60 * 24 * 7; // 7 days

// ── base64url helpers ───────────────────────────────────────
function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(str) {
  str = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

// ── Cookie parsing & serialization ──────────────────────────
function parseCookies(req) {
  const out = {};
  const header = req.headers && req.headers.cookie;
  if (!header) return out;
  header.split(/; */).forEach(part => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function serializeCookie(name, value, opts) {
  opts = opts || {};
  const segments = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge != null) segments.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.path)           segments.push(`Path=${opts.path}`);
  if (opts.expires)        segments.push(`Expires=${opts.expires.toUTCString()}`);
  if (opts.httpOnly)       segments.push('HttpOnly');
  if (opts.secure)         segments.push('Secure');
  if (opts.sameSite)       segments.push(`SameSite=${opts.sameSite}`);
  return segments.join('; ');
}

// ── Session signing (HMAC-SHA256 over base64url(payload)) ───
function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error('SESSION_SECRET is missing or too short (need 32+ chars)');
  }
  return s;
}

function signSession(payload) {
  const body = b64urlEncode(JSON.stringify(payload));
  const sig  = crypto.createHmac('sha256', getSecret()).update(body).digest();
  return `${body}.${b64urlEncode(sig)}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig  = token.slice(dot + 1);
  const expected = b64urlEncode(
    crypto.createHmac('sha256', getSecret()).update(body).digest()
  );
  // Constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(body).toString('utf8')); }
  catch (e) { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}

function makeSessionCookie(payload) {
  const token = signSession(payload);
  return serializeCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure:   true,
    sameSite: 'Lax',
    path:     '/',
    maxAge:   SESSION_MAX_AGE
  });
}

function clearSessionCookie() {
  return serializeCookie(SESSION_COOKIE, '', {
    httpOnly: true,
    secure:   true,
    sameSite: 'Lax',
    path:     '/',
    maxAge:   0
  });
}

function getSession(req) {
  const cookies = parseCookies(req);
  return verifySession(cookies[SESSION_COOKIE]);
}

// ── Return-to (deep-link) sanitiser ────────────────────────
// Accepts only same-origin paths. Blocks open-redirect vectors
// like `//evil.com/foo` or `\\evil.com` and refuses to bounce
// the user back into the auth flow.
function sanitizeReturnTo(p) {
  if (!p || typeof p !== 'string') return '';
  const s = p.trim();
  if (s.length === 0 || s.length > 500)        return '';
  if (s[0] !== '/')                              return '';
  if (s.startsWith('//') || s.startsWith('/\\')) return '';
  if (s.indexOf('\\') !== -1)                    return '';
  if (s === '/auth' || s.startsWith('/auth/'))   return '';
  return s;
}

// ── OAuth state cookie (CSRF + deep-link return) ───────────
// Cookie value:
//   "<state>"                    when no return_to
//   "<state>.<b64url(returnTo)>" when carrying a deep link
function makeStateCookie(state, returnTo) {
  const safeReturn = sanitizeReturnTo(returnTo);
  const value = safeReturn ? `${state}.${b64urlEncode(safeReturn)}` : state;
  return serializeCookie(STATE_COOKIE, value, {
    httpOnly: true,
    secure:   true,
    sameSite: 'Lax',
    path:     '/',
    maxAge:   600 // 10 minutes
  });
}

function clearStateCookie() {
  return serializeCookie(STATE_COOKIE, '', {
    httpOnly: true,
    secure:   true,
    sameSite: 'Lax',
    path:     '/',
    maxAge:   0
  });
}

function getState(req) {
  // Returns just the CSRF portion (left of the dot) for legacy callers.
  const v = parseCookies(req)[STATE_COOKIE] || '';
  const i = v.indexOf('.');
  return i < 0 ? v : v.slice(0, i);
}

// New helper: returns both the CSRF token and the optional deep-link path.
function getStateAndReturn(req) {
  const v = parseCookies(req)[STATE_COOKIE] || '';
  const i = v.indexOf('.');
  if (i < 0) return { state: v, returnTo: '' };
  let returnTo = '';
  try { returnTo = b64urlDecode(v.slice(i + 1)).toString('utf8'); }
  catch (e) { returnTo = ''; }
  return { state: v.slice(0, i), returnTo: sanitizeReturnTo(returnTo) };
}

// ── Domain check ────────────────────────────────────────────
function isAllowedDomain(email) {
  if (!email || typeof email !== 'string') return false;
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return ALLOWED_DOMAINS.indexOf(domain) !== -1;
}

// ── Google service account JWT → access token (for Sheets) ──
function makeServiceJWT(sa, scope) {
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64urlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const pay = b64urlEncode(JSON.stringify({
    iss:   sa.client_email,
    scope: scope,
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600
  }));
  const data = hdr + '.' + pay;
  const sig  = crypto.createSign('RSA-SHA256').update(data).sign(sa.private_key, 'base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return data + '.' + sig;
}

function httpsPostForm(url, body) {
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

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: headers || {} }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end',  () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function getServiceAccountAccessToken(scope) {
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');
  const sa  = JSON.parse(saJson);
  const jwt = makeServiceJWT(sa, scope);
  const res = await httpsPostForm(
    'https://oauth2.googleapis.com/token',
    'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
  );
  if (!res.access_token) throw new Error('Google did not return an access token');
  return res.access_token;
}

// ── Admin lookup against FT_Admins tab ──────────────────────
// Fails closed: if the sheet read errors, returns false (treat as non-admin)
// rather than crashing sign-in.
async function isAdminEmail(email) {
  if (!email) return false;
  const target = email.toLowerCase().trim();
  try {
    const accessToken = await getServiceAccountAccessToken(
      'https://www.googleapis.com/auth/spreadsheets.readonly'
    );
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(ADMIN_RANGE)}`;
    const data = await httpsGet(url, { Authorization: 'Bearer ' + accessToken });
    const rows = data.values || [];
    for (let i = 0; i < rows.length; i++) {
      const cell = (rows[i][0] || '').toString().toLowerCase().trim();
      if (cell && cell === target) return true;
    }
    return false;
  } catch (err) {
    console.error('isAdminEmail error:', err.message);
    return false;
  }
}

// ── Decode an OIDC ID token (signature already verified by Google
// over TLS during the code-for-token exchange) ──────────────
function decodeIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch (e) {
    return null;
  }
}

// ── Origin (for building redirect URIs) ─────────────────────
function getOrigin(req) {
  const host  = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] ||
                (host.indexOf('localhost') === 0 ? 'http' : 'https');
  return `${proto}://${host}`;
}

module.exports = {
  ALLOWED_DOMAINS,
  SESSION_COOKIE,
  parseCookies,
  serializeCookie,
  signSession,
  verifySession,
  makeSessionCookie,
  clearSessionCookie,
  getSession,
  makeStateCookie,
  clearStateCookie,
  getState,
  getStateAndReturn,
  sanitizeReturnTo,
  isAllowedDomain,
  isAdminEmail,
  decodeIdToken,
  httpsPostForm,
  httpsGet,
  getOrigin
};
