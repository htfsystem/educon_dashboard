/**
 * PIPELINE SERVICE  —  read-only analytics over educon_prod
 *
 * Single source of truth for the ETM/ATM x application_status matrix.
 * Every query here is SELECT-only; nothing in this file writes to the database.
 *
 * Why this replaces the old v1-v4 services:
 *   The previous services LEFT JOINed educon_user_academic_details on academic_year,
 *   so a student mapped to an ETM but with no record for the selected year fell
 *   through as 'CREATED'. 461 students are mapped but only ~205 have a record in any
 *   given year, so that inflated every ETM row by 100%+. We INNER JOIN instead: a
 *   student counts toward a year only if they actually have a row for that year.
 */

// System bucket accounts in educon_user_etm_mapping. These are not people — they are
// holding pens the application assigns cases to. Excluded from the roster.
const PSEUDO_USERS = ['rcp', 'clo', 'E300', 'as'];

// Alumni Team Members. The DB `role` table does not separate ATM from ETM (both hold
// 'sct'/'cm'), so team membership comes from the business roster.
const ATM_CODES = ['aas', 'apg', 'apps', 'aps', 'ark', 'atk', 'avms', 'ahm', 'aso', 'avs'];

// Agreed capacity per member. This is a commercial agreement, not a DB fact — there is
// no column for it in educon_prod. Keyed by login_id as it appears in the database.
const AGREED_MAX = {
  amg: 11, ams: 10, dd: 12, dmp: 0, js: 11, ks: 1, mj: 13, mp: 15, nig: 6, png: 3,
  pts: 6, rj: 5, rjv: 11, sas: 5, sss: 8, ss: 1, TS: 3, vk: 9, pmd962: 1, mk: 9,
  aas: 1, apg: 3, apps: 2, aps: 3, ark: 3, atk: 1, avms: 3, ahm: 2, aso: 6, avs: 5
};

