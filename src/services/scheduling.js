// ============================================================================
// clinic-automation — slot computation + no-double-book guard
//   (src/services/scheduling.js)
// buildSlots: pure function turning clinic-hours config + a date into the
//   day's slot grid (no DB). bookSlot: transactional INSERT guarded by
//   UNIQUE(appointments.slot_start) — concurrent bookings for the same slot
//   collapse into exactly one row + one SLOT_TAKEN error (see repository.js).
// Slot datetimes are local-time "YYYY-MM-DD HH:mm" strings; comparisons stay
// lexicographic so SQLite ordering works without date functions.
// Deps: ../db/repository.js (bookSlot only), ../config.js shape (clinicHours).
// ============================================================================
'use strict';

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmtSlot(dateStr, hour, minute) {
  return `${dateStr} ${pad(hour)}:${pad(minute)}`;
}

function addMinutes(hour, minute, delta) {
  const total = hour * 60 + minute + delta;
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

function parseHM(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return { hour: h || 0, minute: m || 0 };
}

// Clinic-hours snapshot: canonical shape from src/config.js getConfig().
// Falls back to safe defaults when config is unavailable (unit/smoke boots).
function getHours() {
  try {
    return require('../config').getConfig().clinicHours;
  } catch (_) {
    return { days: [1, 2, 3, 4, 5, 6], open: '09:00', close: '19:00', slotMinutes: 30, maxAdvanceDays: 30 };
  }
}

// Canonical "HH:mm" formatter (parseTime is its inverse).
function fmtTime(hour, minute) {
  return `${pad(hour)}:${pad(minute)}`;
}

// Canonical names (M3 contract): computeSlots(dateStr[, cfg]) aliases the
// pure grid builder; cfg defaults to getHours() when omitted.
function computeSlots(dateStr, cfg) {
  return buildSlots(dateStr, cfg || getHours());
}

// True when the clinic sees patients on dateStr (non-empty grid).
function isOpen(dateStr, cfg) {
  return computeSlots(dateStr, cfg).length > 0;
}
// cfg: { days:[1..6], open:'09:00', close:'19:00', slotMinutes:30 }.
// Returns [] when the date falls on a closed weekday.
function buildSlots(dateStr, cfg) {
  const day = new Date(`${dateStr}T12:00:00`).getDay();
  if (!cfg.days.includes(day)) return [];
  const open = parseHM(cfg.open);
  const close = parseHM(cfg.close);
  const slots = [];
  let cur = { ...open };
  while (cur.hour * 60 + cur.minute + cfg.slotMinutes <= close.hour * 60 + close.minute) {
    const start = fmtSlot(dateStr, cur.hour, cur.minute);
    const end = addMinutes(cur.hour, cur.minute, cfg.slotMinutes);
    slots.push({ start, end: fmtSlot(dateStr, end.hour, end.minute) });
    cur = end;
  }
  return slots;
}

// Guarded booking: delegates to the repository transaction. SLOT_TAKEN is
// thrown on UNIQUE(slot_start) violation so routes map it to HTTP 409.
function bookSlot(repo, { clientId, slotStart, slotEnd, service }) {
  const book = (repo.appointments && repo.appointments.book)
    ? (o) => repo.appointments.book(o)
    : (o) => repo.createAppointment(o);
  try {
    return book({ clientId, slotStart, slotEnd, service });
  } catch (e) {
    if (e && (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE/i.test(e.message || ''))) {
      const err = new Error('slot taken');
      err.code = 'SLOT_TAKEN';
      throw err;
    }
    throw e;
  }
}

// Availability = full grid minus already-booked slots for that date.
function getAvailability(repo, dateStr, cfg) {
  const grid = buildSlots(dateStr, cfg);
  const list = (repo.appointments && repo.appointments.listByRange)
    ? repo.appointments.listByRange(`${dateStr} 00:00`, `${dateStr} 23:59`)
    : repo.listAppointments({ from: `${dateStr} 00:00`, to: `${dateStr} 23:59`, limit: 500 });
  const booked = new Set(
    list
      .filter((a) => a.status !== 'cancelled')
      .map((a) => a.slot_start)
  );
  return grid.map((s) => ({ ...s, available: !booked.has(s.start) }));
}

module.exports = {
  buildSlots, computeSlots, isOpen, bookSlot, getAvailability,
  parseHM, parseTime: parseHM, fmtSlot, fmtTime, getHours,
};
