/**
 * Every environment variable the code reads must be documented in config/.env.example.
 *
 * The deployment posture is not in version control: AUTH_ENABLED, NODE_ENV and
 * ADMIN_PASSWORD_RESET each change behaviour silently when absent, and .env is
 * gitignored. The example file is the only checked-in record of what a host must set,
 * so it drifting out of date is a deployment hazard, not a documentation nit.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
}

const used = new Set();
for (const file of walk(BACKEND)) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) used.add(m[1]);
}

const example = fs.readFileSync(path.join(ROOT, 'config', '.env.example'), 'utf8');
const documented = new Set([...example.matchAll(/^\s*#?\s*([A-Z0-9_]+)\s*=/gm)].map(m => m[1]));

test('the code reads at least the core database variables', () => {
  for (const k of ['DB_HOST', 'DB_USER', 'DB_PASS', 'DB_NAME']) {
    assert.ok(used.has(k), `expected the code to read ${k}`);
  }
});

test('every process.env variable is documented in config/.env.example', () => {
  const missing = [...used].filter(k => !documented.has(k)).sort();
  assert.deepEqual(
    missing,
    [],
    `undocumented env vars — add them to config/.env.example: ${missing.join(', ')}`
  );
});

test('the example file never carries a real-looking secret value', () => {
  for (const line of example.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || !line.includes('=')) continue;
    const [k, ...rest] = line.split('=');
    const v = rest.join('=').trim();
    const PLACEHOLDER = /^(<|your|change|xxx|\.\.\.|password|secret|placeholder|example|TODO)/i;
    if (/PASS|PASSWORD|SECRET/.test(k) && v && !PLACEHOLDER.test(v)) {
      assert.fail(`config/.env.example appears to contain a real value for ${k.trim()}`);
    }
  }
});
