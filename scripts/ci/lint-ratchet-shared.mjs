// Pure comparison logic for the Tier-2 lint ratchet.
//
// No I/O, no git, no ESLint: everything here takes plain data and returns plain
// data, so it is unit-testable under `node --test` (see ./__tests__).
//
// The ratchet's contract: for every file a change touches, no Tier-2 rule may
// report MORE than it did at the merge base, and the file may not gain new
// suppression comments. Added files start from an implicit all-zero base, so
// "no new Tier-2 warnings in new code" falls out of the same comparison.
//
// (Note the phrasing above: the suppression counter is deliberately a blunt
// text scan, so a comment line that *begins* with the directive word would be
// counted as one. Symmetric on both sides of the diff, but worth knowing.)

// Matches an ESLint directive that suppresses a rule, with its comment opener.
// Requiring the opener keeps identifiers like `eslintDisableCount` out of the
// count; blanking string literals first (below) keeps a directive quoted inside
// a string out of it too, so nobody can inflate the base count to buy room for
// a real suppression. The second branch counts a rule-config comment,
// `/* eslint some-rule: "off" */`: it switches a rule off for the whole file
// (Tier 1 included), and eslint-comments/no-restricted-disable does not see it.
const DISABLE_DIRECTIVE =
  /(?:\/\/|\/\*)[ \t]*eslint-disable(?:-next-line|-line)?(?![\w-])|\/\*[ \t]*eslint\s+[@\w/-]+[ \t]*:/g;

// Single- and double-quoted strings cannot span lines, so an apostrophe in
// prose ("don't") cannot swallow the rest of the file. Template literals can.
const STRING_LITERAL =
  /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g;

/**
 * Count eslint-disable directives in a source string.
 *
 * @param {string} source
 * @returns {number}
 */
export function countDisableDirectives(source) {
  if (!source) return 0;
  const matches = source.replace(STRING_LITERAL, '""').match(DISABLE_DIRECTIVE);
  return matches ? matches.length : 0;
}

/**
 * Reduce ESLint messages to per-rule counts, keeping only the ratcheted rules.
 *
 * @param {Array<{ ruleId: string | null }>} messages
 * @param {readonly string[]} ratchetedRules
 * @returns {Record<string, number>}
 */
export function countRuleHits(messages, ratchetedRules) {
  const wanted = new Set(ratchetedRules);
  /** @type {Record<string, number>} */
  const counts = {};
  for (const message of messages ?? []) {
    if (!message.ruleId || !wanted.has(message.ruleId)) continue;
    counts[message.ruleId] = (counts[message.ruleId] ?? 0) + 1;
  }
  return counts;
}

/**
 * Compare one file's base and head counts.
 *
 * `added` files are compared against an all-zero base, which is what makes new
 * code strictly clean rather than merely "no worse".
 *
 * @param {{
 *   path: string,
 *   added?: boolean,
 *   baseCounts?: Record<string, number>,
 *   headCounts?: Record<string, number>,
 *   baseDisables?: number,
 *   headDisables?: number,
 * }} input
 * @returns {{
 *   path: string,
 *   added: boolean,
 *   rows: Array<{ path: string, rule: string, base: number, head: number, delta: number }>,
 *   regressions: Array<{ path: string, rule: string, base: number, head: number, delta: number }>,
 *   failed: boolean,
 * }}
 */
export function compareFile({
  path,
  added = false,
  baseCounts = {},
  headCounts = {},
  baseDisables = 0,
  headDisables = 0,
}) {
  const effectiveBase = added ? {} : baseCounts;
  const rules = [
    ...new Set([...Object.keys(effectiveBase), ...Object.keys(headCounts)]),
  ].sort();

  const rows = rules.map((rule) => {
    const base = effectiveBase[rule] ?? 0;
    const head = headCounts[rule] ?? 0;
    return { path, rule, base, head, delta: head - base };
  });

  const disableBase = added ? 0 : baseDisables;
  if (disableBase !== headDisables) {
    rows.push({
      path,
      rule: "eslint-disable comments",
      base: disableBase,
      head: headDisables,
      delta: headDisables - disableBase,
    });
  }

  const regressions = rows.filter((row) => row.delta > 0);
  return { path, added, rows, regressions, failed: regressions.length > 0 };
}

/**
 * Roll per-file comparisons into a verdict.
 *
 * @param {Array<ReturnType<typeof compareFile>>} fileResults
 */
export function summarize(fileResults) {
  const regressions = fileResults.flatMap((result) => result.regressions);
  const improvements = fileResults
    .flatMap((result) => result.rows)
    .filter((row) => row.delta < 0);
  return {
    failed: regressions.length > 0,
    filesChecked: fileResults.length,
    regressions,
    improvements,
  };
}

/**
 * Render rows as a fixed-width table. Deterministic: rows are printed in the
 * order given, columns sized to content.
 *
 * @param {Array<{ path: string, rule: string, base: number, head: number, delta: number }>} rows
 * @returns {string}
 */
export function formatTable(rows) {
  if (rows.length === 0) return "";
  const header = ["FILE", "RULE", "BASE", "HEAD", "DELTA"];
  const body = rows.map((row) => [
    row.path,
    row.rule,
    String(row.base),
    String(row.head),
    (row.delta > 0 ? "+" : "") + String(row.delta),
  ]);
  const widths = header.map((_, column) =>
    Math.max(
      header[column].length,
      ...body.map((cells) => cells[column].length),
    ),
  );
  const line = (cells) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column]))
      .join("  ")
      .trimEnd();
  return [
    line(header),
    line(widths.map((width) => "-".repeat(width))),
    ...body.map(line),
  ].join("\n");
}

/**
 * Parse `git diff --name-status --diff-filter=ACMR` output into the file list
 * the ratchet walks. Renames/copies carry both the old path (where the base
 * content lives) and the new path (where the head content lives).
 *
 * @param {string} nameStatusOutput
 * @returns {Array<{ status: string, basePath: string | null, headPath: string }>}
 */
export function parseNameStatus(nameStatusOutput) {
  const files = [];
  for (const rawLine of nameStatusOutput.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split("\t");
    const status = parts[0][0];
    if (status === "R" || status === "C") {
      files.push({ status, basePath: parts[1], headPath: parts[2] });
    } else {
      files.push({
        status,
        basePath: status === "A" ? null : parts[1],
        headPath: parts[1],
      });
    }
  }
  return files;
}
