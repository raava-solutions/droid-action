// The ratchet's verdict logic is what decides whether a PR lands, so it is
// unit tested the same way the domain modules are: pure input, pure output.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compareFile,
  countDisableDirectives,
  countRuleHits,
  formatTable,
  parseNameStatus,
  summarize,
} from "../lint-ratchet-shared.mjs";

const RULES = [
  "complexity",
  "max-lines-per-function",
  "@typescript-eslint/no-explicit-any",
];

// -- countRuleHits ----------------------------------------------------------

test("countRuleHits counts only the ratcheted rules", () => {
  const messages = [
    { ruleId: "complexity" },
    { ruleId: "complexity" },
    { ruleId: "prefer-const" },
    { ruleId: null },
    { ruleId: "@typescript-eslint/no-explicit-any" },
  ];
  assert.deepEqual(countRuleHits(messages, RULES), {
    complexity: 2,
    "@typescript-eslint/no-explicit-any": 1,
  });
});

test("countRuleHits tolerates a result with no messages", () => {
  assert.deepEqual(countRuleHits(undefined, RULES), {});
  assert.deepEqual(countRuleHits([], RULES), {});
});

// -- countDisableDirectives -------------------------------------------------

test("countDisableDirectives counts every directive form", () => {
  const source = [
    "/* eslint-disable */",
    "// eslint-disable-next-line complexity -- why",
    "foo(); // eslint-disable-line no-console -- why",
    "// eslint-enable",
  ].join("\n");
  assert.equal(countDisableDirectives(source), 3);
});

test("countDisableDirectives counts a rule-config comment that turns a rule off", () => {
  const source = [
    '/* eslint regexp/no-super-linear-backtracking: "off" -- why */',
    "/*eslint complexity:0*/",
    "/* eslint-env node */",
    "// eslint complexity: off (a line comment is not a directive)",
  ].join("\n");
  assert.equal(countDisableDirectives(source), 2);
});

test("countDisableDirectives does not count words that merely start the same", () => {
  assert.equal(
    countDisableDirectives("// eslint-disabled-thing\nconst x = 1;"),
    0,
  );
  assert.equal(countDisableDirectives(""), 0);
});

test("countDisableDirectives only counts directives that are actually comments", () => {
  // A string literal mentioning the directive is not a suppression, and must
  // not let someone inflate the base count to buy room for a real one.
  const source = [
    'const help = "add // eslint-disable-next-line to skip";',
    "const other = 'eslint-disable';",
    "// eslint-disable-next-line complexity -- real one",
  ].join("\n");
  assert.equal(countDisableDirectives(source), 1);
});

// -- compareFile ------------------------------------------------------------

test("a modified file passes when every rule holds steady or improves", () => {
  const result = compareFile({
    path: "lib/foo.ts",
    baseCounts: { complexity: 3, "max-lines-per-function": 1 },
    headCounts: { complexity: 3 },
  });
  assert.equal(result.failed, false);
  assert.deepEqual(result.regressions, []);
  assert.deepEqual(
    result.rows.find((row) => row.rule === "max-lines-per-function"),
    {
      path: "lib/foo.ts",
      rule: "max-lines-per-function",
      base: 1,
      head: 0,
      delta: -1,
    },
  );
});

test("a modified file fails when any single rule count goes up", () => {
  const result = compareFile({
    path: "lib/foo.ts",
    // Total is unchanged (4 -> 4): a repo-wide total would miss this.
    baseCounts: { complexity: 1, "max-lines-per-function": 3 },
    headCounts: { complexity: 2, "max-lines-per-function": 2 },
  });
  assert.equal(result.failed, true);
  assert.deepEqual(result.regressions, [
    { path: "lib/foo.ts", rule: "complexity", base: 1, head: 2, delta: 1 },
  ]);
});

test("a rule that fires in head but never fired at the base fails a modified file", () => {
  // The union of base and head rule keys must be walked, not just the base
  // keys — otherwise the first-ever violation of a rule in a file is invisible.
  const result = compareFile({
    path: "lib/foo.ts",
    baseCounts: { complexity: 2 },
    headCounts: { complexity: 2, "max-lines-per-function": 1 },
  });
  assert.equal(result.failed, true);
  assert.deepEqual(result.regressions, [
    {
      path: "lib/foo.ts",
      rule: "max-lines-per-function",
      base: 0,
      head: 1,
      delta: 1,
    },
  ]);
});

