// clinic-automation — central configuration (src/config.js)
// Purpose: load .env via dotenv, validate required keys fail-fast, expose
// clinic hours/slot settings. Consumed by: db.js, app.js, scheduling.js,
// whatsapp/provider.js, jobs. Env keys: see .env.example.
// VALIDATION POLICY: every value that drives the booking grid (days / open /
// close / slotMinutes) or the listen port is checked here, because a silently
// ignored setting is worse than a boot failure — a clinic that closed Wed-Sat
// would still book Wed-Sat, and a junk slotMinutes would show an empty calendar.
// Nothing in this module throws on a value it can still make sense of; it only
// rejects values it would otherwise misinterpret.
// DATABASE PATH POLICY: DB_PATH is the one setting above that must NEVER fall back
// quietly, because src/db/db.js opens cfg.dbPath and MIGRATES IT ON BOOT - so any
// process that reaches getDb() without DB_PATH writes to the real clinic database
// (schema changes first, then whatever rows it goes on to insert). Under
// NODE_ENV=test there is therefore no fallback at all: DB_PATH must be supplied
// explicitly, and a value merely inherited from .env is rejected too. See
// dbPathFrom(). Production and dev keep the ./data/clinic.db default, unchanged.
'use strict';

const path = require('path');

const DEFAULT_CLINIC_HOURS = Object.freeze({
  days: [1, 2, 3, 4, 5, 6], // 0 = Sunday … 6 = Saturday
  open: '09:00',
  close: '19:00',
  slotMinutes: 30,
  maxAdvanceDays: 30,
});

// The only keys accepted inside CLINIC_HOURS_JSON. Anything else is a typo
// ("opne", "slot_minutes") that would otherwise be silently dropped and leave
// the default in place, so it is named in the error instead.
const CLINIC_HOURS_KEYS = ['days', 'open', 'close', 'slotMinutes', 'maxAdvanceDays'];

const CLINIC_HOURS_HINT = 'see .env.example — use [1,2,3,4,5,6] for the working weekdays, '
  + 'or {"days":[1,2,3,4,5,6],"open":"09:00","close":"19:00","slotMinutes":30}';

const TIME_RE = /^([0-9]{1,2}):([0-9]{2})$/;
const INTEGER_RE = /^-?[0-9]+$/;
const TRUTHY = ['true', '1', 'yes', 'on'];
const FALSY = ['false', '0', 'no', 'off'];

// Rate-limit profiles. The windows are fixed policy (only the request ceiling
// is operator-tunable) so the defaults stay a deliberate, reviewable choice:
// admin login and booking are strict, ordinary reads standard, exports relaxed.
const RATE_PROFILES = {
  strict: { windowMs: 10 * 60 * 1000, max: 10, env: 'RATE_LIMIT_STRICT_MAX' },
  standard: { windowMs: 60 * 1000, max: 30, env: 'RATE_LIMIT_STANDARD_MAX' },
  relaxed: { windowMs: 60 * 1000, max: 300, env: 'RATE_LIMIT_RELAXED_MAX' },
};

// True for an unset/empty/whitespace-only env VALUE. The name-taking form
// (isBlank) lives in the helpers section below; this one is declared up here
// because the dotenv block has to inspect DB_PATH before that section is read.
function isBlankValue(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

// Load .env if present (production VPS uses env_file; local dev uses .env).
// dotenv is a hard dependency — but require defensively so `node --check`
// and unit tests never crash when node_modules is absent.
//
// DB_PATH is sampled on BOTH sides of the call below, on purpose. dotenv only
// fills in keys that are ABSENT, so comparing the pair later distinguishes "the
// caller chose this database" from "this process just inherited .env". That
// difference is the whole point of dbPathFrom(): a plain "is DB_PATH empty?"
// test is a no-op here, because .env sets DB_PATH=./data/clinic.db and dotenv has
// already made it look set by the time getConfig() runs.
const DB_PATH_PRE_DOTENV = process.env.DB_PATH;
try {
  require('dotenv').config();
} catch (e) {
  // dotenv not installed yet (pre `npm install`) — env comes from process only.
}
const DB_PATH_FROM_DOTENV = isBlankValue(DB_PATH_PRE_DOTENV) ? process.env.DB_PATH : null;

function required(name) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new Error(`[config] Missing required env var ${name} (see .env.example)`);
  }
  return String(v);
}

