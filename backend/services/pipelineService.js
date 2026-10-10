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

const codes = require('./codeLabels');

// System bucket accounts in educon_user_etm_mapping. These are not people — they are
// holding pens the application assigns cases to. Excluded from the roster.
const PSEUDO_USERS = ['rcp', 'clo', 'E300', 'as', 'rcp1819'];

// Alumni Team Members. The DB `role` table does not separate ATM from ETM (both hold
// 'sct'/'cm'), so team membership comes from the business roster.
const ATM_CODES = ['aas', 'apg', 'apps', 'aps', 'ark', 'atk', 'avms', 'ahm', 'aso', 'avs'];

// Team members who currently handle no students (asked for on 2026-10-10). They are left out
// of the matrix until they do: a year in which one of them holds a student shows them again,
// with no change here. (rcp1819, "Reached Careerpoint1819", is not one of these - it is a
// system bucket and lives in PSEUDO_USERS.)
const DORMANT_MEMBERS = ['ac', 'ap', 'd1', 'dm', 'kdd', 'mg', 'dd2', 'rg', 'sds', 'sms', 'vs', 'atk', 'ng'];

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

/* WHO IS A STUDENT — decided by ROLE, not by the shape of the code (2026-10-09).
 *
 * educon_user_profile holds students and staff alike; the app tells them apart with a role
 * in educon_user_profile_roles (role.id 1 = educon_student, 2 = sct, 3 = cm, 6 = admin).
 * Every figure that counts students filters on it, so staff accounts that carry a stray
 * academic row (dd, ks, rcp, ...) can never inflate a count. Two test accounts hold the
 * student role too (e9999 "Test Kumar", e999) and are excluded by their number; add a number
 * to DUMMY_STUDENT_NUMBERS to drop another.
 *
 * `studentOnly(col)` is a SQL condition on a profile id column, e.g. studentOnly('a.user_id').
 * Aliases sr / dp are private to it. */
const STUDENT_ROLE_ID = 1;
const STUDENT_ROLE_NAME = 'educon_student';
const ETM_ROLE_IDS = [2, 3];                    // sct, cm — the team members
const DUMMY_STUDENT_NUMBERS = [9999, 999];
const studentOnly = col => `(EXISTS (SELECT 1 FROM educon_user_profile_roles sr
            WHERE sr.users_u_id = ${col} AND sr.roles_id = ${STUDENT_ROLE_ID})
        AND NOT EXISTS (SELECT 1 FROM educon_user_profile dp
            WHERE dp.u_id = ${col} AND TRIM(dp.login_id) REGEXP '^[A-Za-z][0-9]+$'
              AND CAST(SUBSTRING(TRIM(dp.login_id), 2) AS UNSIGNED) IN (${DUMMY_STUDENT_NUMBERS.join(', ')})))`;

/** ETM or ATM — the business roster; the DB has no ATM role. Roles (sct, cm, admin) ride along as m.roles. */
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
    SELECT a.academic_year AS year, COUNT(DISTINCT a.user_id) AS students
    FROM educon_user_academic_details a
    WHERE ${studentOnly('a.user_id')}
    GROUP BY a.academic_year
    ORDER BY a.academic_year DESC
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

// Students whose profile status is one of these are counted in the summary rows
// (by u_status) and excluded from the application_status matrix, so they are
// never double-counted.
const PROFILE_TERMINAL = "('REACHED_CAREER_POINT', 'CASE_CLOSED', 'REJECTED')";

/** Exact per-status totals for one academic year (whole cohort, no ETM filter). */
async function getStatusTotals(pool, year) {
  const [rows] = await pool.query(`
    SELECT a.application_status AS status, COUNT(DISTINCT a.user_id) AS count
    FROM educon_user_academic_details a
    JOIN educon_user_profile ep ON ep.u_id = a.user_id
    WHERE a.academic_year = ?
      AND ep.u_status NOT IN ${PROFILE_TERMINAL}
      AND ${studentOnly('a.user_id')}
    GROUP BY a.application_status
  `, [year]);

  const map = {};
  rows.forEach(r => { map[r.status] = Number(r.count); });
  return map;
}

/**
 * Students whose PROFILE status (educon_user_profile.u_status) is REACHED_CAREER_POINT,
 * counted only among those who have an academic record for the selected year.
 *
 * This is a different population from application_status = 'REACHED_CAREER_POINT': the
 * profile status is set once on the student's profile row, while the case status is per
 * year and can be anything — STUDENT_DISBURSED, CHANGE_REQUIRED, etc. In 2025-2026 the
 * profile count is 52 against 20 on the case.
 */
