# EduCon Student Pipeline Dashboard

A **read-only** BI dashboard over the EduCon education-consultancy CRM. It reports where
every student sits in the approval / disbursement pipeline, broken down by the ETM/ATM who
handles them.

`educon_prod` is **never written to**. Every query against it is a `SELECT`.

> **Architecture, data model and decision history live in [CLAUDE.md](CLAUDE.md).**
> Read that before changing a query. This file is only how to run, test and deploy.

---

## Requirements

- **Node 22+** (`.nvmrc` pins 22.5.0; enforced by `engines` in package.json)
- Network access to the MySQL host named in `.env`

No build step, no framework, no CDN. Charts are hand-written SVG and the Excel export is
generated client-side.

## Running it

```bash
cd Dashboard
cp config/.env.example .env     # then fill in the real values
npm install                     # first run only
npm start                       # http://localhost:3007
```

`PORT=3007` is the default in `backend/server.js`. Override it in `.env` or inline:

```bash
PORT=3000 npm start
```

On the very first start the console prints the administrator username and password
**once**. Sign in with those, then go to **Users** and create real accounts.

Windows shortcut: `scripts/start-dashboard-and-open.bat` (accepts a port).

## Environment

Copy `config/.env.example` and fill it in. Every variable the code reads is documented
there — `__tests__/env.test.js` fails the build if one is missing from the example file.

| Variable                                          | Notes                                                                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `DB_HOST` `DB_PORT` `DB_USER` `DB_PASS` `DB_NAME` | the read-only reporting connection                                                                              |
| `PORT`                                            | default `3007`                                                                                                  |
| `AUTH_ENABLED`                                    | **must be exactly `true`** to require sign-in. Any other value serves every request as a full-access admin      |
| `AUTH_DB_NAME`                                    | schema the dashboard's own accounts live in. Must **not** equal `DB_NAME` — the app refuses to start if it does |
| `ADMIN_USERNAME` `ADMIN_PASSWORD`                 | seeds the first administrator, first run only                                                                   |
| `ADMIN_PASSWORD_RESET`                            | recovery hatch. Resets the admin password on the next boot. **Unset it afterwards** — it is not self-disarming  |
| `SESSION_SECRET`                                  | optional. Unset, a key is generated once and kept in `AUTH_DB_NAME.dashboard_settings`                          |
| `NODE_ENV`                                        | `production` sets the session cookie's `Secure` flag                                                            |

`.env` is gitignored and must never be committed.

## Development commands

```bash
npm run dev            # start with --watch
npm test               # the full suite (no database needed)
npm run test:watch     # re-run on change
npm run lint           # eslint — bug-focused rules, no style rules
npm run format:check   # prettier, check only
npm run format         # prettier, write
npm run audit:prod     # dependency vulnerabilities, production deps only
npm run verify         # lint + format:check + test — what CI runs
```

Run `npm run verify` before every commit. It is what `.github/workflows/ci.yml` runs.

## What the tests cover

They need **no database** — everything is asserted against the source. That is deliberate:
the invariants below each cost a production incident to learn, and prose in CLAUDE.md
cannot fail a build.

| File                           | Guards                                                                                                                                                                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `__tests__/assets.test.js`     | every `<script src>` / `<link href>` in `index.html` exists, and the load order that `window.EduConUtil` and `window.PIPELINE_COLUMNS` depend on                                                                                                                  |
| `__tests__/contract.test.js`   | the reported column set, that every column status is a real DB status, that no status is double-claimed, and that the excluded statuses stay excluded                                                                                                             |
| `__tests__/invariants.test.js` | `MAX(amount_sanctioned)` never `SUM`; disbursements summed only over the de-duplicated voucher set; cancelled vouchers excluded; no `LEFT JOIN` on academic details (the 100%-inflation counting bug); pseudo-users bound not interpolated; the 13 exact statuses |
| `__tests__/env.test.js`        | every `process.env` variable is documented in `config/.env.example`, and that file carries no real secret                                                                                                                                                         |

`assets.test.js` exists because `frontend/js/util.js` and `frontend/js/ui.js` were once
untracked by git while `index.html` loaded them — a deploy would have served a blank page.

### Known gap, recorded not hidden

`invariants.test.js` documents that `DISTINCT_PAYMENTS` de-duplicates on **five** columns
while its own comment states a **three**-column natural key. A voucher re-saved with a
corrected amount or date therefore survives twice and is summed twice. The test asserts
only what is true today and names the gap; see the comment in that file for the fix.

## Deploying (Render)

Auto-deploys on push to `main`.

```bash
npm run verify      # do not push red
git add -A          # untracked files are how the blank-page outage happened
git commit -m "..."
git push
```

Set in the Render dashboard — `.env` is not committed, so a variable set locally and not
on the host is a silent difference:

```
DB_HOST DB_PORT DB_USER DB_PASS DB_NAME
NODE_ENV=production
AUTH_ENABLED=true
AUTH_DB_NAME=...
ADMIN_USERNAME ADMIN_PASSWORD
```

**`AUTH_ENABLED` must read exactly `true`.** A trailing space, `TRUE `, `1` or `yes`
leaves the deployment unauthenticated with finance figures exposed, and the only visible
symptom is `@guest · admin` in the profile menu.

Dashboard accounts persist: they live in MySQL (`AUTH_DB_NAME`), not on the filesystem,
so a restart or redeploy does not destroy them.

## Troubleshooting

| Symptom                                     | Cause                                                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `EADDRINUSE`                                | another process holds the port — pass a different one                                                                      |
| Blank page after deploy                     | a `<script src>` 404ing. `npm test` catches this                                                                           |
| `@guest · admin` in the menu                | `AUTH_ENABLED` is not exactly `true` on that host                                                                          |
| A colleague cannot sign in although you can | check the boot log for `✓ account store ready — <schema>.dashboard_users` and confirm `AUTH_DB_NAME` matches on every host |
| Numbers look wrong                          | check `/api/health`, then re-read the Money and counting-bug sections of CLAUDE.md                                         |
| A member shows 0                            | they may genuinely have no students with a record that year                                                                |
| Locked out                                  | set `ADMIN_PASSWORD_RESET=true` with `ADMIN_USERNAME`/`ADMIN_PASSWORD` and restart, then **unset it**                      |

## Layout

```
Dashboard/
├── backend/
│   ├── server.js                 Express app, read-only pool, all routes
│   └── services/
│       ├── pipelineService.js    every educon_prod query — single source of truth
│       ├── codeLabels.js         every code → label (generated from the labels workbook)
│       └── authService.js        local accounts, roles, sessions. Never touches educon_prod
├── frontend/
│   ├── index.html                login screen, app shell, all three pages
│   ├── css/                      dashboard.css (tokens, light + dark), app.css (shell)
│   └── js/                       util · columns · ui · filters · xlsx · students · dashboard · app
│                                 (this is the <script> order — it is load-bearing)
├── __tests__/                    assets · contract · invariants · env
├── config/.env.example           environment template
└── scripts/                      local launcher
```
