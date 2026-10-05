// ============================================================================
// clinic-automation - cron wiring (tests/jobs.test.js)
// Durable, COMMITTED coverage for src/jobs/index.js.
//
// WHY THIS FILE EXISTS: these assertions used to live only in
// src/jobs/__tests__/index.isolated.test.js, which sat OUTSIDE the `npm test`
// glob (tests/**/*.test.js) and was banner-marked "will be deleted after the
// test passes". `npm run check` and `npm run sanity` only run `node --check`,
// which proves the file PARSES - not that digest is registered or that the
// overlap guard works. Deleting that file therefore took digest registration,
// the overlap guard and the loud-drift paths to ZERO coverage. This file puts
// them in the suite that actually runs in CI, so they cannot silently rot.
//
// TARGET: src/jobs/index.js
//
// ISOLATION (and why the DB half of tests/helpers.js is deliberately unused):
//   * index.js is PURE. Its own deps are fs, path and node-cron; it reaches the
//     database only by lazy-requiring a job module INSIDE a tick callback.
//   * Those four job modules are STUBBED into require.cache here, so a real
//     cron tick cannot open data/clinic.db or send a real WhatsApp message.
//     That is what makes it safe to run this file alongside the DB suites.
//   * fs.readFileSync is redirected ONLY for the src/config/schedule.json read,
//     so corrupt / missing / non-object config is simulated without writing to
//     disk. Restored in a finally on every single test.
//   * Every node-cron task is destroy()ed in its own finally, so the test
//     process always exits. Leaving one alive makes `node --test` hang.
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const cron = require('node-cron');

const ROOT = path.resolve(__dirname, '..');
const JOBS = path.join(ROOT, 'src', 'jobs');
const target = require(path.join(JOBS, 'index.js'));

const JOB_KEYS = ['reminders', 'followups', 'reengagement', 'digest'];
// node-cron v4 6-field syntax = every second. Used so a test can observe real
// tick boundaries in ~2s instead of waiting for wall-clock cron times.
const EVERY_SECOND = '* * * * * *';
const DEFAULT_CRONS = {
  reminders: '*/15 * * * *',
  followups: '0 10 * * *',
  reengagement: '0 11 * * MON',
  digest: '0 8 * * MON',
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Capture console for a SYNC fn. Returns { log, warn, error, result }. */
function capture(fn) {
  const out = { log: [], warn: [], error: [] };
  const real = { log: console.log, warn: console.warn, error: console.error };
  const cap = (kind) => (...args) => {
    out[kind].push(args.map((a) => (a && a.message ? a.message : String(a))).join(' '));
  };
  console.log = cap('log');
  console.warn = cap('warn');
  console.error = cap('error');
  try {
    out.result = fn();
  } finally {
    console.log = real.log;
    console.warn = real.warn;
    console.error = real.error;
  }
  return out;
}

/** Capture console across an ASYNC fn; restores only once the promise settles. */
async function captureAsync(fn) {
  const out = { log: [], warn: [], error: [] };
  const real = { log: console.log, warn: console.warn, error: console.error };
  const cap = (kind) => (...args) => {
    out[kind].push(args.map((a) => (a && a.message ? a.message : String(a))).join(' '));
  };
  console.log = cap('log');
  console.warn = cap('warn');
  console.error = cap('error');
  try {
    out.result = await fn();
  } finally {
    console.log = real.log;
    console.warn = real.warn;
    console.error = real.error;
  }
  return out;
}

/**
 * Serve a fake schedule.json for the duration of `fn`.
 * `contents` may be a string, or an Error to simulate an unreadable file.
 */
function withScheduleFile(contents, fn) {
  const fs = require('fs');
  const real = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) {
    if (typeof p === 'string' && p.replace(/\\/g, '/').endsWith('config/schedule.json')) {
      if (contents instanceof Error) throw contents;
      return contents;
    }
    return real.call(fs, p, ...rest);
  };
  try {
    return fn();
  } finally {
    fs.readFileSync = real;
  }
}

/** Stub a job module into require.cache so a real tick cannot reach the DB. */
function stubJobModule(relPath, exports) {
  const filename = require.resolve(path.join(ROOT, relPath));
  require.cache[filename] = {
    id: filename,
    filename,
    path: path.dirname(filename),
    loaded: true,
    exports,
  };
  return filename;
}

