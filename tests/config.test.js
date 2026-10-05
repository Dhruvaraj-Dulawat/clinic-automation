// ============================================================================
// clinic-automation — config validation tests (tests/config.test.js)
// Permanent guard for D13. Lives in tests/ (not src/**/__tests__/*.isolated)
// on purpose: this file IS inside the `npm test` glob, so it runs on every
// suite and cannot be "deleted after pass" into a coverage hole.
//
// D13 background: src/config.js parses CLINIC_HOURS_JSON. The bug class was a
// SILENT default — a setting the operator wrote was quietly ignored, so the
// clinic booked patients on a day it was closed. `[1,2,3,4,5,6]` (the form
// shipped in .env.example) parses as valid JSON, so spreading it over the
// defaults leaked index keys and left `days` at [1..6]. Every test below asserts
// that a value is either HONOURED or REJECTED BY NAME — never silently ignored.
//
// Hermetic: no DB, no Express, no network. config.js's only inputs are
// process.env and dotenv, so every key is pinned per case and the module cache
// is purged (getConfig() memoises).
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, '..', 'src', 'config.js');

// A throwaway DB path for getConfig() to resolve under NODE_ENV=test. src/config.js
// REFUSES to fall back to ./data/clinic.db in test mode (see dbPathFrom), so a case
// that does not name a database would fail on that guard before reaching its own
// assertion. The file is never actually opened here - config.js only validates the
// path - but it must unmistakably not be the real clinic database.
const DB_PATH_FOR_TESTS = path.join(os.tmpdir(), 'opencode', 'config-test-unused.db');

// Every env key src/config.js reads. Pinned to '' rather than deleted: dotenv
// skips keys that already exist in process.env, so '' blocks the operator's
// real .env from leaking into a case under test. DB_PATH is overridden per case
// by the throwaway path above, because config.js refuses to default it in test mode.
const MANAGED = [
  'NODE_ENV', 'PORT', 'DB_PATH', 'CLINIC_NAME', 'SESSION_SECRET', 'ADMIN_USERNAME',
  'ADMIN_PASSWORD_HASH', 'WHATSAPP_MOCK_MODE', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_API_VERSION', 'WHATSAPP_VERIFY_TOKEN', 'OWNER_PHONE', 'CLINIC_HOURS_JSON',
  'SLOT_MINUTES', 'SLOT_OPEN', 'SLOT_CLOSE', 'SLOT_DURATION_MIN', 'SLOT_START_HOUR',
  'SLOT_END_HOUR', 'TRUST_PROXY', 'SESSION_TTL_HOURS', 'RATE_LIMIT_STRICT_MAX',
  'RATE_LIMIT_STANDARD_MAX', 'RATE_LIMIT_RELAXED_MAX',
];

/** Load a pristine getConfig() with `env` applied on top of the pins. */
function loadConfig(env) {
  for (const key of MANAGED) process.env[key] = '';
  process.env.NODE_ENV = 'test';
  process.env.SESSION_SECRET = 'test-session-secret-min-32-chars-xxxx';
  process.env.ADMIN_PASSWORD_HASH = '$2b$10$abcdefghijklmnopqrstuv';
  // src/config.js REFUSES to fall back to ./data/clinic.db when NODE_ENV=test, so
  // the MANAGED loop above (which pins every key to '' so the operator's real .env
  // cannot leak into a case) would make every case below fail on that guard before
  // reaching its own assertion. Name a throwaway database to satisfy it.
  // Nothing in this suite opens a database - getConfig() only validates and returns
  // strings - but the path must still be unmistakably NOT the real clinic DB, so a
  // future change that made this suite open it would write to the OS temp dir.
  process.env.DB_PATH = path.join(os.tmpdir(), 'opencode', 'config-test-unused.db');
  Object.assign(process.env, env || {});
  delete require.cache[require.resolve(CONFIG_PATH)];
  return require(CONFIG_PATH).getConfig();
}

/** Assert a value is rejected, and that the message names what offended. */
function assertRejected(env, mustMention) {
  let err = null;
  try {
    loadConfig(env);
  } catch (e) {
    err = e;
  }
  assert.ok(err, `expected ${JSON.stringify(env)} to be rejected, but it was accepted`);
  assert.match(err.message, /^\[config\] /, 'errors are prefixed [config]');
  if (mustMention) {
    assert.ok(err.message.includes(mustMention),
      `error must name the offending value "${mustMention}", got: ${err.message}`);
  }
  return err.message;
}

