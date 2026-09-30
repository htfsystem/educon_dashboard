# EduCon Student Pipeline Dashboard

## Project Overview

**EduCon** is an education consultancy CRM. This project is a **read-only BI dashboard**
over its production database, reporting where every student sits in the approval /
disbursement pipeline, broken down by the ETM/ATM who handles them.

**The database is never written to.** Every query in this codebase is a `SELECT`.

---

## Database

Credentials live in `.env` (never commit it — use `.env.example` as the template).

```
DB_HOST=166.62.26.39   DB_PORT=3306
DB_USER=educon         DB_PASS=educon
DB_NAME=educon_prod    PORT=3000
```

### Tables that matter

| Table | Role |
|---|---|
| `educon_user_academic_details` | `s_id`, `academic_year`, `application_status`, `user_id` — one row per student per year |
| `educon_user_etm_mapping` | `etm_id`, `s_id`, `is_senior`, `etm_role` — who handles which student |
| `educon_user_profile` | `u_id`, `login_id`, `u_fname`, `u_lname` — the people (**both** students and handlers) |
| `educon_student_personal_details` | `s_id`, `sp_fname`, `sp_lname` — student names, 374 rows (a fallback only); also gender / community / food / family status |
| `educon_student_current_education_details` | `s_id` (**the case**), `sce_education`, `sce_branch`, `sce_course_name`, `sce_board`, `sce_name`, `sce_year`, `sce_college_place` — what the student is studying, that year |
| `educon_student_current_address_details` | `s_id` (**the student**), `spa_*` permanent address, `sa_*` current address |
| `educon_student_first_level_approval` | `s_id` (**the case**), `approval_id` — who gave first-level approval. 750 rows, one per case |
| `educon_student_final_approval_and_sanction` | `s_id`, `academic_year`, `amount_sanctioned` — the sanction; also `first_approval_authority_id`, `sanctioning_authority_id` |
| `educon_payment_transaction_details` | `s_id`, `pt_academic_year`, `pt_amount_disbursed`, `pt_cancel_tag` — the payments |

### The two ID columns — the easiest mistake in this schema

`educon_user_academic_details` carries **two different identities** and picking the wrong
one still returns rows, just far fewer. Verified 2026-08-27:

| Column | Is | Joins to |
|---|---|---|
| `user_id` | the **student** (the person) | `educon_user_etm_mapping.s_id` · `educon_user_profile.u_id` · `educon_student_personal_details.s_id` · `educon_payment_transaction_details.s_id` |
| `s_id` | the **case** (one student, one year) | `educon_student_final_approval_and_sanction.s_id` (+ `academic_year`) |

Row counts if you swap them: the mapping join gives 1361 vs 101, the personal-details
join 1234 vs 75, the payments join 1070 vs 26, the sanction join 728 vs 23. A "working
but suspiciously small" join is the symptom.

The student-detail tables split the same way. Verified 2026-08-28 by joining each one
both ways and counting; every one of them is **one row per key**, so none fans out a
join:

| Table | Rows / keys | Joins on `user_id` | Joins on case `s_id` | Keyed by |
|---|---|---|---|---|
| `educon_student_personal_details` | 374 / 374 | **1234** | 75 | student |
| `educon_student_current_address_details` | 378 / 378 | **1248** | 77 | student |
| `educon_student_communication_details` | 379 / 379 | **1251** | 77 | student |
| `educon_student_current_education_details` | 940 / 940 | 198 | **939** | case |
| `educon_student_family_details` | 2888 / 948 | 620 | **2885** | case |
| `educon_student_previous_education_details` | 2118 / 936 | 390 | **2117** | case |

The split is meaningful, not incidental: who a student *is* (gender, community, food,
family, home address) is one row for life, while what they *study* changes every year
and so is keyed by the case. That is why the academic card follows the year selector
and the personal fields do not.

`educon_user_profile` holds students *and* handlers — 461 of the 462 rows are students
(`login_id` like `e617`, `E747`), and it is the only source of a readable student code.
It covers more students than `educon_student_personal_details` does, so names come from
the profile first and personal details only fill the gaps.

### Money — sanctioned, disbursed, pending

- **Sanctioned** — `MAX(amount_sanctioned)` for the case-year, **never `SUM`**. 14
  `(s_id, academic_year)` groups carry more than one sanction row and in *every one of
  them the amounts are identical* — they are re-saves of one decision, so summing books
  a ₹50,000 sanction as ₹150,000.
- **Disbursed** — sum over **`DISTINCT_PAYMENTS`**, never over the raw payments table.
  It carries the *same* duplicate trap the sanction table does: 31 groups (32 extra
  rows) where one voucher was saved twice — identical student, year, voucher number,
  voucher date, amount, bank transaction id and cheque number, differing only in
  `pt_id`. **`pt_id` is unique, so it is no protection.** A plain `SUM` booked ₹100,000
  paid to student 22292 as ₹200,000 and inflated 2025-2026 by ₹463,019 (₹1.02M across
  all years). De-duplicate on (student, year, voucher number); verified safe — no group
  shares that key with a differing amount or purpose, and no voucher number is NULL or 0.
  Cancelled vouchers (`pt_cancel_tag = 'Y'`) are excluded.
  `pt_sanction_id` is NULL on 1065 of 1072 rows, so payments tie to a sanction by
  (student, year) and by nothing else.
- **Pending** — `sanctioned - disbursed`, left **signed**. Even after de-duplication, 44
  of 208 cases in 2025-2026 are paid more than the year's sanction row records — but 12
  of those simply have **no sanction row at all** (so `sanctioned` reads 0), leaving 32
  genuinely over the sanction. Only 128 of 208 cases have a sanction row, so a ₹0
  sanction usually means "not recorded", not "nothing sanctioned". The UI relabels a
  negative as "Disbursed beyond sanction" rather than clamping to zero.
- `educon_actual_disbursement` and `educon_student_disbursement_details` are **empty
  tables** — do not build on them. `educon_student_sanction_details` has 9 rows and is
  likewise not the sanction source.

### Verified facts about the data

These were confirmed directly against `educon_prod`. Do not re-derive them from
assumptions.

- **`application_status` is `NOT NULL`.** Any code handling a NULL status is dead code.
- **7 academic years exist**: `2020-2021` … `2026-2027`.
- **One row per (user_id, academic_year)** — zero duplicates, so `COUNT(DISTINCT user_id)`
  and `COUNT(*)` agree per year. `DISTINCT` is still used defensively.
- **461 students are mapped to a handler, but only ~205 have a record in any given year.**
  This is the single biggest trap in this codebase — see "The counting bug" below.
- **205 of 461 students are mapped to two handlers**, 256 to one.

### The 13 exact statuses

Fetch and display these **exactly**. Never normalize, merge, or rename them.

`CREATED`, `CHANGE_REQUIRED`, `SUBMITTED`, `REAPPLICATION_SUBMITTED`, `SCRUTINY_DONE`,
`FIRST_LEVEL_APPROVED`, `FINAL_LEVEL_APPROVED`, `BUDGET_PENDING`, `STUDENT_DISBURSED`,
`NO_REQUIREMENT_THIS_YEAR`, `REACHED_CAREER_POINT`, `REJECTED`, `CASE_CLOSED`

`SCRUTINY_DONE` is real and was missing from earlier versions of this document.

### The 7 reported columns

The dashboard reports **7 columns**, defined once in `frontend/js/columns.js` as
`window.PIPELINE_COLUMNS`. **Change them there and nowhere else** — page 1's hero, page
2's matrix and the Excel export all sum that same array, which is what stops the two
pages disagreeing. Two business decisions shape them, both made on 2026-08-25:

| Column | Exact statuses summed |
|---|---|
| Form Not Submitted | `CREATED` + `CHANGE_REQUIRED` |
| Scrutiny Pending | `SUBMITTED` + `REAPPLICATION_SUBMITTED` |
| Approval Pending | `SCRUTINY_DONE` |
| Sanction Pending | `FIRST_LEVEL_APPROVED` |
| Disbursement Pending | `FINAL_LEVEL_APPROVED` |
| Student Disbursed | `STUDENT_DISBURSED` |
| No Requirement This Year | `NO_REQUIREMENT_THIS_YEAR` |

- **`CHANGE_REQUIRED` is merged into Form Not Submitted.** A form sent back for changes
  is not yet submitted, so the business wants one number. There is no separate column.
- **`BUDGET_PENDING` is not reported at all** — no column, no chart slice, and it does
  **not** count toward any member total or the Grand Total. It joins
  `REACHED_CAREER_POINT`, `REJECTED` and `CASE_CLOSED` as an excluded status.

Consequence: the reported Grand Total is **less than `cohortTotal`** by the number of
excluded-status students. The old invariant "all status counts sum to `cohortTotal`"
no longer holds for the displayed columns, and that is intended.

### Coded fields — `codeLabels.js` is the only place a code becomes a word

Several of the student's own answers are stored as opaque codes and **there is no lookup
table for them anywhere on the server**. Checked 2026-08-28 across all four schemas the
`educon` user can see (`educon_prod`, `educon_test_1`, `educon_testdb_27sep25`,
`test_db_ks`): nothing maps `EDU_*`, `FOE_*`, `SPE_*` or `UNI_*`, and nothing maps the
numeric gender / minority / food / family-status codes. Those labels live in the EduCon
**application's** resource file.

They therefore live in `backend/services/codeLabels.js`, in one file, so the real lists
can be pasted in when they arrive. `label()` falls back to **the raw code, never to a
guess** — a reader must be able to tell "the student did not answer" (an em dash) from
"nobody has told the dashboard what this code means" (`SPE_186`).

**The four education lists arrived on 2026-09-01**, as `EduCon-Code-Labels_01.xlsx` in the
repository root — one sheet each for Education, Field of education, Specialization and
Board or University, taken from the application's own dropdowns. They were transcribed
into `codeLabels.js` **by script, not by hand**, and they cover every code present in
`educon_prod`: nothing in the live data falls through to a raw code any more. Re-export
that workbook and re-run the transcription if EduCon adds options.

Three confidence tiers, marked per map. Do not blur them:

| Field | Column | Tier | Mapping |
|---|---|---|---|
| Gender | `sp_gender_category_id` | **verified** | `0` Male · `1` Female |
| Food | `sp_food_category_id` | **verified** | `0` Non-veg · `1` Veg |
| Community | `sp_minority_id` | **verified** for the Jain split | `0` Jain · `1,2,4,5` Non-Jain |
| Family status | `sp_family_status` | inferred | `0` both · `1` single parent · `3` father expired · `4` mother expired · `5` orphan |
| Education | `sce_education` | **verified** — app list | 10 codes, `EDU_1` … `EDU_10`; 8 in the data |
| Field of education | `sce_branch` | **verified** — app list | 32 codes (`FOE_16` unused); 25 in the data |
| Specialization | `sce_course_name` | **verified** — app list | 186 codes (`SPE_81` unused); 81 in the data |
| Board / University | `sce_board` | **verified** — app list | 112 codes (`UNI_93` unused); 33 in the data |

Four things about the education lists that will bite if changed:

