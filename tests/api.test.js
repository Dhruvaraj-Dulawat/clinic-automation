// ============================================================================
// clinic-automation — HTTP integration tests (tests/api.test.js)
// Drives the real Express app in-process: health, admin auth, availability,
// booking + no-double-book, intake validation, status-lookup privacy,
// CSV import dedupe, admin CRUD/export and reporting.
// Hermetic: isolated temp DB, mock WhatsApp, no external services.
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupTemp, startServer, createHttpClient, nextOpenDate } = require('./helpers');

freshDb(); // sets the hermetic env BEFORE app/db modules load
let server;
let client;

test.before(async () => {
  server = await startServer();
  client = server.client;
});
test.after(async () => { if (server) await server.close(); cleanupTemp(); });

const intakeQuestions = require('../src/config/intake-questions.json');

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

// Answers that are VALID (so a rejection can only be about authorization, never
// about validation) but unmistakably NOT the patient's.
//
// This exists because the obvious `answers: validAnswers()` in an attacker
// request makes the "the stored answers were not overwritten" assertion
// VACUOUS: the attacker submits byte-identical answers, so the stored row
// matches whether or not the write was ever authorised. That version of the test
// passes with D11 completely absent. Only differing content can prove the write
// was refused.
//
// Only the free-text and phone fields are altered. `select` must stay one of the
// configured options and `consent` must stay exactly true, or validateIntake
// would reject the request for a reason that has nothing to do with ownership.
function tamperedAnswers() {
  const answers = validAnswers();
  for (const q of intakeQuestions) {
    if (q.id.startsWith('_')) continue;
    if (q.type === 'text' || q.type === 'textarea') answers[q.id] = 'TAMPERED BY ATTACKER';
    else if (q.type === 'phone') answers[q.id] = '+919000000999';
  }
  return answers;
}

// Reserve a free slot and book it, retrying on a 409 race.
const taken = new Set();
async function bookSlotFor(phone, name) {
  const date = nextOpenDate(1);
  for (let i = 0; i < 12; i += 1) {
    const avail = await client.get(`/api/bookings/availability?date=${date}`);
    const slot = avail.body.slots.find((s) => s.available && !taken.has(s.start));
    if (!slot) throw new Error('no free slot left for the test');
    const res = await client.post('/api/bookings/book', {
      name, phone, date, slotStart: slot.start, service: 'Consultation',
    });
    if (res.status === 201) { taken.add(slot.start); return res.body.appointment; }
    assert.equal(res.status, 409, `unexpected booking failure: ${JSON.stringify(res.body)}`);
  }
  throw new Error('could not book a free slot');
}

