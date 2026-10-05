// ============================================================================
// clinic-automation — 30/60/90-day re-engagement job (src/jobs/reengagement.js)
// Weekly (schedule.json "reengagement.cron"): clients whose LATEST completed
// appointment is ~N days ago (N in windowsDays) get the reengage_winback
// template. Idempotency: settings key reengagement.lastWeekSent (ISO week) —
// one pass per week so clients are pinged at most once per ladder rung.
// Deps: ../db/repository.js (appointments, clients and the settings keys),
// ../services/messaging.js. The idempotency key is read and written through
// repo.settings, so this job contains no SQL of its own and the database can be
// swapped without touching it.
// Exports runReengagement (canonical, S5.1.3) + runOnce (legacy alias). Both
// accept (options, injected) where injected = { repo, messaging } for tests.
// ============================================================================
'use strict';

// Idempotency keys (settings table via the repository — see reminders.js for
// why this is repo.settings rather than an inline query). The getSetting /
// setSetting pair used to be copy-pasted into all three jobs, with only the
// catch comment differing; there is now ONE copy in ./settings.js, which also
// retires the duplicated comment that used to sit on lines 44/45.
const { getSetting, setSetting } = require('./settings');

function isoWeek() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const week = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${week}`;
}

// Stored slots are local 'YYYY-MM-DD HH:mm' — parse them as local time.
function parseLocal(s) {
  return new Date(String(s).replace(' ', 'T') + ':00');
}

async function runReengagement({ windowsDays = [30, 60, 90] } = {}, injected = {}) {
  const repo = injected.repo || require('../db/repository');
  const messaging = injected.messaging || require('../services/messaging');
  const week = isoWeek();
  if (getSetting('reengagement.lastWeekSent', repo) === week) {
    return { checked: 0, sent: 0, skipped: 'already ran for ' + week };
  }
  const ladder = [...windowsDays].sort((a, b) => a - b);
  const floor = Math.min(...ladder);
  // Namespaced candidate query (M1 repository contract): every client whose
  // LATEST visit is older than the smallest rung, with the visit timestamp
  // attached as `last_visit`. Rung matching below decides who is sent to.
  const candidates = repo.appointments.findInactiveSince(floor);
  const now = new Date();
  let checked = 0;
  let sent = 0;
  for (const client of candidates) {
    if (!client.last_visit) continue;
    checked += 1;
    const daysSince = Math.floor((now - parseLocal(client.last_visit)) / 86400000);
    // Largest rung at/below daysSince; send when the rung was crossed within
    // the last 7 days (weekly cadence: a client crossing a rung mid-week is
    // caught by the next run, and never re-pinged for the same rung).
    const rung = [...ladder].reverse().find((w) => daysSince >= w);
    if (rung === undefined || daysSince - rung > 7) continue;
    // Positional messaging signature: sendTemplated(to, template, params).
    await messaging.sendTemplated(client.phone, 'reengage_winback', {
      clientName: client.name,
      daysSinceVisit: String(daysSince),
    });
    sent += 1;
  }
  setSetting('reengagement.lastWeekSent', week, repo);
  return { checked, sent };
}

module.exports = { runOnce: runReengagement, runReengagement };
