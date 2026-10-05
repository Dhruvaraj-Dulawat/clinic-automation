// ============================================================================
// clinic-automation — receipt/consent PDF contract + D15 currency glyph
//   (tests/pdf.test.js)
// Locks the module that produces the clinic's financial documents:
//   * the exact export surface src/routes/receipts.js consumes
//   * RECEIPTS_DIR resolution, and that a bad override rejects loudly
//   * D15 — amounts are never printed with the wrong glyph. pdfkit's 14
//     built-in fonts are WinAnsi and carry NO U+20B9, and pdfkit does not throw
//     on a missing glyph: it substitutes the encoding's fallback byte, so every
//     receipt used to print U+00B9 SUPERSCRIPT ONE ("¹500" instead of "500").
//   * a configured font is only trusted if it REALLY carries the glyph
//   * money is coerced/rounded, never printed as NaN or raw float noise
//   * no stray currency literals outside the helper, no new dependencies
//
// WHY THIS FILE DECODES PDF BYTE-LEVEL RATHER THAN REGEX-ING THE RAW FILE
//   pdfkit never writes show-text as literal ASCII — it writes HEX inside TJ
//   arrays, e.g. `[<52656365697074>] TJ` for "Receipt". So a naive
//   `inflatedStream.includes('Rs. ')` is a FALSE PASS, and (worse) a naive
//   scan for U+00B9 is a TRUE POSITIVE for nothing on the broken path.
//   Decoding is also glyph-shape dependent: built-in AFM fonts emit 1-byte
//   WinAnsi codes, but a registered TrueType font emits 2-BYTE Identity-H CIDs
//   that only mean anything once the /ToUnicode CMap is applied. The single
//   sound question is therefore:
//       "is there a code point drawn on this page whose ToUnicode mapping is
//        U+20B9?" — which needs inflate, then the CMap, then the CIDs.
//   Each case below decodes properly. A reader that skipped the CMap step would
//   report a real rupee as four nonsense characters.
//
// This file is intentionally ASCII-only: the rupee (U+20B9), the em-dash
// (U+2014) and U+FFFD appear as \uXXXX escapes so the suite cannot itself be
// corrupted by a lossy write, and so the assertions state the exact code point
// being asserted rather than depending on the editor's encoding.
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

// From tests/, the module under test is one level up (it used to be required
// from src/services/__tests__/, hence the shorter relative hop in the original).
const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'src', 'services', 'pdf.js');

const TMP = path.join(os.tmpdir(), 'opencode', 'pdf-test-' + process.pid);
fs.mkdirSync(TMP, { recursive: true });

// Set BEFORE the module is ever required, so no receipt can reach data/receipts.
const RECEIPTS_DIR_TMP = path.join(TMP, 'out');
process.env.NODE_ENV = 'test';
process.env.RECEIPTS_DIR = RECEIPTS_DIR_TMP;

const RUPEE = '\u20B9';          // U+20B9 RUPEE SIGN — the correct glyph
const WRONG_GLYPH = '\u00B9';    // U+00B9 SUPERSCRIPT ONE — what D15 actually emitted
const EM_DASH = '\u2014';        // U+2014, also lost by the built-in fonts
const REPLACEMENT = '\uFFFD';    // a CID we could not resolve

// Two real fonts on a stock Windows host, characterised up front (verified with
// fontkit on this box): arial.ttf HAS U+20B9 and must be accepted;
// seguisym.ttf LACKS U+20B9 and must be REJECTED, or D15 comes straight back.
const FONT_WITH_RUPEE = 'C:/Windows/Fonts/arial.ttf';
const FONT_WITHOUT_RUPEE = 'C:/Windows/Fonts/seguisym.ttf';

// ===========================================================================
// Font-aware PDF text extraction.
// ===========================================================================

/** Every flate/raw stream in the PDF, inflated where possible. */
function inflateAll(file) {
  const raw = fs.readFileSync(file).toString('latin1');
  const out = [];
  let i = 0;
  while (true) {
    const s = raw.indexOf('stream', i);
    if (s < 0) break;
    let a = s + 6;
    if (raw[a] === '\r') a++;
    if (raw[a] === '\n') a++;
    const e = raw.indexOf('endstream', a);
    if (e < 0) break;
    const bytes = Buffer.from(raw.slice(a, e), 'latin1');
    try { out.push(zlib.inflateSync(bytes)); } catch (_) { out.push(bytes); }
    i = e + 9;
  }
  return { raw, streams: out };
}