function optional(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === null || v === '' ? fallback : String(v);
}

// True for an unset/empty/whitespace-only env var — the state the test harness
// uses to neutralise the operator's .env aliases.
function isBlank(name) {
  return isBlankValue(process.env[name]);
}

// The database file every NON-test mode falls back to. Named so the guard
// message and the default can never drift apart.
const DEFAULT_DB_PATH = './data/clinic.db';

/**
 * DB_PATH resolution - the one setting in this module that must never fall back
 * quietly.
 *
 * WHY THIS FAILS CLOSED UNDER NODE_ENV=test. src/db/db.js opens cfg.dbPath and
 * MIGRATES IT ON BOOT, so any process that reaches getDb() without DB_PATH writes
 * to the real clinic database: schema changes first, then whatever rows it goes on
 * to insert. That is not hypothetical - data/clinic.db came to hold test fixtures
 * ("E2E Patient", "Legacy Button Payload") plus their appointments and messages.
 * This module already fails closed for SESSION_SECRET / ADMIN_PASSWORD_HASH under
 * NODE_ENV=test; DB_PATH is the same policy applied to the one setting that was
 * still fail-open.
 *
 * Three ways to end up aimed at the operator's database, hence three rejections:
 *   1. DB_PATH blank              -> nothing named a database at all;
 *   2. DB_PATH === the .env value -> it looks set, but the caller never chose it,
 *      dotenv just back-filled the production path (see DB_PATH_FROM_DOTENV);
 *   3. DB_PATH resolves to the production file -> named explicitly, and that is
 *      still a test about to migrate and write real patient data.
 * Rejecting (2) is what makes this guard real rather than decorative; (3) closes
 * the remaining deliberate route. Compared by resolved path, so an absolute path
 * to the same file is caught too.
 *
 * Production and dev are untouched: they still resolve to DEFAULT_DB_PATH.
 *
 * @param {boolean} isTest  whether NODE_ENV === test
 * @returns {string} the database path to open
 */
function dbPathFrom(isTest) {
  if (isTest) {
    const raw = process.env.DB_PATH;
    if (isBlankValue(raw)) {
      throw new Error(
        '[config] NODE_ENV=test requires an explicit DB_PATH (e.g. a temp file); refusing to'
        + ` fall back to ${DEFAULT_DB_PATH} so tests can never write the real clinic database`
      );
    }
    if (raw === DB_PATH_FROM_DOTENV) {
      throw new Error(
        '[config] NODE_ENV=test requires an explicit DB_PATH, but the only value set is the'
        + ` ${DEFAULT_DB_PATH} inherited from .env; point DB_PATH at a temp file`
        + ' (tests/helpers.js testEnv() does this) so tests can never write the real'
        + ' clinic database'
      );
    }
    if (path.resolve(String(raw)) === path.resolve(DEFAULT_DB_PATH)) {
      throw new Error(
        `[config] NODE_ENV=test refuses DB_PATH=${raw}: that is the production clinic`
        + ' database. Point DB_PATH at a temp file (tests/helpers.js testEnv() does'
        + ' this) so tests can never migrate or write real patient data.'
      );
    }
  }
  return optional('DB_PATH', DEFAULT_DB_PATH);
}

// Strict integer from env. Rejects '', 'abc', '30abc', '1.5' and out-of-range
// values, all of which parseInt() would happily turn into NaN or a silent 0.
function intFromEnv(name, fallback, bounds = {}) {
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = bounds;
  if (isBlank(name)) return fallback;
  const raw = String(process.env[name]).trim();
  if (!INTEGER_RE.test(raw)) {
    throw new Error(`[config] ${name} must be a whole number, got "${raw}"`);
  }
  const n = Number(raw);
  if (n < min || n > max) {
    throw new Error(`[config] ${name} must be between ${min} and ${max}, got "${raw}"`);
  }
  return n;
}

