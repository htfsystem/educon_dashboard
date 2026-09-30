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

### Security — fixed

Two authentication defences that were silently not working. Both are behaviour changes;
both are locked by `__tests__/auth.test.js` (9 tests).

- **`AUTH_ENABLED` now fails CLOSED, and production can never be open.** It previously had
  to read exactly `true` or every request was served as a full-permission synthetic admin,
  so an unset Render environment, `1`, `yes`, or `true ` with a trailing space exposed the
  entire dataset — finance figures included — to any unauthenticated caller, with nothing
  in the log and only `@guest · admin` in the profile menu as a symptom.

  Now: a missing, empty or malformed value **requires** sign-in; only an explicit
  `AUTH_ENABLED=false` opts out; and `NODE_ENV=production` overrides even that. The
  override is logged rather than thrown, because a crash-loop on a mis-set variable is its
  own outage. The effective posture is printed at boot (`✓ auth ENFORCED` /
  `⚠ AUTH OPEN`), since it depends on host environment that is not in version control and
  was otherwise unknowable.

  Verified across 11 environment combinations: every one requires sign-in except an
  explicit `false` outside production.

- **The anti-enumeration decoy hash was 65 characters; bcrypt requires 60.** `bcryptjs`
  begins `if (hash.length !== 60) return false` and does no key stretching, so an unknown
  username answered in ~0ms and a real one in ~62ms — a bimodal split that made
  `POST /api/auth/login` a reliable username oracle, and the comment describing the
  defence had never been true. `DECOY_HASH` is now generated at load with an assertion
  that it is 60 characters.

  Measured on this machine: the gap between an unknown username and a real one went from
  **62.08ms to 0.66ms**.

### Fixed

- **3 moderate dependency vulnerabilities** (`qs` array-limit bypass and DoS, reached via
  `express` → `body-parser`). Resolved by a patch-level bump; `npm audit --omit=dev` now
  reports 0.
- **`NODE_ENV` was undocumented** in `config/.env.example` although it controls the session
  cookie's `Secure` flag. Added, with a note on what its absence costs. Found by
  `env.test.js` on its first run.
- **`frontend/js/util.js` and `frontend/js/ui.js` are now tracked by git.** Both existed on
  disk but were never committed, while `index.html` loads `util.js` as its first script and
  three modules destructure `window.EduConUtil` on their first line. `git commit -am` stages
  only tracked files, so the most common commit command would have pushed the new
  `index.html` without them and served a blank page. `assets.test.js` now catches it.
- **`CLAUDE.md` and `EduCon-Code-Labels_01.xlsx` are now under version control.** Both sat
  above the git root (`Dashboard/`), so the document holding every data invariant had no
  history and no backup. A thin `@Dashboard/CLAUDE.md` pointer remains at the workspace root
  so it still loads automatically.

### Known — found, not yet fixed

Recorded so they are tracked rather than rediscovered. None is touched by this entry.

- **`columns.js` defines 8 columns, CLAUDE.md documents 7** and lists
  `REACHED_CAREER_POINT` as an excluded status while the code reports it as a column
  (`RCP`). The Grand Total on screen and in the export includes it. Found by
  `contract.test.js` on its first run. **Decide which is right before the next report goes
  out** — the code and the documentation currently describe different totals.
- **`DISTINCT_PAYMENTS` de-duplicates on 5 columns, its comment states a 3-column key.**
  A voucher re-saved with a corrected amount or date is summed twice.
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
