// ============================================================
// ALPHA EXPERIENCES — AUTH DISPATCHER
// One Vercel serverless function that routes to the right auth
// handler based on the URL action segment. Replaces the four
// previous files (google.js, callback.js, me.js, logout.js) so
// we stay under the Vercel Hobby-plan function limit.
//
// Existing rewrites in vercel.json point at /api/auth/google,
// /api/auth/callback, /api/auth/me, /api/auth/logout — Vercel's
// dynamic-segment routing maps all of those to this file with
// req.query.action set to the segment name. No URL changes.
// ============================================================

const crypto = require('crypto');
const {
  httpsPostForm,
  decodeIdToken,
  isAllowedDomain,
  isAdminEmail,
  getSession,
  getStateAndReturn,
  sanitizeReturnTo,
  clearStateCookie,
  makeStateCookie,
  makeSessionCookie,
  clearSessionCookie,
  getOrigin
} = require('../_lib/session.js');

const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

// ── /auth/google ────────────────────────────────────────────
function handleGoogle(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.redirect(302, '/auth/login?error=server');

  const state       = crypto.randomBytes(24).toString('hex');
  const redirectUri = `${getOrigin(req)}/auth/callback`;
  const returnTo    = sanitizeReturnTo(req.query.return_to);

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         'openid email profile',
    state:         state,
    access_type:   'online',
    prompt:        'select_account'
  });

  res.setHeader('Set-Cookie', makeStateCookie(state, returnTo));
  res.setHeader('Cache-Control', 'no-store');
  return res.redirect(302, 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
}

// ── /auth/callback ──────────────────────────────────────────
function callbackFail(res, code) {
  res.setHeader('Set-Cookie', clearStateCookie());
  return res.redirect(302, '/auth/login?error=' + encodeURIComponent(code));
}

async function handleCallback(req, res) {
  const code           = (req.query.code  || '').toString();
  const stateParam     = (req.query.state || '').toString();
  const { state: stateCookie, returnTo } = getStateAndReturn(req);

  if (!code || !stateParam || !stateCookie || stateParam !== stateCookie) {
    return callbackFail(res, 'state');
  }

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return callbackFail(res, 'server');

  const redirectUri = `${getOrigin(req)}/auth/callback`;

  let tokenRes;
  try {
    const body = new URLSearchParams({
      code:          code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code'
    }).toString();
    tokenRes = await httpsPostForm('https://oauth2.googleapis.com/token', body);
  } catch (err) {
    console.error('token exchange failed:', err.message);
    return callbackFail(res, 'oauth');
  }

  if (!tokenRes || !tokenRes.id_token) {
    console.error('token exchange returned no id_token:', tokenRes && tokenRes.error);
    return callbackFail(res, 'oauth');
  }

  const claims = decodeIdToken(tokenRes.id_token);
  if (!claims || !claims.email)        return callbackFail(res, 'oauth');
  if (claims.email_verified === false) return callbackFail(res, 'unverified');
  if (!isAllowedDomain(claims.email))  return callbackFail(res, 'domain');

  const email = claims.email.toLowerCase().trim();
  const admin = await isAdminEmail(email);

  const sessionCookie = makeSessionCookie({
    email:   email,
    name:    claims.name    || claims.email,
    picture: claims.picture || '',
    isAdmin: !!admin,
    exp:     Math.floor(Date.now() / 1000) + SESSION_MAX_AGE
  });

  res.setHeader('Set-Cookie', [sessionCookie, clearStateCookie()]);
  // If a deep link was preserved through the OAuth round-trip, honour
  // it. Otherwise fall back to the role-default landing page.
  const dest = returnTo || (admin ? '/admin' : '/trips');
  return res.redirect(302, dest);
}

// ── /auth/me ────────────────────────────────────────────────
function handleMe(req, res) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'not_authenticated' });
  return res.status(200).json({
    email:   session.email,
    name:    session.name,
    picture: session.picture || '',
    isAdmin: !!session.isAdmin,
    exp:     session.exp
  });
}

// ── /auth/logout ────────────────────────────────────────────
function handleLogout(req, res) {
  res.setHeader('Set-Cookie', clearSessionCookie());
  if (req.method === 'GET') return res.redirect(302, '/auth/login');
  return res.status(200).json({ ok: true });
}

// ── Dispatch ────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const action = String(req.query.action || '').toLowerCase();
  switch (action) {
    case 'google':   return handleGoogle(req, res);
    case 'callback': return handleCallback(req, res);
    case 'me':       return handleMe(req, res);
    case 'logout':   return handleLogout(req, res);
    default:         return res.status(404).json({ error: 'not_found' });
  }
};
