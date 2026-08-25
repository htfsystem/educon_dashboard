/**
 * EduCon Student Pipeline Dashboard — API server
 *
 * READ-ONLY. The pool user only ever issues SELECT statements; there is no write
 * path anywhere in this process.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const mysql = require('mysql2/promise');
const cookieParser = require('cookie-parser');

const pipeline = require('./services/pipelineService');
const auth = require('./services/authService');

const app = express();
const PORT = process.env.PORT || 3007;

// Behind Render's load balancer, so req.ip and secure cookies read the real protocol.
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(auth.attachUser);

// Static assets are public; the login page has to load before anyone has a session.
// Every /api route below that carries data is guarded individually.
app.use(express.static(path.join(__dirname, '..', 'frontend')));

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: 'Z'
});

// Academic years are stable within a session; everything else is fetched live.
const yearCache = { value: null, at: 0 };
const YEAR_TTL_MS = 5 * 60 * 1000;

/** Wraps an async route so a rejected promise becomes a 500 instead of a hang. */
const route = handler => async (req, res) => {
  const label = `${req.method} ${req.path}`;
  const started = Date.now();
  try {
    const payload = await handler(req, res);
    console.log(`✓ ${label} ${JSON.stringify(req.query)} — ${Date.now() - started}ms`);
    res.json(payload);
  } catch (error) {
    console.error(`✗ ${label} — ${error.message}`);
    res.status(500).json({ error: error.message });
  }
};

/** Rejects a year that is not actually present in the database. */
async function requireYear(req) {
  const year = req.query.year;
  if (!year) throw new Error('Query parameter "year" is required');

  if (!yearCache.value || Date.now() - yearCache.at > YEAR_TTL_MS) {
    yearCache.value = await pipeline.getAcademicYears(pool);
    yearCache.at = Date.now();
  }
  if (!yearCache.value.some(y => y.year === year)) {
    throw new Error(`Unknown academic year "${year}"`);
  }
  return year;
}

// ---------------------------------------------------------------- authentication
// Dashboard accounts live in a local SQLite file. educon_prod holds no dashboard
// credentials and is still only ever read from.

auth.open();

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = auth.verify(username, password, req.ip);

  if (!user) {
    console.log(`✗ login failed — ${username}`);
    return res.status(401).json({ error: 'Incorrect username or password' });
  }

  res.cookie(auth.SESSION_COOKIE, auth.issueToken(user), {
    httpOnly: true,
    sameSite: 'lax',
    // Render terminates TLS ahead of the app, so trust the proxy's protocol header.
    secure: process.env.NODE_ENV === 'production',
    maxAge: auth.SESSION_TTL_MS
  });
  console.log(`✓ login — ${user.username} (${user.role})`);
  res.json({ user });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(auth.SESSION_COOKIE);
  res.json({ ok: true });
});

/** Who am I? The frontend calls this on load to decide login vs dashboard. */
app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: req.user });
});

// ---------------------------------------------------------------- user management

app.get('/api/users', auth.requirePermission('manage:users'),
  route(async () => ({ users: auth.listUsers(), roles: auth.ROLES })));

app.post('/api/users', auth.requirePermission('manage:users'), (req, res) => {
  try {
    res.json({ user: auth.createUser(req.body || {}) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch('/api/users/:id', auth.requirePermission('manage:users'), (req, res) => {
  try {
    res.json({ user: auth.updateUser(Number(req.params.id), req.body || {}) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/users/:id', auth.requirePermission('manage:users'), (req, res) => {
  try {
    auth.deleteUser(Number(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/login-history', auth.requirePermission('manage:users'),
  route(async () => ({ history: auth.loginHistory(50) })));

// ---------------------------------------------------------------- pipeline data

app.get('/api/health', route(async () => {
  const [[row]] = await pool.query('SELECT 1 AS ok');
  return {
    status: row.ok === 1 ? 'healthy' : 'degraded',
    database: process.env.DB_NAME,
    host: process.env.DB_HOST,
    access: 'read-only',
    checkedAt: new Date().toISOString()
  };
}));

app.get('/api/years', auth.requirePermission('view:dashboard'), route(async () => {
  yearCache.value = await pipeline.getAcademicYears(pool);
  yearCache.at = Date.now();
  return { years: yearCache.value };
}));

/** The full dashboard payload for one academic year. */
app.get('/api/report', auth.requirePermission('view:summary'), route(async req => {
  const year = await requireYear(req);
  return pipeline.getYearReport(pool, year);
}));

/** Totals per status across every academic year, for the trend chart. */
app.get('/api/trend', auth.requirePermission('view:dashboard'), route(async () => ({
  trend: await pipeline.getYearTrend(pool)
})));

/**
 * Page 1 — the executive overview. Derived from the same getYearReport() payload the
 * summary page uses, so the two pages can never disagree about a number.
 */
app.get('/api/overview', auth.requirePermission('view:dashboard'), route(async req => {
  const year = await requireYear(req);
  const report = await pipeline.getYearReport(pool, year);
  const s = report.statusTotals;
  const at = k => s[k] || 0;

  // Named stages for the headline tiles. Every figure is still a sum of exact
  // statuses — nothing is normalised or renamed (see CLAUDE.md).
  const disbursed = at('STUDENT_DISBURSED');
  const active = at('CREATED') + at('SUBMITTED') + at('REAPPLICATION_SUBMITTED')
    + at('SCRUTINY_DONE') + at('FIRST_LEVEL_APPROVED') + at('FINAL_LEVEL_APPROVED')
    + at('BUDGET_PENDING');
  const attention = at('CHANGE_REQUIRED') + at('REJECTED');
  const dormant = at('NO_REQUIREMENT_THIS_YEAR') + at('REACHED_CAREER_POINT') + at('CASE_CLOSED');

  return {
    academicYear: year,
    cohortTotal: report.reconciliation.cohortTotal,
    headline: { disbursed, active, attention, dormant },
    // The hero quotes the same figures as the Status Summary matrix, so it sums the
    // same per-status map the matrix's Grand Total row does: an exact DISTINCT count
    // per status, pseudo-user-free and never double-counted. Which statuses actually
    // count is decided client-side in js/columns.js — the one place that list lives.
    assignedStatusTotals: report.assignedStatusTotals,
    reconciliation: report.reconciliation
  };
}));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`\n  EduCon Pipeline Dashboard`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  DB ${process.env.DB_USER}@${process.env.DB_HOST}/${process.env.DB_NAME} (read-only)\n`);
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use.`);
    console.error(`The dashboard may already be running at http://localhost:${PORT}`);
    console.error('Close the existing dashboard process before running npm start again.\n');
    process.exit(1);
  }
  throw error;
});