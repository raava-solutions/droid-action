// ESLint configuration — Raava CI quality gates standard.
// Template: engineering/standards/templates/ci-gates/eslint.config.mjs
// Standard: engineering/standards/ci-quality-gates-standard.md
//
// Two tiers, expressed purely as rule severity:
//
//   TIER 1 (error)  Hard gate. `npm run lint` fails the build. These rules must
//                   be green across the repo from the day the gate is installed.
//   TIER 2 (warn)   Complexity / size / type-escape-hatch debt. Reported but
//                   non-fatal, because an existing tree may violate them. The
//                   deterministic gate for these is the diff-based ratchet
//                   (`npm run lint:ratchet`), which fails any change that makes
//                   a touched file worse. New files must be clean.
//
// The only sanctioned way to relax a Tier-2 threshold is editing this file in a
// reviewed PR (it is CODEOWNERS-protected). Inline `eslint-disable` of a
// complexity/size rule is blocked by eslint-comments/no-restricted-disable below.
// When this file changes, the ratchet measures BOTH sides of the diff with the
// BASE version of it, so a same-PR threshold bump cannot hide a regression.

import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import jest from "eslint-plugin-jest";
import regexp from "eslint-plugin-regexp";

import raava from "./scripts/ci/eslint-rules/no-unbounded-select.mjs";

// REPO-SPECIFIC: `true` in repos that read from Supabase (`@supabase/supabase-js`).
// Turns on raava/no-unbounded-select (Tier 2): every `.from(t).select()` read
// needs .limit/.range/.single/.maybeSingle or a head-only count.
const SUPABASE = false;

// NEXT.JS / REACT REPOS: replace the `tseslint.configs.recommended` spread
// below with the Next presets, which already include typescript-eslint:
//
//   import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
//   import nextTypescript from 'eslint-config-next/typescript'
//   ...
//   ...nextCoreWebVitals,
//   ...nextTypescript,
//
// and add `'react/no-unescaped-entities': 'error'` to Tier 1. See
// products/crewops/eslint.config.mjs for a complete conforming instance.

/**
 * Rules that make up TIER 2. The ratchet imports this list, so this file stays
 * the single source of truth for which rules are ratcheted.
 */
export const TIER_2_RULES = [
  "complexity",
  "sonarjs/cognitive-complexity",
  "max-lines",
  "max-lines-per-function",
  "@typescript-eslint/no-explicit-any",
  // Test quality (v2, ADR-0003). Ratcheted because existing suites violate them.
  "jest/expect-expect",
  "jest/no-disabled-tests",
  "jest/no-restricted-matchers",
  // Work inside loops (v3). An await per iteration serialises I/O; use
  // Promise.all over the items, or one batched query.
  "no-await-in-loop",
  // A regex that is slow (quadratic) when a search slides along a long input.
  // Tier 2, not Tier 1: most hits are on trusted input, and it is noisier than
  // no-super-linear-backtracking (12 hits in products/crewops, 6 in tests).
  "regexp/no-super-linear-move",
  // Supabase repos only (SUPABASE above); counts zero elsewhere.
  "raava/no-unbounded-select",
];

/** Rules that may never be silenced with an inline eslint-disable comment. */
const NON_DISABLEABLE_RULES = [
  "complexity",
  "sonarjs/cognitive-complexity",
  "max-lines",
  "max-lines-per-function",
  "max-depth",
  "max-params",
  "max-nested-callbacks",
  "@typescript-eslint/no-explicit-any",
  "jest/expect-expect",
  // ReDoS: a catastrophic-backtracking regex is a denial-of-service bug.
  // Rewrite the regex; there is no safe way to keep it.
  "regexp/no-super-linear-backtracking",
];

// Test files, whatever the runner. eslint-plugin-jest's rules work for
// node:test, vitest, and jest: `settings.jest.globalPackage` names the module
// the test functions are imported from.
const TEST_FILES = [
  "**/__tests__/**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}",
  "**/*.{test,spec}.{js,mjs,cjs,jsx,ts,mts,cts,tsx}",
];

// A call to any of these counts as an assertion. Helpers must be named
// `assert*` or `expect*` to count, which is also what makes them readable.
const ASSERTION_NAMES = [
  "expect",
  "expect*",
  "assert",
  "assert*",
  "assert.**",
  "*.assert.**",
  "**.expect",
];

