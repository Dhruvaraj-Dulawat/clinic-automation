// ============================================================================
// clinic-automation — shared test helpers (tests/helpers.js)
// Zero dependencies: node core only (node:test / node:assert/strict /
// node:http / node:fs). No supertest, no test framework.
//
// Guarantees provided to every test:
//   1. ISOLATION — each freshDb() opens its OWN SQLite file under
//      %LOCALAPPDATA%\Temp\opencode\clinic-automation-tests. data/clinic.db
//      (the operator's real DB) is never opened. Files are deleted by
//      cleanupTemp().
//   2. require-cache reset — src/db/db.js caches its better-sqlite3 handle and
//      src/config.js caches the resolved env, so purgeSrc() drops every module
//      under src/ before each boot. freshDb() must therefore be called BEFORE
//      requiring any db-coupled module (repository.js, routes, csvImport.js);
//      pure modules (scheduling/intake/templates) may be required freely.
//   3. DETERMINISM — NODE_ENV=test, fixed clinic hours, an admin bcrypt hash we
//      control, WHATSAPP_MOCK_MODE=true (no network) and a known webhook verify
//      token. Blank SLOT_* keys so the project .env cannot leak in (dotenv never
//      overrides keys that already exist in process.env).
//   4. HTTP — startServer() boots createApp() in-process on an ephemeral port
//      and drives it with fetch + a cookie jar; close() is instant because each
//      request sends `Connection: close`.
//
// Deps: node core + bcryptjs (already a production dependency, via
// createRequire so helpers.js resolves from the project, not from tests/).
// ============================================================================
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
// NOTE: os.tmpdir() on this host is C:\Users\dhruv\AppData\Local\Temp, so temp
// DBs land inside the pre-approved ...\Temp\opencode subtree.
const TMP_ROOT = path.join(os.tmpdir(), 'opencode', 'clinic-automation-tests');

const projectRequire = createRequire(path.join(ROOT, 'package.json'));
const bcrypt = projectRequire('bcryptjs');

// --- Fixtures / constants ---------------------------------------------------

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'TestPassw0rd!';
// Cost 4 keeps every login assertion fast; format is what auth.js checks.
const ADMIN_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 4);

const VERIFY_TOKEN = 'test-verify-token-abc123';

// Clinic hours under test — mirrored into CLINIC_HOURS_JSON by freshDb().
const CLINIC_HOURS = Object.freeze({
  days: [1, 2, 3, 4, 5, 6], // Mon–Sat (0 = Sunday)
  open: '09:00',
  close: '19:00',
  slotMinutes: 30,
  maxAdvanceDays: 30,
});

// Fixed calendar anchors so date math never depends on "today".
const MONDAY = '2026-10-05'; // getDay() === 1 (clinic open)
const TUESDAY = '2026-10-06'; // getDay() === 2 (clinic open)
const SUNDAY = '2026-10-04'; // getDay() === 0 (clinic CLOSED)
const NEXT_MONDAY = '2026-10-12'; // MONDAY + 7

// Snapshot of the real environment so cleanupTemp() can put it back.
const ENV_SNAPSHOT = Object.assign({}, process.env);

let activeDb = null;
let dbCounter = 0;
const createdFiles = new Set();

// --- Date helpers -----------------------------------------------------------

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Local "YYYY-MM-DD" for a Date (matches src/services/reports.js fmt()). */
function dateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local "YYYY-MM-DD HH:mm" — the format appointments.slot_start is stored in. */
function localStamp(d) {
  return `${dateStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local "YYYY-MM-DD HH:mm:ss" — the format SQLite datetime('now') returns. */
function sqlStamp(d) {
  return `${dateStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** "YYYY-MM-DD HH:mm" for `ms` milliseconds from now (for reports fixtures). */
function stampFromNow(ms) {
  return localStamp(new Date(Date.now() + ms));
}

/** sqlStamp for `ms` milliseconds from now. */
function sqlStampFromNow(ms) {
  return sqlStamp(new Date(Date.now() + ms));
}

/** First clinic-open date at least `daysAhead` days from today. */
function nextOpenDate(daysAhead = 3, cfg = CLINIC_HOURS) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  for (let i = 0; i < 14; i++) {
    if (cfg.days.includes(d.getDay())) return dateStr(d);
    d.setDate(d.getDate() + 1);
  }
  throw new Error('[helpers] no open date found within 14 days');
}

// --- require-cache / env control --------------------------------------------

function purgeSrc() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC + path.sep)) delete require.cache[key];
  }
}

