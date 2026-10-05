// ============================================================================
// clinic-automation — intake validation vs question config
//   (src/services/intake.js)
// validateIntake(answers): checks required flags + basic types for every
// question in src/config/intake-questions.json. Consent (checkbox, required)
// must be exactly true. Returns { ok, errors[] }.
// Deps: ../config/intake-questions.json (read once, cached).
// ============================================================================
'use strict';

let cachedQuestions = null;

function getQuestions() {
  if (!cachedQuestions) {
    cachedQuestions = require('../config/intake-questions.json');
  }
  return cachedQuestions;
}

function validateIntake(answers) {
  const errors = [];
  const given = answers && typeof answers === 'object' ? answers : {};
  for (const q of getQuestions()) {
    if (q.id.startsWith('_')) continue;
    const value = given[q.id];
    const empty = value === undefined || value === null || value === '' || value === false;
    if (q.required && empty) {
      errors.push(`${q.label || q.id} is required`);
      continue;
    }
    if (empty) continue;
    if (q.type === 'checkbox' && q.required && value !== true) {
      errors.push(`${q.label || q.id} must be accepted`);
    }
    if (q.type === 'select' && q.options && !q.options.includes(value)) {
      errors.push(`${q.label || q.id} must be one of: ${q.options.join(', ')}`);
    }
    if (q.type === 'phone' && !/^\+?\d[\d\s-]{5,}$/.test(String(value))) {
      errors.push(`${q.label || q.id} must be a valid phone number`);
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  getQuestions, loadQuestions: getQuestions,
  validateIntake, validate: validateIntake,
};
