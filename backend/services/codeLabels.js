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
 * So they live here instead — deliberately in one file, so that the real dropdown lists
 * are pasted into these objects and every screen updates at once.
 *
 * THE FOUR EDUCATION LISTS ARRIVED ON 2026-09-01, in EduCon-Code-Labels_01.xlsx (four
 * sheets: Education, Field of education, Specialization, Board or University). They were
 * transcribed from that workbook by script, not by hand, and are exact. Between them
 * they cover every code present in educon_prod:
 *
 *   sce_education    8 codes in the data / 10 mapped
 *   sce_branch      25 codes in the data / 32 mapped
 *   sce_course_name 81 codes in the data / 186 mapped
 *   sce_board       33 codes in the data / 112 mapped
 *
 * Nothing in the live data falls through to a raw code any more. The remaining guesses in
 * this file are `sp_family_status` and the individual non-Jain community labels.
 *
 * `label()` still falls back to the raw code, never to a guess — that is what tells a
 * reader "the database holds a code and nobody has told the dashboard what it means"
 * rather than inventing a course name, and it is how a code EduCon adds tomorrow will
 * announce itself instead of being quietly mislabelled.
 *
 * ---------------------------------------------------------------------------------
 * CONFIDENCE — three tiers, marked per map. Do not blur them.
 *
 *   VERIFIED   from the application's own list, or derived from the data and
 *              cross-checked. Ship as fact.
 *   INFERRED   strong circumstantial evidence, recorded below. Correct if told so.
 *   UNMAPPED   no evidence. Falls through to the raw code. (None left in this file.)
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
 * VERIFIED — sce_education, the level of study.
 *
 * Source: EduCon-Code-Labels_01.xlsx, sheet "Education" — the application's own dropdown
 * list, supplied 2026-09-01. These are no longer inferred from college names; they are
 * the exact words the student saw when they picked the option.
 *
 * Four labels changed when the real list arrived, and two codes were missing entirely:
 *
 *   EDU_2   was "Junior College (11th-12th)"  -> "Junior College"
 *   EDU_6   was "Graduation"                  -> "Dual Degree"  (a real distinction: a
 *                                                B.Com+CA or a BA+LLB, not a plain degree)
 *   EDU_8   was "Overseas Education"          -> "Overseas PG"
 *   EDU_9   was "Professional Course"         -> "Professional courses"
 *   EDU_4   ITI             — was printing as the raw code
 *   EDU_10  Entrance Exams  — was printing as the raw code
 *
 * EDU_4 and EDU_10 do not appear in educon_prod today (checked 2026-09-01 across all 940
 * rows of educon_student_current_education_details). They are kept so that a student
 * entered under them tomorrow reads correctly instead of printing "EDU_4".
 */
const EDUCATION = {
  EDU_1:  "School",
  EDU_2:  "Junior College",
  EDU_3:  "Diploma",
  EDU_4:  "ITI",
  EDU_5:  "Graduation",
  EDU_6:  "Dual Degree",
  EDU_7:  "Post Graduation",
  EDU_8:  "Overseas PG",
  EDU_9:  "Professional courses",
  EDU_10: "Entrance Exams"
};

/**
 * VERIFIED — sce_branch, the field of education.
 *
 * Source: EduCon-Code-Labels_01.xlsx, sheet "Field of education". Previously UNMAPPED and
 * printing a raw code on every card.
 *
 * FOE_16 is not in the application's list and does not appear in the data.
 *
 * Labels repeat across codes on purpose — "Medicine" is FOE_8 at graduation and FOE_28 at
 * post graduation; "Engineering" is FOE_5 for a diploma or ITI and FOE_26 for an entrance
 * exam — because the field is only ever read next to the education level that scopes it.
 * Do not de-duplicate them by inventing qualifiers the application does not use.
 *
 * 25 of these appear in educon_prod; every one is covered.
 */
