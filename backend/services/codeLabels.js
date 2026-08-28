/**
 * CODE LABELS — the one place a stored code becomes a word on screen.
 *
 * educon_prod stores several of the student's own answers as opaque codes, and there is
 * NO lookup table for them anywhere on the server. Checked on 2026-08-28 across every
 * schema the `educon` user can see (educon_prod, educon_test_1, educon_testdb_27sep25,
 * test_db_ks): no table maps EDU_*, FOE_*, SPE_* or UNI_* to a label, and none maps the
 * numeric gender / minority / food / family-status codes either. Those labels live in
 * the EduCon *application's* own resource file, not in the database.
 *
 * So they live here instead — deliberately in one file, so that when the real dropdown
 * lists arrive they are pasted into these objects and every screen updates at once.
 *
 * `label()` falls back to the raw code, never to a guess. An unmapped specialization
 * shows as "SPE_186", which is honest: it says "the database holds a code and nobody has
 * told the dashboard what it means" rather than inventing a course name.
 *
 * ---------------------------------------------------------------------------------
 * CONFIDENCE — three tiers, marked per map. Do not blur them.
 *
 *   VERIFIED   derived from the data itself and cross-checked. Ship as fact.
 *   INFERRED   strong circumstantial evidence, recorded below. Correct if told so.
 *   UNMAPPED   no evidence. Falls through to the raw code.
 * ---------------------------------------------------------------------------------
 */

/**
 * VERIFIED — sp_gender_category_id.
 *
 * Evidence: grouping first names by the code splits them cleanly and with no overlap.
 * `0` → Santosh, Abhang, Arun, Avdhut, Hardik, Jenil, Kamlesh, Nitesh, Paresh, Pranav,
 * Rupesh, Tejas, Tushar, Vijay, Yash, Yogesh. `1` → Srushti, Apeksha, Arpita, Bharti,
 * Divya, Grisha, Harshada, Kajal, Komal, Manisha, Mayuri, Neha, Priti, Riddhi, Sneha,
 * Snehal, Tejal, Vaishnavi. 200 rows are `1`, 174 are `0`.
 */
const GENDER = {
  '0': 'Male',
  '1': 'Female'
};

/**
 * VERIFIED — sp_food_category_id.
 *
 * Evidence: cross-tabulated against the community code. 101 of the 102 Jain students
 * carry `1`, which for a Jain cohort can only be vegetarian. The highest rate of `0`
 * sits on the community code whose surnames are Muslim (8 of 13). 303 rows are `1`.
 */
const FOOD = {
  '0': 'Non-vegetarian',
  '1': 'Vegetarian'
};

/**
 * VERIFIED — sp_minority_id, the community / caste answer.
 *
 * The business only ever asks one question of it: Jain, or not Jain. See `casteGroup`.
 *
 * Evidence for `0` = Jain, and it is strong. Surnames under `0` are a Jain roll-call —
 * Oswal, Ostwal, Kasliwal, Sancheti, Kankariya, Kothari, Kotecha, Bora, Golecha,
 * Rakecha, Bedmutha, Gundecha, Bhandari, Chordiya, Lunawat, Lunkad, Munot, Mutha,
 * Navalakha, Pagariya, Bramhecha, Luniya, Nahar, Gadiya, Doshi, Mehta, Parekh, Sheth,
 * Shah, Jain. Against a fixed list of ~50 classic Jain surnames, code `0` scores 68%
 * (the remainder are Jain surnames outside that list) and codes `1`, `2`, `4`, `5` all
 * score **exactly 0%**. Code `2` is Ansari / Khan / Pathan / Shaikh / Saudagar; code `4`
 * — the largest at 248 — is Gaikwad / Jadhav / Pawar / Patil / More / Thorat.
 *
 * The food cross-tab above is the independent confirmation.
 *
 * The individual non-Jain labels below are INFERRED from those surnames and are not
 * used for the Jain / Non-Jain split, which depends only on the identity of code `0`.
 * Code `3` never appears in the data.
 */
const CASTE = {
  '0': 'Jain',
  '1': 'Jain',              // n=1 (surname Munot, a Jain surname); see JAIN_CODES
  '2': 'Muslim',            // inferred from surnames
  '4': 'Hindu',             // inferred from surnames
  '5': 'Other'              // inferred; 10 rows, mixed
};

/**
 * Which codes count as Jain. Kept separate from CASTE so that relabelling a community
 * never silently moves a student between the two reported groups.
 *
 * `1` is included on the strength of its single row carrying a Jain surname, and
 * because a Jain organisation's form is far more likely to list two Jain sub-communities
 * first than to bury one at code 4. It moves one student. If the real list says
 * otherwise, remove it here and nothing else changes.
 */
const JAIN_CODES = new Set(['0', '1']);

/**
 * INFERRED — sp_family_status. Correct these when the real list arrives.
 *
 * Evidence: cross-tabulated against which parents appear in
 * educon_student_family_details (joined on the CASE id, which is that table's key).
 *
 *   code  students  father row  mother row   reading
 *     0      285       282         269       both parents
 *     1       30         4          30       mother only
 *     3       48         4          45       mother only
 *     4        7         7           1       father only
 *     5        4         1           0       neither
 *
 * `0`, `4` and `5` are unambiguous. `1` and `3` are both mother-only and the data cannot
 * separate them; the split below is the conventional pairing (a bereavement and a
 * separation both leave the mother listed alone) and is the one guess in this file that
 * changes a displayed word rather than only a shade of confidence. Code `2` is unused.
 */
