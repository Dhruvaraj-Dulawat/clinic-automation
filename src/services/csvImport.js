// ============================================================================
// clinic-automation — CSV import: parse + normalize + dedupe-by-phone
//   (src/services/csvImport.js)
// Purpose: bulk-load client lists. Phone is the dedupe key: rows whose
//   normalized phone already exists — in the DB or earlier in the same file —
//   are SKIPPED and counted, never duplicated.
// Normalization: name trimmed; email trimmed + lowercased; phone via the
//   repository's normalizePhone (single source of truth: strip non-digits,
//   prepend '+', e.g. "919876543210" -> "+919876543210"). Assumes the CSV
//   already carries country code ("E.164-ish").
// Deps: csv-parse/sync, ../db/repository.js (clients.findByPhone/create).
// CSV columns: name,phone,email,tags,notes (header row required).
// Report shape: { imported, skipped_duplicates, errors[] } (+ `skipped` /
//   `duplicates` aliases kept for older M2 drafts).
// ============================================================================
'use strict';

const { parse } = require('csv-parse/sync');
const { clients, normalizePhone } = require('../db/repository');

function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

// Parse raw CSV text into row objects. Throws on malformed CSV — callers map
// that to a 400/500 + { error } (see src/routes/import.js).
function parseCsv(csvText) {
  // relax_column_count: real-world CSVs have ragged trailing empties —
  // treat missing columns as '' instead of throwing.
  return parse(String(csvText || ''), { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });
}

function parseCsvAndImport(csvText, repo) {
  // `repo` adapter: accept either the full repository ({ clients }) or a
  // minimal { findClientByPhone, createClient } stub (isolated tests).
  const findByPhone = (repo && repo.findClientByPhone)
    || ((phone) => clients.findByPhone(phone));
  const createClient = (repo && repo.createClient)
    || ((row) => clients.create(row));
  const report = { imported: 0, skipped_duplicates: 0, skipped: 0, duplicates: [], errors: [] };
  let records;
  try {
    records = parseCsv(csvText);
  } catch (err) {
    report.errors.push(`CSV parse error: ${err.message}`);
    return report;
  }
  const seenInFile = new Set();
  records.forEach((row, idx) => {
    const line = idx + 2; // + header row
    try {
      const name = String(row.name || '').trim();
      const phone = normalizePhone(row.phone);
      const email = normalizeEmail(row.email);
      const tags = String(row.tags || '').trim();
      const notes = String(row.notes || '').trim();
      if (!name) {
        report.errors.push(`line ${line}: missing name`);
        return;
      }
      if (!phone || phone === '+') {
        report.errors.push(`line ${line}: missing/invalid phone`);
        return;
      }
      // Dedupe within the file first (cheap), then against the DB.
      if (seenInFile.has(phone)) {
        report.skipped_duplicates += 1;
        report.skipped += 1;
        report.duplicates.push(phone);
        return;
      }
      seenInFile.add(phone);
      if (findByPhone(phone)) {
        report.skipped_duplicates += 1;
        report.skipped += 1;
        report.duplicates.push(phone);
        return;
      }
      createClient({ name, phone, email, tags, notes });
      report.imported += 1;
    } catch (err) {
      // UNIQUE race (concurrent import) counts as a duplicate, not a failure.
      if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        report.skipped_duplicates += 1;
        report.skipped += 1;
      } else {
        report.errors.push(`line ${line}: ${err.message}`);
      }
    }
  });
  return report;
}

// Convenience wrapper used by src/routes/import.js (uses the real DB).
function importCsv(csvText) {
  return parseCsvAndImport(csvText, null);
}

module.exports = { normalizePhone, parseCsv, parseCsvAndImport, importCsv };
