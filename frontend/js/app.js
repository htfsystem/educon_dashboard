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

  $('logoutBtn').addEventListener('click', async () => {
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

    document.body.dataset.page = page;
    $('pageTitle').textContent = PAGES[page].title;
    $('pageSub').textContent = PAGES[page].sub;

    if (page === 'dashboard') loadOverview();
    if (page === 'summary') window.EduConSummary.boot();
    if (page === 'users') loadUsers();
  }

  document.querySelectorAll('.navlink').forEach(b =>
    b.addEventListener('click', () => go(b.dataset.page)));
  $('toSummary').addEventListener('click', () => go('summary'));

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
    const pct = n => (o.cohortTotal ? Math.round((n / o.cohortTotal) * 100) : 0);

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
      ['Handlers', o.topMembers.length]
    ].map(([k, v]) => `<div class="hero-stat"><span class="v">${v}</span><span class="k">${k}</span></div>`).join('');

    $('ovTiles').innerHTML = [
      { k: 'Students tracked', v: o.cohortTotal, d: `Distinct records for ${o.academicYear}`, tone: 'var(--ec-blue-500)' },
      { k: 'Disbursed',        v: h.disbursed,   d: `${pct(h.disbursed)}% of the cohort`,     tone: 'var(--ec-green-500)' },
      { k: 'Active in pipeline', v: h.active,    d: 'Between creation and final approval',    tone: 'var(--ec-gold-500)' },
      { k: 'Needs attention',  v: h.attention,   d: 'Change required or rejected',            tone: 'var(--critical)' }
    ].map(t => `
      <div class="ov-tile" style="--tone:${t.tone}">
        <div class="k">${esc(t.k)}</div>
        <div class="v">${t.v}</div>
        <div class="d">${esc(t.d)}</div>
      </div>`).join('');

    // Exact statuses, never merged or renamed — only sorted by size.
    const rows = Object.entries(o.statusTotals).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...rows.map(r => r[1]));
    $('ovBars').innerHTML = rows.map(([status, n], i) => `
      <div class="ov-bar">
        <span class="l" title="${esc(status)}">${esc(status)}</span>
        <div class="track">
          <div class="fill" style="--w:${(n / max) * 100}%; animation-delay:${i * 45}ms"></div>
        </div>
        <span class="n">${n}</span>
      </div>`).join('');

    const r = o.reconciliation;
    const covered = r.cohortTotal ? r.assignedDistinct / r.cohortTotal : 0;
    $('ovRing').innerHTML = `
      <svg class="ring" width="118" height="118" viewBox="0 0 120 120" aria-hidden="true">
        <circle class="bg" cx="60" cy="60" r="54"></circle>
        <circle class="fg" cx="60" cy="60" r="54" style="--off:${339 - 339 * covered}"></circle>
      </svg>
      <div>
        <div class="ring-num">${r.assignedDistinct} / ${r.cohortTotal}</div>
        <div class="ring-legend">
          <div class="row"><span class="sw" style="background:var(--ec-green-500)"></span>Assigned to a named handler</div>
          <div class="row"><span class="sw" style="background:var(--wash)"></span>${r.unassigned} held only by system buckets</div>
        </div>
      </div>`;

    $('ovHandlers').innerHTML = o.topMembers.map((m, i) => `
      <div class="handler">
        <span class="av" style="background:${['var(--ec-blue-700)', 'var(--ec-green-600)', 'var(--ec-gold-500)', 'var(--ec-blue-500)'][i % 4]}">${esc(initials(m.name))}</span>
        <span class="nm">${esc(m.name)}</span>
        <span class="ct">${m.total}</span>
      </div>`).join('') || '<p class="panel-sub">No handler has students on record this year.</p>';

    renderTrend(o.trend);
  }

  /** Cohort size per year as a hand-drawn SVG line — no chart library, per project rules. */
  function renderTrend(trend) {
    const host = $('ovTrend');
    host.innerHTML = '';
    if (!trend || !trend.length) return;

    const years = [...trend].sort((a, b) => String(a.year).localeCompare(String(b.year)));
    const total = y => Object.values(y.statuses || {}).reduce((a, b) => a + b, 0);
    const disbursed = y => (y.statuses || {}).STUDENT_DISBURSED || 0;

    const W = 900, H = 240, padL = 44, padR = 16, padT = 16, padB = 34;
    const max = Math.max(1, ...years.map(total));
    const x = i => padL + (i * (W - padL - padR)) / Math.max(1, years.length - 1);
    const y = v => H - padB - (v / max) * (H - padT - padB);

    const NS = 'http://www.w3.org/2000/svg';
    const node = (tag, attrs, text) => {
      const n = document.createElementNS(NS, tag);
      Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
      if (text !== undefined) n.textContent = text;
      return n;
    };

    const svg = node('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img' });
    svg.appendChild(node('title', {}, 'Cohort size and disbursed students by academic year'));

    [0, 0.5, 1].forEach(f => {
      svg.appendChild(node('line', {
        x1: padL, x2: W - padR, y1: y(max * f), y2: y(max * f),
        stroke: 'var(--grid)', 'stroke-width': 1
      }));
      svg.appendChild(node('text', {
        x: padL - 8, y: y(max * f) + 4, 'text-anchor': 'end',
        'font-size': 10, fill: 'var(--text-muted)'
      }, Math.round(max * f)));
    });

    const path = pick => years.map((yr, i) => `${i ? 'L' : 'M'}${x(i)},${y(pick(yr))}`).join(' ');

    svg.appendChild(node('path', {
      d: `${path(total)} L${x(years.length - 1)},${H - padB} L${x(0)},${H - padB} Z`,
      fill: 'var(--ec-blue-500)', opacity: 0.12
    }));
    svg.appendChild(node('path', {
      d: path(total), fill: 'none', stroke: 'var(--ec-blue-500)',
      'stroke-width': 2.5, 'stroke-linejoin': 'round'
    }));
    svg.appendChild(node('path', {
      d: path(disbursed), fill: 'none', stroke: 'var(--ec-green-500)',
      'stroke-width': 2.5, 'stroke-dasharray': '5 4', 'stroke-linejoin': 'round'
    }));

    years.forEach((yr, i) => {
      svg.appendChild(node('circle', {
        cx: x(i), cy: y(total(yr)), r: i === years.length - 1 ? 5 : 3.2,
        fill: 'var(--ec-blue-500)'
      })).appendChild(node('title', {}, `${yr.year}: ${total(yr)} students, ${disbursed(yr)} disbursed`));
      svg.appendChild(node('text', {
        x: x(i), y: H - 12, 'text-anchor': 'middle',
        'font-size': 10, fill: 'var(--text-muted)'
      }, String(yr.year).replace('-', '–')));
    });

    host.appendChild(svg);
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
