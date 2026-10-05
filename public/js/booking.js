// ============================================================================
// clinic-automation — booking + intake page logic (public/js/booking.js)
// Flow: pick date → fetch availability → pick slot → POST booking → if an
// appointment id comes back, load intake questions and submit answers for it.
// Talks to: /api/bookings/*, /api/intake/*. Loaded by public/booking.html.
// ============================================================================
'use strict';

const $ = (sel) => document.querySelector(sel);
let bookedAppointmentId = null;
// D11: proof of ownership for POST /api/intake/:id — the phone used to book.
let bookedPhone = null;

function flash(msg, kind = 'info') {
  const box = $('#flash');
  box.innerHTML = '';
  const div = document.createElement('div');
  div.className = `flash flash-${kind}`;
  div.textContent = msg;
  box.appendChild(div);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Keep server-side validation details (e.g. intake { details: [...] })
    // on the Error so callers can render them.
    const err = new Error(data.error || `request failed (${res.status})`);
    err.data = data;
    throw err;
  }
  return data;
}

async function loadSlots() {
  const date = $('#date-input').value;
  const sel = $('#slot-select');
  sel.innerHTML = '<option value="">Loading…</option>';
  if (!date) {
    sel.innerHTML = '<option value="">Pick a date first</option>';
    return;
  }
  try {
    const { slots } = await api(`/api/bookings/availability?date=${encodeURIComponent(date)}`);
    sel.innerHTML = '';
    const open = slots.filter((s) => s.available);
    if (!open.length) {
      sel.innerHTML = '<option value="">No slots that day</option>';
      return;
    }
    for (const s of slots) {
      const opt = document.createElement('option');
      opt.value = s.start;
      opt.textContent = `${s.start.slice(11)}${s.available ? '' : ' (taken)'}`;
      opt.disabled = !s.available;
      sel.appendChild(opt);
    }
  } catch (e) {
    sel.innerHTML = '<option value="">Could not load slots</option>';
    flash(e.message, 'error');
  }
}

function renderQuestions(questions) {
  const wrap = $('#intake-fields');
  wrap.innerHTML = '';
  for (const q of questions) {
    if (q.id.startsWith('_')) continue;
    const label = document.createElement('label');
    label.textContent = q.label + (q.required ? ' *' : '');
    let input;
    if (q.type === 'select' && q.options) {
      input = document.createElement('select');
      input.name = q.id;
      if (!q.required) {
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = '—';
        input.appendChild(blank);
      }
      for (const o of q.options) {
        const opt = document.createElement('option');
        opt.value = o;
        opt.textContent = o;
        input.appendChild(opt);
      }
    } else if (q.type === 'textarea') {
      input = document.createElement('textarea');
      input.name = q.id;
      input.placeholder = q.placeholder || '';
    } else if (q.type === 'checkbox') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.name = q.id;
    } else {
      input = document.createElement('input');
      input.name = q.id;
      input.placeholder = q.placeholder || '';
      if (q.required) input.required = true;
    }
    if (q.required && q.type !== 'checkbox') input.required = true;
    label.appendChild(input);
    wrap.appendChild(label);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('#date-input').addEventListener('change', loadSlots);

  $('#booking-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const { appointment } = await api('/api/bookings/book', {
        method: 'POST',
        body: JSON.stringify({
          name: fd.get('name'),
          phone: fd.get('phone'),
          date: fd.get('date'),
          slotStart: fd.get('slotStart'),
          service: fd.get('service'),
        }),
      });
      bookedAppointmentId = appointment.id;
      // D11: the intake endpoint is not anonymous - it needs proof that the
      // caller owns this appointment. The phone they just booked with IS that
      // proof, so retain it and replay it on the intake submit below.
      bookedPhone = fd.get('phone');
      $('#intake-card').hidden = false;
      $('#intake-note').textContent = `Booked for ${appointment.slot_start}. A few details for the doctor:`;
      const { questions } = await api('/api/intake/questions');
      renderQuestions(questions);
      flash('Appointment booked! Please complete the intake below.', 'success');
      loadSlots();
    } catch (err) {
      flash(err.message, 'error');
    }
  });

  $('#intake-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const answers = {};
    for (const [k, v] of fd.entries()) answers[k] = v;
    // Unchecked checkboxes never appear in FormData — default them to false.
    e.target.querySelectorAll('input[type="checkbox"]').forEach((c) => {
      answers[c.name] = c.checked;
    });
    try {
      await api(`/api/intake/${bookedAppointmentId}`, { method: 'POST', body: JSON.stringify({ answers, phone: bookedPhone }) });
      flash('Intake submitted. See you soon!', 'success');
      $('#intake-card').hidden = true;
    } catch (err) {
      const data = err.data || {};
      flash((data.details ? data.details.join('; ') : err.message) || err.message, 'error');
    }
  });
});
