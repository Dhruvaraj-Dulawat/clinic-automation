// ============================================================================
// clinic-automation — cron wiring (src/jobs/index.js)
// Reads src/config/schedule.json and registers FOUR jobs with node-cron:
//   reminders    */15 * * * *   24h-before appointment reminder
//   followups    0 10 * * *     post-visit check-in
//   reengagement 0 11 * * MON   30/60/90-day win-back ladder
//   digest       0 8 * * MON    weekly owner digest (services/digest.js)
// startAll() is called by src/server.js and returns the array of task objects;
// the scheduler is a module-level singleton guarded so double-boot never
// double-sends. server.js safe-requires this file — a missing schedule.json
// must not crash boot, it just skips the scheduler with a warning.
//
// --- OVERLAP GUARD ----------------------------------------------------------
// node-cron starts a run every time its expression fires, even when the
// previous run is still going. Reminders fires every 15 MINUTES against real
// WhatsApp sends, so a slow run would otherwise overlap itself and double-send.
// Each job keeps an in-flight flag: if that job is already running when the
// tick fires, the tick is logged and skipped instead of starting a second
// concurrent run. The flag is set SYNCHRONOUSLY — before the task function
// gets a chance to yield — so two ticks in the same event-loop turn cannot both
// slip past the guard, and it is cleared in finally() no matter how the run
// ends (success, rejection, or synchronous throw).
//
// --- LOUD SCHEDULE DRIFT ---------------------------------------------------
// A schedule.json that cannot be read or parsed used to fall back to the
// built-in defaults behind a single quiet console.warn, so a corrupt file
// silently moved every patient's reminder/follow-up/digest time with nothing on
// the console to say so. loadSchedule() now prints a boxed warning naming the
// error AND listing the cron expressions actually in force. Per-job shape
// problems are reported individually instead of taking the whole scheduler
// down, and a job key that nobody registers is called out — that silent
// no-register case is exactly how `digest` went missing in the first place.
//
// JOBS_HOOK NOTE (S5.1.4): src/server.js is M1-owned — DO NOT rewrite it.
// It already contains the hook: `require('./jobs')` + `jobs.start()`.
// This module therefore exports `start` (what server.js calls) alongside the
// `startAll`/`startJobs` aliases (S5.1.4 canonical name). If server.js ever
// loses that hook, re-add:
//   const jobs = require('./jobs');
//   if (jobs && typeof jobs.start === 'function') jobs.start();
// Deps: node-cron, ./reminders.js, ./followups.js, ./reengagement.js and
// ../services/digest.js. Every job module is required LAZILY inside its own
// tick callback, so a missing or broken job module can never break boot — the
// failure surfaces as one logged error for that one job.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const SCHEDULE_FILE = path.join(__dirname, '..', 'config', 'schedule.json');
const BOX = '='.repeat(70);

let started = false;

// In-flight job labels for the overlap guard (see header).
const inFlight = new Set();

// --- test seams for the overlap guard ---------------------------------------
// Exported so the guard can be proven without waiting on a real cron tick.
function _isRunning(label) {
  return inFlight.has(label);
}

function _markRunning(label) {
  inFlight.add(label);
}

function _clearRunning(label) {
  inFlight.delete(label);
}

