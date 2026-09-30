/* EduCon Pipeline Dashboard — shared helpers.
 *
 * Loaded first. Everything here is used by two or more of app.js, dashboard.js,
 * students.js or filters.js; anything used by only one belongs in that file.
 */
window.EduConUtil = (() => {
  'use strict';

  const $ = id => document.getElementById(id);

  /* Escapes to text. `s ?? ''` matters: a null field must print as nothing, not as
     the word "null" — dashboard.js used to do the latter. */
  const HTML_ENTITY = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => HTML_ENTITY[c]);

  /* One fetch for the whole app. `no-store` because these figures move during the
     working day and a cached 200 leaves the page quoting a number the database no
     longer holds. `onUnauthorized` lets app.js drop to the login screen without this
     helper needing to know what a session is. */
  let onUnauthorized = null;

  async function getJSON(url, options = {}) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: options.body ? { 'Content-Type': 'application/json' } : {},
      ...options
    });

    if (res.status === 401 && onUnauthorized) {
      const handled = onUnauthorized();
      if (handled !== undefined) return handled;
    }

    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }

  /* Formatters are built once, not per call — `money` runs per cell and per total on
     a 21-column list. All three are en-IN: amounts group as 12,53,353, not 1,253,353. */
  const NUM = new Intl.NumberFormat('en-IN');
  const MONEY = new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0
  });
  const DATE = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' });
  const DATETIME = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

  const num = v => NUM.format(Number(v) || 0);
  const money = v => MONEY.format(Number(v) || 0);
  const date = v => (v ? DATE.format(new Date(v)) : '');
  const dateTime = v => (v ? DATETIME.format(new Date(v)) : '');

  const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* localStorage throws outright in some privacy modes, so every access is guarded and
     a failure degrades to "no saved preference" rather than breaking the page. */
  const store = {
    get(key) {
      try { return localStorage.getItem(key); } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); } catch { /* nothing to do */ }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch { /* nothing to do */ }
    }
  };

  /** Trailing debounce: fires once, `ms` after the last call. */
  function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  /** `<option>` list for a <select>. Values are escaped; labels default to the value. */
  const options = (values, { selected, label = v => v } = {}) => values
    .map(v => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(label(v))}</option>`)
    .join('');

  return {
    $, esc, getJSON, num, money, date, dateTime, plural, clamp, store, debounce, options,
    set unauthorizedHandler(fn) { onUnauthorized = fn; }
  };
})();
