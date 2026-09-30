/* EduCon Pipeline Dashboard — the 7 reported columns, defined once.
 *
 * Every figure on either data page is a sum over this array: page 1's hero, page 2's
 * matrix and chart, both Excel exports, and the drill-down's default sort order.
 * Change a column here and nowhere else — that is what stops the two pages disagreeing.
 *
 * `statuses` are exact DB values (13 exist; see CLAUDE.md). `cssVar` is the column's
 * colour wherever it is drawn, so the hero bar and the distribution chart cannot give
 * one column two colours — they did until 2026-09-09, when this field replaced the two
 * separate maps that had drifted apart on DISBURSEMENT_PENDING.
 *
 * Not reported at all: REJECTED, CASE_CLOSED, BUDGET_PENDING.
 * CHANGE_REQUIRED has no column of its own — a form sent back for changes is not yet
 * submitted, so it counts inside Form Not Submitted.
 */
window.PIPELINE_COLUMNS = [
  { key: 'CREATED',                  label: 'Form Not Submitted',       cssVar: '--seq-2',      statuses: ['CREATED', 'CHANGE_REQUIRED'] },
  { key: 'SCRUTINY_PENDING',         label: 'Scrutiny Pending',         cssVar: '--seq-3',      statuses: ['SUBMITTED', 'REAPPLICATION_SUBMITTED'] },
  { key: 'APPROVAL_PENDING',         label: 'Approval Pending',         cssVar: '--seq-4',      statuses: ['SCRUTINY_DONE'] },
  { key: 'SANCTION_PENDING',         label: 'Sanction Pending',         cssVar: '--seq-5',      statuses: ['FIRST_LEVEL_APPROVED'] },
  { key: 'DISBURSEMENT_PENDING',     label: 'Disbursement Pending',     cssVar: '--seq-6',      statuses: ['FINAL_LEVEL_APPROVED'] },
  { key: 'STUDENT_DISBURSED',        label: 'Student Disbursed',        cssVar: '--good',       statuses: ['STUDENT_DISBURSED'] },
  { key: 'NO_REQUIREMENT_THIS_YEAR', label: 'No Requirement This Year', cssVar: '--text-muted', statuses: ['NO_REQUIREMENT_THIS_YEAR'] },
  { key: 'REACHED_CAREER_POINT',   label: 'RCP',                       cssVar: '--seq-7',      statuses: ['REACHED_CAREER_POINT'] }
];

/** Sum of one column's underlying exact statuses from a { STATUS: count } map. */
window.colValue = (col, statusMap) =>
  col.statuses.reduce((n, s) => n + ((statusMap && statusMap[s]) || 0), 0);

/** Sum of every reported column — the "tracked" figure both pages quote. */
window.trackedFrom = statusMap =>
  window.PIPELINE_COLUMNS.reduce((n, c) => n + window.colValue(c, statusMap), 0);
