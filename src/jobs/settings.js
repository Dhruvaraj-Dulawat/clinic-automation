// ============================================================================
// clinic-automation — shared settings-key helpers (src/jobs/settings.js)
// ONE copy of the getSetting/setSetting pair that reminders.js, followups.js and
// reengagement.js each used to carry verbatim. Three identical copies meant a
// fix to the failure handling had to be made three times, and it had drifted:
// only the comment differed.
//
// The keys live in the `settings` table and are read/written through
// repo.settings — src/db/repository.js owns the SQL, so no job holds a query of
// its own and the database stays swappable.
//
// Failure policy (deliberate, and the reason this is shared rather than open-coded
// in each job): a READ that fails yields '' — the key looks unset, so the job
// treats the work as "not done yet" and attempts it. That is the SAFE direction
// for an idempotency key: at worst a message is sent twice, which is far better
// than silently skipping a real patient's reminder. A WRITE that fails is
// swallowed for the same reason — a later tick re-sends rather than losing the
// send. Callers that need the outcome must not assume the key was written.
// Deps: ../db/repository.js (lazily, so requiring this file opens no database).
// Pure enough to require from a job and from a test with an injected repo.
// ============================================================================
'use strict';

/**
 * Read a settings key.
 * @param {string} key
 * @param {object} [repo] injected repository; falls back to the real one
 * @returns {string} the stored value, or '' when unset/unreadable
 */
function getSetting(key, repo) {
  try {
    const { settings } = repo && repo.settings ? repo : require('../db/repository');
    const value = settings.get(key);
    return value === null || value === undefined ? '' : value;
  } catch (_) {
    return '';
  }
}

/**
 * Write a settings key. Never throws: an unwritable key must not abort a cron
 * tick that has already sent its messages.
 * @param {string} key
 * @param {*} value coerced with String()
 * @param {object} [repo] injected repository; falls back to the real one
 * @returns {boolean} whether the write is believed to have landed
 */
function setSetting(key, value, repo) {
  try {
    const { settings } = repo && repo.settings ? repo : require('../db/repository');
    settings.set(key, String(value));
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { getSetting, setSetting };
