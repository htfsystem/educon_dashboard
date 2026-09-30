/* EduCon Pipeline Dashboard — shared UI behaviour.
 *
 * The progress bar and the three motion helpers. Both pages use them; they lived in
 * columns.js only because that file loaded first, which left a file named for the
 * reported columns holding an animation library.
 */

/* The progress bar under the topbar.
 *
 * It counts rather than toggling: page 1 runs /api/overview and /api/report at once, so
 * a plain `hidden = true` from whichever finished first would clear the bar while the
 * other was still in flight. */
window.EduConBusy = {
  n: 0,
  push() { this.n += 1; this.sync(); },
  pop()  { this.n = Math.max(0, this.n - 1); this.sync(); },
  sync() {
    const bar = document.getElementById('loadBar');
    if (bar) bar.hidden = this.n === 0;
  }
};

/* Every helper here checks reduced motion and degrades to the finished state — a figure
   still reads correctly, a tile still lights up, a button still works. */
window.EduConMotion = (() => {
  'use strict';

  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');

  /** Digits that travel to their new value instead of teleporting.
   *
   *  Reads the previous value off the element, so a two-minute refresh animates from the
   *  figure that was on screen to the one that just arrived — the movement itself tells
   *  you the pipeline moved, and by how much. Eased out, never linear: a counter that
   *  decelerates reads as arriving somewhere rather than being scrubbed. */
  function count(node, to, { duration = 900 } = {}) {
    const from = Number(node.dataset.count || 0);
    node.dataset.count = String(to);

    if (REDUCED.matches || from === to) {
      node.textContent = window.EduConUtil.num(to);
      return;
    }

    // Cancel a run still in flight, or two refreshes in quick succession fight over the
    // same element and the figure flickers between them.
    if (node._countRAF) cancelAnimationFrame(node._countRAF);

    const t0 = performance.now();
    const tick = now => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      node.textContent = window.EduConUtil.num(Math.round(from + (to - from) * eased));
      if (p < 1) node._countRAF = requestAnimationFrame(tick);
      else { node._countRAF = null; node.textContent = window.EduConUtil.num(to); }
    };
    node._countRAF = requestAnimationFrame(tick);
  }

  /** Cursor-following highlight on [data-spotlight] tiles.
   *
   *  One delegated listener on the container, not one per tile, and it writes CSS custom
   *  properties rather than touching layout — the paint happens in the compositor. */
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

    // Leaving one tile for a gap between tiles must clear it too, or the highlight hangs
    // on the tile you have already left.
    root.addEventListener('pointerout', e => {
      const tile = e.target.closest('[data-spotlight]');
      if (tile && !tile.contains(e.relatedTarget)) tile.style.setProperty('--spot', '0');
    });
  }

  /** A button that leans toward the cursor and springs back when it leaves.
   *
   *  Capped at 4px: past that the control stops being where the user aimed, which costs
   *  more in accuracy than the effect is worth.
   *
   *  Writes custom properties, never `transform` itself. An inline transform would outrank
   *  the :active press rule in CSS, so a magnetic button would lose its press feedback —
   *  the CSS composes the two instead. */
  function magnetic(node, { strength = 0.28, max = 4 } = {}) {
    if (!node || REDUCED.matches) return;

    const clamp = v => window.EduConUtil.clamp(v, -max, max);

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
