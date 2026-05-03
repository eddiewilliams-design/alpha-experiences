// ============================================================
// ALPHA EXPERIENCES — CURRENT USER
// GET /auth/me
//   200 → { email, name, picture, isAdmin, exp }
//   401 → { error: "not_authenticated" }
// Used by every protected page on the client to decide whether
// to render or bounce the user back to /auth/login.
// ============================================================

const { getSession } = require('../_lib/session.js');

module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'not_authenticated' });
  }

  return res.status(200).json({
    email:   session.email,
    name:    session.name,
    picture: session.picture || '',
    isAdmin: !!session.isAdmin,
    exp:     session.exp
  });
};