const FIELD_OF_EDUCATION = {
  FOE_1:  "Science",
  FOE_2:  "Commerce",
  FOE_3:  "Arts",
  FOE_4:  "Others",
  FOE_5:  "Engineering",
  FOE_6:  "Diploma in Other fields",
  FOE_7:  "Engineering / B.Tech",
  FOE_8:  "Medicine",
  FOE_9:  "Allied Health Science",
  FOE_10: "Paramedical",
  FOE_11: "Teaching",
  FOE_12: "Bachelor of Arts (BA)",
  FOE_13: "Bachelor of Science (BSc)",
  FOE_14: "Bachelor of Commerce",
  FOE_15: "Other 3 years degree courses",
  FOE_17: "M.E. / M.Tech",
  FOE_18: "Masters of Arts (MA)",
  FOE_19: "Master of Science (MSc)",
  FOE_20: "Management",
  FOE_21: "Technical",
  FOE_22: "Other PG",
  FOE_23: "Medical",
  FOE_24: "Other entrance exams",
  FOE_25: "Management",
  FOE_26: "Engineering",
  FOE_27: "Commerce",
  FOE_28: "Medicine",
  FOE_29: "Allied Health Science",
  FOE_30: "Arts",
  FOE_31: "Commerce",
  FOE_32: "Science",
  FOE_33: "Professional course branch"
};

/**
 * VERIFIED — sce_course_name, the specialization.
 *
 * Source: EduCon-Code-Labels_01.xlsx, sheet "Specialization". Previously UNMAPPED — this
 * is the map that turns the 81 distinct codes in the live data into course names.
 *
 * SPE_81 is not in the application's list and does not appear in the data.
 *
 * SPE_186 is "None", and is the single most common value in educon_prod (197 rows). That
 * is an answer rather than a gap: it is the only specialization offered to School and
 * Junior College students, who do not have one.
 *
 * Labels are reproduced EXACTLY as the application shows them, typos included —
 * "Rural Develoment", "Rubber Technolgy", "Anesthisia", "administraion", "TOFFEL". This
 * dashboard reports on EduCon's data, and a course that reads one way in the application
 * and another way here is a discrepancy somebody has to chase. Correct them in the
 * application's resource file and re-export this sheet; do not correct them here.
 */
