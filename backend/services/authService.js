/**
 * Dashboard authentication — its own user store, entirely separate from educon_prod.
 *
 * educon_prod is never read for credentials and never written to. Dashboard accounts
 * live in a local SQLite file (data/dashboard.db) using Node's built-in node:sqlite,
 * so there is no native module to compile.
 *
 * Roles:
 *   admin    dashboard + summary + student finance + export + manage users
 *   manager  dashboard + summary + student finance + export
 *   viewer   dashboard + summary
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const ROLES = ['admin', 'manager', 'viewer'];

// What each role is allowed to do. Checked on the server for every protected route;
// the frontend uses the same list only to decide what to render.
// `view:finance` covers one student's sanctioned / disbursed / pending amounts. Those
// are per-person money figures rather than pipeline counts, so a plain viewer can open
// the student list behind a cell but not the amounts behind a student.
const PERMISSIONS = {
  admin:   ['view:dashboard', 'view:summary', 'view:finance', 'export', 'manage:users'],
  manager: ['view:dashboard', 'view:summary', 'view:finance', 'export'],
  viewer:  ['view:dashboard', 'view:summary']
};

// DATA_DIR is overridable because hosts like Render mount persistent storage outside
// the repo (e.g. /var/data). Without a mounted disk the platform's filesystem is
// ephemeral and every account is lost on redeploy — see CLAUDE.md "Deploying".
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'dashboard.db');

const SESSION_COOKIE = 'educon_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;   // 8 hours

let db = null;

/** Opens (creating on first run) the local account database. */
function open() {
  if (db) return db;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pass_hash  TEXT NOT NULL,
      full_name  TEXT NOT NULL,
      role       TEXT NOT NULL,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_log (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      at       TEXT NOT NULL,
      ip       TEXT,
      ok       INTEGER NOT NULL
    );
  `);

  seedFirstAdmin();
  return db;
}

/**
 * A brand-new install has no accounts and would be unreachable, so the first run
 * creates one admin. The password comes from ADMIN_PASSWORD when set; otherwise a
 * random one is generated and printed once, which is safer than a known default.
 */
function seedFirstAdmin() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n > 0) return;

  const username = process.env.ADMIN_USERNAME || 'admin';
  const generated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');

  createUser({ username, password, fullName: 'Dashboard Administrator', role: 'admin' });

  console.log('\n  No dashboard accounts existed — created the first administrator:');
  console.log(`    username: ${username}`);
  console.log(`    password: ${generated ? `${password}   (generated — save it now)` : '(from ADMIN_PASSWORD)'}\n`);
}

const rowToUser = row => row && {
  id: row.id,
  username: row.username,
  fullName: row.full_name,
  role: row.role,
  active: row.active === 1,
  createdAt: row.created_at,
  permissions: PERMISSIONS[row.role] || []
};

// ---------- accounts ----------

function listUsers() {
  return open().prepare('SELECT * FROM users ORDER BY role, username').all().map(rowToUser);
}

function createUser({ username, password, fullName, role }) {
  const d = open();

  username = String(username || '').trim();
  if (!username) throw new Error('Username is required');
  if (!password || String(password).length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}`);

  const existing = d.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) throw new Error(`Username "${username}" is already taken`);

  d.prepare(`INSERT INTO users (username, pass_hash, full_name, role, active, created_at)
             VALUES (?, ?, ?, ?, 1, ?)`)
   .run(username, bcrypt.hashSync(String(password), 10),
        String(fullName || username).trim(), role, new Date().toISOString());

  return rowToUser(d.prepare('SELECT * FROM users WHERE username = ?').get(username));
}

