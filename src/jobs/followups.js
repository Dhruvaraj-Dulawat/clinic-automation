// ============================================================================
// clinic-automation — post-visit follow-up job (src/jobs/followups.js)
// Daily (schedule.json "followups.cron"): appointments completed daysAfter
// ago get the followup_visit template ("how are you feeling?").
// Idempotency: settings key followups.lastDateSent — one pass per day.
// Deps: ../db/repository.js (appointments, clients and the settings keys),
// ../services/messaging.js. The idempotency key is read and written through
// repo.settings, so this job contains no SQL of its own and the database can be
// swapped without touching it.
// Exports runFollowups (canonical, S5.1.2) + runOnce (legacy alias). Both
// accept (options, injected) where injected = { repo, messaging } for tests.
// ============================================================================
'use strict';

// Idempotency keys (settings table via the repository — see reminders.js for
// why this is repo.settings rather than an inline query). The getSetting /
// setSetting pair used to be copy-pasted into all three jobs; there is now ONE
// copy in ./settings.js so a fix to the failure handling cannot drift.
const { getSetting, setSetting } = require('./settings');

function dayStrOf(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function runFollowups({ daysAfter = 1 } = {}, injected = {}) {
  const repo = injected.repo || require('../db/repository');
  const messaging = injected.messaging || require('../services/messaging');
  const day = new Date();
  day.setDate(day.getDate() - daysAfter);
  const dayStr = dayStrOf(day);
  if (getSetting('followups.lastDateSent', repo) === dayStr) {
    return { checked: 0, sent: 0, skipped: 'already ran for ' + dayStr };
  }
  // Namespaced range query (M1 repository contract). Upper bound is midnight
  // of the NEXT day so a slot at 23:59 is still included (listByRange is
  // inclusive-lo / exclusive-hi).
  const next = new Date(day);
  next.setDate(next.getDate() + 1);
  const due = repo.appointments
    .listByRange(`${dayStr} 00:00`, `${dayStrOf(next)} 00:00`)
    .filter((a) => a.status === 'completed');
  let sent = 0;
  for (const appt of due) {
    const client = repo.clients.findById(appt.client_id);
    if (!client) continue;
    // Positional messaging signature: sendTemplated(to, template, params).
    await messaging.sendTemplated(client.phone, 'followup_visit', { clientName: client.name });
    sent += 1;
  }
  setSetting('followups.lastDateSent', dayStr, repo);
  return { checked: due.length, sent };
}

module.exports = { runOnce: runFollowups, runFollowups };