const SPECIALIZATION = {
  SPE_1:   "Event Management",
  SPE_2:   "Fashion Design",
  SPE_3:   "Film making",
  SPE_4:   "Fire safety",
  SPE_5:   "Foreign language",
  SPE_6:   "Hotel management",
  SPE_7:   "Interior Designing",
  SPE_8:   "Journalism",
  SPE_9:   "Rural Develoment",
  SPE_10:  "Other Non Engg Diploma",
  SPE_11:  "Fitter",
  SPE_12:  "Computer",
  SPE_13:  "Draughtsman",
  SPE_14:  "Electrician",
  SPE_15:  "Machine Tools",
  SPE_16:  "Mechanical",
  SPE_17:  "Plumber",
  SPE_18:  "Surveyor",
  SPE_19:  "Welder",
  SPE_20:  "Other ITI",
  SPE_21:  "Aeronautical",
  SPE_22:  "Agriculture",
  SPE_23:  "Architecture",
  SPE_24:  "Automobile",
  SPE_25:  "Bio Medical",
  SPE_26:  "Bio Tech",
  SPE_27:  "Ceramic",
  SPE_28:  "Chemical",
  SPE_29:  "Civil",
  SPE_30:  "Computer Science",
  SPE_31:  "Electronics and Telecommunication",
  SPE_32:  "Electrical",
  SPE_33:  "Electrical and Computer",
  SPE_34:  "Electronics",
  SPE_35:  "Environmental",
  SPE_36:  "Industrial",
  SPE_37:  "Information Tech.",
  SPE_38:  "Marine",
  SPE_39:  "Mechanical",
  SPE_40:  "Mining",
  SPE_41:  "Production",
  SPE_42:  "Rubber Technolgy",
  SPE_43:  "Textile",
  SPE_44:  "Other Engg",
  SPE_45:  "BAMS : Ayurveda",
  SPE_46:  "BDS : Dental",
  SPE_47:  "BHMS : Homeopathy",
  SPE_48:  "BNYS : Naturopathy",
  SPE_49:  "BPT : Physiotherapy",
  SPE_50:  "MBBS : Allopathic",
  SPE_51:  "Other Medical Courses",
  SPE_52:  "B. Pharma",
  SPE_53:  "BOT : Occupational Therapy",
  SPE_54:  "BSc Anesthisia",
  SPE_55:  "BSc Cardiac",
  SPE_56:  "BSc Medical lab",
  SPE_57:  "BSc Nursing",
  SPE_58:  "BSc Operation Theatre",
  SPE_59:  "BSc Radio Therapy",
  SPE_60:  "Other Nursing courses",
  SPE_61:  "Other Allied Health science",
  SPE_62:  "DHFM",
  SPE_63:  "Dialysis Technician",
  SPE_64:  "DLMT",
  SPE_65:  "DOA",
  SPE_66:  "DOT",
  SPE_67:  "ECG Technician",
  SPE_68:  "Health Inspector",
  SPE_69:  "Sanitary Inspector",
  SPE_70:  "Xray Technician",
  SPE_71:  "Other Paramedical",
  SPE_72:  "B.Ed",
  SPE_73:  "ECCED",
  SPE_74:  "UDPED",
  SPE_75:  "Other teaching courses",
  SPE_76:  "Economics",
  SPE_77:  "Fine Arts",
  SPE_78:  "Library science",
  SPE_79:  "Psychology",
  SPE_80:  "Other BA degree",
  SPE_82:  "BZC ( Botany/ Zoology/ Chem)",
  SPE_83:  "Computer science",
  SPE_84:  "Dairy Science",
  SPE_85:  "Home science",
  SPE_86:  "Horticulture",
  SPE_87:  "MPC(Math/Phy/Chem)",
  SPE_88:  "Other BSc",
  SPE_89:  "B. Com Regular",
  SPE_90:  "B. Com Taxation",
  SPE_91:  "B. Com Bank management",
  SPE_92:  "Other commerce degree course",
  SPE_93:  "B.A.F. ( accounts n finance)",
  SPE_94:  "B.B.A  ( business administraion)",
  SPE_95:  "B.B.M. ( Business Management)",
  SPE_96:  "B.C.A. ( Comp application)",
  SPE_97:  "B.F.M. ( Finance mgt)",
  SPE_98:  "B.M.S. ( Mgt studies)",
  SPE_99:  "L.L.B. (Law)",
  SPE_100: "Other 3 yrs degree course",
  SPE_101: "BA + LLB",
  SPE_102: "BA + BEd",
  SPE_103: "Other dual arts",
  SPE_104: "BSc + BEd",
  SPE_105: "Other dual science",
  SPE_106: "B. Com + ICWA Final",
  SPE_107: "B. Com + ICWA Foundation",
  SPE_108: "B. Com + ICWA Intermediate",
  SPE_109: "B.Com + CA Articleship",
  SPE_110: "B.Com + CA CPT",
  SPE_111: "B.Com + CA Final",
  SPE_112: "B.Com + CA Intermediate",
  SPE_113: "B.Com + CS Executive",
  SPE_114: "B.Com + CS Foundation",
  SPE_115: "BBA + LLB",
  SPE_116: "BBM + LLB",
  SPE_117: "Other dual commerce",
  SPE_118: "MAMS : Ayurveda",
  SPE_119: "MDS : Dental",
  SPE_120: "MD : Homeopathy",
  SPE_121: "MNYS : Naturopathy",
  SPE_122: "MPT : Physiotherapy",
  SPE_123: "MVSC : Veterinary",
  SPE_124: "MD : Allopathic",
  SPE_125: "Other Medical Courses",
  SPE_126: "M. Pharma",
  SPE_127: "BOT : Occupational Therapy",
  SPE_128: "MSc Anesthisia",
  SPE_129: "MSc Cardiac",
  SPE_130: "MSc Medical lab",
  SPE_131: "MSc Nursing",
  SPE_132: "MSc Operation Theatre",
  SPE_133: "MSc Radio Therapy",
  SPE_134: "Other Allied Health science",
  SPE_135: "Economics",
  SPE_136: "Fine Arts",
  SPE_137: "Library science",
  SPE_138: "Psychology",
  SPE_139: "Other MA degree",
  SPE_140: "Bio tech",
  SPE_141: "BZC ( Botany/ Zoology/ Chem)",
  SPE_142: "MPC ( Math/Phy/ Chem)",
  SPE_143: "Other MSc",
  SPE_144: "M. Com Regular",
  SPE_145: "M. Com Taxation",
  SPE_146: "M. Com Bank management",
  SPE_147: "M.A.F. ( accounts n finance)",
  SPE_148: "M.B.A  ( business administraion)",
  SPE_149: "M.B.M. ( Business Management)",
  SPE_150: "M.C.A. ( Comp application)",
  SPE_151: "M.F.M. ( Finance mgt)",
  SPE_152: "M.M.S. ( Mgt studies)",
  SPE_153: "PGDBM",
  SPE_154: "Other Master Program",
  SPE_155: "Other Management",
  SPE_156: "Other Technical",
  SPE_157: "Other PG",
  SPE_158: "CS Foundation",
  SPE_159: "CS Executive",
  SPE_160: "CA CPT",
  SPE_161: "CA Intermediate",
  SPE_162: "CA Articleship",
  SPE_163: "CA Final Groups",
  SPE_164: "ICWA Foundation",
  SPE_165: "ICWA Intermediate",
  SPE_166: "ICWA Final",
  SPE_167: "Other Professional courses",
  SPE_168: "JEE Main",
  SPE_169: "JEE Advance",
  SPE_170: "BITSAT",
  SPE_171: "CET",
  SPE_172: "GRE",
  SPE_173: "NATA",
  SPE_174: "NEET",
  SPE_175: "AIIMS",
  SPE_176: "MPSC",
  SPE_177: "UPSC",
  SPE_178: "Other Entrance exams",
  SPE_179: "CAT",
  SPE_180: "GMAT",
  SPE_181: "TOFFEL",
  SPE_182: "NDA",
  SPE_183: "Indian Army",
  SPE_184: "Indian Navy",
  SPE_185: "Indian Marine",
  SPE_186: "None",
  SPE_187: "BVSC : Veterinary"
};

