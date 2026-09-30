/**
 * Every asset index.html references must exist on disk.
 *
 * This is the test that would have caught frontend/js/util.js and frontend/js/ui.js
 * being untracked by git: index.html loads util.js as its FIRST script and three
 * modules destructure window.EduConUtil on their first line, so a missing file is not
 * a degraded page, it is a blank one.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND = path.join(__dirname, '..', 'frontend');
const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');

test('every <script src> exists', () => {
  const srcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
  assert.ok(srcs.length > 0, 'no script tags found — did index.html change shape?');
  for (const src of srcs) {
    assert.ok(fs.existsSync(path.join(FRONTEND, src)), `missing script: ${src}`);
  }
});

test('every <link href> stylesheet exists', () => {
  const hrefs = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map(m => m[1]);
  assert.ok(hrefs.length > 0, 'no stylesheet links found');
  for (const href of hrefs) {
    assert.ok(fs.existsSync(path.join(FRONTEND, href)), `missing stylesheet: ${href}`);
  }
});

test('util.js loads before any module that destructures EduConUtil', () => {
  const order = [...html.matchAll(/<script\s+src="js\/([^"]+)\.js"/g)].map(m => m[1]);
  const utilAt = order.indexOf('util');
  assert.notEqual(utilAt, -1, 'util.js is not loaded at all');
  for (const name of ['app', 'dashboard', 'students']) {
    const at = order.indexOf(name);
    if (at !== -1) assert.ok(utilAt < at, `util.js must load before ${name}.js`);
  }
});

test('columns.js loads before dashboard.js', () => {
  const order = [...html.matchAll(/<script\s+src="js\/([^"]+)\.js"/g)].map(m => m[1]);
  const c = order.indexOf('columns');
  const d = order.indexOf('dashboard');
  assert.notEqual(c, -1, 'columns.js is not loaded');
  if (d !== -1) assert.ok(c < d, 'columns.js must load before dashboard.js');
});