test.after(() => { for (const key of MANAGED) delete process.env[key]; });

test('D13: a bare [1,2,3,4,5,6] day list is the working-weekdays list', () => {
  // The exact value shipped in .env.example and in the live .env.
  const cfg = loadConfig({ CLINIC_HOURS_JSON: '[1,2,3,4,5,6]' });
  assert.deepEqual(cfg.clinicHours.days, [1, 2, 3, 4, 5, 6]);
});

test('D13: a day list that differs from the default is honoured, not ignored', () => {
  // THE regression: the old code spread the array over the defaults, so `days`
  // stayed [1..6] and a clinic that closed Wed-Sat kept booking Wed-Sat.
  const cfg = loadConfig({ CLINIC_HOURS_JSON: '[1,2,3]' });
  assert.deepEqual(cfg.clinicHours.days, [1, 2, 3], 'the operator day list must win');
  assert.equal(cfg.clinicHours.days.includes(5), false, 'Saturday must be closed');
});

test('D13: no array index keys leak into clinicHours', () => {
  const cfg = loadConfig({ CLINIC_HOURS_JSON: '[1,2,3,4,5,6]' });
  assert.deepEqual(Object.keys(cfg.clinicHours).sort(),
    ['close', 'days', 'maxAdvanceDays', 'open', 'slotMinutes']);
  assert.equal('0' in cfg.clinicHours, false, 'the "0".."5" index keys are gone');
  assert.deepEqual(loadConfig({ CLINIC_HOURS_JSON: '["1","2"]' }).clinicHours.days, [1, 2]);
});

test('a real JSON object is accepted and unknown keys are named, not dropped', () => {
  const cfg = loadConfig({
    CLINIC_HOURS_JSON: '{"days":[1,2],"open":"08:00","close":"13:00","slotMinutes":45}',
  });
  assert.deepEqual(cfg.clinicHours.days, [1, 2]);
  assert.equal(cfg.clinicHours.open, '08:00');
  assert.equal(cfg.clinicHours.close, '13:00');
  assert.equal(cfg.clinicHours.slotMinutes, 45);
  assert.equal(cfg.clinicHours.maxAdvanceDays, 30, 'omitted keys keep their default');

  // A typo must not silently fall back to the default opening hour.
  assertRejected({ CLINIC_HOURS_JSON: '{"opne":"09:00"}' }, 'opne');
});

test('every malformed clinic-hours value is rejected naming the value', () => {
  const cases = [
    ['[1,2,notanumber]', 'notanumber'],
    ['{"days":"nope"}', 'nope'],
    ['{"days":[9]}', '9'],
    ['{"days":[]}', 'days'],
    ['[]', 'days'],
    ['{"open":"9am"}', '9am'],
    ['{"close":"25:00"}', '25:00'],
    ['{"slotMinutes":0}', 'slotMinutes'],
    ['{"maxAdvanceDays":-1}', 'maxAdvanceDays'],
    ['not json at all', 'not json at all'],
  ];
  for (const [value, mention] of cases) {
    assertRejected({ CLINIC_HOURS_JSON: value }, mention);
  }
});

test('junk numeric settings are rejected instead of becoming NaN', () => {
  // NaN slotMinutes made buildSlots() return zero slots: a live clinic with an
  // empty calendar and no error message.
  assertRejected({ SLOT_MINUTES: 'abc' }, 'abc');
  assertRejected({ SLOT_DURATION_MIN: '30abc' }, '30abc');
  assertRejected({ SLOT_MINUTES: '0' }, '0');
  assertRejected({ SLOT_OPEN: '9am' }, '9am');
  assertRejected({ SLOT_CLOSE: '25:00' }, '25:00');
  assertRejected({ SLOT_START_HOUR: 'nine' }, 'nine');
  assertRejected({ SLOT_END_HOUR: '99' }, '99');
  assertRejected({ PORT: 'notaport' }, 'notaport');
  assertRejected({ PORT: '70000' }, '70000');
  assertRejected({ SESSION_TTL_HOURS: 'x' }, 'x');
  assertRejected({ TRUST_PROXY: 'maybe' }, 'maybe');
});

test('a well-formed but unusable slot grid is still rejected', () => {
  // Both of these produce a valid-looking object that yields ZERO slots.
  assertRejected({ SLOT_START_HOUR: '18', SLOT_END_HOUR: '9' }, '18:00');
  assertRejected({ SLOT_DURATION_MIN: '601' }, '601');
  // 600 min exactly fills the 09:00-19:00 window, so one slot remains: allowed.
  assert.equal(loadConfig({ SLOT_DURATION_MIN: '600' }).clinicHours.slotMinutes, 600);
});

