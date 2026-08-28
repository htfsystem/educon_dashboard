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

/* The progress bar under the topbar, shared by both loaders.
 *
 * Page 1 runs two requests at once — /api/overview from app.js and /api/report from
 * dashboard.js — so a plain hidden = true from whichever returned first would clear
 * the bar while the other was still in flight. It counts instead. Defined here because
 * columns.js is the first script loaded, so both callers can rely on it existing. */
window.EduConBusy = {
  n: 0,
  push() { this.n += 1; this.sync(); },
  pop()  { this.n = Math.max(0, this.n - 1); this.sync(); },
  sync() {
    const bar = document.getElementById('loadBar');
    if (bar) bar.hidden = this.n === 0;
  }
};

/* ---------------------------------------------------------------- motion ----
 * Shared interaction helpers. Both page scripts use them, so they live here with
 * the other cross-page utilities rather than being defined twice.
 *
 * Every one of them checks reduced motion and degrades to the finished state — a
 * figure still reads correctly, a tile still lights up, a button still works.
 */
window.EduConMotion = (() => {
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');

  /** Digits that travel to their new value instead of teleporting.
   *
   *  Reads the previous value off the element, so a two-minute refresh animates from
   *  the figure that was on screen to the one that just arrived — the movement itself
   *  tells you the pipeline moved, and by how much. Eased out, never linear: a counter
   *  that decelerates reads as arriving somewhere rather than being scrubbed. */
  function count(node, to, { duration = 900 } = {}) {
    const from = Number(node.dataset.count || 0);
    node.dataset.count = String(to);

    if (REDUCED.matches || from === to) {
      node.textContent = to.toLocaleString();
      return;
    }

    // Cancel a run still in flight, or two refreshes in quick succession fight over
    // the same element and the figure flickers between them.
    if (node._countRAF) cancelAnimationFrame(node._countRAF);

    const t0 = performance.now();
    const tick = now => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      node.textContent = Math.round(from + (to - from) * eased).toLocaleString();
      if (p < 1) node._countRAF = requestAnimationFrame(tick);
      else { node._countRAF = null; node.textContent = to.toLocaleString(); }
    };
    node._countRAF = requestAnimationFrame(tick);
  }

  /** Cursor-following highlight on [data-spotlight] tiles.
   *
   *  One delegated listener on the container, not one per tile, and it writes CSS
   *  custom properties rather than touching layout — the paint happens entirely in
   *  the compositor. --spot fades the layer so there is no hard edge on enter/leave. */
  function spotlight(root) {
    if (!root || REDUCED.matches) return;

    root.addEventListener('pointermove', e => {
      // Coarse pointers have no hover; the highlight would stick where you last tapped.
      if (e.pointerType !== 'mouse') return;
      const tile = e.target.closest('[data-spotlight]');
      if (!tile) return;
      const r = tile.getBoundingClientRect();
      tile.style.setProperty('--mx', `${e.clientX - r.left}px`);
      tile.style.setProperty('--my', `${e.clientY - r.top}px`);
      tile.style.setProperty('--spot', '1');
    });

    root.addEventListener('pointerleave', () => {
      root.querySelectorAll('[data-spotlight]').forEach(t => t.style.setProperty('--spot', '0'));
    });

    // Leaving one tile for a gap between tiles must clear it too, or the highlight
    // hangs on the tile you have already left.
    root.addEventListener('pointerout', e => {
      const tile = e.target.closest('[data-spotlight]');
      if (tile && !tile.contains(e.relatedTarget)) tile.style.setProperty('--spot', '0');
    });
  }

  /** A button that leans toward the cursor and springs back when it leaves.
   *
   *  Capped at 4px: past that the control stops being where the user aimed, which
   *  costs more in accuracy than the effect is worth. */
  function magnetic(node, { strength = 0.28, max = 4 } = {}) {
    if (!node || REDUCED.matches) return;

    const clamp = v => Math.max(-max, Math.min(max, v));

    // Writes custom properties, never `transform` itself. An inline transform would
    // outrank the :active press rule in CSS, so a magnetic button would lose its
    // press feedback — the CSS composes the two instead.
    node.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse') return;
      const r = node.getBoundingClientRect();
      node.style.setProperty('--mag-x', `${clamp((e.clientX - (r.left + r.width / 2)) * strength)}px`);
      node.style.setProperty('--mag-y', `${clamp((e.clientY - (r.top + r.height / 2)) * strength)}px`);
    });

    node.addEventListener('pointerleave', () => {
      node.style.removeProperty('--mag-x');
      node.style.removeProperty('--mag-y');
    });
  }

  return { count, spotlight, magnetic, get reduced() { return REDUCED.matches; } };
})();
