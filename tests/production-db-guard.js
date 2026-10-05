// ============================================================================
// clinic-automation - production-database guard (tests/production-db-guard.js)
// NOT a *.test.js file on purpose: this is a reusable helper, and the suite that
// enforces the invariant is tests/production-db-hermetic.test.js.
//
// WHY THIS EXISTS
//   data/clinic.db is the OPERATOR'S real database - real clients, real
//   appointments, real intake answers. Every test must run against a throwaway
//   file under %TMP%\opencode. That is easy in-process (helpers.freshDb() injects
//   DB_PATH) and easy to forget in a CHILD process: a child with no DB_PATH of
//   its own falls back to the production default and runs the entire migration
//   chain against it. The result is unreviewed, unrepeatable, and it destroys the
//   operator's data.
//
//   This has already happened once in this project: data/clinic.db was found at
//   `schema v3/3` - i.e. a test had migrated the production file - and the only
//   evidence of it was a backup taken during an ad-hoc repair.
//
//   So the invariant is ASSERTED rather than assumed. Take a fingerprint, compare
//   it, and fail loudly with an actionable message.
// Deps: node core only (node:fs, node:path, node:crypto).
// ============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const PROD_DB = path.join(ROOT, 'data', 'clinic.db');

/**
 * Identity of the production database, or null when it does not exist.
 *
 * Compares mtime AND size AND a content hash. A migration that rewrites pages in
 * place can land on the same byte length, so mtime alone is not a sufficient
 * witness - and mtime alone is also what makes this cheap enough to call often.
 */
function productionDbFingerprint() {
  let st;
  try {
    st = fs.statSync(PROD_DB);
  } catch (_) {
    return null; // no production database yet, so there is nothing to protect
  }
  return {
    path: PROD_DB,
    mtimeMs: st.mtimeMs,
    size: st.size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(PROD_DB)).digest('hex'),
  };
}

/** Human-readable one-liner, used in assertion messages. */
function describeFingerprint(fp) {
  if (fp === null) return 'data/clinic.db (absent)';
  return `data/clinic.db size=${fp.size} mtimeMs=${fp.mtimeMs} sha256=${fp.sha256.slice(0, 16)}`;
}

/**
 * Throw unless the production database is byte-identical to `before`.
 *
 * Call this at the END of a test or a test.after hook so a regression fails loudly
 * and names the culprit, instead of quietly migrating real data and reporting
 * success. `label` should identify which test/phase ran, so the message points at
 * the culprit rather than at the suite as a whole.
 */
function assertProductionDbUntouched(before, label) {
  const now = productionDbFingerprint();
  const where = label ? ` (during: ${label})` : '';
  if (before === null && now === null) return;
  if (before === null || now === null) {
    throw new Error(
      `[production-db-guard] the production database appeared or disappeared${where}: ` +
      `before=${before === null ? 'absent' : 'present'} after=${now === null ? 'absent' : 'present'}. ` +
      'A test must never create or delete data/clinic.db.'
    );
  }
  const diff = [];
  if (before.mtimeMs !== now.mtimeMs) diff.push(`mtimeMs ${before.mtimeMs} -> ${now.mtimeMs}`);
  if (before.size !== now.size) diff.push(`size ${before.size} -> ${now.size}`);
  if (before.sha256 !== now.sha256) diff.push(`sha256 ${before.sha256.slice(0, 12)} -> ${now.sha256.slice(0, 12)}`);
  if (diff.length) {
    throw new Error(
      `[production-db-guard] A TEST MUTATED THE PRODUCTION DATABASE${where}: ${diff.join('; ')}\n` +
      `  before: ${describeFingerprint(before)}\n` +
      `  after : ${describeFingerprint(now)}\n` +
      '  Every test must inject a temp DB_PATH (see tests/helpers.js freshDb()/testEnv()). ' +
      'Any CHILD process must get its own `env: { ...process.env, DB_PATH: <temp path> }` - ' +
      'a child that merely inherits an unset DB_PATH opens - and migrates - the real database.'
    );
  }
}

/** Every *.test.js under tests/, excluding this helper and the enforcing suite. */
function listSuiteFiles(dir) {
  const base = dir || path.join(ROOT, 'tests');
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(base, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSuiteFiles(full));
    } else if (entry.name.endsWith('.test.js') && entry.name !== 'production-db-hermetic.test.js') {
      out.push(full);
    }
  }
  return out;
}

/**
 * Find every child-process spawn in the suite and decide whether that child is
 * guaranteed NOT to open the production database.
 *
 * Two shapes are acceptable, and only two:
 *   (a) the call passes its own `env` that sets DB_PATH to a throwaway path, or
 *   (b) the file assigns a throwaway path to process.env.DB_PATH at module scope,
 *       which the child then inherits.
 *
 * Anything else is a latent production-database migration: if DB_PATH is unset
 * (or points at the default) when the child boots src/db/db.js, getDb() runs the
 * whole migration chain against data/clinic.db.
 *
 * Returns [{ file, line, snippet, safe, why }] - deliberately a plain array so a
 * caller can assert on it, print it, or hand it to a Reviewer.
 */
function auditChildProcessDbPaths(dir) {
  const findings = [];
  const SPAWN = /(?:\bspawnSync|\bexecFileSync|\bexecSync|\bspawn|\bfork)\s*\(/;

  for (const file of listSuiteFiles(dir)) {
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split(/\r?\n/);
    const rel = path.relative(ROOT, file);

    // (b) does this file put a throwaway DB_PATH into process.env at all?
    let setsTempDbPath = false;
    for (const line of lines) {
      const m = line.match(/process\.env\.DB_PATH\s*=\s*(.+)$/);
      if (!m) continue;
      const rhs = m[1];
      // A literal path under the OS temp dir, or a call that returns one.
      if (/nextDbPath|dbPath|tmpdir|TMP_ROOT|os\.tmpdir/i.test(rhs) && !/['"]data['"]\s*(\+\s*['"]\/clinic\.db)?['"]\s*$/.test(rhs)) {
        setsTempDbPath = true;
        break;
      }
    }

    lines.forEach((line, i) => {
      if (!SPAWN.test(line)) return;
      // Look at the call plus the options object that follows it.
      const window = lines.slice(i, Math.min(lines.length, i + 16)).join('\n');
      const callEnd = window.indexOf('});');
      const opts = callEnd === -1 ? window : window.slice(0, callEnd + 3);

      const passesOwnEnv = /\benv\s*:/.test(opts);
      const envSetsTempDbPath = passesOwnEnv && /\bDB_PATH\s*:/.test(opts) && !/DB_PATH\s*:\s*(?:db\.join\([^)]*data|.*['"]data[\\/]clinic\.db)/.test(opts);

      let safe = true;
      let why;
      if (envSetsTempDbPath) {
        why = '(a) the call passes its own env with an explicit DB_PATH';
      } else if (passesOwnEnv) {
        safe = false;
        why = '(env given, but it does not set DB_PATH to a throwaway path)';
      } else if (setsTempDbPath) {
        why = '(b) the file sets a throwaway process.env.DB_PATH at module scope, which the child inherits';
      } else {
        safe = false;
        why = 'NO hermetic DB_PATH: the child inherits whatever DB_PATH is set, and defaults to data/clinic.db';
      }

      findings.push({
        file: rel,
        line: i + 1,
        snippet: line.trim(),
        safe,
        why,
      });
    });
  }
  return findings;
}

module.exports = {
  ROOT,
  PROD_DB,
  productionDbFingerprint,
  describeFingerprint,
  assertProductionDbUntouched,
  listSuiteFiles,
  auditChildProcessDbPaths,
};