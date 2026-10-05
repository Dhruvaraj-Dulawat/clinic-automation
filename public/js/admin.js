// clinic-automation â€” admin dashboard UI (public/js/admin.js)
// Vanilla JS (no framework): session login via /api/admin/*, client
// search/edit/tag/notes/lifecycle via /api/clients, CSV import via
// POST /api/import/csv { csv }, CSV export via GET /api/admin/export.csv.
// Tabs (Clients/Import/Reports) toggle the matching tab-panel divs.
//
// CSRF: the admin APIs are session-cookie authenticated, so every mutating
// request must echo the token served by GET /csrf (double-submit). Fetch it
// once per page load and attach it as x-csrf-token on unsafe methods; the
// server compares it in constant time and rejects requests without it.
//
// --- DOM SAFETY --------------------------------------------------------------
// Server-supplied values (name, phone, tags, notes) reach the page through
// textContent ONLY, and the client table is assembled from createElement +
// textContent alone: this file contains NO innerHTML assignment and builds no
// HTML string, so markup inside a name, phone or tag cannot become part of the
// document. That is the structural form of the D8 fix -- do not reintroduce an
// innerHTML write here, and do not "simplify" a row back into a template string.
//
// --- D4 lifecycle UI ---------------------------------------------------------
// "Delete" is gone. A client is DEACTIVATED (active=0) so the appointment and
// intake history survives the RESTRICT foreign key. The server answers 409 when
// the client still has an upcoming booked/confirmed appointment; that message is
// surfaced verbatim (readable English from the API) instead of a raw error.
// Inactive rows are dimmed and badged so they are visually distinct but still
// listed â€” they are history, not noise. Restore reverses a deactivation;
// Anonymize performs a retention scrub (irreversible, hence its own confirm).
'use strict';

// Token cache â€” fetched lazily, refreshed if the server ever rotates it.
let csrfToken = null;

