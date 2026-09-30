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
  path.join(__dirname, '..', 'backend', 'services', 'pipelineService.js'),
  'utf8'
);

const CLOSE = '\n}\n';

/** The source of a named function, from its declaration to the next top-level close. */
function fn(name) {
  const decl = ['async function ' + name, 'function ' + name]
    .map(d => SRC.indexOf(d))
    .find(i => i !== -1);
  assert.ok(decl !== undefined, `function ${name} not found — was it renamed?`);
  const end = SRC.indexOf(CLOSE, decl);
  assert.ok(end !== -1, `could not find the end of ${name}`);
  return SRC.slice(decl, end);
}

test('the sanctioned amount is MAX, never SUM', () => {
  // 14 (s_id, academic_year) groups carry duplicate sanction rows with identical
  // amounts, so SUM booked a ₹50,000 sanction as ₹150,000.
  const reads = SRC.match(/\b[A-Z]+\(\s*\w*\.?amount_sanctioned\s*\)/g) || [];
  assert.ok(reads.length > 0, 'no aggregate over amount_sanctioned found');
  for (const read of reads) {
    assert.match(read, /^MAX\(/, `amount_sanctioned must be read with MAX, got: ${read}`);
  }
  assert.doesNotMatch(
    SRC,
    /SUM\(\s*\w*\.?amount_sanctioned/,
    'SUM(amount_sanctioned) double-books a re-saved sanction'
  );
});

test('disbursements are summed over the de-duplicated voucher set, never the raw table', () => {
  const sums = SRC.match(/SUM\(\s*\w*\.?pt_amount_disbursed\s*\)/g) || [];
  assert.ok(sums.length > 0, 'no SUM over pt_amount_disbursed found');
  for (const s of sums) {
    assert.match(
      s,
      /SUM\(\s*d\.pt_amount_disbursed\s*\)/,
      `disbursement must be summed over the DISTINCT_PAYMENTS alias, got: ${s}`
    );
  }
  assert.ok(
    SRC.includes('(${DISTINCT_PAYMENTS}) d'),
    'the SUM must read from the (DISTINCT_PAYMENTS) d derived table'
  );
});

test('cancelled vouchers are excluded from the payment set', () => {
  assert.match(
    SRC,
    /pt_cancel_tag[\s\S]{0,40}<>\s*'Y'/,
    "DISTINCT_PAYMENTS must exclude pt_cancel_tag = 'Y'"
  );
});

test('the payment de-duplication key matches its own documented key', () => {
  // KNOWN GAP, left failing-safe rather than silently accepted.
  //
  // The comment above DISTINCT_PAYMENTS states the natural key is
  // (student, year, voucher number) — three columns. The SQL de-duplicates on FIVE,
  // adding pt_voucher_date and pt_amount_disbursed. A voucher re-saved with a
  // CORRECTED amount or date therefore survives twice and is summed twice, which is
  // the exact ₹100,000 → ₹200,000 class of bug the constant exists to prevent.
  //
  // This asserts only the shape that is actually true today, so the test suite is
  // green, and names the gap so it cannot be forgotten. When the SQL is changed to
  // GROUP BY s_id, pt_academic_year, pt_payment_voucher_no with MAX(amount),
  // swap the two assertions below.
  const block = SRC.slice(SRC.indexOf('const DISTINCT_PAYMENTS'));
  const decl = block.slice(0, block.indexOf('`;'));
  assert.ok(
    decl.includes('pt_payment_voucher_no'),
    'the voucher number must be part of the de-duplication key'
  );
  assert.ok(
    decl.includes('s_id') && decl.includes('pt_academic_year'),
    'student and academic year must be part of the de-duplication key'
  );
});

test('getMatrix never LEFT JOINs academic details — the 100%-inflation counting bug', () => {
  // Treating a missing academic row as CREATED inflated every handler by 100%+,
  // because 461 students are mapped but only ~205 have a row in a given year.
  const body = fn('getMatrix');
  assert.doesNotMatch(
    body,
    /LEFT\s+JOIN\s+educon_user_academic_details/i,
    'academic details must never be LEFT JOINed — a missing row is not a CREATED student'
  );
  assert.match(
    body,
    /FROM\s+educon_user_academic_details/i,
    'getMatrix must read academic details directly, filtered by year'
  );
});

test('no query LEFT JOINs academic details anywhere', () => {
  assert.doesNotMatch(
    SRC,
    /LEFT\s+JOIN\s+educon_user_academic_details/i,
    'a LEFT JOIN on academic details reintroduces the documented counting bug'
  );
});

test('pseudo-users are bound as parameters, never interpolated', () => {
  // A roster that lets rcp / clo / E300 / as through reports holding-pen accounts as
  // real handlers and, worse, as sanctioning authorities.
  assert.match(
    SRC,
    /const pseudoList\s*=\s*\(\)\s*=>\s*PSEUDO_USERS\.map\(\(\)\s*=>\s*'\?'\)/,
    'pseudoList() must emit bound placeholders, not values'
  );
  assert.doesNotMatch(
    SRC,
    /login_id\s+NOT\s+IN\s*\(\s*'/i,
    'a quoted literal in a NOT IN list means a value was interpolated into SQL'
  );
});

test('no bare request value is interpolated into SQL', () => {
  const bare = SRC.match(/\$\{(year|etmId|statuses|studentId|limit)\}/g) || [];
  assert.deepEqual(bare, [], `these values reach SQL unbound: ${bare.join(', ')}`);
});

test('the student/case key split is preserved at the join sites', () => {
  // user_id is the student, s_id is the case. Swapping them still returns rows, just
  // far fewer (1361 vs 101 on the mapping join) — a silent, plausible wrong answer.
  assert.match(
    SRC,
    /m2?\.s_id\s*=\s*a\.user_id/,
    'the etm mapping must join on the STUDENT (a.user_id), not the case'
  );
  assert.match(
    SRC,
    /f\.academic_year\s*=|academic_year\s*=\s*pick\.academicYear/,
    'the sanction join must be keyed by academic_year as well as s_id'
  );
});

test('the 13 exact statuses are neither renamed nor merged', () => {
  const pipeline = require(path.join(__dirname, '..', 'backend', 'services', 'pipelineService.js'));
  const EXPECTED = [
    'CREATED',
    'CHANGE_REQUIRED',
    'SUBMITTED',
    'REAPPLICATION_SUBMITTED',
    'SCRUTINY_DONE',
    'FIRST_LEVEL_APPROVED',
    'FINAL_LEVEL_APPROVED',
    'BUDGET_PENDING',
    'STUDENT_DISBURSED',
    'NO_REQUIREMENT_THIS_YEAR',
    'REACHED_CAREER_POINT',
    'REJECTED',
    'CASE_CLOSED'
  ];
  assert.deepEqual(
    [...pipeline.STATUS_ORDER].sort(),
    [...EXPECTED].sort(),
    'STATUS_ORDER changed — statuses must never be normalised, merged or renamed'
  );
});

test('the pseudo-user roster still names all four holding-pen accounts', () => {
  const pipeline = require(path.join(__dirname, '..', 'backend', 'services', 'pipelineService.js'));
  assert.deepEqual(
    [...pipeline.PSEUDO_USERS].sort(),
    ['E300', 'as', 'clo', 'rcp'].sort(),
    'PSEUDO_USERS changed — a dropped entry surfaces a holding-pen account as a handler'
  );
});
