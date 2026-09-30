/**
 * Dashboard authentication — its own user store, entirely separate from educon_prod.
 *
 * educon_prod is never read for credentials and never written to.
 *
 * Accounts live in **MySQL**, in a schema alongside educon_prod (default
 * `educon_test_1`, overridable with AUTH_DB_NAME). They used to live in a local
 * SQLite file, and on Render that filesystem is ephemeral: every deploy, every
 * restart and — on the free tier — every 15 minutes of idle destroyed the file, so
 * accounts created through the Users page vanished and only the ADMIN_USERNAME /
 * ADMIN_PASSWORD administrator came back, because it is re-seeded from the
 * environment. A colleague added yesterday could not sign in today. MySQL is the
 * same database the dashboard already depends on, so an account created once now
 * survives every restart, indefinitely.
 *
 * The `educon` user holds ALL PRIVILEGES on `educon_test_1` and
 * `educon_testdb_27sep25` (verified 2026-09-09 by creating, writing and dropping a
 * probe table in each). `educon_prod` is untouched by anything in this file.
 *
 * The session signing key lives in the same table, so sessions also survive a
 * restart without SESSION_SECRET having to be set by hand.
 *
 * Roles:
 *   admin    dashboard + summary + student finance + export + manage users
 *   manager  dashboard + summary + student finance + export
 *   viewer   dashboard + summary
 */

const crypto = require('crypto');
const mysql = require('mysql2/promise');
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

// A schema the `educon` user may write to. Never educon_prod — guarded below.
const AUTH_DB_NAME = process.env.AUTH_DB_NAME || 'educon_test_1';

const USERS_TABLE = 'dashboard_users';
const LOG_TABLE = 'dashboard_login_log';
const SETTINGS_TABLE = 'dashboard_settings';

const SESSION_COOKIE = 'educon_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;   // 8 hours

/**
 * The decoy hash `verify()` compares against when the username does not exist, so a
 * missing account and a wrong password take the same time.
 *
 * It MUST be a real bcrypt hash. bcryptjs starts with `if (hash.length !== 60) return
 * false` and does no key stretching at all for anything else, so a hand-written
 * placeholder returns in ~0ms while a real account costs ~62ms — a bimodal split that
 * makes the login endpoint a reliable username oracle. The previous literal here was 65
 * characters, so the defence this constant exists for was never actually running.
 *
 * Generated at load rather than hard-coded: a real hash cannot be mistyped, and the
 * assertion below refuses to start if bcrypt ever returns something bcrypt won't accept.
 */
const DECOY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);
if (DECOY_HASH.length !== 60) {
  throw new Error(`decoy hash is ${DECOY_HASH.length} chars, bcrypt requires 60`);
}

let pool = null;
let ready = null;
let sessionSecret = null;

/** The account pool. Separate from server.js's educon_prod pool, on its own schema. */
function getPool() {
  if (pool) return pool;

  if (AUTH_DB_NAME === (process.env.DB_NAME || 'educon_prod')) {
    throw new Error(
      `AUTH_DB_NAME must not be the production schema (${AUTH_DB_NAME}) — it is written to`
    );
  }

  pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: AUTH_DB_NAME,
    waitForConnections: true,
    connectionLimit: 4,
    queueLimit: 0,
    timezone: 'Z'
  });
  return pool;
}

/**
 * Creates the tables if they are absent and seeds the first administrator.
 * Idempotent, and memoised — every entry point awaits this one promise, so a burst
 * of requests at boot cannot race two seeds against each other.
 */
