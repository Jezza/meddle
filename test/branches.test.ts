import { test, expect } from "bun:test";
import { computeBranch, planPush, refusePush, type Graph, type PushedRef } from "../src/projects/branches";
import type { BranchRow, RowRef } from "../src/pool/rows";

// The fake history: X, Y and P branch off O; Z follows X; M merges X and Y; U and V are unrelated roots.
const O = "0".repeat(40);
const X = "1".repeat(40);
const Y = "2".repeat(40);
const P = "3".repeat(40);
const Z = "4".repeat(40);
const M = "5".repeat(40);
const U = "6".repeat(40);
const V = "7".repeat(40);
const PARENTS: Record<string, string[]> = { [O]: [], [X]: [O], [Y]: [O], [P]: [O], [Z]: [X], [M]: [X, Y], [U]: [], [V]: [] };

function ancestors(commit: string): Set<string> {
  const seen = new Set<string>();
  const todo = [commit];
  while (todo.length) {
    const c = todo.pop()!;
    if (seen.has(c)) continue;
    seen.add(c);
    todo.push(...PARENTS[c]!);
  }
  return seen;
}

const g: Graph = {
  async isAncestor(a, b) { return ancestors(b).has(a); },
  async mergeBases(commits) {
    const common = commits.map(ancestors).reduce((acc, s) => new Set([...acc].filter((c) => s.has(c))));
    return [...common].filter((c) => ![...common].some((d) => d !== c && ancestors(d).has(c)));
  },
};

function row(node: string, seq: number, commit: string | null, drops: RowRef[] = []): BranchRow {
  return { project: "p", branch: "main", node, seq, commit, drops };
}

const ref = (node: string, seq: number): RowRef => ({ node, seq });
const push = (b: string, old: string | null, next: string | null): PushedRef => ({ ref: `refs/heads/${b}`, old, new: next });
const dropSibling = (commit: string): PushedRef =>
  ({ ref: `refs/heads/meddle/conflict/main/${commit.slice(0, 12)}`, old: commit, new: null });

/** The rows once `self` has written what `planPush` planned, each with its seq + 1. */
async function pushed(self: string, refs: PushedRef[], rows: BranchRow[]): Promise<BranchRow[]> {
  const planned = await planPush(self, "p", refs, rows, g);
  let next = rows;
  for (const p of planned) {
    const mine = next.find((r) => r.branch === p.branch && r.node === self);
    next = [...next.filter((r) => r !== mine), { ...p, node: self, seq: (mine?.seq ?? 0) + 1 }];
  }
  return next;
}

test("a fast-forward records the new commit, drops every current row, and the branch moves to it", async () => {
  const rows = [row("A", 1, X), row("B", 1, X)];
  expect(await planPush("A", "p", [push("main", X, Z)], rows, g))
    .toEqual([{ project: "p", branch: "main", commit: Z, drops: [ref("A", 1), ref("B", 1)] }]);
  expect(await computeBranch(await pushed("A", [push("main", X, Z)], rows), g))
    .toEqual({ kind: "single", commit: Z, live: [ref("A", 2)] });
  expect(await planPush("A", "p", [{ ref: `refs/meddle/incoming/${Z}`, old: null, new: Z }], rows, g)).toEqual([]);
});

test("concurrent pushes give two siblings, served at their merge base", async () => {
  expect(await computeBranch([row("B", 1, Y), row("A", 1, X)], g))
    .toEqual({ kind: "conflicted", siblings: [X, Y], served: O, live: [ref("B", 1), ref("A", 1)] });
});

test("a merge of the siblings resolves the branch", async () => {
  const rows = [row("A", 1, X), row("B", 1, Y)];
  expect(await refusePush([push("main", Y, M)], [{ branch: "main", commits: [X, Y] }], g)).toBeNull();
  expect(await planPush("B", "p", [push("main", Y, M)], rows, g))
    .toEqual([{ project: "p", branch: "main", commit: M, drops: [ref("A", 1), ref("B", 1)] }]);
  expect(await computeBranch(await pushed("B", [push("main", Y, M)], rows), g))
    .toEqual({ kind: "single", commit: M, live: [ref("B", 2)] });
});

