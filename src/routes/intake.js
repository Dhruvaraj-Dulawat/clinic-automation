// ============================================================================
// clinic-automation — intake submit API (src/routes/intake.js)
//   GET  /questions — the questionnaire config (public)
//   POST /:appointmentId { answers, phone } — validated, then saved
//   POST / { appointmentId, answers, phone } — same, id in body (smoke/compat)
// Mounted at /api/intake in src/app.js.
// Deps: express, ../services/intake.js, ../db/repository.js — the repository
//   owns ALL SQL (appointment lookup + intake persistence).
//
// --- D11: THIS ENDPOINT IS NOT ANONYMOUS ------------------------------------
// Intake answers are protected medical data. The endpoint used to accept ANY
// appointmentId with no proof of ownership, which meant:
//   * anyone could walk /api/intake/1, /2, /3... and OVERWRITE a real patient's
//     medical answers (allergies, medications, presenting complaint), and
//   * the 404-vs-201 difference leaked which appointmentIds exist, i.e. a free
//     enumeration oracle for the whole booking table.
// The appointment id is NOT a secret: it is returned by POST /api/bookings/book
// to the patient and travels in a WhatsApp message.
//
// Proof of ownership is the phone number the patient already supplied when
// booking (the same credential GET /api/status uses via phone+last4). An admin
// session also satisfies it, so the dashboard can still file intake on a
// patient's behalf during a consultation.
//
// The two failure responses are deliberately DIFFERENT SHAPES on purpose:
//   * 403 intake_forbidden   - returned when the CALLER cannot be identified at
//                              all. It never consults appointmentId, so it can
//                              never be used as an existence oracle.
//   * 404 appointment_not_found - returned to an IDENTIFIED caller when the id
//                              is missing OR belongs to somebody else. Both
//                              cases are byte-identical, so a logged-in patient
//                              cannot probe for other patients' appointment ids.
// Never "fix" this by returning 404 for an unknown caller: that reintroduces D11.
// ============================================================================
'use strict';

const express = require('express');
// The repository is the only data-access layer: it both looks up the
// appointment and writes the answers (saveIntakeResponse replaces any previous
// answer set for that appointment).
const repo = require('../db/repository');
const { appointments, clients } = repo;
const { getQuestions, validateIntake } = require('../services/intake');

const router = express.Router();

// Identical body for every "you cannot even prove who you are" case.
const FORBIDDEN = { error: 'intake_forbidden' };
// Identical body for "not yours" and "does not exist" - see header.
const NOT_FOUND = { error: 'appointment_not_found' };

router.get('/questions', (req, res) => {
  try {
    res.json({ questions: getQuestions() });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

router.post('/:appointmentId', (req, res) => {
  const body = req.body || {};
  saveIntake(req.params.appointmentId, body.answers, body.phone, req, res);
});

// Body-style alias: POST / { appointmentId, answers, phone } — required by
// smoke-test.js (repo root) and handy for clients that POST a single URL.
router.post('/', (req, res) => {
  const body = req.body || {};
  saveIntake(body.appointmentId, body.answers, body.phone, req, res);
});

// An admin session (src/middleware/auth.js writes req.session.admin) may act for
// any patient; otherwise the caller must present the booking phone number.
function callerIsAdmin(req) {
  return Boolean(req.session && req.session.admin);
}

function saveIntake(appointmentId, answers, phone, req, res) {
  try {
    const admin = callerIsAdmin(req);

    // Identify the caller BEFORE the appointment is touched. A request with no
    // usable phone is rejected here, so appointmentId is never even read and the
    // response cannot vary with it (no enumeration oracle).
    let client = null;
    if (!admin) {
      if (!phone) return res.status(403).json(FORBIDDEN);
      client = clients.findByPhone(phone);
      if (!client) return res.status(403).json(FORBIDDEN);
    }

    const appointment = appointments.findById(appointmentId);

    if (!admin) {
      // One response for "no such appointment" and for "someone else's". A 404
      // here is safe precisely because the caller is already a known client, so
      // it discloses nothing about any other patient.
      if (!appointment || appointment.client_id !== client.id) {
        return res.status(404).json(NOT_FOUND);
      }
    } else if (!appointment) {
      return res.status(404).json(NOT_FOUND);
    }

    const { ok, errors } = validateIntake(answers);
    if (!ok) return res.status(400).json({ error: 'invalid intake', details: errors });

    // Persisted through the repository (replaces the previous answer set for
    // this appointment) so no SQL leaks into the route layer.
    res.status(201).json({ intake: repo.saveIntakeResponse(appointment.id, answers) });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}

module.exports = router;