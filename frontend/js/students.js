/* EduCon Pipeline Dashboard — student drill-down.
 *
 * Turns every number in the status matrix into a way into the students behind it:
 *
 *   hover  a compact preview — Sr. No · Student ID · Student · Current status
 *   click  the full list, filterable column by column, in a dialog that can be maximised
 *   click a student  two cards: their academic details, and their money
 *
 * Read-only, like the rest of the dashboard: every request here is a GET.
 *
 * WHY THE TWO VIEWS SHOW DIFFERENT COLUMNS
 * The hover preview has to fit beside the number it explains, so it stays at four
 * columns and answers "who". The dialog is where the question becomes "who, and what
 * kind of student" — it carries the academic and personal attributes, one filter per
 * column, which is what the maximise control is for. Both are drawn from the same
 * `/api/students` payload and the same cache, so they can never disagree.
 *
 * The ETM/ATM column appears only when the rows do not all name the same handler. That
 * is exactly the Grand Total case: a member's own cell has one handler by construction,
 * and a column repeating one name down every row is noise.
 */

(() => {
  'use strict';

  const COLUMNS = window.PIPELINE_COLUMNS;

  // The Total column is every reported column at once — the same array page 1's hero
  // sums, so a Total cell and its list can never disagree.
  const TOTAL_KEY = '__TOTAL__';
  const statusesFor = key => key === TOTAL_KEY
    ? COLUMNS.flatMap(c => c.statuses)
    : (COLUMNS.find(c => c.key === key) || { statuses: [] }).statuses;

  const labelFor = key => key === TOTAL_KEY
    ? 'All tracked columns'
    : (COLUMNS.find(c => c.key === key) || { label: key }).label;

  const $ = id => document.getElementById(id);

  const esc = s => String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const money = n => new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0
  }).format(Number(n) || 0);

  const can = perm => !!window.EduConUser && window.EduConUser.permissions.includes(perm);

  /* A field the database has no answer for. Written as an em dash rather than as the
     word "Unknown": the student did not answer, which is not the same as the dashboard
     failing to read it. Codes the dashboard cannot decode arrive as the raw code from
     the server instead (see backend/services/codeLabels.js) and print as themselves. */
  const BLANK = '—';
  const val = v => (v === null || v === undefined || v === '') ? BLANK : String(v);

  /**
   * A status, exactly as the database holds it, with a break opportunity after each
   * underscore. REAPPLICATION_SUBMITTED does not fit a narrow column on one line, and
   * without this the browser breaks it mid-word ("STUDENT_DISBURSE / D"). <wbr> is
   * zero-width and copies as nothing, so the value on screen is still the DB value.
   */
  const statusTag = s => `<span class="status-tag">${
    esc(s).split('_').join('_<wbr>')}</span>`;

  // ---------- Fetching ----------
  // Lists are keyed by exactly what identifies them, so re-hovering a cell is instant
  // and moving along a row does not re-query. Cleared whenever the matrix reloads.
  const cache = new Map();

  async function getJSON(url) {
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }

  function fetchList({ year, etmId, colKey }) {
    const key = `${year}|${etmId ?? ''}|${colKey}`;
    if (!cache.has(key)) {
      const params = new URLSearchParams({ year, statuses: statusesFor(colKey).join(',') });
      if (etmId) params.set('etmId', etmId);
      cache.set(key, getJSON(`/api/students?${params}`).catch(error => {
        cache.delete(key);            // a failure must not be remembered as the answer
        throw error;
      }));
    }
    return cache.get(key);
  }

  /** Called by dashboard.js whenever fresh figures arrive, so nothing is served stale. */
  function invalidate() { cache.clear(); }

  // ---------- Column definitions ----------
  //
  // One array drives the header, the body and the filter spec, so a column can never be
  // headed one way and filtered another. `filter` picks the control the filter row gets:
  //
  //   'text'    substring — names, colleges, places, where part of the value is enough
  //   'select'  a list built from the data — the categorical fields, where the whole
  //             point is to pick one exact category and see only it
  //   null      no filter (the serial number is a position, not an attribute)

  const prof = s => (s && s.profile) || {};

  const LIST_COLUMNS = [
    { key: 'sr',      label: 'Sr. No',         cls: 'dt-sr',      filter: null,
      text: (s, i) => String(i + 1) },
    { key: 'code',    label: 'Student ID',     cls: 'dt-id',      filter: 'text',
      text: s => s.code },
    { key: 'name',    label: 'Student',        cls: 'dt-name',    filter: 'text',
      text: s => s.name },
    { key: 'status',  label: 'Current status', cls: 'dt-status',  filter: 'select',
      text: s => s.status, html: s => statusTag(s.status) },
    { key: 'handler', label: 'ETM / ATM',      cls: 'dt-handler', filter: 'select',
      text: s => (s.handler ? s.handler.name : ''),
      html: s => (s.handler
        ? `${esc(s.handler.name)}<span class="dt-sub">${esc(s.handler.loginId)}</span>`
        : BLANK) },
    { key: 'education',   label: 'Education',    cls: 'dt-edu',     filter: 'select',
      text: s => prof(s).education },
    { key: 'studyYear',   label: 'Std / Year',   cls: 'dt-stdyear', filter: 'select',
      text: s => prof(s).studyYear },
    { key: 'college',     label: 'College',      cls: 'dt-college', filter: 'text',
      text: s => prof(s).college },
    { key: 'collegeCity', label: 'College city', cls: 'dt-city',    filter: 'text',
      text: s => prof(s).collegeCity },
    { key: 'gender',      label: 'Gender',       cls: 'dt-tag',     filter: 'select',
      text: s => prof(s).gender },
    { key: 'community',   label: 'Community',    cls: 'dt-tag',     filter: 'select',
      text: s => prof(s).community },
    { key: 'food',        label: 'Food',         cls: 'dt-tag',     filter: 'select',
      text: s => prof(s).food }
  ];

  // The preview beside a number stays narrow enough to sit next to it.
  const POP_KEYS = ['sr', 'code', 'name', 'status'];

  /**
   * Which columns this rendering shows.
   *
   * The handler column earns its place only when the rows disagree about the handler —
   * true for the Grand Total row, false for a member's own cell, where it would repeat
   * one name down the whole table.
   */
  function columnsFor(students, keys) {
    const handlers = new Set(students.map(s => (s.handler ? s.handler.loginId : '')));
    return LIST_COLUMNS.filter(c => {
      if (keys && !keys.includes(c.key)) return false;
      if (c.key === 'handler') return handlers.size > 1;
      return true;
    });
  }

  function listTable(students, { clickable, keys, id }) {
    if (!students.length) {
      return '<p class="drill-empty">No students in this cell.</p>';
    }
    const cols = columnsFor(students, keys);

    const head = cols.map(c => `<th class="${c.cls}">${esc(c.label)}</th>`).join('');
    const body = students.map((s, i) => `
      <tr${clickable ? ` tabindex="0" role="button" data-student="${s.studentId}"` : ''}>
        ${cols.map(c => {
          const raw = c.text(s, i);
          return `<td class="${c.cls}">${c.html ? c.html(s, i) : esc(val(raw))}</td>`;
        }).join('')}
      </tr>`).join('');

    return `<table class="drill-table${clickable ? ' is-clickable' : ''}"${
      id ? ` id="${id}"` : ''}>
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>`;
  }

  /** The filter spec for a rendered list — indices follow the columns actually drawn. */
  const filterSpec = (students, keys, onChange) => ({
    id: 'drillList',
    renumber: 0,                        // Sr. No counts the rows still showing
    columns: columnsFor(students, keys)
      .map((c, index) => ({ index, type: c.filter, label: c.label,
        placeholder: c.filter === 'text' ? 'Filter…' : undefined }))
      .filter(c => c.type),
    onChange
  });

  // ---------- Hover preview ----------

  const pop = $('drillPop');
  const popHead = $('drillPopHead');
  const popBody = $('drillPopBody');
  const popFoot = $('drillPopFoot');

  let hoverTimer = null;
  let hideTimer = null;
  let openCell = null;

  // Two counters, not one: closing the popover must never cancel a dialog that is
  // still loading, and vice versa. A reply whose sequence has moved on is dropped.
  let popSeq = 0;
  let listSeq = 0;

  function positionPop(cell) {
    // Measured, not assumed: the popover's height depends on how many students it
    // holds, so it is shown first and placed second.
    const c = cell.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    const M = 8;

    // Beside the cell where there is room, otherwise flipped to its other side.
    let x = c.right + 10;
    if (x + p.width > innerWidth - M) x = c.left - p.width - 10;
    x = Math.max(M, Math.min(x, innerWidth - p.width - M));

    let y = c.top + c.height / 2 - p.height / 2;
    y = Math.max(M, Math.min(y, innerHeight - p.height - M));

    pop.style.left = `${Math.round(x)}px`;
    pop.style.top = `${Math.round(y)}px`;
  }

  function hidePop() {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    hoverTimer = null;
    hideTimer = null;
    openCell = null;
    popSeq += 1;                      // a reply still in flight must not reopen it
    pop.hidden = true;
    pop.dataset.show = '0';
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hidePop, 180);
  }

  async function showPop(cell) {
    const ctx = cellContext(cell);
    const seq = ++popSeq;

    openCell = cell;
    popHead.innerHTML =
      `<span class="drillpop-title">${esc(ctx.colLabel)}</span>
       <span class="drillpop-meta">${esc(ctx.who)} · ${esc(ctx.year)}</span>`;
    popBody.innerHTML = '<p class="drill-empty">Loading…</p>';
    popFoot.textContent = '';
    pop.hidden = false;
    pop.dataset.show = '1';
    positionPop(cell);

    try {
      const { students } = await fetchList(ctx);
      if (seq !== popSeq) return;                 // the pointer has moved on

      // The Grand Total preview names the handler too — that row's whole question is
      // "who is looking after these students", and waiting for the dialog to answer it
      // makes the hover useless for the one row where it matters most.
      const keys = ctx.etmId === null ? [...POP_KEYS, 'handler'] : POP_KEYS;
      popBody.innerHTML = listTable(students, { clickable: false, keys });
      popFoot.textContent = `${students.length} student${students.length === 1 ? '' : 's'} · click the number for the full list`;
    } catch (error) {
      if (seq !== popSeq) return;
      popBody.innerHTML = `<p class="drill-empty drill-error">${esc(error.message)}</p>`;
    }
    positionPop(cell);
  }

  pop.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  pop.addEventListener('mouseleave', scheduleHide);

  // ---------- The list dialog ----------

  const listDialog = $('drillDialog');
  const listTitle = $('drillTitle');
  const listMeta = $('drillMeta');
  const listYear = $('drillYear');
  const listBody = $('drillBody');
  const listFoot = $('drillFoot');
  const listMaxBtn = $('drillMax');

  // What the dialog is currently showing. The year select rewrites `year` in place, so
  // the same cell can be read across academic years without closing the dialog.
  let listCtx = null;

  // How many rows the filters are currently showing, so the footer can say "18 of 128"
  // rather than silently reporting a filtered count as the cell's total.
  let listShown = null;
  let listTotal = 0;

  async function openList(ctx) {
    listCtx = { ...ctx };
    hidePop();

    listTitle.textContent = ctx.colLabel;
    listMeta.textContent = ctx.who;
    listYear.innerHTML = (window.EduConYears || [ctx.year])
      .map(y => `<option value="${esc(y)}">${esc(y)}</option>`).join('');
    listYear.value = ctx.year;

    if (!listDialog.open) listDialog.showModal();
    await paintList();
  }

  function listFootText() {
    const plural = n => `${n} student${n === 1 ? '' : 's'}`;
    const filtered = listShown !== null && listShown !== listTotal;
    const count = filtered ? `${listShown} of ${plural(listTotal)}` : plural(listTotal);
    return can('view:finance')
      ? `${count} · select a student for their academic details and amounts`
      : count;
  }

  async function paintList() {
    const seq = ++listSeq;
    listBody.innerHTML = '<p class="drill-empty">Loading…</p>';
    listFoot.textContent = '';

    try {
      const { students } = await fetchList(listCtx);
      if (seq !== listSeq || !listDialog.open) return;

      const clickable = can('view:finance');
      listBody.innerHTML = listTable(students, { clickable, id: 'drillListTable' });

      listShown = null;
      listTotal = students.length;
      listFoot.textContent = listFootText();

      // Filters are mounted after the table is in the DOM, because the select options
      // are read off the rendered cells — the same text the user filters against.
      const table = $('drillListTable');
      if (table) {
        window.EduConFilters.mount(table, filterSpec(students, null, shown => {
          listShown = shown;
          listFoot.textContent = listFootText();
        }));
      }

      if (!clickable) return;
      listBody.querySelectorAll('[data-student]').forEach(row => {
        row.addEventListener('click', () => openStudent(Number(row.dataset.student)));
        row.addEventListener('keydown', e => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          openStudent(Number(row.dataset.student));
        });
      });
    } catch (error) {
      if (seq !== listSeq) return;
      listBody.innerHTML = `<p class="drill-empty drill-error">${esc(error.message)}</p>`;
    }
  }

  listYear.addEventListener('change', () => {
    listCtx.year = listYear.value;
    paintList();
  });

  $('drillClose').addEventListener('click', () => listDialog.close());

  /* ---------- Maximise ----------
   *
   * A CSS class rather than the Fullscreen API. The list lives in a <dialog> rendered in
   * the top layer; requesting real fullscreen on an element already in the top layer is
   * inconsistent across browsers, and it would also take the dialog out of the page's
   * own theme and stacking. The class simply grows the dialog to the viewport, which is
   * what "see the details" actually needs, and Escape still closes as it always did.
   */
  function syncMaxButton() {
    const on = listDialog.classList.contains('is-max');
    listMaxBtn.setAttribute('aria-pressed', String(on));
    listMaxBtn.setAttribute('aria-label', on ? 'Restore dialog size' : 'Maximise dialog');
    listMaxBtn.title = on ? 'Restore size' : 'Maximise — more columns at once';
    listMaxBtn.querySelector('use').setAttribute('href', on ? '#icoCollapse' : '#icoExpand');
  }

  listMaxBtn.addEventListener('click', () => {
    listDialog.classList.toggle('is-max');
    syncMaxButton();
  });

  // The size is a preference about how the user likes to read the table, not about one
  // particular cell, so it persists across openings within the session. It is not
  // written to storage: localStorage throws outright in some privacy modes, and this is
  // not worth a try/catch on every open.
  listDialog.addEventListener('close', syncMaxButton);
  syncMaxButton();

  // ---------- The student dialog ----------

  const stuDialog = $('studentDialog');
  const stuName = $('studentName');
  const stuCode = $('studentCode');
  const stuYear = $('studentYear');
  const stuBody = $('studentBody');

  let stuDetail = null;

  async function openStudent(studentId) {
    stuName.textContent = 'Loading…';
    stuCode.textContent = '';
    stuYear.innerHTML = '';
    stuBody.innerHTML = '';
    if (!stuDialog.open) stuDialog.showModal();

    try {
      stuDetail = await getJSON(`/api/students/${studentId}`);
      stuName.textContent = stuDetail.name;
      stuCode.textContent = stuDetail.code;

      // The academic filter offers only the years this student actually has a record
      // in — every option leads to real figures rather than an empty panel.
      stuYear.innerHTML = stuDetail.years
        .map(y => `<option value="${esc(y.academicYear)}">${esc(y.academicYear)}</option>`).join('');

      // Open on the year the drill-down was taken from, when the student has one.
      const preferred = listCtx && stuDetail.years.some(y => y.academicYear === listCtx.year)
        ? listCtx.year
        : stuDetail.years[0].academicYear;
      stuYear.value = preferred;
      paintStudent();
    } catch (error) {
      stuName.textContent = 'Could not load this student';
      stuBody.innerHTML = `<p class="drill-empty drill-error">${esc(error.message)}</p>`;
    }
  }

  /** One labelled fact in card 1. `note` carries the specific community under Jain / Non-Jain. */
  const factRow = (label, value, note) => `
    <div class="fact">
      <dt class="fact-label">${esc(label)}</dt>
      <dd class="fact-value${value ? '' : ' is-blank'}">${esc(val(value))}${
        note ? `<span class="fact-note">${esc(note)}</span>` : ''}</dd>
    </div>`;

  function paintStudent() {
    const y = stuDetail.years.find(r => r.academicYear === stuYear.value);
    if (!y) return;

    const p = y.profile || {};

    // Pending is signed, not clamped: a handful of students are paid more across the
    // year than the year's sanction row records (a top-up paid without a fresh
    // sanction), and rounding that away to zero would misreport the database.
    const over = y.pending < 0;

    // The community card shows the specific answer beneath the reported group, so the
    // reduction to Jain / Non-Jain never hides which community it reduced.
    const communityNote = p.communityDetail && p.communityDetail !== p.community
      ? p.communityDetail : null;

    // Academic facts are per academic year; a year the student has no education row for
    // says so rather than borrowing another year's college.
    const hasAcademic = p.education || p.college || p.studyYear || p.collegeCity;

    stuBody.innerHTML = `
      <p class="stu-status">Current status ${statusTag(y.status)}</p>

      <section class="stu-card">
        <h4 class="stu-card-title">Academic details</h4>
        ${hasAcademic ? '' :
          `<p class="stu-card-note">No education record for ${esc(y.academicYear)}. The personal details below are the student's, and do not change by year.</p>`}
        <dl class="fact-grid">
          ${factRow('Education', p.education)}
          ${factRow('Field of education', p.fieldOfEducation)}
          ${factRow('Specialization', p.specialization)}
          ${factRow('College name', p.college)}
          ${factRow('Std / current year', p.studyYear)}
          ${factRow('College city', p.collegeCity)}
          ${factRow('Gender', p.gender)}
          ${factRow('Community', p.community, communityNote)}
          ${factRow('Food preference', p.food)}
          ${factRow('Family status', p.familyStatus)}
          ${factRow('Parent location', p.parentLocation)}
        </dl>
      </section>

      <section class="stu-card">
        <h4 class="stu-card-title">Student disbursement</h4>
        <div class="stu-figures">
          <div class="stu-fig">
            <span class="stu-fig-label">Sanctioned</span>
            <span class="stu-fig-value">${money(y.sanctioned)}</span>
          </div>
          <div class="stu-fig">
            <span class="stu-fig-label">Disbursed</span>
            <span class="stu-fig-value">${money(y.disbursed)}</span>
          </div>
          <div class="stu-fig stu-fig-accent">
            <span class="stu-fig-label">${over ? 'Disbursed beyond sanction' : 'Pending for disbursement'}</span>
            <span class="stu-fig-value">${money(Math.abs(y.pending))}</span>
          </div>
        </div>
      </section>`;
  }

  stuYear.addEventListener('change', paintStudent);
  $('studentClose').addEventListener('click', () => stuDialog.close());

  // ---------- Wiring the matrix ----------

  /** Reads a cell's drill-down identity out of the data- attributes renderMatrix sets. */
  function cellContext(cell) {
    const row = cell.closest('tr');
    return {
      year: cell.dataset.year,
      etmId: cell.dataset.etm ? Number(cell.dataset.etm) : null,
      colKey: cell.dataset.col,
      colLabel: labelFor(cell.dataset.col),
      who: row.dataset.who || 'All team members'
    };
  }

  /**
   * Bound once to the table element rather than to every cell: renderMatrix rewrites
   * its innerHTML on each sort, filter and refresh, which would throw away per-cell
   * listeners. Delegation survives all of it.
   */
  function bind(table) {
    table.addEventListener('mouseover', e => {
      const cell = e.target.closest('td[data-col]');
      if (!cell || !table.contains(cell)) return;

      // The hide scheduled when the pointer left the previous cell has to be cancelled
      // here. Without this it fires mid-wait and hidePop clears the pending show, so
      // moving straight from one number to another leaves the first cell's list on
      // screen under the second cell's pointer.
      clearTimeout(hideTimer);
      if (cell === openCell) return;

      clearTimeout(hoverTimer);
      // Hover intent: sweeping the pointer across a row of numbers must not fire off a
      // request per cell.
      hoverTimer = setTimeout(() => showPop(cell), 200);
    });

    table.addEventListener('mouseout', e => {
      const cell = e.target.closest('td[data-col]');
      if (!cell) return;
      clearTimeout(hoverTimer);
      // Leaving toward the popover itself must not close it.
      if (e.relatedTarget && pop.contains(e.relatedTarget)) return;
      scheduleHide();
    });

    table.addEventListener('click', e => {
      const cell = e.target.closest('td[data-col]');
      if (!cell || !table.contains(cell)) return;
      openList(cellContext(cell));
    });

    // Keyboard parity: the cells are focusable, so Enter opens the same dialog.
    table.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const cell = e.target.closest('td[data-col]');
      if (!cell) return;
      e.preventDefault();
      openList(cellContext(cell));
    });

    // The matrix is its own scroll region, so a scrolled cell would leave the popover
    // floating over nothing.
    table.closest('.table-scroll')?.addEventListener('scroll', hidePop, { passive: true });
  }

  addEventListener('scroll', hidePop, { passive: true });
  addEventListener('resize', hidePop, { passive: true });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hidePop(); });

  window.EduConDrill = { bind, invalidate };
})();