/** Remove every stub this file installed. */
function clearStubs(filenames) {
  for (const f of filenames) delete require.cache[f];
}

/**
 * Destroy node-cron tasks. This is what stops `node --test` hanging: an
 * undestroyed ScheduledTask keeps its timer, and the process never exits.
 */
function destroyAll(tasks) {
  for (const t of tasks || []) {
    try {
      t.destroy();
    } catch (_) {
      /* already destroyed */
    }
  }
}

/** resetForTests() in a finally, so one test can never poison the next. */
function reset(target) {
  target.resetForTests();
}

// ---------------------------------------------------------------------------
// 1. Export surface — every pre-existing export must survive
// ---------------------------------------------------------------------------

test('preserves every existing export and adds the guard helpers', () => {
  for (const name of ['startAll', 'start', 'startJobs', 'loadSchedule', 'resetForTests']) {
    assert.equal(typeof target[name], 'function', `missing export: ${name}`);
  }
  // src/server.js calls start()/startAll() and reads tasks.length.
  assert.equal(target.start, target.startAll, 'start must alias startAll');
  assert.equal(target.startJobs, target.startAll, 'startJobs must alias startAll');
  assert.equal(target.startAll.length, 0, 'startAll takes no arguments');
  assert.equal(target._isRunning.length, 1, '_isRunning(label)');
  assert.equal(target._markRunning.length, 1, '_markRunning(label)');
});

// ---------------------------------------------------------------------------
// 2. loadSchedule — the REAL file on disk (D14: digest must be present)
// ---------------------------------------------------------------------------

test('loadSchedule returns exactly the four jobs, including digest', () => {
  const s = target.loadSchedule();
  assert.deepEqual(Object.keys(s).sort(), JOB_KEYS.slice().sort());
  assert.ok(s.digest, 'D14: digest MUST be in the schedule or it never runs');
  assert.equal(s.digest.cron, '0 8 * * MON', 'digest cron comes from schedule.json');
});

test('loadSchedule leaks no _comment / private keys at the top level', () => {
  // src/config/schedule.json really does carry a top-level "_comment" and one
  // inside every job, so this asserts the merge really drops them at the top.
  const s = target.loadSchedule();
  for (const k of Object.keys(s)) {
    assert.ok(!k.startsWith('_'), `private key leaked into the schedule: ${k}`);
    assert.equal(typeof s[k].cron, 'string', `${k}.cron must be a string`);
  }
});

test('every returned cron expression is valid (node-cron agrees)', () => {
  const s = target.loadSchedule();
  for (const k of JOB_KEYS) {
    assert.ok(cron.validate(s[k].cron), `${k} cron is invalid: ${s[k].cron}`);
  }
});

test('loadSchedule preserves the sibling job options, not just cron', () => {
  const s = target.loadSchedule();
  assert.equal(s.reminders.hoursBefore, 24);
  assert.equal(s.reminders.lookAheadMinutes, 20);
  assert.equal(s.followups.daysAfter, 1);
  assert.deepEqual(s.reengagement.windowsDays, [30, 60, 90]);
});

test('valid per-job config is merged OVER the defaults, not wholesale replaced', () => {
  const { result } = capture(() =>
    withScheduleFile(JSON.stringify({ reminders: { cron: '0 9 * * *', hoursBefore: 48 } }),
      () => target.loadSchedule()));
  assert.equal(result.reminders.hoursBefore, 48, 'override applies');
  assert.equal(result.reminders.cron, '0 9 * * *', 'cron override applies');
  assert.equal(result.reminders.lookAheadMinutes, 20, 'sibling key survives the merge');
});

// ---------------------------------------------------------------------------
// 3. LOUD FAILURE — a broken schedule.json must never be silent
// ---------------------------------------------------------------------------

