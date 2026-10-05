// ============================================================================
// clinic-automation — outbound messaging: send + log (src/services/messaging.js)
// Rule: EVERY outbound WhatsApp attempt is logged to the messages table win
// or fail (status sent|mocked|failed), so the admin dashboard can audit.
// Nothing is ever silently dropped: send failures are logged AND escalated
// to the owner via staffNotify (except owner-bound sends themselves, to
// avoid an escalation loop). Never throws for transport errors — callers
// (bookings, jobs, webhook) must not break when WhatsApp is down.
//
// RETURN CONTRACT: every send* resolves to the PERSISTED messages ROW, not to
// the rowid. See loggedRow() below for why that distinction is load-bearing.
// Deps: ../whatsapp/provider.js, ../whatsapp/templates.js,
//   ../db/repository.js, ../config.js (clinicName, ownerPhone).
// ============================================================================
'use strict';

const provider = require('../whatsapp/provider');
const { TEMPLATES, render } = require('../whatsapp/templates');

function getRepo() {
  const r = require('../db/repository');
  // Canonical namespaced shape first (M1 contract: messages.log);
  // flat logMessage alias only as fallback.
  if (r && r.messages && typeof r.messages.log === 'function') {
    return { logMessage: (o) => r.messages.log(o) };
  }
  if (r && typeof r.logMessage === 'function') {
    return { logMessage: (o) => r.logMessage(o) };
  }
  throw new Error('messages.log is unavailable');
}

// Log one outbound message and resolve to the row that was persisted.
//
// WHY THIS EXISTS (D18). messages.log() ends at `return info.lastInsertRowid`
// (db/repository.js), so a send used to resolve to a NUMBER. Callers read
// `.status` off that result, and a number has no such property, so the read
// yielded `undefined` - indistinguishable from a status nobody recognised. The
// worst instance is jobs/reminders.js: it decides whether a patient was really
// reminded by testing that status against DELIVERED ('sent'|'mocked'), so every
// real send read as undelivered, nothing was ever marked
// reminders.sent.<appointmentId>, and the 15-minute cron re-sent the same
// reminder to a real patient forever. Reading the row back through
// messages.statusById() puts `.status` (and `.id`, `.createdAt`, the provider
// id) on the value the caller actually receives, so no caller has to know that
// logging happens behind the scenes.
//
// Never throws: this module promises a failed provider never breaks its caller
// (bookings, jobs, webhook), so an unreadable row degrades to the minimal
// { id, status } built from the entry just written - still the honest status,
// because it is the one the INSERT was given.
function loggedRow(entry) {
  const id = getRepo().logMessage(entry);
  try {
    const r = require('../db/repository');
    const row = r && r.messages && typeof r.messages.statusById === 'function'
      ? r.messages.statusById(id)
      : null;
    if (row) return row;
  } catch (_) {
    // A repository that cannot read its own table back must not turn a delivered
    // message into a thrown error at the call site; fall through.
  }
  return { id, status: entry.status };
}

function clinicName() {
  try {
    return require('../config').getConfig().clinicName || 'our clinic';
  } catch (_) {
    return 'our clinic';
  }
}

function ownerPhone() {
  try {
    return require('../config').getConfig().ownerPhone || '';
  } catch (_) {
    return process.env.OWNER_PHONE || '';
  }
}

// Fire-and-forget escalation for a failed send. Skips owner-bound sends so
// a failing owner notification cannot re-trigger itself in a loop. Never
// throws — escalation must not break the caller's flow.
function escalateFailure({ toPhone, template, error }) {
  try {
    if (toPhone && ownerPhone() && String(toPhone) === String(ownerPhone())) return;
    require('./staffNotify').notifySendFailure({ toPhone, template, error }).catch(() => {});
  } catch (_) {
    // staffNotify not landed yet or misconfigured — failure is still logged.
  }
}

async function sendTemplated(toPhone, templateName, params = {}) {
  const tpl = TEMPLATES[templateName];
  if (!tpl) throw new Error(`unknown template: ${templateName}`);
  const body = render(templateName, { ...params, clinicName: clinicName() });
  try {
    const { id, mocked } = await provider.sendText(toPhone, body, { quickReplies: tpl.quickReplies });
    return loggedRow({
      toPhone,
      direction: 'outbound',
      template: templateName,
      body,
      status: mocked ? 'mocked' : 'sent',
      waMessageId: id,
    });
  } catch (err) {
    escalateFailure({ toPhone, template: templateName, error: err });
    return loggedRow({
      toPhone,
      direction: 'outbound',
      template: templateName,
      body,
      status: 'failed',
    });
  }
}

async function sendFreeform(toPhone, body) {
  try {
    const { id, mocked } = await provider.sendText(toPhone, body);
    return loggedRow({
      toPhone,
      direction: 'outbound',
      template: 'freeform',
      body,
      status: mocked ? 'mocked' : 'sent',
      waMessageId: id,
    });
  } catch (err) {
    escalateFailure({ toPhone, template: 'freeform', error: err });
    return loggedRow({ toPhone, direction: 'outbound', template: 'freeform', body, status: 'failed' });
  }
}

// Document/media send + log (receipt PDFs). Same win-or-fail logging rule
// as text sends. `link` must be a public URL the Cloud API can fetch; in
// MOCK_MODE no network happens and the send is logged as mocked.
async function sendDocument(toPhone, { link, filename = 'document.pdf', caption = '', template = 'receipt_ready' } = {}) {
  const body = link || '';
  try {
    const { id, mocked } = await provider.sendMedia(toPhone, { link, filename, caption });
    return loggedRow({
      toPhone,
      direction: 'outbound',
      template,
      body,
      status: mocked ? 'mocked' : 'sent',
      waMessageId: id,
    });
  } catch (err) {
    escalateFailure({ toPhone, template, error: err });
    return loggedRow({ toPhone, direction: 'outbound', template, body, status: 'failed' });
  }
}

module.exports = { sendTemplated, sendFreeform, sendDocument, sendAndLog: sendFreeform };