function open() {
  if (ready) return ready;

  ready = (async () => {
    const p = getPool();

    await p.query(`
      CREATE TABLE IF NOT EXISTS ${USERS_TABLE} (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        username   VARCHAR(100) NOT NULL,
        pass_hash  VARCHAR(255) NOT NULL,
        full_name  VARCHAR(190) NOT NULL,
        role       VARCHAR(20)  NOT NULL,
        active     TINYINT(1)   NOT NULL DEFAULT 1,
        created_at VARCHAR(40)  NOT NULL,
        UNIQUE KEY uq_username (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);
    // utf8mb4_general_ci is case-insensitive, which is what COLLATE NOCASE gave the
    // SQLite table: "Komal" and "komal" are one account, and the unique key enforces it.

    await p.query(`
      CREATE TABLE IF NOT EXISTS ${LOG_TABLE} (
        id       INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(100) NOT NULL,
        at       VARCHAR(40)  NOT NULL,
        ip       VARCHAR(64)  NULL,
        ok       TINYINT(1)   NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS ${SETTINGS_TABLE} (
        k VARCHAR(64)   NOT NULL PRIMARY KEY,
        v VARCHAR(255)  NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await loadSessionSecret(p);
    await seedFirstAdmin(p);
  })();

  // A failed init must not poison the process forever — the next request retries.
  ready.catch(() => { ready = null; });
  return ready;
}

/**
 * The HMAC key for session cookies. SESSION_SECRET wins when set; otherwise one is
 * generated once and kept in the settings table, so a restart does not sign everyone
 * out (which is what the old data/.session-secret file did until Render deleted it).
 */
async function loadSessionSecret(p) {
  if (process.env.SESSION_SECRET) {
    sessionSecret = process.env.SESSION_SECRET;
    return;
  }

  const [rows] = await p.query(`SELECT v FROM ${SETTINGS_TABLE} WHERE k = 'session_secret'`);
  if (rows.length) {
    sessionSecret = rows[0].v;
    return;
  }

  const generated = crypto.randomBytes(32).toString('hex');
  // INSERT IGNORE, then re-read: two instances booting together must agree on one key.
  await p.query(`INSERT IGNORE INTO ${SETTINGS_TABLE} (k, v) VALUES ('session_secret', ?)`,
                [generated]);
  const [again] = await p.query(`SELECT v FROM ${SETTINGS_TABLE} WHERE k = 'session_secret'`);
  sessionSecret = again[0].v;
}

/**
 * A brand-new install has no accounts and would be unreachable, so the first run
 * creates one admin. The password comes from ADMIN_PASSWORD when set; otherwise a
 * random one is generated and printed once, which is safer than a known default.
 *
 * It runs **only when the table is empty**. Now that accounts persist, re-seeding on
 * every boot would be wrong: it would quietly resurrect a deleted administrator, and
 * reset a password the team had since changed through the Users page.
 *
 * ADMIN_PASSWORD_RESET=true is the recovery hatch for a forgotten password — it
 * resets ADMIN_USERNAME's password to ADMIN_PASSWORD (and re-enables the account) on
 * the next boot. Unset it again afterwards.
 */
async function seedFirstAdmin(p) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const [[{ n }]] = await p.query(`SELECT COUNT(*) AS n FROM ${USERS_TABLE}`);

  if (n > 0) {
    if (String(process.env.ADMIN_PASSWORD_RESET || '').toLowerCase() === 'true'
        && process.env.ADMIN_PASSWORD) {
      const [r] = await p.query(
        `UPDATE ${USERS_TABLE} SET pass_hash = ?, role = 'admin', active = 1 WHERE username = ?`,
        [bcrypt.hashSync(String(process.env.ADMIN_PASSWORD), 10), username]
      );
      console.log(r.affectedRows
        ? `\n  ADMIN_PASSWORD_RESET — reset the password for "${username}". Unset the variable now.\n`
        : `\n  ADMIN_PASSWORD_RESET set, but no account named "${username}" exists.\n`);
    }
    return;
  }

  const generated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');

  await insertUser(p, {
    username, password, fullName: 'Dashboard Administrator', role: 'admin'
  });

  console.log('\n  No dashboard accounts existed — created the first administrator:');
  console.log(`    username: ${username}`);
  console.log(`    password: ${generated ? `${password}   (generated — save it now)` : '(from ADMIN_PASSWORD)'}`);
  console.log(`    stored in: ${AUTH_DB_NAME}.${USERS_TABLE} (persistent)\n`);
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

async function listUsers() {
  await open();
  const [rows] = await getPool().query(
    `SELECT * FROM ${USERS_TABLE} ORDER BY role, username`
  );
  return rows.map(rowToUser);
}

/** The insert itself, shared by createUser and the first-run seed. */
async function insertUser(p, { username, password, fullName, role }) {
  username = String(username || '').trim();
  if (!username) throw new Error('Username is required');
  if (!password || String(password).length < 3) {
    throw new Error('Password must be at least 3 characters');
  }
  if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}`);

  try {
    await p.query(
      `INSERT INTO ${USERS_TABLE} (username, pass_hash, full_name, role, active, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
      [username, bcrypt.hashSync(String(password), 10),
       String(fullName || username).trim(), role, new Date().toISOString()]
    );
  } catch (error) {
    // The unique key is the authority on collisions, not a prior SELECT — two admins
    // adding the same colleague at once would both pass that check.
    if (error.code === 'ER_DUP_ENTRY') throw new Error(`Username "${username}" is already taken`);
    throw error;
  }

  const [rows] = await p.query(`SELECT * FROM ${USERS_TABLE} WHERE username = ?`, [username]);
  return rowToUser(rows[0]);
}

async function createUser(input) {
  await open();
  return insertUser(getPool(), input || {});
}

async function updateUser(id, { fullName, role, active, password } = {}) {
  await open();
  const p = getPool();

  const [rows] = await p.query(`SELECT * FROM ${USERS_TABLE} WHERE id = ?`, [id]);
  const row = rows[0];
  if (!row) throw new Error('No such user');

  if (role !== undefined && !ROLES.includes(role)) {
    throw new Error(`Role must be one of: ${ROLES.join(', ')}`);
  }
  if (password !== undefined && String(password).length < 3) {
    throw new Error('Password must be at least 3 characters');
  }

  // Locking out the last admin would make the dashboard unadministrable.
  const losingAdmin = row.role === 'admin' && ((role && role !== 'admin') || active === false);
  if (losingAdmin) {
    const [[{ n }]] = await p.query(
      `SELECT COUNT(*) AS n FROM ${USERS_TABLE} WHERE role = 'admin' AND active = 1`
    );
    if (n <= 1) throw new Error('This is the last active administrator — promote another first');
  }

  await p.query(
    `UPDATE ${USERS_TABLE} SET full_name = ?, role = ?, active = ?, pass_hash = ? WHERE id = ?`,
    [fullName !== undefined ? String(fullName).trim() : row.full_name,
     role !== undefined ? role : row.role,
     active !== undefined ? (active ? 1 : 0) : row.active,
     password !== undefined ? bcrypt.hashSync(String(password), 10) : row.pass_hash,
     id]
  );

  const [after] = await p.query(`SELECT * FROM ${USERS_TABLE} WHERE id = ?`, [id]);
  return rowToUser(after[0]);
}

async function deleteUser(id) {
  await open();
  const p = getPool();

  const [rows] = await p.query(`SELECT * FROM ${USERS_TABLE} WHERE id = ?`, [id]);
  const row = rows[0];
  if (!row) throw new Error('No such user');

  if (row.role === 'admin') {
    const [[{ n }]] = await p.query(
      `SELECT COUNT(*) AS n FROM ${USERS_TABLE} WHERE role = 'admin' AND active = 1`
    );
    if (n <= 1) throw new Error('This is the last active administrator — promote another first');
  }
  await p.query(`DELETE FROM ${USERS_TABLE} WHERE id = ?`, [id]);
}

// ---------- login ----------

async function verify(username, password, ip) {
  await open();
  const p = getPool();

  const [rows] = await p.query(`SELECT * FROM ${USERS_TABLE} WHERE username = ?`,
                               [String(username || '').trim()]);
  const row = rows[0];

  // Hash even when the user does not exist, so a missing account and a wrong password
  // take the same amount of time and cannot be told apart from outside. DECOY_HASH is a
  // real 60-character bcrypt hash for that reason — see its definition above.
  const hash = row ? row.pass_hash : DECOY_HASH;
  const ok = bcrypt.compareSync(String(password || ''), hash) && !!row && row.active === 1;

  await p.query(`INSERT INTO ${LOG_TABLE} (username, at, ip, ok) VALUES (?, ?, ?, ?)`,
                [String(username || '').slice(0, 100), new Date().toISOString(),
                 ip ? String(ip).slice(0, 64) : null, ok ? 1 : 0]);

  return ok ? rowToUser(row) : null;
}

async function loginHistory(limit = 50) {
  await open();
  const [rows] = await getPool().query(
    `SELECT * FROM ${LOG_TABLE} ORDER BY id DESC LIMIT ?`, [Number(limit) || 50]
  );
  return rows.map(r => ({ username: r.username, at: r.at, ip: r.ip, ok: r.ok === 1 }));
}

// ---------- session cookie ----------
// A signed, self-contained token: no server-side session table to keep in sync, and
// tampering with the payload invalidates the signature. The key is loaded by open().

function sign(data) {
  if (!sessionSecret) throw new Error('Session secret not loaded — call open() first');
  return crypto.createHmac('sha256', sessionSecret).update(data).digest('base64url');
}

function issueToken(user) {
  const body = Buffer.from(JSON.stringify({
    id: user.id, username: user.username, role: user.role,
    exp: Date.now() + SESSION_TTL_MS
  })).toString('base64url');
  return `${body}.${sign(body)}`;
}

async function readToken(token) {
  if (!token || !token.includes('.')) return null;
  await open();

  const [body, mac] = token.split('.');

  const expected = sign(body);
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;

  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!claims.exp || claims.exp < Date.now()) return null;

    // Re-read the account so a deactivated or re-roled user loses access immediately,
    // rather than keeping whatever the token was minted with.
    const [rows] = await getPool().query(`SELECT * FROM ${USERS_TABLE} WHERE id = ?`, [claims.id]);
    const row = rows[0];
    if (!row || row.active !== 1) return null;
    return rowToUser(row);
  } catch {
    return null;
  }
}