/** CID -> code point, from the ToUnicode CMap (bfchar + both bfrange forms). */
function toUnicodeMap(streams) {
  const map = new Map();
  const norm = (h) => h.toLowerCase().replace(/^0+(?=.)/, '');
  for (const st of streams) {
    const t = st.toString('latin1');
    if (!t.includes('begincmap')) continue;
    for (const blk of t.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
        map.set(norm(m[1]), parseInt(m[2], 16));
      }
    }
    for (const blk of t.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      const body = blk[1];
      const arrays = [...body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g)];
      for (const r of arrays) {
        const lo = parseInt(r[1], 16);
        [...r[3].matchAll(/<([0-9a-fA-F]+)>/g)].map((d) => d[1])
          .forEach((d, k) => map.set(norm((lo + k).toString(16)), parseInt(d, 16)));
      }
      // Range form only, on the body with the array forms excised — a lookahead
      // placed after an array backtracks and matches garbage.
      let rest = body;
      for (const r of arrays) rest = rest.replace(r[0], ' ');
      for (const r of rest.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
        const lo = parseInt(r[1], 16); const hi = parseInt(r[2], 16); const s0 = parseInt(r[3], 16);
        for (let c = lo; c <= hi; c++) map.set(norm(c.toString(16)), s0 + (c - lo));
      }
    }
  }
  return map;
}

/** The text a PDF reader would show — WinAnsi bytes or Identity-H CIDs. */
function extractText(file) {
  const { raw, streams } = inflateAll(file);
  const embedded = /\/FontFile2/.test(raw);
  const cmap = toUnicodeMap(streams);
  const norm = (h) => h.toLowerCase().replace(/^0+(?=.)/, '');
  let text = '';
  for (const st of streams) {
    const t = st.toString('latin1');
    if (!/\bTJ\b|\bTj\b/.test(t)) continue;
    const emit = (hex) => {
      // Built-in AFM fonts: TWO hex digits per WinAnsi byte. (Iterating single
      // digits silently halves every code point — do not "simplify" this.)
      if (!embedded) {
        for (let k = 0; k + 2 <= hex.length; k += 2) text += String.fromCharCode(parseInt(hex.substr(k, 2), 16));
        return;
      }
      // Embedded TrueType /Identity-H: FOUR hex digits per CID.
      for (let k = 0; k + 4 <= hex.length; k += 4) {
        const u = cmap.get(norm(hex.slice(k, k + 4)));
        text += u === undefined ? REPLACEMENT : String.fromCodePoint(u);
      }
    };
    for (const arr of t.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
      for (const h of arr[1].matchAll(/<([0-9a-fA-F]*)>/g)) emit(h[1]);
      text += '\n';
    }
    for (const m of t.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)) { emit(m[1]); text += '\n'; }
  }
  return { text, embedded, cmap };
}

/**
 * Re-require pdf.js with a cold font memo.
 * resolveCurrencyFont() memoises into a module-level `_font`, so without
 * clearing the registry every case after the first would reuse the FIRST case's
 * decision and the font cases would pass vacuously.
 */
function freshModule(env = {}) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[require.resolve(TARGET)];
  return require(TARGET);
}

/**
 * Every case starts from this exact environment, so none can inherit a mutation
 * the previous case made to the shared process.env.
 *
 * This is load-bearing, not tidiness. `freshModule({ RECEIPTS_DIR: undefined })`
 * DELETES the variable, and a later `process.env.RECEIPTS_DIR = undefined`
 * re-assigns it the STRING "undefined" (Node coerces) — which receiptsDir()
 * then resolves as a relative path and mkdir's, scattering PDFs into a phantom
 * top-level `undefined/` directory instead of the throwaway temp dir. Restoring
 * the temp dir here means the deletion case cannot escape, whatever order the
 * cases run in. The same reset stops a rejected PDF_FONT_PATH from one case
 * leaking into the next.
 */