test('SLOT_* aliases still override the JSON, in the documented order', () => {
  const cfg = loadConfig({
    CLINIC_HOURS_JSON: '{"days":[1,2],"open":"08:00","close":"13:00","slotMinutes":45}',
    SLOT_MINUTES: '20',
    SLOT_DURATION_MIN: '25',     // beats SLOT_MINUTES
    SLOT_OPEN: '07:00',
    SLOT_START_HOUR: '8',        // beats SLOT_OPEN
    SLOT_CLOSE: '14:00',
    SLOT_END_HOUR: '15',         // beats SLOT_CLOSE
  });
  assert.equal(cfg.clinicHours.slotMinutes, 25);
  assert.equal(cfg.clinicHours.open, '08:00');
  assert.equal(cfg.clinicHours.close, '15:00');
  // A blank alias is ignored (helpers.js neutralises .env this way).
  assert.equal(loadConfig({ SLOT_OPEN: '', SLOT_CLOSE: '' }).clinicHours.open, '09:00');
  // SLOT_END_HOUR=24 keeps a full-day window working.
  assert.equal(loadConfig({ SLOT_END_HOUR: '24' }).clinicHours.close, '24:00');
});

test('defaults apply when CLINIC_HOURS_JSON is absent or empty', () => {
  const expected = { days: [1, 2, 3, 4, 5, 6], open: '09:00', close: '19:00', slotMinutes: 30, maxAdvanceDays: 30 };
  assert.deepEqual(loadConfig({}).clinicHours, expected);
  assert.deepEqual(loadConfig({ CLINIC_HOURS_JSON: '' }).clinicHours, expected);
});

test('the module contract, memoisation and test-mode fallbacks are unchanged', () => {
  assert.deepEqual(Object.keys(require(CONFIG_PATH)).sort(), ['getConfig']);

  const first = loadConfig({ CLINIC_NAME: 'First' });
  assert.equal(first, require(CONFIG_PATH).getConfig(), 'getConfig() memoises');
  process.env.CLINIC_NAME = 'Second';
  assert.equal(require(CONFIG_PATH).getConfig().clinicName, 'First');

  // NODE_ENV=test keeps the redacted fallbacks; production fails fast.
  for (const key of MANAGED) process.env[key] = '';
  process.env.NODE_ENV = 'test';
  // config.js deliberately REFUSES to fall back to ./data/clinic.db under
  // NODE_ENV=test (so a test run can never write the real clinic database), so
  // DB_PATH has to be supplied explicitly here.
  process.env.DB_PATH = path.join(os.tmpdir(), 'clinic-config-contract.db');
  delete require.cache[require.resolve(CONFIG_PATH)];
  const relaxed = require(CONFIG_PATH).getConfig();
  assert.equal(relaxed.sessionSecret, 'test-session-secret-min-32-chars-xxxx');
  assert.equal(relaxed.adminPasswordHash, 'test-hash');
  assert.equal(relaxed.isProd, false);

  process.env.NODE_ENV = 'production';
  process.env.SESSION_SECRET = 'x'.repeat(40);
  process.env.ADMIN_PASSWORD_HASH = '$2b$10$abc';
  delete require.cache[require.resolve(CONFIG_PATH)];
  assert.equal(require(CONFIG_PATH).getConfig().isProd, true);
});

test('the middleware knobs keep their documented defaults', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.trustProxy, false);
  assert.equal(cfg.sessionTtlHours, 12, 'matches the session cookie maxAge');
  assert.deepEqual(cfg.rateLimit, {
    strict: { windowMs: 600000, max: 10 },
    standard: { windowMs: 60000, max: 30 },
    relaxed: { windowMs: 60000, max: 300 },
  });
  const tuned = loadConfig({
    TRUST_PROXY: 'yes', SESSION_TTL_HOURS: '4',
    RATE_LIMIT_STRICT_MAX: '3', RATE_LIMIT_STANDARD_MAX: '50', RATE_LIMIT_RELAXED_MAX: '900',
  });
  assert.equal(tuned.trustProxy, true);
  assert.equal(tuned.sessionTtlHours, 4);
  assert.equal(tuned.rateLimit.strict.max, 3);
  assert.equal(tuned.rateLimit.relaxed.max, 900);
});
