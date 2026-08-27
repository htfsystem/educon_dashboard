/* EduCon Pipeline Dashboard — student drill-down.
 *
 * Turns every number in the status matrix into a way into the students behind it:
 *
 *   hover  a compact 4-column list — Sr. No · Student ID · Student · Current status
 *   click  the same list in a dialog, with its own academic-year filter
 *   click a student  that student's sanctioned / disbursed / pending amounts
 *
 * Deliberately narrow. A cell means "these students, this year, this status", so the
 * list shows those four facts and nothing else; the student view shows the three money
 * figures and nothing else. Everything else about a student stays in EduCon itself.
 *
 * Read-only, like the rest of the dashboard: every request here is a GET.
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

  // ---------- The shared list table ----------
  // Four columns, sized to their content: a serial number, a short student code, the
  // name (the only column that needs room), and the exact status. Statuses are printed
  // exactly as the database holds them — never renamed or merged.

  function listTable(students, { clickable }) {
    if (!students.length) {
      return '<p class="drill-empty">No students in this cell.</p>';
    }
    return `<table class="drill-table${clickable ? ' is-clickable' : ''}">
      <thead><tr>
        <th class="dt-sr">#</th>
        <th class="dt-id">ID</th>
        <th class="dt-name">Student</th>
        <th class="dt-status">Current status</th>
      </tr></thead>
      <tbody>${students.map((s, i) => `
        <tr${clickable ? ` tabindex="0" role="button" data-student="${s.studentId}"` : ''}>
          <td class="dt-sr">${i + 1}</td>
          <td class="dt-id">${esc(s.code)}</td>
          <td class="dt-name">${esc(s.name)}</td>
          <td class="dt-status">${statusTag(s.status)}</td>
        </tr>`).join('')}</tbody>
    </table>`;
  }

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
      popBody.innerHTML = listTable(students, { clickable: false });
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

  // What the dialog is currently showing. The year select rewrites `year` in place, so
  // the same cell can be read across academic years without closing the dialog.
  let listCtx = null;

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

  async function paintList() {
    const seq = ++listSeq;
    listBody.innerHTML = '<p class="drill-empty">Loading…</p>';
    listFoot.textContent = '';

    try {
      const { students } = await fetchList(listCtx);
      if (seq !== listSeq || !listDialog.open) return;

      const clickable = can('view:finance');
      listBody.innerHTML = listTable(students, { clickable });
      listFoot.textContent = clickable
        ? `${students.length} student${students.length === 1 ? '' : 's'} · select one to see its sanctioned, disbursed and pending amounts`
        : `${students.length} student${students.length === 1 ? '' : 's'}`;

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

  function paintStudent() {
    const y = stuDetail.years.find(r => r.academicYear === stuYear.value);
    if (!y) return;

    // Pending is signed, not clamped: a handful of students are paid more across the
    // year than the year's sanction row records (a top-up paid without a fresh
    // sanction), and rounding that away to zero would misreport the database.
    const over = y.pending < 0;

    stuBody.innerHTML = `
      <p class="stu-status">Current status ${statusTag(y.status)}</p>
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
      </div>`;
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
