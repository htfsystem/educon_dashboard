/**
 * EduCon Pipeline Dashboard — app shell.
 *
 * Owns authentication, navigation between the three pages, the executive overview
 * (page 1) and account management. The Student Status Summary (page 2) is rendered
 * by dashboard.js, which this file boots the first time that page is opened.
 *
 * Read-only throughout: the only writes anywhere in the product are to the local
 * account database, never to educon_prod.
 */

(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const state = { user: null, page: null, overview: null, year: null };

  // ---------- HTTP ----------

  async function api(url, options = {}) {
    // no-store: these figures move during the working day, and a cached 200 would
    // leave the hero quoting a number the database no longer holds.
    const res = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: options.body ? { 'Content-Type': 'application/json' } : {},
      ...options
    });

    // A session that expired mid-visit drops straight back to the login screen
    // rather than leaving a half-rendered page behind.
    if (res.status === 401 && state.user) return signedOut();

    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }

  const esc = s => String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const can = perm => !!state.user && state.user.permissions.includes(perm);

  const initials = name => String(name || '?')
    .trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

  // ---------- Authentication ----------

  async function start() {
    try {
      const { user } = await api('/api/auth/me');
      signedIn(user);
    } catch {
      showLogin();
    }
  }

  function showLogin() {
    $('appShell').hidden = true;
    $('loginScreen').hidden = false;
    $('loginUser').focus();
  }

  function signedOut() {
    state.user = null;
    window.EduConUser = null;
    state.overview = null;
    $('userMenuPanel').hidden = true;
    $('userMenuBtn').setAttribute('aria-expanded', 'false');
    closeSidebar();
    showLogin();
    return null;
  }

  function signedIn(user) {
    state.user = user;
    // js/students.js is booted by dashboard.js, not by this file, so the signed-in
    // user is published rather than passed. It decides only what to render — every
    // permission is enforced again on the server.
    window.EduConUser = user;
    $('loginScreen').hidden = true;
    $('appShell').hidden = false;

    // With AUTH_DISABLED set there is no session to end — signing out would only
    // bounce straight back in, so the control is removed rather than left dead.
    $('logoutBtn').hidden = !!user.authDisabled;

    $('userName').textContent = user.fullName;
    $('userRole').textContent = user.role;
    $('userAvatar').textContent = initials(user.fullName);
    $('userAvatarLg').textContent = initials(user.fullName);
    $('userNameFull').textContent = user.fullName;
    $('userHandle').textContent = `@${user.username} · ${user.role}`;
    $('setName').textContent = user.fullName;
    $('setRole').textContent = user.role;

    // Anything the role cannot use is taken out of the page entirely.
    document.querySelectorAll('[data-perm]').forEach(node => {
      const allowed = can(node.dataset.perm);
      node.hidden = !allowed;
      node.toggleAttribute('data-perm-denied', !allowed);
    });

    loadYears().then(() => go('dashboard'));
  }

  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('loginBtn');
    const err = $('loginError');

    btn.disabled = true;
    btn.textContent = 'Signing in…';
    err.hidden = true;

    try {
      const { user } = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: $('loginUser').value, password: $('loginPass').value })
      });
      $('loginPass').value = '';
      signedIn(user);
    } catch (error) {
      err.textContent = error.message;
      err.hidden = false;
      $('loginPass').select();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });

  // ---------- Profile menu ----------
  // One menu, rendered once in the shell, so it is identical on every page.

  const menuBtn = $('userMenuBtn');
  const menuPanel = $('userMenuPanel');

  function menuOpen() { return !menuPanel.hidden; }

  function openMenu() {
    describeTheme();
    menuPanel.hidden = false;
    menuBtn.setAttribute('aria-expanded', 'true');
    menuPanel.querySelector('.usermenu-item:not([hidden])')?.focus();
  }

  function closeMenu({ refocus = false } = {}) {
    menuPanel.hidden = true;
    menuBtn.setAttribute('aria-expanded', 'false');
    if (refocus) menuBtn.focus();
  }

  /** Keeps the theme row's hint honest about what a click will do. */
  function describeTheme() {
    const mode = window.EduConSummary.themeMode();
    $('themeHint').textContent = mode === 'system'
      ? `system · ${window.EduConSummary.isDark() ? 'dark' : 'light'}`
      : mode;
  }

  menuBtn.addEventListener('click', () => (menuOpen() ? closeMenu() : openMenu()));

  document.addEventListener('click', e => {
    if (menuOpen() && !$('userMenu').contains(e.target)) closeMenu();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && menuOpen()) closeMenu({ refocus: true });
  });

  // Arrow keys walk the menu once it is open.
  menuPanel.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...menuPanel.querySelectorAll('.usermenu-item:not([hidden])')];
    const next = items.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : -1);
    items[(next + items.length) % items.length]?.focus();
  });

  // Refresh and theme keep their own handlers elsewhere; the menu only closes after.
  ['refreshBtn', 'themeBtn'].forEach(id =>
    $(id).addEventListener('click', () => { describeTheme(); closeMenu(); }));

  $('manageUsersBtn').addEventListener('click', () => { closeMenu(); go('users'); });

  document.addEventListener('educon:theme', describeTheme);

  // ---------- Settings ----------

  const settingsDialog = $('settingsDialog');

  function paintThemeChoice() {
    const mode = window.EduConSummary.themeMode();
    document.querySelectorAll('#themeChoice .segmented-btn').forEach(b =>
      b.setAttribute('aria-checked', String(b.dataset.themeMode === mode)));
  }

  $('settingsBtn').addEventListener('click', () => {
    closeMenu();
    paintThemeChoice();
    settingsDialog.showModal();
  });

  document.querySelectorAll('#themeChoice .segmented-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      window.EduConSummary.setTheme(btn.dataset.themeMode);
      paintThemeChoice();
    }));

  $('logoutBtn').addEventListener('click', async () => {
    closeMenu();
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    signedOut();
  });

  // ---------- Navigation ----------

  // Each page's descriptive line lives in its own panel header, not the topbar.
  const PAGES = {
    dashboard: { el: 'pageDashboard', title: 'Dashboard' },
    summary:   { el: 'main',          title: 'Student Status Summary' },
    users:     { el: 'pageUsers',     title: 'Dashboard accounts' }
  };

  function go(page) {
    if (page === 'users' && !can('manage:users')) page = 'dashboard';
    state.page = page;

    Object.entries(PAGES).forEach(([name, def]) => {
      $(def.el).classList.toggle('is-active', name === page);
    });
    document.querySelectorAll('.navlink').forEach(b => {
      b.classList.toggle('is-active', b.dataset.page === page);
    });

    // The year selector is a single element that follows the active data page,
    // so page 1 and page 2 can never be looking at different years.
    const slot = page === 'summary' ? $('yearSlotSummary') : $('yearSlotDashboard');
    if (slot && $('yearField').parentElement !== slot) slot.appendChild($('yearField'));

    document.body.dataset.page = page;
    $('pageTitle').textContent = PAGES[page].title;
    closeSidebar();

    // dashboard.js renders the status distribution (page 1) and the matrix (page 2),
    // so it is booted for either data page.
    if (page === 'dashboard' || page === 'summary') window.EduConSummary.boot();
    if (page === 'dashboard') loadOverview();
    if (page === 'users') loadUsers();
  }

  document.querySelectorAll('.navlink').forEach(b =>
    b.addEventListener('click', () => go(b.dataset.page)));

  // ---------- Sidebar: collapse, drawer, resize ----------
  // One toggle, two behaviours decided by the breakpoint. Wide screens collapse the
  // sidebar to an icon rail; narrow ones slide it in as an off-canvas drawer. Both the
  // collapsed flag and the dragged width persist, so the layout a user sets stays set.

  const shell = $('appShell');
  const sidebar = $('sidebar');
  const scrim = $('sidebarScrim');
  // Two buttons, one behaviour each, and CSS shows exactly one at a time: the rail
  // toggle lives in the sidebar (wide screens), the drawer toggle in the topbar
  // (narrow screens, where a closed drawer would take the sidebar's own button with it).
  const sidebarToggle = $('sidebarToggle');
  const drawerToggle = $('drawerToggle');
  const toggles = [sidebarToggle, drawerToggle];
  const resizer = $('sidebarResizer');

  const WIDE = matchMedia('(min-width: 901px)');
  const SIDEBAR_MIN = 190;
  const SIDEBAR_MAX = 400;
  const SIDEBAR_DEFAULT = 244;

  // localStorage throws outright in some privacy modes, so every access is guarded
  // and simply falls back to the default layout.
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* not critical */ } }
  };

  const clampWidth = px =>
    Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)));

  function applyWidth(px) {
    // --sidebar-user-w, not --sidebar-w: see the note in app.css on #appShell.
    shell.style.setProperty('--sidebar-user-w', `${clampWidth(px)}px`);
  }

  function setCollapsed(on) {
    shell.classList.toggle('is-collapsed', on);
    store.set('educon.sidebar.collapsed', on ? '1' : '0');
    syncToggle();
  }

  /** Both toggles are labelled for whichever mode is actually live — only one shows. */
  function syncToggle() {
    const drawerOpen = sidebar.classList.contains('is-open');
    const collapsed = shell.classList.contains('is-collapsed');
    const expanded = WIDE.matches ? !collapsed : drawerOpen;
    const label = WIDE.matches
      ? (collapsed ? 'Expand sidebar' : 'Collapse sidebar')
      : (drawerOpen ? 'Hide sections' : 'Show sections');
    for (const t of toggles) {
      t.setAttribute('aria-expanded', String(expanded));
      t.setAttribute('aria-label', label);
    }
  }

  function openSidebar() {
    sidebar.classList.add('is-open');
    scrim.hidden = false;
    syncToggle();
    sidebar.querySelector('.navlink:not([hidden])')?.focus();
  }

  function closeSidebar() {
    sidebar.classList.remove('is-open');
    scrim.hidden = true;
    syncToggle();
  }

  for (const t of toggles) {
    t.addEventListener('click', () => {
      if (WIDE.matches) return setCollapsed(!shell.classList.contains('is-collapsed'));
      return sidebar.classList.contains('is-open') ? closeSidebar() : openSidebar();
    });
  }

  scrim.addEventListener('click', closeSidebar);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && sidebar.classList.contains('is-open')) {
      closeSidebar();
      // The drawer is only ever open below the breakpoint, where this is the
      // visible toggle — focusing the hidden rail button would drop focus entirely.
      drawerToggle.focus();
    }
  });

  // Crossing the breakpoint leaves the other mode's state stale, so reset the drawer
  // and re-label the toggle for whichever mode is now in force.
  WIDE.addEventListener('change', () => { closeSidebar(); syncToggle(); });

  // ---------- Drag to resize ----------
  // Pointer capture keeps the drag alive even when the cursor outruns the 6px handle.

  let dragFrom = 0;
  let dragWidth = 0;

  resizer.addEventListener('pointerdown', e => {
    if (!WIDE.matches || shell.classList.contains('is-collapsed')) return;
    dragFrom = e.clientX;
    dragWidth = sidebar.getBoundingClientRect().width;
    resizer.setPointerCapture(e.pointerId);
    shell.classList.add('is-resizing');
    e.preventDefault();
  });

  resizer.addEventListener('pointermove', e => {
    if (!shell.classList.contains('is-resizing')) return;
    applyWidth(dragWidth + (e.clientX - dragFrom));
  });

  const endDrag = e => {
    if (!shell.classList.contains('is-resizing')) return;
    shell.classList.remove('is-resizing');
    if (e.pointerId !== undefined && resizer.hasPointerCapture?.(e.pointerId)) {
      resizer.releasePointerCapture(e.pointerId);
    }
    store.set('educon.sidebar.width', String(sidebar.getBoundingClientRect().width));
  };
  resizer.addEventListener('pointerup', endDrag);
  resizer.addEventListener('pointercancel', endDrag);

  // Keyboard parity for the drag, and a double-click to get back to the default.
  resizer.addEventListener('keydown', e => {
    const step = e.shiftKey ? 32 : 8;
    const current = sidebar.getBoundingClientRect().width;
    if (e.key === 'ArrowLeft') applyWidth(current - step);
    else if (e.key === 'ArrowRight') applyWidth(current + step);
    else return;
    e.preventDefault();
    store.set('educon.sidebar.width', String(sidebar.getBoundingClientRect().width));
  });

  resizer.addEventListener('dblclick', () => {
    applyWidth(SIDEBAR_DEFAULT);
    store.set('educon.sidebar.width', String(SIDEBAR_DEFAULT));
  });

  // Restore the saved layout before the shell is first shown, so it never flashes
  // at the default width and then jumps.
  const savedWidth = Number(store.get('educon.sidebar.width'));
  if (Number.isFinite(savedWidth) && savedWidth > 0) applyWidth(savedWidth);
  if (store.get('educon.sidebar.collapsed') === '1') shell.classList.add('is-collapsed');
  syncToggle();

  // ---------- Academic years ----------
  // One year selector drives both data pages, so they can never disagree.

  async function loadYears() {
    try {
      const { years } = await api('/api/years');
      $('yearSelect').innerHTML = years
        .map(y => `<option value="${esc(y.year)}">${esc(y.year)}</option>`).join('');
      state.year = years[0].year;
      $('yearSelect').value = state.year;
    } catch (error) {
      // The hero is the only always-visible surface on page 1, so a failure to
      // reach the database has to be reported there.
      $('heroHeadline').textContent = 'Could not reach the database';
      $('heroSub').textContent = error.message;
    }
  }

  $('yearSelect').addEventListener('change', e => {
    state.year = e.target.value;
    state.overview = null;
    if (state.page === 'dashboard') loadOverview();
  });

  $('refreshBtn').addEventListener('click', () => {
    if (state.page === 'dashboard') { state.overview = null; loadOverview(); }
  });

  // ---------- Page 1: executive overview ----------
  // Every number in the hero is read from the selected year's payload, so the
  // year selector in the Status distribution panel drives this section too.

  async function loadOverview() {
    if (!state.year) return;
    const page = $('pageDashboard');
    page.setAttribute('aria-busy', 'true');
    window.EduConBusy.push();

    // A skeleton at the line's own height says "a number is coming" without
    // reserving the wrong amount of space or letting a stale figure stand. The big
    // figure itself is left alone: it animates from the old value to the new one, and
    // blanking it first would throw away the starting point of that movement.
    $('heroHeadline').innerHTML =
      '<span class="skeleton sk-line" style="display:block;width:min(28ch,100%)"></span>';

    try {
      state.overview = await api(`/api/overview?year=${encodeURIComponent(state.year)}`);
      renderOverview();
    } catch (error) {
      $('heroHeadline').textContent = 'Could not load the pipeline';
      $('heroSub').textContent = error.message;
    } finally {
      page.removeAttribute('aria-busy');
      window.EduConBusy.pop();
    }
  }

  // The colour each column takes in the stacked pipeline bar and its key. Same
  // variables the distribution chart uses, so a column is one colour on this page.
  const SEG_VAR = {
    CREATED: '--seq-2',
    SCRUTINY_PENDING: '--seq-3',
    APPROVAL_PENDING: '--seq-4',
    SANCTION_PENDING: '--seq-5',
    DISBURSEMENT_PENDING: '--seq-6',
    STUDENT_DISBURSED: '--good',
    NO_REQUIREMENT_THIS_YEAR: '--text-muted'
  };

  function renderOverview() {
    const o = state.overview;
    const n = v => Number(v ?? 0).toLocaleString();

    // Both figures are summed from assignedStatusTotals over the shared column list,
    // which is exactly how the Status Summary builds its Grand Total row. So the
    // headline always equals that row — it is not the raw cohort count, which would
    // include rejected, closed, career-point, budget-pending and unassigned students
    // that the matrix does not report.
    const disbursedCol = window.PIPELINE_COLUMNS.find(c => c.key === 'STUDENT_DISBURSED');
    const tracked = window.trackedFrom(o.assignedStatusTotals);
    const disbursed = window.colValue(disbursedCol, o.assignedStatusTotals);

    // The figure travels from whatever was on screen to the new one. On a refresh that
    // movement is the point: you see the pipeline move without reading two numbers.
    window.EduConMotion.count($('statTracked'), tracked);

    $('heroHeadline').innerHTML = tracked
      ? `<em>${n(disbursed)} disbursed</em> so far — ${
          Math.round((disbursed / tracked) * 100)}% of everyone tracked this year.`
      : 'No students tracked in this academic year.';

    // ---- the pipeline as one bar ----
    const segs = window.PIPELINE_COLUMNS
      .map(c => ({ c, v: window.colValue(c, o.assignedStatusTotals) }))
      .filter(s => s.v > 0);

    // flex-grow carries the proportion, so the bar re-proportions with a transition
    // when the year changes instead of being torn down and rebuilt.
    $('pipeBar').innerHTML = segs.map((s, i) =>
      `<span style="flex-grow:${s.v};--seg:var(${SEG_VAR[s.c.key]});--i:${i}"
             title="${esc(s.c.label)}: ${n(s.v)}"></span>`).join('');

    $('pipeKey').innerHTML = segs.map(s =>
      `<span class="pipekey-item"><i class="pipekey-dot" style="--seg:var(${SEG_VAR[s.c.key]})"></i>` +
      `${esc(s.c.label)} <b class="pipekey-n">${n(s.v)}</b></span>`).join('');

    // No standing explanation here — this node is an error surface only (see the
    // catch blocks above).
    $('heroSub').textContent = '';
  }

  // The dashboard auto-refreshes on a fixed cadence; both the overview and the
  // matrix use it, so the two can never show figures from different moments.
  const REFRESH_MS = 120000;

  window.EduConMotion.spotlight(document.querySelector('.bento'));

  // The matrix auto-refreshes every two minutes; the hero is refreshed on the
  // same cadence so the two can never show figures from different moments.
  const heroIsLive = () => state.page === 'dashboard' && state.user && !document.hidden;

  setInterval(() => { if (heroIsLive()) loadOverview(); }, REFRESH_MS);

  // The interval deliberately skips while the tab is hidden, so coming back could
  // otherwise leave up to two minutes of stale figures on screen. Refreshing on the
  // way back in means what you see on returning to the tab is what the database holds.
  document.addEventListener('visibilitychange', () => { if (heroIsLive()) loadOverview(); });
  window.addEventListener('online', () => { if (heroIsLive()) loadOverview(); });

  // ---------- Page 3: accounts ----------

  async function loadUsers() {
    if (!can('manage:users')) return;
    try {
      const [{ users }, { history }] = await Promise.all([
        api('/api/users'), api('/api/login-history')
      ]);
      renderUsers(users);
      renderHistory(history);
    } catch (error) {
      $('userTable').innerHTML = `<tbody><tr><td>${esc(error.message)}</td></tr></tbody>`;
    }
  }

  function renderUsers(users) {
    $('userTable').innerHTML = `
      <thead><tr>
        <th>Username</th><th>Full name</th><th>Role</th><th>Status</th><th>Created</th><th></th>
      </tr></thead>
      <tbody>${users.map(u => `
        <tr>
          <td><b>${esc(u.username)}</b></td>
          <td>${esc(u.fullName)}</td>
          <td><span class="role-pill role-${esc(u.role)}">${esc(u.role)}</span></td>
          <td>${u.active
            ? '<span class="state-on"><i class="state-dot"></i>Active</span>'
            : '<span class="state-off"><i class="state-dot"></i>Disabled</span>'}</td>
          <td>${new Date(u.createdAt).toLocaleDateString()}</td>
          <td><div class="row-actions">
            <button class="mini" data-edit="${u.id}" type="button">Edit</button>
            <button class="mini" data-toggle="${u.id}" type="button">${u.active ? 'Disable' : 'Enable'}</button>
            <button class="mini mini-danger" data-del="${u.id}" type="button">Delete</button>
          </div></td>
        </tr>`).join('')}</tbody>`;

    const byId = id => users.find(u => u.id === Number(id));

    $('userTable').querySelectorAll('[data-edit]').forEach(b =>
      b.addEventListener('click', () => openUserDialog(byId(b.dataset.edit))));

    $('userTable').querySelectorAll('[data-toggle]').forEach(b =>
      b.addEventListener('click', async () => {
        const u = byId(b.dataset.toggle);
        try {
          await api(`/api/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ active: !u.active }) });
          loadUsers();
        } catch (error) { alert(error.message); }
      }));

    $('userTable').querySelectorAll('[data-del]').forEach(b =>
      b.addEventListener('click', async () => {
        const u = byId(b.dataset.del);
        if (!confirm(`Delete the account "${u.username}"? This cannot be undone.`)) return;
        try {
          await api(`/api/users/${u.id}`, { method: 'DELETE' });
          loadUsers();
        } catch (error) { alert(error.message); }
      }));
  }

  function renderHistory(history) {
    if (!history.length) {
      $('loginTable').innerHTML = `<tbody><tr><td>${window.EduConSummary.emptyState({
        title: 'No sign-ins recorded yet',
        note: 'Every sign-in attempt against this dashboard, successful or not, is listed '
            + 'here once someone has signed in. The log holds the last 50.'
      })}</td></tr></tbody>`;
      return;
    }
    $('loginTable').innerHTML = `
      <thead><tr><th>When</th><th>Username</th><th>Result</th><th>From</th></tr></thead>
      <tbody>${history.map(h => `
        <tr>
          <td>${new Date(h.at).toLocaleString()}</td>
          <td>${esc(h.username)}</td>
          <td>${h.ok
            ? '<span class="state-on"><i class="state-dot"></i>Signed in</span>'
            : '<span class="state-off"><i class="state-dot"></i>Rejected</span>'}</td>
          <td>${esc(h.ip || '—')}</td>
        </tr>`).join('')}</tbody>`;
  }

  let editingId = null;

  function openUserDialog(user) {
    editingId = user ? user.id : null;

    $('userDialogTitle').textContent = user ? `Edit ${user.username}` : 'Add user';
    $('uUsername').value = user ? user.username : '';
    $('uUsername').disabled = !!user;          // the username is the account's identity
    $('uFullName').value = user ? user.fullName : '';
    $('uRole').value = user ? user.role : 'viewer';
    $('uPassword').value = '';
    $('uPassLabel').textContent = user
      ? 'New password (leave blank to keep the current one)'
      : 'Password (min 8 characters)';
    $('userFormError').hidden = true;

    $('userDialog').showModal();
  }

  $('addUserBtn').addEventListener('click', () => openUserDialog(null));

  // Closing directly rather than submitting the form: a submit — even one valued
  // 'cancel' — runs constraint validation first, so an empty required Username would
  // block the dialog from closing at all.
  $('userDialogClose').addEventListener('click', () => $('userDialog').close('cancel'));

  $('userForm').addEventListener('submit', async e => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();

    const err = $('userFormError');
    const payload = {
      fullName: $('uFullName').value.trim(),
      role: $('uRole').value
    };
    if ($('uPassword').value) payload.password = $('uPassword').value;

    try {
      if (editingId) {
        await api(`/api/users/${editingId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        await api('/api/users', {
          method: 'POST',
          body: JSON.stringify({ ...payload, username: $('uUsername').value.trim() })
        });
      }
      $('userDialog').close();
      loadUsers();
    } catch (error) {
      err.textContent = error.message;
      err.hidden = false;
    }
  });

  start();
})();
