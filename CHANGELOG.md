# Changelog

All notable changes to this project.

CLAUDE.md's "Last verified" section holds the _reasoning_ behind each change — what was
checked, what was rejected and why. This file holds only _what changed_, so a reader can
see the shape of a release without reading 98KB of prose. Keep entries short and link to
the CLAUDE.md entry for the argument.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added — code health baseline

No application logic was changed in this entry. Every file below is new tooling,
configuration or documentation.

- **Test suite** (`__tests__/`, `npm test`) — 24 tests, no database required.
  - `assets.test.js` — every `<script src>` and `<link href>` in `index.html` resolves on
    disk, and `util.js` / `columns.js` load before the modules that read their globals.
  - `contract.test.js` — the reported column set is locked; every column status is a real
    DB status; no status is claimed twice; the excluded statuses stay excluded.
  - `invariants.test.js` — `MAX(amount_sanctioned)` never `SUM`; disbursements summed only
    over the de-duplicated voucher set; cancelled vouchers excluded; no `LEFT JOIN` on
    academic details; pseudo-users bound not interpolated; the 13 exact statuses and the
    4 pseudo-user accounts unchanged.
  - `env.test.js` — every `process.env` variable is documented in `config/.env.example`
    and that file carries no real secret.
- **ESLint** (`eslint.config.js`, `npm run lint`) — deliberately bug-focused, not
  style-focused. Baseline: **0 errors, 10 warnings.** The warnings are signal, not noise:
  three `require-atomic-updates` races (`yearCache.at`, `req.user`, `state.overview`), four
  over-long functions (`renderMatrix` 96, `exportExcel` 96, `exportList` 90) and two
  complexity hotspots (`buildRow` 20, `updateUser` 17).
- **Prettier** (`.prettierrc.json`, `.prettierignore`) — wired as `format:check` only;
  nothing was reformatted, so the diff stays reviewable.
- **CI** (`.github/workflows/ci.yml`) — runs `npm run verify` (lint + format check + tests)
  on every push and pull request.
- **`README.md`** — how to run, test and deploy, and the `AUTH_ENABLED` warning.
- **`.editorconfig`**, **`.gitattributes`**, **`.nvmrc`** — whitespace, line endings
  (three frontend files are CRLF today) and the Node version, so a Windows checkout and
  the Linux host agree.
- **`npm run verify`** — the single command to run before committing.

### Fixed

- **3 moderate dependency vulnerabilities** (`qs` array-limit bypass and DoS, reached via
  `express` → `body-parser`). Resolved by a patch-level bump; `npm audit --omit=dev` now
  reports 0.
- **`NODE_ENV` was undocumented** in `config/.env.example` although it controls the session
  cookie's `Secure` flag. Added, with a note on what its absence costs. Found by
  `env.test.js` on its first run.

### Known — found, not yet fixed

Recorded so they are tracked rather than rediscovered. None is touched by this entry.

- `frontend/js/util.js` and `frontend/js/ui.js` are **untracked by git** while
  `index.html` loads `util.js` as its first script and three modules destructure
  `window.EduConUtil` on their first line. A `git commit -am` would push the modified
  `index.html` without them and serve a blank page. `assets.test.js` now catches it.
- **`CLAUDE.md` is outside the git root** (`Dashboard/`), so the document holding every
  data invariant has no history and no backup.
- **`columns.js` defines 8 columns, CLAUDE.md documents 7** and lists
  `REACHED_CAREER_POINT` as an excluded status while the code reports it as a column
  (`RCP`). The Grand Total on screen and in the export includes it. Found by
  `contract.test.js` on its first run.
- **`DISTINCT_PAYMENTS` de-duplicates on 5 columns, its comment states a 3-column key.**
  A voucher re-saved with a corrected amount or date is summed twice.
- **`AUTH_ENABLED` fails open** — any value that is not exactly `true` serves every request
  as a full-permission admin, with no warning in the log.
- **The anti-enumeration decoy hash is 65 characters**; bcrypt requires 60, so
  `bcryptjs` returns early and the timing defence does not run (0ms vs 62ms).
- **No rate limiting on `/api/auth/login`**, against a 3-character password minimum. Also
  `bcrypt.compareSync` blocks the event loop, so concurrent login attempts stall the app.
- **`viewer` receives every student's community, family status, gender and food
  preference** — only the rupee figures are gated by `view:finance`.
- **A password change does not invalidate an existing session**; the token binds only to
  the numeric user id, and logout only clears the cookie client-side.
- **`getReconciliation` runs two queries per report that no client reads.** CLAUDE.md's
  Reconciliation section also contradicts the code on whether `memberRowSum` must equal
  `assignedDistinct`.
- **`loadYear()` has no in-flight guard**, so a late `/api/report` response can leave the
  matrix on a different year than the selector.
- **No Excel formula-injection guard** — a college name beginning `=` becomes a live
  formula in a circulated workbook.
- **Dead CSS** for removed features (`.segmented`, `.kpi-*`, `.settings-*`) and tokens used
  but never defined (`--kpi-accent`, `--seg`, `--swatch`).

---

## [2.0.0]

The pre-existing release. Its history is not reconstructible from this working copy — only
five commits are reachable and CLAUDE.md, which records the change history in prose, was
never tracked. See CLAUDE.md's "Last verified" section for entries from 2026-08-22
onward.
