// ============================================================
// ALPHA EXPERIENCES — LOGOUT
// POST /auth/logout → clears the session cookie.
// GET is also accepted so a plain link can sign the user out.
// ============================================================

const { clearSessionCookie } = require('../_lib/session.js');

module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', clearSessionCookie());

  if (req.method === 'GET') {
    return res.redirect(302, '/auth/login');
  }
  return res.status(200).json({ ok: true });
};
