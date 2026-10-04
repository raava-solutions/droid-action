#!/usr/bin/env node
// Tier-2 lint ratchet — the deterministic half of the CI quality gate.
//
// `npm run lint` fails on Tier-1 (error) rules only. Tier-2 rules (cyclomatic
// complexity, cognitive complexity, file/function length, `any`) are warnings,
// because the existing tree violates them 480+ times. This script makes them
// enforceable anyway: it diffs the touched files against the merge base and
// fails the build if a change makes any touched file WORSE.
//
// Properties that matter:
//   * No baseline file. Nothing to regenerate, nothing to forge, no merge
//     conflicts. The base is always the merge base of the target branch.
//   * Per (file, rule) comparison, not a repo total — so you cannot offset a
//     new 400-line component by deleting warnings somewhere else.
//   * Added files are compared against zero, so new code is strictly clean.
//   * Counting is per-file, so splitting one bad function across two files
//     still shows up: both files are "added" or "modified" and both are checked.
//   * Deterministic: same tree in, same output out. No network, no clock, no
//     randomness, no cache.
//   * A threshold change cannot launder a regression. If the change edits
//     eslint.config.mjs, BOTH sides are measured with the BASE config, so
//     loosening a limit buys nothing in the same PR. (Measuring only the base
//     side with the base config would NOT close this: the head side would still
//     be under-counted at the looser limit.) This fails closed: if the config
//     changed and the base config cannot be loaded, the run exits 2 rather than
//     falling back to the head config. Editing the config also needs a
//     code-owner review — see .github/CODEOWNERS.
//
// Usage:
//   node scripts/ci/lint-ratchet.mjs            compare against RATCHET_BASE
//   node scripts/ci/lint-ratchet.mjs --report   print repo-wide Tier-2 totals
//
// Env:
//   RATCHET_BASE   git ref to compare against (default: origin/main; a repo whose
//                  integration branch is elsewhere, e.g. crewops/staging, sets
//                  this or changes the default below)

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ESLint } from "eslint";

import { TIER_2_RULES } from "../../eslint.config.mjs";
import {
  compareFile,
  countDisableDirectives,
  countRuleHits,
  formatTable,
  parseNameStatus,
  summarize,
} from "./lint-ratchet-shared.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const CONFIG_NAME = "eslint.config.mjs";
const CONFIG_FILE = path.join(REPO_ROOT, CONFIG_NAME);
// The base config is materialised next to the real one so its bare plugin
// imports ('eslint-plugin-sonarjs', ...) resolve against the repo's
// node_modules. eslint.config.mjs ignores this path; the run always deletes it.
const BASE_CONFIG_FILE = path.join(REPO_ROOT, ".lint-ratchet-base.config.mjs");
const LINTED_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js", ".cjs"]);
const DIFF_PATHSPECS = ["*.ts", "*.tsx", "*.mjs", "*.js", "*.cjs"];

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      // An expected miss (a path that does not exist at the base) is normal
      // control flow here, so keep git's complaint out of the CI log.
      stdio: allowFailure
        ? ["ignore", "pipe", "ignore"]
        : ["ignore", "pipe", "inherit"],
    });
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function resolveMergeBase(baseRef) {
  const merged = git(["merge-base", baseRef, "HEAD"], { allowFailure: true });
  if (merged) return merged.trim();
  // Shallow clones or a push event whose `before` SHA is already an ancestor:
  // fall back to the ref itself so the gate still runs rather than passing
  // vacuously.
  const resolved = git(["rev-parse", "--verify", `${baseRef}^{commit}`], {
    allowFailure: true,
  });
  return resolved ? resolved.trim() : null;
}

function changedFiles(mergeBase) {
  // Compared against the WORKING TREE (no `HEAD` argument), so a local run sees
  // uncommitted edits. In CI the working tree equals HEAD, so this is identical
  // to a HEAD..base diff there.
  const output = git([
    "diff",
    "--name-status",
    "--diff-filter=ACMR",
    mergeBase,
    "--",
    ...DIFF_PATHSPECS,
  ]);
  const files = parseNameStatus(output ?? "");
  // `git diff` never lists an untracked file, so a brand-new file that has not
  // been `git add`ed would be invisible to a local run and the gate would pass
  // vacuously. Treat every untracked, non-ignored file as added. In CI the
  // tree is fully committed, so this adds nothing there. (Template addition
  // over the crewops original; see engineering/standards/templates/ci-gates/README.md.)
  const untracked = git([
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    ...DIFF_PATHSPECS,
  ]);
  for (const line of (untracked ?? "").split("\n")) {
    const headPath = line.trim();
    if (headPath) files.push({ status: "A", basePath: null, headPath });
  }
  return files.filter((file) =>
    LINTED_EXTENSIONS.has(path.extname(file.headPath)),
  );
}

