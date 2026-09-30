/**
 * EduCon Dashboard — lint baseline.
 *
 * Deliberately bug-focused, not style-focused: Prettier owns formatting, so every
 * rule here exists to catch something that can actually break at runtime. There is
 * no bundler and no module system on the frontend, so `no-undef` plus an explicit
 * globals list is the only thing that can catch a cross-file typo or a script that
 * reads a global its <script> tag order has not defined yet.
 */

const NODE_GLOBALS = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  setTimeout: 'readonly',
  setInterval: 'readonly',
  clearTimeout: 'readonly',
  clearInterval: 'readonly',
  URL: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly'
};

// Every global the frontend defines on `window`, plus the browser surface it uses.
// Add a name here when a new js/*.js file exposes one — that is the whole point.
const BROWSER_GLOBALS = {
  window: 'readonly',
  document: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  fetch: 'readonly',
  location: 'readonly',
  navigator: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  setInterval: 'readonly',
  clearTimeout: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  matchMedia: 'readonly',
  ResizeObserver: 'readonly',
  AbortController: 'readonly',
  Blob: 'readonly',
  URL: 'readonly',
  Range: 'readonly',
  getComputedStyle: 'readonly',
  Intl: 'readonly',
  addEventListener: 'readonly',
  removeEventListener: 'readonly',
  dispatchEvent: 'readonly',
  CustomEvent: 'readonly',
  Event: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  performance: 'readonly',
  innerWidth: 'readonly',
  innerHeight: 'readonly',
  scrollX: 'readonly',
  scrollY: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  HTMLElement: 'readonly',
  Node: 'readonly',
  FormData: 'readonly',
  crypto: 'readonly',
  // --- the app's own globals (see index.html script order) ---
  EduConUtil: 'writable',
  EduConBusy: 'writable',
  EduConMotion: 'writable',
  EduConFilters: 'writable',
  EduConXlsx: 'writable',
  EduConDrill: 'writable',
  EduConSummary: 'writable',
  EduConUser: 'writable',
  PIPELINE_COLUMNS: 'writable'
};

const BUG_RULES = {
  // Real-bug rules.
  'no-undef': 'error',
  'no-unused-vars': ['warn', { args: 'after-used', argsIgnorePattern: '^_' }],
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'warn',
  'no-fallthrough': 'error',
  'no-self-compare': 'error',
  'no-constant-condition': ['warn', { checkLoops: false }],
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-await-in-loop': 'warn',
  'require-atomic-updates': 'warn',
  'no-promise-executor-return': 'error',
  'no-async-promise-executor': 'error',
  'no-return-await': 'warn',

  // Correctness-adjacent hygiene.
  eqeqeq: ['error', 'smart'],
  'no-var': 'error',
  'prefer-const': 'warn',
  'no-implicit-coercion': 'off',
  'no-shadow': 'warn',
  'no-param-reassign': 'off',

  // This codebase builds HTML with template literals and escapes with esc().
  // eval/new Function would be the only true injection sinks; ban them outright.
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',

  // Size guards — these are the two metrics the audit flagged.
  'max-lines': ['warn', { max: 700, skipBlankLines: true, skipComments: true }],
  'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
  complexity: ['warn', 15]
};

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'data/**',
      '*.log',
      // Generated from EduCon-Code-Labels_01.xlsx — not hand-maintained.
      'backend/services/codeLabels.js'
    ]
  },
  {
    // ---- backend: CommonJS on Node 22+
    files: ['backend/**/*.js', 'eslint.config.js', '__tests__/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: NODE_GLOBALS
    },
    rules: BUG_RULES
  },
  {
    // ---- frontend: classic scripts, no modules, globals on window
    files: ['frontend/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: BROWSER_GLOBALS
    },
    rules: BUG_RULES
  }
];
