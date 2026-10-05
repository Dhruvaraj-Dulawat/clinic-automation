// clinic-automation — CSV upload endpoint (src/routes/import.js)
// Canonical: POST /api/import/csv with JSON { csv: "<raw text>" }
//   (mounted at /api/import in src/app.js). POST / is kept as an alias for
//   older drafts. Admin-guarded. Zero new deps: JSON body only — for
//   multipart uploads, paste the file text into the `csv` field (the admin
//   UI does exactly this); a future M-task may add multer.
// Delegates to src/services/csvImport.js (phone-dedupe). Returns
//   { report: { imported, skipped_duplicates, errors[] } }.
'use strict';

const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { parseCsvAndImport } = require('../services/csvImport');

const router = express.Router();
router.use(requireAdmin);

function handleImport(req, res) {
  try {
    // Accept { csv } (canonical), { text } (older UI), or raw-string bodies.
    const body = req.body || {};
    const csv = typeof body === 'string' ? body : (body.csv || body.text);
    if (!csv) return res.status(400).json({ error: 'csv body required (JSON { csv: "<raw text>" })' });
    const report = parseCsvAndImport(String(csv), null);
    res.json({ report });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

router.post('/csv', handleImport);
router.post('/', handleImport);

module.exports = router;