function showAtRev(rev, filePath) {
  return git(["show", `${rev}:${filePath}`], { allowFailure: true });
}

function createLinter(configFile = CONFIG_FILE) {
  return new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: configFile,
    // A cache would make the run depend on prior state; the ratchet must be a
    // pure function of the tree.
    cache: false,
  });
}

// Set only when THIS run materialised the base config, so the cleanup in
// main() can never delete a file the run deliberately refused to touch.
let wroteBaseConfig = false;

function headConfigMeasurement(reason) {
  if (reason) console.log(`lint-ratchet: ${reason}`);
  return { linter: createLinter(), rules: TIER_2_RULES };
}

/**
 * Pick the config BOTH sides are measured with.
 *
 * Normally that is the working-tree config. When the change edits the config
 * itself, it is the config as it stood at the merge base — so a same-PR
 * threshold bump cannot hide a regression behind its own looser limit.
 *
 * The ONLY fallback to the head config is "the base has no config yet" (the
 * change that introduces it). Everything else fails closed: if the change edits
 * the config and we cannot measure with the base config, falling back to the
 * head config would quietly restore the exact hole this defends, and a
 * malformed base config is easy to arrange on purpose.
 *
 * @throws {Error} on any condition that must fail the run.
 */
async function resolveMeasuringConfig(mergeBase, files) {
  if (!files.some((file) => file.headPath === CONFIG_NAME)) {
    return headConfigMeasurement();
  }

  const baseConfigSource = showAtRev(mergeBase, CONFIG_NAME);
  if (baseConfigSource == null) {
    return headConfigMeasurement(
      `${CONFIG_NAME} is new at this base; measuring with the head config.`,
    );
  }

  // Never clobber: an existing file here is a stale temp from a killed run, or
  // something checked in to pre-empt this write. Either way, do not overwrite
  // it and do not read it as if we had written it.
  if (existsSync(BASE_CONFIG_FILE)) {
    throw new Error(
      `${path.basename(BASE_CONFIG_FILE)} already exists. The ratchet writes and ` +
        "deletes that path itself, so refusing to overwrite it. Delete it and re-run.",
    );
  }

  writeFileSync(BASE_CONFIG_FILE, baseConfigSource);
  wroteBaseConfig = true;
  let baseModule;
  try {
    baseModule = await import(pathToFileURL(BASE_CONFIG_FILE).href);
  } catch (error) {
    throw new Error(
      `${CONFIG_NAME} changed, but the base version could not be loaded: ${error.message}\n` +
        "Refusing to measure with the head config — that is the hole this check closes.\n" +
        "Fix the base config, or rebase onto a commit whose config loads.",
    );
  }

  console.log(
    `lint-ratchet: ${CONFIG_NAME} changed — measuring BOTH sides with the BASE` +
      " config, so a threshold change cannot launder a regression.",
  );
  return {
    linter: createLinter(BASE_CONFIG_FILE),
    rules: baseModule.TIER_2_RULES ?? TIER_2_RULES,
  };
}

async function lintSource(linter, source, absolutePath) {
  const results = await linter.lintText(source, { filePath: absolutePath });
  return results[0]?.messages ?? [];
}

async function report(linter) {
  const results = await linter.lintFiles(["."]);
  /** @type {Record<string, number>} */
  const totals = {};
  for (const result of results) {
    for (const [rule, count] of Object.entries(
      countRuleHits(result.messages, TIER_2_RULES),
    )) {
      totals[rule] = (totals[rule] ?? 0) + count;
    }
  }
  const width = Math.max(...TIER_2_RULES.map((rule) => rule.length));
  console.log(
    "Tier-2 totals across the repo (warnings; the ratchet gates the delta):\n",
  );
  let sum = 0;
  for (const rule of TIER_2_RULES) {
    const count = totals[rule] ?? 0;
    sum += count;
    console.log(`  ${rule.padEnd(width)}  ${String(count).padStart(5)}`);
  }
  console.log(`  ${"TOTAL".padEnd(width)}  ${String(sum).padStart(5)}`);
}