test.beforeEach(() => {
  process.env.RECEIPTS_DIR = RECEIPTS_DIR_TMP;
  delete process.env.PDF_FONT;
  delete process.env.PDF_FONT_REGULAR;
});

test.before(() => {
  // Never inherit an operator's font from the ambient shell.
  delete process.env.PDF_FONT;
  delete process.env.PDF_FONT_REGULAR;
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});

// ===========================================================================
// Contract
// ===========================================================================

test('exports stay exactly what src/routes/receipts.js consumes', () => {
  const mod = require(TARGET);
  assert.deepEqual(
    Object.keys(mod).sort(),
    ['generateConsent', 'generateReceipt', 'receiptsDir'],
    'the public export surface must not change'
  );
  for (const k of ['generateReceipt', 'generateConsent', 'receiptsDir']) {
    assert.equal(typeof mod[k], 'function', k + ' must remain a function');
  }
});

test('receiptsDir() honours RECEIPTS_DIR and creates it', () => {
  const { receiptsDir } = freshModule();
  const dir = receiptsDir();
  assert.equal(dir, path.resolve(process.env.RECEIPTS_DIR), 'env override must win');
  assert.ok(fs.existsSync(dir), 'directory must be created if missing');
  assert.ok(!dir.includes(`${path.sep}clinic-automation${path.sep}data${path.sep}`),
    'must NOT write into the real data/receipts during tests');
});

test('receiptsDir() falls back to data/receipts with no override', () => {
  const { receiptsDir } = freshModule({ RECEIPTS_DIR: undefined });
  assert.equal(receiptsDir(), path.resolve(ROOT, 'data', 'receipts'));
});

test('a bad RECEIPTS_DIR rejects rather than resolving a phantom path', async () => {
  const { generateReceipt } = freshModule();
  const asFile = path.join(TMP, 'iam-a-file');
  fs.writeFileSync(asFile, 'not a directory');
  const saved = process.env.RECEIPTS_DIR;
  process.env.RECEIPTS_DIR = asFile;
  try {
    await assert.rejects(
      () => generateReceipt({ client: { name: 'X', phone: '+919000000444' }, amount: 1 }),
      /EEXIST|ENOTDIR/
    );
  } finally {
    // delete, never `= saved`: assigning undefined would coerce to the literal
    // string "undefined" and create a phantom directory. beforeEach restores
    // the real value regardless, so this only needs to leave nothing behind.
    if (saved === undefined) delete process.env.RECEIPTS_DIR;
    else process.env.RECEIPTS_DIR = saved;
  }
});

test('every generated PDF lands in the throwaway dir, never in the repo', async () => {
  // The containment property the module's own header warns about. Asserted on
  // the RETURNED path rather than trusting the env, because that is what the
  // caller actually writes to disk.
  const { generateReceipt, generateConsent } = freshModule();
  const client = { name: 'Containment', phone: '+919000000555' };
  const files = [
    await generateReceipt({ client, amount: 100 }),
    await generateConsent({ client, amount: 100 }),
  ];
  for (const f of files) {
    assert.ok(path.isAbsolute(f), `not absolute: ${f}`);
    assert.ok(f.startsWith(TMP + path.sep), `escaped the throwaway dir:\n  ${f}`);
    assert.ok(!f.includes(`${path.sep}data${path.sep}receipts`),
      `wrote into the real data/receipts:\n  ${f}`);
    assert.ok(fs.existsSync(f), `declared but not on disk: ${f}`);
  }
});

// ===========================================================================
// D15 — the defect itself
// ===========================================================================

