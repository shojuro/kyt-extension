import globals from 'globals';

/**
 * ESLint flat config for KYT Chrome Extension (MV3)
 *
 * File categories:
 *   1. Extension source (background.js, src/**, platforms/**)   — browser + chrome globals
 *   2. Popup / setup page (popup/**, setup.js)                  — browser + chrome globals
 *   3. CLI tool (cli/**)                                        — Node.js globals
 *   4. Scripts & migrations (scripts/**, migrations/**)         — Node.js globals
 *   5. Vitest test files (tests/**)                             — vitest globals
 *   6. CommonJS utilities (*.cjs)                               — Node/CommonJS
 *   7. Config files (*.config.js)                               — Node ESM
 */
export default [
  // ── Global ignores ──────────────────────────────────────────────
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'coverage/**',
      'cli/node_modules/**',
      'web-ext-artifacts/**',
      'test-results/**',
      'validation/**',
      'supabase/functions/**',

      // Root-level one-off scripts (diagnostics, generators, test harnesses)
      'debug_*.js',
      'check_*.js',
      'verify_*.js',
      'test_*.js',
      'generate_*.js',
      'phase0_*.js',
      'calibrate_*.js',
      'setup_*.js',
      'validate_*.js',
      'competitor_*.js',

      // Node.js-only modules (not part of the extension, use process.env etc.)
      'src/sync.js',        // Node.js sync module (CLI)
      'src/search.js',      // Node.js search module (CLI)
      'src/config.js',      // Node.js config loader (uses process.env)
      'src/test-*.js',      // Standalone test scripts
      'src/lib/jszip.js',   // Bundled library
      'test/**',            // Root test/ directory (not tests/)
      'cli/test_again.js',  // CLI test script

      // Files with pre-existing syntax issues (fix separately)
      'cli/src/commands/watch.js', // Stray } on line 5
    ],
  },

  // ── Default: Extension ES module source files ───────────────────
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Chrome Extension MV3 APIs
        chrome: 'readonly',
        // Service worker globals used in background.js
        globalThis: 'readonly',
        // Fetch API (available in service workers and content scripts)
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        AbortController: 'readonly',
        // Timers
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        // Console (service worker + content scripts)
        console: 'readonly',
        // Performance API
        performance: 'readonly',
        // URL API
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    rules: {
      // ── Errors: catch real bugs ──────────────────────────────────
      'no-undef': 'error',
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-debugger': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-extra-semi': 'warn',
      'no-func-assign': 'error',
      'no-inner-declarations': 'error',
      'no-irregular-whitespace': 'error',
      'no-sparse-arrays': 'error',
      'no-unexpected-multiline': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',

      // ── Warnings: code quality ───────────────────────────────────
      'no-var': 'warn',
      'prefer-const': ['warn', { destructuring: 'all' }],
      'eqeqeq': ['warn', 'smart'],
      'no-throw-literal': 'warn',
      'no-self-compare': 'warn',
      'no-template-curly-in-string': 'warn',

      // ── Off: too noisy for existing codebase ─────────────────────
      'no-console': 'off', // Console is the primary debug channel in extensions
      'no-fallthrough': 'off', // switch/case in alarm handler uses intentional fallthrough
    },
  },

  // ── Files using CJS-style module.exports in browser context ─────
  {
    files: ['src/context-injector.js'],
    languageOptions: {
      globals: {
        module: 'readonly',
      },
    },
  },

  // ── Node.js scripts: CLI, migrations, build scripts ─────────────
  {
    files: [
      'cli/**/*.js',
      'scripts/**/*.js',
      'migrations/**/*.js',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // ── Vitest test files (run in Node.js via Vitest) ────────────────
  {
    files: ['tests/**/*.js', 'tests/**/*.test.js', 'tests/**/*.spec.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        // Vitest globals (configured in vitest.config.js globals: true)
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        vi: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
      },
    },
    rules: {
      // Tests often declare vars they don't read (setup, side-effects)
      'no-unused-vars': 'off',
    },
  },

  // ── CommonJS utilities (.cjs) ───────────────────────────────────
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
  },

  // ── Config files (eslint, vitest, playwright) ───────────────────
  {
    files: ['*.config.js', '*.config.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];
