// ============================================================================
// clinic-automation — pdfkit receipts/invoices + consent forms
//   (src/services/pdf.js)
// generateReceipt({ client, appointment, items, amount }) → absolute file path
//   under the receipts directory, named rcpt-<id>-<timestamp>.pdf. Plain,
//   printable layout: clinic header, client block, items table, total, footer.
// generateConsent({ client, appointment, questions, answers, amount }) →
//   absolute file path under the same directory, named consent-<timestamp>.pdf:
//   client block, a snapshot of the answered intake questions, an optional fee
//   line, consent declaration + a signature line (the patient signs on paper
//   after printing).
// Env: RECEIPTS_DIR (receipt directory override) and PDF_FONT_PATH (Unicode
//   font override) — both optional. See CURRENCY GLYPH below.
// Deps: pdfkit, fontkit (pdfkit's own declared dependency, used only to PROVE
//   a font carries the glyph), fs, path. Never throws without creating the
//   directory first.
//
// ---------------------------------------------------------------------------
// CURRENCY GLYPH — why this file prints "Rs." and not ₹ by default
// ---------------------------------------------------------------------------
// pdfkit's 14 built-in standard fonts (Helvetica, Times-Roman, Courier, …) are
// WinAnsi / Standard-Encoding and carry NO glyph for U+20B9. pdfkit does NOT
// throw for a missing glyph, and it does not omit the character either: it
// substitutes the encoding's fallback byte, so every receipt was printed with a
// SUPERSCRIPT ONE instead of a rupee. Decoding a real receipt from data/receipts
// shows exactly this:
//
//     "  Consult  x1  @  ¹500  =  ¹500"
//     "Total:  ¹500"
//
// A visibly corrupt financial document handed to a patient. The em-dash
// (U+2014) was lost the same way, leaving "Visit: … 09:00  Dental cleaning".
// (Those receipts stay on disk: regenerating them is a re-print, not a
// migration, so this only ever fixed FORWARD.)
//
// Registering a TrueType font via doc.registerFont() does fix it, but we
// deliberately do not vendor one, for three independent reasons:
//   1. LICENCE. Every TrueType on a typical Windows host that actually carries
//      a U+20B9 glyph (Segoe UI, Arial, Calibri, Tahoma, Verdana, Times New
//      Roman, Courier New, Consolas, Cambria) is a Microsoft-proprietary font
//      whose licence forbids redistribution — and vendoring means copying it
//      into the repo and into the published image.
//   2. DEPLOYMENT. The Dockerfile is `node:20-bookworm-slim`, installs no font
//      packages, and COPYs only ./src and ./public. An assets/fonts/ directory
//      would not exist inside the image at all.
//   3. DETERMINISM. Because of (2), auto-scanning system font directories
//      would render ₹ on a clinic's Windows workstation and "Rs." on the VPS —
//      a financial document that prints differently per environment.
// "Rs." is the conventional, unambiguous Indian invoice abbreviation and
// renders correctly in the built-in font, so an amount is never left unmarked
// or mis-marked. (The WhatsApp caption in routes/receipts.js and the template in
// whatsapp/templates.js are plain UTF-8 text and always sent a real ₹ — the
// defect was PDF-only.)
//
// UPGRADE PATH — no code change required. Drop a redistributable font that
//   carries U+20B9 (Noto Sans, SIL OFL 1.1, is the usual choice) at
//   assets/fonts/clinic.ttf — adding one `COPY assets ./assets` line to the
//   Dockerfile — or point PDF_FONT_PATH at any .ttf that has the glyph.
//   resolveCurrencyFont() verifies the glyph is really there, registers the
//   font, and currency() switches to ₹ on its own.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

// ---------------------------------------------------------------------------
// Static values
// ---------------------------------------------------------------------------

// U+20B9 RUPEE SIGN, written as an escape so the source stays pure ASCII.
const RUPEE_SIGN = '\u20B9';
const ASCII_CURRENCY = 'Rs. ';
// Same story as the rupee: U+2014 has no WinAnsi byte either, so the built-in
// fonts dropped it and left a double space ("Visit: … 09:00  Dental cleaning").
// When no Unicode font is available we substitute an ASCII hyphen so the line
// still reads correctly instead of silently losing a character.
const EM_DASH = '\u2014';
const ASCII_DASH = '-';
const CURRENCY_FONT = 'currency-unicode';
const BUILTIN_FONT = 'Helvetica';

