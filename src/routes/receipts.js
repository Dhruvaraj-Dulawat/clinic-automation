// ============================================================================
// clinic-automation — receipt API + WhatsApp document send (src/routes/receipts.js)
//   POST /api/receipts { clientId, appointmentId?, amount, items?[], sendWhatsApp? }
//     → generates the PDF (services/pdf.js), stores the row, optionally
//     sends it as a WhatsApp document when ?sendWhatsApp=1 (or body
//     sendWhatsApp=true). Sending needs a PUBLIC_FILE_BASE_URL so the Cloud
//     API can fetch the file; without it the receipt is still created and the
//     response says whatsapp:'skipped'. Provider send is lazy-required in
//     try/catch so a missing/failing provider never 500s the receipt.
//   GET  /api/receipts/:id/download — streams the PDF (admin-guarded).
// NOTE: app.js mounts this router at /api/receipts, so routes below are
//   relative ('/' and '/:id/download') — never repeat the prefix here.
// Mounted in src/app.js. Deps: express, ../db/repository.js,
//   ../services/pdf.js, ../services/messaging.js, ../middleware/auth.js.
// ============================================================================
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const repo = require('../db/repository');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdmin);

// Shared document-send: builds the public link the Cloud API fetches and
// sends via services/messaging.js (same send+log path as everything else —
// win or fail is logged, transport errors never throw). Returns the logged
// message status ('sent' | 'mocked' | 'failed') or 'skipped' when no public
// file base is configured.
async function trySendReceipt(client, filePath, amount) {
  const base = process.env.PUBLIC_FILE_BASE_URL || '';
  if (!base) return 'skipped';
  const link = `${base.replace(/\/$/, '')}/receipts/${path.basename(filePath)}`;
  const messaging = require('../services/messaging');
  const logged = await messaging.sendDocument(client.phone, {
    link,
    filename: path.basename(filePath),
    caption: `Receipt for \u20B9${amount}`,
  });
  // messaging.send* resolves to the PERSISTED ROW - that is what carries
  // `.status`. Accept a bare rowid too, so this stays correct if that contract
  // is ever narrowed: statusById() THROWS when handed an object, and by this
  // point the receipt has already reached the patient, so a lost status read
  // must not also become a swallowed error. Mirrors the shape-tolerant
  // messageStatus() in services/digest.js.
  const row = logged && typeof logged === 'object'
    ? logged
    : (repo.messages && typeof repo.messages.statusById === 'function'
      ? repo.messages.statusById(logged)
      : null);
  return (row && row.status) || 'sent';
}

router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const { clientId, appointmentId = null, amount, items = [] } = body;
    // Accept both ?sendWhatsApp=1 (canonical, S6.1.2) and the body flag.
    const sendWhatsApp = req.query.sendWhatsApp === '1' || body.sendWhatsApp === true || body.sendWhatsApp === '1';
    const client = repo.clients.findById(clientId);
    if (!client) return res.status(404).json({ error: 'client not found' });
    if (amount === undefined || Number.isNaN(Number(amount))) {
      return res.status(400).json({ error: 'numeric amount is required' });
    }
    const appointment = appointmentId ? repo.appointments.findById(appointmentId) : null;
    if (appointmentId && !appointment) return res.status(404).json({ error: 'appointment not found' });

    const { generateReceipt } = require('../services/pdf');
    const filePath = await generateReceipt({ client, appointment, items, amount: Number(amount) });
    const receiptId = repo.receipts.create({
      appointmentId: appointment ? appointment.id : null,
      clientId: client.id,
      amount: Number(amount),
      itemsJson: JSON.stringify(items),
      filePath,
    });
    const receipt = repo.receipts.findById(receiptId);

    let whatsapp = 'skipped';
    if (sendWhatsApp) {
      // Best-effort: a failing send must never 500 an already-created
      // receipt — messaging.js logs the failure and we report 'failed'.
      try {
        whatsapp = await trySendReceipt(client, filePath, Number(amount));
      } catch (_) {
        whatsapp = 'failed';
      }
    }
    res.status(201).json({ receipt, whatsapp });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /api/receipts/:id/send — (re)send an existing receipt PDF as a
// WhatsApp document. Needs PUBLIC_FILE_BASE_URL (the Cloud API fetches the
// file from that public base); without it this is a 400, unlike creation
// where sending stays best-effort 'skipped'.
router.post('/:id/send', async (req, res) => {
  try {
    const receipt = repo.receipts.findById(req.params.id);
    if (!receipt || !fs.existsSync(receipt.file_path)) {
      return res.status(404).json({ error: 'receipt file not found' });
    }
    if (!process.env.PUBLIC_FILE_BASE_URL) {
      return res.status(400).json({ error: 'PUBLIC_FILE_BASE_URL is not configured' });
    }
    const client = repo.clients.findById(receipt.client_id);
    if (!client) return res.status(404).json({ error: 'client not found' });
    let whatsapp = 'skipped';
    try {
      whatsapp = await trySendReceipt(client, receipt.file_path, receipt.amount);
    } catch (_) {
      whatsapp = 'failed'; // already logged as failed by messaging.js
    }
    res.json({ receipt, whatsapp });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

router.get('/:id/download', (req, res) => {
  try {
    const receipt = repo.receipts.findById(req.params.id);
    if (!receipt || !fs.existsSync(receipt.file_path)) {
      return res.status(404).json({ error: 'receipt file not found' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(receipt.file_path)}"`);
    fs.createReadStream(receipt.file_path).pipe(res);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

module.exports = router;