const FAMILY_STATUS = {
  '0': 'Both parents',
  '1': 'Single parent',
  '3': 'Father expired',
  '4': 'Mother expired',
  '5': 'Orphan'
};

/**
 * INFERRED — sce_education, the level of study.
 *
 * Evidence: the college names filed under each code, plus the year values that go with
 * them. Every reading below is drawn from names, not from the code number.
 *
 *   EDU_1  58   schools; years fifth…twelveth  ("… High School", "English Medium School")
 *   EDU_2  139  junior colleges; years eleventh / twelveth
 *   EDU_3  31   polytechnics, "(Diploma)", hospital nursing schools
 *   EDU_5  592  degree colleges — engineering, medical, commerce (the bulk of the data)
 *   EDU_6  8    degree colleges, years fy…fourthy; too few names to separate from EDU_5
 *   EDU_7  60   MBA / MCA / MD — IIM Trichy, Welingkar, Amity Global, MCA Mahila college
 *   EDU_8  5    University of Birmingham, University of Derby, Amity Global
 *   EDU_9  47   ICAI, flight-training academy, coaching classes, plus medical colleges
 *
 * EDU_4 never appears.
 */
const EDUCATION = {
  EDU_1: 'School',
  EDU_2: 'Junior College (11th–12th)',
  EDU_3: 'Diploma',
  EDU_5: 'Graduation',
  EDU_6: 'Graduation',
  EDU_7: 'Post Graduation',
  EDU_8: 'Overseas Education',
  EDU_9: 'Professional Course'
};

/**
 * UNMAPPED — sce_branch (FOE_1 … FOE_33), the field of education.
 *
 * Reading the students' own free-text course-reason essays gives a decent sense of the
 * larger codes (FOE_7 is overwhelmingly engineering, FOE_8 medicine, FOE_14 commerce),
 * but the essays are about ambitions rather than course names and several codes share a
 * theme. Guessing 33 labels off that would put invented words on a report. Empty until
 * the EduCon app's list arrives; every code falls through to itself.
 */
const FIELD_OF_EDUCATION = {};

/**
 * UNMAPPED — sce_course_name (SPE_1 … SPE_186), the specialization.
 * 186 codes and no evidence at all. Falls through to the raw code.
 */
const SPECIALIZATION = {};

/** UNMAPPED — sce_board (UNI_*), the university or board. Not currently displayed. */
const BOARD = {};

/**
 * VERIFIED by inspection — sce_year. Unlike the codes above these are English words
 * already ("fy", "twelveth"), so this map only tidies spelling and casing. Anything
 * unrecognised is title-cased rather than dropped.
 */
const STUDY_YEAR = {
  fy: 'FY (1st year)',
  sy: 'SY (2nd year)',
  ty: 'TY (3rd year)',
  fourthy: '4th year',
  finaly: 'Final year',
  first: '1st year',
  second: '2nd year',
  third: '3rd year',
  fourth: '4th year',
  fifth: 'Std 5th',
  sixth: 'Std 6th',
  seventh: 'Std 7th',
  eighth: 'Std 8th',
  ninth: 'Std 9th',
  tenth: 'Std 10th',
  eleventh: 'Std 11th',
  twelveth: 'Std 12th',
  other: 'Other'
};

/**
 * A code's label, or the code itself when nothing maps it.
 *
 * Never returns a placeholder like "Unknown" for a value that *is* present — a reader
 * has to be able to tell "the student did not answer" from "the dashboard has not been
 * told what this code means", and printing the raw code is what says the second.
 */
function label(map, code) {
  if (code === null || code === undefined) return null;
  const key = String(code).trim();
  if (!key) return null;
  return map[key] ?? key;
}

/** sce_year, tidied. Falls back to title case so an unseen value still reads. */
function studyYear(code, numericYear) {
  const key = String(code ?? '').trim().toLowerCase();
  const named = key ? (STUDY_YEAR[key] ?? (key.charAt(0).toUpperCase() + key.slice(1))) : null;

  // current_year is a 1-7 ordinal that mostly agrees with sce_year but is dirty in a
  // handful of rows (values of 2021, 26840). Only shown when it is plausible and when
  // sce_year gave nothing.
  const n = Number(numericYear);
  if (named) return named;
  if (Number.isInteger(n) && n >= 1 && n <= 12) return `Year ${n}`;
  return null;
}

/**
 * The only community question the dashboard reports: Jain, or not.
 *
 * The brief is explicit that the source is a list of many communities rather than two —
 * so this reduces that list, and `CASTE` above still holds the specific answer for the
 * card, rather than the reduction replacing it.
 */
function casteGroup(code) {
  if (code === null || code === undefined || String(code).trim() === '') return null;
  return JAIN_CODES.has(String(code).trim()) ? 'Jain' : 'Non-Jain';
}

/** "Pune, Pune, Maharashtra" without the empties, the repeats or the trailing comma. */
function place(...parts) {
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const v = String(p ?? '').replace(/\s+/g, ' ').trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out.length ? out.join(', ') : null;
}

/** Trimmed, or null — so the client can render one "Not recorded" for every blank. */
function text(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s || null;
}

module.exports = {
  GENDER,
  FOOD,
  CASTE,
  FAMILY_STATUS,
  EDUCATION,
  FIELD_OF_EDUCATION,
  SPECIALIZATION,
  BOARD,
  STUDY_YEAR,
  JAIN_CODES,
  label,
  studyYear,
  casteGroup,
  place,
  text
};
