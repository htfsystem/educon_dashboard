/* EduCon Pipeline Dashboard — client.
   Charts are hand-rolled SVG: no chart library, no CDN, works fully offline. */

(() => {
  'use strict';

  // ---------- Status presentation ----------
  // Display columns for the dashboard. Each column maps to one or more exact DB
  // statuses (see pipelineService.js / CLAUDE.md for the 13 real values) — the
  // underlying query and stored totals are never altered, only how they are grouped
  // and labelled for display. REACHED_CAREER_POINT, REJECTED and CASE_CLOSED are
  // intentionally excluded from every column, chart and total below.
  const COLUMNS = [
    { key: 'CREATED',            label: 'Form Not Submitted',   statuses: ['CREATED'] },
    { key: 'CHANGE_REQUIRED',    label: 'Change Required',      statuses: ['CHANGE_REQUIRED'] },
    { key: 'SCRUTINY_PENDING',   label: 'Scrutiny Pending',     statuses: ['SUBMITTED', 'REAPPLICATION_SUBMITTED'] },
    { key: 'APPROVAL_PENDING',   label: 'Approval Pending',     statuses: ['SCRUTINY_DONE'] },
    { key: 'SANCTION_PENDING',   label: 'Sanction Pending',     statuses: ['FIRST_LEVEL_APPROVED'] },
    { key: 'BUDGET_PENDING',     label: 'Budget Pending',       statuses: ['BUDGET_PENDING'] },
    { key: 'DISBURSEMENT_PENDING', label: 'Disbursement Pending', statuses: ['FINAL_LEVEL_APPROVED'] },
    { key: 'STUDENT_DISBURSED',  label: 'Student Disbursed',    statuses: ['STUDENT_DISBURSED'] },
    { key: 'NO_REQUIREMENT_THIS_YEAR', label: 'No Requirement This Year', statuses: ['NO_REQUIREMENT_THIS_YEAR'] }
  ];

  const GROUP_VAR = {
    CREATED:                '--seq-2',
    CHANGE_REQUIRED:        '--seq-2',
    SCRUTINY_PENDING:       '--seq-3',
    APPROVAL_PENDING:       '--seq-4',
    SANCTION_PENDING:       '--seq-5',
    BUDGET_PENDING:         '--seq-5',
    DISBURSEMENT_PENDING:   '--seq-5',
    STUDENT_DISBURSED:      '--good',
    NO_REQUIREMENT_THIS_YEAR: '--text-muted'
  };

  /** Sum of this column's underlying exact statuses from a { STATUS: count } map. */
  const colValue = (col, statusMap) =>
    col.statuses.reduce((n, s) => n + (statusMap[s] || 0), 0);

  // Member totals count only the 9 tracked columns — closed / rejected / reached-
  // career-point cases are excluded from every ETM/ATM count on this dashboard.
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
    fetchedAt: null,
    database: null      // from /api/health, stamped onto the exports
  };

  const $ = id => document.getElementById(id);
  const el = {
    main: $('main'), year: $('yearSelect'), team: $('teamSelect'), search: $('searchInput'),
    statusChart: $('statusChart'), stageLegend: $('stageLegend'),
    table: $('matrixTable'), tooltip: $('tooltip'),
    badge: $('dbBadge'), freshness: $('freshness'),
    distSub: $('distSub'), matrixSub: $('matrixSub')
  };

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

      state.database = health.database;
      el.badge.className = `badge badge-${health.status === 'healthy' ? 'live' : 'error'}`;
      el.badge.textContent = health.status === 'healthy'
        ? `Live · ${health.database}` : 'Database unreachable';

      // The app shell fills this selector before either data page opens; honour a
      // year the user already picked rather than snapping back to the newest one.
      if (!el.year.options.length) {
        el.year.innerHTML = years
          .map(y => `<option value="${y.year}">${y.year}</option>`)
          .join('');
      }

      state.year = el.year.value || years[0].year;
      el.year.value = state.year;

      await loadYear();
    } catch (error) {
      el.badge.className = 'badge badge-error';
      el.badge.textContent = 'Connection failed';
      el.main.removeAttribute('aria-busy');
      el.badge.title = error.message;
    }
  }

  async function loadYear() {
    el.main.setAttribute('aria-busy', 'true');
    try {
      state.report = await getJSON(`/api/report?year=${encodeURIComponent(state.year)}`);
      state.fetchedAt = Date.now();
      renderAll();
    } catch (error) {
      el.badge.className = 'badge badge-error';
      el.badge.textContent = escapeHtml(error.message);
    } finally {
      el.main.removeAttribute('aria-busy');
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

      const bar = svgEl('path', {
        class: 'bar', d: hBarPath(padL, y, w, rowH, 4), fill
      });
      svg.appendChild(bar);

      svg.appendChild(svgEl('text', {
        class: 'value-text', x: padL + w + 8, y: y + rowH / 2 + 4
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

  function renderMatrix() {
    const r = state.report;
    const rows = visibleMembers();
    const max = Math.max(...rows.flatMap(m => COLUMNS.map(c => colValue(c, m.statuses))), 1);

    const arrow = k => state.sortKey === k
      ? `<span class="sort-arrow">${state.sortDir === 1 ? '▲' : '▼'}</span>` : '';

    const head = `<thead><tr>
      <th class="col-sl">#</th>
      <th class="col-name" data-sort="name">Team member${arrow('name')}</th>
      ${COLUMNS.map(c =>
        `<th data-sort="${c.key}" title="${escapeHtml(c.statuses.join(', '))}">${escapeHtml(c.label)}${arrow(c.key)}</th>`).join('')}
      <th class="col-total" data-sort="total">Total${arrow('total')}</th>
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

      body += `<tr>
        <td class="col-sl">${sl}</td>
        <td class="col-name"><span class="team-tag team-${m.team}">${m.team}</span><span class="member-name">${escapeHtml(m.name)}</span><span class="member-code">${escapeHtml(m.loginId)}</span></td>
        ${COLUMNS.map(c => {
          const v = colValue(c, m.statuses);
          return v
            ? `<td><span class="cell-v"${heatStyle(v, max)}>${v}</span></td>`
            : '<td class="cell-zero">0</td>';
        }).join('')}
        <td class="col-total">${memberTotal(m)}</td>
      </tr>`;
    });

    // Each student is attributed to exactly one handler upstream, so this row is a
    // genuine column total: it equals the sum of the member rows above it. It excludes
    // students held only by the rcp/clo/E300/as pseudo-user buckets.
    const cohort = trackedTotal(r);
    const foot = `
      <tr class="total-row">
        <td class="col-sl"></td>
        <td class="col-name">Total (each student counted once)</td>
        ${COLUMNS.map(c => `<td>${colAssignedTotal(c, r)}</td>`).join('')}
        <td class="col-total">${cohort}</td>
      </tr>`;

    el.table.innerHTML = head + `<tbody>${body}</tbody><tfoot>${foot}</tfoot>`;
    el.table.classList.toggle('heat', state.heatmap);

    // The header wraps to a variable number of lines, so its height is measured rather
    // than assumed — .section-row sticks to --head-h, immediately under the locked header.
    const headRow = el.table.querySelector('thead tr');
    if (headRow) el.table.style.setProperty('--head-h', `${headRow.getBoundingClientRect().height}px`);

    el.matrixSub.textContent =
      `${rows.length} members × ${COLUMNS.length} columns · ${state.year} · ` +
      `each student counted under exactly one handler, so the rows add up to the total row`;

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
  // SpreadsheetML 2003: a genuine Excel file with typed numeric cells and styling,
  // produced with no library and no network call.
  function exportExcel() {
    const r = state.report;
    const rows = visibleMembers();
    const xe = s => escapeHtml(s);
    const cohort = trackedTotal(r);

    // Numbers default to the centred, fully bordered style; text to the left-aligned
    // one — so every cell in the sheet carries a row and column rule.
    const cell = (v, style) => typeof v === 'number'
      ? `<Cell ss:StyleID="${style || 'num'}"><Data ss:Type="Number">${v}</Data></Cell>`
      : `<Cell ss:StyleID="${style || 'txt'}"><Data ss:Type="String">${xe(v ?? '')}</Data></Cell>`;

    /** A plain, border-free cell — used only in the header/notes block above the table. */
    const bare = (v, style) =>
      `<Cell${style ? ` ss:StyleID="${style}"` : ''}><Data ss:Type="String">${xe(v ?? '')}</Data></Cell>`;

    const row = (cells) => `<Row>${cells}</Row>`;

    const rec = r.reconciliation;

    // Only what the end user actually needs on the front sheet: which year, when it was
    // pulled, and from where. The counting rules and reconciliation live on sheet 2.
    const infoRows = [
      ['Academic year', r.academicYear],
      ['Generated', new Date().toLocaleString()],
      ['Database', `${state.database || 'educon_prod'} (read-only)`]
    ];

    const reconRows = [
      ['Cohort total (records this year)', rec.cohortTotal],
      ['Assigned to a named member', rec.assignedDistinct],
      ['Unassigned (system buckets only)', rec.unassigned],
      ['Sum of member rows', rec.memberRowSum],
      ['Rows reconcile to assigned', rec.memberRowSum === rec.assignedDistinct ? 'YES' : 'NO — double counting'],
      ['Tracked total (9 pipeline columns)', cohort]
    ];

    // One continuous hairline on all four sides of every table cell.
    const BORDERS = '<Borders>' +
      ['Top', 'Bottom', 'Left', 'Right']
        .map(p => `<Border ss:Position="${p}" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#B7C2CE"/>`)
        .join('') + '</Borders>';

    let xml = `<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles>
 <Style ss:ID="title"><Font ss:Bold="1" ss:Size="14"/></Style>
 <Style ss:ID="sub"><Font ss:Size="10" ss:Color="#595959"/></Style>
 <Style ss:ID="note"><Font ss:Size="10" ss:Color="#595959"/>
   <Alignment ss:Horizontal="Left" ss:Vertical="Top" ss:WrapText="1"/></Style>
 <Style ss:ID="noteKey"><Font ss:Size="10" ss:Bold="1" ss:Color="#333333"/>
   <Alignment ss:Horizontal="Left" ss:Vertical="Top"/></Style>
 <Style ss:ID="head"><Font ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#2A78D6" ss:Pattern="Solid"/>
   <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>
   ${BORDERS}</Style>
 <Style ss:ID="sect"><Font ss:Bold="1"/><Interior ss:Color="#EEF4FC" ss:Pattern="Solid"/>
   <Alignment ss:Horizontal="Left" ss:Vertical="Center"/>${BORDERS}</Style>
 <Style ss:ID="txt"><Alignment ss:Horizontal="Left" ss:Vertical="Center"/>${BORDERS}</Style>
 <Style ss:ID="num"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/>${BORDERS}</Style>
 <Style ss:ID="tot"><Font ss:Bold="1"/>
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Interior ss:Color="#F2F6FB" ss:Pattern="Solid"/>${BORDERS}</Style>
 <Style ss:ID="totL"><Font ss:Bold="1"/>
   <Alignment ss:Horizontal="Left" ss:Vertical="Center"/>
   <Interior ss:Color="#F2F6FB" ss:Pattern="Solid"/>${BORDERS}</Style>
 <Style ss:ID="grand"><Font ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#1F5FAE" ss:Pattern="Solid"/>
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>${BORDERS}</Style>
 <Style ss:ID="grandL"><Font ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#1F5FAE" ss:Pattern="Solid"/>
   <Alignment ss:Horizontal="Left" ss:Vertical="Center"/>${BORDERS}</Style>
</Styles>
<Worksheet ss:Name="Status Summary">
<Table>
 <Column ss:Width="30"/><Column ss:Width="150"/><Column ss:Width="52"/>
 ${COLUMNS.map(() => '<Column ss:Width="74"/>').join('')}
 <Column ss:Width="52"/>
 ${row(bare('EduCon — Student Status Summary Sheet', 'title'))}
 ${infoRows.map(([k, v]) => row(bare(k, 'noteKey') + bare(v, 'note'))).join('\n ')}
 ${row('')}
 ${row(['Sl', 'Name of the ETM/ATM', 'Code', ...COLUMNS.map(c => c.label), 'Total']
     .map(h => cell(h, 'head')).join(''))}`;

    const teamLabel = t => t === 'ETM' ? 'Educon Team Members (ETM)' : 'Alumni Team Members (ATM)';

    // A subtotal row closes each team block, so the sheet answers "how much is ETM
    // carrying vs ATM" without the reader having to re-add the rows by hand.
    const subtotalRow = (label, group) => row([
      cell('', 'totL'), cell(label, 'totL'), cell('', 'totL'),
      ...COLUMNS.map(c => cell(group.reduce((n, m) => n + colValue(c, m.statuses), 0), 'tot')),
      cell(group.reduce((n, m) => n + memberTotal(m), 0), 'tot')
    ].join(''));

    let lastTeam = null, sl = 0, group = [];
    rows.forEach(m => {
      if (m.team !== lastTeam) {
        if (group.length) xml += subtotalRow(`${teamLabel(lastTeam)} — subtotal`, group);
        lastTeam = m.team;
        sl = 0;
        group = [];
        xml += row(cell(teamLabel(m.team), 'sect') +
          Array(COLUMNS.length + 2).fill(cell('', 'sect')).join(''));
      }
      sl += 1;
      group.push(m);
      xml += row([
        cell(sl), cell(m.name), cell(m.loginId),
        ...COLUMNS.map(c => cell(colValue(c, m.statuses))),
        cell(memberTotal(m), 'tot')
      ].join(''));
    });
    if (group.length) xml += subtotalRow(`${teamLabel(lastTeam)} — subtotal`, group);

    xml += row([cell('', 'grandL'), cell('DISTINCT TOTAL (each student counted once)', 'grandL'), cell('', 'grandL'),
      ...COLUMNS.map(c => cell(colAssignedTotal(c, r), 'grand')),
      cell(cohort, 'grand')].join(''));

    xml += `</Table></Worksheet>`;

    // Sheet 2 — what each column actually means in the database, plus the
    // reconciliation figures, so the numbers can be defended away from the dashboard.
    xml += `<Worksheet ss:Name="Notes &amp; Definitions"><Table>
 <Column ss:Width="220"/><Column ss:Width="300"/>
 ${row(bare('Column definitions — exact database statuses', 'title'))}
 ${row(cell('Dashboard column', 'head') + cell('Exact application_status value(s)', 'head'))}
 ${COLUMNS.map(c => row(cell(c.label) + cell(c.statuses.join(', ')))).join('\n ')}
 ${row('')}
 ${row(bare('Reconciliation', 'title'))}
 ${row(cell('Measure', 'head') + cell('Value', 'head'))}
 ${reconRows.map(([k, v]) => row(cell(k) + cell(v))).join('\n ')}
 ${row('')}
 ${row(bare('Excluded from every figure above: REACHED_CAREER_POINT, REJECTED, CASE_CLOSED. Pseudo-user accounts (rcp, clo, E300, as) are not people and are filtered out of the roster.', 'note'))}
</Table></Worksheet></Workbook>`;

    const blob = new Blob(['﻿', xml], { type: 'application/vnd.ms-excel' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `EduCon-Status-Summary-${r.academicYear}.xls`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- Freshness ----------
  function tickFreshness() {
    if (!state.fetchedAt) return;
    const s = Math.round((Date.now() - state.fetchedAt) / 1000);
    el.freshness.textContent = s < 5 ? 'Updated just now'
      : s < 60 ? `Updated ${s}s ago`
      : `Updated ${Math.round(s / 60)}m ago`;
  }

  function renderAll() {
    renderStatusChart();
    renderMatrix();
    tickFreshness();
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
  $('exportCsv').addEventListener('click', () => {
    location.href = `/api/export.csv?year=${encodeURIComponent(state.year)}`;
  });

  $('heatToggle').addEventListener('click', e => {
    state.heatmap = !state.heatmap;
    e.currentTarget.classList.toggle('is-on', state.heatmap);
    renderMatrix();
  });

  $('zeroToggle').addEventListener('click', e => {
    state.hideEmpty = !state.hideEmpty;
    e.currentTarget.classList.toggle('is-on', state.hideEmpty);
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

  setInterval(tickFreshness, 10000);
  setInterval(() => { if (!document.hidden) loadYear(); }, 120000);

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
    isDark
  };
})();