/**
 * VERIFIED — sce_board, the school board or the awarding university.
 *
 * Source: EduCon-Code-Labels_01.xlsx, sheet "Board or University". Previously UNMAPPED
 * *and* unread: the column was never selected by any query, so this field is new to the
 * dashboard rather than merely newly decoded.
 *
 * One list, two kinds of answer, which is why the card labels it "Board / University":
 *   UNI_107 … UNI_113   school boards — SSC, HSC, CBSE, ICSE, IB, CIE, Others
 *   UNI_1   … UNI_106   universities, alphabetical, UNI_106 being "Other universities"
 *
 * UNI_93 is not in the application's list and does not appear in the data. UNI_103 is
 * stored with a leading space in the source sheet; it is trimmed here.
 *
 * 33 of these appear in educon_prod, and the distribution is the check that this is the
 * right list: UNI_85 Savitribai Phule Pune University leads with 297 rows, then UNI_60
 * Maharashtra University of Health Sciences with 178 — exactly the shape of a Pune
 * consultancy funding engineering and medicine.
 */
const BOARD = {
  UNI_1:   "Ajeenkya D.Y. Patil University",
  UNI_2:   "Aligarh Muslim University",
  UNI_3:   "All India Institute of Medical Sciences Delhi",
  UNI_4:   "Amity University",
  UNI_5:   "Amrita Vishwa Vidyapeetham",
  UNI_6:   "Anna University",
  UNI_7:   "Banaras Hindu University",
  UNI_8:   "Bharati Vidyapeeth University",
  UNI_9:   "Birla Institute of Technology and Science",
  UNI_10:  "Central Institute of Fisheries Education",
  UNI_11:  "Chandigarh University",
  UNI_12:  "Chhatrapati Shahu Ji Maharaj University",
  UNI_13:  "Christ University",
  UNI_14:  "Cochin University of Science and Technology",
  UNI_15:  "Datta Meghe Institute of Medical Sciences",
  UNI_16:  "Deccan College Post-Graduate and Research Institute",
  UNI_17:  "Dr. A.P.J. Abdul Kalam Technical",
  UNI_18:  "Dr. Babasaheb Ambedkar Marathwada University",
  UNI_19:  "Dr. Balasaheb Sawant Konkan Krishi Vidyapeeth",
  UNI_20:  "Dr. D.Y. Patil Vidyapeeth",
  UNI_21:  "Dr. Panjabrao Deshmukh Krishi Vidyapeeth",
  UNI_22:  "Dr. Vishwanath Karad MIT World Peace University",
  UNI_23:  "Flame University",
  UNI_24:  "Gandhi Institute of Technology and Management",
  UNI_25:  "Gokhale Institute of Politics and Economics",
  UNI_26:  "Gondwana University",
  UNI_27:  "Gujarat Technological University",
  UNI_28:  "Homi Bhabha National Institute",
  UNI_29:  "Indian Institute of Information Technology Allahabad",
  UNI_30:  "Indian Institute of Science",
  UNI_31:  "Indian Institute of Science Education and Research, Pune",
  UNI_32:  "Indian Institute of Technology Bombay",
  UNI_33:  "Indian Institute of Technology Delhi",
  UNI_34:  "Indian Institute of Technology Gandhinagar",
  UNI_35:  "Indian Institute of Technology Guwahati",
  UNI_36:  "Indian Institute of Technology Hyderabad",
  UNI_37:  "Indian Institute of Technology Kanpur",
  UNI_38:  "Indian Institute of Technology Kharagpur",
  UNI_39:  "Indian Institute of Technology Madras",
  UNI_40:  "Indian Institute of Technology Roorkee",
  UNI_41:  "Indian Institute of Technology, BHU",
  UNI_42:  "Indian School of Mines",
  UNI_43:  "Indian Statistical Institute",
  UNI_44:  "Indira Gandhi Institute of Development Research",
  UNI_45:  "Institute of Chemical Technology",
  UNI_46:  "International Institute for Population Sciences",
  UNI_47:  "International Institute of Information Technology, Hyderabad",
  UNI_48:  "Jadavpur University",
  UNI_49:  "Jamia Millia Islamia",
  UNI_50:  "Jawaharlal Nehru University",
  UNI_51:  "K L University",
  UNI_52:  "Kavi Kulguru Kalidas Sanskrit Vishwavidyalaya",
  UNI_53:  "Krishna Institute of Medical Sciences",
  UNI_54:  "Kurukshetra University",
  UNI_55:  "Lovely Professional University",
  UNI_56:  "M.J.P. Rohilkhand University",
  UNI_57:  "Maharashtra Animal and Fishery Sciences University",
  UNI_58:  "Maharashtra National Law University, Mumbai",
  UNI_59:  "Maharashtra National Law University, Nagpur",
  UNI_60:  "Maharashtra University of Health Sciences",
  UNI_61:  "Mahatma Gandhi Antarrashtriya Hindi Vishwavidyalaya",
  UNI_62:  "Mahatma Phule Krishi Vidyapeeth",
  UNI_63:  "Manipal Academy of Higher Education",
  UNI_64:  "MGM Institute of Health Sciences",
  UNI_65:  "MIT Art Design and Technology University",
  UNI_66:  "Motilal Nehru National Institute of Technology",
  UNI_67:  "Narsee Monjee Institute of Management and Higher Studies",
  UNI_68:  "National Institute of Design",
  UNI_69:  "National Institute of Technology, Calicut",
  UNI_70:  "National Institute of Technology, Karnataka",
  UNI_71:  "National Institute of Technology, Rourkela",
  UNI_72:  "National Institute of Technology, Tiruchirappalli",
  UNI_73:  "National Institute of Technology, Warangal",
  UNI_74:  "National University of Educational Planning and Administration",
  UNI_75:  "North Maharashtra University",
  UNI_76:  "Osmania University",
  UNI_77:  "Padmashree Dr. D.Y. Patil Vidyapeeth",
  UNI_78:  "Panjab University",
  UNI_79:  "Pondicherry University",
  UNI_80:  "Pravara Institute of Medical Sciences",
  UNI_81:  "Rajiv Gandhi Proudyogiki Vishwavidyalaya",
  UNI_82:  "Rashtrasant Tukadoji Maharaj Nagpur University",
  UNI_83:  "Sandip University",
  UNI_84:  "Sant Gadge Baba Amravati University",
  UNI_85:  "Savitribai Phule Pune University",
  UNI_86:  "Shivaji University",
  UNI_87:  "Shreemati Nathibai Damodar Thackersey Women's University",
  UNI_88:  "SRM Institute of Science and Technology",
  UNI_89:  "Swami Ramanand Teerth Marathwada University",
  UNI_90:  "Symbiosis International University",
  UNI_91:  "Tamil Nadu Agricultural University",
  UNI_92:  "Tata Institute of Fundamental Research",
  UNI_94:  "Tata Institute of Social Sciences",
  UNI_95:  "Tilak Maharashtra Vidyapeeth",
  UNI_96:  "University of Delhi",
  UNI_97:  "University of Kerala",
  UNI_98:  "University of Mumbai",
  UNI_99:  "University of Petroleum and Energy Studies",
  UNI_100: "University of Solapur",
  UNI_101: "Vasantrao Naik Marathwada Krishi Vidyapeeth",
  UNI_102: "Vishwakarma University",
  UNI_103: "Visvesvaraya National Institute of Technology",
  UNI_104: "Visvesvaraya Technological University",
  UNI_105: "VIT University",
  UNI_106: "Other universities",
  UNI_107: "SSC",
  UNI_108: "HSC",
  UNI_109: "CBSE",
  UNI_110: "ICSE",
  UNI_111: "IB",
  UNI_112: "CIE",
  UNI_113: "Others"
};

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