test('GET /api/health reports ok', async () => {
  const res = await client.get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('admin APIs reject anonymous callers', async () => {
  const anon = createHttpClient(server.baseUrl);
  assert.equal((await anon.get('/api/clients')).status, 401);
  assert.equal((await anon.get('/api/reports/daily')).status, 401);
  assert.equal((await anon.get('/api/reports/flags')).status, 401);
  assert.equal((await anon.post('/api/clients', { name: 'X', phone: '+919000000099' })).status, 401);
  assert.equal((await anon.post('/api/import/csv', { csv: 'name,phone\nX,+919000000099' })).status, 401);
});

test('login rejects a bad password and opens a session for a good one', async () => {
  const c = createHttpClient(server.baseUrl);
  // Login is itself CSRF-guarded (login-CSRF is a real attack), so bootstrap a
  // token before posting credentials.
  await c.ensureCsrf();
  assert.equal((await c.post('/api/admin/login', { username: 'admin', password: 'wrong' })).status, 401);

  const good = await c.login();
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.equal(good.body.ok, true);

  assert.equal((await c.get('/api/clients')).status, 200, 'session cookie unlocks guarded routes');
  assert.equal((await c.get('/api/reports/daily')).status, 200);
});

test('booking: availability -> 201 -> double-book 409 -> availability updates', async () => {
  const date = nextOpenDate(2);
  const avail = await client.get(`/api/bookings/availability?date=${date}`);
  assert.equal(avail.status, 200);
  assert.equal(avail.body.date, date);
  assert.ok(avail.body.slots.length > 0);
  assert.ok(avail.body.slots.every((s) => typeof s.start === 'string' && typeof s.available === 'boolean'));

  const free = avail.body.slots.find((s) => s.available && !taken.has(s.start));
  const res = await client.post('/api/bookings/book', {
    name: 'Test Patient', phone: '+91 90000 00111', date, slotStart: free.start, service: 'Consultation',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(res.body.appointment && res.body.appointment.id);
  assert.ok(res.body.client && res.body.client.id, 'booking creates/links the client record');
  taken.add(free.start);

  const clash = await client.post('/api/bookings/book', {
    name: 'Other Patient', phone: '+919000000112', date, slotStart: free.start, service: 'Consultation',
  });
  assert.equal(clash.status, 409, 'double-booking must be refused');

  const after = await client.get(`/api/bookings/availability?date=${date}`);
  assert.equal(after.body.slots.find((s) => s.start === free.start).available, false);
});

test('booking validates its input', async () => {
  assert.equal((await client.post('/api/bookings/book', { name: 'A', phone: '+919000000113', slotStart: 'nope' })).status, 400);
  assert.equal((await client.post('/api/bookings/book', { name: '', phone: '+919000000114', slotStart: '2026-01-01 09:00' })).status, 400);
  assert.equal((await client.post('/api/bookings/book', { name: 'A', phone: '', slotStart: '2026-01-01 09:00' })).status, 400);
  // 03:00 is outside clinic hours.
  const date = nextOpenDate(2);
  assert.equal((await client.post('/api/bookings/book', { name: 'A', phone: '+919000000115', date, slotStart: `${date} 03:00` })).status, 400);
  assert.equal((await client.get('/api/bookings/availability')).status, 400, 'date is required');
});

test('intake stores a complete questionnaire and rejects an incomplete one', async () => {
  const phone = '+919000000116';
  const appointment = await bookSlotFor(phone, 'Intake Patient');

  // D11: the phone is the proof of ownership, so it rides along with the answers.
  const bad = await client.post(`/api/intake/${appointment.id}`, { phone, answers: {} });
  assert.equal(bad.status, 400);
  assert.ok(Array.isArray(bad.body.details) && bad.body.details.length > 0);

  const good = await client.post(`/api/intake/${appointment.id}`, { phone, answers: validAnswers() });
  assert.equal(good.status, 201, JSON.stringify(good.body));

  // An id that does not exist, presented by an IDENTIFIED caller, is a 404.
  const missing = await client.post('/api/intake/99999999', { phone, answers: validAnswers() });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'appointment_not_found');

  assert.equal((await client.get('/api/intake/questions')).status, 200);
});

test('D11: intake cannot be read or overwritten by anyone but the patient or an admin', async () => {
  const phone = '+919000000118';
  const attackerPhone = '+919000000119';
  const appointment = await bookSlotFor(phone, 'D11 Patient');

  // The attacker must be a REAL client. Without a clients row, findByPhone()
  // cannot identify them at all, so the route stops at the "unidentified
  // caller" 403 and never reaches the ownership check this test is about. A
  // stranger and a known-client-attacking-someone-else are two different
  // threats and they deserve two different assertions.
  const attackerAppointment = await bookSlotFor(attackerPhone, 'D11 Attacker');
  assert.notEqual(attackerAppointment.client_id, appointment.client_id,
    'the attacker must be a DIFFERENT client, or case 2 proves nothing');

  // The victim files a real intake first, so we can prove it is NOT clobbered.
  const seeded = await client.post(`/api/intake/${appointment.id}`, { phone, answers: validAnswers() });
  assert.equal(seeded.status, 201, JSON.stringify(seeded.body));

  // 1) No proof at all -> 403. Answer payload must be ignored entirely.
  const anon = await client.post(`/api/intake/${appointment.id}`, { answers: tamperedAnswers() });
  assert.equal(anon.status, 403);
  assert.equal(anon.body.error, 'intake_forbidden');

  // 2) A phone that exists but is NOT this appointment's client -> 404, and the
  //    response is byte-identical to a genuinely absent id, so it is not an
  //    enumeration oracle for other patients' appointment ids.
  const foreign = await client.post(`/api/intake/${appointment.id}`, { phone: attackerPhone, answers: tamperedAnswers() });
  const absent = await client.post('/api/intake/88888888', { phone: attackerPhone, answers: tamperedAnswers() });
  assert.equal(foreign.status, 404, `a cross-patient write must be 404, got ${foreign.status} ${JSON.stringify(foreign.body)}`);
  assert.deepEqual(foreign.body, absent.body,
    'foreign-appointment and absent-appointment responses must be indistinguishable');

  // 3) Unknown phone -> 403, and likewise independent of appointmentId.
  const unknown = await client.post(`/api/intake/${appointment.id}`, { phone: '+919000000001', answers: tamperedAnswers() });
  assert.equal(unknown.status, 403);
  assert.equal(unknown.body.error, 'intake_forbidden');
  const unknownAbsent = await client.post('/api/intake/77777777', { phone: '+919000000001', answers: tamperedAnswers() });
  assert.deepEqual(unknown.body, unknownAbsent.body,
    'the 403 must not vary with appointmentId either, or it enumerates the table');

  // 4) Nothing above may have mutated the stored answers. Read them back
  //    through the repository (public accessor) rather than raw SQL.
  //
  //    This is only meaningful because the rejected writes carried
  //    tamperedAnswers(). latestFor() returns the NEWEST row, so an accepted
  //    overwrite OR an accepted append would both surface the attacker's text
  //    here and fail the comparison below.
  const repository = require('../src/db/repository');
  const stored = repository.getIntakeByAppointment(appointment.id);
  assert.ok(stored, "the patient's own answers are still stored");
  const storedAnswers = JSON.parse(stored.answers_json);
  assert.deepEqual(
    storedAnswers,
    JSON.parse(seeded.body.intake.answers_json),
    "the stored answers are the ones the PATIENT submitted, not the attacker's",
  );
  assert.notEqual(storedAnswers.full_name, 'TAMPERED BY ATTACKER',
    'the tamper marker must never reach storage');
});

test('status lookup returns own visits only and resists enumeration', async () => {
  const phone = '+919000000777';
  await bookSlotFor(phone, 'Status Patient');
  const last4 = phone.slice(-4);

  const found = await client.get(`/api/status?phone=${encodeURIComponent(phone)}&last4=${last4}`);
  assert.equal(found.status, 200);
  assert.equal(found.body.client.phone, phone);
  assert.ok(found.body.appointments.length >= 1);

  const wrongLast4 = await client.get(`/api/status?phone=${encodeURIComponent(phone)}&last4=0000`);
  const unknown = await client.get('/api/status?phone=%2B919999999999&last4=9999');
  assert.equal(wrongLast4.status, 404);
  assert.equal(unknown.status, 404);
  assert.deepEqual(wrongLast4.body, unknown.body, 'identical 404 body prevents client enumeration');

  assert.equal((await client.get('/api/status')).status, 400, 'a missing phone is a client error');
  // The last-4 check is mandatory: knowing only the number must NOT be enough.
  // A missing code returns the same opaque 404 as a wrong code, so the endpoint
  // never reveals whether a number is registered.
  const noCode = await client.get(`/api/status?phone=${encodeURIComponent(phone)}`);
  assert.equal(noCode.status, 404, 'last4 is required, otherwise any holder of the number could read the visits');
  assert.deepEqual(noCode.body, wrongLast4.body, 'missing and wrong codes are indistinguishable');
});

test('CSV import reports duplicates and errors', async () => {
  const admin = createHttpClient(server.baseUrl);
  assert.equal((await admin.login()).status, 200);

  const csv = [
    'name,phone,email,tags,notes',
    'Import One,+91 90000 00333,one@example.com,,',
    'Import One Again,919000000333,,,',
    'Import Two,+919000000334,,,',
  ].join('\n');

  const first = await admin.post('/api/import/csv', { csv });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.report.imported, 2);
  assert.equal(first.body.report.skipped_duplicates, 1);

  const second = await admin.post('/api/import/csv', { csv });
  assert.equal(second.body.report.imported, 0, 're-import never duplicates');
  assert.equal(second.body.report.skipped_duplicates, 3);

  assert.equal((await admin.post('/api/import/csv', {})).status, 400);
});

test('admin client CRUD, tagging and CSV export', async () => {
  const admin = createHttpClient(server.baseUrl);
  await admin.login();

  const created = await admin.post('/api/clients', { name: 'CRUD Person', phone: '+919000000555', email: 'crud@example.com' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.client.id;

  assert.equal((await admin.post('/api/clients', { name: 'CRUD Clone', phone: '+919000000555' })).status, 409);
  assert.equal((await admin.post('/api/clients', { name: 'No Phone' })).status, 400);

  const tagged = await admin.post(`/api/clients/${id}/tags`, { tag: 'vip' });
  assert.equal(tagged.status, 200);
  assert.match(String(tagged.body.client.tags), /vip/);

  const patched = await admin.patch(`/api/clients/${id}`, { notes: 'prefers mornings' });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.client.notes, 'prefers mornings');
  assert.equal(patched.body.client.name, 'CRUD Person', 'patch must not blank other fields');

  const searched = await admin.get('/api/clients?search=CRUD');
  assert.equal(searched.status, 200);
  assert.ok(searched.body.clients.length >= 1);

  const exported = await admin.get('/api/admin/export.csv');
  assert.equal(exported.status, 200);
  assert.match(String(exported.text), /CRUD Person/);
});

test('reporting endpoints return coherent summaries', async () => {
  const admin = createHttpClient(server.baseUrl);
  await admin.login();

  const daily = await admin.get('/api/reports/daily');
  assert.equal(daily.status, 200);
  for (const key of ['bookings', 'noShows', 'revenue', 'newClients', 'returningClients']) {
    assert.equal(typeof daily.body[key], 'number', `daily.${key} must be numeric`);
  }

  const flags = await admin.get('/api/reports/flags');
  assert.equal(flags.status, 200);
  for (const key of ['noResponseAfterReminder', 'overdueNextVisit']) {
    assert.ok(Array.isArray(flags.body[key]), `flags.${key} must be an array`);
  }

  const weekly = await admin.get('/api/reports/weekly');
  assert.equal(weekly.status, 200);
  assert.equal(typeof weekly.body.total, 'number');
});

test('unknown API routes return a JSON 404', async () => {
  const res = await client.get('/api/definitely-not-a-route');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});