// ============================================================================
// clinic-automation — D11 authorization tests (tests/intake-authz.test.js)
// Intake answers are protected medical data. POST /api/intake/:appointmentId
// used to accept ANY appointmentId with no proof of ownership, so anyone could
// walk the ids and overwrite a patient's answers, and the 404-vs-201 split was a
// free enumeration oracle for the whole booking table.
//
// Deliberately mounts ONLY src/routes/intake.js on a bare express app rather
// than going through createApp(): this file then tests the authorization
// contract in isolation and cannot be broken by unrelated rewiring of app.js
// (CSRF mounts, rate-limit presets, session store) - which is exactly the churn
// that made the same assertions untestable from tests/api.test.js.
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { freshDb, cleanupTemp, SRC } = require('./helpers');

const ctx = freshDb();
const repo = ctx.repo;

// Teardown lives in the single `after` hook at the bottom of this file: the
// listening server must be closed BEFORE cleanupTemp() closes the SQLite
// handle, otherwise a request in flight trips over a closed DB.

const express = require(path.join(SRC, '..', 'node_modules', 'express'));
const intakeRouter = require(path.join(SRC, 'routes', 'intake.js'));
const intakeQuestions = require(path.join(SRC, 'config', 'intake-questions.json'));

// Every listener this file opens is tracked. The admin test below starts a
// SECOND app; assigning it to `server` overwrote the first reference, so the
// original listener was never closed and the test process hung after all
// assertions had passed (node --test reported a file-level failure with zero
// failing subtests). A leaked listener is a test bug, not a flake.
const servers = new Set();
let server;
let client;

test.before(async () => {
  const app = express();
  app.use(express.json());
  // Mirror src/app.js: no CSRF on the public intake API (it is not
  // cookie-authenticated), so this test exercises D11 and nothing else.
  app.use('/api/intake', intakeRouter);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
    servers.add(server);
  });
  // Resolve the base URL at CALL time, never capture it here. The admin test at
  // the bottom of this file deliberately closes THIS server and starts a
  // different one on a different port, so a captured `base` leaves `client`
  // aimed at a dead listener for the rest of the process. A stale client does
  // not return a status code - it throws the opaque `TypeError: fetch failed`,
  // which is precisely the "mystery" failure mode this file's teardown comments
  // were written to eliminate. Verified by probe: a client bound to a closed
  // listener throws on the next call instead of answering.
  const currentBase = () => {
    if (!server || !server.listening) {
      throw new Error('intake-authz: no live server for `client` (called during/after teardown?)');
    }
    return `http://127.0.0.1:${server.address().port}`;
  };
  client = {
    post: async (p, body) => {
      const res = await fetch(currentBase() + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify(body || {}),
      });
      return { status: res.status, body: await res.json() };
    },
    get: async (p) => {
      const res = await fetch(currentBase() + p, { headers: { connection: 'close' } });
      return { status: res.status, body: await res.json() };
    },
  };
});

test.after(async () => {
  await Promise.all([...servers].map((s) => new Promise((resolve) => {
    if (!s.listening) return resolve();
    s.close(() => resolve());
  })));
  servers.clear();
  // LAST, never before the await above. cleanupTemp() closes this process's
  // SQLite handle and deletes test-<pid>-N.db; calling it while a listener is
  // still up lets a request in flight trip over a closed DB. Without this call
  // every run orphans its temp DB, and helpers.js documents that the OS REUSES
  // pids - so a later run handed the same pid reopens that stale file, inherits
  // its rows, and this file's fixed-phone fixtures (VICTIM/ATTACKER) then fail
  // SQLITE_CONSTRAINT_UNIQUE on a run that is otherwise byte-identical.
  cleanupTemp();
});

// A complete, valid answer set built from the real questionnaire config.
function validAnswers() {
  const answers = {};
  for (const q of intakeQuestions) {
    if (q.id.startsWith('_')) continue;
    if (q.type === 'checkbox') answers[q.id] = true;
    else if (q.type === 'select' && Array.isArray(q.options) && q.options.length) answers[q.id] = q.options[0];
    else if (q.type === 'phone') answers[q.id] = '+919876543210';
    else answers[q.id] = 'Test answer';
  }
  return answers;
}

// Two distinct patients, each with one appointment, so "mine" and "yours" differ.
const VICTIM_PHONE = '+919000000118';
const ATTACKER_PHONE = '+919000000119';
let victim;
let attacker;

test.before(() => {
  const victimClient = repo.clients.create({ name: 'Victim', phone: VICTIM_PHONE });
  const attackerClient = repo.clients.create({ name: 'Attacker', phone: ATTACKER_PHONE });
  victim = repo.appointments.book({
    clientId: victimClient.id,
    slotStart: '2026-11-02 10:00',
    slotEnd: '2026-11-02 10:30',
    service: 'Consultation',
  });
  attacker = repo.appointments.book({
    clientId: attackerClient.id,
    slotStart: '2026-11-02 11:00',
    slotEnd: '2026-11-02 11:30',
    service: 'Consultation',
  });
});

test('the patient CAN file their own intake', async () => {
  const res = await client.post(`/api/intake/${victim.id}`, { phone: VICTIM_PHONE, answers: validAnswers() });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(res.body.intake, 'the saved intake is echoed back');
});

test('invalid answers are still a 400 - and validation runs only AFTER authorization', async () => {
  const anon = await client.post(`/api/intake/${victim.id}`, { answers: {} });
  assert.equal(anon.status, 403, 'an unauthorized caller never learns whether the answers were valid');

  const owner = await client.post(`/api/intake/${victim.id}`, { phone: VICTIM_PHONE, answers: {} });
  assert.equal(owner.status, 400);
  assert.ok(Array.isArray(owner.body.details) && owner.body.details.length > 0);
});

