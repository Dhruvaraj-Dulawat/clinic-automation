// ============================================================================
// clinic-automation — reporting API, admin-guarded (src/routes/reports.js)
//   GET /api/reports/daily?date=YYYY-MM-DD
//   GET /api/reports/flags
//   GET /api/reports/weekly?weekStart=YYYY-MM-DD
//   GET /api/reports/digest — same text the owner gets on WhatsApp (preview)
// Mounted at /api/reports in src/app.js, so paths below are RELATIVE ('/daily'
// not '/api/reports/daily' — the double prefix would 404).
// Deps: express, ../services/reports.js, ../services/digest.js,
//   ../middleware/auth.js (requireAdmin over the whole router).
// ============================================================================
'use strict';

const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const reports = require('../services/reports');
const dt = require('../services/datetime');

const router = express.Router();
router.use(requireAdmin);

// Default a missing ?date / ?weekStart to the CLINIC'S LOCAL day, never the UTC
// day. These used to be `new Date().toISOString().slice(0, 10)`, which is the D9
// defect: for a clinic east of UTC (IST is +05:30) the UTC calendar day is
// already yesterday between local 00:00 and 05:30, so a receptionist opening the
// dashboard at 08:00 UTC — or the WhatsApp digest firing before 05:30 IST —
// silently got YESTERDAY's report with no error anywhere. services/reports.js was
// already converted to dt.*; these two route-level defaults were the last
// UTC-derived day bounds in the project. dt.todayStr() reads local components;
// an explicit ?date=/?weekStart= from the caller is still honoured verbatim.
router.get('/daily', (req, res) => {
  try {
    const date = req.query.date || dt.todayStr();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '?date=YYYY-MM-DD required' });
    res.json(reports.getDailySummary(date));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

router.get('/flags', (req, res) => {
  try {
    res.json(reports.getFollowupFlags());
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

router.get('/weekly', (req, res) => {
  try {
    // Default to the current clinic week (Monday), matching the convention
    // reports.getWeeklyAggregates() documents.
    const weekStart = req.query.weekStart || dt.weekStart(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return res.status(400).json({ error: '?weekStart=YYYY-MM-DD required' });
    res.json(reports.getWeeklyAggregates(weekStart));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

router.get('/digest', (req, res) => {
  try {
    const { buildWeeklyDigest } = require('../services/digest');
    res.json({ digest: buildWeeklyDigest() });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

module.exports = router;