// Boolean from env ('true'/'1'/'yes'/'on' and their negatives).
function boolFromEnv(name, fallback) {
  if (isBlank(name)) return fallback;
  const raw = String(process.env[name]).trim();
  const value = raw.toLowerCase();
  if (TRUTHY.indexOf(value) !== -1) return true;
  if (FALSY.indexOf(value) !== -1) return false;
  throw new Error(`[config] ${name} must be true/false (or 1/0, yes/no, on/off), got "${raw}"`);
}

// --- clinic-hours value parsing ---------------------------------------------
// Every parser below throws a plain Error whose message is a short "why"; the
// caller wraps it with the offending raw CLINIC_HOURS_JSON value + an example.

// JSON.parse that reports failure instead of throwing.
function tryParseJson(raw) {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

// Rewrite a bare `[1,2,3]` into `["1","2","3"]` so JSON.parse accepts it.
// Returns null when an element is neither an integer nor already quoted (e.g.
// `[1,2,notanumber]`) — the caller then rejects the value rather than guess.
function quoteBareArray(raw) {
  const text = String(raw).trim();
  if (text[0] !== '[' || text[text.length - 1] !== ']') return null;
  const inner = text.slice(1, -1).trim();
  if (inner === '') return null; // '[]' — already valid JSON, rejected by shape
  const out = [];
  const tokens = inner.split(',');
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i].trim();
    if (INTEGER_RE.test(token)) out.push(`"${token}"`);
    else if (/^"[^"]*"$/.test(token)) out.push(token);
    else return null;
  }
  return `[${out.join(',')}]`;
}

// CLINIC_HOURS_JSON accepts two shapes:
//   1. a JSON object  {"days":[1,2],"open":"08:00","close":"13:00","slotMinutes":45}
//   2. a bare day list  [1,2,3,4,5,6]  <-- the form shipped in .env.example/.env
// Shape 2 is valid JSON, so it used to be spread over the defaults as if it
// were an object: the hours object gained index keys ("0".."5") and `days` kept
// its default, i.e. the operator's working days were silently ignored. Both
// shapes are now read deliberately.
function readClinicHoursJson(raw) {
  const direct = tryParseJson(raw);
  if (direct.ok) return direct.value;
  const quoted = quoteBareArray(raw);
  if (quoted === null) {
    throw new Error(`not JSON, and not a bare [1,2,…] day list (${direct.why})`);
  }
  const retried = tryParseJson(quoted);
  if (!retried.ok) throw new Error(retried.why);
  return retried.value;
}

// days: weekday integers 0=Sun..6=Sat. buildSlots() asks days.includes(getDay())
// to decide whether the clinic is open, so a bad list means closed (or always
// open) days with no explanation anywhere in the UI.
function normalizeDays(value) {
  const list = Array.isArray(value) ? value : [value];
  const days = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (item === null || item === undefined || typeof item === 'boolean' || Array.isArray(item)) {
      throw new Error(`days must hold weekday numbers 0-6, found ${JSON.stringify(item)}`);
    }
    const text = String(item).trim();
    if (!INTEGER_RE.test(text)) {
      throw new Error(`days must hold weekday numbers 0-6, found "${item}"`);
    }
    const n = Number(text);
    if (n < 0 || n > 6) {
      throw new Error(`days must be weekdays 0-6 (0=Sunday, 6=Saturday), found ${n}`);
    }
    if (days.indexOf(n) === -1) days.push(n);
  }
  if (days.length === 0) throw new Error('days is empty — the clinic would never be open');
  return days;
}