test('a corrupt schedule.json warns LOUDLY, naming the error and the crons in force', () => {
  const { warn, result } = capture(() =>
    withScheduleFile('{ this is not json', () => target.loadSchedule()));

  const blob = warn.join('\n');
  assert.ok(blob.length > 0, 'a parse failure must produce output');
  assert.match(blob, /schedule\.json/, 'the warning must name the config file');
  assert.match(blob, /JSON/i, 'the warning must name the parse failure');
  // The operator must be able to see WHEN patients will actually be messaged.
  assert.match(blob, /in force/i, 'the warning must announce which crons are live');
  for (const k of JOB_KEYS) {
    assert.ok(blob.includes(k), `the warning must list the ${k} schedule`);
    assert.ok(blob.includes(DEFAULT_CRONS[k]), `the warning must print the ${k} cron in force`);
  }
  // Still usable, never a crash.
  assert.deepEqual(Object.keys(result).sort(), JOB_KEYS.slice().sort());
  for (const k of JOB_KEYS) assert.ok(cron.validate(result[k].cron), `${k} must stay valid`);
});

test('an unreadable schedule.json (missing file) also warns loudly', () => {
  const enoent = new Error("ENOENT: no such file or directory, open 'schedule.json'");
  enoent.code = 'ENOENT';
  const { warn, result } = capture(() => withScheduleFile(enoent, () => target.loadSchedule()));
  const blob = warn.join('\n');
  assert.match(blob, /schedule\.json/);
  assert.match(blob, /ENOENT|no such file/, 'the underlying error must be surfaced');
  assert.match(blob, /0 8 \* \* MON/, 'the digest cron in force must be printed');
  assert.equal(result.digest.cron, '0 8 * * MON');
});

test('schedule.json that parses to a non-object warns loudly and falls back', () => {
  for (const bad of ['"hello"', 'null', '[1,2,3]', '42']) {
    const { warn, result } = capture(() => withScheduleFile(bad, () => target.loadSchedule()));
    assert.ok(warn.join('\n').length > 0, `no warning for non-object config: ${bad}`);
    assert.deepEqual(Object.keys(result).sort(), JOB_KEYS.slice().sort());
    for (const k of JOB_KEYS) {
      assert.ok(cron.validate(result[k].cron), `${k} must still have a valid cron`);
    }
  }
});

test('a job missing its cron warns PER-JOB without breaking the others', () => {
  const { warn, result } = capture(() =>
    withScheduleFile(JSON.stringify({
      reminders: { hoursBefore: 24 }, // cron accidentally deleted
      digest: { cron: '0 8 * * MON' },
    }), () => target.loadSchedule()));

  const blob = warn.join('\n');
  assert.match(blob, /reminders/, 'the offending job must be named');
  assert.ok(blob.includes('*/15 * * * *'), `the substituted cron must be shown; got:\n${blob}`);
  assert.match(blob, /followups/, 'each absent job is called out individually');
  // The healthy jobs are untouched and everything stays valid.
  assert.equal(result.reminders.cron, '*/15 * * * *');
  assert.equal(result.followups.cron, '0 10 * * *');
  assert.equal(result.reengagement.cron, '0 11 * * MON');
  assert.equal(result.digest.cron, '0 8 * * MON');
  for (const k of JOB_KEYS) assert.ok(cron.validate(result[k].cron));
});

test('a job that is not an object warns per-job and falls back', () => {
  const { warn, result } = capture(() =>
    withScheduleFile(JSON.stringify({ reengagement: '0 11 * * MON' }), () => target.loadSchedule()));
  assert.match(warn.join('\n'), /reengagement/);
  assert.equal(result.reengagement.cron, '0 11 * * MON');
});

test('a non-string or empty cron is rejected at load, never handed to node-cron', () => {
  for (const bad of [42, null, true, ['0', '8'], '', '   ']) {
    const { result } = capture(() =>
      withScheduleFile(JSON.stringify({ digest: { cron: bad } }), () => target.loadSchedule()));
    assert.equal(typeof result.digest.cron, 'string');
    assert.ok(result.digest.cron.trim().length > 0,
      `blank cron ${JSON.stringify(bad)} leaked through`);
  }
});

