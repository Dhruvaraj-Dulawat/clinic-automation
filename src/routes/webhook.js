// ============================================================================
// clinic-automation — WhatsApp webhook: verification + two-way intents
//   (src/routes/webhook.js)
//   GET  /webhook?hub.verify_token=&hub.challenge=&hub.mode= — Meta handshake.
//     The token is compared in CONSTANT TIME (timingSafeEqual) so attackers
//     can't guess it byte-by-byte.
//   POST /webhook — inbound Cloud API payload. Handles text intents:
//     CANCEL […]            → cancels the sender's next upcoming appointment
//     CONFIRM […]           → confirms the next upcoming appointment
//     RESCHEDULE YYYY-MM-DD HH:mm → moves it (guarded, 409 when taken)
// Inbound + outcomes are logged to messages (direction inbound / outbound).
// Mounted in src/app.js. Deps: express, crypto, ../db/repository.js
//   (namespaced: clients/appointments/messages + normalizePhone),
//   ../services/datetime.js, ../services/messaging.js,
//   ../services/scheduling.js, ../config.js.
//   (Public route — no admin session required.)
// ============================================================================
'use strict';

const express = require('express');
const crypto = require('crypto');
const repo = require('../db/repository');
const { normalizePhone } = require('../db/repository');
// D10: slot_start is local-naive 'YYYY-MM-DD HH:mm'. This module compares it
// against "now", so "now" has to be on the same clock — see nextUpcomingForPhone.
const dt = require('../services/datetime');

const router = express.Router();

function verifyToken() {
  try {
    return require('../config').getConfig().whatsapp.verifyToken || '';
  } catch (_) {
    return process.env.WHATSAPP_VERIFY_TOKEN || '';
  }
}

// Constant-time string compare (length-leak only, no early exit on content).
function tokensEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && tokensEqual(token, verifyToken()) && challenge) {
    return res.status(200).send(challenge);
  }
  return res.status(403).json({ error: 'verification failed' });
});

// Extract { from, text } pairs from a Cloud API webhook payload.
// Accepts typed text (message.text.body) AND tapped quick-reply buttons:
// interactive button_reply (id/title) and legacy button payloads. Button
// ids are the CONFIRM/CANCEL/RESCHEDULE keywords by construction (see
// whatsapp/provider.js sendInteractive), so taps flow into the same intent
// parser as typed keywords.
function parseInbound(payload) {
  const out = [];
  try {
    const entries = (payload && payload.entry) || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        for (const msg of value.messages || []) {
          const interactive = msg.interactive || {};
          const buttonReply = interactive.button_reply || {};
          const legacyButton = msg.button || {};
          const text =
            (msg.text && msg.text.body) ||
            buttonReply.id ||
            buttonReply.title ||
            legacyButton.payload ||
            legacyButton.text ||
            '';
          if (msg.from && text) out.push({ from: `+${String(msg.from).replace(/\D/g, '')}`, text: String(text).trim() });
        }
      }
    }
  } catch (_) {}
  return out;
}

// Namespaced repository shims (canonical M1 contract:
// { clients, appointments, messages, normalizePhone }).
function findClient(phone) {
  return repo.clients.findByPhone(normalizePhone(phone));
}

function logMsg(entry) {
  if (repo.messages && typeof repo.messages.log === 'function') {
    return repo.messages.log(entry);
  }
  return repo.logMessage(entry);
}

function setStatus(id, status) {
  if (repo.appointments && typeof repo.appointments.updateStatus === 'function') {
    return repo.appointments.updateStatus(id, status);
  }
  return repo.updateAppointmentStatus(id, status);
}

function slotTaken(slotStart) {
  // Prefer the live-status guard (cancelled slots are reusable).
  if (repo.appointments && typeof repo.appointments.findBySlot === 'function') {
    return repo.appointments.findBySlot(slotStart);
  }
  // No namespaced method (a test fake that predates it): fall back to the flat
  // alias. Both live in src/db/repository.js — the slot guard used to run an
  // inline SELECT here, which meant the SQL for this decision existed twice.
  if (typeof repo.findAppointmentBySlot === 'function') {
    return repo.findAppointmentBySlot(slotStart);
  }
  const err = new Error('[webhook] repository exposes no slot lookup');
  err.code = 'REPO_SLOT_LOOKUP_MISSING';
  throw err;
}