// Pipeline order for column layout. Any status found in the DB but missing here is
// appended at the end, so a new status added upstream still shows up.
const STATUS_ORDER = [
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

// Which statuses represent a finished case, for the KPI strip.
const TERMINAL_STATUSES = [
  'STUDENT_DISBURSED', 'REACHED_CAREER_POINT', 'NO_REQUIREMENT_THIS_YEAR',
  'CASE_CLOSED', 'REJECTED'
];

const pseudoList = () => PSEUDO_USERS.map(() => '?').join(',');

function classify(loginId) {
  return ATM_CODES.includes(loginId) ? 'ATM' : 'ETM';
}

function displayName(row) {
  const name = `${row.u_fname || ''} ${row.u_lname || ''}`
    .replace(/[`,]/g, ' ')          // DB has "Manish Kumar," and "Timir Sanghvi`"
    .replace(/\s+/g, ' ')
    .trim();
  return name || row.login_id;
}

/** Academic years present in the data, newest first. */
async function getAcademicYears(pool) {
  const [rows] = await pool.query(`
    SELECT academic_year AS year, COUNT(DISTINCT user_id) AS students
    FROM educon_user_academic_details
    GROUP BY academic_year
    ORDER BY academic_year DESC
  `);
  return rows.map(r => ({ year: r.year, students: Number(r.students) }));
}

/** Every distinct application_status in the DB, ordered by pipeline position. */
async function getStatusCatalog(pool) {
  const [rows] = await pool.query(`
    SELECT DISTINCT application_status AS status
    FROM educon_user_academic_details
  `);
  const found = rows.map(r => r.status);
  const known = STATUS_ORDER.filter(s => found.includes(s));
  const extra = found.filter(s => !STATUS_ORDER.includes(s)).sort();
  return [...known, ...extra];
}

/** Exact per-status totals for one academic year (whole cohort, no ETM filter). */
async function getStatusTotals(pool, year) {
  const [rows] = await pool.query(`
    SELECT application_status AS status, COUNT(DISTINCT user_id) AS count
    FROM educon_user_academic_details
    WHERE academic_year = ?
    GROUP BY application_status
  `, [year]);

  const map = {};
  rows.forEach(r => { map[r.status] = Number(r.count); });
  return map;
}

/**
 * The matrix: one row per real ETM/ATM, one cell per status, for a single year.
 *
 * A student counts toward a member only if BOTH are true:
 *   - the member is that student's single responsible handler (see below)
 *   - the student has an educon_user_academic_details row for the selected year
 *
 * ONE HANDLER PER STUDENT — do not reintroduce the double count.
 * Verified in educon_prod for 2025-2026: 174 of 182 assigned students carry exactly
 * two mappings, one `is_senior = 1` (owning / fallback supervisor) and one
 * `is_senior = 0` (the person actually working the case). Counting every mapping —
 * which this function used to do — booked each of those students twice and inflated
 * whoever supervises the most cases: `dd` is senior owner on 147 students and showed
 * 148 against a real working load of 5.
 *
 * So each student is attributed to exactly one member: the working assignment
 * (`is_senior = 0`) when there is one, otherwise the senior owner. `ORDER BY
 * m2.is_senior ASC` does that selection; `m2.etm_id` only breaks ties so the pick is
 * deterministic. Member rows now partition the cohort and sum exactly to
 * `assignedDistinct`.
 */
async function getMatrix(pool, year) {
  const [rows] = await pool.query(`
    SELECT
      p.u_id           AS etmId,
      p.login_id       AS loginId,
      p.u_fname,
      p.u_lname,
      pick.status,
      COUNT(*) AS count
    FROM (
      SELECT
        a.user_id,
        a.application_status AS status,
        ${OWNER_PICK} AS ownerId
      FROM educon_user_academic_details a
      WHERE a.academic_year = ?
    ) pick
    INNER JOIN educon_user_profile p ON p.u_id = pick.ownerId
    GROUP BY p.u_id, p.login_id, p.u_fname, p.u_lname, pick.status
  `, [...PSEUDO_USERS, year]);

  const members = new Map();
  for (const r of rows) {
    if (!members.has(r.etmId)) {
      members.set(r.etmId, {
        etmId: r.etmId,
        loginId: r.loginId,
        name: displayName(r),
        team: classify(r.loginId),
        agreedMax: AGREED_MAX[r.loginId] ?? null,
        statuses: {},
        total: 0
      });
    }
    const m = members.get(r.etmId);
    m.statuses[r.status] = Number(r.count);
    m.total += Number(r.count);
  }

  // Members on the roster with zero students this year still deserve a row, so the
  // table shape stays stable as the year filter changes.
  const [roster] = await pool.query(`
    SELECT DISTINCT p.u_id AS etmId, p.login_id AS loginId, p.u_fname, p.u_lname
    FROM educon_user_etm_mapping m
    INNER JOIN educon_user_profile p ON p.u_id = m.etm_id
    WHERE p.login_id NOT IN (${pseudoList()})
  `, PSEUDO_USERS);

  for (const r of roster) {
    if (!members.has(r.etmId)) {
      members.set(r.etmId, {
        etmId: r.etmId,
        loginId: r.loginId,
        name: displayName(r),
        team: classify(r.loginId),
        agreedMax: AGREED_MAX[r.loginId] ?? null,
        statuses: {},
        total: 0
      });
    }
  }

  const list = [...members.values()].sort((a, b) => {
    if (a.team !== b.team) return a.team === 'ETM' ? -1 : 1;
    return b.total - a.total || a.name.localeCompare(b.name);
  });

  return list;
}

/**
 * Per-status counts for students who are real-person assigned (not held only by a
 * pseudo-user bucket), each counted once. This is the column-total row under the
 * matrix. Because `getMatrix` now attributes each student to exactly one handler, the
 * member rows sum to precisely these numbers — the footer is a true column total, not
 * an independent figure that happens to sit nearby.
 */
async function getAssignedStatusTotals(pool, year) {
  const [rows] = await pool.query(`
    SELECT a.application_status AS status, COUNT(DISTINCT a.user_id) AS count
    FROM educon_user_academic_details a
    INNER JOIN educon_user_etm_mapping m ON m.s_id = a.user_id
    INNER JOIN educon_user_profile p ON p.u_id = m.etm_id
    WHERE a.academic_year = ?
      AND p.login_id NOT IN (${pseudoList()})
    GROUP BY a.application_status
  `, [year, ...PSEUDO_USERS]);

  const map = {};
  rows.forEach(r => { map[r.status] = Number(r.count); });
  return map;
}

/**
 * Cross-checks so the UI can prove its own numbers rather than asking to be trusted.
 * Each student is attributed to a single handler, so `memberRowSum` must now equal
 * `assignedDistinct` exactly — if it does not, `getMatrix` has regressed to counting
 * a student under both their working handler and their senior owner.
 */
async function getReconciliation(pool, year) {
  const [[cohort]] = await pool.query(`
    SELECT COUNT(DISTINCT user_id) AS total
    FROM educon_user_academic_details WHERE academic_year = ?
  `, [year]);

  const [[assigned]] = await pool.query(`
    SELECT COUNT(DISTINCT a.user_id) AS total
    FROM educon_user_academic_details a
    INNER JOIN educon_user_etm_mapping m ON m.s_id = a.user_id
    INNER JOIN educon_user_profile p ON p.u_id = m.etm_id
    WHERE a.academic_year = ?
      AND p.login_id NOT IN (${pseudoList()})
  `, [year, ...PSEUDO_USERS]);

  const cohortTotal = Number(cohort.total);
  const assignedDistinct = Number(assigned.total);

  return {
    cohortTotal,
    assignedDistinct,
    unassigned: cohortTotal - assignedDistinct,
    sharedStudentNote: 'Each student is counted under exactly one handler — their working assignment (is_senior = 0) where one exists, otherwise their senior owner. Member rows therefore sum exactly to assignedDistinct.'
  };
}

/** Everything one dashboard render needs, in a single round trip. */
async function getYearReport(pool, year) {
  const [statuses, members, totals, assignedStatusTotals, reconciliation] = await Promise.all([
    getStatusCatalog(pool),
    getMatrix(pool, year),
    getStatusTotals(pool, year),
    getAssignedStatusTotals(pool, year),
    getReconciliation(pool, year)
  ]);

  const rowSum = members.reduce((s, m) => s + m.total, 0);

  return {
    academicYear: year,
    generatedAt: new Date().toISOString(),
    statuses,
    terminalStatuses: TERMINAL_STATUSES,
    statusTotals: totals,
    assignedStatusTotals,
    members,
    reconciliation: { ...reconciliation, memberRowSum: rowSum }
  };
}

// ---------------------------------------------------------------- drill-down
//
// KEY SHAPES — verified against educon_prod on 2026-08-27, do not re-derive:
//
//   educon_user_academic_details.user_id  is the STUDENT (the person).
//     -> joins educon_user_etm_mapping.s_id, educon_user_profile.u_id,
//        educon_student_personal_details.s_id, educon_payment_transaction_details.s_id
//   educon_user_academic_details.s_id     is the CASE row (one student, one year).
//     -> joins educon_student_final_approval_and_sanction.s_id (+ academic_year)
//
// The two are easy to swap and the wrong one still returns rows, just far fewer:
// 1361 vs 101 for the mapping join, 728 vs 23 for the sanction join.

/** The one-handler-per-student pick, shared with getMatrix. See that function's note. */
const OWNER_PICK = `
  (SELECT m2.etm_id
     FROM educon_user_etm_mapping m2
     INNER JOIN educon_user_profile p2 ON p2.u_id = m2.etm_id
    WHERE m2.s_id = a.user_id
      AND p2.login_id NOT IN (${pseudoList()})
    ORDER BY m2.is_senior ASC, m2.etm_id ASC
    LIMIT 1)`;

/**
 * A student's display name. educon_user_profile carries 461 of the 462 students and is
 * the only source with a readable code (login_id, e.g. "e617"), so it leads;
 * educon_student_personal_details (374 rows) fills the gaps.
 */
function studentName(row) {
  const fromProfile = `${row.u_fname || ''} ${row.u_lname || ''}`;
  const fromPersonal = `${row.sp_fname || ''} ${row.sp_lname || ''}`;
  const pick = fromProfile.trim() ? fromProfile : fromPersonal;
  const name = pick.replace(/[`,]/g, ' ').replace(/\s+/g, ' ').trim();
  return name || row.studentCode || `Student ${row.studentId}`;
}

/**
 * The students behind one number in the matrix.
 *
 * `etmId` null means the Grand Total row: every student a real person handles. That is
 * the same population `getAssignedStatusTotals` counts — a student has an owner in the
 * pick above exactly when they have at least one non-pseudo mapping — so a cell and its
 * list can never disagree about how many students there are.
 *
 * `statuses` is the exact DB status list behind the clicked column, sent by the client
 * from js/columns.js. Keeping it client-side is what stops the column definitions from
 * being duplicated on the server and drifting.
 */
async function getStudentList(pool, { year, etmId = null, statuses = [] }) {
  if (!statuses.length) return [];

  const statusList = statuses.map(() => '?').join(',');
  const ownerClause = etmId === null ? 'pick.ownerId IS NOT NULL' : 'pick.ownerId = ?';

  // Placeholder order follows the SQL text: the correlated pick (pseudo users) sits in
  // the SELECT list and so binds first, then the year, then the statuses, then the owner.
  const params = [...PSEUDO_USERS, year, ...statuses];
  if (etmId !== null) params.push(etmId);

  const [rows] = await pool.query(`
    SELECT
      pick.user_id      AS studentId,
      pick.caseId,
      pick.status,
      sp.login_id       AS studentCode,
      sp.u_fname, sp.u_lname,
      pd.sp_fname, pd.sp_lname,
      h.login_id        AS handlerLogin,
      h.u_fname         AS h_fname,
      h.u_lname         AS h_lname
    FROM (
      SELECT
        a.user_id,
        a.s_id                AS caseId,
        a.application_status  AS status,
        ${OWNER_PICK}         AS ownerId
      FROM educon_user_academic_details a
      WHERE a.academic_year = ?
        AND a.application_status IN (${statusList})
    ) pick
    LEFT JOIN educon_user_profile sp ON sp.u_id = pick.user_id
    LEFT JOIN educon_student_personal_details pd ON pd.s_id = pick.user_id
    LEFT JOIN educon_user_profile h  ON h.u_id  = pick.ownerId
    WHERE ${ownerClause}
  `, params);

  return rows
    .map(r => ({
      studentId: r.studentId,
      caseId: r.caseId,
      code: r.studentCode || String(r.studentId),
      name: studentName(r),
      status: r.status,
      handler: r.handlerLogin
        ? { loginId: r.handlerLogin, name: displayName({ u_fname: r.h_fname, u_lname: r.h_lname, login_id: r.handlerLogin }) }
        : null
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One student's money, per academic year.
 *
 * Sanctioned  MAX(amount_sanctioned) for the case, NOT SUM. 14 (case, year) groups carry
 *             more than one sanction row and in every one of them the amounts are
 *             identical — they are re-saves of the same decision, so summing would book
 *             a 50,000 sanction as 150,000.
 * Disbursed   SUM of the year's payment vouchers, cancelled ones excluded.
 * Pending     sanctioned - disbursed. Left signed rather than clamped: a few students
 *             are genuinely paid more than the year's sanction row records (top-ups
 *             paid without a fresh sanction), and hiding that would misreport the data.
 */
async function getStudentDetail(pool, studentId) {
  const [[who]] = await pool.query(`
    SELECT
      ? AS studentId,
      sp.login_id AS studentCode,
      sp.u_fname, sp.u_lname,
      pd.sp_fname, pd.sp_lname
    FROM (SELECT 1) one
    LEFT JOIN educon_user_profile sp ON sp.u_id = ?
    LEFT JOIN educon_student_personal_details pd ON pd.s_id = ?
  `, [studentId, studentId, studentId]);

  const [[owner]] = await pool.query(`
    SELECT p.login_id, p.u_fname, p.u_lname
    FROM educon_user_etm_mapping m
    INNER JOIN educon_user_profile p ON p.u_id = m.etm_id
    WHERE m.s_id = ? AND p.login_id NOT IN (${pseudoList()})
    ORDER BY m.is_senior ASC, m.etm_id ASC
    LIMIT 1
  `, [studentId, ...PSEUDO_USERS]);

  const [rows] = await pool.query(`
    SELECT
      a.academic_year       AS academicYear,
      a.s_id                AS caseId,
      a.application_status  AS status,
      COALESCE((SELECT MAX(f.amount_sanctioned)
                  FROM educon_student_final_approval_and_sanction f
                 WHERE f.s_id = a.s_id AND f.academic_year = a.academic_year), 0) AS sanctioned,
      COALESCE((SELECT SUM(p.pt_amount_disbursed)
                  FROM educon_payment_transaction_details p
                 WHERE p.s_id = a.user_id
                   AND p.pt_academic_year = a.academic_year
                   AND COALESCE(p.pt_cancel_tag, 'N') <> 'Y'), 0) AS disbursed
    FROM educon_user_academic_details a
    WHERE a.user_id = ?
    ORDER BY a.academic_year DESC
  `, [studentId]);

  return {
    studentId: Number(studentId),
    code: (who && who.studentCode) || String(studentId),
    name: studentName({ ...who, studentId }),
    handler: owner
      ? { loginId: owner.login_id, name: displayName({ ...owner }) }
      : null,
    years: rows.map(r => {
      const sanctioned = Number(r.sanctioned);
      const disbursed = Number(r.disbursed);
      return {
        academicYear: r.academicYear,
        status: r.status,
        sanctioned,
        disbursed,
        pending: sanctioned - disbursed
      };
    })
  };
}

/** Per-year totals across every academic year, for the trend chart. */
async function getYearTrend(pool) {
  const [rows] = await pool.query(`
    SELECT academic_year AS year, application_status AS status,
           COUNT(DISTINCT user_id) AS count
    FROM educon_user_academic_details
    GROUP BY academic_year, application_status
    ORDER BY academic_year
  `);

  const byYear = {};
  for (const r of rows) {
    byYear[r.year] = byYear[r.year] || { year: r.year, total: 0, statuses: {} };
    byYear[r.year].statuses[r.status] = Number(r.count);
    byYear[r.year].total += Number(r.count);
  }
  return Object.values(byYear).sort((a, b) => a.year.localeCompare(b.year));
}

module.exports = {
  getAcademicYears,
  getStatusCatalog,
  getStatusTotals,
  getAssignedStatusTotals,
  getMatrix,
  getReconciliation,
  getYearReport,
  getYearTrend,
  getStudentList,
  getStudentDetail,
  STATUS_ORDER,
  TERMINAL_STATUSES,
  PSEUDO_USERS,
  ATM_CODES,
  AGREED_MAX
};