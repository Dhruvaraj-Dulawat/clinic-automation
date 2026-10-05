// ============================================================================
// clinic-automation — availability + booking API (src/routes/bookings.js)
//   GET  /api/bookings/availability?date=YYYY-MM-DD  (free/taken slot grid)
//   POST /api/bookings/book { name, phone, date?, slotStart, service? }
//     (POST /api/bookings is a legacy alias for the same handler)
//   PUT  /api/bookings/:id { status?, slotStart? }  (admin: cancel/reschedule)
// NOTE: canonical availability path is /api/bookings/availability (mounted at
// /api/bookings in src/app.js); the M3 brief's "/api/availability" shorthand
// refers to this same handler.
// Booking flow (VALIDATE-THEN-CREATE, ATOMICALLY): every request is fully
// validated — name, phone, slotStart format, date agreement, slot inside clinic
// hours — BEFORE clients.create() is ever reached, so a 400 leaves NO trace in
// the clients table. The client insert and the guarded appointment insert then
// run inside ONE transaction: if the slot race is lost the client row rolls
// back with it, so neither a 400 nor a 409 can leave an orphan patient
// (post-holding-the-slot attacks previously created one client per attempt).
// Then find-or-create client by normalized phone + guarded bookSlot (409 +
// SLOT_TAKEN when the slot just got taken). Public route.
// On success: fire-and-forget WhatsApp booking_confirm via messaging.js +
// staff notify — both required LAZILY (try/catch) so M3 works even if M4/M5
// files have not landed yet.
// PUT cancel/reschedule is admin-guarded (requireAdmin); reschedule books the
// new slot first (guarded, 409 when taken) then cancels the old row, so the
// UNIQUE(slot_start) invariant is never broken. Update message sent lazily.
// Deps: express, ../db/repository.js (clients, appointments, normalizePhone),
//   ../services/scheduling.js, ../config.js (clinicHours),
//   ../middleware/auth.js (PUT only, required directly — M1 file, always present).
// ============================================================================
'use strict';

const express = require('express');
// Namespaced repository contract (M1): { clients, appointments, normalizePhone }.
// (Flat aliases exist for back-compat, but M3 uses the canonical names.)
const repo = require('../db/repository');
const { clients, appointments, normalizePhone } = repo;
const scheduling = require('../services/scheduling');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Clinic-hours snapshot from src/config.js. This used to swallow a config
// failure and invent 09:00-19:00 Mon-Sat hours, which quietly offered real
// patients slots the clinic had never configured. Fail LOUDLY instead: warn
// with the underlying error and rethrow, so the enclosing route try/catch turns
// it into an honest 500 { error } rather than a fabricated slot grid.
function clinicHours() {
  try {
    return require('../config').getConfig().clinicHours;
  } catch (err) {
    console.warn(
      '[bookings] WARNING: config.getConfig() failed - clinic hours are UNKNOWN, refusing to book. ' +
      `Check CLINIC_HOURS_JSON / SLOT_* in .env. Cause: ${String((err && err.message) || err)}`
    );
    throw err;
  }
}

router.get('/availability', (req, res) => {
  try {
    const { date } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'query ?date=YYYY-MM-DD is required' });
    }
    res.json({ date, slots: scheduling.getAvailability({ appointments }, date, clinicHours()) });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Canonical booking handler: validate EVERYTHING first, then find-or-create the