// ---------- express middleware ----------

// Sign-in is ON unless a host explicitly opts out, and production cannot opt out at all.
//
// This used to be the other way round: `AUTH_ENABLED` had to read exactly `true` or every
// request arrived as the synthetic administrator below. The argument for that default was
// that a host which never receives the .env file (Render does not) would otherwise
// silently bring the login page back. The argument is real but the direction was wrong —
// it chose "no authentication" as the outcome of a missing variable, so `1`, `yes`, `TRUE `
// with a trailing space, or Render's environment simply not being set left the whole
// dataset, finance figures included, open to any unauthenticated caller, with no log line
// and no banner. The only visible symptom was `@guest · admin` in the profile menu.
//
// Three properties now hold, in order of importance:
//
//   1. A missing, empty or misspelled variable means sign-in is REQUIRED. Failing closed
//      is recoverable — someone signs in — where failing open is a silent data exposure.
//   2. Production is never open, whatever the variable says. NODE_ENV=production forces
//      sign-in even against an explicit AUTH_ENABLED=false.
//   3. It cannot crash the app. A deliberate opt-out in production is overridden and
//      logged, not thrown, because a crash-loop on a mis-set variable is its own outage.
//
// Opting out is therefore explicit and local-only: AUTH_ENABLED=false with NODE_ENV unset.
// Nothing below is deleted either way — accounts, bcrypt hashes, sessions and every
// requirePermission check are intact.
const AUTH_OPT_OUT = String(process.env.AUTH_ENABLED ?? 'true').trim().toLowerCase() === 'false';
const IS_PRODUCTION = String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
const AUTH_DISABLED = AUTH_OPT_OUT && !IS_PRODUCTION;