// open/close: "HH:MM", normalised to zero-padded 24h.
function normalizeTime(field, value) {
  const text = String(value).trim();
  const m = TIME_RE.exec(text);
  if (!m) throw new Error(`${field} must look like "HH:MM", found "${value}"`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`${field} is not a real time, found "${value}"`);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// slotMinutes / maxAdvanceDays: >= 1. Zero would make the buildSlots() loop spin
// forever (the cursor never advances); NaN would silently produce zero slots.
function normalizePositiveInt(field, value) {
  const text = String(value).trim();
  if (!INTEGER_RE.test(text)) {
    throw new Error(`${field} must be a positive whole number, found "${value}"`);
  }
  const n = Number(text);
  if (n < 1) throw new Error(`${field} must be 1 or more, found ${n}`);
  return n;
}

// Assemble the canonical hours object from the defaults plus a parsed
// CLINIC_HOURS_JSON value. Only the five documented keys are ever present, so a
// stray key can no longer leak into every response that echoes clinicHours.
function buildClinicHours(parsed) {
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`expected an object or a [1,2,…] day list, found ${JSON.stringify(parsed)}`);
  }
  if (Array.isArray(parsed)) parsed = { days: parsed };

  const known = Object.keys(parsed);
  const unknown = known.filter((k) => CLINIC_HOURS_KEYS.indexOf(k) === -1);
  if (unknown.length > 0) {
    throw new Error(`unknown key(s) ${unknown.map((k) => `"${k}"`).join(', ')} — expected ${CLINIC_HOURS_KEYS.join(', ')}`);
  }

  return {
    days: normalizeDays(parsed.days !== undefined ? parsed.days : DEFAULT_CLINIC_HOURS.days),
    open: normalizeTime('open', parsed.open !== undefined ? parsed.open : DEFAULT_CLINIC_HOURS.open),
    close: normalizeTime('close', parsed.close !== undefined ? parsed.close : DEFAULT_CLINIC_HOURS.close),
    slotMinutes: normalizePositiveInt('slotMinutes', parsed.slotMinutes !== undefined ? parsed.slotMinutes : DEFAULT_CLINIC_HOURS.slotMinutes),
    maxAdvanceDays: normalizePositiveInt('maxAdvanceDays', parsed.maxAdvanceDays !== undefined ? parsed.maxAdvanceDays : DEFAULT_CLINIC_HOURS.maxAdvanceDays),
  };
}

// 'HH:MM' -> minutes since midnight, for the derived open<close / window checks.
function timeToMinutes(hhmm) {
  const parts = hhmm.split(':').map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0);
}

// Final gate on the ASSEMBLED hours (defaults + JSON + SLOT_* aliases). These
// two mistakes produce a perfectly well-formed object that yields an empty slot
// grid, so no per-key check above can catch them.
function assertUsableGrid(hours) {
  const open = timeToMinutes(hours.open);
  const close = timeToMinutes(hours.close);
  if (close <= open) {
    throw new Error(`[config] clinic hours close (${hours.close}) must be after open (${hours.open})`);
  }
  if (hours.slotMinutes > close - open) {
    throw new Error(`[config] clinic hours slotMinutes (${hours.slotMinutes}) is longer than the open window ${hours.open}-${hours.close} (${close - open} min) — no bookable slots`);
  }
  return hours;
}

// SLOT_OPEN / SLOT_CLOSE reuse the JSON shape check but report under their own
// env-key name, so every config error keeps the "[config] <ENV_KEY> …" prefix.
function timeFromEnv(name) {
  try {
    return normalizeTime(name, process.env[name]);
  } catch (e) {
    throw new Error(`[config] ${e.message}`);
  }
}

// SLOT_START_HOUR / SLOT_END_HOUR are the .env.example alias pair (9 -> '09:00').
// 24 is accepted on the closing hour so a 09:00-24:00 window still works.
function hourToTime(name, allow24) {
  const raw = String(process.env[name]).trim();
  if (!INTEGER_RE.test(raw)) {
    throw new Error(`[config] ${name} must be a whole number, got "${raw}"`);
  }
  const n = Number(raw);
  if (n < 0 || n > (allow24 ? 24 : 23)) {
    throw new Error(`[config] ${name} must be between 0 and ${allow24 ? 24 : 23}, got "${raw}"`);
  }
  return `${String(n).padStart(2, '0')}:00`;
}

