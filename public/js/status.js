// ============================================================================
// clinic-automation — status lookup UI (public/js/status.js)
// Talks to: GET /api/status?phone=&last4=. Loaded by public/status.html.
// ============================================================================
'use strict';

const $ = (sel) => document.querySelector(sel);

function flash(msg, kind = 'info') {
  const box = $('#flash');
  box.innerHTML = '';
  const div = document.createElement('div');
  div.className = `flash flash-${kind}`;
  div.textContent = msg;
  box.appendChild(div);
}

document.addEventListener('DOMContentLoaded', () => {
  $('#status-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const q = new URLSearchParams({ phone: fd.get('phone'), last4: fd.get('last4') });
    try {
      const res = await fetch(`/api/status?${q}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `lookup failed (${res.status})`);
      $('#result-card').hidden = false;
      $('#result-title').textContent = `Appointments for ${data.client.name}`;
      const body = $('#result-body');
      body.innerHTML = '';
      if (!data.appointments.length) {
        body.innerHTML = '<tr><td colspan="3" class="muted">No appointments yet.</td></tr>';
        return;
      }
      for (const a of data.appointments) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td></td><td></td><td><span class="status"></span></td>';
        tr.children[0].textContent = a.slot_start;
        tr.children[1].textContent = a.service;
        const badge = tr.querySelector('.status');
        badge.textContent = a.status;
        badge.classList.add(`status-${a.status}`);
        body.appendChild(tr);
      }
    } catch (err) {
      $('#result-card').hidden = true;
      flash(err.message, 'error');
    }
  });
});