/** Print a boxed, high-visibility operator warning. */
function loudWarn(lines) {
  console.warn(`\n${BOX}`);
  console.warn('[jobs] *** SCHEDULER WARNING — OPERATOR ACTION REQUIRED ***');
  for (const line of lines) console.warn(`[jobs] ${line}`);
  console.warn(`${BOX}\n`);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read schedule.json and merge it over the built-in defaults.
 *
 * @param {string} [file] Override for the schedule file. Defaults to
 *   src/config/schedule.json; the parameter exists so the drift paths can be
 *   exercised against a throwaway fixture instead of the real config.
 * @returns {object} Always a usable schedule for all four jobs. Never throws.
 */
function loadSchedule(file) {
  const source = file || SCHEDULE_FILE;
  const fallback = {
    reminders: { cron: '*/15 * * * *', hoursBefore: 24, lookAheadMinutes: 20 },
    followups: { cron: '0 10 * * *', daysAfter: 1 },
    reengagement: { cron: '0 11 * * MON', windowsDays: [30, 60, 90] },
    digest: { cron: '0 8 * * MON' },
  };
  const labels = Object.keys(fallback);
  const schedule = Object.assign({}, fallback);
  const warnings = [];

  let parsed;
  let parseFailed = false;
  try {
    parsed = JSON.parse(fs.readFileSync(source, 'utf8'));
  } catch (err) {
    parseFailed = true;
    warnings.push(`could not read/parse ${source} (${err.message}) — every job is using its BUILT-IN default cron.`);
  }

  if (!parseFailed) {
    if (!isPlainObject(parsed)) {
      warnings.push(`${source} has no JSON object at the top level (got ${Array.isArray(parsed) ? 'array' : typeof parsed}) — every job is using its BUILT-IN default cron.`);
    } else {
      for (const label of labels) {
        const entry = parsed[label];
        if (entry === undefined) {
          warnings.push(`"${label}" is missing from schedule.json — using default cron "${fallback[label].cron}".`);
        } else if (!isPlainObject(entry)) {
          warnings.push(`"${label}" is not an object in schedule.json — using default cron "${fallback[label].cron}".`);
        } else if (typeof entry.cron !== 'string' || entry.cron.trim() === '') {
          warnings.push(`"${label}".cron is missing or not a non-empty string in schedule.json — using default cron "${fallback[label].cron}".`);
        } else {
          schedule[label] = Object.assign({}, fallback[label], entry, { cron: entry.cron.trim() });
        }
      }
      // Drift detector: a declared job nobody registers would never run, and
      // that is precisely the failure mode this scheduler already shipped once.
      const unknown = Object.keys(parsed).filter((k) => !k.startsWith('_') && labels.indexOf(k) === -1);
      for (const key of unknown) {
        warnings.push(`schedule.json declares "${key}", which this scheduler does not register — it will NEVER run. Registered jobs: ${labels.join(', ')}.`);
      }
    }
  }

  if (warnings.length) {
    loudWarn(warnings);
    console.warn('[jobs] cron expressions actually in force:');
    for (const label of labels) {
      console.warn(`[jobs]   ${label.padEnd(13)} ${schedule[label].cron}`);
    }
    console.warn('');
  }
  return schedule;
}

function startAll() {
  if (started) return [];
  const cron = require('node-cron');
  const schedule = loadSchedule();
  const tasks = [];
  const register = (expr, fn, label) => {
    if (typeof expr !== 'string' || !cron.validate(expr)) {
      console.warn(`[jobs] *** ${label} WILL NOT RUN *** invalid cron expression "${expr}" — this job is skipped entirely.`);
      return;
    }
    const task = cron.schedule(expr, () => {
      if (inFlight.has(label)) {
        console.warn(`[jobs] ${label} still running — skipping this tick (overlap guard)`);
        return;
      }
      // Set the flag before fn() can yield (see header).
      inFlight.add(label);
      // Promise.resolve().then(fn) normalises BOTH a synchronous throw inside fn
      // (e.g. MODULE_NOT_FOUND from the lazy require) and a rejected promise
      // into one logged error, so a broken job module cannot crash the process.
      // .finally() always releases the guard, or the job would deadlock itself.
      Promise.resolve()
        .then(fn)
        .catch((err) => console.error(`[jobs] ${label} failed:`, err && err.message ? err.message : err))
        .finally(() => inFlight.delete(label));
    });
    tasks.push(task);
    console.log(`[jobs] ${label} scheduled: ${expr}`);
  };

  register(schedule.reminders.cron, () => require('./reminders').runReminders(schedule.reminders), 'reminders');
  register(schedule.followups.cron, () => require('./followups').runFollowups(schedule.followups), 'followups');
  register(schedule.reengagement.cron, () => require('./reengagement').runReengagement(schedule.reengagement), 'reengagement');
  // The fourth job. services/digest.js takes no options — it resolves the owner
  // phone from config itself — so it is invoked bare. The require stays lazy
  // and inside the tick, so a missing/broken digest.js is just one failed run.
  register(schedule.digest.cron, () => require('../services/digest').sendWeeklyDigest(), 'digest');

  started = true;
  return tasks;
}

function resetForTests() {
  started = false;
  inFlight.clear();
}

module.exports = {
  startAll,
  start: startAll,
  startJobs: startAll,
  loadSchedule,
  resetForTests,
  _isRunning,
  _markRunning,
  _clearRunning,
};
