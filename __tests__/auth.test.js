/**
 * The two authentication properties that were silently broken, locked so they cannot
 * regress.
 *
 * Neither needs a database: the posture is decided at module load from the environment,
 * and the decoy-hash property is a fact about bcrypt.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const AUTH_SRC = fs.readFileSync(path.join(ROOT, 'backend', 'services', 'authService.js'), 'utf8');

/**
 * Load authService in a child process with a controlled environment and report whether
 * it decided to require sign-in. AUTH_DISABLED is computed at module load, so the only
 * honest way to test the matrix is a fresh process per case.
 */
function posture(env) {
  const clean = { ...process.env };
  delete clean.AUTH_ENABLED;
  delete clean.NODE_ENV;
  const out = execFileSync(
    process.execPath,
    [
      '-e',
      "process.stdout.write(require('./backend/services/authService.js').AUTH_DISABLED ? 'OPEN' : 'LOCKED')"
    ],
    { cwd: ROOT, env: { ...clean, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
  return out.trim().split(/\s+/).pop();
}

// ---------------------------------------------------------------- AUTH_ENABLED posture

test('a missing AUTH_ENABLED requires sign-in — it must fail CLOSED', () => {
  // This is the whole point. The previous default served every request as a
  // full-permission admin when the variable was absent, which is what an unset Render
  // environment looks like.
  assert.equal(posture({}), 'LOCKED');
});

test('every malformed or truthy-ish value requires sign-in', () => {
  for (const v of [
    'true',
    'TRUE',
    'True',
    'true ',
    ' true',
    '1',
    'yes',
    'on',
    '',
    'garbage',
    'FALSEY'
  ]) {
    assert.equal(
      posture({ AUTH_ENABLED: v }),
      'LOCKED',
      `AUTH_ENABLED=${JSON.stringify(v)} must still require sign-in`
    );
  }
});

test('only an explicit false opts out, and only outside production', () => {
  assert.equal(posture({ AUTH_ENABLED: 'false' }), 'OPEN');
  assert.equal(posture({ AUTH_ENABLED: 'FALSE' }), 'OPEN');
  assert.equal(posture({ AUTH_ENABLED: ' false ' }), 'OPEN');
});

test('production can never be open, whatever AUTH_ENABLED says', () => {
  assert.equal(posture({ NODE_ENV: 'production' }), 'LOCKED');
  assert.equal(posture({ NODE_ENV: 'production', AUTH_ENABLED: 'false' }), 'LOCKED');
  assert.equal(posture({ NODE_ENV: 'PRODUCTION', AUTH_ENABLED: 'false' }), 'LOCKED');
  assert.equal(posture({ NODE_ENV: ' production ', AUTH_ENABLED: 'false' }), 'LOCKED');
});

test('an opt-out in production is overridden, not fatal', () => {
  // A crash-loop on a mis-set variable is its own outage, so the override is logged
  // rather than thrown. If this ever starts throwing, the process below will fail.
  assert.doesNotThrow(() => posture({ NODE_ENV: 'production', AUTH_ENABLED: 'false' }));
});

test('the boot log states the effective posture', () => {
  // The deployed posture depends on host environment that is not in version control,
  // so it has to be observable in the log or it is unknowable.
  assert.match(AUTH_SRC, /auth ENFORCED/, 'the enforced posture must be logged');
  assert.match(AUTH_SRC, /AUTH OPEN/, 'the open posture must be logged');
});

// ---------------------------------------------------------------- the decoy hash

test('bcrypt does no work at all on a hash that is not 60 characters', () => {
  // The fact that made the old placeholder a username oracle: bcryptjs returns early on
  // any hash of the wrong length, so the comparison costs ~0ms instead of ~62ms.
  const tooLong = '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
  assert.equal(tooLong.length, 65, 'this is the literal that used to be in verify()');
  assert.equal(bcrypt.compareSync('anything', tooLong), false);

  const real = bcrypt.hashSync('x', 10);
  assert.equal(real.length, 60, 'a real bcrypt hash is 60 characters');

  const ms = h => {
    const s = process.hrtime.bigint();
    for (let i = 0; i < 5; i++) bcrypt.compareSync('guess', h);
    return Number(process.hrtime.bigint() - s) / 1e6 / 5;
  };
  assert.ok(ms(tooLong) < 5, 'a wrong-length hash should return almost instantly');
  assert.ok(ms(real) > 10, 'a real hash should cost real work');
});

test('verify() compares against a generated hash, never a literal', () => {
  assert.match(
    AUTH_SRC,
    /const DECOY_HASH = bcrypt\.hashSync\(/,
    'the decoy must be generated so it cannot be mistyped'
  );
  assert.match(
    AUTH_SRC,
    /DECOY_HASH\.length !== 60/,
    'startup must assert the decoy is a valid bcrypt hash'
  );
  assert.match(
    AUTH_SRC,
    /row \? row\.pass_hash : DECOY_HASH/,
    'verify() must fall back to DECOY_HASH for an unknown username'
  );
  assert.doesNotMatch(
    AUTH_SRC,
    /'\$2[aby]\$\d\d\$[A-Za-z0-9./]{20,}'/,
    'no hard-coded bcrypt hash literal may remain in this file'
  );
});

test('the startup guard still refuses to write accounts to the production schema', () => {
  assert.match(
    AUTH_SRC,
    /must not be the production schema/,
    'getPool() must throw when AUTH_DB_NAME equals DB_NAME'
  );
});