test('D15: with no Unicode font, amounts print "Rs. " and NEVER a wrong glyph', async () => {
  const { generateReceipt } = freshModule({ PDF_FONT_PATH: undefined, PDF_FONT_REGULAR: undefined });
  const file = await generateReceipt({
    client: { name: 'Asha Rao', phone: '+919876543210' },
    appointment: { slot_start: '2026-10-05 09:00', service: 'Dental cleaning' },
    items: [{ desc: 'Scaling', qty: 2, rate: 500 }],
    amount: 1000,
  });

  assert.ok(path.isAbsolute(file), 'must resolve to an ABSOLUTE path');
  assert.ok(fs.existsSync(file), 'file must exist on disk');
  assert.ok(fs.statSync(file).size > 800, `PDF suspiciously small: ${fs.statSync(file).size} bytes`);

  const { text } = extractText(file);

  // THE DEFECT: the standard fonts emit U+00B9 (superscript one) for a rupee.
  assert.ok(!text.includes(WRONG_GLYPH),
    `currency rendered as the WRONG glyph U+00B9 (superscript one):\n${text}`);

  // Both the item line and the total must carry a marker.
  assert.match(text, /Scaling {2}x2 {2}@ Rs\. 500 {2}= Rs\. 1000/, `items line wrong:\n${text}`);
  assert.match(text, /Total: Rs\. 1000/, `total line wrong:\n${text}`);
});

test('D15: a rupee-capable font renders a real U+20B9 and the em-dash', async () => {
  assert.ok(fs.existsSync(FONT_WITH_RUPEE), `test fixture missing: ${FONT_WITH_RUPEE}`);
  const { generateReceipt } = freshModule({ PDF_FONT_PATH: FONT_WITH_RUPEE });
  const file = await generateReceipt({
    client: { name: 'Asha Rao', phone: '+919876543210' },
    appointment: { slot_start: '2026-10-05 09:00', service: 'Dental cleaning' },
    items: [{ desc: 'Scaling', qty: 2, rate: 500 }],
    amount: 1000,
  });

  const { text, embedded } = extractText(file);
  assert.ok(embedded, 'the configured font must actually be embedded in the PDF');

  assert.ok(!text.includes(WRONG_GLYPH), `wrong glyph present:\n${text}`);
  assert.match(text, /@ ₹500 {2}= ₹1000/, `items line missing a real rupee:\n${text}`);
  assert.match(text, /Total: ₹1000/, `total line missing a real rupee:\n${text}`);
  // The em-dash was lost by the standard fonts too.
  assert.ok(text.includes(EM_DASH), `em-dash missing from:\n${text}`);
  assert.doesNotMatch(text, /09:00 {2}Dental/, 'em-dash must not collapse to a double space');
});

test('D15 GUARD: a font WITHOUT the rupee glyph is REJECTED, not trusted', async () => {
  // Segoe UI Symbol is installed on a stock Windows box and looks like a font,
  // but carries no U+20B9. Trusting it would silently restore the "¹500" bug.
  assert.ok(fs.existsSync(FONT_WITHOUT_RUPEE), `test fixture missing: ${FONT_WITHOUT_RUPEE}`);
  const { generateReceipt } = freshModule({ PDF_FONT_PATH: FONT_WITHOUT_RUPEE });
  const file = await generateReceipt({
    client: { name: 'Trap', phone: '+919000000777' },
    items: [{ desc: 'Consult', qty: 1, rate: 500 }],
    amount: 500,
  });

  const { text } = extractText(file);
  assert.ok(!text.includes(WRONG_GLYPH), `wrong glyph leaked through:\n${text}`);
  assert.match(text, /Rs\. 500/, `a glyph-less font must degrade to "Rs. ", got:\n${text}`);
  assert.doesNotMatch(text, /₹/, 'a glyph-less font must NOT be used for the rupee');
});

test('an unreadable PDF_FONT_PATH is ignored rather than fatal', async () => {
  const { generateReceipt } = freshModule({ PDF_FONT_PATH: path.join(TMP, 'nope.ttf') });
  const file = await generateReceipt({ client: { name: 'Ghost', phone: '+919000000888' }, amount: 250 });
  const { text } = extractText(file);
  assert.match(text, /Rs\. 250/, `expected the ASCII fallback:\n${text}`);
});

// ===========================================================================
// Robustness of the money path
// ===========================================================================

test('a receipt with no items still renders a total with a marker', async () => {
  const { generateReceipt } = freshModule();
  const file = await generateReceipt({ client: { name: 'No Items', phone: '+919000000222' }, amount: 499 });
  const { text } = extractText(file);
  assert.match(text, /Rs\. 499/, `defaulted item line lost the marker:\n${text}`);
});

