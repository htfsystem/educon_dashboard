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
   *   min     numeric floor; a cell with no number never passes a floor above zero
   */
  function passes(row, spec, values) {
    for (const col of spec.columns) {
      const v = values[col.index];
      if (v === undefined || v === '') continue;

      const text = cellText(row, col.index);

      if (col.type === 'select') {
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
    table.classList.toggle('is-filtered', Object.values(values).some(v => v !== ''));
    if (spec.onChange) spec.onChange(shown, rows.filter(r => !r.hasAttribute('data-filter-group')).length);
    return shown;
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

  /** Is anything currently filtering this table? Used to word an empty state. */
  const isActive = id => {
    const entry = store.get(id);
    return !!entry && Object.values(entry.values).some(v => v !== '');
  };

  return { mount, clear, isActive };
})();
