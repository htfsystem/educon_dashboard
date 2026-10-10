/* EduCon Pipeline Dashboard — column filters, one implementation for every table.
 *
 * Three tables want filtering and they are rebuilt in three different ways: the status
 * matrix replaces its own innerHTML on every sort and every two-minute refresh, the
 * drill-down list is rebuilt whenever the academic year changes, and the user tables are
 * rebuilt after every edit. A filter row written into the markup by each of those would
 * be destroyed by the next render, taking whatever the user had typed with it.
 *
 * So the filter state lives here, keyed by table, and survives the render. `mount()` is
 * called again after each rebuild; it re-creates the row, puts the values back, and
 * re-applies them. The caller never has to remember what was typed.
 *
 * Surviving a *render* is not the same as surviving a *session*, and the two were
 * conflated until 2026-09-05. The drill-down list calls `forget('drillList')` when its
 * dialog closes: a refresh mid-read must not lose what the user typed, but the next cell
 * they open is a different question, and answering it through the previous cell's filter
 * reads as missing students rather than as a filter still in force. The Users tables keep
 * theirs — they are a standing view of one page, not a window that opens and closes.
 *
 * Filtering is done on the rendered cell text rather than on the underlying data. That
 * is deliberate: what the user sees in a column is exactly what they are filtering, so a
 * decoded label ("Vegetarian") filters as the word on screen and not as the stored `1`.
 */