test('a job declared in schedule.json that nobody registers is called out', () => {
  // The exact failure mode that lost `digest`: declared but never wired.
  const { warn } = capture(() =>
    withScheduleFile(JSON.stringify({ newsletters: { cron: '0 7 * * *' } }),
      () => target.loadSchedule()));
  assert.match(warn.join('\n'), /newsletters/,
    'an orphaned schedule entry must be reported, not silently ignored');
});

// ---------------------------------------------------------------------------
// 4. OVERLAP GUARD — in-flight flag bookkeeping (instant, no waiting)
// ---------------------------------------------------------------------------

test('_isRunning flips false -> true -> false around _markRunning + reset', () => {
  target.resetForTests();
  assert.equal(target._isRunning('digest'), false, 'idle by default');
  target._markRunning('digest');
  assert.equal(target._isRunning('digest'), true, 'marked as in flight');
  target.resetForTests();
  assert.equal(target._isRunning('digest'), false, 'resetForTests clears the flags');
});

test('the in-flight flag is per job, not global', () => {
  target.resetForTests();
  target._markRunning('digest');
  assert.equal(target._isRunning('digest'), true);
  assert.equal(target._isRunning('reminders'), false, 'a busy digest must not block reminders');
  target.resetForTests();
});

test('_clearRunning frees one label and resetForTests frees every label', () => {
  target.resetForTests();
  target._markRunning('digest');
  target._markRunning('reminders');
  target._clearRunning('digest');
  assert.equal(target._isRunning('digest'), false, '_clearRunning released its label');
  assert.equal(target._isRunning('reminders'), true, 'and left the other alone');
  target.resetForTests();
  assert.equal(target._isRunning('reminders'), false, 'resetForTests clears the flags');
  for (const k of JOB_KEYS) {
    assert.equal(target._isRunning(k), false, `${k} flag survived resetForTests`);
  }
});

// ---------------------------------------------------------------------------
// 5. OVERLAP GUARD — END TO END through real node-cron ticks
// ---------------------------------------------------------------------------

test('a second cron tick while a job is still running is SKIPPED, not run concurrently', async () => {
  // reminders blocks forever; the other three return instantly. All four are
  // scheduled every SECOND so several ticks land inside the wait window.
  let remindersRuns = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const stubs = [
    stubJobModule('src/jobs/reminders.js', {
      runReminders: async () => {
        remindersRuns += 1;
        return gate;
      },
    }),
    stubJobModule('src/jobs/followups.js', { runFollowups: async () => ({ sent: 0 }) }),
    stubJobModule('src/jobs/reengagement.js', { runReengagement: async () => ({ sent: 0 }) }),
    stubJobModule('src/services/digest.js', { sendWeeklyDigest: async () => ({ sent: true }) }),
  ];
  const schedule = {};
  for (const k of JOB_KEYS) schedule[k] = { cron: EVERY_SECOND };

  let tasks = [];
  let ticks = 0;
  const ticker = cron.schedule(EVERY_SECOND, () => {
    ticks += 1;
  });
  try {
    const { warn, error } = await captureAsync(async () => {
      tasks = withScheduleFile(JSON.stringify(schedule), () => target.startAll());
      await new Promise((r) => setTimeout(r, 2800)); // >= 2 cron boundaries
    });

    assert.equal(tasks.length, 4, `all four jobs must register, got ${tasks.length}`);
    // Prove the window really contained >= 2 ticks, so a pass/fail here is
    // about the guard rather than about a slow machine.
    assert.ok(ticks >= 2, `the window must contain >= 2 real ticks, saw ${ticks}`);
    assert.equal(remindersRuns, 1,
      `the overlap guard failed: ${remindersRuns} concurrent reminders runs over ${ticks} ticks`);
    assert.match(warn.join('\n'), /reminders still running/i,
      'the skipped tick must be logged so the operator can see drops');
    assert.equal(error.join('\n'), '', 'a skipped tick is not an error');

    release();
    await gate;
    // Once the run finishes the next tick is allowed again.
    await new Promise((r) => setTimeout(r, 1600));
    assert.ok(remindersRuns >= 2,
      `after the guard released, ticks must run again (saw ${remindersRuns})`);
  } finally {
    destroyAll(tasks);
    ticker.destroy();
    release();
    clearStubs(stubs);
    reset(target);
  }
});

