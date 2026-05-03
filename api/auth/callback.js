// ============================================================
// ALPHA EXPERIENCES — GOOGLE OAUTH CALLBACK
// GET /auth/callback?code=...&state=...
//   1. Verify state cookie matches state param (CSRF)
//   2. Exchange code for tokens
//   3. Decode the ID token, enforce email_verified + allowed domain
//   4. Look up admin status in FT_Admins
//   5. Set 7-day signed session cookie
//   6. Redirect → /admin (if admin) or /trips (otherwise)
// ============================================================

const {
  httpsPostForm,
  decodeIdToken,
  isAllowedDomain,
  isAdminEmail,
  getState,
  clearStateCookie,
  makeSessionCookie,
  getOrigin
} = require('../_lib/session.js');

const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

function fail(res, code) {
  res.setHeader('Set-Cookie', clearStateCookie());
  return res.redirect(302, '/auth/login?error=' + encodeURIComponent(code));
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const code         = (req.query.code  || '').toString();
  const stateParam   = (req.query.state || '').toString();
  const stateCookie  = getState(req);

  if (!code || !stateParam || !stateCookie || stateParam !== stateCookie) {
    return fail(res, 'state');
  }

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return fail(res, 'server');
  }

  const redirectUri = `${getOrigin(req)}/auth/callback`;

  // Exchange code for tokens
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
    return fail(res, 'oauth');
  }

  if (!tokenRes || !tokenRes.id_token) {
    console.error('token exchange returned no id_token:', tokenRes && tokenRes.error);
    return fail(res, 'oauth');
  }

  const claims = decodeIdToken(tokenRes.id_token);
  if (!claims || !claims.email) {
    return fail(res, 'oauth');
  }

  if (claims.email_verified === false) {
    return fail(res, 'unverified');
  }

  if (!isAllowedDomain(claims.email)) {
    return fail(res, 'domain');
  }

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
  return res.redirect(302, admin ? '/admin' : '/trips');
};