function updateUser(id, { fullName, role, active, password }) {
  const d = open();
  const row = d.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) throw new Error('No such user');

  if (role !== undefined && !ROLES.includes(role)) {
    throw new Error(`Role must be one of: ${ROLES.join(', ')}`);
  }
  if (password !== undefined && String(password).length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  // Locking out the last admin would make the dashboard unadministrable.
  const losingAdmin = row.role === 'admin' && ((role && role !== 'admin') || active === false);
  if (losingAdmin) {
    const { n } = d.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1").get();
    if (n <= 1) throw new Error('This is the last active administrator — promote another first');
  }

  d.prepare(`UPDATE users SET full_name = ?, role = ?, active = ?, pass_hash = ? WHERE id = ?`)
   .run(fullName !== undefined ? String(fullName).trim() : row.full_name,
        role !== undefined ? role : row.role,
        active !== undefined ? (active ? 1 : 0) : row.active,
        password !== undefined ? bcrypt.hashSync(String(password), 10) : row.pass_hash,
        id);

  return rowToUser(d.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

function deleteUser(id) {
  const d = open();
  const row = d.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) throw new Error('No such user');
  if (row.role === 'admin') {
    const { n } = d.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1").get();
    if (n <= 1) throw new Error('This is the last active administrator — promote another first');
  }
  d.prepare('DELETE FROM users WHERE id = ?').run(id);
}

// ---------- login ----------

function verify(username, password, ip) {
  const d = open();
  const row = d.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());

  // Hash even when the user does not exist, so a missing account and a wrong password
  // take the same amount of time and cannot be told apart from outside.
  const hash = row ? row.pass_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
  const ok = bcrypt.compareSync(String(password || ''), hash) && !!row && row.active === 1;

  d.prepare('INSERT INTO login_log (username, at, ip, ok) VALUES (?, ?, ?, ?)')
   .run(String(username || ''), new Date().toISOString(), ip || null, ok ? 1 : 0);

  return ok ? rowToUser(row) : null;
}

function loginHistory(limit = 50) {
  return open().prepare('SELECT * FROM login_log ORDER BY id DESC LIMIT ?').all(limit)
    .map(r => ({ username: r.username, at: r.at, ip: r.ip, ok: r.ok === 1 }));
}

// ---------- session cookie ----------
// A signed, self-contained token: no server-side session table to keep in sync, and
// tampering with the payload invalidates the signature.

function secret() {
  if (!process.env.SESSION_SECRET) {
    // Stable across restarts within one install, so sessions survive a reload.
    const file = path.join(DATA_DIR, '.session-secret');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'));
    process.env.SESSION_SECRET = fs.readFileSync(file, 'utf8').trim();
  }
  return process.env.SESSION_SECRET;
}

const sign = data => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

function issueToken(user) {
  const body = Buffer.from(JSON.stringify({
    id: user.id, username: user.username, role: user.role,
    exp: Date.now() + SESSION_TTL_MS
  })).toString('base64url');
  return `${body}.${sign(body)}`;
}

function readToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');

  const expected = sign(body);
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;

  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!claims.exp || claims.exp < Date.now()) return null;

    // Re-read the account so a deactivated or re-roled user loses access immediately,
    // rather than keeping whatever the token was minted with.
    const row = open().prepare('SELECT * FROM users WHERE id = ?').get(claims.id);
    if (!row || row.active !== 1) return null;
    return rowToUser(row);
  } catch {
    return null;
  }
}

// ---------- express middleware ----------

// The login screen is OFF by default, here and on Render alike: every request arrives
// as this synthetic administrator, so /api/auth/me always succeeds and the frontend
// goes straight to the dashboard.
//
// The default is deliberately "no sign-in" rather than "sign-in unless disabled",
// because a host that never receives the .env file (Render does not) would otherwise
// silently bring the login page back — which is exactly what happened on 2026-08-28.
// Turning it on is now an explicit act on every host: set AUTH_ENABLED=true.
//
// Nothing below is deleted — accounts, bcrypt hashes, sessions and every
// requirePermission check are intact, so flipping the flag restores sign-in as it was.
// Note this leaves a public deployment fully open, finance figures included.
const AUTH_DISABLED = String(process.env.AUTH_ENABLED || '').toLowerCase() !== 'true';

const OPEN_ACCESS_USER = {
  id: 0,
  username: 'guest',
  fullName: 'EduCon Dashboard',
  role: 'admin',
  active: true,
  createdAt: null,
  permissions: PERMISSIONS.admin,
  authDisabled: true
};

/** Attaches req.user when a valid session cookie is present. Never rejects. */
function attachUser(req, _res, next) {
  req.user = AUTH_DISABLED
    ? OPEN_ACCESS_USER
    : readToken(req.cookies && req.cookies[SESSION_COOKIE]);
  next();
}

/** Guards a route. `permission` is optional; omit it to require only a valid session. */
const requirePermission = permission => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue' });
  if (permission && !req.user.permissions.includes(permission)) {
    return res.status(403).json({ error: `Your role (${req.user.role}) cannot ${permission}` });
  }
  next();
};

module.exports = {
  ROLES, PERMISSIONS, SESSION_COOKIE, SESSION_TTL_MS, AUTH_DISABLED,
  open, listUsers, createUser, updateUser, deleteUser,
  verify, loginHistory, issueToken, attachUser, requirePermission
};