- **`sce_education` labels moved when the real list landed.** `EDU_6` was being shown as
  "Graduation" and is actually **Dual Degree** (a B.Com+CA, a BA+LLB) — a real
  distinction, not a wording change. `EDU_2` lost its "(11th–12th)" gloss, `EDU_8` became
  "Overseas PG", `EDU_9` "Professional courses". `EDU_4` ITI and `EDU_10` Entrance Exams
  were missing entirely; neither appears in the data yet, and both are kept so a student
  entered under them tomorrow reads correctly.
- **Labels repeat across `FOE_*` codes on purpose.** "Medicine" is `FOE_8` at graduation
  and `FOE_28` at post graduation; "Engineering" is `FOE_5` for a diploma/ITI and `FOE_26`
  for an entrance exam. The field is only ever read beside the education level that scopes
  it. Do not invent qualifiers to tell them apart.
- **`SPE_186` is "None"**, and is the most common value in the table (197 rows). It is an
  answer, not a gap: School and Junior College students are offered no specialization.
- **Typos are reproduced exactly** — "Rural Develoment", "Rubber Technolgy", "Anesthisia",
  "administraion", "TOFFEL". A course that reads one way in EduCon and another way here is
  a discrepancy someone has to chase. Fix them in the app's resource file and re-export.

`sce_board` is **one column holding two kinds of answer**: `UNI_107`–`UNI_113` are school
boards (SSC, HSC, CBSE, ICSE, IB, CIE, Others) and `UNI_1`–`UNI_106` are universities.
That is why the field is labelled "Board / University" rather than either one.

How the verified ones were established, so nobody re-derives them from assumptions:

- **Gender** — grouping first names by the code separates them cleanly and with no
  overlap (`0`: Santosh, Arun, Hardik, Kamlesh, Yash; `1`: Apeksha, Bharti, Komal, Neha).
- **Community** — the surnames under `0` are a Jain roll-call (Oswal, Kasliwal, Sancheti,
  Kankariya, Kothari, Bora, Golecha, Rakecha, Gundecha, Lunkad, Mutha, Shah, Jain).
  Against a fixed list of ~50 classic Jain surnames, code `0` scores 68% and codes
  `1`, `2`, `4`, `5` score **exactly 0%**. Code `2` is Ansari / Khan / Pathan / Shaikh;
  code `4` — the largest at 248 — is Gaikwad / Jadhav / Pawar / Patil / Thorat.
- **Food** — the independent confirmation of both: 101 of the 102 students on community
  code `0` carry food code `1`, which for a Jain cohort can only be vegetarian.

The brief is explicit that the community source is a list of many, not a pair, so
`casteGroup()` reduces it to Jain / Non-Jain for reporting while `CASTE` keeps the
specific answer — the card shows it under the reported group rather than in place of it.

**Family status is the one guess that changes a displayed word.** Codes `1` and `3` are
both mother-only in the family table (father rows: 4 of 30, and 4 of 48) and the data
cannot separate them; the pairing above is conventional, not evidenced. Since 2026-09-05
the field is a **column in the student list and in the hover preview**, not only a line on
card 1 — the business decides cases on it — so that guess is now read far more often. If
EduCon supplies the real list, `FAMILY_STATUS` in `codeLabels.js` is still the only place
to change.

### Pseudo-users — exclude from any roster

`educon_user_etm_mapping` assigns cases to four accounts that are **not people**:

| `login_id` | Display name | Holds |
|---|---|---|
| `rcp` | Reached Carierpoint | 116 students |
| `clo` | Closed Rejected | 82 students |
| `E300` | Amit Educon | 22 students |
| `as` | Admin Educon | 8 students |

They are filtered out in `services/pipelineService.js` (`PSEUDO_USERS`). Students held
only by these accounts surface in the dashboard as **unassigned**, which is why the
cohort total exceeds the distinct-assigned count — especially in older years.

### Approval authority and Sanction authority — the case, never the profile