/**
 * Apply env vars for the duration of fn (sync or async), then restore exactly.
 * An undefined/null value DELETES the key instead of setting "".
 */
function withEnv(env, fn) {
  const saved = new Map();
  for (const key of Object.keys(env)) {
    saved.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (env[key] === undefined || env[key] === null) delete process.env[key];
    else process.env[key] = String(env[key]);
  }
  const restore = () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  let out;
  try {
    out = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (out && typeof out.then === 'function') return out.then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
  restore();
  return out;
}

/** The hermetic environment every test boots with (DB_PATH injected). */
function testEnv(dbPath) {
  return {
    NODE_ENV: 'test',
    DB_PATH: dbPath,
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    ADMIN_USERNAME,
    ADMIN_PASSWORD_HASH: ADMIN_HASH,
    CLINIC_NAME: 'Test Clinic',
    CLINIC_HOURS_JSON: JSON.stringify(CLINIC_HOURS),
    // Blank the .env aliases so the project .env cannot change clinic hours.
    SLOT_DURATION_MIN: '',
    SLOT_OPEN: '',
    SLOT_CLOSE: '',
    SLOT_START_HOUR: '',
    SLOT_END_HOUR: '',
    WHATSAPP_MOCK_MODE: 'true',
    WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
    WHATSAPP_TOKEN: '',
    WHATSAPP_PHONE_NUMBER_ID: '',
// Raise the public rate limits: the suite books many appointments from
      // 127.0.0.1 and would otherwise throttle itself. The limiter itself is
      // covered by its own dedicated test (which drives the limiter directly,
      // so these env budgets do not weaken it). Key names come from
      // src/config.js presets: strict / standard / relaxed.
      RATE_LIMIT_STRICT_MAX: '100000',
      RATE_LIMIT_STANDARD_MAX: '100000',
      RATE_LIMIT_RELAXED_MAX: '100000',
    // No owner phone => staffNotify is a no-op (keeps message-log assertions
    // about client sends only, and avoids escalation noise).
    OWNER_PHONE: '',
  };
}

// --- DB lifecycle -----------------------------------------------------------

function closeActiveDb() {
  if (!activeDb) return;
  try {
    if (activeDb.open) activeDb.close();
  } catch (_) {
    /* already closed */
  }
  activeDb = null;
}

/**
 * Boot an isolated, migrated SQLite database and return the live repository.
 * MUST be called before requiring any db-coupled module.
 */
function freshDb(options = {}) {
  closeActiveDb();
  purgeSrc();
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  dbCounter += 1;
  const dbPath = path.join(TMP_ROOT, `test-${process.pid}-${dbCounter}.db`);
  createdFiles.add(dbPath);
  // A process pid is REUSED by the OS. If an earlier run with this same pid died
  // before cleanupTemp() (a killed run, a --test timeout, a crashed file), its
  // DB is still sitting on disk under this exact name. Opening it would inherit
  // that run's rows, which surfaced as a baffling
  // `SQLITE_CONSTRAINT_UNIQUE: clients.phone` in tests that insert fixed fixture
  // phones -- and as pass/fail that FLIPPED between identical runs.
  // schema.sql is idempotent so it would happily reuse the stale file.
  // Guarantee a clean slate: remove the file and its WAL sidecars first.
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { fs.unlinkSync(dbPath + suffix); } catch (_) { /* absent is the normal case */ }
  }
  withEnv(Object.assign(testEnv(dbPath), options.env || {}), () => {});
  // CRITICAL: the env above must STAY applied while db.js/config.js are first
  // required, because config.js captures the environment at require-time and
  // dotenv would otherwise fill in the operator's real .env (DB_PATH +
  // clinic hours). withEnv() rolls its changes back when it returns, so
  // re-apply the same values persistently for the life of this test process.
  const persistent = Object.assign(testEnv(dbPath), options.env || {});
  for (const key of Object.keys(persistent)) {
    if (persistent[key] === undefined || persistent[key] === null) delete process.env[key];
    else process.env[key] = String(persistent[key]);
  }
  const { getDb } = require(path.join(SRC, 'db', 'db.js'));
  activeDb = getDb(); // runs schema.sql + seeds the admin user
  const repo = require(path.join(SRC, 'db', 'repository.js'));
  const config = require(path.join(SRC, 'config.js'));
  return {
    db: activeDb,
    dbPath,
    repo,
    clients: repo.clients,
    appointments: repo.appointments,
    cfg: config.getConfig(),
  };
}

