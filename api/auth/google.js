// ============================================================
// ALPHA EXPERIENCES — START GOOGLE OAUTH
// GET /auth/google → redirects to Google's authorize URL.
// Sets a short-lived state cookie for CSRF protection that
// /auth/callback will compare against.
// ============================================================

const crypto = require('crypto');
const {
  makeStateCookie,
  getOrigin
} = require('../_lib/session.js');

module.exports = (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.redirect(302, '/auth/login?error=server');
  }

  const state       = crypto.randomBytes(24).toString('hex');
  const redirectUri = `${getOrigin(req)}/auth/callback`;

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         'openid email profile',
    state:         state,
    access_type:   'online',
    prompt:        'select_account'
  });

  res.setHeader('Set-Cookie', makeStateCookie(state));
  res.setHeader('Cache-Control', 'no-store');
  return res.redirect(302, 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
};
