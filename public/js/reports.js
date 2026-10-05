// ============================================================================
// clinic-automation — dashboard reporting cards + flags UI
//   (public/js/reports.js)
// Fetches /api/reports/* (admin session) and renders into the Reports tab:
// mounts into div#reports (the mount point reserved in public/admin.html;
// #reports-mount is accepted as an alias). Loaded via
// <script src="/js/reports.js"> in admin.html — safe when the admin is not
// logged in (renders a login hint instead of failing).
// Vanilla JS, no framework. Talks to: GET /api/reports/daily|flags|weekly.
//
// --- D8 (XSS) ---------------------------------------------------------------
// Every value that originates from the server is escaped with esc() BEFORE it
// is interpolated into an HTML string, and esc() covers the full set that can
// break out of an attribute or a text node: & < > " and ' (the single quote was
// missing before, which is what makes `onmouseover='...'` payloads and
// attribute-injection through single-quoted attributes possible).
// The three original holes were `weekly.total`, `daily.bookings` and the flag
// counts; the whole file is now audited, not just those three. Counts go
// through num(), which is stronger than escaping: it coerces to a finite number
// so a hostile or malformed payload can never render as markup at all.
//
// Only TWO innerHTML uses remain, both STATIC MARKUP with no interpolation:
//   * `mount.innerHTML = ''`  — clears the mount point
//   * `div.innerHTML = bodyHtml` — bodyHtml is assembled here from esc()/num()
//   Everything that touches server data uses textContent (card titles).
//
// --- D9/D10 (date) -----------------------------------------------------------
// The server defaults ?date= and ?weekStart= to new Date().toISOString() which
// is UTC. For a clinic in IST (UTC+5:30) that is the PREVIOUS calendar day for
// 5h30m every single morning, so "Today" silently showed yesterday's numbers.
// The client therefore always sends an explicit LOCAL date, computed from the
// browser's own calendar fields rather than from an ISO/UTC string.
// /weekly gets ?weekStart= as well, and NOT the same value: "This week" means
// the clinic week (Monday-based) everywhere else in this app, so it must be
// Monday. See localWeekStart() below and src/services/digest.js:36.
// ============================================================================
'use strict';

// Local 'YYYY-MM-DD' from the browser's own calendar fields. Deliberately NOT
// toISOString(): that converts to UTC and is a day behind for most of the day.
function localDateStr(d) {
  const date = d || new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Monday on or before `d` (getDay(): 0=Sun..6=Sat), mirroring
// src/services/datetime.js weekStart(). Duplicated rather than imported because
// this file is a plain browser script and datetime.js is CommonJS - keep the two
// in step.
// WHY THIS IS NOT JUST `today`: src/services/digest.js:36 (the weekly digest the
// owner receives on WhatsApp) calls getWeeklyAggregates(datetime.weekStart(...))
// and labels the result "This week", and this card is labelled "This week" too.
// Sending `today` would make the dashboard and the owner's own digest disagree
// about "this week" on 6 days out of 7.
function localWeekStart(d) {
  const c = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  c.setDate(c.getDate() - ((c.getDay() + 6) % 7));
  return localDateStr(c);
}

async function api(path) {
  const res = await fetch(path, { credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function card(title, bodyHtml) {
  const section = document.createElement('section');
  section.className = 'card mt';
  const h = document.createElement('h2');
  h.className = 'card-title';
  h.textContent = title;
  section.appendChild(h);
  const div = document.createElement('div');
  // bodyHtml is built exclusively from esc()/num() output — see the header.
  div.innerHTML = bodyHtml;
  section.appendChild(div);
  return section;
}

// The single escaping chokepoint for this file. `'` is included so the output is
// safe inside single-quoted attributes as well as double-quoted ones.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

// Counts and money-shaped values: coerce to a finite number so they can never
// carry markup. Anything unparseable renders as 0 rather than as raw text.
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '0';
}

// A list of flag rows, or a muted "empty" note. Every field of every row is
// escaped; `empty` is escaped too so a future caller passing server text is
// still safe.
const flagRows = (list, empty) => {
  const rows = Array.isArray(list) ? list : [];
  if (!rows.length) return `<p class="small muted">${esc(empty)}</p>`;
  const items = rows.slice(0, 10).map((a) => {
    const row = a || {};
    const name = row.client ? row.client.name : '?';
    const when = (row.status || row.lastVisit) || '';
    return `<li>${esc(name)} — ${esc(row.slot_start)} (${esc(row.service)} / ${esc(when)})</li>`;
  }).join('');
  return `<ul class="small">${items}</ul>`;
};

document.addEventListener('DOMContentLoaded', async () => {
  // admin.html mount point is div#reports; accept #reports-mount as alias.
  const mount = document.querySelector('#reports-mount') || document.querySelector('#reports');
  if (!mount) return;
  // The placeholder paragraph ("Reports land with M7.") is replaced on load.
  // Static markup, no interpolation.
  mount.innerHTML = '';
  try {
    // Always send an explicit LOCAL date (see the header) rather than letting
    // the server fall back to its UTC default.
    const today = localDateStr();
    const weekStart = localWeekStart(new Date());
    const [daily, flags, weekly] = await Promise.all([
      api(`/api/reports/daily?date=${encodeURIComponent(today)}`),
      api('/api/reports/flags'),
      api(`/api/reports/weekly?weekStart=${encodeURIComponent(weekStart)}`),
    ]);

    mount.appendChild(card('Today', `<p class="small">${esc(daily.date)}: <strong>${num(daily.bookings)}</strong> bookings, `
      + `${num(daily.noShows)} no-shows, revenue <strong>${num(daily.revenue)}</strong> `
      + `(${num(daily.newClients)} new / ${num(daily.returningClients)} returning) ${esc(JSON.stringify(daily.byStatus))}</p>`));

    mount.appendChild(card('This week', `<p class="small">${esc(weekly.weekStart)} → ${esc(weekly.weekEnd || '')}: `
      + `<strong>${num(weekly.total)}</strong> bookings, revenue <strong>${num(weekly.revenue)}</strong> ${esc(JSON.stringify(weekly.byStatus))}</p>`));

    const noResp = flags.noResponseAfterReminder || [];
    const overdue = flags.overdueNextVisit || [];
    mount.appendChild(card('Follow-up flags', `
      <h3 class="small">No response after reminder (${num(noResp.length)})</h3>${flagRows(noResp, 'None.')}
      <h3 class="small">Overdue next visit (${num(overdue.length)})</h3>${flagRows(overdue, 'None.')}
      <h3 class="small">No-show recalls (${num((flags.noShowRecall || []).length)})</h3>${flagRows(flags.noShowRecall || [], 'None.')}
      <h3 class="small">Unconfirmed in 48h (${num((flags.unconfirmedSoon || []).length)})</h3>${flagRows(flags.unconfirmedSoon || [], 'None.')}
      <h3 class="small">Completed without intake (${num((flags.missingIntake || []).length)})</h3>${flagRows(flags.missingIntake || [], 'None.')}`));
  } catch (e) {
    mount.appendChild(card('Reports', `<p class="small muted">Log in as admin to see reports. (${esc(e.message)})</p>`));
  }
});
