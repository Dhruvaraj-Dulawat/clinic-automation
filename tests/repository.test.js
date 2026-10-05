// clinic-automation — repository contract (tests/repository.test.js)
// Locks the data-access layer before any refactor: phone normalization, the
// UNIQUE(phone) dedupe constraint, the UNIQUE(slot_start) no-double-book
// constraint, search/list/update semantics and the flat back-compat aliases.
// Target: src/db/repository.js (against a real, isolated temp SQLite DB).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { after } = require('node:test');
const h = require('./helpers');

after(() => h.cleanupTemp());

test('normalizePhone strips everything but digits/plus and prepends +', () => {
  const { repo } = h.freshDb();
  const cases = [
    ['+91 98765-43210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['9876543210', '+9876543210'],
    ['  +91 98765 43210  ', '+919876543210'],
    ['(+91)98765-43210', '+919876543210'],
    ['91-98765-43210', '+919876543210'],
    ['+91.98765.43210', '+919876543210'],
    ['+1 (555) 010-9999', '+15550109999'],
    ['+919876543210', '+919876543210'],
    // Empty-ish input normalizes to the bare '+' sentinel that every caller
    // rejects with `phone === '+'` (see csvImport.js / routes/bookings.js).
    ['', '+'],
    [null, '+'],
    [undefined, '+'],
    ['not-a-phone', '+'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(repo.normalizePhone(input), expected, `normalizePhone(${JSON.stringify(input)})`);
  }
});

test('clients.create normalizes the phone and returns the persisted row', () => {
  const { clients } = h.freshDb();
  const created = clients.create({ name: 'Asha Rao', phone: '+91 98765-43210', email: 'A@Example.COM', tags: 'new', notes: 'first visit' });
  assert.equal(created.name, 'Asha Rao');
  assert.equal(created.phone, '+919876543210');
  assert.equal(created.email, 'A@Example.COM');
  assert.ok(Number.isInteger(created.id) && created.id > 0, 'id is an autoincrement integer');
  assert.ok(created.created_at && created.updated_at, 'timestamps defaulted by the schema');

  // findByPhone normalizes its argument too, so raw formats still resolve.
  assert.equal(clients.findByPhone('91-98765-43210').id, created.id);
  assert.equal(clients.findByPhone('+919876543210').id, created.id);
  assert.equal(clients.findByPhone('+919876543211'), null, 'unknown phone -> null');
  assert.equal(clients.findById(created.id).phone, '+919876543210');
  assert.equal(clients.findById(99999), null);
});

test('duplicate phone violates UNIQUE(clients.phone) — the CSV dedupe key', () => {
  const { clients } = h.freshDb();
  clients.create({ name: 'First', phone: '+919876543210' });
  assert.throws(
    () => clients.create({ name: 'Second', phone: '+91 98765 43210' }),
    (err) => {
      assert.equal(err.code, 'SQLITE_CONSTRAINT_UNIQUE', 'UNIQUE violation code');
      assert.match(err.message, /UNIQUE constraint failed: clients\.phone/);
      return true;
    }
  );
  // The failed insert must not have created a second row.
  assert.equal(clients.search('First').length + clients.search('Second').length, 1);
  assert.equal(clients.list(100, 0).length, 1);
});

test('clients.search matches name, phone and tags (LIKE %q%)', () => {
  const { clients } = h.freshDb();
  clients.create({ name: 'Priya Sharma', phone: '+919811110001', tags: 'acne, followup' });
  clients.create({ name: 'Rahul Verma', phone: '+919822220002', tags: 'dental' });

  assert.equal(clients.search('Priya').length, 1);
  assert.equal(clients.search('priya').length, 1, 'SQLite LIKE is ASCII case-insensitive');
  assert.equal(clients.search('+91982222').length, 1, 'phone fragment match');
  assert.equal(clients.search('acne').length, 1, 'tag match');
  assert.equal(clients.search('nobody').length, 0);
  assert.equal(clients.search('').length, 2, 'empty query matches everything');
});

test('clients.list is updated_at DESC and honours limit/offset', () => {
  const { clients, db } = h.freshDb();
  clients.create({ name: 'A', phone: '+919800000001' });
  clients.create({ name: 'B', phone: '+919800000002' });
  clients.create({ name: 'C', phone: '+919800000003' });
  // Pin updated_at so the ordering assertion is not clock-dependent.
  db.prepare("UPDATE clients SET updated_at = '2026-01-01 00:00:00' WHERE name = 'A'").run();
  db.prepare("UPDATE clients SET updated_at = '2026-03-01 00:00:00' WHERE name = 'B'").run();
  db.prepare("UPDATE clients SET updated_at = '2026-02-01 00:00:00' WHERE name = 'C'").run();

  assert.deepEqual(clients.list().map((c) => c.name), ['B', 'C', 'A']);
  assert.deepEqual(clients.list(2, 0).map((c) => c.name), ['B', 'C']);
  assert.deepEqual(clients.list(2, 2).map((c) => c.name), ['A']);
});

test('clients.update merges via COALESCE and bumps updated_at', () => {
  const { clients } = h.freshDb();
  const c = clients.create({ name: 'Nikhil', phone: '+919833330003', email: 'n@x.com', tags: 'vip', notes: 'keep me' });

  const patched = clients.update(c.id, { notes: 'changed' });
  assert.equal(patched.name, 'Nikhil', 'absent fields fall back to the stored value');
  assert.equal(patched.email, 'n@x.com');
  assert.equal(patched.tags, 'vip');
  assert.equal(patched.notes, 'changed');

  const noop = clients.update(c.id, {});
  assert.equal(noop.notes, 'changed');
  assert.equal(noop.phone, '+919833330003', 'update() never touches phone');
});

test('appointments.book + the UNIQUE(slot_start) no-double-book constraint', () => {
  const { clients, appointments, repo } = h.freshDb();
  const c = clients.create({ name: 'Sana', phone: '+919844440004' });
  const slotStart = '2026-10-05 09:00';
  const a = appointments.book({ clientId: c.id, slotStart, slotEnd: '2026-10-05 09:30', service: 'General consultation' });
  assert.equal(a.status, 'booked', 'default status on insert');
  assert.equal(a.client_name, 'Sana', 'findById JOINs the client name');
  assert.equal(a.client_phone, '+919844440004');

  assert.throws(
    () => appointments.book({ clientId: c.id, slotStart, slotEnd: '2026-10-05 09:30', service: 'General consultation' }),
    (err) => err.code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
  assert.equal(appointments.listByRange('2000-01-01 00:00', '2999-01-01 00:00').length, 1, 'the losing insert rolled back');

  // The flat alias translates the constraint error into SLOT_TAKEN for routes.
  assert.throws(
    () => repo.createAppointment({ clientId: c.id, slotStart, slotEnd: '2026-10-05 09:30', service: 'x' }),
    (err) => {
      assert.equal(err.code, 'SLOT_TAKEN');
      assert.equal(err.message, 'slot taken');
      return true;
    }
  );
});

test('findBySlot and the flat findAppointmentBySlot alias agree on cancelled rows', () => {
  const { clients, appointments, repo } = h.freshDb();
  const c = clients.create({ name: 'Vikram', phone: '+919855550005' });
  appointments.book({ clientId: c.id, slotStart: '2026-10-05 10:00', slotEnd: '2026-10-05 10:30', service: 'Dental' });
  assert.ok(appointments.findBySlot('2026-10-05 10:00'), 'live appointment blocks the slot');

  appointments.updateStatus(appointments.findBySlot('2026-10-05 10:00').id, 'cancelled');
  assert.equal(appointments.findBySlot('2026-10-05 10:00'), null, 'cancelled slots are reusable');
  // The alias used to run its own raw SELECT and therefore still saw the
  // cancelled row — two different answers to "is this slot taken?".
  assert.equal(repo.findAppointmentBySlot('2026-10-05 10:00'), null,
    'the flat alias must use the same live-status rule as appointments.findBySlot');
});

test('listByRange is a half-open [from, to) interval, ordered by slot_start', () => {
  const { clients, appointments } = h.freshDb();
  const c = clients.create({ name: 'Meera', phone: '+919866660006' });
  appointments.book({ clientId: c.id, slotStart: '2026-10-05 09:00', slotEnd: '2026-10-05 09:30', service: 'A' });
  appointments.book({ clientId: c.id, slotStart: '2026-10-05 10:00', slotEnd: '2026-10-05 10:30', service: 'B' });
  appointments.book({ clientId: c.id, slotStart: '2026-10-06 09:00', slotEnd: '2026-10-06 09:30', service: 'C' });

  assert.deepEqual(
    appointments.listByRange('2026-10-05 00:00', '2026-10-06 00:00').map((a) => a.slot_start),
    ['2026-10-05 09:00', '2026-10-05 10:00'],
    '`to` is exclusive — the next day is excluded'
  );
  assert.deepEqual(
    appointments.listByRange('2026-10-05 09:00', '2026-10-05 10:00').map((a) => a.slot_start),
    ['2026-10-05 09:00'],
    '`from` is inclusive, `to` exclusive'
  );
  assert.equal(appointments.listByRange('2000-01-01 00:00', '2999-01-01 00:00').length, 3, 'wide window returns all three');
});

test('updateStatus returns the refreshed JOINed row', () => {
  const { clients, appointments } = h.freshDb();
  const c = clients.create({ name: 'Ishita', phone: '+919877770007' });
  const a = appointments.book({ clientId: c.id, slotStart: '2026-10-05 11:00', slotEnd: '2026-10-05 11:30', service: 'Physiotherapy' });
  for (const status of ['confirmed', 'no_show', 'completed', 'cancelled', 'booked']) {
    const row = appointments.updateStatus(a.id, status);
    assert.equal(row.status, status);
    assert.equal(row.client_name, 'Ishita');
  }
  // Unknown statuses are rejected by the repository with a clear domain error
  // (code STATUS_INVALID) instead of leaking a raw SQLite CHECK-constraint
  // message up to the HTTP layer.
  assert.throws(
    () => appointments.updateStatus(a.id, 'teleported'),
    (err) => err.code === 'STATUS_INVALID' && /invalid appointment status/.test(err.message)
  );
});

test('appointments.findByPhone returns the client history newest-first, capped at 20', () => {
  const { clients, appointments } = h.freshDb();
  const c = clients.create({ name: 'Rohan', phone: '+919888880008' });
  for (let i = 0; i < 22; i++) {
    appointments.book({ clientId: c.id, slotStart: `2026-11-${String(i + 1).padStart(2, '0')} 09:00`, slotEnd: '2026-11-01 09:30', service: 'General consultation' });
  }
  const rows = appointments.findByPhone('+91 98888 80008');
  assert.equal(rows.length, 20, 'LIMIT 20');
  assert.equal(rows[0].slot_start, '2026-11-22 09:00', 'newest first');
  assert.equal(rows[19].slot_start, '2026-11-03 09:00');
  assert.equal(appointments.findByPhone('+919899990009').length, 0);
});

test('messages.log, receipts.create and intake round-trip through the repository', () => {
  const { db, clients, appointments, repo } = h.freshDb();
  const c = clients.create({ name: 'Zoya', phone: '+919911110009' });
  const a = appointments.book({ clientId: c.id, slotStart: '2026-10-05 12:00', slotEnd: '2026-10-05 12:30', service: 'Vaccination' });

  const msgId = repo.messages.log({ toPhone: '+919911110009', direction: 'outbound', template: 'reminder_24h', body: 'Reminder text', status: 'mocked' });
  assert.ok(Number.isInteger(msgId) && msgId > 0);
  const logged = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
  assert.equal(logged.template, 'reminder_24h');
  assert.equal(logged.status, 'mocked');
  assert.equal(logged.direction, 'outbound');

  const receiptId = repo.receipts.create({ appointmentId: a.id, clientId: c.id, amount: 500, itemsJson: '[{"x":1}]', filePath: 'data/receipts/r1.pdf' });
  assert.equal(repo.receipts.findById(receiptId).amount, 500);

  assert.equal(repo.getIntakeByAppointment(a.id), null);
  const saved = repo.saveIntakeResponse(a.id, { full_name: 'Zoya', consent: true });
  assert.deepEqual(JSON.parse(saved.answers_json), { full_name: 'Zoya', consent: true });
  repo.saveIntakeResponse(a.id, { full_name: 'Zoya K', consent: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM intake_responses WHERE appointment_id = ?').get(a.id).n, 1, 're-saving replaces (DELETE + INSERT)');
  assert.equal(JSON.parse(repo.getIntakeByAppointment(a.id).answers_json).full_name, 'Zoya K');
});

test('settings KV upsert', () => {
  const { repo } = h.freshDb();
  assert.equal(repo.getSetting('last_digest'), null, 'unknown key -> null');
  repo.setSetting('last_digest', '2026-10-05');
  assert.equal(repo.getSetting('last_digest'), '2026-10-05');
  repo.setSetting('last_digest', '2026-10-12');
  assert.equal(repo.getSetting('last_digest'), '2026-10-12', 'upsert overwrites');
  assert.equal(repo.getSetting('never_set'), null);
});

test('flat back-compat aliases delegate to the namespaced contract', () => {
  const { clients, appointments, repo } = h.freshDb();
  const c = repo.createClient({ name: 'Alias', phone: '+919922220010' });
  assert.equal(repo.findClientByPhone('+91 99222 20010').id, c.id);
  assert.equal(repo.findClientById(c.id).name, 'Alias');
  assert.equal(repo.getClientById(c.id).id, c.id);
  assert.equal(repo.searchClients('Alias').length, 1);
  assert.equal(repo.searchClients({ q: 'Alias', limit: 5 }).length, 1, 'object-form search args');
  assert.equal(repo.listClients(10, 0).length, 1);

  const a = repo.createAppointment({ clientId: c.id, slotStart: '2026-10-05 14:00', slotEnd: '2026-10-05 14:30', service: 'Health checkup' });
  assert.equal(repo.getAppointmentById(a.id).slot_start, '2026-10-05 14:00');
  assert.equal(repo.findAppointmentById(a.id).id, a.id);
  assert.equal(repo.updateAppointmentStatus(a.id, 'confirmed').status, 'confirmed');
  assert.equal(repo.listAppointmentsByClient(c.id).length, 1);
  assert.equal(repo.listAppointments({ from: '2026-10-05 00:00', to: '2026-10-06 00:00' }).length, 1);
  assert.equal(repo.listAppointments().length, 1, 'no args -> wide default window');
  assert.ok(clients.findById(c.id), 'namespaced clients still reachable');
  assert.equal(appointments.findById(a.id).status, 'confirmed');
});

test('findInactiveSince(days) returns clients whose latest visit is older than the window', () => {
  const { db, clients, appointments } = h.freshDb();
  const stale = clients.create({ name: 'Stale', phone: '+919933330011' });
  const fresh = clients.create({ name: 'Fresh', phone: '+919944440012' });
  appointments.book({ clientId: stale.id, slotStart: h.localStamp(new Date(Date.now() - 90 * 86400000)), slotEnd: '2020-01-01 09:30', service: 'General consultation' });
  appointments.book({ clientId: fresh.id, slotStart: h.localStamp(new Date(Date.now() + 3 * 86400000)), slotEnd: '2020-01-01 09:30', service: 'General consultation' });

  const rows = appointments.findInactiveSince(30);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, stale.id);
  assert.ok(rows[0].last_visit, 'MAX(slot_start) is exposed as last_visit');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n, 2);
});