window.EduConFilters = (() => {
  'use strict';

  // Keyed by the id passed to mount(), NOT by element — the matrix element survives its
  // re-renders but the drill table is a brand new node each time.
  const store = new Map();

  const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

  // A filter value is a string, or — for a 'multi' column — the array of ticked values.
  const isSet = v => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '');

  /** A row's text for one column, taken from the cell the user is actually reading. */
  const cellText = (row, index) => {
    const cell = row.cells[index];
    return cell ? norm(cell.textContent) : '';
  };

  /**
   * Distinct values in a column, for a select filter.
   *
   * Built from every row rather than only the visible ones, so narrowing one column
   * never empties another column's list and strands the user with no way back.
   */
  function optionsFor(rows, index) {
    const seen = new Map();
    for (const row of rows) {
      const cell = row.cells[index];
      if (!cell) continue;
      const raw = String(cell.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!raw) continue;
      if (!seen.has(norm(raw))) seen.set(norm(raw), raw);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  /**
   * Does one row pass every active filter?
   *
   *   text    substring, case-insensitive — the forgiving default for names and places
   *   select  exact match on the whole cell, so "Jain" cannot also match "Non-Jain"
   *   multi   exact match on the whole cell against ANY of the ticked values
   *   min     numeric floor; a cell with no number never passes a floor above zero
   */
  function passes(row, spec, values) {
    for (const col of spec.columns) {
      const v = values[col.index];
      if (!isSet(v)) continue;

      const text = cellText(row, col.index);

      if (col.type === 'multi') {
        if (!v.some(x => norm(x) === text)) return false;
      } else if (col.type === 'select') {
        if (text !== norm(v)) return false;
      } else if (col.type === 'min') {
        const n = Number(String(text).replace(/[^0-9.-]/g, ''));
        if (!Number.isFinite(n) || n < Number(v)) return false;
      } else {
        if (!text.includes(norm(v))) return false;
      }
    }
    return true;
  }

  /**
   * Show or hide rows, and report how many survived.
   *
   * Group headings (`data-filter-group`) are not filtered but are hidden when every row
   * beneath them has gone — an "Alumni Team Members (ATM)" band over nothing reads as a
   * rendering fault rather than as an empty result.
   */
  function apply(entry) {
    const { table, spec, values } = entry;
    const body = table.tBodies[0];
    if (!body) return 0;

    const rows = [...body.rows];
    let shown = 0;

    // Walk backwards so each group heading already knows whether anything below it
    // survived by the time it is reached.
    let sinceGroup = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (row.hasAttribute('data-filter-group')) {
        row.hidden = sinceGroup === 0;
        sinceGroup = 0;
        continue;
      }
      const ok = passes(row, spec, values);
      row.hidden = !ok;
      if (ok) { shown += 1; sinceGroup += 1; }
    }

    /* Renumber the serial column against what survived.
     *
     * Without this a filtered table reads 1, 2, 4, 5, 9 — the positions the rows held
     * before anything was hidden — which looks like missing data rather than like a
     * filter. The topbar's own member search already renumbers, because it re-renders;
     * these filters only hide, so the numbering is corrected here instead.
     *
     * The counter resets at each group heading, so the matrix's ETM and ATM blocks each
     * start at 1 exactly as renderMatrix numbers them unfiltered. */
    if (spec.renumber !== undefined) {
      let n = 0;
      for (const row of rows) {
        if (row.hasAttribute('data-filter-group')) { n = 0; continue; }
        if (row.hidden) continue;
        n += 1;
        const cell = row.cells[spec.renumber];
        if (cell) cell.textContent = String(n);
      }
    }

    entry.shown = shown;
    table.classList.toggle('is-filtered', Object.values(values).some(isSet));
    if (spec.onChange) spec.onChange(shown, rows.filter(r => !r.hasAttribute('data-filter-group')).length);
    return shown;
  }

  /* ---------- Multi-select: a button that opens a list of tick boxes ----------
   *
   * Asked for on 2026-10-09 for Education, Field of education, Specialization, Board /
   * University, Support Year and Cumulative Disbursed — columns where the question is
   * "show me these three courses", which a single-choice select cannot ask.
   *
   * The panel is `position: fixed`, placed from the button's rectangle: the header is
   * sticky inside a scrolling region, which would clip an absolutely positioned list. It
   * lives inside the table (so inside the <dialog>, which is in the top layer — a panel
   * appended to <body> would be drawn underneath it). Only one is open at a time, and it
   * closes on an outside click, Escape, or any scroll. */
  let openMulti = null;
  const closeMulti = () => {
    if (!openMulti) return;
    openMulti.panel.hidden = true;
    openMulti.btn.setAttribute('aria-expanded', 'false');
    openMulti = null;
  };
  document.addEventListener('click', e => { if (openMulti && !openMulti.wrap.contains(e.target)) closeMulti(); });
  document.addEventListener('scroll', e => { if (openMulti && !openMulti.panel.contains(e.target)) closeMulti(); }, true);

  function buildMulti(entry, col, i, dataRows) {
    const { values } = entry;
    const chosen = () => (Array.isArray(values[i]) ? values[i] : []);

    const wrap = document.createElement('div');
    wrap.className = 'filter-multi';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'filter-input filter-multi-btn';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', `Filter by ${col.label || `column ${i + 1}`}`);

    const panel = document.createElement('div');
    panel.className = 'filter-multi-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'group');

    const paint = () => {
      const n = chosen().length;
      btn.textContent = n === 0 ? (col.allLabel || 'All') : n === 1 ? chosen()[0] : `${n} selected`;
      btn.title = chosen().join(', ');
      btn.classList.toggle('is-set', n > 0);
    };

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'filter-multi-clear';
    clear.textContent = 'Clear selection';
    panel.appendChild(clear);

    // A saved value whose option has gone (data changed under it) is kept, so the control
    // never claims fewer filters than are in force.
    const known = optionsFor(dataRows, i);
    const all = [...known, ...chosen().filter(v => !known.some(k => norm(k) === norm(v)))];
    const boxes = all.map(value => {
      const label = document.createElement('label');
      label.className = 'filter-multi-opt';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = value;
      box.checked = chosen().some(v => norm(v) === norm(value));
      const text = document.createElement('span');
      text.textContent = value;
      label.append(box, text);
      panel.appendChild(label);
      return box;
    });

    const commit = () => {
      values[i] = boxes.filter(b => b.checked).map(b => b.value);
      paint();
      apply(entry);
    };
    boxes.forEach(b => b.addEventListener('change', commit));
    clear.addEventListener('click', () => { boxes.forEach(b => { b.checked = false; }); commit(); });

    btn.addEventListener('click', () => {
      if (openMulti && openMulti.panel === panel) { closeMulti(); return; }
      closeMulti();
      const r = btn.getBoundingClientRect();
      panel.hidden = false;
      panel.style.minWidth = `${Math.max(r.width, 180)}px`;
      panel.style.left = `${Math.round(Math.min(r.left, window.innerWidth - 260))}px`;
      panel.style.top = `${Math.round(r.bottom + 4)}px`;
      panel.style.maxHeight = `${Math.max(160, Math.min(320, window.innerHeight - r.bottom - 16))}px`;
      btn.setAttribute('aria-expanded', 'true');
      openMulti = { wrap, panel, btn };
    });
    wrap.addEventListener('keydown', e => {
      if (e.key === 'Escape' && openMulti) { e.preventDefault(); e.stopPropagation(); closeMulti(); btn.focus(); }
      if (e.key === 'Enter') e.preventDefault();
    });

    paint();
    wrap.append(btn, panel);
    return wrap;
  }

  /** Builds the filter row itself. One `<tr>` in the head, one control per column. */
  function buildRow(entry) {
    const { table, spec, values } = entry;
    const head = table.tHead;
    if (!head) return;

    const dataRows = [...(table.tBodies[0]?.rows || [])]
      .filter(r => !r.hasAttribute('data-filter-group'));

    const tr = document.createElement('tr');
    tr.className = 'filter-row';

    const width = head.rows[0] ? head.rows[0].cells.length : spec.columns.length;

    for (let i = 0; i < width; i += 1) {
      const td = document.createElement('th');

      // The filter cell inherits the header cell's own classes, so it is the same column
      // in every respect the stylesheet cares about: the frozen Sl/name cells stay frozen
      // when the matrix scrolls sideways, and the width caps on the prose columns apply
      // to the filter box as well as to the values under it.
      const headCell = head.rows[0]?.cells[i];
      td.className = `filter-cell${headCell ? ` ${headCell.className}` : ''}`;

      const col = spec.columns.find(c => c.index === i);
      if (!col) { tr.appendChild(td); continue; }

      if (col.type === 'multi') {
        td.appendChild(buildMulti(entry, col, i, dataRows));
        tr.appendChild(td);
        continue;
      }

      let control;
      if (col.type === 'select') {
        control = document.createElement('select');
        control.className = 'filter-input filter-select';
        const all = document.createElement('option');
        all.value = '';
        all.textContent = col.allLabel || 'All';
        control.appendChild(all);
        for (const value of optionsFor(dataRows, i)) {
          const opt = document.createElement('option');
          opt.value = value;
          opt.textContent = value;
          control.appendChild(opt);
        }
        // A saved value whose option has gone (the year changed under it) would silently
        // select "All" and show more rows than the control claims. Re-add it instead.
        if (values[i] && !optionsFor(dataRows, i).some(v => norm(v) === norm(values[i]))) {
          const opt = document.createElement('option');
          opt.value = values[i];
          opt.textContent = values[i];
          control.appendChild(opt);
        }
      } else {
        control = document.createElement('input');
        control.className = 'filter-input';
        control.type = col.type === 'min' ? 'number' : 'search';
        if (col.type === 'min') { control.min = '0'; control.step = '1'; }
        control.placeholder = col.placeholder || (col.type === 'min' ? 'min' : 'Filter…');
        control.autocomplete = 'off';
        // size=1 with width:100% in CSS. An input's default intrinsic width is about 20
        // characters, and in an auto-layout table that becomes the column's minimum —
        // so a Student ID column holding "e747" was being held open to 179px by the box
        // under it. size=1 drops the intrinsic contribution to nothing and lets the
        // column size to its data, which is the whole point of the auto layout.
        control.size = 1;
      }

      control.value = values[i] ?? '';
      control.setAttribute('aria-label', `Filter by ${col.label || `column ${i + 1}`}`);
      // `is-set` is what CSS colours an active filter by. It has to be a class: a typed
      // value never writes back to the `value` attribute, so [value=""] cannot see it.
      control.classList.toggle('is-set', control.value !== '');

      const onInput = () => {
        values[i] = control.value;
        control.classList.toggle('is-set', control.value !== '');
        apply(entry);
      };
      control.addEventListener('input', onInput);
      control.addEventListener('change', onInput);
      // Enter in a filter box must not submit the dialog's form or close the dialog.
      control.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });

      td.appendChild(control);
      tr.appendChild(td);
    }

    head.appendChild(tr);
  }

  /**
   * Attach (or re-attach) filters to a table.
   *
   * Call it after every render of that table. Values typed before the render are put
   * back and re-applied, so a two-minute refresh never clears what the user set up.
   */
  function mount(table, spec) {
    if (!table || !table.tHead) return null;

    const id = spec.id;
    const prev = store.get(id);
    // Column layouts differ between renders only when the caller changes them; a stale
    // value on an index that now means something else would filter the wrong column.
    const sameShape = prev && prev.shape === shapeOf(spec);
    const values = sameShape ? prev.values : {};

    const entry = { table, spec, values, shape: shapeOf(spec), shown: 0 };
    store.set(id, entry);

    buildRow(entry);
    apply(entry);
    return entry;
  }

  const shapeOf = spec => spec.columns.map(c => `${c.index}:${c.type}:${c.label}`).join('|');

  /** Empty every filter on a table and redraw its row. */
  function clear(id) {
    const entry = store.get(id);
    if (!entry) return;
    entry.values = {};
    entry.table.tHead.querySelector('.filter-row')?.remove();
    buildRow(entry);
    apply(entry);
  }

  /**
   * Drop a table's remembered filters entirely, so the next mount() starts blank.
   *
   * `clear()` is for a table that is on screen — it empties the controls the user is
   * looking at. This is for one that is going away: the drill-down dialog forgets its
   * filters when it closes, because the next number opened is a different question and
   * arriving at it pre-filtered by the last one reads as missing students rather than as
   * a filter still in force. Safe to call when the table's node is already gone.
   */
  function forget(id) {
    store.delete(id);
  }

  /**
   * The filters currently in force, as [{ label, value }], in column order.
   *
   * Exported so a report can say what it is a subset of. A filtered list saved to Excel
   * with no record of the filter is the dangerous artefact here: "58 students" circulates
   * as the cell's total. The export stamps this into the sheet header.
   */
  function active(id) {
    const entry = store.get(id);
    if (!entry) return [];
    return entry.spec.columns
      .filter(c => isSet(entry.values[c.index]))
      .map(c => {
        const v = entry.values[c.index];
        return { label: c.label || `Column ${c.index + 1}`, value: Array.isArray(v) ? v.join(', ') : v };
      });
  }

  /** Is anything currently filtering this table? Used to word an empty state. */
  const isActive = id => active(id).length > 0;

  return { mount, clear, forget, active, isActive };
})();
