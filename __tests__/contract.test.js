/**
 * The 7 reported columns are defined in the browser (frontend/js/columns.js) and the
 * 13 real statuses in the service. Nothing at runtime checks that they agree, so this
 * does — a typo or an upstream rename otherwise shows as a matrix cell with an empty
 * list behind it and no error anywhere.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const pipeline = require(path.join(ROOT, 'backend', 'services', 'pipelineService.js'));

/** Load a frontend classic script and return the globals it set on `window`. */
function loadBrowserScript(rel) {
  const code = fs.readFileSync(path.join(ROOT, 'frontend', rel), 'utf8');
  const sandbox = { window: {}, document: undefined, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: rel });
  return sandbox.window;
}

const { PIPELINE_COLUMNS } = loadBrowserScript('js/columns.js');

// The column set as the CODE actually has it, locked so an accidental edit is caught.
const EXPECTED_KEYS = [
  'CREATED',
  'SCRUTINY_PENDING',
  'APPROVAL_PENDING',
  'SANCTION_PENDING',
  'DISBURSEMENT_PENDING',
  'STUDENT_DISBURSED',
  'NO_REQUIREMENT_THIS_YEAR'
];

test('columns.js exposes PIPELINE_COLUMNS', () => {
  assert.ok(Array.isArray(PIPELINE_COLUMNS), 'window.PIPELINE_COLUMNS is not an array');
});

test('the reported column set has not changed by accident', () => {
  // Array.from() brings the value into this realm — a vm-context array has a different
  // Array.prototype and deepStrictEqual compares prototypes.
  assert.deepEqual(
    Array.from(PIPELINE_COLUMNS, c => c.key),
    EXPECTED_KEYS,
    'the reported columns changed — update EXPECTED_KEYS and CLAUDE.md together'
  );
});

test('every column status is one of the real DB statuses', () => {
  const real = new Set(pipeline.STATUS_ORDER);
  assert.ok(real.size > 0, 'pipelineService.STATUS_ORDER is empty');
  for (const col of PIPELINE_COLUMNS) {
    for (const s of col.statuses) {
      assert.ok(real.has(s), `column "${col.label}" names unknown status ${s}`);
    }
  }
});

test('no status is claimed by two columns', () => {
  const seen = new Map();
  for (const col of PIPELINE_COLUMNS) {
    for (const s of col.statuses) {
      assert.ok(!seen.has(s), `${s} is in both "${seen.get(s)}" and "${col.label}"`);
      seen.set(s, col.label);
    }
  }
});

test('the statuses excluded from reporting stay excluded', () => {
  const reported = new Set(PIPELINE_COLUMNS.flatMap(c => c.statuses));
  for (const s of ['BUDGET_PENDING', 'REJECTED', 'CASE_CLOSED', 'REACHED_CAREER_POINT']) {
    assert.ok(!reported.has(s), `${s} must not appear in any reported column`);
  }
});

test('every column has a key, a label and at least one status', () => {
  for (const col of PIPELINE_COLUMNS) {
    assert.ok(col.key, 'a column has no key');
    assert.ok(col.label, `column ${col.key} has no label`);
    assert.ok(col.statuses && col.statuses.length, `column ${col.key} has no statuses`);
  }
});
