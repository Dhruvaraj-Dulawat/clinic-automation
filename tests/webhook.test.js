// ============================================================================
// clinic-automation — WhatsApp webhook + message-log tests (tests/webhook.test.js)
// Covers the Meta verification handshake, the two-way CONFIRM / CANCEL /
// RESCHEDULE intents, and the guarantee that every outbound message is
// persisted with a terminal status.
//
// The intents are exercised across ALL THREE shapes parseInbound accepts, so no
// arm of its `||` chain is left untested:
//   typed text              message.text.body
//   modern quick-reply      interactive.button_reply.{id,title}
//   legacy quick-reply      button.{payload,text}   (deprecated, still shipped)
// Runs in WHATSAPP_MOCK_MODE so nothing leaves the machine.
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupTemp, startServer, nextOpenDate, VERIFY_TOKEN } = require('./helpers');

const ctx = freshDb();
let server;
let client;

test.before(async () => { server = await startServer(); client = server.client; });
test.after(async () => { if (server) await server.close(); cleanupTemp(); });

// Book one appointment per test, always on a slot no other test has taken.
const taken = new Set();
async function bookFor(phone, name) {
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

// Meta Cloud API inbound text payload.
function inboundText(from, text) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages: [{ from, text: { body: text } }] } }] }],
  };
}

// Meta Cloud API inbound LEGACY button payload.
//
// `button` is a SIBLING of `interactive` inside the message (not a child of it),
// which is what distinguishes it from the modern shape handled at
// `interactive.button_reply` — see webhook.js parseInbound L70-79.
//
// This shape is DEPRECATED by Meta but still arrives in production from older
// WhatsApp Business app builds, so the branch is intentionally still supported.
// Do NOT "clean it up": patients tapping a quick reply from an old client would
// silently get the generic "Sorry, I understood CONFIRM, CANCEL, or ..." reply
// and their appointment would never change state.
//
// Only `payload` is set here (no `text`) — and in the second test below only
// `text` (no `payload`). That asymmetry is deliberate: parseInbound reads them in
// an `||` chain with `legacyButton.payload` FIRST, so a payload in both would
// pass through the payload branch and the `button.text` test would prove nothing.
function inboundLegacyButton(from, fields) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages: [{ from, button: fields }] } }] }],
  };
}

function appointmentStatus(id) {
  return require('../src/db/repository').appointments.findById(id).status;
}

test('verification handshake echoes the challenge only for the right token', async () => {
  const ok = await client.get(
    `/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=CHAL_123`
  );
  assert.equal(ok.status, 200);
  assert.equal(String(ok.text).trim(), 'CHAL_123');

  assert.equal((await client.get('/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=CHAL_123')).status, 403);
  assert.equal((await client.get(`/webhook?hub.mode=unsubscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=X`)).status, 403);
});

test('inbound CANCEL cancels the appointment', async () => {
  const appointment = await bookFor('+919000009001', 'Cancel Me');
  assert.equal(appointment.status, 'booked');

  const res = await client.post('/webhook', inboundText('919000009001', 'CANCEL'));
  assert.equal(res.status, 200);
  assert.equal(appointmentStatus(appointment.id), 'cancelled');
});

test('inbound CONFIRM confirms the appointment', async () => {
  const appointment = await bookFor('+919000009002', 'Confirm Me');
  const res = await client.post('/webhook', inboundText('919000009002', 'CONFIRM'));
  assert.equal(res.status, 200);
  assert.equal(appointmentStatus(appointment.id), 'confirmed');
});

test('inbound RESCHEDULE moves the appointment to a free slot', async () => {
  const appointment = await bookFor('+919000009003', 'Move Me');
  const date = nextOpenDate(1);
  const avail = await client.get(`/api/bookings/availability?date=${date}`);
  const target = avail.body.slots.find((s) => s.available && !taken.has(s.start) && s.start !== appointment.slot_start);
  assert.ok(target, 'a second free slot is required');

  const res = await client.post('/webhook', inboundText('919000009003', `RESCHEDULE ${target.start}`));
  assert.equal(res.status, 200);

  const repo = require('../src/db/repository');
  assert.ok(repo.appointments.findByPhone('+919000009003').some((a) => a.slot_start === target.start),
    'appointment now sits on the requested slot');
  assert.equal(appointmentStatus(appointment.id), 'cancelled', 'the original row is cancelled, not deleted');
});

test('unknown inbound text is answered without changing anything', async () => {
  const appointment = await bookFor('+919000009004', 'Confused Client');
  const res = await client.post('/webhook', inboundText('919000009004', 'hello there'));
  assert.equal(res.status, 200);
  assert.equal(appointmentStatus(appointment.id), 'booked');
});

// MODERN quick-reply shape: interactive.button_reply.{id,title}.
// Named explicitly because this used to be called "quick-reply button payloads"
// and was mistaken for coverage of the legacy `button` shape below — it is not;
// it exercises the interactive branch of parseInbound only.
test('interactive.button_reply (modern quick-reply) taps drive the same intents', async () => {
  const appointment = await bookFor('+919000009006', 'Button Client');
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages: [{ from: '919000009006', interactive: { button_reply: { id: 'CANCEL', title: 'Cancel' } } }] } }] }],
  };
  assert.equal((await client.post('/webhook', payload)).status, 200);
  assert.equal(appointmentStatus(appointment.id), 'cancelled');
});

// --- LEGACY quick-reply shape: msg.button.{payload,text} ---------------------
// webhook.js parseInbound reads `legacyButton.payload || legacyButton.text`, but
// nothing exercised either one: every button test above goes through
// `interactive.button_reply`. These two cover the branch.

test('legacy button.payload cancels the appointment (deprecated WhatsApp shape)', async () => {
  const appointment = await bookFor('+919000009007', 'Legacy Button Payload');
  assert.equal(appointment.status, 'booked');

  const res = await client.post('/webhook', inboundLegacyButton('919000009007', { payload: 'CANCEL' }));
  assert.equal(res.status, 200);
  // Real state assertion — the whole point is that the row actually changes.
  assert.equal(appointmentStatus(appointment.id), 'cancelled');
});

test('legacy button.text confirms the appointment (deprecated WhatsApp shape)', async () => {
  const appointment = await bookFor('+919000009008', 'Legacy Button Text');
  assert.equal(appointment.status, 'booked');

  // ONLY `text` here — no `payload`, so this can only pass via the
  // `legacyButton.text` arm of the parseInbound `||` chain.
  const res = await client.post('/webhook', inboundLegacyButton('919000009008', { text: 'CONFIRM' }));
  assert.equal(res.status, 200);
  assert.equal(appointmentStatus(appointment.id), 'confirmed');
});

test('every outbound message is logged with a status', () => {
  const rows = ctx.db.prepare('SELECT * FROM messages ORDER BY id').all();
  assert.ok(rows.length > 0, 'booking must log at least one outbound message');
  for (const row of rows) {
    assert.ok(row.status && String(row.status).length > 0, `message ${row.id} has no status`);
    assert.ok(row.body, `message ${row.id} has no body`);
    // Outbound rows carry the recipient; inbound rows carry the sender.
    const counterparty = row.direction === 'inbound' ? row.from_phone : row.to_phone;
    assert.ok(counterparty, `message ${row.id} (${row.direction}) has no counterparty`);
  }
  assert.ok(rows.some((r) => r.template === 'booking_confirm' && r.to_phone),
    'the booking confirmation was logged with its recipient');
});

test('an unknown WhatsApp sender is handled without crashing', async () => {
  const res = await client.post('/webhook', inboundText('919000000000', 'CANCEL'));
  assert.equal(res.status, 200);
});