async function getCsrfToken() {
  if (csrfToken) return csrfToken;
  try {
    const res = await fetch('/csrf', { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (data && data.csrfToken) csrfToken = data.csrfToken;
  } catch (_) {
    /* offline or pre-session: the server will reject the write, which is safe */
  }
  return csrfToken;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Build an Error that also carries the status and the parsed body, so a handler
// that needs a server-authored sentence (e.g. the 409 "client still has an
// appointment") can show it instead of the bare error code. `message` keeps its
// previous value so the login/import handlers are unaffected.
function apiError(status, data) {
  const body = data || {};
  const err = new Error(body.error || ('HTTP ' + status));
  err.status = status;
  err.payload = body;
  return err;
}

// The server ROTATES the CSRF token on login and logout (routes/admin.js), so a
// cached token can be stale. On a csrf_* 403 drop the cache and retry once with
// a fresh token instead of stranding the admin with a dead session.
async function api(path, opts) {
  const options = opts || {};
  const method = String(options.method || 'GET').toUpperCase();
  const first = await rawApi(path, options, method);
  if (first.ok) return first.data;
  if (first.status === 403 && /csrf_(invalid|token_missing)/.test(String(first.data.error || '')) && !SAFE_METHODS.has(method)) {
    csrfToken = null;
    const retry = await rawApi(path, options, method);
    if (retry.ok) return retry.data;
    throw apiError(retry.status, retry.data);
  }
  throw apiError(first.status, first.data);
}

async function rawApi(path, options, method) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  if (!SAFE_METHODS.has(method)) {
    const token = await getCsrfToken();
    if (token) headers['x-csrf-token'] = token;
  }
  const res = await fetch(path, Object.assign({}, options, {
    method,
    headers,
    credentials: 'same-origin',
  }));
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// -- Status line -------------------------------------------------------------
// One reusable element above the client table. textContent only.
function notify(message, isError) {
  const table = document.getElementById('clients-table');
  let el = document.getElementById('admin-notice');
  if (!el) {
    el = document.createElement('div');
    el.id = 'admin-notice';
    el.className = 'small';
    const wrap = table && table.parentNode;
    if (wrap) wrap.parentNode.insertBefore(el, wrap);
    else document.body.appendChild(el);
  }
  el.classList.remove('muted', 'field-error');
  el.classList.add(isError ? 'field-error' : 'muted');
  el.textContent = message;
  el.hidden = false;
}

function clearNotice() {
  const el = document.getElementById('admin-notice');
  if (el) el.hidden = true;
}

// Turn an internal error code into something an operator can read. Used only as
// a LAST resort, when the server sent no sentence of its own -- printing
// `client_has_upcoming_appointment` at an admin is a bug, not a message.
function humanize(code) {
  if (typeof code !== 'string' || !code.trim()) return 'The request failed.';
  const words = code.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1) + '.';
}

// One sentence explaining why a lifecycle action failed.
//
// routes/clients.js usually sends a human `message`, and when it does we show it
// verbatim -- it is the server's own wording and stays correct as it evolves.
// But that field must not be load-bearing: if it is missing (an older build, a
// proxy in between, or the 409 body reduced to `error` + `appointment`) we build
// the sentence from the STRUCTURED fields instead, so the operator still learns
// which appointment is in the way instead of reading an error code.
function describeLifecycleError(err, client) {
  const payload = (err && err.payload) || {};
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message;

  const status = err && err.status;
  const who = client && client.name ? client.name : 'This client';
  const appointment = payload.appointment || {};

  if (status === 409 && (appointment.slot_start || appointment.status)) {
    const what = appointment.status || 'upcoming';
    const when = appointment.slot_start ? ' on ' + appointment.slot_start : '';
    return who + ' still has a ' + what + ' appointment' + when + '. '
      + 'Cancel or complete it first, or anonymize ' + (client && client.name ? 'them' : 'the client')
      + ' instead.';
  }
  if (status === 404) return 'That client is no longer in the list.';
  if (status === 501) {
    // clients.js answers 501 when a repository accessor it needs is not
    // implemented yet, and explains which one in `message`; this covers the
    // case where only the code survived.
    return 'Not available yet: ' + humanize(payload.missing || payload.error).replace(/\.$/, '') + '.';
  }
  if (status === 401 || status === 403) return 'Your session has expired. Sign in again and retry.';
  return humanize(payload.error || (err && err.message) || ('HTTP ' + status));
}

document.addEventListener('DOMContentLoaded', () => {
  const loginCard = document.getElementById('login-card');
  const dashboard = document.getElementById('dashboard');
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');

  // -- Tabs ---------------------------------------------------------------
  document.querySelectorAll('.tab[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
      for (const name of ['clients', 'import', 'reports']) {
        document.getElementById('tab-' + name).hidden = name !== btn.dataset.tab;
      }
    });
  });

  // -- Client table --------------------------------------------------------
  function actionButton(label, className, handler) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = label; // static label, never server text
    btn.onclick = handler;
    return btn;
  }

  // A state marker ("inactive", "anonymized") for a row. textContent, so a
  // label can never be markup; the leading space separates it from the tags.
  function badge(label) {
    const el = document.createElement('span');
    el.className = 'small muted';
    el.textContent = ' ' + label;
    return el;
  }

  async function refresh(q) {
    // Server accepts ?search= (canonical) and ?q= (alias).
    const data = await api('/api/clients' + (q ? ('?search=' + encodeURIComponent(q)) : ''));
    // A non-conforming body must not blank the tab with a TypeError.
    if (!data || !Array.isArray(data.clients)) throw new Error('The client list came back in an unexpected shape.');
    const tbody = document.querySelector('#clients-table tbody');
    tbody.replaceChildren();
    for (const c of data.clients) {
// `active` arrived with migration 002; a pre-migration row has no such
// column, and an absent flag means "active" (see routes/clients.js withActive).
//
// NOTE: this must NOT be `!!c.active`. SQLite can hand back the string "0"
// for a boolean-ish column, and `!!'0'` is TRUE â€” which would render a
// deactivated client as active. Every falsy spelling is normalised here.
const isActive = (c) => {
  const flag = c ? c.active : undefined;
  if (flag === undefined || flag === null) return true; // absent column
  if (typeof flag === 'string') {
    const v = flag.trim().toLowerCase();
    if (v === '' || v === '0' || v === 'false') return false;
    return true;
  }
  return flag !== false && flag !== 0;
};

      const isAnonymized = !!c.anonymized;
      const who = c.name == null || c.name === '' ? 'this client' : String(c.name);
      const active = isActive(c);

      const tr = document.createElement('tr');
      if (!active) tr.style.opacity = '0.55'; // dimmed: history, not noise

      const name = document.createElement('td');
      name.textContent = who;
      const phone = document.createElement('td');
      phone.textContent = c.phone == null ? '' : String(c.phone);
      const tags = document.createElement('td');
      tags.textContent = c.tags || '';
      if (!active) tags.appendChild(badge('inactive'));
      if (isAnonymized) tags.appendChild(badge('anonymized'));
      const actions = document.createElement('td');

      // Edit tags button.
      actions.appendChild(actionButton('Edit tags', 'btn btn-secondary btn-small', async () => {
        const next = prompt('Tags (comma-separated):', c.tags || '');
        if (next === null) return;
        try {
          await api('/api/clients/' + c.id, { method: 'PATCH', body: JSON.stringify({ tags: next }) });
        } catch (err) {
          notify(describeLifecycleError(err, c), true);
          return;
        }
        refreshAndReport();
      }));
      actions.appendChild(document.createTextNode(' '));

      // Edit notes button.
      actions.appendChild(actionButton('Notes', 'btn btn-secondary btn-small', async () => {
        const text = prompt('Notes for ' + who + ':', c.notes || '');
        if (text === null) return;
        try {
          await api('/api/clients/' + c.id, { method: 'PATCH', body: JSON.stringify({ notes: text }) });
        } catch (err) {
          notify(describeLifecycleError(err, c), true);
          return;
        }
        refreshAndReport();
      }));
      actions.appendChild(document.createTextNode(' '));

      // Deactivate. DELETE is the HTTP verb; what it DOES is reversible.
      if (active) {
        actions.appendChild(actionButton('Deactivate', 'btn btn-secondary btn-small', async () => {
          const ok = confirm(
            'Deactivate ' + who + (c.phone ? ' (' + c.phone + ')' : '') + '?\n\n'
            + 'Their appointments, receipts and intake history are all kept.\n'
            + 'You can Restore them at any time from this list.'
          );
          if (!ok) return;
          try {
            await api('/api/clients/' + c.id, { method: 'DELETE' });
          } catch (err) {
            // 409 = an upcoming booked/confirmed appointment is in the way.
            notify(describeLifecycleError(err, c), true);
            return;
          }
          notify('Deactivated ' + who + '. Their history is kept, and Restore is available here.', false);
          refreshAndReport();
        }));
        actions.appendChild(document.createTextNode(' '));
      }

      // Undo a deactivation.
      if (!active) {
        actions.appendChild(actionButton('Restore', 'btn btn-secondary btn-small', async () => {
          try {
            await api('/api/clients/' + c.id + '/restore', { method: 'POST' });
          } catch (err) {
            notify(describeLifecycleError(err, c), true);
            return;
          }
          notify('Restored ' + who + '.', false);
          refreshAndReport();
        }));
        actions.appendChild(document.createTextNode(' '));
      }

      // Retention scrub -- irreversible, so it gets its own confirm.
      actions.appendChild(actionButton('Anonymize', 'btn btn-danger btn-small', async () => {
        const ok = confirm(
          'Anonymize ' + who + (c.phone ? ' (' + c.phone + ')' : '') + '?\n\n'
          + 'Name, phone, email, notes and tags will be permanently erased.\n'
          + 'The record itself is kept so receipts and reports stay auditable.\n'
          + 'This cannot be undone.'
        );
        if (!ok) return;
        try {
          await api('/api/clients/' + c.id + '/anonymize', { method: 'POST' });
        } catch (err) {
          notify(describeLifecycleError(err, c), true);
          return;
        }
        notify('Anonymized ' + who + '.', false);
        refreshAndReport();
      }));

      tr.appendChild(name);
      tr.appendChild(phone);
      tr.appendChild(tags);
      tr.appendChild(actions);
      tbody.appendChild(tr);
    }
  }

  // Re-read the list after a mutation. A failure here must land in the notice,
  // never as an unhandled rejection escaping a click handler.
  function refreshAndReport(q) {
    const query = q === undefined ? document.getElementById('q').value : q;
    refresh(query).catch((err) => notify(err.message, true));
  }

  // -- Session ---------------------------------------------------------------
  async function checkMe() {
    try {
      await api('/api/admin/me');
      loginCard.hidden = true;
      dashboard.hidden = false;
      refreshAndReport('');
    } catch (e) {
      loginCard.hidden = false;
      dashboard.hidden = true;
    }
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.hidden = true;
    const fd = new FormData(loginForm);
    try {
      await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }) });
      checkMe();
    } catch (err) {
      loginError.textContent = err.message;
      loginError.hidden = false;
    }
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
    location.reload();
  });

  document.getElementById('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    clearNotice();
    refreshAndReport(document.getElementById('q').value);
  });

  // -- CSV import (dedupe by phone, report shown inline) ----------------------
  document.getElementById('import-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const csv = document.getElementById('csv').value;
    try {
      const { report } = await api('/api/import/csv', { method: 'POST', body: JSON.stringify({ csv }) });
      document.getElementById('import-result').textContent = JSON.stringify(report, null, 2);
      refreshAndReport('');
    } catch (err) {
      document.getElementById('import-result').textContent = 'Error: ' + err.message;
    }
  });

  checkMe();
});