/**
 * Measure the merge-base version of a file, or an all-zero base for new files.
 * The base content is linted through `lintText` under the file's REAL repo path
 * so the config's per-path overrides and the TS parser resolve exactly as they
 * do for the head version.
 */
async function measureBase({ linter, rules }, mergeBase, file, absolutePath) {
  if (file.status === "A" || !file.basePath) {
    return { counts: {}, disables: 0 };
  }
  // Renames and copies read the base content from the OLD path.
  const baseSource = showAtRev(mergeBase, file.basePath);
  if (baseSource == null) {
    // The path did not exist at the base after all: treat it as added.
    return { counts: {}, disables: 0 };
  }
  const messages = await lintSource(linter, baseSource, absolutePath);
  return {
    counts: countRuleHits(messages, rules),
    disables: countDisableDirectives(baseSource),
  };
}

/** Compare one changed file, or null when the file is outside the lint scope. */
async function ratchetFile(measuring, mergeBase, file) {
  const absolutePath = path.join(REPO_ROOT, file.headPath);
  if (await measuring.linter.isPathIgnored(absolutePath)) return null;

  const [headResult] = await measuring.linter.lintFiles([absolutePath]);
  if (!headResult) return null;

  const headSource = readFileSync(absolutePath, "utf8");
  const base = await measureBase(measuring, mergeBase, file, absolutePath);

  return compareFile({
    path: file.headPath,
    added: file.status === "A" || !file.basePath,
    baseCounts: base.counts,
    headCounts: countRuleHits(headResult.messages, measuring.rules),
    baseDisables: base.disables,
    headDisables: countDisableDirectives(headSource),
  });
}

async function ratchet() {
  const baseRef = process.env.RATCHET_BASE || "origin/main";
  const mergeBase = resolveMergeBase(baseRef);
  if (!mergeBase) {
    console.error(
      `lint-ratchet: cannot resolve base ref "${baseRef}".\n` +
        "Fetch it first (CI uses actions/checkout with fetch-depth: 0), or set RATCHET_BASE.",
    );
    return 2;
  }

  console.log(`lint-ratchet: base ${baseRef} (${mergeBase.slice(0, 12)})`);
  const files = changedFiles(mergeBase);
  if (files.length === 0) {
    console.log("lint-ratchet: no changed source files — nothing to ratchet.");
    return 0;
  }

  let measuring;
  try {
    measuring = await resolveMeasuringConfig(mergeBase, files);
  } catch (error) {
    console.error(`lint-ratchet: ${error.message}`);
    return 2;
  }

  const results = [];
  for (const file of files) {
    const result = await ratchetFile(measuring, mergeBase, file);
    if (result) results.push(result);
  }

  const verdict = summarize(results);
  console.log(`lint-ratchet: checked ${verdict.filesChecked} changed file(s).`);

  if (verdict.improvements.length > 0) {
    console.log("\nImproved:");
    console.log(formatTable(verdict.improvements));
  }

  if (!verdict.failed) {
    console.log(
      "\nlint-ratchet: PASS — no Tier-2 regressions in the touched files.",
    );
    return 0;
  }

  console.error(
    "\nlint-ratchet: FAIL — these changes make touched files worse:\n",
  );
  console.error(formatTable(verdict.regressions));
  console.error(
    "\nThe fix is to refactor the function or file you touched, not to suppress the rule:\n" +
      "  complexity / sonarjs/cognitive-complexity  extract the branchy part into a named helper\n" +
      "  max-lines-per-function                     split the component or handler\n" +
      "  max-lines                                  split the module\n" +
      "  @typescript-eslint/no-explicit-any         write the type\n" +
      "\nInline eslint-disable of these rules is blocked by eslint-comments/no-restricted-disable.\n" +
      "Thresholds live in eslint.config.mjs and can only change in a reviewed PR.\n" +
      "See engineering/standards/ci-quality-gates-standard.md.",
  );
  return 1;
}

async function main() {
  const wantsReport =
    process.argv.includes("--report") ||
    process.env.npm_config_report === "true";
  if (wantsReport) {
    await report(createLinter());
    return 0;
  }
  try {
    return await ratchet();
  } finally {
    if (wroteBaseConfig) rmSync(BASE_CONFIG_FILE, { force: true });
  }
}

process.exitCode = await main();