// client by normalized phone, then guarded bookSlot (409 + SLOT_TAKEN when the
// slot just got taken). Public.
//
// Order matters: clients.create() must be the LAST thing before bookSlot, so a
// 400 (bad date, outside hours, junk slotStart) can never leave an orphaned
// client row behind.
function handleBook(req, res) {
  try {
    const { name, phone, date, slotStart, service = 'General consultation' } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const normalized = normalizePhone(phone);
    if (!normalized || normalized === '+') return res.status(400).json({ error: 'valid phone is required' });
    if (!slotStart || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(slotStart)) {
      return res.status(400).json({ error: 'slotStart "YYYY-MM-DD HH:mm" is required' });
    }

    // --- validation phase: no writes below here until the slot is proven real ---
    const day = slotStart.slice(0, 10);
    if (date && day !== date) return res.status(400).json({ error: 'slotStart does not match date' });
    const grid = scheduling.computeSlots(day, clinicHours());
    const slot = grid.find((s) => s.start === slotStart);
    if (!slot) return res.status(400).json({ error: 'slot is outside clinic hours' });

    // --- write phase: only a fully valid request reaches the database ---
    //
    // ATOMIC (SYNC-4). The appointment FK references clients(id) with
    // `foreign_keys = ON`, so the client row must be inserted first and cannot
    // be un-inserted by ordering alone. Running the pair inside one
    // better-sqlite3 transaction is what actually closes the orphan: if the
    // guarded insert loses the slot race, the whole transaction (client row
    // included) rolls back. Nested transactions are SAVEPOINTs, and
    // appointments.book() opens its own db.transaction() internally, so the
    // inner one nests cleanly inside this outer scope — verified, not assumed.
    //
    // A pre-flight `appointments.findBySlot()` check would NOT do this: two
    // genuinely concurrent requests both pass the check, and the loser still
    // orphans its client row. Only a real rollback closes the race.
    //
    // NOTE ON LAYERING: this reaches for getDb() to obtain transaction control,
    // not to write SQL — every statement still lives in ../db/repository.js.
    // The repository home for this would be a single bookWithClient()
    // primitive; until that exists, the transaction is declared here.
    let client;
    let appointment;
    try {
      const commit = require('../db/db').getDb().transaction(() => {
        let c = clients.findByPhone(normalized);
        if (!c) c = clients.create({ name: String(name).trim(), phone: normalized });
        const booked = scheduling.bookSlot({ appointments }, {
          clientId: c.id,
          slotStart: slot.start,
          slotEnd: slot.end,
          service,
        });
        return { client: c, appointment: booked };
      });
      const written = commit();
      client = written.client;
      appointment = written.appointment;
    } catch (err) {
      // Reaching here means the transaction rolled back, so no client row from
      // this request survives.
      if (err && err.code === 'SLOT_TAKEN') {
        return res.status(409).json({ error: 'slot just got booked, please pick another' });
      }
      throw err;
    }

    // Fire-and-forget WhatsApp confirm to the client (lazy: M4 may land later;
    // sync require-throw and async rejection both swallowed). Deliberately
    // AFTER the commit — a message must never describe an uncommitted booking.
    try {
      const messaging = require('../services/messaging');
      Promise.resolve(
        messaging.sendTemplated(normalized, 'booking_confirm', {
          clientName: client.name,
          service,
          slotStart: slot.start,
        })
      ).catch(() => {});
    } catch (_) {}
    // Fire-and-forget staff notification (never fails the booking).
    try {
      const staff = require('../services/staffNotify');
      Promise.resolve(staff.notifyBooking({ client, appointment })).catch(() => {});
    } catch (_) {}
    res.status(201).json({ appointment, client });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}

// Canonical path (M3 frontend posts here) + legacy alias (same handler).
router.post('/book', handleBook);
router.post('/', handleBook);

// Admin: cancel or reschedule. Body may carry:
//   { status: 'cancelled' }            — cancel in place (same row, same id)
//   { slotStart: 'YYYY-MM-DD HH:mm' }  — move to a free slot (guarded, 409)
// Both may be combined (status is applied to the final row). Sends the client
// a lazy fire-and-forget update message + staff notify; neither ever fails
// the request.
router.put('/:id', requireAdmin, (req, res) => {
  try {
    const current = appointments.findById(req.params.id);
    if (!current) return res.status(404).json({ error: 'appointment not found' });
    const { status, slotStart } = req.body || {};
    let appointment = current;

    if (slotStart !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(slotStart))) {
        return res.status(400).json({ error: 'slotStart "YYYY-MM-DD HH:mm" is required' });
      }
      const day = String(slotStart).slice(0, 10);
      const grid = scheduling.computeSlots(day, clinicHours());
      const slot = grid.find((s) => s.start === slotStart);
      if (!slot) return res.status(400).json({ error: 'slot is outside clinic hours' });
      if (slotStart !== current.slot_start) {
        // Book-new-first (guarded) then cancel-old: UNIQUE never violated,
        // and a taken target leaves the original booking untouched.
        try {
          const moved = scheduling.bookSlot({ appointments }, {
            clientId: current.client_id,
            slotStart: slot.start,
            slotEnd: slot.end,
            service: current.service,
          });
          appointments.updateStatus(current.id, 'cancelled');
          appointment = moved;
        } catch (err) {
          if (err && err.code === 'SLOT_TAKEN') {
            return res.status(409).json({ error: 'target slot just got booked, please pick another' });
          }
          throw err;
        }
      }
    }

    if (status !== undefined) {
      const allowed = ['booked', 'confirmed', 'cancelled', 'completed', 'no_show'];
      if (!allowed.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
      }
      appointment = appointments.updateStatus(appointment.id, status);
    }

    // Lazy update message to the client + staff notify (both best-effort).
    const note = status === 'cancelled' && slotStart === undefined
      ? `Your appointment on ${current.slot_start} has been cancelled. Reply to rebook.`
      : `Update on your appointment: ${appointment.service} — ${appointment.slot_start} (${appointment.status}).`;
    try {
      const messaging = require('../services/messaging');
      const toPhone = (clients.findById(appointment.client_id) || {}).phone || current.client_phone;
      if (toPhone) Promise.resolve(messaging.sendFreeform(toPhone, note)).catch(() => {});
    } catch (_) {}
    try {
      const staff = require('../services/staffNotify');
      Promise.resolve(staff.notifyCancel({
        client: clients.findById(appointment.client_id),
        appointment,
      })).catch(() => {});
    } catch (_) {}

    res.json({ appointment });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

module.exports = router;
