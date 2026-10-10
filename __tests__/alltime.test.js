/**
 * The all-years tiles (Latest ID, Live, Live + RCP, RCP), asserted against the source.
 * Same approach as invariants.test.js: no database, so CI goes red if a rule is dropped.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const PIPE = read('backend', 'services', 'pipelineService.js');
const SERVER = read('backend', 'server.js');

const start = PIPE.indexOf('// ------------------------------------------------------------- all-time');
const end = PIPE.indexOf("* One student's money, per academic year.");
assert.ok(start !== -1 && end > start, 'all-time section not found - was it renamed?');
const ALL_TIME = PIPE.slice(start, end);

test('every function server.js calls for the all-years tiles is exported', () => {
  const svc = require('../backend/services/pipelineService.js');
  for (const name of ['getLatestStudent', 'getAllTimeTotals', 'getAllTimeStudentList', 'getUnassignedAccounts']) {
    assert.equal(typeof svc[name], 'function', `${name} is not exported - the route would fail at runtime`);
  }
  assert.ok(svc.ALL_TIME_POPULATIONS && svc.DUMMY_STUDENT_NUMBERS);
});

test('the dummy student numbers 9999 and 999 are excluded from "latest"', () => {
  assert.match(PIPE, /const DUMMY_STUDENT_NUMBERS\s*=\s*\[\s*9999\s*,\s*999\s*\]/);
  assert.match(ALL_TIME, /NOT IN \(\?\)/, 'the dummy list must be bound as a parameter');
});

test('every all-years query is limited to real students (not staff accounts)', () => {
  assert.match(ALL_TIME, /const REAL_STUDENT\s*=/);
  // latest, totals and list = three uses of the fragment
  const uses = ALL_TIME.match(/\$\{REAL_STUDENT\}/g) || [];
  assert.ok(uses.length >= 3, `REAL_STUDENT used ${uses.length}x, expected >= 3`);
});

test('dummy numbers are not real students, and every rejected profile is an unassigned account', () => {
  // A student is decided by ROLE (educon_student), minus the dummy numbers.
  assert.match(PIPE, /const studentOnly = col =>[\s\S]*roles_id = \$\{STUDENT_ROLE_ID\}[\s\S]*IN \(\$\{DUMMY_STUDENT_NUMBERS\.join\(', '\)\}\)/);
  assert.match(ALL_TIME, /const REAL_STUDENT = studentOnly\('p\.u_id'\)/);
  assert.match(ALL_TIME, /const NOT_REAL_STUDENT\s*=\s*`\(p\.login_id IS NULL OR NOT \(\$\{REAL_STUDENT\}\)\)`/);
  assert.match(ALL_TIME, /async function getUnassignedAccounts/);
});

test('the unassigned list is served without letting contact details out to a viewer', () => {
  const route = SERVER.slice(SERVER.indexOf("'/api/students/all-time'"), SERVER.indexOf("'/api/students/:studentId'"));
  assert.match(route, /population === 'unassigned'/);
  assert.match(route, /withContact: withMoney/);
});

test('students are counted once, never per year', () => {
  assert.match(ALL_TIME, /COUNT\(DISTINCT CASE WHEN/);
  assert.doesNotMatch(ALL_TIME, /LEFT JOIN educon_user_academic_details/,
    'the counting bug: never LEFT JOIN academic details');
});

test('Live, Live + RCP and RCP are the documented profile-status populations', () => {
  assert.match(ALL_TIME, /live:\s+`p\.u_status NOT IN \$\{PROFILE_TERMINAL\}`/);
  assert.match(ALL_TIME, /live_rcp:\s+`p\.u_status NOT IN \('CASE_CLOSED', 'REJECTED'\)`/);
  assert.match(ALL_TIME, /rcp:\s+`p\.u_status = 'REACHED_CAREER_POINT'`/);
});

test('Closed and Rejected are profile-status populations', () => {
  assert.match(ALL_TIME, /closed:\s+`p\.u_status = 'CASE_CLOSED'`/);
  assert.match(ALL_TIME, /rejected:\s+`p\.u_status = 'REJECTED'`/);
  assert.match(ALL_TIME, /WHERE p\.u_status = \?/, 'the per-year status is bound, never interpolated');
});

test('rcpTotal is a distinct count, not the sum of the per-year rows', () => {
  // A student with an RCP case in two years sits in both year rows (160 rows, 155 students).
  assert.doesNotMatch(ALL_TIME, /rcpTotal:\s*byYear/);
  assert.match(ALL_TIME, /rcpTotal:\s*Number\(t\.rcp\)/);
});

test('the all-time list route is declared before /api/students/:studentId', () => {
  const allTime = SERVER.indexOf("'/api/students/all-time'");
  const byId = SERVER.indexOf("'/api/students/:studentId'");
  assert.ok(allTime !== -1 && byId !== -1);
  assert.ok(allTime < byId, '"all-time" would be swallowed as a student id');
});

test('the population parameter is allow-listed and finance stays server-decided', () => {
  const route = SERVER.slice(SERVER.indexOf("'/api/students/all-time'"), SERVER.indexOf("'/api/students/:studentId'"));
  assert.match(route, /hasOwnProperty\.call\(pipeline\.ALL_TIME_POPULATIONS, population\)/);
  assert.match(route, /req\.user\.permissions\.includes\('view:finance'\)/);
});
