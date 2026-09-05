/* EduCon Pipeline Dashboard — student drill-down.
 *
 * Turns every number in the status matrix into a way into the students behind it:
 *
 *   hover  a compact preview — Sr. No · Student ID · Student · Current status · Family status
 *   click  the full list, filterable column by column, in a dialog that can be maximised
 *   click a student  two cards: their academic details, and their money
 *
 * Read-only, like the rest of the dashboard: every request here is a GET.
 *
 * WHY THE TWO VIEWS SHOW DIFFERENT COLUMNS
 * The hover preview has to fit beside the number it explains, so it stays at five
 * columns and answers "who". The dialog is where the question becomes "who, and what
 * kind of student" — it carries the academic and personal attributes, one filter per
 * column, which is what the maximise control is for. Both are drawn from the same
 * `/api/students` payload and the same cache, so they can never disagree.
 *
 * The ETM/ATM column appears only when the rows do not all name the same handler. That
 * is exactly the Grand Total case: a member's own cell has one handler by construction,
 * and a column repeating one name down every row is noise.
 *
 * THE FILTERS LAST EXACTLY AS LONG AS THE DIALOG (2026-09-05)
 * They survive a re-render — the two-minute refresh must not swallow what was typed —
 * but not a close. Closing forgets them, so the next number opened is answered as itself
 * rather than through the previous question's filter. See the `close` handler below.
 *
 * SORTING BY STUDENT ID (2026-09-05)
 * One column sorts, at the user's request: Student ID, ascending or descending. The list
 * otherwise arrives in the server's own order (student name, A→Z). Everything else in the
 * list is a category rather than a sequence, and the filter row is the right tool for
 * those — see the header rules in `listTable`.
 *
 * EXPORTING WHAT IS ON SCREEN (2026-09-05)
 * The Export button in the dialog head writes exactly the visible rows to .xlsx. It is
 * built from the rendered table, not from the payload, so the filters cannot be applied
 * one way to the screen and another to the sheet. The sheet's header names the cell, the
 * academic year and every filter in force — a filtered list circulated without that
 * record gets read as the cell's total by whoever opens it next week.
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
    // The one sortable column, and the one whose filter is worded as a search: a student
    // code is looked up ("show me e617"), not chosen from a list of 158.
    { key: 'code',    label: 'Student ID',     cls: 'dt-id',      filter: 'text',
      placeholder: 'Search ID…', sortable: true,
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
    // Education → field → specialization is the application's own hierarchy, and reads
    // as one thought across three columns: "Graduation · Medicine · MBBS : Allopathic".
    // They were raw codes until 2026-09-01 and so were deliberately kept off this list;
    // now that codeLabels.js has the real dropdowns they are the answer to "what kind of
    // student is this", which is the question the dialog exists to ask.
    { key: 'education',   label: 'Education',    cls: 'dt-edu',     filter: 'select',
      text: s => prof(s).education },
    { key: 'field',       label: 'Field of education', cls: 'dt-field', filter: 'select',
      text: s => prof(s).fieldOfEducation },
    { key: 'specialization', label: 'Specialization',  cls: 'dt-spec',  filter: 'select',
      text: s => prof(s).specialization },
    { key: 'studyYear',   label: 'Std / Year',   cls: 'dt-stdyear', filter: 'select',
      text: s => prof(s).studyYear },
    { key: 'college',     label: 'College',      cls: 'dt-college', filter: 'text',
      text: s => prof(s).college },
    { key: 'board',       label: 'Board / University', cls: 'dt-uni', filter: 'select',
      text: s => prof(s).board },
    { key: 'collegeCity', label: 'College city', cls: 'dt-city',    filter: 'text',
      text: s => prof(s).collegeCity },
    { key: 'gender',      label: 'Gender',       cls: 'dt-tag',     filter: 'select',
      text: s => prof(s).gender },
    { key: 'community',   label: 'Community',    cls: 'dt-tag',     filter: 'select',
      text: s => prof(s).community },
    { key: 'food',        label: 'Food',         cls: 'dt-tag',     filter: 'select',
      text: s => prof(s).food },
    // Family status is a decision criterion rather than a description — an orphan or a
    // single-parent student is read differently from one with both parents — so unlike
    // the other personal fields it also rides in the hover preview below.
    { key: 'family',      label: 'Family status', cls: 'dt-family', filter: 'select',
      text: s => prof(s).familyStatus }
  ];

  // The preview beside a number stays narrow enough to sit next to it: who the student
  // is, where they are in the pipeline, and the one personal fact the business weighs a
  // case on. Everything else waits for the dialog.
  const POP_KEYS = ['sr', 'code', 'name', 'status', 'family'];

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

  /* ---------- Sorting, on Student ID and nothing else ----------
   *
   * Asked for on 2026-09-05. The list arrives in the server's order — student name, A→Z —
   * and the business reads it by student code as often as by name, in both directions.
   *
   * THREE STATES, NOT TWO: ascending, descending, and back to the name order the list
   * opens in. A plain asc/desc toggle would leave no way back to the default without
   * closing the dialog and losing the filters with it. The header's tooltip names what the
   * NEXT click does, the same convention the summary page's empty-rows chip follows, so
   * the control can never contradict the state it is in.
   *
   * The sort is a reading preference, like the maximised size, and so persists across
   * openings — unlike the filters, which are forgotten on close. The difference is that a
   * sort hides nothing: arriving at a new cell re-sorted shows every student it should,
   * while arriving pre-filtered shows fewer and reads as missing data.
   */
  const SORT_CYCLE = [0, 1, -1];        // default -> ascending -> descending -> default
  let listSortDir = 0;

  /* Student codes are a letter and a number ("e617", "E747"), and the handful of students
     with no code at all fall back to their numeric id. `numeric` is what puts e9 before
     e10 rather than after it; `sensitivity: 'base'` is what stops the upper-case E-codes
     sorting as a separate block from the lower-case ones. Ties fall back to the name, so
     the order is total and a re-render never reshuffles equal rows. */
  const byCode = dir => (a, b) =>
    dir * String(a.code ?? '').localeCompare(String(b.code ?? ''), undefined,
      { numeric: true, sensitivity: 'base' })
    || String(a.name ?? '').localeCompare(String(b.name ?? ''));

  const sortStudents = students =>
    (listSortDir === 0 ? students : [...students].sort(byCode(listSortDir)));

  /** The tooltip names the next click's effect, never the current state. */
  const nextSortLabel = dir => (
    dir === 0 ? 'Sort by Student ID, A → Z'
      : dir === 1 ? 'Sort by Student ID, Z → A'
        : 'Clear the sort — back to student name order');

  const ariaSort = dir => (dir === 1 ? 'ascending' : dir === -1 ? 'descending' : 'none');

  /**
   * One rendering of a list.
   *
   * `sortDir` undefined means "no sorting controls at all" — that is the hover preview,
   * which is a glance at a number rather than a table to work in.
   */
  function listTable(students, { clickable, keys, id, sortDir }) {
    if (!students.length) {
      return '<p class="drill-empty">No students in this cell.</p>';
    }
    const cols = columnsFor(students, keys);

    /* A real <button> inside the <th>, not a click handler on the cell: it is focusable,
       reachable by keyboard and announced as a control without a line of ARIA. The
       stylesheet hangs every visual rule off `.th-sort` for a related reason — filters.js
       copies a header cell's classes onto the filter cell beneath it, so anything styled
       on the th itself would also paint the filter box below as a sort control. */
    const head = cols.map(c => {
      if (sortDir === undefined || !c.sortable) {
        return `<th class="${c.cls}">${esc(c.label)}</th>`;
      }
      const caret = sortDir === 0 ? ''
        : `<svg class="ico sort-arrow${sortDir === -1 ? ' is-desc' : ''}" viewBox="0 0 24 24"` +
          ' aria-hidden="true"><use href="#icoCaret"/></svg>';
      return `<th class="${c.cls} is-sortable" aria-sort="${ariaSort(sortDir)}"><button` +
        ` type="button" class="th-sort" title="${esc(nextSortLabel(sortDir))}">${
          esc(c.label)}${caret}</button></th>`;
    }).join('');
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

  /* The drill list's filter identity. The export reads the active filters under it and
     the dialog's close handler forgets them under it, so all three agree by construction
     rather than by three copies of the same string. */
  const LIST_FILTERS = 'drillList';

  /** The filter spec for a rendered list — indices follow the columns actually drawn. */
  const filterSpec = (students, keys, onChange) => ({
    id: LIST_FILTERS,
    renumber: 0,                        // Sr. No counts the rows still showing
    columns: columnsFor(students, keys)
      .map((c, index) => ({ index, type: c.filter, label: c.label,
        placeholder: c.filter === 'text' ? (c.placeholder || 'Filter…') : undefined }))
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
  const listExportBtn = $('drillExport');

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

  /** How many rows are on screen right now — the filtered count when filters are set. */
  const listVisible = () => (listShown === null ? listTotal : listShown);

  function listFootText() {
    const plural = n => `${n} student${n === 1 ? '' : 's'}`;
    const filtered = listShown !== null && listShown !== listTotal;
    const count = filtered ? `${listShown} of ${plural(listTotal)}` : plural(listTotal);
    return can('view:finance')
      ? `${count} · select a student for their academic details and amounts`
      : count;
  }

  /* The export button offers exactly what is on screen, so it is disabled whenever there
     is nothing on screen to offer: while the list is loading, when it failed, and when
     the filters have narrowed it to nothing. A button that downloads a header row and no
     students is worse than a button that says it has nothing to give. */
  function syncExportButton(ready) {
    if (!listExportBtn) return;                 // the role has no export permission
    const n = ready ? listVisible() : 0;
    listExportBtn.disabled = n === 0;
    listExportBtn.title = n === 0
      ? 'Nothing to export'
      : `Download these ${n} student${n === 1 ? '' : 's'} as an Excel sheet`;
  }

  // The list currently loaded, in the order the server sent it. Sorting reorders a copy,
  // so the default order is always still there to return to.
  let listStudents = [];

  /**
   * Draw the loaded list — the initial paint, and every sort after it.
   *
   * A sort rebuilds the whole table rather than only reordering the rows, because Sr. No,
   * the filter row and the select options all have to agree with the order on screen.
   * That costs nothing the reader can feel: filters.js is re-mounted straight after and
   * puts back every value that was typed, and no request is made — the list is already in
   * hand.
   */
  function renderList() {
    const students = sortStudents(listStudents);
    const clickable = can('view:finance');

    listBody.innerHTML = listTable(students, {
      clickable, id: 'drillListTable', sortDir: listSortDir
    });

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
        syncExportButton(true);
      }));
    }
    syncExportButton(true);

    // The header button is a new node after every render, so the listener is bound here
    // rather than once, and focus is moved onto the replacement. Without that, Enter on
    // the header would drop the user back to the top of the dialog and reversing a sort
    // would cost a second journey through the tab order. A mouse click is unaffected —
    // the ring is :focus-visible, so it shows for the keyboard only.
    const sortBtn = listBody.querySelector('.th-sort');
    if (sortBtn) {
      sortBtn.addEventListener('click', () => {
        const i = SORT_CYCLE.indexOf(listSortDir);
        listSortDir = SORT_CYCLE[(i + 1) % SORT_CYCLE.length];
        renderList();
        listBody.querySelector('.th-sort')?.focus();
      });
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
  }

  async function paintList() {
    const seq = ++listSeq;
    listBody.innerHTML = '<p class="drill-empty">Loading…</p>';
    listFoot.textContent = '';
    syncExportButton(false);

    try {
      const { students } = await fetchList(listCtx);
      if (seq !== listSeq || !listDialog.open) return;

      listStudents = students;
      renderList();
    } catch (error) {
      if (seq !== listSeq) return;
      listStudents = [];
      listBody.innerHTML = `<p class="drill-empty drill-error">${esc(error.message)}</p>`;
    }
  }

  listYear.addEventListener('change', () => {
    listCtx.year = listYear.value;
    paintList();
  });

  $('drillClose').addEventListener('click', () => listDialog.close());

  /* ---------- Closing the dialog releases the filters ----------
   *
   * Asked for on 2026-09-05. Filters were remembered between openings, because the state
   * lives in js/filters.js keyed by table id and survives a re-render — which is right
   * while the dialog is open (a two-minute refresh must not lose what was typed) and
   * wrong once it closes. Someone who narrows a cell to "Female · MBBS", closes the
   * dialog and opens a different number was being shown that number filtered by the
   * previous question, with no visible cause: the count in the footer was smaller than
   * the cell they clicked, which reads as missing students rather than as a filter.
   *
   * So the state is forgotten on close, not merely emptied — the table node goes with the
   * next render anyway, and forgetting is what makes the next mount() start blank.
   *
   * `close` covers every way out: the ✕, Escape, and a programmatic close. The listener
   * is separate from syncMaxButton's because the two answer different questions — the
   * maximised size is a reading preference and deliberately does persist.
   */
  listDialog.addEventListener('close', () => {
    window.EduConFilters.forget(LIST_FILTERS);
    listShown = null;
    listTotal = 0;
    syncExportButton(false);
  });

  /* ---------- Exporting what is on screen ----------
   *
   * The sheet is built from the rendered table rather than from the `students` payload,
   * which is what makes "export what I filtered" true by construction rather than by a
   * second implementation of the filter that could drift from the first. It also carries
   * the decoded labels and exactly the columns actually drawn — the ETM/ATM column, for
   * one, only exists on the Grand Total row.
   *
   * Every export stamps the cell it came from and the filters in force. A filtered list
   * circulated with no record of the filter is the real hazard here: "58 students" is
   * read as the cell's total by whoever opens the file a week later.
   */
  function exportList() {
    const table = $('drillListTable');
    if (!table || !window.EduConXlsx) return;

    const X = window.EduConXlsx;
    const S = X.S;

    // The header row only — tHead's second row is the filter row, whose controls are not
    // data and must not become column headings.
    const headCells = [...(table.tHead.rows[0]?.cells || [])];
    const headers = headCells.map(th => th.textContent.trim());
    if (!headers.length) return;

    // Hidden rows are the ones the filters excluded; group headings do not occur here.
    const bodyRows = [...(table.tBodies[0]?.rows || [])].filter(r => !r.hidden);
    if (!bodyRows.length) return;

    const filters = window.EduConFilters.active(LIST_FILTERS);
    const last = X.colLetter(headers.length - 1);
    const rows = [];
    const merges = [];

    rows.push({ cells: [{ v: `EduCon — ${listCtx.colLabel}`, s: S.title }], height: 26 });
    merges.push(`A1:${last}1`);

    rows.push({
      cells: [{
        v: `${listCtx.who}     ·     Academic year: ${listCtx.year}     ·     Generated: ${new Date().toLocaleString()}`,
        s: S.info
      }],
      height: 18
    });
    merges.push(`A2:${last}2`);

    // Said plainly, and only when it is true: an unfiltered sheet must not carry a line
    // implying it might be a subset. The sort is stamped for the same reason the filters
    // are — the rows come out in the order on screen, so the sheet says what that order is
    // rather than leaving a reader to guess why it is not alphabetical by name.
    const sortNote = listSortDir === 0 ? ''
      : `     ·     Sorted by Student ID (${listSortDir === 1 ? 'A → Z' : 'Z → A'})`;
    rows.push({
      cells: [{
        v: (filters.length
          ? `Filtered: ${filters.map(f => `${f.label} = ${f.value}`).join('  ·  ')}     ·     ` +
            `${bodyRows.length} of ${listTotal} students`
          : `All ${listTotal} student${listTotal === 1 ? '' : 's'} in this cell — no filters applied`
        ) + sortNote,
        s: S.info
      }],
      height: 18
    });
    merges.push(`A3:${last}3`);

    rows.push({ cells: [] });
    rows.push({ cells: headers.map(h => ({ v: h, s: S.head })), height: 32 });
    const HEAD_ROW = 5;

    /* Cell text, not the underlying record: what the reader saw is what they get. The
       ETM/ATM cell holds the handler's name with their login id stacked under it in a
       <span>, and a plain textContent would run the two together as "Rohit Deshmukhrd" —
       hence joining the child nodes with a space. Sr. No is renumbered against the
       filtered rows by filters.js already; it is rewritten here as a number so Excel
       treats the column as numeric rather than as text. */
    bodyRows.forEach((tr, i) => {
      rows.push({
        cells: [...tr.cells].map((td, ci) => {
          const text = [...td.childNodes]
            .map(n => (n.nodeType === 3 ? n.nodeValue : n.textContent))
            .join(' ').replace(/\s+/g, ' ').trim();
          if (ci === 0) return { v: i + 1, s: S.num };
          return { v: text, s: S.txt };
        })
      });
    });

    // Sized by what the column holds: identifiers and tags stay narrow, the prose columns
    // (college, specialization, university) get the room they need.
    const width = h => {
      const key = h.toLowerCase();
      if (key.startsWith('sr')) return 6;
      if (key.includes('college') && !key.includes('city')) return 34;
      if (key.includes('specialization') || key.includes('university')) return 30;
      if (key.includes('status') || key.includes('student') || key.includes('etm')) return 24;
      return 18;
    };

    // The filename says which cell, whose, which year, and whether it is a subset — the
    // four things someone needs to know from a file sitting in a Downloads folder.
    const stamp = filters.length ? '-filtered' : '';
    X.save(
      [{ name: listCtx.colLabel, rows, merges, cols: headers.map(h => ({ w: width(h) })), freezeRow: HEAD_ROW }],
      `${X.safeName(`EduCon-${listCtx.colLabel}-${listCtx.who}-${listCtx.year}${stamp}`)}.xlsx`
    );
  }

  // Hidden by app.js for a role without `export` ([data-perm] nodes get `hidden` and
  // `data-perm-denied`), so the optional chaining is defensive only.
  listExportBtn?.addEventListener('click', exportList);

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
  syncExportButton(false);      // nothing is open yet, so there is nothing to export

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
    const hasAcademic = p.education || p.college || p.studyYear || p.collegeCity || p.board;

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
          ${factRow('Board / University', p.board)}
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