/** Restore the process env + drop every temp DB this process created. */
function cleanupTemp() {
  closeActiveDb();
  purgeSrc();
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(ENV_SNAPSHOT, key)) delete process.env[key];
  }
  Object.assign(process.env, ENV_SNAPSHOT);
  for (const file of createdFiles) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try {
        fs.rmSync(file + suffix, { force: true });
      } catch (_) {
        /* best effort */
      }
    }
  }
  createdFiles.clear();
  try {
    if (fs.readdirSync(TMP_ROOT).length === 0) fs.rmdirSync(TMP_ROOT);
  } catch (_) {
    /* other test processes still using it — leave it alone */
  }
}

// --- HTTP client ------------------------------------------------------------

/**
 * Cookie-jar HTTP client over fetch. `Connection: close` on every request keeps
 * server.close() instant (no lingering keep-alive sockets).
 */
function createHttpClient(baseUrl) {
  const jar = new Map();
  // Unsafe methods must echo the CSRF token back, exactly as browser JS does.
  // The mirror cookie lands in the jar from GET /csrf, so reading it here
  // exercises the real double-submit path instead of special-casing the guard.
  const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  async function send(method, urlPath, opts = {}) {
    const headers = Object.assign({}, opts.headers);
    headers.Connection = 'close';
    if (opts.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (jar.size) headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    // Unsafe methods echo the CSRF token back, exactly as browser JS does: the
    // mirror cookie lands in the jar from GET /csrf, so this exercises the real
    // double-submit path instead of special-casing the guard. Two escape
    // hatches, both needed by tests/csrf.test.js to PROVE the guard bites:
    //   opts.csrf === false      -> deliberately send no token
    //   an explicit x-csrf-token  -> send exactly that value (a forged one)
    if (UNSAFE.has(String(method).toUpperCase()) && opts.csrf !== false && headers['x-csrf-token'] === undefined && jar.has('csrf_token')) {
      headers['x-csrf-token'] = jar.get('csrf_token');
    }
    const res = await fetch(baseUrl + urlPath, {
      method,
      headers,
      body: opts.body === undefined ? undefined : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)),
    });
    const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const entry of setCookie) {
      const pair = entry.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '') jar.delete(name);
      else jar.set(name, value);
    }
    const text = await res.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch (_) {
      /* non-JSON response (e.g. the webhook challenge) — keep the raw text */
    }
    return { status: res.status, body, text, setCookie, headers: res.headers };
  }
  return {
    jar,
    send,
    /** Fetch a CSRF token + mirror cookie so mutations can be authorized. */
    async ensureCsrf() {
      if (jar.has('csrf_token')) return jar.get('csrf_token');
      const res = await send('GET', '/csrf');
      return res.body && res.body.csrfToken;
    },
    get: (p, o) => send('GET', p, o),
    post: (p, body, o) => send('POST', p, Object.assign({}, o, { body })),
    put: (p, body, o) => send('PUT', p, Object.assign({}, o, { body })),
    patch: (p, body, o) => send('PATCH', p, Object.assign({}, o, { body })),
    del: (p, o) => send('DELETE', p, o),
    /** POST /api/admin/login with the canonical test credentials. */
    async login(username = ADMIN_USERNAME, password = ADMIN_PASSWORD) {
      // The login POST is CSRF-guarded, so obtain a token first. The server
      // rotates it on successful login and returns the new one.
      await this.ensureCsrf();
      const res = await send('POST', '/api/admin/login', { body: { username, password } });
      return res;
    },
    cookieHeader: () => (jar.size ? [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') : ''),
  };
}

/** Boot createApp() in-process on an ephemeral 127.0.0.1 port. */
async function startServer() {
  const { createApp } = require(path.join(SRC, 'app.js'));
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    app,
    server,
    baseUrl,
    client: createHttpClient(baseUrl),
    async close() {
      if (!server.listening) return;
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = {
  ROOT,
  SRC,
  TMP_ROOT,
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  ADMIN_HASH,
  VERIFY_TOKEN,
  CLINIC_HOURS,
  MONDAY,
  TUESDAY,
  SUNDAY,
  NEXT_MONDAY,
  // lifecycle
  freshDb,
  cleanupTemp,
  withEnv,
  purgeSrc,
  closeActiveDb,
  // http
  startServer,
  createHttpClient,
  // dates
  dateStr,
  localStamp,
  sqlStamp,
  stampFromNow,
  sqlStampFromNow,
  nextOpenDate,
};