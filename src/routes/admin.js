// clinic-automation — admin API (src/routes/admin.js)
// Routes (mounted at /api/admin — see src/app.js):
//   POST /login      { username, password } -> { ok:true, user } (IP-throttled)
//   POST /logout     destroy session -> { ok:true }
//   GET  /me         current admin or 401
//   GET  /dashboard  today counts + client total (passthrough over repository)
//   GET  /export.csv full client dump as CSV (admin-guarded)
// Auth: src/services/auth.js (bcrypt, users table + env bootstrap fallback);
// guard: src/middleware/auth.js `requireAdmin` (checks `req.session.admin`).
'use strict';

const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { verifyAdmin, loginSession, logoutSession, sessionUser } = require('../services/auth');
// Rotate the CSRF token across a privilege change (see middleware/csrf.js).
// Without this a token an attacker managed to read BEFORE the admin logged in
// stays valid afterwards — CSRF-token fixation.
const { rotateCsrfToken } = require('../middleware/csrf');

const router = express.Router();

// Simple in-memory login throttle: 10 attempts / 10 min per IP (brute-force
// guard — see middleware/auth.js header). Resets naturally via the window.
const attempts = new Map();
function throttled(ip) {
  const now = Date.now();
  const arr = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  arr.push(now);
  attempts.set(ip, arr);
  return arr.length > 10;
}

router.post('/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (throttled(ip)) return res.status(429).json({ error: 'too_many_attempts' });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (verifyAdmin(username, password)) {
    loginSession(req, { username, role: 'admin' });
    // Fresh token for the new privilege level; the pre-login one is dead.
    const csrfToken = rotateCsrfToken(req, res);
    return res.json({ ok: true, user: { username, role: 'admin' }, csrfToken: csrfToken || undefined });
  }
  return res.status(401).json({ error: 'invalid_credentials' });
});

router.post('/logout', (req, res) => {
  // Burn the token as well as the session: a leaked cookie must not authenticate
  // a later write even if the session cookie is somehow still valid.
  rotateCsrfToken(req, res);
  logoutSession(req, () => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  const admin = sessionUser(req);
  if (!admin) return res.status(401).json({ error: 'unauthenticated' });
  res.json({ admin });
});

router.get('/dashboard', requireAdmin, (req, res) => {
  try {
    const { clients, appointments } = require('../db/repository');
    const today = appointments.todays();
    const byStatus = {};
    for (const a of today) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
    // Client total via a bounded count (list cap 100k — fine for a clinic).
    const total = clients.list(100000, 0).length;
    res.json({ today: today.length, byStatus, clients: total, appointments: today.slice(0, 20) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/export.csv', requireAdmin, (req, res) => {
  try {
    const { clients } = require('../db/repository');
    const rows = clients.list(10000, 0);
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['name,phone,email,tags,notes', ...rows.map((c) => [c.name, c.phone, c.email, c.tags, c.notes].map(esc).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="clients.csv"');
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