test('non-numeric money is coerced, never printed as NaN or undefined', async () => {
  const { generateReceipt } = freshModule();
  const file = await generateReceipt({
    client: { name: 'Junk Money', phone: '+919000000555' },
    items: [{ desc: 'Weird', qty: 'x', rate: 'abc' }],
    amount: undefined,
  });
  const { text } = extractText(file);
  assert.doesNotMatch(text, /NaN|undefined/, `garbage leaked into the receipt:\n${text}`);
});

test('fractional amounts are fixed to 2dp so float noise never reaches a patient', async () => {
  const { generateReceipt } = freshModule();
  const file = await generateReceipt({
    client: { name: 'Floaty', phone: '+919000000999' },
    items: [{ desc: 'Split', qty: 3, rate: 33.333333 }],
    amount: 99.999999,
  });
  const { text } = extractText(file);
  // The RAW floats must never be printed...
  assert.doesNotMatch(text, /99\.99999\b|33\.333333/, `raw float noise printed:\n${text}`);
  // ...and 3 x 33.333333 = 99.999999 must round to 100.00, not truncate to 99.99.
  assert.match(text, /Rs\. 33\.33/, `unit rate not fixed to 2dp:\n${text}`);
  assert.match(text, /100\.00/, `total not correctly rounded:\n${text}`);
});

test('generateConsent still works and produces a real PDF', async () => {
  const { generateConsent } = freshModule();
  const file = await generateConsent({
    client: { name: 'Asha Rao', phone: '+919876543210' },
    appointment: { slot_start: '2026-10-05 09:00', service: 'Dental cleaning' },
    questions: [{ id: 'meds', label: 'Current medications' }, { id: 'allergy', label: 'Any allergy?' }],
    answers: { meds: 'None', allergy: false },
  });
  assert.ok(path.isAbsolute(file));
  assert.ok(fs.statSync(file).size > 800, 'consent PDF too small');
  const { text } = extractText(file);
  assert.match(text, /Consent Form/);
  assert.match(text, /None/);
  assert.match(text, /Signature/);
});

test('generateConsent tolerates being called with no arguments', async () => {
  const { generateConsent } = freshModule();
  const file = await generateConsent();
  assert.ok(fs.existsSync(file));
  assert.ok(fs.statSync(file).size > 800);
});

test('the optional consent fee line uses the same currency helper', async () => {
  const { generateConsent } = freshModule();
  const file = await generateConsent({ client: { name: 'Fee', phone: '+919000000123' }, amount: 900 });
  const { text } = extractText(file);
  assert.match(text, /Consultation fee: Rs\. 900/, `fee line wrong:\n${text}`);
});

test('receipts are written with mode 0o640 (owner+group read, world locked out)', () => {
  if (process.platform === 'win32') return; // POSIX modes are not meaningful on NTFS
  const { generateReceipt } = freshModule();
  return generateReceipt({ client: { name: 'Mode', phone: '+919000000333' }, amount: 10 })
    .then((file) => {
      assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    });
});

// ===========================================================================
// Source hygiene
// ===========================================================================

test('no stray currency literals hardcoded outside the helper', () => {
  const src = fs.readFileSync(TARGET, 'utf8');
  // The glyph may be written literally or escaped; either way it may appear
  // only on the RUPEE_SIGN constant line or inside a comment.
  const offenders = src.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => l.includes(RUPEE) || l.includes('\\u20B9'))
    .filter(([, l]) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || /const\s+RUPEE_SIGN\s*=/.test(l));
    });
  assert.deepEqual(offenders.map(([n, l]) => `${n}: ${l.trim()}`), [],
    'money must go through currency(), never inline in a template literal');
  assert.match(src, /const\s+RUPEE_SIGN\s*=/, 'the RUPEE_SIGN constant must exist');
});

test('no debug logging, and no new dependencies', () => {
  const src = fs.readFileSync(TARGET, 'utf8');
  assert.doesNotMatch(src, /console\.log|debugger/, 'no debug logging');
  assert.deepEqual(
    Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies).sort(),
    ['bcryptjs', 'better-sqlite3', 'csv-parse', 'dotenv', 'express', 'express-session', 'node-cron', 'pdfkit'],
    'pdf.js must not require any new dependency'
  );
});