const config = [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "build/**",
      "out/**",
      "coverage/**",
      ".wrangler/**",
      ".next/**",
      ".vercel/**",
      // Written and deleted by scripts/ci/lint-ratchet.mjs within a single run.
      ".lint-ratchet-base.config.mjs",
      // Written and deleted by scripts/ci/mutation.mjs; Stryker's sandbox and report.
      ".stryker-ratchet-base.config.mjs",
      ".stryker-tmp/**",
      "reports/**",
      // REPO-SPECIFIC: generated files that are never hand-edited, e.g.
      //   'lib/supabase/types.generated.ts',
      //   'worker-configuration.d.ts',
      // Do NOT blanket-ignore vendored UI directories (components/ui/**): a
      // blanket ignore is a hole that lets anything placed there escape Tier 1.
    ],
  },

  ...tseslint.configs.recommended,

  {
    name: "raava/plugins",
    plugins: {
      sonarjs,
      "eslint-comments": eslintComments,
      regexp,
      raava,
    },
  },

  {
    name: "raava/tier-1",
    // Core flat-config directive reporting. `eslint-comments/no-unused-disable`
    // is a no-op under eslint 9 flat config — this is the setting that actually
    // makes a suppression that suppresses nothing an error, so stale
    // suppressions cannot accumulate.
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      // --- structural limits ---
      "max-depth": ["error", 4],
      "max-params": ["error", 5],
      "max-nested-callbacks": ["error", 3],

      // --- correctness / hygiene ---
      "prefer-const": "error",
      "no-var": "error",
      "@typescript-eslint/no-empty-object-type": "error",
      // --- ReDoS (v3): a regex that can take exponential or polynomial time
      // on one crafted input. eslint-plugin-regexp checks every regex literal
      // and `RegExp('...')` with a constant pattern.
      "regexp/no-super-linear-backtracking": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // --- the disable-comment gate: the escape hatches are themselves gated ---
      // (stale directives are handled by linterOptions above, not by a rule)
      // Every disable must say why.
      "eslint-comments/require-description": ["error", { ignore: [] }],
      // Complexity and size rules can never be disabled inline. The only lever
      // is this config file, changed in a reviewed PR.
      "eslint-comments/no-restricted-disable": [
        "error",
        ...NON_DISABLEABLE_RULES,
      ],
      // `/* eslint-disable */` with no rule list silences everything.
      "eslint-comments/no-unlimited-disable": "error",
      "eslint-comments/no-duplicate-disable": "error",
      "eslint-comments/no-aggregating-enable": "error",
    },
  },

  {
    name: "raava/tier-2",
    rules: {
      complexity: ["warn", 15],
      "sonarjs/cognitive-complexity": ["warn", 15],
      "max-lines": [
        "warn",
        { max: 400, skipBlankLines: true, skipComments: true },
      ],
      "max-lines-per-function": [
        "warn",
        { max: 80, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-await-in-loop": "warn",
      "regexp/no-super-linear-move": "warn",
      ...(SUPABASE ? { "raava/no-unbounded-select": "warn" } : {}),
    },
  },

  {
    name: "raava/tests",
    files: TEST_FILES,
    plugins: { jest },
    settings: {
      // REPO-SPECIFIC: 'node:test' (default), 'vitest', or '@jest/globals'.
      jest: { globalPackage: "node:test" },
    },
    rules: {
      // Tier 1: a focused test silently skips the rest of the suite; two tests
      // with one title are one test too many; an expect() without a matcher
      // asserts nothing.
      "jest/no-focused-tests": "error",
      "jest/no-identical-title": "error",
      "jest/valid-expect": "error",
      // Tier 2 (ratcheted): every test asserts; no skipped tests (a skipped test
      // is dead code: fix it or delete it); no external snapshots (a snapshot
      // nobody reads is not an assertion). Inline snapshots stay reviewable.
      "jest/expect-expect": ["warn", { assertFunctionNames: ASSERTION_NAMES }],
      "jest/no-disabled-tests": "warn",
      "jest/no-restricted-matchers": [
        "warn",
        {
          toMatchSnapshot:
            "Assert the values that matter, or use toMatchInlineSnapshot.",
          toThrowErrorMatchingSnapshot:
            "Assert the error, or use toThrowErrorMatchingInlineSnapshot.",
        },
      ],
    },
  },

  {
    // Plain-JS modules: no TS-only rules. NOTE: this does NOT relax the size
    // or complexity budget — production `.mjs` is held to the same limits as
    // the .ts tree.
    name: "raava/plain-js",
    files: ["**/*.mjs", "**/*.js", "**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },

  {
    // Tests and build/CI scripts only. Test bodies and one-shot scripts are
    // long and wide by nature; the size and parameter budgets exist to keep
    // product code readable. Test fixtures also legitimately mirror wide
    // constructor signatures. Tests and scripts often await in order on
    // purpose (one step, then check), so no-await-in-loop is off here too, and
    // their regexes read trusted input, so no-super-linear-move is off.
    name: "raava/tests-and-ci-scripts",
    files: ["**/__tests__/**", "**/*.test.*", "scripts/**"],
    rules: {
      "max-lines-per-function": "off",
      "max-lines": "off",
      "max-params": "off",
      "no-await-in-loop": "off",
      "regexp/no-super-linear-move": "off",
    },
  },
];

export default config;