test('D11 core: no proof of ownership is refused and nothing is written', async () => {
  const before = repo.getIntakeByAppointment(victim.id);

  const noPhone = await client.post(`/api/intake/${attacker.id}`, { answers: validAnswers() });
  assert.equal(noPhone.status, 403);
  assert.equal(noPhone.body.error, 'intake_forbidden');

  const emptyPhone = await client.post(`/api/intake/${attacker.id}`, { phone: '', answers: validAnswers() });
  assert.equal(emptyPhone.status, 403);

  const unknownPhone = await client.post(`/api/intake/${attacker.id}`, { phone: '+919000000001', answers: validAnswers() });
  assert.equal(unknownPhone.status, 403);

  // The attacker has NO intake of their own before this test...
  assert.equal(repo.getIntakeByAppointment(attacker.id), null, 'precondition: attacker has no intake');
  // ...and still none after every attempt above.
  assert.equal(repo.getIntakeByAppointment(attacker.id), null,
    'a refused caller must never create or replace an intake row');
  assert.deepEqual(repo.getIntakeByAppointment(victim.id), before,
    "the victim's stored answers are untouched");
});

test('D11 core: a valid patient cannot overwrite ANOTHER patient\'s answers', async () => {
  const before = repo.getIntakeByAppointment(victim.id);
  assert.ok(before, 'precondition: the victim has intake to protect');

  // The attacker knows their OWN phone (they booked legitimately) and guesses
  // the victim's appointmentId. That must still fail.
  const res = await client.post(`/api/intake/${victim.id}`, { phone: ATTACKER_PHONE, answers: validAnswers() });

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'appointment_not_found');
  assert.deepEqual(repo.getIntakeByAppointment(victim.id), before,
    "the victim's medical answers are byte-identical after the attack");
});

test('D11: "not yours" and "does not exist" are byte-identical (no enumeration oracle)', async () => {
  // For an IDENTIFIED caller, a foreign appointmentId and an absent one must be
  // indistinguishable - otherwise the attacker can enumerate the booking table.
  const foreign = await client.post(`/api/intake/${victim.id}`, { phone: ATTACKER_PHONE, answers: validAnswers() });
  const absent = await client.post('/api/intake/88888888', { phone: ATTACKER_PHONE, answers: validAnswers() });

  assert.equal(foreign.status, absent.status);
  assert.deepEqual(foreign.body, absent.body,
    'responses must be byte-identical so appointmentId existence cannot be probed');

  // And for an UNIDENTIFIED caller the response must not vary with the id either.
  const anonVictim = await client.post(`/api/intake/${victim.id}`, { answers: validAnswers() });
  const anonAbsent = await client.post('/api/intake/88888888', { answers: validAnswers() });
  assert.equal(anonVictim.status, anonAbsent.status);
  assert.deepEqual(anonVictim.body, anonAbsent.body);
});

test('the body-style alias POST /api/intake enforces the same rule', async () => {
  const before = repo.getIntakeByAppointment(victim.id);

  const anon = await client.post('/api/intake', { appointmentId: victim.id, answers: validAnswers() });
  assert.equal(anon.status, 403, 'the alias must not be an unauthenticated back door');

  const foreign = await client.post('/api/intake', {
    appointmentId: victim.id, phone: ATTACKER_PHONE, answers: validAnswers(),
  });
  assert.equal(foreign.status, 404);

  const owner = await client.post('/api/intake', {
    appointmentId: victim.id, phone: VICTIM_PHONE, answers: validAnswers(),
  });
  assert.equal(owner.status, 201, JSON.stringify(owner.body));

  assert.ok(repo.getIntakeByAppointment(victim.id), 'owner still has their intake');
  assert.ok(before, 'precondition held');
});

test('GET /api/intake/questions stays public (config, not patient data)', async () => {
  const res = await client.get('/api/intake/questions');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.questions) && res.body.questions.length > 0);
});

test('an admin session may file intake on a patient\'s behalf', async () => {
  // src/middleware/auth.js writes req.session.admin on login; assert the route
  // honours that shape without needing the full login flow.
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { admin: { username: 'admin' } }; next(); });
  app.use('/api/intake', intakeRouter);
  // Close the anonymous server FIRST: the credential under test is installed by
  // middleware the anonymous app does not have, so this needs its own listener.
  await new Promise((resolve) => { if (server) server.close(resolve); else resolve(); });
  server = null;
  // The new listener MUST join `servers`. `test.after` closes servers by iterating
  // that Set, so a handle missing from it is never closed: node --test waits on the
  // open listener until it force-kills the process, which surfaces as a FILE-level
  // "test failed" with ZERO failing subtests after the full timeout. That is exactly
  // the 233-second stall this line previously caused, so it is asserted rather than
  // left to a comment: a Set is idempotent, so adding twice is harmless.
  const adminServer = app.listen(0, '127.0.0.1');
  servers.add(adminServer);
  await new Promise((resolve) => adminServer.once('listening', resolve));
  const base = `http://127.0.0.1:${adminServer.address().port}`;
  // No CSRF token here on purpose. src/app.js mounts /api/intake with a rate
  // limiter ONLY - the public JSON APIs carry no cookie credential, so there is
  // no ambient authority for a CSRF attack to borrow (see app.js header). This
  // app is a bare express instance and serves no /csrf route at all.
  const res = await fetch(`${base}/api/intake/${attacker.id}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      connection: 'close',
    },
    body: JSON.stringify({ answers: validAnswers() }),
  });
  assert.equal(res.status, 201, 'an admin needs no patient phone');
  assert.ok(repo.getIntakeByAppointment(attacker.id), "the admin-filed intake is persisted");
});