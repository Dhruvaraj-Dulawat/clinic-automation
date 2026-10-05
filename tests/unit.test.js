// ============================================================================
// clinic-automation — unit tests for pure logic (tests/unit.test.js)
// Covers: phone normalization, slot grid computation, intake validation,
// message templates, CSV dedupe and repository client operations.
// Hermetic: isolated temp SQLite DB, fixed clinic hours, no network.
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupTemp, withEnv, nextOpenDate, CLINIC_HOURS, dateStr } = require('./helpers');

const ctx = freshDb();
const repo = ctx.repo;
const scheduling = require('../src/services/scheduling');
const intake = require('../src/services/intake');
const templates = require('../src/whatsapp/templates');
const csvImport = require('../src/services/csvImport');
const questions = intake.getQuestions();

test.after(() => cleanupTemp());

// Build a valid answers object for every configured question.
function validAnswers() {
  const answers = {};
  for (const q of questions) {
    if (q.id.startsWith('_')) continue;
    if (q.type === 'checkbox') answers[q.id] = true;
    else if (q.type === 'select' && Array.isArray(q.options) && q.options.length) answers[q.id] = q.options[0];
    else if (q.type === 'phone') answers[q.id] = '+919876543210';
    else answers[q.id] = 'Test answer';
  }
  return answers;
}

test('normalizePhone produces one canonical +<digits> form', () => {
  assert.equal(repo.normalizePhone('919876543210'), '+919876543210');
  assert.equal(repo.normalizePhone('+919876543210'), '+919876543210');
  assert.equal(repo.normalizePhone('+91 98765-43210'), '+919876543210');
  assert.equal(repo.normalizePhone('(91) 98765 43210'), '+919876543210');
  assert.equal(repo.normalizePhone(''), '+', 'empty input degrades to a bare +');
});

test('buildSlots honours open/close, duration and closed weekdays', () => {
  const monday = nextOpenDate(1);
  const cfg = { ...CLINIC_HOURS, open: '09:00', close: '11:00', slotMinutes: 30 };
  const slots = scheduling.buildSlots(monday, cfg);
  assert.equal(slots.length, 4, '09:00-11:00 at 30m = 4 slots');
  assert.equal(slots[0].start, `${monday} 09:00`);
  assert.equal(slots[0].end, `${monday} 09:30`);
  assert.equal(slots[3].end, `${monday} 11:00`);

  const odd = scheduling.buildSlots(monday, { ...cfg, open: '09:00', close: '09:35' });
  assert.equal(odd.length, 1, 'a partial trailing slot is dropped');

  // Sunday is closed in the clinic config.
  const d = new Date(`${monday}T12:00:00`);
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7 || 7)); // next Sunday
  assert.deepEqual(scheduling.buildSlots(dateStr(d), cfg), [], 'closed weekday yields no slots');
});

test('getAvailability marks a booked slot unavailable', () => {
  const day = nextOpenDate(2);
  const cfg = { ...CLINIC_HOURS, open: '09:00', close: '10:00' };
  const client = repo.clients.create({ name: 'Slot Tester', phone: '+919000000001' });
  scheduling.bookSlot({ appointments: repo.appointments }, {
    clientId: client.id, slotStart: `${day} 09:00`, slotEnd: `${day} 09:30`, service: 'Consultation',
  });
  const avail = scheduling.getAvailability({ appointments: repo.appointments }, day, cfg);
  assert.equal(avail.find((s) => s.start === `${day} 09:00`).available, false);
  assert.equal(avail.find((s) => s.start === `${day} 09:30`).available, true);
});

test('bookSlot refuses a double-booking with SLOT_TAKEN', () => {
  const day = nextOpenDate(3);
  const client = repo.clients.create({ name: 'Double Booker', phone: '+919000000002' });
  const args = { clientId: client.id, slotStart: `${day} 10:00`, slotEnd: `${day} 10:30`, service: 'Consultation' };
  scheduling.bookSlot({ appointments: repo.appointments }, args);
  assert.throws(
    () => scheduling.bookSlot({ appointments: repo.appointments }, args),
    (e) => e.code === 'SLOT_TAKEN',
    'the same slot must not be bookable twice'
  );
});

test('validateIntake enforces required answers, options and consent', () => {
  const ok = intake.validateIntake(validAnswers());
  assert.equal(ok.ok, true, `valid answers rejected: ${JSON.stringify(ok.errors)}`);

  const missing = intake.validateIntake({});
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.length > 0);

  const consent = questions.find((q) => q.type === 'checkbox' && q.required);
  if (consent) {
    assert.equal(intake.validateIntake({ ...validAnswers(), [consent.id]: 'yes' }).ok, false,
      'consent must be exactly true');
  }
});

test('every template renders without leftover placeholders', () => {
  const params = {
    clientName: 'Asha', name: 'Asha', service: 'Dental cleaning',
    slotStart: '2026-03-02 10:00', slot: '2026-03-02 10:00',
    clinicName: 'Bright Smile', clinic: 'Bright Smile',
    daysSinceVisit: 42, amount: 1200, event: 'new_booking', detail: 'Asha booked 10:00',
  };
  for (const key of Object.keys(templates.TEMPLATES)) {
    const out = templates.render(key, params);
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0, `${key} rendered empty`);
    assert.doesNotMatch(out, /\{\{|\}\}/, `${key} left an unresolved placeholder`);
  }
});

test('unknown template names throw', () => {
  assert.throws(() => templates.render('nope_not_a_template', {}), /unknown template/i);
});

test('CSV import dedupes by normalized phone in-file and against the DB', () => {
  const store = new Map();
  const stub = {
    findClientByPhone: (p) => store.get(p) || null,
    createClient: (row) => { store.set(row.phone, row); return row; },
  };
  const csv = [
    'name,phone,email,tags,notes',
    'Rita,919811111111,Rita@Example.COM,,',
    'Rita Again,+91 98111-11111,,,',
    'Sam,919822222222,,,',
    ',919833333333,,,',
  ].join('\n');

  const report = csvImport.parseCsvAndImport(csv, stub);
  assert.equal(report.imported, 2);
  assert.equal(report.skipped_duplicates, 1, 'in-file duplicate skipped');
  assert.equal(report.errors.length, 1, 'row without a name is reported');
  assert.equal(store.size, 2);

  const again = csvImport.parseCsvAndImport(csv, stub);
  assert.equal(again.imported, 0, 're-import adds nothing');
  assert.equal(again.skipped_duplicates, 3);
  assert.equal(store.size, 2);
});

test('client repository: unique phone, search, partial update', () => {
  const created = repo.clients.create({ name: 'Repo Probe', phone: '+91 90000 00004', email: 'Probe@Example.com' });
  assert.ok(created.id);
  assert.equal(created.phone, '+919000000004', 'phone stored normalized');
  assert.throws(() => repo.clients.create({ name: 'Dup', phone: '+919000000004' }), /UNIQUE/i);

  assert.ok(repo.clients.search('Probe').length >= 1);
  assert.equal(repo.clients.update(created.id, { notes: 'called once' }).notes, 'called once');
  assert.equal(repo.clients.update(created.id, { notes: 'called twice' }).name, 'Repo Probe',
    'partial update must not blank other columns');
});

test('config is hermetic: test env overrides the project .env', () => {
  const cfg = ctx.cfg;
  assert.equal(cfg.clinicHours.open, CLINIC_HOURS.open);
  assert.equal(cfg.clinicHours.close, CLINIC_HOURS.close);
  assert.equal(cfg.whatsapp.mockMode, true, 'tests must never hit the real WhatsApp API');
});