test('a job that throws SYNCHRONOUSLY is logged, does not crash, and releases the guard', async () => {
  let attempts = 0;
  const stubs = [
    // A missing/broken digest.js makes require('./...') throw synchronously.
    stubJobModule('src/services/digest.js', {
      sendWeeklyDigest: () => {
        attempts += 1;
        throw new Error('digest module is broken');
      },
    }),
    stubJobModule('src/jobs/reminders.js', { runReminders: async () => ({ sent: 0 }) }),
    stubJobModule('src/jobs/followups.js', { runFollowups: async () => ({ sent: 0 }) }),
    stubJobModule('src/jobs/reengagement.js', { runReengagement: async () => ({ sent: 0 }) }),
  ];
  const schedule = {};
  for (const k of JOB_KEYS) schedule[k] = { cron: EVERY_SECOND };

  let tasks = [];
  try {
    const { error } = await captureAsync(async () => {
      tasks = withScheduleFile(JSON.stringify(schedule), () => target.startAll());
      await new Promise((r) => setTimeout(r, 2600));
    });

    assert.ok(attempts >= 2, `every tick must retry, saw ${attempts}`);
    assert.match(error.join('\n'), /digest/, 'the failure must be attributed to the job that failed');
    assert.match(error.join('\n'), /digest module is broken/);
    assert.equal(target._isRunning('digest'), false,
      'a crashed run must release its slot or the job is dead forever');
  } finally {
    destroyAll(tasks);
    clearStubs(stubs);
    reset(target);
  }
});

test('a job whose promise REJECTS is logged and releases the guard', async () => {
  let attempts = 0;
  const stubs = [
    stubJobModule('src/jobs/reminders.js', {
      runReminders: async () => {
        attempts += 1;
        throw new Error('db is locked');
      },
    }),
    stubJobModule('src/jobs/followups.js', { runFollowups: async () => ({ sent: 0 }) }),
    stubJobModule('src/jobs/reengagement.js', { runReengagement: async () => ({ sent: 0 }) }),
    stubJobModule('src/services/digest.js', { sendWeeklyDigest: async () => ({ sent: true }) }),
  ];
  const schedule = {};
  for (const k of JOB_KEYS) schedule[k] = { cron: EVERY_SECOND };

  let tasks = [];
  try {
    const { error } = await captureAsync(async () => {
      tasks = withScheduleFile(JSON.stringify(schedule), () => target.startAll());
      await new Promise((r) => setTimeout(r, 2600));
    });
    assert.ok(attempts >= 2, `every tick must retry, saw ${attempts}`);
    assert.match(error.join('\n'), /db is locked/);
    assert.equal(target._isRunning('reminders'), false, 'the guard must be released');
  } finally {
    destroyAll(tasks);
    clearStubs(stubs);
    reset(target);
  }
});

test('a job module that does not export its runner is a logged failure, not a boot crash', async () => {
  // digest.js present but exporting something else entirely.
  const stubs = [
    stubJobModule('src/services/digest.js', { somethingElse: true }),
    stubJobModule('src/jobs/reminders.js', { runReminders: async () => ({ sent: 0 }) }),
    stubJobModule('src/jobs/followups.js', { runFollowups: async () => ({ sent: 0 }) }),
    stubJobModule('src/jobs/reengagement.js', { runReengagement: async () => ({ sent: 0 }) }),
  ];
  const schedule = {};
  for (const k of JOB_KEYS) schedule[k] = { cron: EVERY_SECOND };

  let tasks = [];
  try {
    const { error } = await captureAsync(async () => {
      tasks = withScheduleFile(JSON.stringify(schedule), () => target.startAll());
      await new Promise((r) => setTimeout(r, 1800));
    });
    assert.equal(tasks.length, 4, 'all four jobs still register');
    assert.match(error.join('\n'), /digest/,
      'the missing runner must surface as a logged failure for that one job');
    assert.equal(target._isRunning('digest'), false);
  } finally {
    destroyAll(tasks);
    clearStubs(stubs);
    reset(target);
  }
});

// ---------------------------------------------------------------------------
// 6. startAll — registers ALL FOUR jobs, still returns an array
// ---------------------------------------------------------------------------

