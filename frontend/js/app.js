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
    const res = await fetch(url, {
      credentials: 'same-origin',
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
    state.overview = null;
    $('userMenuPanel').hidden = true;
    $('userMenuBtn').setAttribute('aria-expanded', 'false');
    showLogin();
    return null;
  }

  function signedIn(user) {
    state.user = user;
    $('loginScreen').hidden = true;
    $('appShell').hidden = false;

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

    Promise.all([loadHealth(), loadYears()]).then(() => go('dashboard'));
  }

  /** Pool liveness, shown in the status line from the moment the shell opens. */
  async function loadHealth() {
    const badge = $('dbBadge');
    try {
      const health = await api('/api/health');
      badge.className = `badge badge-${health.status === 'healthy' ? 'live' : 'error'}`;
      badge.textContent = health.status === 'healthy'
        ? `Live · ${health.database}` : 'Database unreachable';
    } catch (error) {
      badge.className = 'badge badge-error';
      badge.textContent = 'Connection failed';
      badge.title = error.message;
    }
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

  const PAGES = {
    dashboard: { el: 'pageDashboard', title: 'Dashboard',               sub: 'EduCon approval & disbursement pipeline' },
    summary:   { el: 'main',          title: 'Student Status Summary',  sub: 'Every team member against every database status' },
    users:     { el: 'pageUsers',     title: 'Dashboard accounts',      sub: 'Who can sign in, and what they may do' }
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
    $('pageSub').textContent = PAGES[page].sub;

    // dashboard.js renders the status distribution (page 1) and the matrix (page 2),
    // so it is booted for either data page.
    if (page === 'dashboard' || page === 'summary') window.EduConSummary.boot();
    if (page === 'dashboard') loadOverview();
    if (page === 'users') loadUsers();
  }

  document.querySelectorAll('.navlink').forEach(b =>
    b.addEventListener('click', () => go(b.dataset.page)));

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
      $('dbBadge').className = 'badge badge-error';
      $('dbBadge').textContent = 'Connection failed';
      $('dbBadge').title = error.message;
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

  async function loadOverview() {
    if (!state.year) return;
    const page = $('pageDashboard');
    page.setAttribute('aria-busy', 'true');

    try {
      state.overview = await api(`/api/overview?year=${encodeURIComponent(state.year)}`);
      $('freshness').textContent = `Updated ${new Date().toLocaleTimeString()}`;
      renderOverview();
    } catch (error) {
      $('heroHeadline').textContent = 'Could not load the pipeline';
      $('heroSub').textContent = error.message;
    } finally {
      page.removeAttribute('aria-busy');
    }
  }

  function renderOverview() {
    const o = state.overview;
    const h = o.headline;

    $('heroLive').textContent = `Live · educon_prod · ${o.academicYear}`;
    $('heroHeadline').innerHTML =
      `${o.cohortTotal} students tracked, <em>${h.disbursed} disbursed</em> so far.`;
    $('heroSub').textContent =
      `Academic year ${o.academicYear}. ${h.active} students are still moving through the ` +
      `pipeline and ${o.reconciliation.assignedDistinct} of the cohort are held by a named handler.`;

    $('heroStats').innerHTML = [
      ['Cohort', o.cohortTotal],
      ['Disbursed', h.disbursed],
      ['In pipeline', h.active],
      ['Assigned', o.reconciliation.assignedDistinct]
    ].map(([k, v]) => `<div class="hero-stat"><span class="v">${v}</span><span class="k">${k}</span></div>`).join('');
  }

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
          <td>${u.active ? '<span class="state-on">● Active</span>' : '<span class="state-off">○ Disabled</span>'}</td>
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
    $('loginTable').innerHTML = `
      <thead><tr><th>When</th><th>Username</th><th>Result</th><th>From</th></tr></thead>
      <tbody>${history.map(h => `
        <tr>
          <td>${new Date(h.at).toLocaleString()}</td>
          <td>${esc(h.username)}</td>
          <td>${h.ok ? '<span class="state-on">● Signed in</span>' : '<span class="state-off">✗ Rejected</span>'}</td>
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
