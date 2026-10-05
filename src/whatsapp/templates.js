// ============================================================================
// clinic-automation — WhatsApp templates, final bodies (src/whatsapp/templates.js)
// MODIFIED in M4 (S4.1.2): skeleton → full bodies + variable slots +
// quick-reply keywords. Keep `name` stable: messaging.js + jobs reference it.
// When NOT in mock mode these bodies must match templates approved in the
// Meta dashboard (same variable order). Keywords CONFIRM / CANCEL /
// RESCHEDULE are parsed by routes/webhook.js — do not rename them.
// ============================================================================
'use strict';

const TEMPLATES = {
  booking_confirm: {
    name: 'booking_confirm', vars: ['name', 'slot', 'clinic'],
    variables: ['clientName', 'service', 'slotStart'],
    quickReplies: ['CONFIRM', 'CANCEL'],
    body: ({ clientName, service, slotStart, clinicName = 'our clinic', name, slot, clinic }) =>
      `Hello ${clientName || name}, your ${service || 'appointment'} at ${clinicName || clinic} is booked for ${slotStart || slot}. Reply CONFIRM to confirm or CANCEL to cancel.`,
  },
  reminder_24h: {
    name: 'reminder_24h', vars: ['name', 'slot', 'clinic'],
    variables: ['clientName', 'service', 'slotStart'],
    quickReplies: ['CONFIRM', 'CANCEL', 'RESCHEDULE'],
    body: ({ clientName, service, slotStart, clinicName = 'our clinic', name, slot, clinic }) =>
      `Reminder: ${clientName || name}, you have ${service || 'an appointment'} at ${clinicName || clinic} tomorrow (${slotStart || slot}). Reply CONFIRM, CANCEL, or RESCHEDULE YYYY-MM-DD HH:mm.`,
  },
  followup_visit: {
    name: 'followup_visit', vars: ['name', 'clinic'],
    variables: ['clientName'],
    quickReplies: [],
    body: ({ clientName, clinicName = 'our clinic', name, clinic }) =>
      `Hi ${clientName || name}, this is ${clinicName || clinic}. How are you feeling after your visit? Reply here if you need anything.`,
  },
  // Legacy aliases expected by M1 isolated test + older jobs/routes.
  followup_post_visit: {
    name: 'followup_post_visit', vars: ['name', 'clinic'],
    variables: ['clientName'],
    quickReplies: [],
    body: ({ clientName, clinicName = 'our clinic', name, clinic }) =>
      `Hi ${clientName || name}, this is ${clinicName || clinic}. How are you feeling after your visit? Reply here if you need anything.`,
  },
  reengage_winback: {
    name: 'reengage_winback', vars: ['name', 'clinic'],
    variables: ['clientName', 'daysSinceVisit'],
    quickReplies: [],
    body: ({ clientName, daysSinceVisit, clinicName = 'our clinic', name, clinic }) =>
      `Hi ${clientName || name}, it's been ${daysSinceVisit != null ? daysSinceVisit : ''} days since your last visit to ${clinicName || clinic}. Time for a checkup? Reply to book.`,
  },
  reengage_30: {
    name: 'reengage_30', vars: ['name', 'clinic'],
    variables: ['clientName', 'daysSinceVisit'],
    quickReplies: [],
    body: ({ clientName, clinicName = 'our clinic', name, clinic }) =>
      `Hi ${clientName || name}, it has been 30 days since your last visit to ${clinicName || clinic}. Time for a checkup? Reply to book.`,
  },
  reengage_60: {
    name: 'reengage_60', vars: ['name', 'clinic'],
    variables: ['clientName', 'daysSinceVisit'],
    quickReplies: [],
    body: ({ clientName, clinicName = 'our clinic', name, clinic }) =>
      `Hi ${clientName || name}, it has been 60 days since your last visit to ${clinicName || clinic}. Time for a checkup? Reply to book.`,
  },
  reengage_90: {
    name: 'reengage_90', vars: ['name', 'clinic'],
    variables: ['clientName', 'daysSinceVisit'],
    quickReplies: [],
    body: ({ clientName, clinicName = 'our clinic', name, clinic }) =>
      `Hi ${clientName || name}, it has been 90 days since your last visit to ${clinicName || clinic}. Time for a checkup? Reply to book.`,
  },
  staff_alert: {
    name: 'staff_alert', vars: ['event', 'detail'],
    variables: ['event', 'detail'],
    quickReplies: [],
    body: ({ event, detail } = {}) => `[STAFF] ${event}: ${detail}`,
  },
  receipt_ready: {
    name: 'receipt_ready', vars: ['name', 'clinic'],
    variables: ['clientName', 'amount'],
    quickReplies: [],
    body: ({ clientName, amount, clinicName = 'our clinic', name, clinic }) =>
      `Hi ${clientName || name}, your receipt for ₹${amount} from ${clinicName || clinic} is ready.`,
  },
};

function render(name, params = {}) {
  const tpl = TEMPLATES[name];
  if (!tpl) throw new Error(`unknown template: ${name}`);
  return tpl.body(params);
}

// Back-compat: M1 test uses renderTemplate(name,{name,slot,clinic}) + `Unknown template`.
function renderTemplate(name, params = {}) {
  const tpl = TEMPLATES[name];
  if (!tpl) throw new Error(`Unknown template: ${name}`);
  const mapped = { ...params };
  if (mapped.name && !mapped.clientName) mapped.clientName = mapped.name;
  if (mapped.slot && !mapped.slotStart) mapped.slotStart = mapped.slot;
  if (mapped.clinic && !mapped.clinicName) mapped.clinicName = mapped.clinic;
  return tpl.body(mapped);
}

module.exports = { TEMPLATES, render, renderTemplate };