// Clinic hours JSON: {"days":[1..6],"open":"09:00","close":"19:00","slotMinutes":30,"maxAdvanceDays":30}
// or a bare working-day list: [1,2,3,4,5,6]. SLOT_* aliases override the JSON.
function parseClinicHours() {
  const raw = optional('CLINIC_HOURS_JSON', '');
  let hours;
  if (raw.trim() === '') {
    hours = buildClinicHours({});
  } else {
    try {
      hours = buildClinicHours(readClinicHoursJson(raw));
    } catch (e) {
      // Name the exact offending value and show a copy-pasteable example.
      throw new Error(`[config] CLINIC_HOURS_JSON is invalid: ${raw} — ${e.message} (${CLINIC_HOURS_HINT})`);
    }
  }

  // SLOT_* aliases: each is validated under its own env-key name. Order is the
  // historical one — SLOT_DURATION_MIN beats SLOT_MINUTES, and the *_HOUR pair
  // beats SLOT_OPEN/SLOT_CLOSE.
  if (!isBlank('SLOT_MINUTES')) hours.slotMinutes = intFromEnv('SLOT_MINUTES', hours.slotMinutes, { min: 1, max: 1440 });
  if (!isBlank('SLOT_OPEN')) hours.open = timeFromEnv('SLOT_OPEN');
  if (!isBlank('SLOT_CLOSE')) hours.close = timeFromEnv('SLOT_CLOSE');
  if (!isBlank('SLOT_DURATION_MIN')) hours.slotMinutes = intFromEnv('SLOT_DURATION_MIN', hours.slotMinutes, { min: 1, max: 1440 });
  if (!isBlank('SLOT_START_HOUR')) hours.open = hourToTime('SLOT_START_HOUR', false);
  if (!isBlank('SLOT_END_HOUR')) hours.close = hourToTime('SLOT_END_HOUR', true);

  return assertUsableGrid(hours);
}

let cached = null;

function getConfig() {
  if (cached) return cached;
  const isTest = process.env.NODE_ENV === 'test';
  // In test/smoke mode allow redacted defaults so `npm test` sanity passes
  // without a real .env on disk. Production still fails fast (see below).
  const sessionSecret = process.env.SESSION_SECRET || (isTest ? 'test-session-secret-min-32-chars-xxxx' : required('SESSION_SECRET'));
  if (sessionSecret.length < 32 && !isTest) {
    throw new Error('[config] SESSION_SECRET must be at least 32 characters');
  }
  const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH || (isTest ? 'test-hash' : required('ADMIN_PASSWORD_HASH'));
  const rateLimit = {};
  for (const profile of Object.keys(RATE_PROFILES)) {
    const spec = RATE_PROFILES[profile];
    rateLimit[profile] = { windowMs: spec.windowMs, max: intFromEnv(spec.env, spec.max, { min: 1 }) };
  }
  cached = {
    port: intFromEnv('PORT', 3000, { min: 1, max: 65535 }),
    dbPath: dbPathFrom(isTest),
    clinicName: optional('CLINIC_NAME', 'Your Clinic Name'),
    clinicHours: parseClinicHours(),
    sessionSecret,
    adminUsername: optional('ADMIN_USERNAME', 'admin'),
    adminPasswordHash,
    whatsapp: {
      mockMode: optional('WHATSAPP_MOCK_MODE', 'true') === 'true',
      token: optional('WHATSAPP_TOKEN', ''),
      phoneNumberId: optional('WHATSAPP_PHONE_NUMBER_ID', ''),
      apiVersion: optional('WHATSAPP_API_VERSION', 'v21.0'),
      verifyToken: optional('WHATSAPP_VERIFY_TOKEN', ''),
    },
    ownerPhone: optional('OWNER_PHONE', ''),
    isProd: process.env.NODE_ENV === 'production',
    // --- knobs read by the middleware layer (all optional, safe defaults) ---
    trustProxy: boolFromEnv('TRUST_PROXY', false),
    sessionTtlHours: intFromEnv('SESSION_TTL_HOURS', 12, { min: 1, max: 8760 }),
    rateLimit,
    rootDir: path.join(__dirname, '..'),
  };
  return cached;
}

module.exports = { getConfig };
