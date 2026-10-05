// ============================================================================
// clinic-automation — owner/staff notifications (src/services/staffNotify.js)
// booking/cancel/send-fail alerts go to OWNER_PHONE via the same send+log
// path (messaging.js). No owner phone configured → no-op (returns null) so
// local dev without OWNER_PHONE still works. Never throws: failures are
// logged, never allowed to break the booking flow.
// Deps: ./messaging.js, ../config.js (ownerPhone).
// ============================================================================
'use strict';

function ownerPhone() {
  try {
    return require('../config').getConfig().ownerPhone || '';
  } catch (_) {
    return process.env.OWNER_PHONE || '';
  }
}

async function notifyOwner(text) {
  const to = ownerPhone();
  if (!to) return null;
  const messaging = require('./messaging');
  return messaging.sendFreeform(to, text);
}

async function notifyBooking({ client, appointment }) {
  return notifyOwner(
    `New booking: ${client.name} (${client.phone}) — ${appointment.service} at ${appointment.slot_start}.`
  );
}

async function notifyCancel({ client, appointment }) {
  return notifyOwner(`Cancelled: ${client ? `${client.name} (${client.phone})` : 'unknown'} — slot ${appointment.slot_start}.`);
}

async function notifyReschedule({ client, appointment, newSlot }) {
  return notifyOwner(
    `Rescheduled: ${client ? `${client.name} (${client.phone})` : 'unknown'} — ${appointment.slot_start} → ${newSlot}.`
  );
}

async function notifySendFailure({ toPhone, template }) {
  return notifyOwner(`WhatsApp send FAILED to ${toPhone} (template ${template}). Check MOCK_MODE/token.`);
}

module.exports = { notifyOwner, notifyBooking, notifyCancel, notifyReschedule, notifySendFailure };