test("a rewind drops every current row, the stale ancestor row included", async () => {
  const rows = [row("A", 1, X), row("B", 1, Z)];
  expect(await planPush("B", "p", [push("main", Z, O)], rows, g))
    .toEqual([{ project: "p", branch: "main", commit: O, drops: [ref("A", 1), ref("B", 1)] }]);
  expect(await computeBranch(await pushed("B", [push("main", Z, O)], rows), g))
    .toEqual({ kind: "single", commit: O, live: [ref("B", 2)] });
});

test("a deletion drops every current row, and the branch no longer exists", async () => {
  const rows = [row("A", 1, X), row("B", 2, Z)];
  expect(await planPush("A", "p", [push("main", Z, null)], rows, g))
    .toEqual([{ project: "p", branch: "main", commit: null, drops: [ref("A", 1), ref("B", 2)] }]);
  expect(await computeBranch(await pushed("A", [push("main", Z, null)], rows), g)).toEqual({ kind: "absent" });
});

test("a re-push of a dropped commit makes a fresh row that counts again", async () => {
  const rewound = [row("A", 1, X), row("B", 2, O, [ref("A", 1), ref("B", 1)])];
  expect(await computeBranch(rewound, g)).toEqual({ kind: "single", commit: O, live: [ref("B", 2)] });
  expect(await computeBranch(await pushed("A", [push("main", O, X)], rewound), g))
    .toEqual({ kind: "single", commit: X, live: [ref("A", 2)] });
});

test("dropping another node's sibling keeps your commit", async () => {
  const rows = [row("A", 1, X), row("B", 1, Y)];
  expect(await refusePush([dropSibling(Y)], [{ branch: "main", commits: [X, Y] }], g)).toBeNull();
  expect(await planPush("A", "p", [dropSibling(Y)], rows, g))
    .toEqual([{ project: "p", branch: "main", commit: X, drops: [ref("B", 1)] }]);
  expect(await computeBranch(await pushed("A", [dropSibling(Y)], rows), g))
    .toEqual({ kind: "single", commit: X, live: [ref("A", 2)] });
});

test("dropping your own sibling makes your row deleted", async () => {
  const rows = [row("A", 1, X), row("B", 1, Y)];
  expect(await planPush("A", "p", [dropSibling(X)], rows, g))
    .toEqual([{ project: "p", branch: "main", commit: null, drops: [ref("A", 1)] }]);
  expect(await computeBranch(await pushed("A", [dropSibling(X)], rows), g))
    .toEqual({ kind: "single", commit: Y, live: [ref("B", 1)] });
});

test("a reviewer node with no row drops a sibling, and its row is created deleted", async () => {
  const rows = [row("A", 1, X), row("B", 1, Y)];
  expect(await planPush("C", "p", [dropSibling(Y)], rows, g))
    .toEqual([{ project: "p", branch: "main", commit: null, drops: [ref("B", 1)] }]);
  expect(await computeBranch(await pushed("C", [dropSibling(Y)], rows), g))
    .toEqual({ kind: "single", commit: X, live: [ref("A", 1)] });
});

test("a sibling held by two rows, one of them yours, is dropped as the union of both", async () => {
  const rows = [row("A", 1, X), row("C", 1, X), row("B", 1, Y)];
  expect(await planPush("A", "p", [dropSibling(X)], rows, g))
    .toEqual([{ project: "p", branch: "main", commit: null, drops: [ref("A", 1), ref("C", 1)] }]);
  expect(await computeBranch(await pushed("A", [dropSibling(X)], rows), g))
    .toEqual({ kind: "single", commit: Y, live: [ref("B", 1)] });
});

test("your deleted row stays deleted when you drop another node's sibling", async () => {
  const rows = [row("A", 1, null), row("B", 1, X), row("C", 1, Y)];
  expect(await planPush("A", "p", [dropSibling(Y)], rows, g))
    .toEqual([{ project: "p", branch: "main", commit: null, drops: [ref("C", 1)] }]);
});

test("your row dropped by another node's rewind stays dropped when you drop a sibling", async () => {
  const rows = [row("A", 1, X), row("B", 2, Y, [ref("A", 1), ref("B", 1)]), row("C", 1, P)];
  expect(await planPush("A", "p", [dropSibling(P)], rows, g))
    .toEqual([{ project: "p", branch: "main", commit: null, drops: [ref("C", 1)] }]);
  expect(await computeBranch(await pushed("A", [dropSibling(P)], rows), g))
    .toEqual({ kind: "single", commit: Y, live: [ref("B", 2)] });
});

