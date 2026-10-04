// raava/no-unbounded-select: a Supabase read must say how many rows it can return.
// Standard: engineering/standards/ci-quality-gates-standard.md §3 (Tier 2, opt-in).
//
// Flags `<client>.from(table)...select(...)` when nothing in the query bounds it:
//   .limit(n)  .range(a, b)  .single()  .maybeSingle()
//   .select(cols, { head: true })   (a count-only query returns no rows)
// A select after .insert/.update/.upsert/.delete returns the written rows, so
// it is not a read and is not flagged.
//
// A query kept in a variable counts as bounded when any later use of that
// variable (or of a variable assigned from it) calls a bounding method, e.g.
//   let q = db.from('t').select('*'); if (x) q = q.eq('a', x); await q.limit(50)
//
// Known limits (documented in the standard): a builder returned from a helper
// function is flagged even if the caller bounds it; a select on a variable that
// holds `db.from(t)` is not seen. The fix for a small table that is unbounded
// by design is an explicit .limit() that states the cap.

const BOUNDS = new Set(["limit", "range", "single", "maybeSingle"]);
const WRITES = new Set(["insert", "update", "upsert", "delete"]);
// Nodes that wrap a value without changing it: `x as T`, `x!`, `x satisfies T`, `a?.b()`.
const WRAPPERS = new Set([
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "ChainExpression",
]);
// How many `const b = a.eq(...)` hops to follow from the original variable.
const MAX_HOPS = 3;

function methodName(call) {
  const callee = call.type === "CallExpression" ? call.callee : null;
  if (callee?.type !== "MemberExpression" || callee.computed) return null;
  return callee.property.type === "Identifier" ? callee.property.name : null;
}

function unwrapDown(node) {
  while (WRAPPERS.has(node.type)) node = node.expression;
  return node;
}

function wrappedUp(node) {
  while (node.parent && WRAPPERS.has(node.parent.type)) node = node.parent;
  return node;
}

/** Method names called before `call` in its chain: `a.from(t).eq().select()` -> [eq, from]. */
function methodsBelow(call) {
  const names = [];
  let node = unwrapDown(call.callee.object);
  for (let name = methodName(node); name; name = methodName(node)) {
    names.push(name);
    node = unwrapDown(node.callee.object);
  }
  return names;
}

/** Method names called on `node` and on each result after it, and the outermost expression. */
function methodsAbove(node) {
  const names = [];
  let top = wrappedUp(node);
  while (top.parent?.type === "MemberExpression" && top.parent.object === top) {
    const call = top.parent.parent;
    if (call?.type !== "CallExpression" || call.callee !== top.parent) break;
    const name = methodName(call);
    if (name) names.push(name);
    top = wrappedUp(call);
  }
  return { names, top };
}

function findVariable(scope, name) {
  for (let s = scope; s; s = s.upper) {
    const found = s.set.get(name);
    if (found) return found;
  }
  return null;
}

/** The variable an expression is stored in (`const q = <expr>` or `q = <expr>`), if any. */
function storedIn(expr, sourceCode) {
  const parent = expr.parent;
  if (
    parent?.type === "VariableDeclarator" &&
    parent.init === expr &&
    parent.id.type === "Identifier"
  ) {
    return sourceCode.getDeclaredVariables(parent)[0] ?? null;
  }
  if (
    parent?.type === "AssignmentExpression" &&
    parent.right === expr &&
    parent.left.type === "Identifier"
  ) {
    return findVariable(sourceCode.getScope(parent), parent.left.name);
  }
  return null;
}

function boundedLater(variable, sourceCode, hops) {
  if (!variable || hops > MAX_HOPS) return false;
  return variable.references.some((ref) => {
    if (!ref.isRead()) return false;
    const { names, top } = methodsAbove(ref.identifier);
    if (names.some((name) => BOUNDS.has(name))) return true;
    const next = storedIn(top, sourceCode);
    return next !== variable && boundedLater(next, sourceCode, hops + 1);
  });
}

function isHeadOnly(selectCall) {
  const options = selectCall.arguments[1];
  return (
    options?.type === "ObjectExpression" &&
    options.properties.some(
      (p) =>
        p.type === "Property" &&
        !p.computed &&
        p.key.type === "Identifier" &&
        p.key.name === "head" &&
        p.value.type === "Literal" &&
        p.value.value === true,
    )
  );
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Require a row bound on Supabase .from().select() reads",
    },
    schema: [],
    messages: {
      unbounded:
        "Unbounded Supabase read: add .limit(), .range(), .single() or .maybeSingle(), " +
        "or select with { count: 'exact', head: true }.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      CallExpression(node) {
        if (methodName(node) !== "select") return;
        const below = methodsBelow(node);
        if (
          !below.includes("from") ||
          below.some((name) => WRITES.has(name) || BOUNDS.has(name))
        )
          return;
        if (isHeadOnly(node)) return;
        const { names, top } = methodsAbove(node);
        if (names.some((name) => BOUNDS.has(name))) return;
        if (boundedLater(storedIn(top, sourceCode), sourceCode, 1)) return;
        context.report({ node: node.callee.property, messageId: "unbounded" });
      },
    };
  },
};

export default {
  meta: { name: "raava" },
  rules: { "no-unbounded-select": rule },
};
