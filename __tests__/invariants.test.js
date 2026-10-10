/**
 * The money and join invariants, asserted against the query source itself.
 *
 * These cost a production incident each to learn and are recorded in CLAUDE.md as prose.
 * Prose does not fail a build. Reading the SQL text is crude, but it needs no database
 * and it turns "a human re-reads a 98KB document" into "CI goes red".
 *
 * If a query is legitimately rewritten, update the assertion in the same commit — that
 * is the point: the change becomes deliberate and reviewable instead of silent.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'backend', 'services', 'pipelineService.js'), 'utf8');

/** The source of a named function, from its declaration to the next top-level close. */
function fn(name) {
  const decl = ['async function ' + name, 'function ' + name]
    .map(d => SRC.indexOf(d))
    .find(i => i !== -1);
  assert.ok(decl !== undefined, 'function ' + name + ' not found - was it renamed?');
  const end = SRC.indexOf('\n}\n', decl);
  assert.ok(end !== -1, 'could not find the end of ' + name);
  return SRC.slice(decl, end);
}

test('the sanctioned amount is MAX, never SUM', () => {
  // 14 (s_id, academic_year) groups carry duplicate sanction rows with identical
  // amounts; SUM booked a Rs 50,000 sanction as Rs 150,000.
  const sanctionReads = SRC.match(/\w+\(\s*\w*\.?amount_sanctioned\s*\)/g) || [];
  assert.ok(sanctionReads.length > 0, 'no aggregate over amount_sanctioned found');
  for (const read of sanctionReads) {
    assert.match(read, /^MAX\(/, `amount_sanctioned must be read with MAX, got: ${read}`);
  }
  assert.doesNotMatch(SRC, /SUM\(\s*\w*\.?amount_sanctioned/,
    'SUM(amount_sanctioned) double-books a re-saved sanction');
});

test('disbursements are summed over the de-duplicated voucher set, never the raw table', () => {
  const sums = SRC.match(/SUM\(\s*\w*\.?pt_amount_disbursed\s*\)/g) || [];
  assert.ok(sums.length > 0, 'no SUM over pt_amount_disbursed found');
  // Every such SUM must be against the derived DISTINCT_PAYMENTS table, aliased d, d2, d3...
  for (const s of sums) {
    assert.match(s, /SUM\(\s*d\d*\.pt_amount_disbursed\s*\)/,
      `disbursement must be summed over the DISTINCT_PAYMENTS alias, got: ${s}`);
  }
  assert.match(SRC, /\(\$\{DISTINCT_PAYMENTS\}\)\s*d/,
    'the SUM must read from the (DISTINCT_PAYMENTS) d derived table');
});

test('cancelled vouchers are excluded from the payment set', () => {
  assert.match(SRC, /pt_cancel_tag[\s\S]{0,40}<>\s*'Y'/,
    "DISTINCT_PAYMENTS must exclude pt_cancel_tag = 'Y'");
});

test('getMatrix INNER JOINs academic details — the 100%-inflation counting bug', () => {
  // Treating a missing academic row as CREATED inflated every handler by 100%+,
  // because 461 students are mapped but only ~205 have a row in a given year.
  const body = fn('getMatrix');
  assert.doesNotMatch(body, /LEFT\s+JOIN\s+educon_user_academic_details/i,
    'academic details must never be LEFT JOINed — a missing row is not a CREATED student');
});

test('pseudo-users are bound as parameters, never interpolated', () => {
  // A roster that lets rcp / clo / E300 / as through reports holding-pen accounts as
  // real handlers and, worse, as sanctioning authorities.
  assert.match(SRC, /const pseudoList\s*=\s*\(\)\s*=>\s*PSEUDO_USERS\.map\(\(\)\s*=>\s*'\?'\)/,
    'pseudoList() must emit bound placeholders, not values');
  assert.doesNotMatch(SRC, /login_id\s+NOT\s+IN\s*\(\s*'/i,
    'a quoted literal in a NOT IN list means a value was interpolated into SQL');
});

test('no value is interpolated into SQL — only placeholder lists', () => {
  // Any ${...} inside a SQL template must be a known fragment or a placeholder list.
  const ALLOWED = /^\$\{(pseudoList\(\)|statusList|ownerClause|moneyColumns|PROFILE_COLUMNS|PROFILE_JOINS[\s\S]*|AUTHORITY_JOINS|OWNER_PICK|DISTINCT_PAYMENTS|withMoney[\s\S]*)\}$/;
  const interpolations = SRC.match(/\$\{[^}]*\}/g) || [];
  const suspicious = interpolations.filter(i => {
    if (ALLOWED.test(i)) return false;
    // Template strings outside SQL (log lines, messages) are fine; flag only ones that
    // look like a bare variable landing in a query.
    return /^\$\{(year|etmId|statuses|studentId|limit)\}$/.test(i);
  });
  assert.deepEqual(suspicious, [], `these values are interpolated into SQL: ${suspicious}`);
});

test('the student/case key split is documented at the join sites', () => {
  // user_id is the student, s_id is the case. Swapping them still returns rows, just
  // far fewer (1361 vs 101 on the mapping join) — a silent, plausible wrong answer.
  assert.match(SRC, /m2?\.s_id\s*=\s*a\.user_id/,
    'the etm mapping must join on the STUDENT (a.user_id), not the case');
  assert.match(SRC, /academic_year\s*=\s*pick\.academicYear|f\.academic_year\s*=/,
    'the sanction join must be keyed by academic_year as well as s_id');
});
