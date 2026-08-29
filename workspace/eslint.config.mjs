/**
 * Lint, alongside the type checker rather than instead of it.
 *
 * `tsc -b` already proves a great deal: strict null handling, exact optional
 * properties, unchecked index access, unused locals. Repeating any of that here
 * would be noise. So this configuration deliberately covers only what a type
 * checker cannot see — the shapes that compile perfectly and are still wrong.
 *
 * Four categories, and each one exists because of a specific failure this
 * product would rather not have:
 *
 * **Floating promises and misused awaits.** An unawaited `submitObservation`
 * or `child.stop()` produces a test that passes and a process that leaks. The
 * type checker is entirely happy with both.
 *
 * **Unsafe assertions.** `as any` and non-null assertions are how a contract
 * gets bypassed at exactly the boundary the contract exists to guard. They are
 * errors here, not warnings, because a warning in a codebase this size is a
 * thing nobody reads.
 *
 * **Accidental truthiness.** `if (evidence.text)` treats an empty reading and
 * a missing reading identically, and in an evidence product those are
 * different facts. Strict boolean expressions makes that a compile-time
 * conversation rather than a bug report.
 *
 * **House rules with their own gate.** A hex colour in a feature package
 * defeats the theming the brand package exists to provide, and a `console.log`
 * in a library is output nobody asked for. Both are checked as lint rules
 * because both are one-line mistakes that reviewers miss.
 *
 * Type-aware linting needs the projects, so this runs the same
 * `tsconfig.json` references the build does.
 */

import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // Build output, dependencies and the upstream checkout are not ours.
    ignores: [
      '**/lib/**',
      '**/node_modules/**',
      'upstream/**',
      '**/*.d.ts',
      'apps/desktop/renderer/**',
      'apps/desktop/*.cjs',
      // Bundler configuration, outside every tsconfig by design: it imports a
      // .mjs build helper and belongs to the build rather than to the product.
      '**/tsdown.config.ts',
    ],
  },

  // ── TypeScript sources, with type information ─────────────────────────────
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── what the type checker already covers ────────────────────────────
      // Turned off rather than left on: duplicated diagnostics train people to
      // skim, and skimming is how the ones that matter get missed.
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],

      // ── the ones that compile and are still wrong ───────────────────────
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',

      // An empty string and a missing string are different facts here.
      '@typescript-eslint/strict-boolean-expressions': ['error', {
        allowString: false,
        allowNumber: false,
        allowNullableObject: false,
      }],

      // ── relaxations, each with a reason ─────────────────────────────────
      // The contracts are shaped by what Watch Core sends, and several unions
      // are genuinely wide. `strictTypeChecked` reads some of those as
      // redundant conditions when they are defensive parsing of a wire value.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // Template literals of numbers are explicit `String(...)` calls here by
      // house style; the rule would rather they were not templates at all.
      '@typescript-eslint/restrict-template-expressions': 'off',
      // Several modules intentionally hold a union of literal types wider than
      // one branch uses, for exhaustiveness at the call site.
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',

      // ── house rules ──────────────────────────────────────────────────────
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
      // A promise nobody handles in a supervisor is a process nobody stops.
      'no-return-await': 'off',
    },
  },

  // ── the browser halves ────────────────────────────────────────────────────
  {
    files: ['**/src/client/**/*.tsx', '**/src/client/**/*.ts'],
    rules: {
      // A colour written out in a feature package is a colour a theme change
      // misses. Tones come from the brand package's semantic tokens.
      'no-restricted-syntax': ['error', {
        selector: "Literal[value=/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/]",
        message:
          'No hex colours in a feature package. Use tokenFor(toneFor(status)) or a '
          + '--watch-* custom property, so a theme change reaches this too.',
      }],
    },
  },

  // ── build and gate scripts ────────────────────────────────────────────────
  {
    files: ['scripts/**/*.mjs', 'eslint.config.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      // The Node globals these gates legitimately use. Enumerated rather than
      // pulled from a globals package: the list is short, and a gate that
      // reaches for something not on it should have to say so.
      globals: {
        process: 'readonly', console: 'readonly', Buffer: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', URL: 'readonly', TextEncoder: 'readonly',
        fetch: 'readonly', AbortSignal: 'readonly',
      },
    },
    rules: {
      // A gate that cannot print is a gate nobody can read the output of.
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
)