// Receipts live in data/receipts unless RECEIPTS_DIR overrides it, so a
// container volume layout can change without a code edit.
const DEFAULT_RECEIPTS_DIR = path.resolve(__dirname, '..', '..', 'data', 'receipts');
// Repo drop-in slot for a redistributable rupee-capable font (see UPGRADE PATH).
const ASSETS_FONT_DIR = path.resolve(__dirname, '..', '..', 'assets', 'fonts');

// Receipts hold patient names, phone numbers and amounts, so the file is
// created 0640 rather than the 0666 fs.createWriteStream defaults to on POSIX.
const RECEIPT_FILE_MODE = 0o640;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function receiptsDir() {
  // `String(x || '')` turns an ASSIGNED JavaScript `undefined` into the literal
  // 4+9 character STRING "undefined" - process.env coerces every value to a
  // string. `process.env.RECEIPTS_DIR = undefined` therefore yields "undefined",
  // and path.resolve("undefined") resolves against the CWD, so every receipt and
  // consent form was silently written into a junk `undefined/` directory at the
  // repo root (140 real patient PDFs had accumulated there). Same trap applies to
  // "null". Treat both sentinels as ABSENT so the default directory is used.
  const raw = String(process.env.RECEIPTS_DIR == null ? '' : process.env.RECEIPTS_DIR).trim();
  const unusable = raw === '' || raw === 'undefined' || raw === 'null';
  const dir = unusable ? DEFAULT_RECEIPTS_DIR : path.resolve(raw);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isReadableFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Font resolution
// ---------------------------------------------------------------------------

/**
 * Prove a TrueType file actually carries a glyph for U+20B9.
 *
 * This check is the whole point of the module's font handling. "The file opens"
 * is NOT evidence that it can draw a rupee: Segoe UI Symbol and Lucida Sans
 * are both installed on a stock Windows box and BOTH lack U+20B9 (verified with
 * fontkit). Pointing PDF_FONT_PATH at one of those — an easy mistake, since
 * they look like a font and open fine — would silently restore exactly the
 * "¹500" bug this file exists to prevent.
 *
 * @returns {boolean} true only if the glyph is present. Unreadable, corrupt,
 *   encrypted, non-font or simply glyph-less files all return false.
 */
function hasRupeeGlyph(file) {
  let fontkit;
  try {
    fontkit = require('fontkit'); // declared dep of pdfkit (^2.0.4)
  } catch (_) {
    return false; // cannot verify ⇒ must not trust
  }
  try {
    const opened = fontkit.openSync(file);
    const font = opened && opened.fonts ? opened.fonts[0] : opened; // .ttc collections
    if (!font) return false;
    if (typeof font.hasGlyphForCodePoint === 'function') {
      return font.hasGlyphForCodePoint(0x20b9) === true;
    }
    return typeof font.glyphForCodePoint === 'function' && !!font.glyphForCodePoint(0x20b9);
  } catch (_) {
    return false;
  }
}

// Memoised resolution. `undefined` = unresolved, `null` = no usable font,
// otherwise { file, family }. Resolution touches the filesystem and parses a
// font, and generateReceipt/generateConsent run per request.
let _font;

/**
 * Locate a Unicode font that can ACTUALLY render U+20B9, in priority order:
 *   1. $PDF_FONT_PATH / $PDF_FONT_REGULAR — explicit operator override.
 *   2. assets/fonts/clinic.ttf — the documented drop-in slot.
 *   3. any other font dropped into assets/fonts/.
 * We deliberately do NOT auto-scan system font directories: the rupee-capable
 * fonts there are proprietary, and picking one up silently would make local dev
 * render differently from the production container (see header, reason 3).
 *
 * @returns {{file: string, family: string}|null} null ⇒ ASCII "Rs. " fallback
 */
function resolveCurrencyFont() {
  if (_font !== undefined) return _font;

  const override = String(process.env.PDF_FONT_PATH || process.env.PDF_FONT_REGULAR || '').trim();
  if (override) {
    const abs = path.resolve(override);
    if (isReadableFile(abs)) {
      if (hasRupeeGlyph(abs)) {
        _font = { file: abs, family: CURRENCY_FONT };
        return _font;
      }
      console.error(
        `[pdf] PDF_FONT_PATH "${abs}" has no U+20B9 rupee glyph; amounts will print as ` +
        `"${ASCII_CURRENCY.trim()}". Pick a font that actually carries it (e.g. Noto Sans).`
      );
    } else {
      console.error(`[pdf] PDF_FONT_PATH "${abs}" is not a readable file; ignoring it.`);
    }
  }

  try {
    const named = path.join(ASSETS_FONT_DIR, 'clinic.ttf');
    const names = fs.readdirSync(ASSETS_FONT_DIR).sort();
    // clinic.ttf first so the documented slot wins over a stray sibling.
    if (isReadableFile(named)) names.unshift('clinic.ttf');
    for (const name of names) {
      if (!/\.(ttf|ttc|otf)$/i.test(name)) continue;
      const abs = path.join(ASSETS_FONT_DIR, name);
      if (isReadableFile(abs) && hasRupeeGlyph(abs)) {
        _font = { file: abs, family: CURRENCY_FONT };
        return _font;
      }
    }
  } catch (_) {
    // No assets/fonts/ directory is the normal case — not an error.
  }

  _font = null;
  return _font;
}

// ---------------------------------------------------------------------------
// Money formatting — shared by EVERY currency occurrence (receipt item lines,
// the receipt total, the consent fee line)
// ---------------------------------------------------------------------------

// Integers stay bare ("500"); a fractional value is fixed to 2dp so float noise
// (0.1 + 0.2) never reaches a patient.
function formatAmount(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/**
 * Format one amount with its currency mark.
 * @param {number|string} n
 * @param {boolean} [unicode] force the rupee glyph on/off. Callers inside a
 *   generator pass the document's actual capability so a font that failed to
 *   register can never reintroduce the dropped-glyph bug; when omitted the font
 *   is resolved here so this stays usable as a standalone helper.
 */
function currency(n, unicode) {
  const useUnicode = unicode === undefined ? Boolean(resolveCurrencyFont()) : Boolean(unicode);
  return (useUnicode ? RUPEE_SIGN : ASCII_CURRENCY) + formatAmount(n);
}

/**
 * The dash used between a slot and a service on a "Visit:" line. U+2014 is
 * outside WinAnsi, so without a Unicode font it would be dropped and the two
 * halves would run together; degrade to an ASCII hyphen rather than lose it.
 */
function dash(unicode) {
  return unicode ? EM_DASH : ASCII_DASH;
}

/**
 * New document + write stream, with the Unicode font pre-registered when a
 * verified one is available.
 *
 * The font is applied to the WHOLE document, not just the money lines: a
 * font that can draw ₹ can also draw the em-dash, and scoping the swap to the
 * money lines would leave "Visit: … 09:00  Dental" broken on every receipt.
 *
 * @returns {{doc: object, stream: object, unicode: boolean}}
 */
function openDoc(filePath) {
  const doc = new PDFDocument({ margin: 50 });
  let unicode = false;
  const font = resolveCurrencyFont();
  if (font) {
    try {
      doc.registerFont(font.family, font.file);
      doc.font(font.family);
      unicode = true;
    } catch (_) {
      // A corrupt or unparseable font must never break a receipt — fall back to
      // the built-in font and the ASCII marks.
      doc.font(BUILTIN_FONT);
      unicode = false;
    }
  }
  const stream = fs.createWriteStream(filePath, { mode: RECEIPT_FILE_MODE });
  doc.pipe(stream);
  return { doc, stream, unicode };
}

function clinicName() {
  try {
    return require('../config').getConfig().clinicName || 'Clinic';
  } catch (_) {
    return 'Clinic';
  }
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

function generateReceipt({ client, appointment = null, items = [], amount = 0 } = {}) {
  return new Promise((resolve, reject) => {
    try {
      const dir = receiptsDir();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filePath = path.join(dir, `rcpt-${Date.now()}-${stamp}.pdf`);
      const { doc, stream, unicode } = openDoc(filePath);
      // Bound to this document's real capability — never re-resolves per line.
      const money = (n) => currency(n, unicode);
      const rule = dash(unicode);

      doc.fontSize(20).text(clinicName(), { align: 'center' });
      doc.fontSize(12).text('Receipt', { align: 'center' });
      doc.moveDown();
      doc.fontSize(10);
      doc.text(`Date: ${new Date().toLocaleString()}`);
      doc.text(`Billed to: ${client ? `${client.name} (${client.phone})` : ASCII_DASH}`);
      if (appointment) doc.text(`Visit: ${appointment.slot_start} ${rule} ${appointment.service}`);
      doc.moveDown();

      const list = items.length ? items : [{ desc: 'Consultation', qty: 1, rate: amount }];
      doc.text('Items:');
      for (const it of list) {
        const qty = Number(it.qty) || 1;
        const rate = Number(it.rate) || 0;
        doc.text(`  ${it.desc || 'Item'}  x${qty}  @ ${money(rate)}  = ${money(qty * rate)}`);
      }
      doc.moveDown();
      doc.fontSize(14);
      doc.text(`Total: ${money(amount)}`, { align: 'right' });
      doc.moveDown();
      doc.fontSize(9).fillColor('#555').text('Computer-generated receipt. Thank you for visiting!', { align: 'center' });

      doc.end();
      stream.on('finish', () => resolve(filePath));
      stream.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

function generateConsent({ client, appointment = null, questions = [], answers = {}, amount = null } = {}) {
  return new Promise((resolve, reject) => {
    try {
      const dir = receiptsDir();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filePath = path.join(dir, `consent-${Date.now()}-${stamp}.pdf`);
      const { doc, stream, unicode } = openDoc(filePath);
      const money = (n) => currency(n, unicode);
      const rule = dash(unicode);

      doc.fontSize(20).text(clinicName(), { align: 'center' });
      doc.fontSize(12).text('Consent Form', { align: 'center' });
      doc.moveDown();
      doc.fontSize(10);
      doc.text(`Date: ${new Date().toLocaleString()}`);
      doc.text(`Patient: ${client ? `${client.name} (${client.phone})` : ASCII_DASH}`);
      if (appointment) doc.text(`Visit: ${appointment.slot_start} ${rule} ${appointment.service}`);
      doc.moveDown();

      // Snapshot of the intake answers at signing time (non-dev readable).
      const given = answers && typeof answers === 'object' ? answers : {};
      if (Array.isArray(questions) && questions.length) {
        doc.text('Intake answers on record:');
        for (const q of questions) {
          const label = q.label || q.id || 'Question';
          const raw = given[q.id];
          const val = raw === true ? 'Yes' : raw === false ? 'No' : raw == null || raw === '' ? ASCII_DASH : String(raw);
          doc.text(`  ${label}: ${val}`);
        }
      } else if (Object.keys(given).length) {
        doc.text('Intake answers on record:');
        for (const [k, v] of Object.entries(given)) {
          doc.text(`  ${k}: ${v === true ? 'Yes' : v === false ? 'No' : String(v)}`);
        }
      }
      // Optional fee line, formatted by the same helper as the receipt total.
      if (amount !== null && amount !== undefined && amount !== '') {
        doc.moveDown();
        doc.text(`Consultation fee: ${money(amount)}`, { align: 'right' });
      }
      doc.moveDown();
      doc.text('I confirm that the information above is correct to the best of my');
      doc.text('knowledge, and I consent to treatment at the clinic.');
      doc.moveDown(3);
      doc.text('Signature: ______________________________');
      doc.moveDown();
      doc.text(`Name: ${client ? client.name : '__________________'}      Date: ______________`);

      doc.end();
      stream.on('finish', () => resolve(filePath));
      stream.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

// Kept at the bottom on purpose: every export above is a hoisted function
// declaration, so exporting here is equivalent to exporting mid-file (which is
// what this module used to do) while keeping the definitions in reading order.
// The public surface is exactly what src/routes/receipts.js consumes.
module.exports = { generateReceipt, generateConsent, receiptsDir };