function bookGuarded(args) {
  try {
    if (repo.appointments && typeof repo.appointments.book === 'function') {
      return repo.appointments.book(args);
    }
    return repo.createAppointment(args);
  } catch (e) {
    if (e && (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.code === 'SLOT_TAKEN' || /UNIQUE/i.test(e.message || ''))) {
      const err = new Error('slot taken');
      err.code = 'SLOT_TAKEN';
      throw err;
    }
    throw e;
  }
}

function nextUpcomingForPhone(phone) {
  const normalized = normalizePhone(phone);
  // D10: "now" MUST be the clinic's own wall clock, in the stored slot format.
  // This used to be `new Date().toISOString().slice(0, 16).replace('T', ' ')`,
  // which is UTC — 5h30m behind IST. Every visit that had already started up to
  // that offset still compared as "upcoming", so replying CANCEL cancelled an
  // appointment the patient had already attended, and the dashboard then
  // reported the visit as cancelled instead of completed.
  const now = dt.nowStr();
  const client = findClient(normalized);
  if (!client) return { client: null, appointment: null, past: null };
  const rows = (repo.appointments && typeof repo.appointments.findByPhone === 'function')
    ? repo.appointments.findByPhone(normalized)
    : repo.listAppointmentsByClient(client.id);
  const upcoming = rows
    .filter((a) => (a.status === 'booked' || a.status === 'confirmed') && a.slot_start >= now)
    .sort((a, b) => (a.slot_start < b.slot_start ? -1 : 1))[0];
  // The nearest visit that has ALREADY STARTED and is still marked live. The
  // filter above drops past rows, so without this the "nothing upcoming" branch
  // is the only answer a patient can get for a cancel aimed at a visit that has
  // already happened — and that answer ("we could not find an upcoming
  // appointment... reply with your name to book") reads as "we have no record of
  // you" and sends them to book a second visit for a slot they already attended.
  // Surfacing it lets handleIntent refuse the cancel by name and by slot, and
  // leaves the attended row untouched so the report still counts it.
  const past = rows
    .filter((a) => (a.status === 'booked' || a.status === 'confirmed') && hasAlreadyPassed(a.slot_start))
    .sort((a, b) => (a.slot_start > b.slot_start ? -1 : 1))[0];
  return { client, appointment: upcoming || null, past: past || null };
}

// Has this visit already started? Compared as two local-naive slot strings, so
// it needs no timezone maths. Defensive on a non-slot value: an unrecognised
// slot_start is treated as NOT past, because the alternative — refusing the
// cancel on a formatting quirk — would lock a patient out of cancelling.
function hasAlreadyPassed(slotStart) {
  return dt.isSlotStr(slotStart) && slotStart < dt.nowStr();
}