**They are columns of the student drill-down list, not of the status matrix** (moved
2026-09-08, at the user's request). They sit between ETM/ATM and the money, one login code
per student, naming who signed *that student's* case off. An authority is a fact about a
case, so this is where it answers a question; aggregated up to a team member it was a set
of codes, not an answer, and it was never comparable with the Total column beside it.

**Do not reinstate them on the summary matrix or in its Excel export.** The matrix header
is back to `# · Team member · Total · the 7 columns`, the export to
`Sl · Name · Code · Total · the 7 columns`, and the export's Notes sheet no longer carries
the authority blocks or the code-to-name key. The section below records the source
evidence, which still stands and is the part not to re-derive:

| Heading | Holds |
|---|---|
| **Approval auth** | the **first level approver** |
| **Sanction auth** | the **final approver** (the sanctioning authority) |

**The headings are the short ones and stay that way** — asked for explicitly on
2026-09-07, when the business named what each column should *hold* and said not to rename
the columns themselves. The role each one carries is in the heading's tooltip, in the
export's header, and on the export's Notes sheet.

**Two sources, in that order: who signed, else who is assigned** (2026-09-08). The
case-level tables record what *happened*, and for a case nobody has touched yet nothing has
— **zero of the 178 `CREATED` cases carry a first-level-approval or a sanction row**. But
the student is already assigned an authority, on their own profile row, so the columns fall
back to it:

| | Source | Marked |
|---|---|---|
| **Signed** | `educon_student_first_level_approval.approval_id` · `educon_student_final_approval_and_sanction.sanctioning_authority_id` — the case | plain |
| **Assigned** | `educon_user_profile.first_level_auth` / `sanctioning_auth` — the student | `assigned: true`; muted italic, `(assigned)` in the export |

**This is the source the matrix deliberately rejected, and the distinction matters.** There
it competed with the actual authority and lost — it agrees with what really happened on
only 442 of 736 decided cases. Here it never competes: it is read **only** when the case has
no actual authority, so there is nothing to disagree with, and it is the sole answer to "who
is this student with". The signed value always wins. Do not blend the two — "dd will approve
this" and "dd approved this" are different claims, which is why the fallback is marked on
screen (muted, italic, "not yet approved" on hover) and spelled out in the export.

**Pseudo-users are suppressed.** The planned columns hold a **numeric `u_id`** — unlike the
case-level columns, which hold a `login_id` — and 87 of the 177 unapproved `CREATED` cases
point at a holding-pen account (`E300`, `rcp`, `clo`). Those are not approvers; `clo` under
Sanction auth would be a fabrication, so they stay blank. What survives is real: 73 of the
74 `CREATED` cases in 2026-2027 read `dd` for approval and `ks` or `mp` for sanction — the
same people who actually sign. The `_login_id` twin columns are **NULL on all 462 rows**, so
the numeric id and a `u_id` join are the only way in.

`AUTHORITY_JOINS` in `pipelineService.js` puts both onto every `/api/students` row.
`getAuthorities()` — the per-member aggregate the matrix used — still runs and
`/api/report` still carries `authorities` on every member, but **nothing reads it**; it is
kept so the columns can be restored if the business changes its mind.

The database holds the answer **twice, and the two disagree** — verified 2026-09-07:

| Source | Is | Use it? |
|---|---|---|
| `educon_user_profile.first_level_auth` / `sanctioning_auth` / `scrutiny_auth` (+ their `_login_id` twins, all NULL) | the **planned** authority, set on the *student's* profile row | **No** |
| `educon_student_first_level_approval.approval_id` | who **actually** gave first-level approval, on the case | **Yes** |
| `educon_student_final_approval_and_sanction.sanctioning_authority_id` | who **actually** sanctioned, on the case | **Yes** |

Why the profile columns lose, so nobody reinstates them:

- Read off a **handler's own** row they are meaningless — all 30 roster members carry
  `300` (Amit Educon) in all three columns. They describe students, not staff.
- Read off **their students** they disagree with what happened: 442 of 736 decided cases
  match on approval, 383 on sanction.
- They cannot even fill one cell — they split a single member between two sanctioning
  authorities on 15 of 30 rows in 2025-2026.

`etm_first_level_authority` and `etm_sanctioning_authority` look like the right tables and
are **both empty (0 rows)**. Do not build on them.

There is a **second** case-level candidate for the first level approver —
`educon_student_final_approval_and_sanction.first_approval_authority_id`, sitting beside
the sanctioning authority in the same row. It is **not** used, and the check that settles
it is worth not re-running: across every case where both records exist, the two name the
same person on **720 of 720** — they never disagree. The first-level table simply covers 31
more cases, the ones approved but not yet sanctioned (15 `BUDGET_PENDING`, 8
`STUDENT_DISBURSED`, 7 `FIRST_LEVEL_APPROVED`, 1 `NO_REQUIREMENT_THIS_YEAR`). Reading the
approver off the sanction row would blank those 31 cells for no gain.

Both authority columns hold a **`login_id` string**, not a numeric id. `login_id` is
unique across all 462 `educon_user_profile` rows and never NULL, so joining on it fans
nothing out. Only four people ever appear as an approver (`dd` 710, `ss` 37, `sss` 2,
`ks` 1) and three as a sanctioner (`ks` 706, `dd` 20, `mp` 13); every code resolves to a
real person, and an unresolvable one falls through to the raw code, never to a guess.

Two traps in the join:

- `educon_student_first_level_approval` keys on the **case** `s_id` and has no
  `academic_year` — the case already carries the year. 750 rows / 750 distinct `s_id`.
- `educon_student_final_approval_and_sanction` carries the **same 14 re-saved duplicate
  `(s_id, academic_year)` keys** the sanction amount does, so it is read through a
  `SELECT DISTINCT`. Verified that no duplicated key differs on the authority.

**The cells show the login code, not the name** — `dd`, `ks`, `mp`, never "Mr. Deepak
Daga". Asked for directly on 2026-09-07 ("only add the short forms of their name, not the
whole name"), and it is the same code the member column already prints under every name,
so nothing new has to be learned to read it. The full name and case count are the cell's
tooltip. The Excel sheet uses the codes too and carries a **code-to-name key on its Notes
sheet**, built from whoever actually appears in that workbook — a printed page cannot
hover, and a sheet of bare `dd`/`ks` would be unreadable outside the team.

**An authority is a fact about a case, not about a member**, so a member row can name more
than one and does — 6 of 24 members in 2022-2023 on approval, 7 of 26 in 2026-2027 on
sanction. The server returns the full set, commonest first. Because the codes are short
the cell lists **every** one inline (`ks, mp`) rather than the leader plus a `+N` badge:
the widest such cell in any year, `dd, ks, ss`, is 64px, narrower than the heading above
it, so the badge bought no width and cost a hover. The export adds the case count to each
code when there is more than one (`ks (52), mp (12)`).

The case counts cover **every** case the member holds for the year, including the
statuses the 7 reported columns exclude, so they are deliberately **not comparable with
the Total column** — which is why the tooltip says "cases" and never "of N". An em dash
means no case of theirs has reached that stage in that year.

The Grand Total row's pair is `assignedAuthorities`, the union over the whole assigned
cohort. Because each case has exactly one handler, it is the exact sum of the member rows
— checked for all 7 years.

### ETM vs ATM

The `role` table (`sct`, `cm`, `admin`, …) does **not** separate ATM from ETM — both
teams hold a mix. Team membership comes from the business roster constant `ATM_CODES`
in `pipelineService.js`.

`is_senior` distinguishes the owning/fallback handler (`1`) from the working
assignment (`0`). Current reporting counts **all** real-person mappings.

### Roster drift vs. the legacy spreadsheet

- Spreadsheet `ng` → DB `nig`; `PD` → DB `pmd962`; `ts` → DB `TS`
- Spreadsheet `dd2` (Deepak Doshi) **does not exist in the database**
- DB has two people absent from the spreadsheet: `ac` (Archana Chordiya), `jrs` (Jaysukh Shah)

`AGREED_MAX` in `pipelineService.js` holds each member's agreed capacity. This is a
commercial agreement with **no column in the database** — it must be maintained by hand.

---

## The counting bug (do not reintroduce)

Earlier services `LEFT JOIN`ed `educon_user_academic_details` on `academic_year` and
treated a missing row as `CREATED`. Because 461 students are mapped but only ~205 have
a record in a given year, this **inflated every handler's numbers by 100%+**.

The rule: a student counts toward a year **only if they have an actual row for that
year**. `getMatrix()` uses `INNER JOIN` for exactly this reason.

---

## Architecture

```
Dashboard/
├── backend/
│   ├── server.js                 Express app + read-only pool + all routes
│   └── services/
│       ├── pipelineService.js    Every educon_prod query. Single source of truth.
│       ├── codeLabels.js         Every code → label. The only place a code becomes a word.
│                                 Its four education maps come from EduCon-Code-Labels_01.xlsx
│                                 (repo root) — EduCon's own dropdown lists.
│       └── authService.js        Local accounts, roles, sessions. Never touches educon_prod.
├── frontend/
│   ├── index.html                Login screen + app shell + all three pages
│   ├── css/dashboard.css         Design tokens, light + dark
│   ├── css/app.css               Login, shell, and the Ascent overview page
│   ├── js/columns.js             The 7 reported columns. Loaded first; both pages read it.
│   ├── js/filters.js             Column filters: the drill-down list + the Users tables.
│   ├── js/xlsx.js                The workbook writer. Both exports go through it.
│   ├── js/students.js            The drill-down: hover panel + both dialogs + list export
│   ├── js/app.js                 Auth, navigation, page 1 overview, user management
│   └── js/dashboard.js           Page 2 rendering, SVG charts, Excel export
├── config/
│   └── .env.example               Environment variable template
├── scripts/
│   └── start-dashboard-and-open.bat  Local launcher
├── .env                          Credentials (not committed)
├── package.json
└── package-lock.json
```

**No build step, no framework, no CDN** still holds. Dependencies added for auth are
`bcryptjs` and `cookie-parser` (both pure JS). Accounts live in MySQL through the
`mysql2` the dashboard already uses, so there is no second database driver and nothing
native to compile. Requires Node 22+.

### Shell layout

`#appShell` is a two-column CSS grid: a fixed 244px **left sidebar** and the main column
(`.shell-main`). The sidebar holds the brand and the section nav — Dashboard, Student
Status Summary, Users — and is present on every page, so navigation never moves. There is
no top nav; the topbar is now just the page title and the profile menu.

`.shell-main` carries `min-width: 0` so the wide status matrix scrolls inside
`.table-scroll` instead of stretching the grid column and pushing the page sideways.

A `☰` toggle is visible at every width, but there are **two buttons, one behaviour
each**, and CSS shows exactly one — the topbar never carries a toggle next to the page
title on a normal desktop width:

- **≥901px** — `#sidebarToggle` (`.sidebar-toggle-rail`) sits **inside the sidebar**, at
  the right end of `.sidebar-brand`. It collapses the sidebar to a 66px icon rail
  (`#appShell.is-collapsed`). Labels, tagline and footer are hidden; `title=` on each
  `.navlink` names it in the rail. In the rail the brand stacks vertically — 50px of
  usable width cannot hold the 40px mark and the 34px button side by side.
- **≤900px** — the rail button is hidden and `#drawerToggle` (`.sidebar-toggle-drawer`,
  in the topbar) takes over: the grid collapses to one column and the sidebar becomes an
  off-canvas drawer with a scrim, closed on every navigation, on Escape, and on crossing
  back. It must live in the topbar, because a closed drawer carries the sidebar's own
  button off-screen with it.

`syncToggle()` labels both buttons and the click handler is bound to both, so whichever
one is showing behaves correctly. Escape returns focus to `#drawerToggle` — the drawer is
only ever open below the breakpoint, where the rail button is hidden.

A 6px drag handle (`.sidebar-resizer`) on the right edge resizes the sidebar between
190 and 400px; arrow keys do the same, and double-click restores 244px. Both the
collapsed flag and the width persist in `localStorage` (every access is try/caught —
it throws outright in some privacy modes).

**The width lives in two custom properties on purpose.** JS writes
`--sidebar-user-w` inline; CSS resolves `--sidebar-w: var(--sidebar-user-w, 244px)`.
Writing `--sidebar-w` inline instead would outrank `#appShell.is-collapsed`, and the
sidebar could never be collapsed once it had been dragged.

The sidebar itself has `overflow: hidden` and only `.sidenav` scrolls, which is what
keeps the brand locked to the top and the footer to the bottom on every page.

### Pages

1. **Dashboard** — animated hero and the status distribution chart.
2. **Student Status Summary** — the member × status matrix, with Excel/CSV export.
3. **Users** (admin only) — manage dashboard accounts and view recent sign-ins.

The hero comes from `/api/overview`; the status distribution and the matrix are
both rendered by `dashboard.js` from `/api/report`. Because `/api/overview` is derived
from the same `getYearReport()` payload, the two pages can never disagree about a number.
`dashboard.js` is booted for either data page, since it now renders on both.

Deliberately removed (do not reintroduce without being asked): the status matrix's
column-filter row, the coverage ring, the
seven-year trend chart, the busiest-handlers strip, the KPI card row that used to sit
above the matrix, the four headline tiles that used to sit under the hero on page 1, and
the topbar status line (the `Live · educon_prod` badge, the "Updated Ns ago" freshness
counter, and the read-only notice), and the summary page's **"Status matrix" heading**
(removed 2026-09-01 — the topbar page title already names the page). `/api/trend` still
exists and is still guarded, but nothing consumes it.

### The profile menu — four rows, no descriptions

Reduced on 2026-09-08 at the user's request to **Refresh data · Toggle theme · Manage
users · Sign out**, with the name, `@handle` and role in the head above them.

- **Settings is gone permanently** — the button, the `#settingsDialog`, `#icoSettings`,
  the `.settings-*` / `.segmented` CSS and the `paintThemeChoice` handler. It held exactly
  two things and the menu already carries both: the theme is the "Toggle theme" row, and
  "signed in as" is the head. Do not reinstate it. The one capability actually lost is
  pinning the theme to **system** — the menu row cycles light/dark only. If that is wanted
  back, it belongs as a third state on the existing row, not as a dialog.
- **The two hint labels are gone** ("from database" on Refresh, and the live theme name on
  Toggle). They described what the row's own verb already says. With that column removed
  `.usermenu-hint` no longer exists and `describeTheme()` was deleted with it — so nothing
  needs recomputing when the menu opens, and `openMenu()` no longer calls anything.
- The panel's `min-width` dropped 258 → **188px** and the rows to 7px padding. It renders
  at ~234px, because the head's full name — not the `min-width` — is now what sets the
  width. That is intended: the account is the reason the menu exists.

**Sign out is only visible when `AUTH_ENABLED=true`.** See the Authentication section — a
menu with no Sign out means the variable is off, not that the button was lost.

**All three summary-page filters sit in the topbar.** As of 2026-09-01 the year selector's
summary-page slot (`#yearSlotSummary`) is in `.topbar-controls` beside the member search
rather than in the matrix panel head, so Team · Search member · Academic year read as one
row of controls. It is still the *same* `#yearField` element that page 1 borrows — `app.js`
moves it into the active page's slot — so the two pages still cannot look at different
years. The matrix panel head is now the Heatmap and empty-rows chips and nothing else.

Two smaller decisions from the same pass: the member search is `.field-search` (a fixed
168px lookup box, not the old `.field-grow` that stretched to 300px) and its placeholder
is `Name…` — there is no member *code* to search on, so offering one was a false promise.
The year and Team `<select>`s are `width: auto` with no min-width (`.field-year .select`,
`.field-team .select`), each sized by its own widest option — the closed control only,
the dropdown list is untouched.
The empty-rows chip's label names the **next** action: it reads "Hide empty rows" and
becomes "Unhide empty rows" once rows are hidden. Both the chip and the empty state's
"Clear filters" link go through `syncZeroToggle()`, so the label can never contradict
`state.hideEmpty`.

With the status line gone, failures report themselves on the surfaces that remain: the
hero headline on page 1, and the panel subtitles (`.panel-sub-error`) for anything
`dashboard.js` fetches. `/api/health` is still called once by `dashboard.js`, but now only
as a liveness guard — it turns an unreachable database into one clear message instead of a
confusing failure further in. It used to supply the database name for the export header;
that stamp was removed on 2026-09-01.

**The Excel export's header carries the academic year, the generation time, and — only
when something is filtering — what was filtered.** It used to print
`· Database: educon_prod (read-only)` beneath the title. That line was removed at the
user's request: the sheet is printed and circulated outside the team, and the server's
schema name is an internal detail that means nothing to the people reading the report. Do
not reinstate it on the exported page — the dashboard's own read-only assurance still
appears on the login screen and in the sidebar footer, which is where it belongs.

The provenance line added on 2026-09-05 is the opposite case, and the distinction is the
whole point: the schema name told the reader nothing, whereas "which rows is this?" is
the one thing they cannot recover from the file. Team, the member search and "hide empty
rows" have always narrowed `visibleMembers()` and therefore the export, but silently — a
workbook of six ATMs circulated as if it were the roster. An **unfiltered** export is
unchanged, byte for byte; a filtered one gains one line naming each active filter and
`N of M team members shown`, and its last row reads **"Grand Total (all members)"** rather
than "Grand Total". That row is `assignedStatusTotals`, a DISTINCT count over the whole
cohort that deliberately does not equal the sum of the rows above it and does not move
when they are filtered — unlabelled, in a printed sheet, that reads as an arithmetic
error.

### One workbook writer — `frontend/js/xlsx.js`

Two surfaces export now, so the hand-rolled ZIP/CRC32/OOXML stack was lifted out of
`dashboard.js` into `js/xlsx.js` (`window.EduConXlsx`) rather than copied. It exposes
`workbook(sheets)`, `save(sheets, filename)`, the style-id map `S`, `colLetter` and
`safeName`; a sheet is `{ name, rows, merges, cols, freezeRow }` and the writer knows
nothing about statuses or students. Still no library, no CDN, no build step — a real
.xlsx, so Excel does not warn about the extension. Add a sheet by adding an entry to the
array; content types and relationship ids are generated from its length (styles.xml takes
the id after the last sheet, so a new sheet cannot steal it).

`S.money` and `S.moneyGrand` (added 2026-09-07 for the student list's amounts) carry
`numFmt` 164, a ₹ amount in Indian digit grouping. The cell still holds a plain number, so
Excel sums it; only the display is formatted. **Append new style ids, never insert one** —
the ids are positions in `<cellXfs>`, and one inserted in the middle silently restyles
every existing call site.

The hero reads **only** `assignedStatusTotals`, summing it over `PIPELINE_COLUMNS` — so
"N students tracked, M disbursed" is by construction identical to the matrix's Grand
Total row. It is deliberately *not* `cohortTotal`, which counts rejected, closed,
career-point, budget-pending and unassigned students the matrix does not report.
`/api/overview` still returns `cohortTotal`, `headline.*` and `reconciliation`, none of
which the hero renders now that the tiles are gone.

Both pages refresh every two minutes, and again on `visibilitychange` — the interval
skips while the tab is hidden, so without that a returning user could read figures up
to two minutes stale. `api()` fetches with `cache: 'no-store'` for the same reason.

### The drill-down — every number opens

Every **non-zero** number in the status matrix is a way into the students behind it.
`renderMatrix` stamps `data-col` / `data-etm` / `data-year` on those cells and
`js/students.js` binds by **delegation on the table**, because renderMatrix replaces the
table's `innerHTML` on every sort, filter and refresh. Zero cells are deliberately left
unmarked: an empty list reads as a failure rather than as an answer.

| Gesture | Shows |
|---|---|
| hover a number | a compact panel — **Sr. No · Student ID · Student · Current status · Family status**, plus **ETM / ATM** on the Grand Total row |
| click a number | the full list in a dialog: 19 columns, one filter per column, a sortable Student ID heading, a **totals row**, a maximise control and **Export** |
| click a student | two cards — **Academic details** and **Student disbursement** |

The two views answer different questions and so carry different columns. The preview has
to fit beside the number it explains, so it stays narrow and answers *who*. The dialog is
where the question becomes *who, and what kind of student*, so it carries the academic and
personal attributes with a filter on each — which is what the maximise control is for.
Both are drawn from the same `/api/students` payload and the same cache, so they can
never disagree.

**The ETM/ATM column appears only when the rows do not all name the same handler.** That
is exactly the Grand Total case; a member's own cell has one handler by construction, and
a column repeating one name down every row is noise. The server sends `handler` on every
row regardless — a column that appeared and vanished depending on which cell you came
from would read as a bug.

The dialog's 21 columns: Sr. No · Student ID · Student · Current status · ETM/ATM ·
**Approval auth · Sanction auth** · **Sanctioned · Disbursed · Pending disbursement** ·
Education · Field of education · Specialization · Std/Year · College · Board/University ·
College city · Gender · Community · Food · Family status.

**The first six are the identity block, in that order, asked for on 2026-09-08**: who the
student is, where they are, whose they are, and who signed them off — before any figure.
The two authority columns came down from the matrix in the same pass.

**The default order is the pipeline, not the alphabet** (2026-09-08). The list opens in
status order — CREATED, then CHANGE_REQUIRED, then SUBMITTED, and so on — because a list is
read to see where a cohort has got to, and a Total or Grand Total cell mixes several
statuses together. The rank comes from `window.PIPELINE_COLUMNS` rather than from a second
list in `students.js`, so the sequence *down* a list is by construction the sequence
*across* the matrix; a status outside the 7 reported columns sorts to the end, never to the
front. Ties fall back to the student name, so the order is total. The Student ID sort still
cycles asc → desc → **back to this order** (its third state used to be "student name, A→Z",
which no longer exists), and the export stamps `Sorted by pipeline status` when it is in
force.

#### The money columns, and the row that totals them (2026-09-07)

Asked for directly: *"when user clicks on any number they want the columns like sanction,
disbursed, pending disbursement — and then total of that amount."* Every one of these
lists was being read with the same follow-up question, and answering it a student at a
time — one click each, then add them up by hand — was the wrong shape of answer.

- **They are the same figures card 2 shows**, for the academic year the list is being read
  at: `MAX(amount_sanctioned)` for the case-year, a sum over `DISTINCT_PAYMENTS` for the
  disbursement, and the signed difference. Both subqueries are the ones `getStudentDetail`
  already used, so a row in the list and that student's own card cannot disagree —
  verified student by student over all 156 in the 2025-2026 Grand Total.
- **They sit directly behind Current status, not at the right-hand end.** With 19 columns
  the far right is two screens of horizontal scroll away, and these three are the reason
  the list was opened.
- **`view:finance` gates them, server-side.** `/api/students` decides from the session
  whether to run the two money subqueries at all, so a `viewer`'s payload carries no
  `money` object and the client draws no columns — the same boundary that already stops a
  viewer opening one student's amounts. Asking for them is not a way to be given them.
- **Pending stays signed here too**, and is never clamped. A negative is printed in red
  with `Disbursed beyond sanction` on hover — the column has no room for card 2's relabel.
  It is common, not exceptional: only 128 of 208 cases in 2025-2026 have a sanction row at
  all, so the Student Disbursed column's pending total for that year is **−₹12,53,353**.
  That is the database, not an arithmetic fault.
- **The totals row is a `<tfoot>`, filled from the rendered cells**, and it totals what is
  on screen: apply a filter and it follows, along with a `· 18 of 156 students` note beside
  the word "Total". A total with no count beside it is exactly the figure that gets quoted
  later as the cell's own. It is read from each cell's `data-amount` — the exact number —
  never by re-parsing the ₹ string beside it.
- **The row is sticky to the bottom** of the scroll region, for the same reason the header
  is sticky to the top: on a 156-student list the sum is otherwise 156 rows away.
- The three columns filter as a **numeric floor** (`min`), not as text: the question asked
  of them is "who is owed more than X".
- **The amounts are right-aligned**, and so are the headings, the totals row, the filter
  boxes and the exported cells (`S.money` / `S.moneyGrand` in `xlsx.js`) —
  `font-variant-numeric: tabular-nums` lines the digits up under each other. Changed from
  centred on 2026-09-08 at the user's request: units under units is how a column of amounts
  is compared. A centred heading over right-aligned figures reads as two columns, which is
  why all four move together.
- **A zero prints as nothing** — the em dash, not `₹0` (2026-09-08, at the user's request).
  A column of `₹0` reads as a figure somebody recorded, where the truth is usually that no
  sanction row exists or nothing has been paid yet. The cell still carries
  `data-amount="0"`, so the totals row and the export are unaffected; a nil **total** blanks
  by the same rule, and the exported cell goes out empty while keeping the money style so
  the column still formats and sums as one.
- **They are one uniform 118px block**, not three columns of different widths — `width` on
  `.dt-money`, a preference rather than a cap, honoured down to the widest heading word.
  118px fits "SANCTIONED" on one line and a seven-figure total ("₹49,50,925" is 72px);
  "Pending disbursement", which is 183px set on one line, wraps to two. Their widths are
  the headings' and the data's alone — see the filter-row note under "Column filters".
- The **hover preview is unchanged** — five columns, no money, no totals. It is a glance
  beside a number, not a ledger.

**Family status is the one personal field that also rides in the hover preview** (added
2026-09-05, at the user's request: it is a criterion cases are decided on, so it should not
need a click). It is the preview's fifth column — sixth on the Grand Total row, with the
handler — which is why `.drillpop` is 660px rather than 545px. In the dialog it filters as
`select`, like the other categorical fields. Live check on the 2025-2026 Grand Total: 156
students, of whom 118 both parents, 21 father expired, 11 single parent, 3 mother expired,
1 orphan and 2 with no answer — a real discriminator, not a column of one value. Note that
codes `1` and `3` are the one inferred pair in `codeLabels.js` (see "Coded fields"), and
promoting the field into two lists puts that guess in front of more readers.

**Field of education, Specialization and Board/University were promoted into the list on
2026-09-01**, when `codeLabels.js` got the real dropdowns. They were held back until then
because raw codes would have made them 157 rows of `SPE_186`. Education → field →
specialization is the application's own hierarchy and reads as one thought across three
columns — "Graduation · Medicine · MBBS : Allopathic" — which is what makes the list
answer *what kind of student is this* rather than only *who*. All three filter as
`select`: the whole point is to pick one exact course and see only it.

#### Sorting — Student ID, and only Student ID

Added 2026-09-05, at the user's request: the list is read by student code as often as by
name, and in both directions. **Student ID is the only sortable column** and must stay
that way unless asked otherwise — everything else in the list is a category, and the
filter row is the right tool for a category.

- **Three states, not two**: click cycles ascending → descending → **back to the server's
  order** (student name, A→Z). A plain toggle would leave no way back to the default
  without closing the dialog, which also drops the filters. `SORT_CYCLE` in
  `js/students.js` is `[0, 1, -1]`.
- The heading's **tooltip names the next click**, not the current state — the same
  convention as the summary page's empty-rows chip, so the control cannot contradict
  itself. `aria-sort` on the `<th>` carries the current state for screen readers.
- The comparator is `localeCompare` with **`numeric: true`** (so `e73` sorts before `e113`,
  not after it as a plain string compare would) and **`sensitivity: 'base'`** (so the one
  upper-case `E747` sorts among the `e…` codes rather than as its own block). Ties fall
  back to the name, so the order is total and a re-render never reshuffles equal rows.
  Verified against the 2025-2026 Grand Total: 156 codes, descending is the exact reverse of
  ascending, no blank codes.
- A sort **rebuilds the whole table** rather than reordering rows, because Sr. No, the
  filter row and the select options all have to agree with what is on screen. No request is
  made — `listStudents` holds the payload and `renderList()` redraws from it — and
  `filters.mount()` puts back everything typed.
- **The sort persists across dialog openings; the filters do not.** Both are session state,
  and the difference is that a sort hides nothing: a new cell opened re-sorted still shows
  every student it should, while one opened pre-filtered shows fewer and reads as missing
  data. The maximised size persists for the same reason.
- The hover preview is **not** sorted and has no sort control (`sortDir` undefined in
  `listTable`). It is a glance at a number, not a table to work in.
- Export follows the screen: rows come out in the displayed order, and the sheet's third
  header line stamps `Sorted by Student ID (A → Z)` beside the filter record, so a
  re-ordered sheet never looks like a corrupted one.

**Searching a student ID** is the Student ID column's own filter box — substring,
case-insensitive, in the filter row under the heading. It is the one filter placeholder
worded as a search (`Search ID…`, set by `placeholder` on the column): a code is looked up,
not chosen from a list of 158. Search and sort compose — filtering hides rows, sorting
reorders what is left, and the footer keeps saying "18 of 156 students".

#### The two cards

Card 1 **Academic details** — Education · Field of education · Specialization · College
name · Board / University · Std / current year · College city · Gender · Community ·
Food preference · Family status · Parent location.

Card 2 **Student disbursement** — Sanctioned · Disbursed · Pending for disbursement,
unchanged, including the "Disbursed beyond sanction" relabel for a negative.

Card 1 is **per academic year**, not per student: the seven academic fields come from the
case row, so a student reads FY Engineering in one year and TY in the next, and a year
with no education row says so rather than borrowing another year's college. The five
personal fields are one row for life and do not move with the year selector.

**Parent location is the permanent address** (`spa_*`), not the current one (`sa_*`): a
student living in a Pune hostel still has parents in Junnar. It falls back to `sa_*` for
the 5 rows with no permanent city.

#### Column filters — `frontend/js/filters.js`

One module, three tables: the drill-down list, and both tables on the Users page. Three
control types — `text` (substring), `select` (exact, options built from the rendered
cells), `min` (numeric floor).

**The status matrix has no filter row, and must not get one back.** It had one briefly on
2026-08-28 and it was removed the same day at the user's request: a row of "min" boxes
under every status heading was noise against a grid whose whole job is to be read at a
glance, and the filters that matter there already sit in the topbar (Team, the member
search, and — since 2026-09-01 — the academic year). Filtering belongs on the drill-down list behind a number, which is where
it was actually asked for. `renderMatrix` carries a comment saying so; the matrix
therefore also has no `data-etm-row` / `data-filter-group` attributes and `exportExcel`
reads `visibleMembers()` alone.

**The filter state lives in the module, keyed by table id, not in the markup.** All three
tables replace their own `innerHTML` — the list on every year change, the user tables
after every edit — and a filter row written into that markup would be destroyed by the
next render along with whatever had been typed. `mount()` is called again after each
render and puts the values back.

**The drill-down's filters are released when its dialog closes** (2026-09-05, at the
user's request). Surviving a *render* and surviving a *session* had been conflated: a
refresh mid-read must not lose what was typed, but the next number opened is a different
question, and answering it through the previous one's filter shows a count smaller than
the cell that was clicked with nothing on screen saying why — it reads as missing
students, not as a filter. `students.js` calls `EduConFilters.forget('drillList')` on the
dialog's `close` event, which covers the ✕, Escape and a programmatic close alike.
`forget()` **deletes** the entry rather than emptying it (`clear()` does that, for a table
still on screen), so the next `mount()` starts blank. The Users tables deliberately keep
theirs: they are a standing view of a page, not a window that opens and closes. The
maximised size also still persists — it is a reading preference, not a question.

Three details that bite if changed:

- Filtering reads the **rendered cell text**, not the underlying data, so a decoded label
  filters as the word on screen rather than as the stored `1`.
- The filter inputs carry `size=1`. An input's default intrinsic width is ~20 characters,
  which in an auto-layout table becomes the column's minimum — a Student ID column
  holding `e747` was being held open to 179px by the box under it.
- **In the drill list the controls are taken out of flow entirely** (2026-09-07), because
  `size=1` is ignored on `type=number` and means nothing to a `<select>` — whose intrinsic
  width is its *widest option*. Measured on the 2025-2026 Grand Total, the filter row, not
  the data, was setting nearly every column: Current status 213px, Specialization 215px,
  ETM/ATM 185px, and each money column 167px against a heading needing 95px and amounts
  needing 63px. The table came to 3179px, most of it air. `.drill-table tr.filter-row
  .filter-input` is now absolutely positioned inside its (already `sticky`, so already
  positioned) header cell, contributing nothing to intrinsic sizing: the column is sized by
  its heading and its cells, and the control stretches to whatever that is. Table width
  2816px, and nothing else moved. Two things to keep: the row needs an explicit `height`
  (40px = 5 + a select's natural 28 + 7) now that no child is in flow, and the control is
  **centred, not stretched** — anchoring `bottom` squeezed a select from 28px to 21px and
  clipped its own text, so "All" rendered as "ΛII". Scoped to `.drill-table`; the Users
  page tables keep their in-flow controls.
- The serial column is **renumbered** against what survived (`renumber: 0`). Without it a
  filtered table reads 1, 2, 4, 5, 9 and looks like missing data. The counter resets at
  each `data-filter-group` row, which is how a grouped table keeps each block starting
  at 1.

#### Exporting one cell's students — the Export button in the dialog head

Added 2026-09-05, for the ETMs and ATMs who read the dashboard: filter the list behind a
number to the students they care about, then take exactly that away as a sheet.

- **It is built from the rendered table, not from the `/api/students` payload.** That is
  what makes "export what I filtered" true by construction instead of by a second
  implementation of the filter that could drift from the first. It also inherits the
  decoded labels and exactly the columns actually drawn — the ETM/ATM column exists only
  on the Grand Total row, and the sheet follows.
- Hidden rows (`row.hidden`, set by `filters.js`) are dropped; `tHead.rows[0]` is the
  header and `tHead.rows[1]` is the filter row, which must never become column headings.
  A handler cell holds the name with the login id in a `<span>` beneath it, so the cells
  are read from `childNodes` joined with a space — `textContent` alone gives
  "Rohit Deshmukh rd" run together.
- **The money goes out as numbers, not as text**, in a ₹ format (`numFmt` 164 in
  `xlsx.js`), and the sheet ends with the same **Total** row the screen shows, summed over
  the rows actually written. A column of ₹ strings would be one Excel cannot add up, and
  totalling a filtered set is the first thing anyone does with this file.
- **The sheet's header names the cell, the academic year and every filter in force**, and
  says `N of M students`. A filtered list circulated without that record is read as the
  cell's total by whoever opens it next week. When nothing is filtering, the line says so
  explicitly rather than being omitted. The filename carries the same four facts and ends
  `-filtered` when it is a subset.
- The button is **disabled whenever there is nothing on screen to give** — mid-load, after
  a failure, and when the filters have matched no rows. Disabled and explained by its
  `title`, not hidden: a control that vanishes reads as a bug.
- It is gated `data-perm="export"`, the same permission as the summary page's own export
  button, so **a `viewer` does not get it** — give an ETM/ATM who needs to export the
  `manager` role. The permission is enforced server-side on the data behind it either way.
- It is `.btn-primary`, the same blue as the summary page's Export. Two identical actions
  on two screens must not look like two different controls. Disabled, it keeps the accent
  at 45% rather than turning grey, so it does not appear to change identity when it wakes.

**Both dialog heads wrap their controls in `.dialog-head-actions`.** The year select,
Export, maximise and close are one group in their own flex row, aligned `flex-end` to
each other and given a shared 34px height. Loose in `.dialog-head` — which is
`align-items: flex-start`, so the title and its subtitle stack from the top — each
control aligned itself against the *title block* instead, and they came out on three
different heights; the user rejected that on sight. The group also carries the
`margin-left: auto` that pushes it right and the `margin-right: -4px` that keeps the ✕
optically flush with the dialog's padding (−4 rather than the icon button's old −6,
because the buttons grew from 30px to 34px around a centred glyph). Below 560px the word
"Export" drops and the icon carries it; `aria-label` and `title` still name it.

#### Column widths, and maximise

**Re-measured 2026-09-08, at the user's request — every column as wide as its own data and
its own heading, and no wider. The table went 3056px → 2547px** across 21 columns, measured
in headless Chrome against the real dialog and 156 real students. What was taking the space,
in order of how much:

| | Before | After | Why |
|---|---|---|---|
| horizontal padding | 10px | **7px** | charged once per side per column — ~126px on a 21-column table |
| `min-width` floors | 120–170px on 5 prose columns | **removed** | set above anything in the data, so they held columns open at a width nothing needed |
| `max-width` caps | 190–320px | **130–220px** | now ≈ the column's 95th-percentile value, so only true outliers wrap |
| `.dt-money` | 118px | **96px** | 118 was measured against headings set on one line |
| `.dt-auth` | 96px | **68px** | data is a 14px login code; the heading is the whole constraint |

Biggest single savings: College 320 → 220, Board/University 260 → 190, the two authority
columns 120 → 77 each, and the three money columns 118 → 96/96/107.

**A `min-width` on a column of this table is almost always a bug.** Under `table-layout:
auto` a column with no floor is already sized to max(its heading, its content) — which *is*
the rule the business asked for — so a floor can only ever make it wider than its data,
never narrower. The caps are the opposite: they are load-bearing, because the data contains
real outliers a cap is the only defence against. College holds a **180-character** answer (a
student typed an essay into the field), 1288px unwrapped; College city holds a 76-character
college name, 544px; Board/University holds "National University of Educational Planning and
Administration", 444px.

**Headings wrap wherever the heading, not the data, would set the column** — Student ID,
both authority columns, the money columns, College city, Std/Year, ETM/ATM, and the three
course columns. Two short lines under a sticky header cost no usable height. Columns whose
*data* is the wider of the two are deliberately not in that list: wrapping their heading
buys nothing and costs a line. **Current status stays on one line at 193px** — that is
genuinely its longest value (`NO_REQUIREMENT_THIS_YEAR`), so it already obeys the rule.

Verified in the render, not just the CSS: **nothing clipped in any of the 21 columns, and no
heading breaks mid-word** (checked with a Range per word against real layout, the same
method the 2026-09-07 entry describes). Do not shrink `.dt-money` below 90px or `.dt-auth`
below 62px — both split their heading's longest word.

The drill table is `table-layout: auto` — each column as wide as its own data. Two rules
keep that honest: `nowrap` by default so a short value is never wrapped to save space the
table has, and a `max-width` on the three prose columns so one long college name cannot
take the whole table. In the dialog the table is `width: max-content` and scrolls; in the
hover preview it is `width: 100%` and wraps, because a horizontal scrollbar inside a hover
panel is not something anyone will reach for.

Watch the specificity: the prose columns are written `.drill-table td.dt-college`, not
`.dt-college`. The nowrap default is `.drill-table td` at (0,1,1) and a bare class is
(0,1,0) — it loses, and the college name prints straight across the city beside it.

Maximise is a **class, not the Fullscreen API**: the list is inside a `<dialog>` already
in the top layer, where requesting real fullscreen behaves differently across browsers and
drops the page's theming. `dialog.dialog-wide.is-max[open]` — the `[open]` is load-bearing,
because the class persists after the dialog closes and `display: flex` would otherwise
override the UA's `dialog:not([open]) { display: none }` and paint a closed dialog across
the page.

Statuses are printed **exactly** as the database holds them. `statusTag()` inserts a
`<wbr>` after each underscore so `REAPPLICATION_SUBMITTED` wraps at the underscore
instead of mid-word; `<wbr>` is zero-width and copies as nothing, so the value on screen
is still the DB value.

The list comes from `/api/students`, which takes the **exact statuses** as a query
parameter rather than a column name — that is what keeps `js/columns.js` the only place
the 7 columns are defined. Omitting `etmId` means the Grand Total row. Every cell in the
matrix was checked against its own list for 2025-2026: all 88 reconcile exactly.

Lists are cached by `year|etmId|column` so re-hovering is instant, and the cache is
cleared on every `/api/report` reload — a two-minute-old list under a current number
would read as a bug.

Two details that bite if changed:

- The hover panel takes **pointer events** (unlike `.tooltip`), so a long list can be
  scrolled. Moving between two numbers must `clearTimeout(hideTimer)` in the `mouseover`
  handler — otherwise the pending hide fires mid-wait, `hidePop` clears the pending
  show, and the first cell's list sits under the second cell's pointer.
- The dialog width rule is `dialog.dialog-wide`, not `.dialog-wide`. `css/app.css` is
  linked **after** `css/dashboard.css`, so its `.dialog { width: min(400px, …) }` wins on
  source order alone and squeezes the student name column to one character wide.

---

## Authentication

**Dashboard logins are completely separate from EduCon's own user table.** The
`educon_user_profile.password` column is never read, and `educon_prod` is never written
to. Dashboard accounts live in **MySQL**, in a non-production schema (`AUTH_DB_NAME`,
default `educon_test_1`) — see "Accounts persist" under Deploying. They were in a local
SQLite file until 2026-09-09, which is why they used to disappear on every Render
restart.

- Passwords are bcrypt hashed (cost 10). A failed login hashes a dummy value anyway, so
  a missing account and a wrong password take the same time.
- Sessions are HMAC-signed, self-contained cookies (8 hours, `httpOnly`, `sameSite=lax`).
  The account is re-read on every request, so disabling a user takes effect immediately.
- The first run seeds one administrator from `ADMIN_USERNAME` / `ADMIN_PASSWORD`. With no
  `ADMIN_PASSWORD` set, a random one is generated and printed once at startup.
- The last active administrator cannot be demoted, disabled, or deleted.
- **Minimum password length is 3 characters** (`authService.js`, both `createUser` and
  `updateUser`). Lowered from 8 on 2026-09-08 at the user's request — these are internal
  accounts for a known team on a read-only dashboard, not public sign-ups. The rule is
  enforced on the **server**; the Add-user form's label only describes it, so changing one
  without the other lets the dialog promise something the API refuses.

### `AUTH_ENABLED` — the whole login screen is behind one variable

`AUTH_ENABLED` in `.env` is the switch, and **it is off unless it reads exactly `true`**
(`authService.js`: `AUTH_DISABLED = String(process.env.AUTH_ENABLED || '').toLowerCase()
!== 'true'`). With it off, `requirePermission` never runs and every request is served as a
synthetic full-access `admin` called **`guest`** — no login screen, and the profile menu's
Sign out is removed by `app.js` (`logoutBtn.hidden = !!user.authDisabled`), because ending
a session that does not exist would bounce straight back in.

**`@guest · admin` in the profile menu is the tell** that the variable is off. That is not
a bug in the account system and no amount of creating users will change it: a dashboard
with accounts, roles and a Users page can still be wide open because this one line is
commented out. It was, until 2026-09-08.

It must be set in the **Render dashboard** as well as in `.env` — `.env` is not committed,
so a deploy with the variable set locally and not on the host is unauthenticated in
production while looking authenticated in development.

### Roles

| Role | view:dashboard | view:summary | view:finance | export | manage:users |
|---|:-:|:-:|:-:|:-:|:-:|
| `admin` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `manager` | ✓ | ✓ | ✓ | ✓ | |
| `viewer` | ✓ | ✓ | | | |

`view:finance` covers sanctioned / disbursed / pending amounts wherever they appear —
one student's card, and (since 2026-09-07) the three money columns and totals row in the
drill-down list. Those are per-person money figures rather than pipeline counts, so a
`viewer` can open the student list behind a cell but sees no amounts in it: the rows are
not clickable for them, `/api/students/:id` returns 403 regardless, and `/api/students`
simply does not run the money subqueries for their session.

Permissions are enforced **server-side** on every route. The frontend uses the same list
only to decide what to render — a control the role cannot use is removed from the DOM,
but that is a convenience, never the security boundary.

**No build step, no framework, no CDN.** Charts are hand-written SVG, and Excel export
is generated client-side as SpreadsheetML — the dashboard works fully offline apart
from its database connection.

### API

| Endpoint | Requires | Returns |
|---|---|---|
| `POST /api/auth/login` | — | Sets the session cookie; returns the user |
| `POST /api/auth/logout` | — | Clears the session cookie |
| `GET /api/auth/me` | session | The signed-in user, or 401 |
| `GET /api/health` | — | Pool liveness + which database is attached |
| `GET /api/years` | `view:dashboard` | Academic years present, newest first, with cohort sizes |
| `GET /api/overview?year=…` | `view:dashboard` | Page 1 hero and headline tiles |
| `GET /api/report?year=YYYY-YYYY` | `view:summary` | Full payload: statuses, member matrix, totals, reconciliation |
| `GET /api/students?year=…&statuses=A,B&etmId=…` | `view:summary` | The students behind one matrix cell. Omit `etmId` for the Grand Total row. Each row also carries `money` (sanctioned / disbursed / pending for that year) **only** for a role holding `view:finance`; `includesAmounts` says which it is |
| `GET /api/students/:studentId` | `view:finance` | One student's academic profile **and** sanctioned / disbursed / pending, per academic year |
| `GET /api/trend` | `view:dashboard` | Per-status totals for every year (trend chart) |
| `GET /api/users`, `POST`, `PATCH /:id`, `DELETE /:id` | `manage:users` | Local account management |
| `GET /api/login-history` | `manage:users` | Last 50 sign-in attempts |

Unauthenticated requests to a guarded route get **401**; an authenticated user whose role
lacks the permission gets **403**.

`year` is validated against the years actually present; an unknown year is a 500 with
a clear message rather than a silently empty result.

---

## Reconciliation — the dashboard proves its own numbers

Every response carries a `reconciliation` block, surfaced in the UI:

- **`cohortTotal`** — distinct students with a record for the year
- **`assignedDistinct`** — of those, how many a real person handles
- **`unassigned`** — the remainder, held only by pseudo-users
- **`memberRowSum`** — sum of the member rows

`memberRowSum > assignedDistinct` is **expected, not a bug**: a student worked by two
members counts once under each, because the sheet reports workload per person rather
than partitioning students. The UI states this explicitly rather than hiding it.

**Note:** the sum of the *displayed* columns is deliberately less than `cohortTotal` —
see "The 7 reported columns" above for the excluded statuses.

---

## Conventions

**Do:**
- Keep every query in `pipelineService.js`
- Use `COUNT(DISTINCT user_id)`
- `INNER JOIN` academic details when filtering by year
- Filter `PSEUDO_USERS` out of any roster
- Join on `user_id` for anything about the **student**, on `s_id` for anything about the
  **case** — see "The two ID columns" above
- Take `MAX(amount_sanctioned)`, never `SUM`, for a case's sanctioned amount
- Sum payments over `DISTINCT_PAYMENTS`, never over `educon_payment_transaction_details`
  directly — both money tables contain re-saved duplicate rows with distinct primary keys
- Keep the 7 reported columns in sync between the screen and the Excel export — both
  read the same `COLUMNS` array, so change it in one place only
- Put every code → label mapping in `codeLabels.js`, and let an unmapped code fall
  through to itself. Never invent a label for a code you have no evidence for
- Validate any chart palette with the `dataviz` skill's validator before shipping
- **Render a layout change before calling it done.** Three separate entries below record
  getting one wrong by reasoning from the CSS alone. Puppeteer is *not* installed and does
  not need to be — **headless Chrome is already on this machine** at
  `C:\Program Files\Google\Chrome\Application\chrome.exe` (Edge too). The route that works:
  write a throwaway `frontend/*.tmp.html` harness linking the **real** stylesheets and the
  real `columns.js` / `filters.js` / `xlsx.js` / `students.js`, paste in the dialog markup
  from `index.html`, stub `window.fetch` with a real `/api/students` payload dumped to
  JSON, set `window.EduConUser` permissions, synthesise the cell click, then measure in
  script and read it back with `--headless --dump-dom` (or `--screenshot` for an image;
  `--virtual-time-budget=6000` waits for the render). Serve it off the running app so the
  relative asset paths resolve. **Delete the `*.tmp.*` files afterwards.**

**Don't:**
- Don't write to the database. Ever.
- Don't merge or drop statuses beyond the two decisions recorded above
- Don't `LEFT JOIN` academic details and treat missing rows as `CREATED`
- Don't add a chart library or CDN dependency
- Don't commit `.env`

---

## Running it

```bash
cd Dashboard
npm install          # first run only
npm start            # http://localhost:3000
PORT=3007 npm start  # if 3000 is taken
```

On the very first start, watch the console — it prints the administrator username and
password once. Sign in with those, then go to **Users** and create real accounts.

Or double-click `start-dashboard-and-open.bat` (accepts a port: `… .bat 3007`).

## Deploying (Render)

Hosted at `github.com/htfsystem/educon_dashboard` → Render auto-deploys on push to
`main`. Requires **Node 22+**; pinned via `engines` in package.json.

Environment variables to set in the Render dashboard: the five `DB_*` values,
`NODE_ENV=production`, `AUTH_ENABLED=true`, `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
`SESSION_SECRET` and `AUTH_DB_NAME` are optional — see below.

### Accounts persist — they live in MySQL, not on the filesystem

**Resolved 2026-09-09.** Accounts used to live in a local SQLite file
(`data/dashboard.db`), and Render's filesystem is ephemeral: the file was destroyed on
every deploy and restart, and on the free tier after ~15 minutes idle. The symptom was
specific and misleading — **the admin still worked and nobody else did**, because
`ADMIN_USERNAME` / `ADMIN_PASSWORD` re-seed that one account from the environment on
every boot while a colleague added through the Users page simply vanished.

They now live in **MySQL**, in `AUTH_DB_NAME` (default `educon_test_1`), in three
tables `authService.js` creates on first run:

| Table | Holds |
|---|---|
| `dashboard_users` | the accounts — bcrypt hashes, role, active flag |
| `dashboard_login_log` | sign-in attempts (the Users page's recent-sign-ins list) |
| `dashboard_settings` | one row: the session signing key |

`educon_prod` is **still never written to**, and `getPool()` throws at startup if
`AUTH_DB_NAME` equals `DB_NAME`, so a mis-set variable cannot point the writes at
production. The `educon` user holds `ALL PRIVILEGES` on `educon_test_1` and
`educon_testdb_27sep25` — re-verified 2026-09-09 by creating, writing to and dropping a
probe table in each.

Consequences, all of them the point of the change:

- **A user is created once and stays.** Restart, redeploy, idle spin-down — the account
  is still there, and it is not tied to any host's disk.
- **The seed is genuinely first-run only.** It fires only when `dashboard_users` is
  empty, so it can no longer resurrect a deleted administrator or reset a password the
  team has since changed. `ADMIN_PASSWORD_RESET=true` is the deliberate recovery hatch
  for a forgotten password; unset it after the boot that uses it.
- **`SESSION_SECRET` is now optional.** With it unset, a key is generated once and kept
  in `dashboard_settings`, so a restart no longer signs everyone out. Set it only to
  invalidate every session at once. The old `data/.session-secret` file is gone.
- `DATA_DIR` and `node:sqlite` are gone from `authService.js`. Node 22+ is still pinned
  for other reasons, but no longer for `node:sqlite`.

The `data/` directory is no longer created or used.

### Troubleshooting

- **`EADDRINUSE`** — another app holds the port. Pass a different one.
- **Numbers look wrong** — check `/api/health`, then the reconciliation panel at the
  bottom of the dashboard. If the integrity check fails, the query changed.
- **A member shows 0** — they may genuinely have no students with a record that year;
  older years legitimately have most cases parked on `rcp`/`clo`.
- **Locked out of the dashboard** — set `ADMIN_PASSWORD_RESET=true` alongside
  `ADMIN_USERNAME` / `ADMIN_PASSWORD` and restart: that one boot resets the
  administrator's password and re-enables the account. Unset the variable afterwards.
  Deleting a file no longer does anything — the accounts are in MySQL. Emptying
  `AUTH_DB_NAME.dashboard_users` re-seeds a fresh administrator on the next boot and
  destroys every dashboard account; no EduCon data is affected either way.
- **A colleague cannot sign in although you can** — this was the ephemeral-SQLite bug,
  fixed 2026-09-09. If it recurs, check the startup log for
  `✓ account store ready — <schema>.dashboard_users` and confirm `AUTH_DB_NAME` is the
  same schema on every host.

---

## Last verified

2026-09-09 — **dashboard accounts moved from SQLite to MySQL, so a user created once
persists forever.** The reported symptom was that the administrator could always sign in
but colleagues added through the Users page could not, after a logout or a restart. That
is not an account-system bug: Render's filesystem is ephemeral, `data/dashboard.db` was
destroyed on every restart, and the admin came back only because `ADMIN_USERNAME` /
`ADMIN_PASSWORD` re-seed it from the environment each boot. **Every other account was
being deleted by the host, not by the code.**

`authService.js` is now MySQL-backed (`AUTH_DB_NAME`, default `educon_test_1`) and every
account function is `async`; `server.js`'s six auth call sites were awaited to match, and
`attachUser` became async middleware that yields a 401 rather than a crash if the account
database is unreachable. `node:sqlite`, `DATA_DIR` and the `data/` directory are gone from
the auth path. **No query, join, count or UI changed** — `/api/report` still answers 200.

Write access was **probed, not assumed**: a table was created, written to, read back and
dropped in both `educon_test_1` and `educon_testdb_27sep25`. `getPool()` throws at startup
if `AUTH_DB_NAME` equals `DB_NAME`, so the writes can never reach `educon_prod`.

Driven end to end against a running server and the live host, **killing the process
between steps to simulate a redeploy**:

- First boot seeds `admin` and prints `stored in: educon_test_1.dashboard_users
  (persistent)`. A colleague (`komal` / `manager`) is created through `POST /api/users`.
- **After a real restart, `komal` signs in and gets `/api/report` 200** — and the boot
  log no longer prints the seed banner, so the first-run seed correctly did not re-fire.
  This is the exact scenario that used to fail.
- **Sessions survive a restart with `SESSION_SECRET` unset**: a cookie issued before the
  kill still answers `/api/auth/me` 200 afterwards, because the key is now a row in
  `dashboard_settings` rather than a file.
- The boundary is unchanged: unauthenticated `/api/report` → 401; a `manager` calling
  `/api/users` → 403; a wrong password → 401 and a `false` row in the login log; a 2-char
  password → 400; `KOMAL` against existing `komal` → "already taken" (the unique key is
  case-insensitive, matching SQLite's old `COLLATE NOCASE`). The login history survived
  the restart too.
- The test account was deleted afterwards; the table holds only `admin`.

**Nothing was rendered** — this change has no UI. One deployment consequence, recorded
because it is silent: `AUTH_DB_NAME` must name the *same* schema on every host, or
development and production keep separate account tables.

2026-09-08 — **the drill-down list's columns were re-measured and the table is 17%
narrower: 3056px → 2547px.** Asked for directly: every column as wide as its own data and
its own name, and no wider. CSS only — no query, service or count touched. The figures and
the reasoning are under "Column widths, and maximise" above; the short version is that
horizontal padding, five `min-width` floors set above anything in the data, and over-generous
prose caps were between them holding ~500px of empty space open.

**This was measured in headless Chrome, not reasoned from the CSS** — the first time that
has been done in this repo, after three earlier entries recorded getting a layout wrong
without it. Chrome is already installed; the harness recipe is now in Conventions above, so
the next layout change has no excuse. Against the real dialog and 156 real students, before
and after, in both themes:

- **21 of 21 columns clip nothing** and **no heading breaks mid-word** (a Range per word
  against real layout, not a synthetic probe).
- Per-column: College 320 → 220, Board/University 260 → 190, Specialization 209 → 175,
  Field of education 190 → 150, the authority columns 120 → 77 each, the money columns
  118 → 96 / 96 / 107, Education 141 → 135, Student 160 → 154, Current status 199 → 193.
- Rendered light and dark: the wrapped `APPROVAL / AUTH` headings sit on two lines cleanly,
  the assigned codes read as muted italic, the em-dash zeros and the right-aligned totals
  row are correct in both.

2026-09-08 — **the authority columns now fall back to the assigned authority**, so a
`CREATED` student no longer reads as an em dash. Asked for directly: those students already
have an approving and a sanctioning authority assigned, and the columns were blank for them.

They were blank for a real reason — **zero of the 178 `CREATED` cases have a row in either
case-level table**, because those record what happened and nothing has. The answer was on
the student's profile row all along. See "Approval authority and Sanction authority" above
for why that source is right here and was wrong on the matrix, and for the pseudo-user
suppression; both are the parts not to re-derive.

Checked against live `educon_prod`, three years. **Nothing fans out and no signed value
moved**: the lists are still 156 / 156 distinct for 2026-2027 and 2025-2026 and 51 / 51 for
2022-2023, and the *signed* counts are unchanged to the row — 2025-2026 still reads 123
approval / 120 sanction, the same figure raw SQL gives. The gap is what filled:

| Year | `CREATED` | signed | assigned | blank |
|---|---|---|---|---|
| 2026-2027 | 73 | 0 | **73** | 0 |
| 2025-2026 | 12 | 0 | **11** | 1 |
| 2022-2023 | 1 | 0 | **1** | 0 |

The one remaining blank is correct — that student's assigned authority is a holding-pen
account. **No pseudo-user reached a cell in any of the three years.** `/api/students` was
driven against a running server and returns `{"loginId":"dd","name":"Mr. Deepak
Daga","assigned":true}` for the first 2026-2027 `CREATED` student. Still not rendered
headless — puppeteer is not installed here — so the muted-italic treatment of an assigned
code has not been checked as an image.

2026-09-08 — **the authorities moved down to the student, the amounts were re-aligned, and
the list now opens in pipeline order.** Four requests in one pass:

1. **Approval auth / Sanction auth are per student**, in the drill-down list between
   ETM/ATM and the money, and **gone from the status matrix and its Excel export** (headers,
   cells, sort key, subtotal and Grand Total padding, column widths, and the Notes sheet's
   two authority blocks and code-to-name key). One new query shape: `AUTHORITY_JOINS` in
   `getStudentList`, reading the same two case-level sources `getAuthorities` uses.
2. **Amounts are right-aligned** — cells, headings, totals row, filter boxes, and the two
   ₹ styles in `xlsx.js`.
3. **A zero amount prints blank**, on screen, in the totals row and in the export.
4. **The list's default sort is pipeline status order**, from `PIPELINE_COLUMNS`.

Checked against live `educon_prod`. **No count moved and nothing fans out**: the
2025-2026 Grand Total list is still 156 rows / 156 distinct students and 2022-2023 still
51 / 51, with the two new joins in place. The authorities match raw SQL on **every row of
both years — zero mismatches** (2025-2026: 123 approvals, 120 sanctions; 2022-2023: 46 and
46, agreeing with the per-year figures recorded below), and every code resolves to a real
person (`dd`, `ks`, `ss`). `/api/students` and `/api/report` both answer 200 against a
running server.

**Not rendered headless** — puppeteer is not installed here and adding it was outside the
request. The matrix change is a removal that returns the header to the shape it had before
2026-09-07, and the arithmetic was checked by hand (matrix header, body, section band
colspan and Grand Total all 10 cells; every export row 11), but the drill list's new column
widths and the right-aligned money have **not** been looked at as an image. Do that before
treating the layout as settled — see the two entries below where reasoning from the CSS
alone got it wrong.

2026-09-08 — **sign-in was switched on, and the profile menu cut to four rows.** No query,
join or service changed and **no count moved**; this is auth configuration and chrome.

The request read as "add the user authentication page", but the whole system already
existed and was simply **disabled**: `AUTH_ENABLED` was commented out in `.env`, so every
request ran as the synthetic `guest` admin and the login screen never appeared. That also
explains the missing Sign out — `app.js` removes it when `authDisabled`. One uncommented
line, not a feature. **Check that variable before concluding auth is unbuilt.**

Then: Settings removed entirely (button, dialog, icon symbol, CSS, handler), both hint
labels dropped, and the panel narrowed 258 → 188px `min-width`.

Verified against a running server on a throwaway `DATA_DIR`, so the real
`data/dashboard.db` was untouched:

- **The boundary holds.** Unauthenticated `/api/report` → **401**; with a session → 200;
  after `POST /api/auth/logout` → **401** again, and `/api/auth/me` → 401. The session is
  genuinely dead, not just hidden client-side.
- **Short passwords work end to end.** `admin` / `abc` (3 chars) seeds and signs in;
  creating `kk` / `kom` through `POST /api/users` succeeds; a 2-char password is refused
  **400 "Password must be at least 3 characters"**. The earlier "at least 8" error the user
  hit was a stale server process, not stale code.
- **Driven headless in both themes** — 10 checks, all passing: a visitor gets the login
  screen with the shell hidden; after sign-in the menu holds exactly `Refresh data`,
  `Toggle theme`, `Manage users`, `Sign out` at a uniform 34px; **zero** `.usermenu-hint`
  spans survive and neither `#settingsBtn` nor `#settingsDialog` exists in the DOM; the
  panel measures 234x221px; and clicking Sign out closes the menu, hides the shell and puts
  the login screen back. Rendered as images too — the menu reads clean in light and dark,
  and the post-logout screenshot is the login card.

One deployment consequence, recorded because it is silent: `.env` is not committed, so
**`AUTH_ENABLED=true` must also be set in the Render dashboard** or production stays open
while development looks locked.

2026-09-07 — **the two authority columns show short forms, and were resized to them.**
Asked for directly: *"I want First Level Approver in Approval auth column and Final
approver in Sanction Auth. Don't change the column name — you have to retrieve data from
that particular column. Only add the short forms of their name, not the whole name."*

Nothing about the **headings** changed, and nothing about the **query** changed: Approval
auth was already the first level approver and Sanction auth already the final approver.
The source was re-checked against the one other case-level candidate,
`educon_student_final_approval_and_sanction.first_approval_authority_id`, and they name the
same person on **720 of 720** cases where both records exist — zero disagreement — while
the first-level table covers 31 more cases (approved but not yet sanctioned). So the
existing source stands, and the section above records why.

What changed is the **value**: `dd` / `ks` / `mp` instead of "Mr. Deepak Daga", with the
full name and case count in the tooltip, plus a code-to-name key on the export's Notes
sheet. With short values the cell now lists every code inline (`ks, mp`) and the `+N`
badge is gone.

**Then the columns were re-measured against the new data, which is where the work was.**
The binding constraint moved from the data to the heading:

| | before (names) | after (codes) |
|---|---|---|
| widest cell, all 7 years | "Mr. Deepak Daga" 115px | `dd, ks, ss` 64px |
| longest heading word | — (heading fitted on one line) | `SANCTION` 76px |
| `.col-auth` width | 136px | **90px** |
| `.matrix` min-width | 1445px | **1353px** |
| visible member rows at 1600px | 9 | **13** |

The heading is now allowed to wrap to two lines ("APPROVAL / AUTH"), which costs no height
because the status headings beside it already take two — so the column only has to fit the
longest single word. **Do not shrink it to 78px** to fit the codes alone: that splits the
heading. The grid still scrolls sideways at 1600px with the sidebar open, by ~55px rather
than ~147px, and not at all with the sidebar collapsed to its rail.

Driven headless against the real page in both themes — 21 checks, all passing: the two
headings are unchanged and still sit between Team member and Total, no cell prints a full
name, every code on screen is one of the real approvers, every tooltip expands its codes to
names with case counts, the column measures exactly 90px with no cell wrapping or clipping,
rows are back to 39px, **no heading breaks mid-word** (checked from real layout with a
Range per word, not a synthetic probe — that mis-flagged the 56px Total column), sorting
cycles, the authority cells are still not drill targets, and clicking a number still opens
its student list. The 2021-2022 worst case `dd, ks, ss` was rendered and fits on one line.

The export was downloaded and read back entry by entry, filtered and unfiltered: header is
`Approval auth (first level approver)` / `Sanction auth (final approver)`, all 30 rows
carry codes and no full names, a split reads `ks (52), mp (12)`, subtotals leave both cells
empty, and the Notes key lists exactly the three codes the sheet uses and nobody else.

**No count moved.** All 7 years still reconcile against raw SQL (2025-2026 approval 123 /
sanction 120; 2026-2027 reads 69 / 64 rather than the 68 / 64 recorded below — the live
database gained a first-approval between the two runs, and the service and raw SQL agree at
69).

2026-09-07 — **Approval auth and Sanction auth are columns on the status matrix**, sitting
between Team member and Total, sortable, and carried into the Excel export. Read off the
case (`educon_student_first_level_approval.approval_id`,
`educon_student_final_approval_and_sanction.sanctioning_authority_id`), never off the
planned authority on the student's profile row — see "Approval authority and Sanction
authority" above for the evidence, which is the part not to re-derive.

Checked against live `educon_prod` for **all 7 academic years**: the per-member authority
sets sum exactly to the Grand Total sets in every year, and the case counts match raw SQL
exactly (2026-2027 approval 68 / sanction 64, 2025-2026 123 / 120, 2024-2025 102 / 101,
2023-2024 81 / 79, 2022-2023 59 / 59, 2021-2022 25 / 24, 2020-2021 9 / 8). **No existing
count moved** — no join, filter or status query changed; `getAuthorities` is a new query
and the member objects gain one field.

Driven headless against the real page in both themes: the two headings land in the right
place, every body row and the team band match the header's 12 columns, the Grand Total row
carries both, no raw login code reaches the screen, sorting cycles and sinks the
unrecorded rows to the end of their team block, the authority cells are **not** drill
targets, and clicking a number still opens its student list. The export was downloaded and
read back entry by entry: both sheets open, the header is Sl · Name · Code · Approval
authority · Sanction authority · Total · the 7 columns, all 30 member rows are full and
header-width, subtotals leave the authority cells empty, and a split authority is spelled
out with case counts rather than a `+N`.

Two width decisions were **measured, not chosen**, and the numbers are in the CSS. See the
2026-09-07 short-forms entry above for the values they were revised to.

**Render the matrix before calling a change to it done** — a two-line wrap and a mid-word
heading break were both invisible in the CSS and obvious in the image.

2026-09-07 — **the money is in the list.** Sanctioned, Disbursed and Pending disbursement
are columns of the drill-down dialog, with a sticky totals row that follows the filters.
One new query shape: `getStudentList` takes `withMoney` and adds the two subqueries
`getStudentDetail` already used, correlated against a new `pick.academicYear` so they bind
**no parameters of their own** — a `?` in that SELECT list would have taken the derived
table's `PSEUDO_USERS` and year instead.

Checked against live `educon_prod`. **No count moved**: the list is the same 156 students
in the same order with and without the money, all distinct, so the new subqueries fan out
nothing; a member cell still reconciles with its matrix number (13 = 13). Every row equals
that student's own card — all 156 in the 2025-2026 Grand Total compared field by field,
and all 51 in 2022-2023 — and both column totals match an independent aggregate query
(₹36,97,572 sanctioned, ₹49,50,925 disbursed for 2025-2026). The duplicate-voucher trap is
still avoided: a naive `SUM` over the raw payments table for that year reads ₹54,97,555.

The UI was then **driven headless against the real `columns.js`, `filters.js`, `xlsx.js`
and `students.js`** — the dialog markup lifted from `index.html`, a stubbed fetch,
synthetic clicks — and all 38 checks passed: the columns land behind Current status, the
totals row sums correctly and re-sums when a `min` filter narrows it (saying `· 3 of 5
students`), a negative pending stays negative and marked, a sort rebuilds the table
without losing either total or filter, the export writes numeric money cells and a Total
row and stamps the filter, the generated .xlsx unzips to six well-formed parts with the
₹ format declared, and a `viewer`'s list has neither the columns nor the row.

Finally **rendered from the running server against live data**, light and dark, at both
dialog sizes: the amounts sit right-aligned and tabular, the totals row stays pinned to the
bottom of the scroll, and the 2025-2026 pending total prints as **−₹12,53,353** in red —
correct, and the reason is in "Money" above: most disbursed cases have no sanction row.

Then, at the user's request, **every column in that list was made as wide as its own name
and data and no wider.** The filter controls had been setting nearly all of them; they are
now out of flow. Measured before and after in the real dialog: the money columns 179px →
a uniform 118px, Current status 225 → 199, ETM/ATM 197 → 157, Education 163 → 141, Food
138 → 114, Gender 89 → 68, and the table 3179px → 2816px, with two more columns fitting on
screen at the same dialog size. Re-rendered in both themes and both sizes afterwards — the
selects read "All" at their natural 28px — and the Users page filter row was checked to be
untouched (`position: static`, 26px control, 41px row, exactly as before).

2026-09-05 — **family status is a column, and Student ID sorts both ways.** Two requests,
both client-side: no query, join or service changed, and no count moved. `familyStatus` was
already on every `/api/students` row, so the column is a `LIST_COLUMNS` entry plus a
`POP_KEYS` entry; sorting is `SORT_CYCLE` + `renderList()` in `js/students.js`; searching a
code is the Student ID column's own filter, reworded `Search ID…`.

Checked against live `educon_prod` (2025-2026 Grand Total, 156 students): family status
fills 154 of 156 — 118 both parents, 21 father expired, 11 single parent, 3 mother expired,
1 orphan, 2 unanswered — so the column discriminates rather than repeating one value; and
the comparator over the real 156 codes puts `e73` before `e113`, sorts the single
upper-case `E747` among the lower-case codes, and gives a descending order that is the
exact reverse of ascending.

The UI was then **driven headless against the real `columns.js`, `filters.js` and
`students.js`** — a stubbed `fetch`, the real dialog markup, synthetic clicks — and all 21
checks passed: opens in server order with no caret, three clicks cycle asc → desc → back,
`aria-sort` and the tooltip follow, Sr. No renumbers each time, and a search typed into the
Student ID box survives a sort with its value, its `is-set` styling and its filtered rows
intact. Rendered as images too, light and dark: the caret sits on the heading's baseline
and the six-column preview fits 660px. Follow the same route for the next UI change — see
the note under the entry below.

2026-09-05 — **filters now end with the window that opened them, and the filtered list
exports.** Three changes, none of which touches a query: the drill-down dialog calls
`EduConFilters.forget('drillList')` on `close`, so a filter can no longer follow the user
into the next cell they open; an **Export** button in that dialog's head writes the
visible rows to .xlsx with the cell, the year and the active filters stamped in the sheet
header; and the summary page's own export gained the same provenance line when Team, the
member search or "hide empty rows" is narrowing it.

The workbook writer was lifted out of `dashboard.js` into `frontend/js/xlsx.js`
unchanged — same ZIP, same styles, same fixed 1980 timestamp — and generalised from two
hardcoded sheets to N. Verified by generating both the one-sheet and two-sheet packages
and reading every entry back: the ZIP opens, all CRCs check, the sheet XML is well-formed
and the escaping is intact (`A & B <test>` round-trips). The list extraction was checked
against a table with a hidden row, a filter row and a two-node handler cell: the filter
row is not read, the hidden row is dropped, Sr. No renumbers 1..n, and the handler reads
"Archana Chordiya ac". **No counts moved** — no join, filter or service changed, and
`/api/health` answers 200 with the new bundle served.

The dialog head was then rendered headless from the real markup and the real stylesheets
and checked as an image, after the first attempt shipped the controls on three different
heights: select, Export, maximise and close now sit on one line at one height, in light
and dark, and at the 560px breakpoint where the label drops to a bare icon. Render the
head before calling a change to it done — this is the second time reasoning about flex
alignment from the CSS alone got it wrong.

2026-09-01 — **the education code labels landed and every code in the data now decodes.**
`EduCon-Code-Labels_01.xlsx` was transcribed by script into `codeLabels.js`: 10 education,
32 field-of-education, 186 specialization and 112 board/university labels. Checked against
live `educon_prod`, every distinct code in all 940 rows of
`educon_student_current_education_details` resolves to a word — `sce_education` 8/8,
`sce_branch` 25/25, `sce_course_name` 81/81, `sce_board` 33/33 — and no raw code reaches
the drill-down: across all 158 students in the 2025-2026 Grand Total, 143 carry an
education row and all 143 decode on every one of the four fields.

`sce_board` is newly **read** as well as newly decoded — the column was never selected
before — and its distribution is the check that the list is the right one: Savitribai
Phule Pune University 47, Maharashtra University of Health Sciences 39. Reading now says
"Graduation · Medicine · MBBS : Allopathic · Maharashtra University of Health Sciences"
where it said "EDU_5 · FOE_8 · SPE_50" and nothing at all.

The counts did not move: only `PROFILE_COLUMNS` gained a column and `studentProfile` a
decoded field, no join or filter changed. `cohortTotal` 208 = 208 academic rows for
2025-2026, `assignedDistinct` 163 = `memberRowSum` 163.

2026-08-28 — the two student cards, column filters and the maximisable list added, and
checked against live `educon_prod`. **All 440 non-zero cells across all 7 academic years
reconcile exactly with the student list behind them** (2025-2026's 88 among them, Grand
Total 164 = 164) — the new profile joins are one row per key and fan out nothing. The
money is untouched: 1362 year rows returned for 1362 `educon_user_academic_details` rows,
and student 22292 still reads ₹100,000, not ₹200,000. Field coverage on a 128-student
list: education 126, community 128, handler 128, parent location 128.

~~Open — the labels for `FOE_*`, `SPE_*`, `UNI_*`.~~ **Closed 2026-09-01** — see below.
`sp_family_status` is still the one guess that changes a displayed word.

2026-08-27 — student drill-down added and checked against live `educon_prod`: every one
of the 88 non-zero cells in the 2025-2026 matrix reconciles exactly with the student list
behind it, Grand Total included (164 = 164). Sanctioned / disbursed / pending verified
per student and per year.

2026-08-22 — rebuilt against live `educon_prod`. Status counts reconcile to cohort
totals for all 7 academic years; per-member row integrity passes for every member.