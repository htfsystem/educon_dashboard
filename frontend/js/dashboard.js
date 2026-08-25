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
    database: null      // from /api/health, stamped onto the exports
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

      // Still needed: the database name is stamped onto the exports.
      state.database = health.database;
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

      await loadYear();
    } catch (error) {
      showError(`Could not reach the database — ${error.message}`);
      el.main.removeAttribute('aria-busy');
    }
  }

  async function loadYear() {
    el.main.setAttribute('aria-busy', 'true');
    try {
      state.report = await getJSON(`/api/report?year=${encodeURIComponent(state.year)}`);
      clearError();
      renderAll();
    } catch (error) {
      showError(error.message);
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

      body += `<tr>
        <td class="col-sl">${sl}</td>
        <td class="col-name"><span class="member-name">${escapeHtml(m.name)}</span><span class="member-code">${escapeHtml(m.loginId)}</span></td>
        <td class="col-total">${memberTotal(m)}</td>
        ${COLUMNS.map(c => {
          const v = colValue(c, m.statuses);
          return v
            ? `<td><span class="cell-v"${heatStyle(v, max)}>${v}</span></td>`
            : '<td class="cell-zero">0</td>';
        }).join('')}
      </tr>`;
    });

    // Each student is attributed to exactly one handler upstream, so this row is a
    // genuine column total: it equals the sum of the member rows above it. It excludes
    // students held only by the rcp/clo/E300/as pseudo-user buckets.
    const cohort = trackedTotal(r);
    const foot = `
      <tr class="total-row">
        <td class="col-sl"></td>
        <td class="col-name">Grand Total</td>
        <td class="col-total">${cohort}</td>
        ${COLUMNS.map(c => `<td>${colAssignedTotal(c, r)}</td>`).join('')}
      </tr>`;

    el.table.innerHTML = head + `<tbody>${body}</tbody><tfoot>${foot}</tfoot>`;
    el.table.classList.toggle('heat', state.heatmap);

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
  // A real .xlsx (Office Open XML in a ZIP), written by hand — no library, no CDN.
  // The previous export was SpreadsheetML 2003 saved under an .xls name, which made
  // Excel warn "the file format and extension don't match" on every open. A genuine
  // xlsx matches its extension, so it opens silently.

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /** ZIP with every entry stored uncompressed — the only method needing no deflate. */
  function zipStore(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;

    files.forEach(f => {
      const name = enc.encode(f.name);
      const data = enc.encode(f.data);
      const crc = crc32(data);

      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);      // version needed to extract
      lv.setUint16(6, 0x0800, true);  // UTF-8 file names
      lv.setUint16(8, 0, true);       // method 0 = stored
      lv.setUint16(12, 0x0021, true); // fixed 1980-01-01 date, so exports are reproducible
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      local.set(name, 30);

      const cd = new Uint8Array(46 + name.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(14, 0x0021, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      cd.set(name, 46);

      parts.push(local, data);
      offset += local.length + data.length;
      central.push(cd);
    });

    const cdStart = offset;
    let cdSize = 0;
    central.forEach(c => { parts.push(c); cdSize += c.length; });

    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdStart, true);
    parts.push(end);

    return new Blob(parts, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
  }

  /** 0 -> A, 25 -> Z, 26 -> AA. */
  function colLetter(n) {
    let s = '';
    let i = n + 1;
    while (i > 0) {
      const m = (i - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      i = (i - m - 1) / 26;
    }
    return s;
  }

  /**
   * Style ids used below, matching the order of <cellXfs> in styles.xml:
   * 0 default · 1 title · 2 info strip · 3 column header · 4 text · 5 number ·
   * 6 team band · 7 subtotal label · 8 subtotal number · 9 grand label · 10 grand number ·
   * 11 note · 12 note key
   */
  const S = {
    def: 0, title: 1, info: 2, head: 3, txt: 4, num: 5,
    sect: 6, totL: 7, tot: 8, grandL: 9, grand: 10, note: 11, noteKey: 12
  };

  /** A cell: numbers stay numeric so Excel can sum them; text goes inline. */
  const xc = (ref, v, s) => {
    const style = s ? ` s="${s}"` : '';
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
    if (v === null || v === undefined || v === '') return `<c r="${ref}"${style}/>`;
    return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeHtml(v)}</t></is></c>`;
  };

  /**
   * Builds one worksheet. `rows` is an array of { cells: [v|{v,s}], s, height },
   * `merges` a list of A1-style ranges, `cols` a list of { w, wrap }.
   */
  function sheetXml(rows, merges, cols, freezeRow) {
    const colsXml = cols.length
      ? `<cols>${cols.map((c, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${c.w}" customWidth="1"/>`).join('')}</cols>`
      : '';

    const body = rows.map((r, ri) => {
      const n = ri + 1;
      const cells = r.cells.map((c, ci) => {
        const o = (c && typeof c === 'object' && !Array.isArray(c)) ? c : { v: c, s: r.s };
        return xc(`${colLetter(ci)}${n}`, o.v, o.s === undefined ? r.s : o.s);
      }).join('');
      const h = r.height ? ` ht="${r.height}" customHeight="1"` : '';
      return `<row r="${n}"${h}>${cells}</row>`;
    }).join('');

    const pane = freezeRow
      ? `<sheetView workbookViewId="0"><pane ySplit="${freezeRow}" topLeftCell="A${freezeRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView>`
      : '<sheetView workbookViewId="0"/>';

    const mergeXml = merges.length
      ? `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
      : '';

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<sheetViews>${pane}</sheetViews>` +
      `<sheetFormatPr defaultRowHeight="15"/>${colsXml}` +
      `<sheetData>${body}</sheetData>${mergeXml}` +
      `<pageMargins left="0.4" right="0.4" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>` +
      `</worksheet>`;
  }

  const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="6">
 <font><sz val="11"/><name val="Calibri"/></font>
 <font><b/><sz val="16"/><color rgb="FF1F5FAE"/><name val="Calibri"/></font>
 <font><sz val="10"/><color rgb="FF595959"/><name val="Calibri"/></font>
 <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
 <font><b/><sz val="11"/><name val="Calibri"/></font>
 <font><b/><sz val="10"/><color rgb="FF333333"/><name val="Calibri"/></font>
</fonts>
<fills count="6">
 <fill><patternFill patternType="none"/></fill>
 <fill><patternFill patternType="gray125"/></fill>
 <fill><patternFill patternType="solid"><fgColor rgb="FF2A78D6"/><bgColor indexed="64"/></patternFill></fill>
 <fill><patternFill patternType="solid"><fgColor rgb="FFEEF4FC"/><bgColor indexed="64"/></patternFill></fill>
 <fill><patternFill patternType="solid"><fgColor rgb="FFF2F6FB"/><bgColor indexed="64"/></patternFill></fill>
 <fill><patternFill patternType="solid"><fgColor rgb="FF1F5FAE"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
 <border><left/><right/><top/><bottom/><diagonal/></border>
 <border>
  <left style="thin"><color rgb="FFB7C2CE"/></left>
  <right style="thin"><color rgb="FFB7C2CE"/></right>
  <top style="thin"><color rgb="FFB7C2CE"/></top>
  <bottom style="thin"><color rgb="FFB7C2CE"/></bottom>
  <diagonal/>
 </border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="13">
 <xf xfId="0" numFmtId="0" fontId="0" fillId="0" borderId="0"/>
 <xf xfId="0" numFmtId="0" fontId="1" fillId="0" borderId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
 <xf xfId="0" numFmtId="0" fontId="2" fillId="0" borderId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
 <xf xfId="0" numFmtId="0" fontId="3" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
 <xf xfId="0" numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
 <xf xfId="0" numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
 <xf xfId="0" numFmtId="0" fontId="4" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
 <xf xfId="0" numFmtId="0" fontId="4" fillId="4" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
 <xf xfId="0" numFmtId="0" fontId="4" fillId="4" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
 <xf xfId="0" numFmtId="0" fontId="3" fillId="5" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
 <xf xfId="0" numFmtId="0" fontId="3" fillId="5" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
 <xf xfId="0" numFmtId="0" fontId="2" fillId="0" borderId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>
 <xf xfId="0" numFmtId="0" fontId="5" fillId="0" borderId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

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

    sheet.push({
      cells: [{
        v: `Academic year: ${r.academicYear}     ·     Generated: ${new Date().toLocaleString()}` +
           `     ·     Database: ${state.database || 'educon_prod'} (read-only)`,
        s: S.info
      }],
      height: 18
    });
    merges.push(`A2:${last}2`);

    sheet.push({ cells: [] });
    sheet.push({ cells: headers.map(h => ({ v: h, s: S.head })), height: 44 });
    const HEAD_ROW = 4;

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

    sheet.push({
      cells: [
        { v: 'Grand Total', s: S.grandL }, { v: '', s: S.grandL }, { v: '', s: S.grandL },
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

    const files = [
      {
        name: '[Content_Types].xml',
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`
      },
      {
        name: '_rels/.rels',
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
      },
      {
        name: 'xl/workbook.xml',
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
<sheet name="Status Summary" sheetId="1" r:id="rId1"/>
<sheet name="Notes &amp; Definitions" sheetId="2" r:id="rId2"/>
</sheets>
</workbook>`
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
      },
      { name: 'xl/styles.xml', data: STYLES_XML },
      { name: 'xl/worksheets/sheet1.xml', data: sheetXml(sheet, merges, cols, HEAD_ROW) },
      { name: 'xl/worksheets/sheet2.xml', data: sheetXml(notes, nMerges, [{ w: 30 }, { w: 46 }], 0) }
    ];

    const a = document.createElement('a');
    a.href = URL.createObjectURL(zipStore(files));
    a.download = `EduCon-Status-Summary-${r.academicYear}.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
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
    isDark
  };
})();