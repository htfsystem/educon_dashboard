/* EduCon Pipeline Dashboard — client.
   Charts are hand-rolled SVG: no chart library, no CDN, works fully offline. */

(() => {
  'use strict';

  // ---------- Status presentation ----------
  // The reported columns are defined once, in js/columns.js, because page 1's hero
  // sums the same array. See that file for what is excluded and why.
  const COLUMNS = window.PIPELINE_COLUMNS;

  const GROUP_VAR = {
    CREATED:                '--seq-2',
    SCRUTINY_PENDING:       '--seq-3',
    APPROVAL_PENDING:       '--seq-4',
    SANCTION_PENDING:       '--seq-5',
    DISBURSEMENT_PENDING:   '--seq-5',
    STUDENT_DISBURSED:      '--good',
    NO_REQUIREMENT_THIS_YEAR: '--text-muted'
  };

  const colValue = window.colValue;

  // Member totals count only the tracked columns above — closed / rejected / reached-
  // career-point and budget-pending cases are excluded from every ETM/ATM count.
  const memberTotal = m => COLUMNS.reduce((n, c) => n + colValue(c, m.statuses), 0);

  // Column/grand totals come from the server's assignedStatusTotals: an exact, DISTINCT
  // count of real-person-assigned students per status (COUNT(DISTINCT user_id) in SQL).
  // This is deliberately NOT the sum of the member matrix rows — 205 of 461 students
  // are mapped to two handlers, so summing rows counts them twice. It is also NOT the
  // raw cohort-wide statusTotals, which would include students held only by the
  // pseudo-user buckets (rcp/clo/E300/as). assignedStatusTotals is the one number that
  // is both pseudo-user-free and never double-counted.
  const colAssignedTotal = (col, report) => colValue(col, report.assignedStatusTotals);
  const trackedTotal = report => COLUMNS.reduce((n, c) => n + colAssignedTotal(c, report), 0);

  const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // ---------- State ----------
  const state = {
    report: null,
    year: null,
    team: 'ALL',
    search: '',
    sortKey: 'total',
    sortDir: -1,
    heatmap: true,
    hideEmpty: false,
    // Cell keys whose figure moved in the most recent sync. Consumed and cleared by
    // the next renderMatrix, so a change flashes exactly once.
    changed: new Set()
  };

  const $ = id => document.getElementById(id);
  const el = {
    main: $('main'), year: $('yearSelect'), team: $('teamSelect'), search: $('searchInput'),
    statusChart: $('statusChart'), stageLegend: $('stageLegend'),
    table: $('matrixTable'), tooltip: $('tooltip'),
    distSub: $('distSub'), matrixSub: $('matrixSub')
  };

  // With the status line gone, a failure has to announce itself on the panels
  // themselves rather than in a badge at the top of the shell.
  function showError(message) {
    [el.distSub, el.matrixSub].forEach(node => {
      node.textContent = message;
      node.classList.add('panel-sub-error');
    });
  }

  function clearError() {
    [el.distSub, el.matrixSub].forEach(node => node.classList.remove('panel-sub-error'));
    // The matrix has no standing subtitle — the node exists only to carry an error.
    el.matrixSub.textContent = '';
  }

  // ---------- Loading ----------

  /* Two different states, because they are two different situations. A *first* load has
     no figures to preserve, so the layout is drawn as skeletons at the size the real
     content will take. A *refresh* has correct figures already on screen; replacing
     them with skeletons every two minutes would be a worse answer than leaving them,
     so only the 2px bar under the topbar moves. What this replaces — dimming the whole
     .layout to 55% — did neither: it made the controls read as disabled. */
  const setBusy = on => on ? window.EduConBusy.push() : window.EduConBusy.pop();

  const skRow = () =>
    '<div class="sk-row"><span class="skeleton sk-name"></span>' +
    Array.from({ length: 8 }, () => '<span class="skeleton sk-cell"></span>').join('') +
    '</div>';

  /** Skeleton rows sized to the real grid, so nothing shifts when the table lands. */
  function skeletonMatrix() {
    el.table.innerHTML =
      `<tbody><tr><td><div class="sk-rows">${
        Array.from({ length: 9 }, skRow).join('')}</div></td></tr></tbody>`;
  }

  /** Skeleton bars: one per reported column, at the row height the chart will use. */
  function skeletonChart() {
    el.statusChart.innerHTML = `<div class="sk-bars">${
      COLUMNS.map((_, i) =>
        // Descending widths read as a plausible distribution rather than a blank block.
        `<div class="sk-bar"><span class="skeleton sk-label"></span>` +
        `<span class="skeleton sk-track" style="flex:0 0 ${72 - i * 8}%"></span></div>`
      ).join('')}</div>`;
  }

  // ---------- Change detection ----------

  /* What actually moved since the last sync.
   *
   * The matrix reloads every two minutes and nothing marked what changed — you had to
   * have memorised the previous figure. This diffs the incoming report against the one
   * it replaces and hands renderMatrix a set of cell keys to flash.
   *
   * It is computed in loadYear, not in renderMatrix, and cleared once consumed: sorting,
   * filtering and searching all re-render the matrix, and flashing on those would be
   * lying about what came from the database. */
  const cellKey = (etmId, colKey) => `${etmId || '*'}|${colKey}`;

  function diffReports(prev, next) {
    const changed = new Set();
    if (!prev) return changed;                     // first load marks nothing

    const before = new Map(prev.members.map(m => [m.etmId, m]));
    next.members.forEach(m => {
      const was = before.get(m.etmId);
      if (!was) return;                            // a member new to this year
      COLUMNS.forEach(c => {
        if (colValue(c, m.statuses) !== colValue(c, was.statuses)) {
          changed.add(cellKey(m.etmId, c.key));
        }
      });
      if (memberTotal(m) !== memberTotal(was)) changed.add(cellKey(m.etmId, '__TOTAL__'));
    });

    // The Grand Total row moves independently of any single member's row — a student
    // reassigned between two handlers changes both member rows and neither total.
    COLUMNS.forEach(c => {
      if (colAssignedTotal(c, next) !== colAssignedTotal(c, prev)) changed.add(cellKey(null, c.key));
    });
    if (trackedTotal(next) !== trackedTotal(prev)) changed.add(cellKey(null, '__TOTAL__'));

    return changed;
  }

  // ---------- Empty states ----------

  /** An empty table with only a header and a total row reads as a failure, not an answer. */
  function emptyState({ title, note, action }) {
    return `<div class="empty">
      <svg class="ico empty-ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#icoTable"/></svg>
      <div class="empty-title">${escapeHtml(title)}</div>
      <p class="empty-note">${escapeHtml(note)}</p>
      ${action ? `<button class="btn" type="button" id="${action.id}">${escapeHtml(action.label)}</button>` : ''}
    </div>`;
  }

  // ---------- SVG helpers ----------
  const NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs = {}, text) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** Rounded only on the value end, anchored square to the baseline. */
  function hBarPath(x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w));
    if (w <= 0.5) return `M${x},${y}h${Math.max(w, 0.5)}v${h}h${-Math.max(w, 0.5)}z`;
    return `M${x},${y}h${w - rr}a${rr},${rr} 0 0 1 ${rr},${rr}v${h - 2 * rr}a${rr},${rr} 0 0 1 ${-rr},${rr}h${-(w - rr)}z`;
  }

  function niceTicks(max, count = 4) {
    if (max <= 0) return [0];
    const raw = max / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || 10 * mag;
    const ticks = [];
    for (let t = 0; t <= max + step * 0.001; t += step) ticks.push(Math.round(t));
    return ticks;
  }

  // ---------- Tooltip ----------
  function showTip(evt, html) {
    el.tooltip.innerHTML = html;
    el.tooltip.dataset.show = '1';
    el.tooltip.setAttribute('aria-hidden', 'false');
    const box = el.tooltip.getBoundingClientRect();
    let x = evt.clientX + 14;
    let y = evt.clientY - box.height - 10;
    if (x + box.width > innerWidth - 8) x = evt.clientX - box.width - 14;
    if (y < 8) y = evt.clientY + 18;
    el.tooltip.style.left = `${Math.max(8, x)}px`;
    el.tooltip.style.top = `${y}px`;
  }
  function hideTip() {
    el.tooltip.dataset.show = '0';
    el.tooltip.setAttribute('aria-hidden', 'true');
  }

  function attachHover(hit, mark, chart, html) {
    hit.addEventListener('mousemove', e => {
      chart.classList.add('dim');
      mark.classList.add('active');
      showTip(e, html);
    });
    hit.addEventListener('mouseleave', () => {
      chart.classList.remove('dim');
      mark.classList.remove('active');
      hideTip();
    });
  }

  // ---------- Data fetching ----------
  async function getJSON(url) {
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }

  async function boot() {
    try {
      const [{ years }, health] = await Promise.all([
        getJSON('/api/years'),
        getJSON('/api/health')
      ]);

      // /api/health is now called purely as a liveness guard: it turns an unreachable
      // database into one clear message instead of a confusing failure further in. The
      // name it also returns is no longer used — the exports stopped printing it.
      if (health.status !== 'healthy') throw new Error('Database unreachable');

      // The app shell fills this selector before either data page opens; honour a
      // year the user already picked rather than snapping back to the newest one.
      if (!el.year.options.length) {
        el.year.innerHTML = years
          .map(y => `<option value="${y.year}">${y.year}</option>`)
          .join('');
      }

      state.year = el.year.value || years[0].year;
      el.year.value = state.year;

      // The drill-down's own academic filter offers the same years as the page's, so
      // both are driven by one list from /api/years.
      window.EduConYears = years.map(y => y.year);

      // Delegated once, not per render: renderMatrix replaces the table's innerHTML on
      // every sort, filter and refresh, which would discard per-cell listeners.
      window.EduConDrill.bind(el.table);

      await loadYear();
    } catch (error) {
      showError(`Could not reach the database — ${error.message}`);
      el.main.removeAttribute('aria-busy');
    }
  }

  async function loadYear() {
    el.main.setAttribute('aria-busy', 'true');
    // Nothing on screen yet — draw the shape of what is coming. On a refresh the
    // existing figures stay put and only the progress bar reports the request.
    if (!state.report) { skeletonMatrix(); skeletonChart(); }
    setBusy(true);
    try {
      const next = await getJSON(`/api/report?year=${encodeURIComponent(state.year)}`);
      // Only diff within one academic year — switching years changes every figure on
      // screen, and flashing all of them would say "the database moved" when it did not.
      state.changed = next.academicYear === state.report?.academicYear
        ? diffReports(state.report, next)
        : new Set();
      state.report = next;
      // Fresh cell figures must not sit next to a drill-down list cached from the
      // previous fetch — a two-minute-old list under a current number reads as a bug.
      window.EduConDrill.invalidate();
      clearError();
      renderAll();
    } catch (error) {
      showError(error.message);
    } finally {
      el.main.removeAttribute('aria-busy');
      setBusy(false);
    }
  }

  const escapeHtml = s => String(s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- Derived views ----------
  function visibleMembers() {
    const q = state.search.trim().toLowerCase();
    let rows = state.report.members.filter(m =>
      (state.team === 'ALL' || m.team === state.team) &&
      (!q || m.name.toLowerCase().includes(q) || m.loginId.toLowerCase().includes(q))
    );
    if (state.hideEmpty) rows = rows.filter(m => memberTotal(m) > 0);

    const dir = state.sortDir;
    const key = state.sortKey;
    return rows.sort((a, b) => {
      // ETM always precedes ATM, whichever column the user sorts by.
      if (a.team !== b.team) return a.team === 'ETM' ? -1 : 1;

      let av, bv;
      const col = COLUMNS.find(c => c.key === key);
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'total') { av = memberTotal(a); bv = memberTotal(b); }
      else if (col) { av = colValue(col, a.statuses); bv = colValue(col, b.statuses); }
      else { av = 0; bv = 0; }
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.name.localeCompare(b.name);
    });
  }

  // ---------- Render: status distribution ----------
  function renderStatusChart() {
    const r = state.report;
    const data = COLUMNS
      .map(c => ({ col: c, count: colAssignedTotal(c, r) }))
      .filter(d => d.count > 0);

    // Every reported column is zero for this year. That is an answer, and it needs to
    // say so — an empty 0-height SVG would read as a chart that failed to draw.
    if (!data.length) {
      el.statusChart.innerHTML = emptyState({
        title: `No tracked students in ${r.academicYear}`,
        note: 'Every reported status is empty for this year. Students held only by the '
            + 'rcp / clo buckets, and the excluded statuses, are not counted here.'
      });
      el.distSub.textContent = `0 of ${COLUMNS.length} tracked columns present in ${r.academicYear}`;
      el.stageLegend.innerHTML = '';
      return;
    }

    const rowH = 30, gap = 6, padL = 216, padR = 54, padT = 22;
    const height = padT + data.length * (rowH + gap);
    const width = Math.max(el.statusChart.clientWidth || 760, 560);
    const plotW = width - padL - padR;
    const max = Math.max(...data.map(d => d.count), 1);
    const x = v => (v / max) * plotW;

    const svg = svgEl('svg', {
      viewBox: `0 0 ${width} ${height}`, role: 'img',
      'aria-label': `Student counts by application status for ${r.academicYear}`
    });

    niceTicks(max).forEach(t => {
      svg.appendChild(svgEl('line', {
        class: 'gridline', x1: padL + x(t), x2: padL + x(t), y1: padT - 6, y2: height - 4
      }));
      svg.appendChild(svgEl('text', {
        class: 'tick-text', x: padL + x(t), y: padT - 11, 'text-anchor': 'middle'
      }, t));
    });

    const cohort = trackedTotal(r);

    data.forEach((d, i) => {
      const y = padT + i * (rowH + gap);
      const w = Math.max(x(d.count), 2);
      const fill = cssVar(GROUP_VAR[d.col.key] || '--series-1');

      svg.appendChild(svgEl('text', {
        class: 'label-text', x: padL - 10, y: y + rowH / 2 + 4, 'text-anchor': 'end'
      }, d.col.label));

      // --i staggers the draw so the bars arrive in sequence, top to bottom, rather
      // than all at once. The CSS resolves both to their finished state under
      // prefers-reduced-motion, so the chart is complete either way.
      const bar = svgEl('path', {
        class: 'bar bar-grow', d: hBarPath(padL, y, w, rowH, 4), fill, style: `--i:${i}`
      });
      svg.appendChild(bar);

      svg.appendChild(svgEl('text', {
        class: 'value-text value-in', x: padL + w + 8, y: y + rowH / 2 + 4, style: `--i:${i}`
      }, d.count));

      const hit = svgEl('rect', { class: 'hit', x: padL, y: y - gap / 2, width: plotW + padR, height: rowH + gap });
      svg.appendChild(hit);
      attachHover(hit, bar, el.statusChart, `
        <div class="tooltip-title">${escapeHtml(d.col.label)}</div>
        <div class="tooltip-row"><b>${d.count}</b> students · ${cohort ? Math.round((d.count / cohort) * 100) : 0}% of tracked cohort</div>
        <div class="tooltip-row">DB value${d.col.statuses.length > 1 ? 's' : ''}: <b>${escapeHtml(d.col.statuses.join(', '))}</b></div>`);
    });

    el.statusChart.replaceChildren(svg);
    el.distSub.textContent =
      `${data.length} of ${COLUMNS.length} tracked columns present in ${r.academicYear} · exact counts`;
    el.stageLegend.innerHTML = '';
  }

  // ---------- Render: matrix ----------
  // Tint intensity carries magnitude; the numeral stays in primary ink at full
  // contrast in both themes. Mixing toward the surface rather than swapping text
  // colour means legibility never depends on getting a threshold right.
  function heatStyle(v, max) {
    if (!state.heatmap || !v) return '';
    const step = Math.min(6, Math.max(1, Math.ceil((v / max) * 6)));
    const alpha = [8, 15, 24, 34, 46, 60][step - 1];
    return ` style="background: color-mix(in srgb, var(--series-1) ${alpha}%, var(--surface-1))"`;
  }

  /**
   * Marks a cell as a way into the students behind it — js/students.js binds hover and
   * click to `td[data-col]` by delegation. Only non-zero cells are marked: there is no
   * list behind a 0, and an empty popover reads as a failure rather than as an answer.
   * Omitting data-etm means the Grand Total row: every student a real person handles.
   */
  /** A cell that fell to zero still moved — the zero branches skip drill(), so they
   *  pick the flash class up here instead. */
  const zeroFlash = (etmId, colKey) =>
    state.changed.has(cellKey(etmId, colKey)) ? ' cell-changed' : '';

  const drill = (colKey, etmId, cls = '') =>
    ` class="is-drill${cls ? ` ${cls}` : ''}${
       state.changed.has(cellKey(etmId, colKey)) ? ' cell-changed' : ''}" tabindex="0"` +
    ` data-col="${colKey}" data-year="${escapeHtml(state.year)}"` +
    (etmId ? ` data-etm="${etmId}"` : '') +
    ' title="Show the students behind this number"';

  /**
   * Puts the empty-rows chip in step with state.hideEmpty. Its label names the action
   * the next click performs, not the state it is already in, so a reader always knows
   * what pressing it will do. Called from both places that change the flag — the chip
   * itself and the "Clear filters" link in the empty state.
   */
  function syncZeroToggle() {
    const btn = $('zeroToggle');
    btn.classList.toggle('is-on', state.hideEmpty);
    btn.textContent = state.hideEmpty ? 'Unhide empty rows' : 'Hide empty rows';
  }

  function renderMatrix() {
    const r = state.report;
    const rows = visibleMembers();

    // No rows is a real answer to a filter, but a table showing only a header and a
    // Grand Total row does not say so. Name which filter emptied it and offer the
    // way back, rather than leaving the user to guess whether the query failed.
    if (!rows.length) {
      const filtered = state.search.trim() || state.team !== 'ALL' || state.hideEmpty;
      el.table.innerHTML = `<tbody><tr><td>${emptyState({
        title: filtered ? 'No team members match these filters' : `No team members recorded in ${state.year}`,
        note: filtered
          ? (state.search.trim()
              ? `Nothing matches “${state.search.trim()}” in the ${
                  state.team === 'ALL' ? 'ETM + ATM' : state.team} roster.`
              : 'No member in this team has a student with a record for the selected year.')
          : 'Older years often have most cases parked on the rcp / clo buckets, which are '
            + 'excluded from the roster. Try a more recent academic year.',
        action: filtered ? { id: 'matrixClearFilters', label: 'Clear filters' } : null
      })}</td></tr></tbody>`;

      const clear = $('matrixClearFilters');
      if (clear) clear.addEventListener('click', () => {
        state.search = ''; state.team = 'ALL'; state.hideEmpty = false;
        el.search.value = '';
        el.team.value = 'ALL';
        syncZeroToggle();
        // The chart ignores these filters, so only the matrix needs redrawing —
        // matching every other filter handler at the bottom of this file.
        renderMatrix();
      });
      return;
    }

    const max = Math.max(...rows.flatMap(m => COLUMNS.map(c => colValue(c, m.statuses))), 1);

    // One caret symbol, rotated for descending — ▲ and ▼ are different sizes in most
    // system fonts, so the header visibly shifted when the sort direction flipped.
    const arrow = k => state.sortKey === k
      ? `<svg class="ico sort-arrow${state.sortDir === 1 ? '' : ' is-desc'}" viewBox="0 0 24 24"` +
        ` aria-hidden="true"><use href="#icoCaret"/></svg>` : '';

    const head = `<thead><tr>
      <th class="col-sl">#</th>
      <th class="col-name" data-sort="name">Team member${arrow('name')}</th>
      <th class="col-total" data-sort="total">Total${arrow('total')}</th>
      ${COLUMNS.map(c =>
        `<th data-sort="${c.key}" title="${escapeHtml(c.statuses.join(', '))}">${escapeHtml(c.label)}${arrow(c.key)}</th>`).join('')}
    </tr></thead>`;

    let body = '';
    let lastTeam = null;
    let sl = 0;

    rows.forEach(m => {
      if (m.team !== lastTeam) {
        lastTeam = m.team;
        body += `<tr class="section-row"><td colspan="${COLUMNS.length + 3}">${
          m.team === 'ETM' ? 'Educon Team Members (ETM)' : 'Alumni Team Members (ATM)'}</td></tr>`;
        sl = 0;
      }
      sl += 1;
      const total = memberTotal(m);

      // data-who names the row for the drill-down's header, so the list can say whose
      // students it is showing without students.js having to re-read the matrix.
      const rowMoved = state.changed.has(cellKey(m.etmId, '__TOTAL__'));
      body += `<tr class="${rowMoved ? 'row-changed' : ''}" data-who="${escapeHtml(`${m.name} (${m.loginId})`)}">
        <td class="col-sl">${sl}</td>
        <td class="col-name"><span class="member-name">${escapeHtml(m.name)}</span><span class="member-code">${escapeHtml(m.loginId)}</span></td>
        ${total
          ? `<td${drill('__TOTAL__', m.etmId, 'col-total')}>${total}</td>`
          : `<td class="col-total cell-zero${zeroFlash(m.etmId, '__TOTAL__')}">0</td>`}
        ${COLUMNS.map(c => {
          const v = colValue(c, m.statuses);
          return v
            ? `<td${drill(c.key, m.etmId)}><span class="cell-v"${heatStyle(v, max)}>${v}</span></td>`
            : `<td class="cell-zero${zeroFlash(m.etmId, c.key)}">0</td>`;
        }).join('')}
      </tr>`;
    });

    // Each student is attributed to exactly one handler upstream, so this row is a
    // genuine column total: it equals the sum of the member rows above it. It excludes
    // students held only by the rcp/clo/E300/as pseudo-user buckets.
    const cohort = trackedTotal(r);
    const foot = `
      <tr class="total-row" data-who="All team members">
        <td class="col-sl"></td>
        <td class="col-name">Grand Total</td>
        ${cohort
          ? `<td${drill('__TOTAL__', null, 'col-total')}>${cohort}</td>`
          : `<td class="col-total cell-zero${zeroFlash(null, '__TOTAL__')}">0</td>`}
        ${COLUMNS.map(c => {
          const v = colAssignedTotal(c, r);
          return v
            ? `<td${drill(c.key, null)}>${v}</td>`
            : `<td class="cell-zero${zeroFlash(null, c.key)}">0</td>`;
        }).join('')}
      </tr>`;

    el.table.innerHTML = head + `<tbody>${body}</tbody><tfoot>${foot}</tfoot>`;
    el.table.classList.toggle('heat', state.heatmap);

    // Consumed. A sort or a search re-renders this table immediately afterwards, and
    // those must not re-flash figures that have not moved again.
    state.changed = new Set();

    /* NO FILTER ROW ON THIS TABLE — removed 2026-08-28 at the user's request, and not to
     * be reintroduced. A row of "min" boxes under every status heading was noise against
     * a grid whose whole job is to be read at a glance, and the two filters that matter
     * here already sit in the topbar: Team, and the member search. The drill-down list
     * behind a number keeps its own filters, which is where filtering was actually asked
     * for — see js/students.js. */

    // The header wraps to a variable number of lines, so its height is measured rather
    // than assumed — .section-row sticks to --head-h, immediately under the locked header.
    const headRow = el.table.querySelector('thead tr');
    if (headRow) el.table.style.setProperty('--head-h', `${headRow.getBoundingClientRect().height}px`);

    el.table.querySelectorAll('th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (state.sortKey === key) state.sortDir *= -1;
        else { state.sortKey = key; state.sortDir = key === 'name' ? 1 : -1; }
        renderMatrix();
      });
    });
  }

  // ---------- Excel export ----------
  // The workbook writer itself lives in js/xlsx.js — the filtered student list behind a
  // matrix cell exports too (js/students.js), and one hand-rolled ZIP/CRC/styles stack
  // serving both is what keeps the two sheets looking like one report.

  const X = window.EduConXlsx;
  const S = X.S;
  const colLetter = X.colLetter;

  function exportExcel() {
    const r = state.report;
    const rows = visibleMembers();
    const cohort = trackedTotal(r);

    // Column order matches the on-screen matrix exactly: Total sits beside the name,
    // ahead of the nine status columns, so the headline number is read first.
    const headers = ['Sl', 'Name of the ETM/ATM', 'Code', 'Total', ...COLUMNS.map(c => c.label)];
    const NCOL = headers.length;
    const last = colLetter(NCOL - 1);

    const sheet = [];
    const merges = [];

    // The title and the info strip each span the full width of the table, so nothing
    // is clipped by the column beneath it.
    sheet.push({ cells: [{ v: 'EduCon — Student Status Summary', s: S.title }], height: 26 });
    merges.push(`A1:${last}1`);

    // Academic year and generated-at only. The database name and its "(read-only)" note
    // used to sit here too; they were removed on 2026-09-01 because this sheet is printed
    // and circulated, and "educon_prod" is an internal detail that means nothing to the
    // people reading the report. Do not put it back on the exported page.
    sheet.push({
      cells: [{
        v: `Academic year: ${r.academicYear}     ·     Generated: ${new Date().toLocaleString()}`,
        s: S.info
      }],
      height: 18
    });
    merges.push(`A2:${last}2`);

    /* A filtered sheet says so, on the sheet.
     *
     * Team, the member search and "hide empty rows" all narrow what visibleMembers()
     * returns, and the export has always followed them — but silently, so a workbook of
     * six ATMs circulated as if it were the whole roster and nothing on the page said
     * otherwise. The line appears only when something is actually filtering: an
     * unfiltered export is byte-for-byte what it always was.
     *
     * This is not the "Database: educon_prod (read-only)" stamp removed on 2026-09-01 —
     * that was an internal detail meaning nothing to the reader. This is the opposite:
     * what the reader needs in order to know what they are holding. */
    const applied = [];
    if (state.team !== 'ALL') applied.push(`Team: ${state.team}`);
    if (state.search.trim()) applied.push(`Member search: "${state.search.trim()}"`);
    if (state.hideEmpty) applied.push('Members with no students hidden');
    if (applied.length) {
      sheet.push({
        cells: [{
          v: `Filtered — ${applied.join('     ·     ')}     ·     ${rows.length} of ${
            r.members.length} team members shown`,
          s: S.info
        }],
        height: 18
      });
      merges.push(`A${sheet.length}:${last}${sheet.length}`);
    }

    sheet.push({ cells: [] });
    sheet.push({ cells: headers.map(h => ({ v: h, s: S.head })), height: 44 });
    const HEAD_ROW = sheet.length;

    const teamLabel = t => t === 'ETM' ? 'Educon Team Members (ETM)' : 'Alumni Team Members (ATM)';

    /** A subtotal closes each team block, so ETM vs ATM load is readable without re-adding. */
    const pushSubtotal = (team, group) => {
      sheet.push({
        cells: [
          { v: `${teamLabel(team)} — subtotal`, s: S.totL }, { v: '', s: S.totL }, { v: '', s: S.totL },
          { v: group.reduce((n, m) => n + memberTotal(m), 0), s: S.tot },
          ...COLUMNS.map(c => ({ v: group.reduce((n, m) => n + colValue(c, m.statuses), 0), s: S.tot }))
        ]
      });
      merges.push(`A${sheet.length}:C${sheet.length}`);
    };

    let lastTeam = null, sl = 0, group = [];
    rows.forEach(m => {
      if (m.team !== lastTeam) {
        if (group.length) pushSubtotal(lastTeam, group);
        lastTeam = m.team;
        sl = 0;
        group = [];
        // Banded across the full width, so the team name is never cut off by column A.
        sheet.push({ cells: headers.map((_, i) => ({ v: i === 0 ? teamLabel(m.team) : '', s: S.sect })) });
        merges.push(`A${sheet.length}:${last}${sheet.length}`);
      }
      sl += 1;
      group.push(m);
      sheet.push({
        cells: [
          { v: sl, s: S.num }, { v: m.name, s: S.txt }, { v: m.loginId, s: S.txt },
          { v: memberTotal(m), s: S.tot },
          ...COLUMNS.map(c => ({ v: colValue(c, m.statuses), s: S.num }))
        ]
      });
    });
    if (group.length) pushSubtotal(lastTeam, group);

    /* The Grand Total is the server's assignedStatusTotals — a DISTINCT count across the
       whole cohort, which is deliberately not the sum of the rows above it (205 students
       are handled by two people). It therefore does not move when the rows are filtered,
       exactly as on screen. Unlabelled that reads as an arithmetic error in a printed
       sheet, so when a filter is on, the row says which population it counts. */
    sheet.push({
      cells: [
        { v: applied.length ? 'Grand Total (all members)' : 'Grand Total', s: S.grandL },
        { v: '', s: S.grandL }, { v: '', s: S.grandL },
        { v: cohort, s: S.grand },
        ...COLUMNS.map(c => ({ v: colAssignedTotal(c, r), s: S.grand }))
      ]
    });
    merges.push(`A${sheet.length}:C${sheet.length}`);

    // Wide enough that every header label wraps to at most two lines and stays readable.
    const cols = [{ w: 5 }, { w: 32 }, { w: 10 }, { w: 9 }, ...COLUMNS.map(() => ({ w: 15 }))];

    // Sheet 2 — the column definitions only: which exact database statuses sit behind
    // each dashboard column. The reconciliation figures live on the dashboard, not here.
    const notes = [];
    const nMerges = ['A1:B1'];
    notes.push({ cells: [{ v: 'Column definitions — exact database statuses', s: S.title }], height: 24 });
    notes.push({ cells: [{ v: 'Dashboard column', s: S.head }, { v: 'Exact application_status value(s)', s: S.head }] });
    COLUMNS.forEach(c => notes.push({ cells: [{ v: c.label, s: S.txt }, { v: c.statuses.join(', '), s: S.txt }] }));

    X.save([
      { name: 'Status Summary', rows: sheet, merges, cols, freezeRow: HEAD_ROW },
      { name: 'Notes & Definitions', rows: notes, merges: nMerges, cols: [{ w: 30 }, { w: 46 }] }
    ], `EduCon-Status-Summary-${r.academicYear}.xlsx`);
  }


  function renderAll() {
    renderStatusChart();
    renderMatrix();
  }

  // ---------- Wiring ----------
  el.year.addEventListener('change', () => { state.year = el.year.value; loadYear(); });
  el.team.addEventListener('change', () => { state.team = el.team.value; renderMatrix(); });

  let searchTimer;
  el.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = el.search.value;
      renderMatrix();
    }, 140);
  });

  $('refreshBtn').addEventListener('click', loadYear);
  $('exportExcel').addEventListener('click', exportExcel);
  $('heatToggle').addEventListener('click', e => {
    state.heatmap = !state.heatmap;
    e.currentTarget.classList.toggle('is-on', state.heatmap);
    renderMatrix();
  });

  $('zeroToggle').addEventListener('click', () => {
    state.hideEmpty = !state.hideEmpty;
    syncZeroToggle();
    renderMatrix();
  });

  // ---------- Theme ----------
  // The profile menu toggles, the settings dialog sets an explicit mode; both go
  // through here so the stored preference and the SVG re-render stay in step.

  /** 'light' | 'dark' | 'system' — what the user chose, not what is showing. */
  function themeMode() {
    return document.documentElement.getAttribute('data-theme') || 'system';
  }

  /** Whether dark is actually on screen right now. */
  function isDark() {
    const mode = themeMode();
    return mode === 'dark' ||
      (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function setTheme(mode) {
    const root = document.documentElement;
    if (mode === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);

    try {
      if (mode === 'system') localStorage.removeItem('educon-theme');
      else localStorage.setItem('educon-theme', mode);
    } catch { /* private mode */ }

    // Charts bake theme colours into their SVG, so they must be redrawn.
    if (state.report) renderAll();
    document.dispatchEvent(new CustomEvent('educon:theme', { detail: { mode, dark: isDark() } }));
  }

  $('themeBtn').addEventListener('click', () => setTheme(isDark() ? 'light' : 'dark'));

  try {
    const saved = localStorage.getItem('educon-theme');
    if (saved === 'light' || saved === 'dark') {
      document.documentElement.setAttribute('data-theme', saved);
    }
  } catch { /* storage unavailable */ }

  // A 'system' preference must follow the OS while the page is open.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themeMode() !== 'system') return;
    if (state.report) renderAll();
    document.dispatchEvent(new CustomEvent('educon:theme', { detail: { mode: 'system', dark: isDark() } }));
  });

  let resizeTimer;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!state.report) return;
      renderStatusChart();
      // A narrower window rewraps the header, moving where the team band must park.
      const headRow = el.table.querySelector('thead tr');
      if (headRow) el.table.style.setProperty('--head-h', `${headRow.getBoundingClientRect().height}px`);
    }, 180);
  });

  // Two-minute cadence, matching the hero on page 1. The interval skips while the tab
  // is hidden, so returning to it refreshes immediately rather than showing figures
  // that could be up to two minutes old.
  setInterval(() => { if (!document.hidden) loadYear(); }, 120000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.report) loadYear();
  });

  // The app shell owns navigation and decides when the summary page is first shown,
  // so booting is deferred rather than firing on script load.
  window.EduConSummary = {
    booted: false,
    boot() {
      if (this.booted) return;
      this.booted = true;
      boot();
    },
    setTheme,
    themeMode,
    isDark,
    // Shared so the Users page composes its empty states from the same markup —
    // two different-looking "nothing here" panels in one app is the thing to avoid.
    emptyState
  };
})();