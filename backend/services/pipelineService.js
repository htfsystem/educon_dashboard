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
        (SELECT m2.etm_id
           FROM educon_user_etm_mapping m2
           INNER JOIN educon_user_profile p2 ON p2.u_id = m2.etm_id
          WHERE m2.s_id = a.user_id
            AND p2.login_id NOT IN (${pseudoList()})
          ORDER BY m2.is_senior ASC, m2.etm_id ASC
          LIMIT 1) AS ownerId
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
  STATUS_ORDER,
  TERMINAL_STATUSES,
  PSEUDO_USERS,
  ATM_CODES,
  AGREED_MAX
};