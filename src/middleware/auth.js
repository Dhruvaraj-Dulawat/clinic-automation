// clinic-automation — admin session guard (src/middleware/auth.js)
// Purpose: protect /api/admin/* + CSV import + reports with express-session.
// Env: SESSION_SECRET via src/config.js. Note: login brute-force is throttled
// by a simple in-memory per-IP counter on the login route (see routes/admin.js).
'use strict';

function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) {
    return next();
  }
  return res.status(401).json({ error: 'unauthenticated' });
}

module.exports = { requireAdmin };