test('startAll registers four cron tasks, including digest, and returns an array', () => {
  target.resetForTests();
  const tasks = capture(() => target.startAll()).result;
  try {
    assert.ok(Array.isArray(tasks), 'server.js reads tasks.length — it MUST be an array');
    assert.equal(tasks.length, 4, 'reminders, followups, reengagement AND digest');
    for (const t of tasks) {
      assert.equal(typeof t.stop, 'function');
      assert.equal(typeof t.destroy, 'function');
    }
  } finally {
    destroyAll(tasks);
    reset(target);
  }
});

test('startAll logs a startup line for every job, naming digest (the D14 proof)', () => {
  target.resetForTests();
  let tasks = [];
  const { log } = capture(() => {
    tasks = target.startAll();
  });
  const blob = log.join('\n');
  try {
    for (const k of JOB_KEYS) {
      assert.ok(blob.includes(k), `no startup log line for ${k}`);
      assert.ok(blob.includes(`${k} scheduled`), `missing "scheduled" line for ${k}`);
    }
    assert.match(blob, /digest scheduled: 0 8 \* \* MON/);
  } finally {
    destroyAll(tasks);
    reset(target);
  }
});

test('a job with an INVALID cron is skipped loudly while the others still run', () => {
  target.resetForTests();
  let tasks = [];
  const { warn, log, result } = capture(() =>
    withScheduleFile(JSON.stringify({
      reminders: { cron: 'every 15 mins please' },
      digest: { cron: '0 8 * * MON' },
    }), () => target.startAll()));
  tasks = result;
  try {
    assert.equal(tasks.length, 3, 'only the broken job is dropped');
    assert.match(warn.join('\n'), /reminders/);
    assert.match(warn.join('\n'), /every 15 mins please/, 'the bad expression is echoed back');
    assert.match(warn.join('\n'), /WILL NOT RUN/i, 'the skip must be loud');
    assert.match(log.join('\n'), /digest scheduled/, 'digest still registers');
  } finally {
    destroyAll(tasks);
    reset(target);
  }
});

test('startAll is still idempotent: a second boot returns [] and adds no timers', () => {
  target.resetForTests();
  let first = [];
  let second = null;
  capture(() => {
    first = target.startAll();
  });
  try {
    capture(() => {
      second = target.startAll();
    });
    assert.deepEqual(second, [], 'double-boot must not double-schedule');
    assert.equal(first.length, 4);
  } finally {
    destroyAll(first);
    reset(target);
  }
});

test('after resetForTests a fresh startAll registers all four again', () => {
  let first = [];
  let again = [];
  capture(() => {
    first = target.startAll();
  });
  target.resetForTests();
  capture(() => {
    again = target.startAll();
  });
  try {
    assert.equal(again.length, 4, 'the singleton guard must be resettable');
  } finally {
    destroyAll(first);
    destroyAll(again);
    reset(target);
  }
});

// ---------------------------------------------------------------------------
// 7. The module a future editor would otherwise have to trust
// ---------------------------------------------------------------------------

test('index.js is syntactically valid and requires nothing database-related at load', () => {
  // `npm run check` / `npm run sanity` do NOT node --check this file, so a
  // parse error here would otherwise only surface at boot, in production.
  const src = require('fs').readFileSync(path.join(JOBS, 'index.js'), 'utf8');
  // The lazy-require is the whole boot-tolerance mechanism; a top-level require
  // of a job module or of db.js would reintroduce the crash-on-boot bug.
  const topLevel = src.split('\n').filter((line) => {
    const t = line.trim();
    if (!t.startsWith('const ') || !t.includes('require(')) return false;
    // A require at column 0 is module scope; index.js indents tick bodies.
    return /^const\s/.test(line);
  });
  for (const line of topLevel) {
    assert.ok(!/require\('\.\/(reminders|followups|reengagement)'\)/.test(line),
      `job module required at module scope (breaks boot tolerance): ${line.trim()}`);
    assert.ok(!/db\/db|repository/.test(line),
      `database required at module scope (breaks boot + opens data/clinic.db): ${line.trim()}`);
  }
  assert.ok(topLevel.length > 0, 'sanity: the top-level require scan actually matched something');
});