async function handleIntent({ from, text }, messaging) {
  logMsg({ fromPhone: from, direction: 'inbound', template: 'freeform', body: text, status: 'delivered' });
  const upper = text.toUpperCase();
  const { client, appointment, past } = nextUpcomingForPhone(from);
  // D10: a CANCEL aimed at a visit that has ALREADY STARTED, with no later one
  // to fall back on — the single most common case after the patient leaves.
  // Without this branch it falls into the generic reply below, which denies
  // knowing the patient at all and invites them to book again. Refuse it by name
  // and by slot instead, and leave the attended row exactly as it is.
  if (/^CANCEL\b/.test(upper) && !appointment && past) {
    await messaging.sendFreeform(
      from,
      `Your appointment on ${past.slot_start} has already started, so it can't be cancelled here. Please call the clinic if you need to sort something out.`
    );
    return { intent: 'cancel-past', appointmentId: past.id };
  }
  if (!appointment) {
    await messaging.sendFreeform(from, 'We could not find an upcoming appointment for this number. Reply with your name to book.');
    return { intent: 'none' };
  }
  if (/^CANCEL\b/.test(upper)) {
    // D10: a visit that has already started must NOT be cancellable. Silently
    // accepting it would rewrite a visit the patient actually attended into
    // `cancelled`, which is what revenue and the daily report are built from.
    // nextUpcomingForPhone() already filters on `slot_start >= now`; this second
    // check is deliberate belt-and-braces so the rule survives a future change
    // to how the "upcoming" appointment is chosen.
    if (hasAlreadyPassed(appointment.slot_start)) {
      await messaging.sendFreeform(
        from,
        `Your appointment on ${appointment.slot_start} has already started, so it can't be cancelled here. Please call the clinic if you need to sort something out.`
      );
      return { intent: 'cancel-past', appointmentId: appointment.id };
    }
    setStatus(appointment.id, 'cancelled');
    try {
      await require('../services/staffNotify').notifyCancel({ client, appointment });
    } catch (_) {}
    await messaging.sendFreeform(from, `Your appointment on ${appointment.slot_start} has been cancelled. Reply to rebook.`);
    return { intent: 'cancel', appointmentId: appointment.id };
  }
  if (/^CONFIRM\b/.test(upper)) {
    setStatus(appointment.id, 'confirmed');
    await messaging.sendFreeform(from, `Confirmed — see you on ${appointment.slot_start}.`);
    return { intent: 'confirm', appointmentId: appointment.id };
  }
  const m = upper.match(/^RESCHEDULE\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  if (m) {
    const newStart = `${m[1]} ${m[2]}`;
    const scheduling = require('../services/scheduling');
    let hours;
    try {
      hours = require('../config').getConfig().clinicHours;
    } catch (_) {
      hours = { days: [1, 2, 3, 4, 5, 6], open: '09:00', close: '19:00', slotMinutes: 30 };
    }
    const grid = scheduling.buildSlots(m[1], hours);
    const slot = grid.find((s) => s.start === newStart);
    if (!slot) {
      await messaging.sendFreeform(from, 'That time is outside clinic hours. Reply RESCHEDULE YYYY-MM-DD HH:mm with a valid slot.');
      return { intent: 'reschedule-invalid' };
    }
    if (slotTaken(newStart)) {
      await messaging.sendFreeform(from, 'That slot is already taken. Please pick another time.');
      return { intent: 'reschedule-taken' };
    }
    // Move = new guarded row + cancel old (keeps UNIQUE invariant simple).
    // A concurrent booking racing us here surfaces SLOT_TAKEN → tell the
    // sender to pick another time (never 500 on a race).
    let fresh;
    try {
      fresh = bookGuarded({
        clientId: appointment.client_id,
        slotStart: slot.start,
        slotEnd: slot.end,
        service: appointment.service,
      });
    } catch (err) {
      if (err && err.code === 'SLOT_TAKEN') {
        await messaging.sendFreeform(from, 'That slot just got booked. Please pick another time.');
        return { intent: 'reschedule-taken' };
      }
      throw err;
    }
    setStatus(appointment.id, 'cancelled');
    await messaging.sendFreeform(from, `Rescheduled to ${fresh.slot_start}. Reply CONFIRM to confirm.`);
    try {
      await require('../services/staffNotify').notifyReschedule({ client, appointment, newSlot: fresh.slot_start });
    } catch (_) {}
    return { intent: 'reschedule', appointmentId: fresh.id };
  }
  await messaging.sendFreeform(from, 'Sorry, I understood CONFIRM, CANCEL, or RESCHEDULE YYYY-MM-DD HH:mm.');
  return { intent: 'unknown' };
}

router.post('/', async (req, res) => {
  try {
    const messaging = require('../services/messaging');
    const inbound = parseInbound(req.body);
    const results = [];
    for (const msg of inbound) {
      results.push(await handleIntent(msg, messaging));
    }
    res.json({ ok: true, handled: results.length });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Test hook: pure parser + intent handler without HTTP.
module.exports = router;
module.exports.parseInbound = parseInbound;
module.exports.handleIntent = handleIntent;
module.exports.tokensEqual = tokensEqual;