async function getProfileStatusCounts(pool, year) {
  const [rows] = await pool.query(`
    SELECT p.u_status AS status, COUNT(DISTINCT a.user_id) AS count
    FROM educon_user_academic_details a
    JOIN educon_user_profile p ON p.u_id = a.user_id
    WHERE a.academic_year = ?
      AND ${studentOnly('a.user_id')}
      AND p.u_status IN ('REACHED_CAREER_POINT', 'CASE_CLOSED', 'REJECTED')
      AND (a.application_status = p.u_status
           OR (NOT EXISTS (
                 SELECT 1 FROM educon_user_academic_details a2
                 WHERE a2.user_id = a.user_id AND a2.application_status = p.u_status)
               AND a.academic_year = (
                 SELECT MAX(a3.academic_year) FROM educon_user_academic_details a3
                 WHERE a3.user_id = a.user_id)))
    GROUP BY p.u_status
  `, [year]);
  const counts = {};
  for (const r of rows) counts[r.status] = Number(r.count);
  return counts;
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
      JOIN educon_user_profile ep ON ep.u_id = a.user_id
      WHERE a.academic_year = ?
        AND ep.u_status NOT IN ${PROFILE_TERMINAL}
        AND ${studentOnly('a.user_id')}
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
        roles: [],
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
  // The roster is everyone holding the sct or cm role (the team members), not merely
  // whoever happens to be mapped to a student — so a member with no students this year still
  // has a row, and the roles each one holds are known.
  const [roster] = await pool.query(`
    SELECT p.u_id AS etmId, p.login_id AS loginId, p.u_fname, p.u_lname,
           GROUP_CONCAT(DISTINCT r.name ORDER BY r.id SEPARATOR ',') AS roles
    FROM educon_user_profile p
    JOIN educon_user_profile_roles pr ON pr.users_u_id = p.u_id AND pr.roles_id IN (${[...ETM_ROLE_IDS, 6].join(', ')})
    JOIN role r ON r.id = pr.roles_id
    WHERE p.login_id NOT IN (${pseudoList()})
      AND EXISTS (SELECT 1 FROM educon_user_profile_roles tm
                   WHERE tm.users_u_id = p.u_id AND tm.roles_id IN (${ETM_ROLE_IDS.join(', ')}))
    GROUP BY p.u_id, p.login_id, p.u_fname, p.u_lname
  `, PSEUDO_USERS);

  const rolesOf = new Map(roster.map(r => [r.etmId, String(r.roles).split(',')]));
  for (const r of roster) {
    if (!members.has(r.etmId)) {
      members.set(r.etmId, {
        etmId: r.etmId,
        loginId: r.loginId,
        name: displayName(r),
        team: classify(r.loginId),
        roles: [],
        agreedMax: AGREED_MAX[r.loginId] ?? null,
        statuses: {},
        total: 0
      });
    }
  }
  for (const m of members.values()) m.roles = rolesOf.get(m.etmId) || [];

  // A dormant member appears only in a year in which they hold at least one student.
  for (const [etmId, m] of members) {
    if (DORMANT_MEMBERS.includes(m.loginId) && m.total === 0) members.delete(etmId);
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
    JOIN educon_user_profile sp ON sp.u_id = a.user_id
    WHERE a.academic_year = ?
      AND p.login_id NOT IN (${pseudoList()})
      AND sp.u_status NOT IN ${PROFILE_TERMINAL}
      AND ${studentOnly('a.user_id')}
    GROUP BY a.application_status
  `, [year, ...PSEUDO_USERS]);

  const map = {};
  rows.forEach(r => { map[r.status] = Number(r.count); });
  return map;
}

/**
 * APPROVAL / SANCTION AUTHORITY — who signs off the cases a member is carrying.
 *
 * WHICH SOURCE, AND WHY. educon_prod holds the answer twice and the two disagree, so
 * this is a decision, not a lookup (verified 2026-09-07):
 *
 *   The *planned* authority — educon_user_profile.first_level_auth / sanctioning_auth,
 *   set on the STUDENT's profile row. Rejected. It agrees with what actually happened on
 *   only 442 of 736 decided cases for approval and 383 for sanction, and read off a
 *   handler's own profile row it is meaningless: all 30 roster members carry 300
 *   (Amit Educon) in every one of the three auth columns. Read off their students it
 *   splits a single member between two sanctioning authorities on 15 of 30 rows in
 *   2025-2026, so it cannot even fill one cell.
 *
 *   The *actual* authority — recorded on the case itself, which is what this uses:
 *     Approval  educon_student_first_level_approval.approval_id            (750 rows /
 *               750 distinct s_id, so one row per CASE and no fan-out; never NULL or '')
 *     Sanction  educon_student_final_approval_and_sanction
 *                 .sanctioning_authority_id                                (739 rows /
 *               723 (s_id, academic_year) keys — the same 14 re-saved duplicates the
 *               sanction *amount* carries. SELECT DISTINCT collapses them; verified that
 *               no duplicated key differs on the authority, so nothing is lost.)
 *
 * Both columns hold a login_id, not a numeric id. login_id is unique across all 462
 * educon_user_profile rows and never NULL, so joining on it fans nothing out, and every
 * code present resolves to a real person — only four ever appear as an approver
 * (dd 710, ss 37, sss 2, ks 1) and three as a sanctioner (ks 706, dd 20, mp 13).
 *
 * SHAPE. An authority is a fact about a case, not about a member, so a member row can
 * legitimately name more than one — and does: 6 of 24 members in 2022-2023 for approval,
 * 7 of 26 in 2026-2027 for sanction. The set is returned in full, commonest first, and
 * the client shows the leader with a "+N". An empty array means no case of theirs has
 * reached that stage this year, which the client prints as an em dash rather than as a
 * name it does not have.
 *
 * The counts are over every case the member holds for the year, including the statuses
 * the 7 reported columns exclude, so they are deliberately not comparable with the Total
 * column — the client's tooltip says "cases", never "of total".
 */
async function getAuthorities(pool, year) {
  const [rows] = await pool.query(`
    SELECT
      pick.ownerId               AS etmId,
      fl.approval_id             AS approvalCode,
      ap.u_fname AS ap_fname, ap.u_lname AS ap_lname,
      san.sanctioning_authority_id AS sanctionCode,
      sn.u_fname AS sn_fname, sn.u_lname AS sn_lname,
      COUNT(*) AS cases
    FROM (
      SELECT
        a.s_id          AS caseId,
        a.academic_year AS academicYear,
        ${OWNER_PICK}   AS ownerId
      FROM educon_user_academic_details a
      JOIN educon_user_profile ep ON ep.u_id = a.user_id
      WHERE a.academic_year = ?
        AND ep.u_status NOT IN ${PROFILE_TERMINAL}
        AND ${studentOnly('a.user_id')}
    ) pick
    LEFT JOIN educon_student_first_level_approval fl ON fl.s_id = pick.caseId
    LEFT JOIN (
      SELECT DISTINCT s_id, academic_year, sanctioning_authority_id
        FROM educon_student_final_approval_and_sanction
    ) san ON san.s_id = pick.caseId AND san.academic_year = pick.academicYear
    LEFT JOIN educon_user_profile ap ON ap.login_id = fl.approval_id
    LEFT JOIN educon_user_profile sn ON sn.login_id = san.sanctioning_authority_id
    WHERE pick.ownerId IS NOT NULL
    GROUP BY pick.ownerId,
             fl.approval_id, ap.u_fname, ap.u_lname,
             san.sanctioning_authority_id, sn.u_fname, sn.u_lname
  `, [...PSEUDO_USERS, year]);

  const byMember = new Map();
  const overall = { approval: new Map(), sanction: new Map() };

  // A code with no profile row falls through to itself rather than to a guess — the same
  // rule codeLabels.js follows. It does not happen today; it must not become a fabrication
  // if EduCon adds an approver tomorrow.
  const tally = (bucket, code, fname, lname, n) => {
    if (!code) return;                            // case not yet at this stage
    const seen = bucket.get(code);
    if (seen) { seen.cases += n; return; }
    bucket.set(code, {
      loginId: code,
      name: displayName({ u_fname: fname, u_lname: lname, login_id: code }),
      cases: n
    });
  };

  for (const r of rows) {
    const n = Number(r.cases);
    if (!byMember.has(r.etmId)) {
      byMember.set(r.etmId, { approval: new Map(), sanction: new Map() });
    }
    const m = byMember.get(r.etmId);
    tally(m.approval, r.approvalCode, r.ap_fname, r.ap_lname, n);
    tally(m.sanction, r.sanctionCode, r.sn_fname, r.sn_lname, n);
    tally(overall.approval, r.approvalCode, r.ap_fname, r.ap_lname, n);
    tally(overall.sanction, r.sanctionCode, r.sn_fname, r.sn_lname, n);
  }

  // Commonest first, then by name, so the leader the client shows is stable across
  // renders and a tie never reshuffles between two refreshes.
  const rank = bucket => [...bucket.values()]
    .sort((a, b) => b.cases - a.cases || a.name.localeCompare(b.name));
  const pack = pair => ({ approval: rank(pair.approval), sanction: rank(pair.sanction) });

  const members = {};
  for (const [etmId, pair] of byMember) members[etmId] = pack(pair);
  return { members, overall: pack(overall) };
}

const NO_AUTHORITY = { approval: [], sanction: [] };

/**
 * Cross-checks so the UI can prove its own numbers rather than asking to be trusted.
 * Each student is attributed to a single handler, so `memberRowSum` must now equal
 * `assignedDistinct` exactly — if it does not, `getMatrix` has regressed to counting
 * a student under both their working handler and their senior owner.
 */
async function getReconciliation(pool, year) {
  const [[cohort]] = await pool.query(`
    SELECT COUNT(DISTINCT a.user_id) AS total
    FROM educon_user_academic_details a
    JOIN educon_user_profile ep ON ep.u_id = a.user_id
    WHERE a.academic_year = ?
      AND ep.u_status NOT IN ${PROFILE_TERMINAL}
      AND ${studentOnly('a.user_id')}
  `, [year]);

  const [[assigned]] = await pool.query(`
    SELECT COUNT(DISTINCT a.user_id) AS total
    FROM educon_user_academic_details a
    INNER JOIN educon_user_etm_mapping m ON m.s_id = a.user_id
    INNER JOIN educon_user_profile p ON p.u_id = m.etm_id
    JOIN educon_user_profile sp ON sp.u_id = a.user_id
    WHERE a.academic_year = ?
      AND p.login_id NOT IN (${pseudoList()})
      AND sp.u_status NOT IN ${PROFILE_TERMINAL}
      AND ${studentOnly('a.user_id')}
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
  const [statuses, members, totals, assignedStatusTotals, reconciliation, authorities, profileStatusCounts] = await Promise.all([
    getStatusCatalog(pool),
    getMatrix(pool, year),
    getStatusTotals(pool, year),
    getAssignedStatusTotals(pool, year),
    getReconciliation(pool, year),
    getAuthorities(pool, year),
    getProfileStatusCounts(pool, year)
  ]);

  const rowSum = members.reduce((s, m) => s + m.total, 0);

  for (const m of members) {
    m.authorities = authorities.members[m.etmId] || NO_AUTHORITY;
  }

  return {
    academicYear: year,
    generatedAt: new Date().toISOString(),
    statuses,
    terminalStatuses: TERMINAL_STATUSES,
    statusTotals: totals,
    assignedStatusTotals,
    profileStatusCounts,
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

/**
 * Payment vouchers, de-duplicated. DO NOT SUM THE TABLE DIRECTLY.
 *
 * educon_payment_transaction_details holds 31 groups (32 extra rows) where one voucher
 * was saved twice: identical student, year, voucher number, voucher date, amount, bank
 * transaction id and cheque number — only pt_id differs, so pt_id being unique is no
 * protection. A plain SUM booked ₹100,000 paid to student 22292 as ₹200,000, and
 * inflated 2025-2026 by ₹463,019.
 *
 * The natural key is (student, year, voucher number). Verified safe: there is no group
 * sharing that key with a differing amount or purpose, so no genuine split payment is
 * lost, and no voucher number is NULL or 0.
 */
const DISTINCT_PAYMENTS = `
  SELECT DISTINCT s_id, pt_academic_year, pt_payment_voucher_no,
                  pt_voucher_date, pt_amount_disbursed
    FROM educon_payment_transaction_details
   WHERE COALESCE(pt_cancel_tag, 'N') <> 'Y'`;

/** The one-handler-per-student pick, shared with getMatrix. See that function's note. */
const OWNER_PICK = `
  (SELECT m2.etm_id
     FROM educon_user_etm_mapping m2
     INNER JOIN educon_user_profile p2 ON p2.u_id = m2.etm_id
    WHERE m2.s_id = a.user_id
      AND p2.login_id NOT IN (${pseudoList()})
    ORDER BY m2.is_senior ASC, m2.etm_id ASC
    LIMIT 1)`;

// ------------------------------------------------------- the student's own profile
//
// KEYS — verified 2026-08-28 by joining each table both ways and counting. Two families,
// and getting one wrong loses most of the rows without erroring:
//
//   per STUDENT, keyed by educon_user_academic_details.user_id (one row, lifetime)
//     educon_student_personal_details          374 rows / 374 keys  (1234 vs 75)
//     educon_student_current_address_details   378 rows / 378 keys  (1248 vs 77)
//
//   per CASE, keyed by educon_user_academic_details.s_id (one row per student-year)
//     educon_student_current_education_details 940 rows / 940 keys  (939 vs 198)
//
// Every one of these is one row per key, so none of them fans out a join. That is why
// the education fields can be joined straight into the student list rather than
// aggregated: what a student studies is a fact about the *year*, and the case id is what
// carries the year.
const PROFILE_JOINS = `
  LEFT JOIN educon_student_current_education_details ce ON ce.s_id = %CASE%
  LEFT JOIN educon_student_current_address_details   ad ON ad.s_id = %STUDENT%`;

/**
 * The two authorities, per CASE — the same sources getAuthorities() uses on the matrix,
 * and for the same reason: who ACTUALLY signed the case off, never the *planned*
 * authority on the student's profile row (see that function's note for the evidence).
 *
 * Moved down to the student on 2026-09-08, at the user's request: an authority is a fact
 * about a case, so it belongs beside the student whose case it is rather than aggregated
 * into a member's row on the summary sheet.
 *
 * Neither join fans out. `educon_student_first_level_approval` is one row per case (750 /
 * 750) and carries no academic_year — the case already is the year. The sanction table
 * carries the same 14 re-saved (s_id, academic_year) duplicates the amount does, so it is
 * read through SELECT DISTINCT; verified that no duplicated key differs on the authority.
 * Both columns hold a login_id, which is unique and never NULL across all 462 profile
 * rows, so the two name lookups fan nothing out either.
 */
const AUTHORITY_JOINS = `
  LEFT JOIN educon_student_first_level_approval fl ON fl.s_id = pick.caseId
  LEFT JOIN (
    SELECT DISTINCT s_id, academic_year, sanctioning_authority_id
      FROM educon_student_final_approval_and_sanction
  ) san ON san.s_id = pick.caseId AND san.academic_year = pick.academicYear
  LEFT JOIN educon_user_profile ap ON ap.login_id = fl.approval_id
  LEFT JOIN educon_user_profile sn ON sn.login_id = san.sanctioning_authority_id
  LEFT JOIN educon_user_profile pap ON pap.u_id = sp.first_level_auth
  LEFT JOIN educon_user_profile psn ON psn.u_id = sp.sanctioning_auth`;

/* ---------- The ASSIGNED authority, for a case nobody has signed yet (2026-09-08) ----
 *
 * Asked for directly: a CREATED student already has an approving and a sanctioning
 * authority assigned, and the columns were blank for them. They were blank because the
 * case-level tables record what HAPPENED, and nothing has happened yet — zero of the 178
 * CREATED cases carry a first-level-approval or a sanction row. The answer is on the
 * STUDENT's profile row instead: educon_user_profile.first_level_auth / sanctioning_auth,
 * the *planned* authority, which is set for every one of them.
 *
 * THIS IS THE SOURCE THE MATRIX DELIBERATELY REJECTED, and the reason it is right here and
 * wrong there is worth keeping straight. On the matrix it competed with the actual
 * authority and lost — it agrees with what really happened on only 442 of 736 decided
 * cases. Here it never competes: it is read ONLY when the case has no actual authority, so
 * there is nothing for it to disagree with, and it is the sole answer to "who is this
 * student assigned to". The actual authority always wins where one exists.
 *
 * The two are still marked apart rather than blended — `assigned: true` on the fallback,
 * which the client prints in a muted style with "assigned, not yet approved" on hover.
 * "dd will approve this" and "dd approved this" are different claims and the list must not
 * make them look like one.
 *
 * PSEUDO-USERS ARE SUPPRESSED. The planned columns hold a numeric u_id (unlike the
 * case-level columns, which hold a login_id) and 87 of the 177 unapproved CREATED cases
 * point at a holding-pen account — E300 Amit Educon, rcp Reached Carierpoint, clo Closed
 * Rejected. Those are not approvers, and "clo" under Sanction auth would be a fabrication,
 * so they fall back to blank exactly as before. What is left is real: 73 of the 74 CREATED
 * cases in 2026-2027 read dd for approval and ks or mp for sanction — the same people who
 * actually sign (dd 710 approvals; ks 706 and mp 13 sanctions).
 */
const isPseudo = loginId => PSEUDO_USERS.includes(loginId);

/**
 * One authority. The actual signer where the case has one; otherwise the authority
 * assigned on the student's profile, marked as such. Null when neither is available or
 * the assigned one is a holding-pen account (except 'rcp', which is shown — its auth
 * columns carry real meaning on students assigned to the RCP bucket).
 */
const authority = (code, fname, lname, planned) => {
  if (code) {
    return { loginId: code, name: displayName({ u_fname: fname, u_lname: lname, login_id: code }), assigned: false };
  }
  if (!planned || !planned.login_id) return null;
  if (isPseudo(planned.login_id) && planned.login_id !== 'rcp') return null;
  return {
    loginId: planned.login_id,
    name: displayName({ u_fname: planned.fname, u_lname: planned.lname, login_id: planned.login_id }),
    assigned: true
  };
};

const PROFILE_COLUMNS = `
  ce.sce_education, ce.sce_branch, ce.sce_course_name, ce.sce_board,
  ce.sce_name AS collegeName,
  ce.sce_college_place, ce.sce_year, ce.current_year,
  pd.sp_gender_category_id, pd.sp_minority_id, pd.sp_food_category_id, pd.sp_family_status,
  ad.spa_city, ad.spa_district, ad.spa_state,
  ad.sa_city,  ad.sa_district,  ad.sa_state`;

/**
 * The twelve facts card 1 reports, decoded.
 *
 * Everything coded goes through codeLabels.js, which falls back to the raw code rather
 * than to a guess — see the confidence tiers documented there. `null` means the student
 * did not answer or has no row, and the client prints one "Not recorded" for all of them.
 *
 * PARENT LOCATION is the *permanent* address (spa_*), not the current one (sa_*): a
 * student living in a Pune hostel still has parents in Junnar, and the current address
 * is the student's. 255 of 378 rows are flagged identical anyway. It falls back to the
 * current address for the 5 rows with no permanent city, so the field is filled wherever
 * the database knows anything at all.
 */
function studentProfile(row) {
  if (!row) return null;
  return {
    education: codes.label(codes.EDUCATION, row.sce_education),
    fieldOfEducation: codes.label(codes.FIELD_OF_EDUCATION, row.sce_branch),
    specialization: codes.label(codes.SPECIALIZATION, row.sce_course_name),
    // Board for a school student (SSC, CBSE), awarding university for everyone else —
    // one column in the application, one list of codes, so one field here.
    board: codes.label(codes.BOARD, row.sce_board),
    college: codes.text(row.collegeName),
    studyYear: codes.studyYear(row.sce_year, row.current_year),
    collegeCity: codes.text(row.sce_college_place),
    gender: codes.label(codes.GENDER, row.sp_gender_category_id),
    community: codes.casteGroup(row.sp_minority_id),
    // The specific community answer sits beside the Jain / Non-Jain reduction rather
    // than being replaced by it — the brief says the source is a list of many.
    communityDetail: codes.label(codes.CASTE, row.sp_minority_id),
    food: codes.label(codes.FOOD, row.sp_food_category_id),
    familyStatus: codes.label(codes.FAMILY_STATUS, row.sp_family_status),
    parentLocation: codes.place(row.spa_city, row.spa_district, row.spa_state)
      || codes.place(row.sa_city, row.sa_district, row.sa_state)
  };
}

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
 *
 * `withMoney` adds the case-year's sanctioned / disbursed / pending figures to every row.
 * It is set from the caller's `view:finance` permission, not from a query parameter: a
 * viewer may open the list behind a cell but not the amounts in it, exactly as they may
 * not open one student's amounts (see /api/students/:id). The two subqueries are the same
 * ones getStudentDetail uses — MAX for the sanction, a sum over DISTINCT_PAYMENTS for the
 * disbursement — so a student's row in this list and their own card cannot disagree.
 */
async function getStudentList(pool, { year, etmId = null, statuses = [], withMoney = false, scope = 'assigned', statusSource = 'case' }) {
  if (!statuses.length) return [];

  const statusList = statuses.map(() => '?').join(',');

  /* WHICH POPULATION. `scope` is passed in by the caller rather than inferred from the
     statuses, so the number on screen and the list behind it are driven by the same
     decision. A member cell always means that member, whatever the scope says.
       assigned   — students a real person handles. The member rows and Live Total Student.
       unassigned — students held only by a pseudo-user bucket (rcp/clo/E300/as), so
                    OWNER_PICK found nobody. The "Unassigned (no ETM)" row.
       all        — both. The RCP / Closed / Rejected rows and the Grand Total, which
                    count the whole cohort because those cases are mostly parked on a
                    holding-pen account and would otherwise read as zero. */
  const SCOPE_CLAUSE = {
    assigned:   'pick.ownerId IS NOT NULL',
    unassigned: 'pick.ownerId IS NULL',
    all:        '1=1'
  };
  const ownerClause = etmId === null
    ? (SCOPE_CLAUSE[scope] || SCOPE_CLAUSE.assigned)
    : 'pick.ownerId = ?';

  /* STATUS SOURCE.
       case    — the default: filter on application_status (per-year case status).
       profile — filter on educon_user_profile.u_status (profile-level status). Used for
                 the RCP summary row, because the profile records who has reached career
                 point even when the year's case status says something else.
       grand   — the Grand Total: matches students whose application_status is in the list
                 OR whose u_status is REACHED_CAREER_POINT. Covers both populations without
                 double-counting (DISTINCT). */
  const useProfile = statusSource === 'profile';
  const useGrand   = statusSource === 'grand';

  const profileJoin = (useProfile || useGrand)
    ? 'JOIN educon_user_profile pf ON pf.u_id = a.user_id'
    : 'JOIN educon_user_profile pf ON pf.u_id = a.user_id';

  const FALLBACK_LATEST = `(NOT EXISTS (
              SELECT 1 FROM educon_user_academic_details ax
              WHERE ax.user_id = a.user_id AND ax.application_status = pf.u_status)
            AND a.academic_year = (
              SELECT MAX(ay.academic_year) FROM educon_user_academic_details ay
              WHERE ay.user_id = a.user_id))`;

  const statusFilter = useProfile
    ? `pf.u_status IN (${statusList}) AND (a.application_status = pf.u_status OR ${FALLBACK_LATEST})`
    : useGrand
      ? `((a.application_status IN (${statusList}) AND pf.u_status NOT IN ${PROFILE_TERMINAL})
          OR (pf.u_status IN ${PROFILE_TERMINAL} AND (a.application_status = pf.u_status OR ${FALLBACK_LATEST})))`
      : `a.application_status IN (${statusList}) AND pf.u_status NOT IN ${PROFILE_TERMINAL}`;

  // Placeholder order follows the SQL text: the correlated pick (pseudo users) sits in
  // the SELECT list and so binds first, then the year, then the statuses, then the owner.
  const params = [...PSEUDO_USERS, year, ...statuses];
  if (etmId !== null) params.push(etmId);

  /* Correlated against `pick`, and deliberately carrying NO placeholders of their own.
     They sit in the outer SELECT list, which is textually ahead of the derived table that
     binds PSEUDO_USERS and the year — a `?` here would take those parameters instead. The
     year is therefore read off `pick.academicYear` rather than bound a second time. */
  const moneyColumns = withMoney ? `,
      COALESCE((SELECT MAX(f.amount_sanctioned)
                  FROM educon_student_final_approval_and_sanction f
                 WHERE f.s_id = pick.caseId
                   AND f.academic_year = pick.academicYear), 0) AS sanctioned,
      COALESCE((SELECT SUM(d.pt_amount_disbursed) FROM (${DISTINCT_PAYMENTS}) d
                 WHERE d.s_id = pick.user_id
                   AND d.pt_academic_year = pick.academicYear), 0) AS disbursed,
      COALESCE((SELECT COUNT(DISTINCT d2.pt_academic_year) FROM (${DISTINCT_PAYMENTS}) d2
                 WHERE d2.s_id = pick.user_id), 0) AS supportYears,
      COALESCE((SELECT SUM(d3.pt_amount_disbursed) FROM (${DISTINCT_PAYMENTS}) d3
                 WHERE d3.s_id = pick.user_id), 0) AS cumulativeDisbursed` : '';

  /* Pseudo handler fallback: when OWNER_PICK found no real person, find which pseudo-user
     bucket (rcp/clo/E300/as) the student is mapped to. Literal strings, no placeholders. */
  const PSEUDO_PICK = `
      (SELECT m3.etm_id
         FROM educon_user_etm_mapping m3
         INNER JOIN educon_user_profile p3 ON p3.u_id = m3.etm_id
        WHERE m3.s_id = a.user_id
          AND p3.login_id IN ('rcp','clo','E300','as','rcp1819')
        ORDER BY m3.etm_id ASC
        LIMIT 1)`;

  const [rows] = await pool.query(`
    SELECT
      pick.user_id      AS studentId,
      pick.caseId,
      pick.status,
      sp.login_id       AS studentCode,
      sp.u_fname, sp.u_lname,
      sp.u_status       AS profileStatus,
      pd.sp_fname, pd.sp_lname,
      h.login_id        AS handlerLogin,
      h.u_fname         AS h_fname,
      h.u_lname         AS h_lname,
      ph.login_id       AS pseudoHandlerLogin,
      ph.u_fname        AS ph_fname,
      ph.u_lname        AS ph_lname,
      (SELECT GROUP_CONCAT(DISTINCT hr.name ORDER BY hr.id SEPARATOR ',')
         FROM educon_user_profile_roles hpr JOIN role hr ON hr.id = hpr.roles_id
        WHERE hpr.users_u_id = pick.ownerId AND hpr.roles_id IN (${ETM_ROLE_IDS.join(', ')})) AS handlerRoles,
      fl.approval_id             AS approvalCode,
      ap.u_fname AS ap_fname, ap.u_lname AS ap_lname,
      san.sanctioning_authority_id AS sanctionCode,
      sn.u_fname AS sn_fname, sn.u_lname AS sn_lname,
      pap.login_id AS pap_login, pap.u_fname AS pap_fname, pap.u_lname AS pap_lname,
      psn.login_id AS psn_login, psn.u_fname AS psn_fname, psn.u_lname AS psn_lname,
      ${PROFILE_COLUMNS}${moneyColumns}
    FROM (
      SELECT
        a.user_id,
        a.s_id                AS caseId,
        a.academic_year       AS academicYear,
        a.application_status  AS status,
        ${OWNER_PICK}         AS ownerId,
        ${PSEUDO_PICK}        AS pseudoOwnerId
      FROM educon_user_academic_details a
      ${profileJoin}
      WHERE a.academic_year = ?
        AND ${statusFilter}
        AND ${studentOnly('a.user_id')}
    ) pick
    LEFT JOIN educon_user_profile sp ON sp.u_id = pick.user_id
    LEFT JOIN educon_student_personal_details pd ON pd.s_id = pick.user_id
    LEFT JOIN educon_user_profile h  ON h.u_id  = pick.ownerId
    LEFT JOIN educon_user_profile ph ON ph.u_id = pick.pseudoOwnerId
    ${AUTHORITY_JOINS}
    ${PROFILE_JOINS.replace('%CASE%', 'pick.caseId').replace('%STUDENT%', 'pick.user_id')}
    WHERE ${ownerClause}
  `, params);

  return rows
    .map(r => {
      const row = {
        studentId: r.studentId,
        caseId: r.caseId,
        code: r.studentCode || String(r.studentId),
        role: STUDENT_ROLE_NAME,
        name: studentName(r),
        status: useProfile
          ? (r.profileStatus || r.status)
          : (useGrand && ['REACHED_CAREER_POINT', 'CASE_CLOSED', 'REJECTED'].includes(r.profileStatus))
            ? r.profileStatus
            : r.status,
        profileStatus: r.profileStatus || null,
        handler: r.handlerLogin
          ? { loginId: r.handlerLogin, name: displayName({ u_fname: r.h_fname, u_lname: r.h_lname, login_id: r.handlerLogin }),
            roles: r.handlerRoles ? String(r.handlerRoles).split(',') : [] }
          : r.pseudoHandlerLogin
            ? { loginId: r.pseudoHandlerLogin, name: displayName({ u_fname: r.ph_fname, u_lname: r.ph_lname, login_id: r.pseudoHandlerLogin }), pseudo: true }
            : null,
        // Carried on every row, like the handler: the case is what has an approver, so a
        // list opened from a member cell and one opened from the Grand Total row read the
        // same. Who actually signed where the case has been signed; otherwise who is
        // assigned to (`assigned: true`), which is what fills these columns for a CREATED
        // student. Null only when neither is known — an absence, printed as an em dash,
        // never a guess at who will sign it.
        approvalAuth: authority(r.approvalCode, r.ap_fname, r.ap_lname,
          { login_id: r.pap_login, fname: r.pap_fname, lname: r.pap_lname }),
        sanctionAuth: authority(r.sanctionCode, r.sn_fname, r.sn_lname,
          { login_id: r.psn_login, fname: r.psn_fname, lname: r.psn_lname }),
        profile: studentProfile(r)
      };

      if (withMoney) {
        const sanctioned = Number(r.sanctioned);
        const disbursed = Number(r.disbursed);
        // Nested rather than flattened, so the client can tell "this payload carries no
        // amounts" (a viewer) from "this student's amounts are zero" — the first hides
        // the columns, the second prints three zeroes.
        // Pending stays signed for the same reason it does on the student card: some
        // students are paid more in a year than that year's sanction row records, and a
        // column of clamped zeroes would hide it. The UI relabels rather than rounds.
        row.money = {
          sanctioned, disbursed, pending: sanctioned - disbursed,
          supportYears: Number(r.supportYears),
          cumulativeDisbursed: Number(r.cumulativeDisbursed)
        };
      }
      return row;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ------------------------------------------------------------- all-time (every year)
//
// The figures above are all scoped to one academic year. These are not: they answer
// "how many students, ever" and count each student ONCE however many years they appear in.
// Population is decided by the PROFILE status (educon_user_profile.u_status) — one value
// per student — so a student with five year-rows cannot be counted five times.

// DUMMY_STUDENT_NUMBERS (e9999 "Test Kumar", e999) is declared at the top with studentOnly().

/* A REAL STUDENT. educon_user_profile holds students AND staff, and 46 staff accounts
   (dd, ks, rcp, clo, as, ...) carry a stray CREATED academic row each, so without this
   they are counted as "live students". A student's code is one letter and digits (e617,
   E747; one is stored padded as ' e682 ', hence TRIM) and a student is never a handler in
   educon_user_etm_mapping — that also drops E300, the one pseudo-user shaped like a student.
   Verified 2026-10-08: 217 -> 170 live, 372 -> 325 live + RCP, RCP unchanged at 155.
   Since 2026-10-09 the dummy numbers (e9999 "Test Kumar", e999) are not real students either:
   they were being counted as live / rejected students. They, with every other account this
   rejects, are listed under "Unassigned Accounts" (getUnassignedAccounts). */
const REAL_STUDENT = studentOnly('p.u_id');

// Every profile REAL_STUDENT rejects — the "unassigned accounts".
const NOT_REAL_STUDENT = `(p.login_id IS NULL OR NOT (${REAL_STUDENT}))`;

// The "Unassigned accounts" list is only the system buckets (rcp, clo, E300, as) and the test
// accounts (a student-shaped code with a dummy number, e.g. e9999). Team members and other
// staff are not students either, but were removed from the list on 2026-10-09 at the user's
// request. Needs the PSEUDO_USERS placeholders bound once wherever it is used.
const UNASSIGNED_ACCOUNT = `${NOT_REAL_STUDENT}
      AND (p.login_id IN (${pseudoList()})
           OR EXISTS (SELECT 1 FROM educon_user_profile_roles tr
                       WHERE tr.users_u_id = p.u_id AND tr.roles_id = ${STUDENT_ROLE_ID}))`;

// population -> profile-status filter. Literals, never user input.
const ALL_TIME_POPULATIONS = {
  live:     `p.u_status NOT IN ${PROFILE_TERMINAL}`,
  live_rcp: `p.u_status NOT IN ('CASE_CLOSED', 'REJECTED')`,
  rcp:      `p.u_status = 'REACHED_CAREER_POINT'`,
  closed:   `p.u_status = 'CASE_CLOSED'`,
  rejected: `p.u_status = 'REJECTED'`
};

/**
 * The latest real student ID (login_id like "e792"): the highest number in the running
 * sequence. Not simply the largest number — e987 is a hand-entered outlier that would show
 * forever — and not the newest u_id either (old codes such as e485 get re-created late). The
 * next registrations (e793, e794, ...) extend the run and take over automatically.
 * Dummy numbers are excluded by the student filter. Only profiles that also have an
 * academic record qualify, so the student can be opened.
 */
const LATEST_RUN_GAP = 10;
async function getLatestStudent(pool) {
  const [rows] = await pool.query(`
    SELECT p.u_id AS studentId, TRIM(p.login_id) AS studentCode, p.u_fname, p.u_lname,
           CAST(SUBSTRING(TRIM(p.login_id), 2) AS UNSIGNED) AS num
    FROM educon_user_profile p
    WHERE ${REAL_STUDENT}
      AND TRIM(p.login_id) REGEXP '^[A-Za-z][0-9]+$'
      AND CAST(SUBSTRING(TRIM(p.login_id), 2) AS UNSIGNED) NOT IN (?)
      AND EXISTS (SELECT 1 FROM educon_user_academic_details a WHERE a.user_id = p.u_id)
    ORDER BY num DESC
  `, [DUMMY_STUDENT_NUMBERS]);

  // The highest number that belongs to the running sequence: another real student must sit
  // within LATEST_RUN_GAP numbers below it. A lone hand-entered code (e987, 195 above the
  // run) has nobody beside it and is skipped; e793, e794, ... extend the run and take over.
  const numbers = new Set(rows.map(r => Number(r.num)));
  const inRun = n => { for (let m = n - 1; m >= n - LATEST_RUN_GAP; m -= 1) if (numbers.has(m)) return true; return false; };
  const row = rows.find(r => inRun(Number(r.num)));
  if (!row) return null;
  return {
    studentId: row.studentId,
    code: row.studentCode,
    number: Number(row.num),
    name: studentName(row)
  };
}

/**
 * Distinct-student totals across every year, plus RCP per year.
 *
 * rcpTotal is a DISTINCT count, deliberately not the sum of rcpByYear: the per-year rows
 * use the same attribution as the matrix's RCP footer (so a year's number equals the list
 * behind it), and a student whose case is RCP in two years sits in both rows. The sum is
 * therefore >= the distinct total, and the client says so.
 */
async function getAllTimeTotals(pool) {
  const [[t]] = await pool.query(`
    SELECT
      COUNT(DISTINCT CASE WHEN ${ALL_TIME_POPULATIONS.live}     THEN a.user_id END) AS live,
      COUNT(DISTINCT CASE WHEN ${ALL_TIME_POPULATIONS.live_rcp} THEN a.user_id END) AS liveRcp,
      COUNT(DISTINCT CASE WHEN ${ALL_TIME_POPULATIONS.rcp}      THEN a.user_id END) AS rcp,
      COUNT(DISTINCT CASE WHEN ${ALL_TIME_POPULATIONS.closed}   THEN a.user_id END) AS closed,
      COUNT(DISTINCT CASE WHEN ${ALL_TIME_POPULATIONS.rejected} THEN a.user_id END) AS rejected
    FROM educon_user_academic_details a
    JOIN educon_user_profile p ON p.u_id = a.user_id
    WHERE ${REAL_STUDENT}
  `);

  const [[u]] = await pool.query(`
    SELECT COUNT(*) AS n FROM educon_user_profile p WHERE ${UNASSIGNED_ACCOUNT}
  `, [...PSEUDO_USERS]);

  // One profile status (bound as `?`) attributed to years the way the matrix did, for real
  // students only. getAllTimeStudentList({ year }) applies the very same rule, so a year's
  // figure equals the list its click opens.
  const YEAR_ROWS = `
    FROM educon_user_academic_details a
    JOIN educon_user_profile p ON p.u_id = a.user_id
    WHERE p.u_status = ?
      AND ${REAL_STUDENT}
      AND (a.application_status = p.u_status
           OR (NOT EXISTS (
                 SELECT 1 FROM educon_user_academic_details a2
                 WHERE a2.user_id = a.user_id AND a2.application_status = p.u_status)
               AND a.academic_year = (
                 SELECT MAX(a3.academic_year) FROM educon_user_academic_details a3
                 WHERE a3.user_id = a.user_id)))`;

  const perYear = async status => {
    const [rows] = await pool.query(`
      SELECT a.academic_year AS year, COUNT(DISTINCT a.user_id) AS count
      ${YEAR_ROWS}
      GROUP BY a.academic_year
      ORDER BY a.academic_year DESC
    `, [status]);
    return rows.map(r => ({ year: r.year, count: Number(r.count) }));
  };
  const rcpByYear = await perYear('REACHED_CAREER_POINT');

  // The students who make the year rows add up to more than the total: RCP in 2+ years.
  const [multi] = await pool.query(`
    SELECT a.user_id AS studentId, TRIM(p.login_id) AS studentCode, p.u_fname, p.u_lname,
           GROUP_CONCAT(DISTINCT a.academic_year ORDER BY a.academic_year SEPARATOR ',') AS years
    ${YEAR_ROWS}
    GROUP BY a.user_id, p.login_id, p.u_fname, p.u_lname
    HAVING COUNT(DISTINCT a.academic_year) > 1
    ORDER BY MIN(a.academic_year), p.login_id
  `, ['REACHED_CAREER_POINT']);

  return {
    liveTotal: Number(t.live),
    livePlusRcpTotal: Number(t.liveRcp),
    rcpTotal: Number(t.rcp),
    closedTotal: Number(t.closed),
    rejectedTotal: Number(t.rejected),
    unassignedTotal: Number(u.n),
    rcpByYear,
    rcpInTwoYears: multi.map(r => ({
      studentId: r.studentId,
      code: r.studentCode,
      name: studentName(r),
      years: String(r.years).split(',')
    }))
  };
}

/**
 * "Unassigned accounts": the system buckets (rcp, clo, E300, as) and the test accounts
 * (a student-shaped code with a dummy number, such as e9999). Team members and other staff
 * are not listed. One row per account.
 *
 * `type` is 'System bucket' or 'Test / dummy'. Contact details ride along only for a role
 * holding view:finance.
 */
async function getUnassignedAccounts(pool, { withContact = false } = {}) {
  const [rows] = await pool.query(`
    SELECT p.u_id AS accountId, TRIM(p.login_id) AS code, p.u_fname, p.u_lname,
           p.u_status AS profileStatus, p.u_emailid AS email, p.u_phoneno AS phone,
           CASE WHEN p.login_id IN (${pseudoList()}) THEN 'System bucket' ELSE 'Test / dummy' END AS type,
           (SELECT COUNT(DISTINCT m.s_id) FROM educon_user_etm_mapping m
             WHERE m.etm_id = p.u_id) AS studentsHandled,
           (SELECT GROUP_CONCAT(DISTINCT a.academic_year ORDER BY a.academic_year SEPARATOR ', ')
              FROM educon_user_academic_details a WHERE a.user_id = p.u_id) AS years
    FROM educon_user_profile p
    WHERE ${UNASSIGNED_ACCOUNT}
    ORDER BY type, p.login_id
  `, [...PSEUDO_USERS, ...PSEUDO_USERS]);

  return rows.map(r => {
    const row = {
      account: true,
      studentId: r.accountId,
      code: r.code || String(r.accountId),
      name: displayName({ u_fname: r.u_fname, u_lname: r.u_lname, login_id: r.code }),
      type: r.type,
      status: r.profileStatus || null,
      studentsHandled: Number(r.studentsHandled),
      years: r.years || ''
    };
    if (withContact) { row.email = r.email || ''; row.phone = r.phone || ''; row.hasContact = true; }
    return row;
  });
}

/**
 * The students behind an all-time number: one row per distinct student.
 *
 * Each student is shown at ONE academic year — the latest year whose case status equals
 * their profile status, else their latest year — so the row count equals the tile's
 * number exactly. `academicYear` on every row says which year that is.
 *
 * With `year`, the list is that year's: the students whose profile-status case sits in that
 * year, by the matrix's own attribution — the rule the per-year figures use.
 */
async function getAllTimeStudentList(pool, { population, withMoney = false, year = null }) {
  const filter = ALL_TIME_POPULATIONS[population];
  if (!filter) throw new Error('Unknown population');

  const moneyColumns = withMoney ? `,
      COALESCE((SELECT MAX(f.amount_sanctioned)
                  FROM educon_student_final_approval_and_sanction f
                 WHERE f.s_id = pick.caseId
                   AND f.academic_year = pick.academicYear), 0) AS sanctioned,
      COALESCE((SELECT SUM(d.pt_amount_disbursed) FROM (${DISTINCT_PAYMENTS}) d
                 WHERE d.s_id = pick.user_id
                   AND d.pt_academic_year = pick.academicYear), 0) AS disbursed,
      COALESCE((SELECT COUNT(DISTINCT d2.pt_academic_year) FROM (${DISTINCT_PAYMENTS}) d2
                 WHERE d2.s_id = pick.user_id), 0) AS supportYears,
      COALESCE((SELECT SUM(d3.pt_amount_disbursed) FROM (${DISTINCT_PAYMENTS}) d3
                 WHERE d3.s_id = pick.user_id), 0) AS cumulativeDisbursed` : '';

  const PSEUDO_PICK = `
      (SELECT m3.etm_id
         FROM educon_user_etm_mapping m3
         INNER JOIN educon_user_profile p3 ON p3.u_id = m3.etm_id
        WHERE m3.s_id = a.user_id
          AND p3.login_id IN ('rcp','clo','E300','as','rcp1819')
        ORDER BY m3.etm_id ASC
        LIMIT 1)`;

  // Which year row stands for the student: the latest year whose case status equals their
  // profile status, else their latest year; or, for one year, the matrix's attribution.
  const yearClause = year ? `a.academic_year = ?
        AND (a.application_status = p.u_status
             OR (NOT EXISTS (SELECT 1 FROM educon_user_academic_details a2
                              WHERE a2.user_id = a.user_id AND a2.application_status = p.u_status)
                 AND a.academic_year = (SELECT MAX(a3.academic_year)
                                          FROM educon_user_academic_details a3
                                         WHERE a3.user_id = a.user_id)))`
    : `a.academic_year = COALESCE(
              (SELECT MAX(ax.academic_year) FROM educon_user_academic_details ax
                WHERE ax.user_id = a.user_id AND ax.application_status = p.u_status),
              (SELECT MAX(ay.academic_year) FROM educon_user_academic_details ay
                WHERE ay.user_id = a.user_id))`;

  const [rows] = await pool.query(`
    SELECT
      pick.user_id      AS studentId,
      pick.caseId,
      pick.academicYear,
      pick.status,
      sp.login_id       AS studentCode,
      sp.u_fname, sp.u_lname,
      sp.u_status       AS profileStatus,
      pd.sp_fname, pd.sp_lname,
      h.login_id        AS handlerLogin,
      h.u_fname         AS h_fname,
      h.u_lname         AS h_lname,
      ph.login_id       AS pseudoHandlerLogin,
      ph.u_fname        AS ph_fname,
      ph.u_lname        AS ph_lname,
      (SELECT GROUP_CONCAT(DISTINCT hr.name ORDER BY hr.id SEPARATOR ',')
         FROM educon_user_profile_roles hpr JOIN role hr ON hr.id = hpr.roles_id
        WHERE hpr.users_u_id = pick.ownerId AND hpr.roles_id IN (${ETM_ROLE_IDS.join(', ')})) AS handlerRoles,
      fl.approval_id             AS approvalCode,
      ap.u_fname AS ap_fname, ap.u_lname AS ap_lname,
      san.sanctioning_authority_id AS sanctionCode,
      sn.u_fname AS sn_fname, sn.u_lname AS sn_lname,
      pap.login_id AS pap_login, pap.u_fname AS pap_fname, pap.u_lname AS pap_lname,
      psn.login_id AS psn_login, psn.u_fname AS psn_fname, psn.u_lname AS psn_lname,
      ${PROFILE_COLUMNS}${moneyColumns}
    FROM (
      SELECT
        a.user_id,
        a.s_id                AS caseId,
        a.academic_year       AS academicYear,
        a.application_status  AS status,
        ${OWNER_PICK}         AS ownerId,
        ${PSEUDO_PICK}        AS pseudoOwnerId
      FROM educon_user_academic_details a
      JOIN educon_user_profile p ON p.u_id = a.user_id
      WHERE ${filter}
        AND ${REAL_STUDENT}
        AND ${yearClause}
    ) pick
    LEFT JOIN educon_user_profile sp ON sp.u_id = pick.user_id
    LEFT JOIN educon_student_personal_details pd ON pd.s_id = pick.user_id
    LEFT JOIN educon_user_profile h  ON h.u_id  = pick.ownerId
    LEFT JOIN educon_user_profile ph ON ph.u_id = pick.pseudoOwnerId
    ${AUTHORITY_JOINS}
    ${PROFILE_JOINS.replace('%CASE%', 'pick.caseId').replace('%STUDENT%', 'pick.user_id')}
  `, year ? [...PSEUDO_USERS, year] : [...PSEUDO_USERS]);

  return rows
    .map(r => {
      const row = {
        studentId: r.studentId,
        caseId: r.caseId,
        academicYear: r.academicYear,
        code: r.studentCode || String(r.studentId),
        role: STUDENT_ROLE_NAME,
        name: studentName(r),
        // The population is defined on the profile status, so that is the status shown.
        status: r.profileStatus || r.status,
        profileStatus: r.profileStatus || null,
        handler: r.handlerLogin
          ? { loginId: r.handlerLogin, name: displayName({ u_fname: r.h_fname, u_lname: r.h_lname, login_id: r.handlerLogin }),
            roles: r.handlerRoles ? String(r.handlerRoles).split(',') : [] }
          : r.pseudoHandlerLogin
            ? { loginId: r.pseudoHandlerLogin, name: displayName({ u_fname: r.ph_fname, u_lname: r.ph_lname, login_id: r.pseudoHandlerLogin }), pseudo: true }
            : null,
        approvalAuth: authority(r.approvalCode, r.ap_fname, r.ap_lname,
          { login_id: r.pap_login, fname: r.pap_fname, lname: r.pap_lname }),
        sanctionAuth: authority(r.sanctionCode, r.sn_fname, r.sn_lname,
          { login_id: r.psn_login, fname: r.psn_fname, lname: r.psn_lname }),
        profile: studentProfile(r)
      };
      if (withMoney) {
        const sanctioned = Number(r.sanctioned);
        const disbursed = Number(r.disbursed);
        row.money = {
          sanctioned, disbursed, pending: sanctioned - disbursed,
          supportYears: Number(r.supportYears),
          cumulativeDisbursed: Number(r.cumulativeDisbursed)
        };
      }
      return row;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One student's money, per academic year.
 *
 * Sanctioned  MAX(amount_sanctioned) for the case, NOT SUM. 14 (case, year) groups carry
 *             more than one sanction row and in every one of them the amounts are
 *             identical — they are re-saves of the same decision, so summing would book
 *             a 50,000 sanction as 150,000.
 * Disbursed   SUM over DISTINCT_PAYMENTS, not over the raw table — the same duplicate
 *             trap sits in the payments table too. See that constant.
 * Pending     sanctioned - disbursed. Left signed rather than clamped: even after
 *             de-duplication some students are paid more in a year than that year's
 *             sanction row records, and clamping to zero would hide it.
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
      COALESCE((SELECT SUM(d.pt_amount_disbursed) FROM (${DISTINCT_PAYMENTS}) d
                 WHERE d.s_id = a.user_id
                   AND d.pt_academic_year = a.academic_year), 0) AS disbursed,
      ${PROFILE_COLUMNS}
    FROM educon_user_academic_details a
    LEFT JOIN educon_student_personal_details pd ON pd.s_id = a.user_id
    ${PROFILE_JOINS.replace('%CASE%', 'a.s_id').replace('%STUDENT%', 'a.user_id')}
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
    // The academic card is per year, not per student: a student is in FY Engineering in
    // one row and TY in another, and card 1 must follow the year selector rather than
    // showing whichever row the join happened to reach first.
    years: rows.map(r => {
      const sanctioned = Number(r.sanctioned);
      const disbursed = Number(r.disbursed);
      return {
        academicYear: r.academicYear,
        status: r.status,
        sanctioned,
        disbursed,
        pending: sanctioned - disbursed,
        profile: studentProfile(r)
      };
    })
  };
}

/** All payment vouchers for one student, de-duplicated, newest first. */
async function getStudentVouchers(pool, studentId) {
  const [rows] = await pool.query(`
    SELECT DISTINCT
      s_id, pt_academic_year AS academicYear, pt_payment_voucher_no AS voucherNo,
      pt_voucher_date AS voucherDate, pt_amount_disbursed AS amount,
      pt_payment_toward AS paymentToward, pt_payment_mode AS paymentMode,
      pt_bank_txn_id AS bankTxnId
    FROM educon_payment_transaction_details
    WHERE s_id = ?
      AND COALESCE(pt_cancel_tag, 'N') <> 'Y'
    ORDER BY pt_voucher_date DESC, pt_payment_voucher_no DESC
  `, [studentId]);

  let total = 0;
  const vouchers = rows.map(r => {
    const amt = Number(r.amount);
    total += amt;
    return {
      academicYear: r.academicYear,
      voucherNo: r.voucherNo,
      voucherDate: r.voucherDate,
      amount: amt,
      paymentToward: r.paymentToward,
      paymentMode: r.paymentMode,
      bankTxnId: r.bankTxnId
    };
  });

  return { studentId: Number(studentId), supportYears: new Set(rows.map(r => r.academicYear)).size, total, vouchers };
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
  getProfileStatusCounts,
  getMatrix,
  getReconciliation,
  getYearReport,
  getYearTrend,
  getStudentList,
  getLatestStudent,
  getAllTimeTotals,
  getAllTimeStudentList,
  getUnassignedAccounts,
  getStudentDetail,
  getStudentVouchers,
  ALL_TIME_POPULATIONS,
  DUMMY_STUDENT_NUMBERS,
  STATUS_ORDER,
  TERMINAL_STATUSES,
  PSEUDO_USERS,
  ATM_CODES,
  AGREED_MAX
};