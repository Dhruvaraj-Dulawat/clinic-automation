// ============================================================================
// clinic-automation — CSRF enforcement tests (tests/csrf.test.js)
// Verifies the double-submit guard on the session-authenticated admin surfaces:
//   * unsafe methods are rejected WITHOUT the token (and without a session);
//   * they succeed WITH the token from GET /csrf;
//   * safe methods never need a token;
//   * the webhook path stays exempt (Meta cannot send a custom header).
// Runs with CSRF_ENFORCE=true so the guard is actually armed.
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupTemp, startServer, createHttpClient } = require('./helpers');

freshDb({ env: { CSRF_ENFORCE: 'true' } });
let server;

test.before(async () => { server = await startServer(); });
test.after(async () => { if (server) await server.close(); cleanupTemp(); });

async function tokenFor(client) {
  const res = await client.get('/csrf');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.csrfToken, 'a CSRF token is issued');
  return res.body.csrfToken;
}

test('a mutation without a CSRF token is refused, with one it succeeds', async () => {
  const client = createHttpClient(server.baseUrl);
  await client.login();
  const token = await tokenFor(client);

  const noToken = await client.post('/api/clients', { name: 'CSRF Probe', phone: '+919000007777' }, { csrf: false });
  assert.equal(noToken.status, 403, 'a cookie-authenticated write without a token must be blocked');
  assert.match(noToken.body.error, /csrf/i);

  const withToken = await client.post(
    '/api/clients',
    { name: 'CSRF Probe', phone: '+919000007777' },
    { headers: { 'x-csrf-token': token } }
  );
  assert.equal(withToken.status, 201, JSON.stringify(withToken.body));
});

test('a forged or truncated token is refused', async () => {
  const client = createHttpClient(server.baseUrl);
  await client.login();
  const token = await tokenFor(client);

  for (const bad of ['', 'x', `${token}x`, token.slice(0, -1), 'f'.repeat(64)]) {
    const res = await client.post(
      '/api/clients',
      { name: 'Forged', phone: '+919000007778' },
      { headers: { 'x-csrf-token': bad } }
    );
    assert.equal(res.status, 403, `token "${String(bad).slice(0, 8)}" must be refused`);
  }
});

test('safe methods never require a token', async () => {
  const client = createHttpClient(server.baseUrl);
  await client.login();
  assert.equal((await client.get('/api/clients')).status, 200);
  assert.equal((await client.get('/api/reports/daily')).status, 200);
});

test('an unauthenticated write is still rejected even with a token', async () => {
  const client = createHttpClient(server.baseUrl);
  const token = await tokenFor(client);
  const res = await client.post(
    '/api/clients',
    { name: 'No Session', phone: '+919000007779' },
    { headers: { 'x-csrf-token': token } }
  );
  assert.equal(res.status, 401, 'CSRF is not a substitute for authentication');
});

test('the WhatsApp webhook path is exempt from the CSRF guard', async () => {
  const client = createHttpClient(server.baseUrl);
  // No token, no session — Meta's inbound POST must still be processed.
  const res = await client.post('/webhook', {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages: [{ from: '919000008888', text: { body: 'HELLO' } }] } }] }],
  });
  assert.equal(res.status, 200, 'the webhook must not require a CSRF token');
});

test('public booking endpoints are not CSRF-gated (no ambient credential)', async () => {
  const anon = createHttpClient(server.baseUrl);
  const res = await anon.post('/api/bookings/book', {
    name: 'No Token', phone: '+919000007780', slotStart: 'not-a-slot',
  });
  assert.notEqual(res.status, 403, 'a public booking must fail validation, not CSRF');
  assert.equal(res.status, 400);
});