test("a renamed file is compared, not treated as added, and is labelled by its new path", () => {
  // parseNameStatus hands the runner the OLD path to read base content from and
  // the NEW path to lint and report, so a rename carries its history with it
  // instead of resetting the file's budget to zero.
  const [renamed] = parseNameStatus("R096\tlib/from.ts\tlib/to.ts");
  assert.deepEqual(renamed, {
    status: "R",
    basePath: "lib/from.ts",
    headPath: "lib/to.ts",
  });

  const result = compareFile({
    path: renamed.headPath,
    added: renamed.status === "A" || !renamed.basePath,
    baseCounts: { complexity: 3 },
    headCounts: { complexity: 3 },
  });
  assert.equal(result.added, false, "a rename must not be scored as new code");
  assert.equal(result.failed, false);
  assert.deepEqual(result.rows, [
    { path: "lib/to.ts", rule: "complexity", base: 3, head: 3, delta: 0 },
  ]);
});

test("an added file is measured against zero, so any Tier-2 warning fails it", () => {
  const clean = compareFile({
    path: "lib/new.ts",
    added: true,
    headCounts: {},
  });
  assert.equal(clean.failed, false);

  const dirty = compareFile({
    path: "lib/new.ts",
    added: true,
    // A base is ignored for added files even if one is somehow supplied.
    baseCounts: { complexity: 99 },
    headCounts: { complexity: 1 },
  });
  assert.equal(dirty.failed, true);
  assert.deepEqual(dirty.regressions, [
    { path: "lib/new.ts", rule: "complexity", base: 0, head: 1, delta: 1 },
  ]);
});

test("gaining an eslint-disable comment fails the file; removing one does not", () => {
  const gained = compareFile({
    path: "lib/foo.ts",
    baseDisables: 1,
    headDisables: 2,
  });
  assert.equal(gained.failed, true);
  assert.deepEqual(gained.regressions, [
    {
      path: "lib/foo.ts",
      rule: "eslint-disable comments",
      base: 1,
      head: 2,
      delta: 1,
    },
  ]);

  const dropped = compareFile({
    path: "lib/foo.ts",
    baseDisables: 2,
    headDisables: 1,
  });
  assert.equal(dropped.failed, false);

  const steady = compareFile({
    path: "lib/foo.ts",
    baseDisables: 2,
    headDisables: 2,
  });
  assert.equal(steady.failed, false);
  assert.equal(
    steady.rows.length,
    0,
    "an unchanged disable count is not reported",
  );
});

test("an added file carrying an eslint-disable fails", () => {
  const result = compareFile({
    path: "lib/new.ts",
    added: true,
    headDisables: 1,
  });
  assert.equal(result.failed, true);
  assert.equal(result.regressions[0].rule, "eslint-disable comments");
});

// -- summarize --------------------------------------------------------------

test("summarize fails the run if any single file regressed", () => {
  const verdict = summarize([
    compareFile({
      path: "a.ts",
      baseCounts: { complexity: 2 },
      headCounts: { complexity: 1 },
    }),
    compareFile({
      path: "b.ts",
      baseCounts: { complexity: 1 },
      headCounts: { complexity: 2 },
    }),
  ]);
  assert.equal(verdict.failed, true);
  assert.equal(verdict.filesChecked, 2);
  assert.deepEqual(
    verdict.regressions.map((row) => row.path),
    ["b.ts"],
  );
  assert.deepEqual(
    verdict.improvements.map((row) => row.path),
    ["a.ts"],
  );
});

test("summarize passes an empty run", () => {
  const verdict = summarize([]);
  assert.equal(verdict.failed, false);
  assert.equal(verdict.filesChecked, 0);
});

// -- parseNameStatus --------------------------------------------------------

test("parseNameStatus reads adds, modifies, and renames", () => {
  const output = [
    "A\tlib/new.ts",
    "M\tlib/old.ts",
    "R096\tlib/from.ts\tlib/to.ts",
    "",
  ].join("\n");
  assert.deepEqual(parseNameStatus(output), [
    { status: "A", basePath: null, headPath: "lib/new.ts" },
    { status: "M", basePath: "lib/old.ts", headPath: "lib/old.ts" },
    { status: "R", basePath: "lib/from.ts", headPath: "lib/to.ts" },
  ]);
});

// -- formatTable ------------------------------------------------------------

test("formatTable renders deterministically and signs the delta", () => {
  const table = formatTable([
    { path: "a.ts", rule: "complexity", base: 1, head: 2, delta: 1 },
  ]);
  const lines = table.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^FILE\s+RULE\s+BASE\s+HEAD\s+DELTA$/);
  assert.match(lines[2], /^a\.ts\s+complexity\s+1\s+2\s+\+1$/);
  assert.equal(formatTable([]), "");
});