test("deleting a conflict ref that names no sibling records nothing", async () => {
  expect(await planPush("A", "p", [dropSibling(Z)], [row("A", 1, X), row("B", 1, Z)], g)).toEqual([]);
  expect(await planPush("A", "p", [dropSibling(U)], [row("A", 1, X), row("B", 1, Y)], g)).toEqual([]);
});

test("a dropped row stays dropped through the dropper's fast-forward, until its writer writes a higher seq", async () => {
  let rows = await pushed("A", [dropSibling(Y)], [row("A", 1, X), row("B", 3, Y)]);
  expect(rows).toEqual([row("B", 3, Y), row("A", 2, X, [ref("B", 3)])]);
  rows = await pushed("A", [push("main", X, Z)], rows);
  expect(rows).toEqual([row("B", 3, Y), row("A", 3, Z, [ref("B", 3), ref("A", 2)])]);
  expect(await computeBranch(rows, g)).toEqual({ kind: "single", commit: Z, live: [ref("A", 3)] });

  rows = [row("B", 4, Y), rows[1]!];
  expect(await computeBranch(rows, g))
    .toEqual({ kind: "conflicted", siblings: [Y, Z], served: O, live: [ref("B", 4), ref("A", 3)] });
  // B's seq 4 supersedes the drop of (B, 3), so A's next row prunes it.
  expect(await planPush("A", "p", [dropSibling(Y)], rows, g))
    .toEqual([{ project: "p", branch: "main", commit: Z, drops: [ref("B", 4)] }]);
});

test("dropping a sibling doesn't resurface the fast-forwarded rows under it", async () => {
  // B creates main at O, C and A fast-forward it to X and Z; D's concurrent P makes Z and P siblings.
  let rows = await pushed("B", [push("main", null, O)], []);
  rows = await pushed("C", [push("main", O, X)], rows);
  rows = await pushed("A", [push("main", X, Z)], rows);
  rows = [...rows, row("D", 1, P)];
  expect(await computeBranch(rows, g))
    .toEqual({ kind: "conflicted", siblings: [P, Z], served: O, live: [ref("A", 1), ref("D", 1)] });
  expect(await computeBranch(await pushed("E", [dropSibling(Z)], rows), g))
    .toEqual({ kind: "single", commit: P, live: [ref("D", 1)] });
});

test("dropping a dropper doesn't resurrect what it dropped", async () => {
  const rows = [row("B", 1, Y), row("A", 2, X, [ref("B", 1)]), row("C", 1, P)];
  expect(await computeBranch(rows, g))
    .toEqual({ kind: "conflicted", siblings: [X, P], served: O, live: [ref("A", 2), ref("C", 1)] });
  expect(await computeBranch(await pushed("C", [dropSibling(X)], rows), g))
    .toEqual({ kind: "single", commit: P, live: [ref("C", 2)] });
});

test("unrelated siblings give no served position", async () => {
  expect(await computeBranch([row("A", 1, U), row("B", 1, V)], g))
    .toEqual({ kind: "conflicted", siblings: [U, V], served: null, live: [ref("A", 1), ref("B", 1)] });
});

test("refusals: refs meddle doesn't accept, and a push onto a conflicted branch", async () => {
  const heads = [{ branch: "main", commits: [X, Y] }];
  for (const r of [
    { ref: "refs/heads/meddle", old: null, new: X },
    { ref: "refs/heads/meddle/task/t/p", old: null, new: X },
    { ref: `refs/heads/meddle/conflict/main/${X.slice(0, 12)}`, old: null, new: X },
    { ref: "refs/tags/v1", old: null, new: X },
    { ref: "refs/meddle/other", old: null, new: X },
  ]) {
    expect(await refusePush([push("next", null, X), r], heads, g)).toBe(`ref ${r.ref} is not accepted here`);
  }
  expect(await refusePush([push("main", X, Z)], heads, g)).toBe([
    "main is conflicted; push a merge of its siblings, or delete the ones you don't want",
    `  meddle/conflict/main/${X.slice(0, 12)}@meddle`,
    `  meddle/conflict/main/${Y.slice(0, 12)}@meddle`,
    "  to keep your own work: jj bookmark set main -r <your commit>",
  ].join("\n"));
  expect(await refusePush([
    push("main", X, null), dropSibling(X), { ref: `refs/meddle/incoming/${Z}`, old: null, new: Z }, push("next", null, Z),
  ], heads, g)).toBeNull();
});