if (AUTH_OPT_OUT && IS_PRODUCTION) {
  console.warn(
    '\n  ⚠  AUTH_ENABLED=false was ignored: NODE_ENV=production always requires sign-in.\n'
  );
}

// The deployed posture is otherwise unobservable — it depends on host environment that is
// not in version control — so state it once at boot where anyone reading the log can see it.
console.log(AUTH_DISABLED
  ? '\n  ⚠  AUTH OPEN — no sign-in required. Every request is served as an administrator.\n'
     + '     Set AUTH_ENABLED=true (or unset it) to require sign-in.\n'
  : `  ✓ auth ENFORCED — sign-in required${IS_PRODUCTION ? ' (production)' : ''}`);

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
async function attachUser(req, _res, next) {
  if (AUTH_DISABLED) {
    req.user = OPEN_ACCESS_USER;
    return next();
  }
  try {
    req.user = await readToken(req.cookies && req.cookies[SESSION_COOKIE]);
  } catch (error) {
    // An unreachable account database is a 401, never a crash: the login screen and
    // its static assets still have to load so the failure is visible.
    console.error(`✗ session lookup — ${error.message}`);
    req.user = null;
  }
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
  ROLES, PERMISSIONS, SESSION_COOKIE, SESSION_TTL_MS, AUTH_DISABLED, AUTH_DB_NAME,
  open, listUsers, createUser, updateUser, deleteUser,
  verify, loginHistory, issueToken, attachUser, requirePermission
};
