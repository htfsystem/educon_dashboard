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

const pipeline = require('./services/pipelineService');

const app = express();
const PORT = process.env.PORT || 3007;

app.use(cors());
app.use(express.json());
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

app.get('/api/years', route(async () => {
  yearCache.value = await pipeline.getAcademicYears(pool);
  yearCache.at = Date.now();
  return { years: yearCache.value };
}));

/** The full dashboard payload for one academic year. */
app.get('/api/report', route(async req => {
  const year = await requireYear(req);
  return pipeline.getYearReport(pool, year);
}));

/** Totals per status across every academic year, for the trend chart. */
app.get('/api/trend', route(async () => ({
  trend: await pipeline.getYearTrend(pool)
})));

// Dashboard display columns. Mirrors public/js/dashboard.js COLUMNS — each column
// sums one or more exact DB statuses (see pipelineService.js / CLAUDE.md for the 13
// real values). REACHED_CAREER_POINT, REJECTED and CASE_CLOSED are intentionally
// excluded here and everywhere else on the dashboard.
const EXPORT_COLUMNS = [
  { label: 'Form Not Submitted', statuses: ['CREATED'] },
  { label: 'Change Required', statuses: ['CHANGE_REQUIRED'] },
  { label: 'Scrutiny Pending', statuses: ['SUBMITTED', 'REAPPLICATION_SUBMITTED'] },
  { label: 'Approval Pending', statuses: ['SCRUTINY_DONE'] },
  { label: 'Sanction Pending', statuses: ['FIRST_LEVEL_APPROVED'] },
  { label: 'Budget Pending', statuses: ['BUDGET_PENDING'] },
  { label: 'Disbursement Pending', statuses: ['FINAL_LEVEL_APPROVED'] },
  { label: 'Student Disbursed', statuses: ['STUDENT_DISBURSED'] },
  { label: 'No Requirement This Year', statuses: ['NO_REQUIREMENT_THIS_YEAR'] }
];
const colSum = (col, statusMap) => col.statuses.reduce((n, s) => n + (statusMap[s] || 0), 0);

/** Server-rendered CSV of the matrix, so export works without any client library. */
app.get('/api/export.csv', async (req, res) => {
  try {
    const year = await requireYear(req);
    const report = await pipeline.getYearReport(pool, year);

    const esc = v => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const memberTotal = m => EXPORT_COLUMNS.reduce((n, c) => n + colSum(c, m.statuses), 0);

    // report.assignedStatusTotals is an exact DISTINCT count per status for real-person-
    // assigned students (SQL COUNT(DISTINCT user_id)) — a student mapped to two members
    // is counted once here, not twice like summing the member rows would, and it never
    // includes students held only by the rcp/clo/E300/as pseudo-user buckets.
    const assignedColSum = c => colSum(c, report.assignedStatusTotals);
    const cohort = EXPORT_COLUMNS.reduce((n, c) => n + assignedColSum(c), 0);
    const rec = report.reconciliation;

    const lines = [];
    const line = cells => lines.push(cells.map(esc).join(','));

    // Only what the end user needs at the top: which year, when, and from where.
    // The counting rules and reconciliation stay in the block below the table.
    line(['EduCon — Student Status Summary Sheet']);
    line(['Academic year', year]);
    line(['Generated', new Date().toLocaleString()]);
    line(['Database', `${process.env.DB_NAME} (read-only)`]);
    line([]);

    const header = ['Sl', 'Team', 'Name', 'Code', ...EXPORT_COLUMNS.map(c => c.label), 'Total'];
    line(header);

    // ETM first, then ATM, each block closed by its own subtotal.
    ['ETM', 'ATM'].forEach(team => {
      const group = report.members.filter(m => m.team === team);
      if (!group.length) return;
      group.forEach((m, i) => line([
        i + 1, m.team, m.name, m.loginId,
        ...EXPORT_COLUMNS.map(c => colSum(c, m.statuses)),
        memberTotal(m)
      ]));
      line(['', team, `${team} SUBTOTAL`, '',
        ...EXPORT_COLUMNS.map(c => group.reduce((n, m) => n + colSum(c, m.statuses), 0)),
        group.reduce((n, m) => n + memberTotal(m), 0)]);
    });

    line(['', '', 'DISTINCT TOTAL (each student counted once)', '',
      ...EXPORT_COLUMNS.map(assignedColSum), cohort]);

    line([]);
    line(['Column definitions — exact application_status values']);
    EXPORT_COLUMNS.forEach(c => line([c.label, c.statuses.join(' + ')]));

    line([]);
    line(['Reconciliation']);
    line(['Cohort total (records this year)', rec.cohortTotal]);
    line(['Assigned to a named member', rec.assignedDistinct]);
    line(['Unassigned (system buckets only)', rec.unassigned]);
    line(['Sum of member rows', rec.memberRowSum]);
    line(['Rows reconcile to assigned',
      rec.memberRowSum === rec.assignedDistinct ? 'YES' : 'NO — double counting']);
    line(['Tracked total (9 pipeline columns)', cohort]);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="educon-pipeline-${year}.csv"`);
    res.send('﻿' + lines.join('\r\n'));   // BOM so Excel reads UTF-8
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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