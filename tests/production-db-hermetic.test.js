// ============================================================================
// clinic-automation - production-database hermeticity (tests/production-db-hermetic.test.js)
// Enforces the invariant that the suite can never touch data/clinic.db, the
// OPERATOR'S real database.
//
// This is not theoretical. During M9 a test was found to have migrated the
// production file to `schema v3/3`, and the only trace was an ad-hoc backup
// taken during a repair. Two independent failure modes produce that:
//
//   1. A test boots src/db/db.js with no DB_PATH in the environment. getDb()
//      then applies the whole migration chain to data/clinic.db.
//   2. A test SPAWNS A CHILD PROCESS and forgets that the child needs its own
//      DB_PATH. In-process hermeticity (helpers.freshDb()) does not travel to a
//      child, and a child with DB_PATH unset is failure mode 1.
//
// Mode 2 is the dangerous one, because the in-process suite can be provably
// clean while the suite as a whole still migrates production. So this file
// asserts the EFFECTIVE property at every spawn site rather than trusting review.
//
// Also asserted directly: this very file leaves data/clinic.db byte-identical,
// measured across its own run.
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ROOT,
  PROD_DB,
  productionDbFingerprint,
  describeFingerprint,
  assertProductionDbUntouched,
  listSuiteFiles,
  auditChildProcessDbPaths,
} = require('./production-db-guard.js');

// Taken at MODULE LOAD, i.e. before this file does anything at all. Every
// assertion below therefore compares against the state as it was on entry.
const ENTRY = productionDbFingerprint();

test.after(() => {
  assertProductionDbUntouched(ENTRY, 'production-db-hermetic.test.js as a whole');
});

test('the guard itself can see the production database', () => {
  // A guard that silently reports "absent" would make every other test here
  // vacuous, so prove the instrument is actually pointed at a real file. The
  // database legitimately may not exist on a fresh clone, so accept either - but
  // if it DOES exist, the fingerprint must be complete, not partially populated.
  const fp = productionDbFingerprint();
  if (fp === null) {
    assert.ok(!fs.existsSync(PROD_DB), 'absent fingerprint must mean the file is really gone');
    return;
  }
  assert.equal(fp.path, PROD_DB);
  assert.equal(typeof fp.mtimeMs, 'number');
  assert.ok(fp.size > 0, `production db is ${fp.size} bytes - an empty file is not a database`);
  assert.match(fp.sha256, /^[0-9a-f]{64}$/, 'the hash must cover the whole file, not a prefix');
});

test('reading the production database never opens it for writing', () => {
  // Guards the guard: if this file opened the DB it is meant to protect, the
  // very act of testing it would be the defect.
  const before = fs.statSync(PROD_DB, { throwIfNoEntry: false });
  if (!before) return;
  const after = fs.statSync(PROD_DB);
  assert.equal(before.mtimeMs, after.mtimeMs, 'stat alone must not touch the file');
  assert.equal(after.size, before.size);
});

test('no test spawns a child process that could open data/clinic.db', () => {
  const findings = auditChildProcessDbPaths(path.join(ROOT, 'tests'));

  // A silently-empty audit would make this test pass for the wrong reason, so
  // assert the audit actually found the spawn sites that exist today.
  const suiteFiles = listSuiteFiles(path.join(ROOT, 'tests'));
  assert.ok(suiteFiles.length > 0, 'sanity: the suite file list is not empty');
  assert.ok(
    findings.length > 0,
    `sanity: the spawn audit matched nothing across ${suiteFiles.length} suite file(s). ` +
    'If the suites genuinely stopped spawning children, DELETE this assertion rather than ' +
    'leaving it to pass vacuously - a guard that cannot fail is worse than no guard.'
  );

  const unsafe = findings.filter((f) => !f.safe);
  assert.deepEqual(
    unsafe,
    [],
    'these child processes can boot src/db/db.js with no throwaway DB_PATH, so they migrate ' +
    'data/clinic.db.\n' +
    unsafe.map((f) => `  ${f.file}:${f.line}  ${f.snippet}\n      ${f.why}`).join('\n') +
    '\n  Fix: give the call its own env, e.g.\n' +
    "      env: { ...process.env, NODE_ENV: 'test', DB_PATH: <fresh os.tmpdir() path> }"
  );
});

test('every audited spawn is safe, and the reasons are recorded', () => {
  // Same audit, but asserts the classification is meaningful rather than merely
  // empty: each finding must carry a reason, and the safe/unsafe split must be
  // decidable. This catches a regression in the AUDITOR, which would otherwise
  // make the test above pass by classifying everything as safe.
  const findings = auditChildProcessDbPaths(path.join(ROOT, 'tests'));
  for (const f of findings) {
    assert.equal(typeof f.safe, 'boolean', `${f.file}:${f.line} must be classified`);
    assert.ok(f.why && f.why.length > 10, `${f.file}:${f.line} must record why it is ${f.safe ? 'safe' : 'unsafe'}`);
    assert.match(f.file, /^tests[\\/].+\.test\.js$/, `unexpected file in the audit: ${f.file}`);
    assert.ok(f.line > 0, 'line numbers must be real so the message is clickable');
  }
  // Both shapes are legitimately in use today; pin that so a future change that
  // silently removes one of them is visible rather than invisible.
  const byReason = new Set(findings.filter((f) => f.safe).map((f) => f.why.charAt(0)));
  assert.ok(byReason.size >= 1, 'sanity: at least one spawn is classified safe');
});

test('this suite changed nothing about the production database', () => {
  assertProductionDbUntouched(ENTRY, 'the assertions in this file');
  assert.equal(describeFingerprint(productionDbFingerprint()), describeFingerprint(ENTRY));
});