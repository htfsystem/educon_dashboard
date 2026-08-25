/* EduCon Pipeline Dashboard — the reported columns, defined once.
 *
 * Both data pages read this file: the executive hero on page 1 and the member matrix
 * on page 2. Sharing one definition is what stops the two pages disagreeing about how
 * many students are "tracked" — every figure on either page is a sum over this array.
 *
 * Each column maps to one or more exact DB statuses (see pipelineService.js /
 * CLAUDE.md for the 13 real values). The underlying query and its stored totals are
 * never altered — only how they are grouped and labelled for display.
 *
 * Deliberately NOT reported anywhere: REACHED_CAREER_POINT, REJECTED, CASE_CLOSED and
 * BUDGET_PENDING. CHANGE_REQUIRED has no column of its own — a form sent back for
 * changes is not yet submitted, so it is counted inside Form Not Submitted.
 */
window.PIPELINE_COLUMNS = [
  { key: 'CREATED',            label: 'Form Not Submitted',   statuses: ['CREATED', 'CHANGE_REQUIRED'] },
  { key: 'SCRUTINY_PENDING',   label: 'Scrutiny Pending',     statuses: ['SUBMITTED', 'REAPPLICATION_SUBMITTED'] },
  { key: 'APPROVAL_PENDING',   label: 'Approval Pending',     statuses: ['SCRUTINY_DONE'] },
  { key: 'SANCTION_PENDING',   label: 'Sanction Pending',     statuses: ['FIRST_LEVEL_APPROVED'] },
  { key: 'DISBURSEMENT_PENDING', label: 'Disbursement Pending', statuses: ['FINAL_LEVEL_APPROVED'] },
  { key: 'STUDENT_DISBURSED',  label: 'Student Disbursed',    statuses: ['STUDENT_DISBURSED'] },
  { key: 'NO_REQUIREMENT_THIS_YEAR', label: 'No Requirement This Year', statuses: ['NO_REQUIREMENT_THIS_YEAR'] }
];

/** Sum of one column's underlying exact statuses from a { STATUS: count } map. */
window.colValue = (col, statusMap) =>
  col.statuses.reduce((n, s) => n + ((statusMap && statusMap[s]) || 0), 0);

/** Sum of every reported column — the "tracked" figure both pages quote. */
window.trackedFrom = statusMap =>
  window.PIPELINE_COLUMNS.reduce((n, c) => n + window.colValue(c, statusMap), 0);
