// test/advance.test.ts — `advanceBranch`: a node moves a branch as a checkout's push would, through the same checks.
import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { git } from "../src/jj";
import { shortId } from "../src/pool/ids";
import { listBranchRows, mergeBranchRows, settleBranchRows, writeBranchRow } from "../src/pool/rows";
import { advanceBranch } from "../src/projects/advance";
import { applyProject } from "../src/projects/applier";
import { conflictFix } from "../src/projects/branches";
import { startPoolNode, type GitPoolNode } from "./pool-helpers";

const nodes: GitPoolNode[] = [];
afterEach(async () => {
  for (const n of nodes.splice(0)) {
    await n.close();
    n.db.close();
    await rm(n.home, { recursive: true, force: true });
  }
});

/** A new commit on top of `parent` in `repo`, with the parent's tree: made by git alone, so no jj ref names it. */
async function commitOn(n: GitPoolNode, parent: string, message: string): Promise<string> {
  const out = await git(
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit-tree", `${parent}^{tree}`, "-p", parent, "-m", message],
    n.project.replica, n.cfg,
  );
  return out.trim();
}

/** A new commit with `parent`'s tree and no parent: it shares no history with `parent`. */
async function rootLike(n: GitPoolNode, parent: string, message: string): Promise<string> {
  const out = await git(
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit-tree", `${parent}^{tree}`, "-m", message], n.project.replica, n.cfg,
  );
  return out.trim();
}

/** A node whose project has `main` at `B`, applied (its view shows it there), and `C`, a commit on `B`. */
async function started(inputHold?: () => string | null) {
  const n = await startPoolNode(undefined, {}, inputHold === undefined ? {} : { inputHold });
  nodes.push(n);
  const P = n.project.id;
  const B = listBranchRows(n.db, P, "main").find((r) => r.node === n.id)?.commit;
  if (B == null) throw new Error("no main row");
  await applyProject(replicaDeps(n), P);
  const C = await commitOn(n, B, "c");
  const deps = { ...replicaDeps(n), selfId: n.id, ...(inputHold === undefined ? {} : { inputHold }) };
  return { n, P, B, C, advance: (branch: string, old: string, next: string) => advanceBranch(deps, P, branch, old, next) };
}

const replicaDeps = (n: GitPoolNode) => ({ cfg: n.cfg, db: n.db, pool: n.pool, log: (line: string) => n.logs.push(line) });

/** The branch rows of `P` as `branch node seq commit`, for comparing before and after a refusal. */
const rowsOf = (n: GitPoolNode, P: string) => listBranchRows(n.db, P).map((r) => `${r.branch} ${r.node} ${r.seq} ${r.commit}`);

/** The refusal `p` rejects with: its message. */
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("it was not refused");
}

/** The view's branches as a checkout sees them (`refs/heads/…`), with their commits. */
async function viewOf(n: GitPoolNode): Promise<Map<string, string>> {
  const prefix = "refs/namespaces/view/";
  const out = await git(["for-each-ref", "--format=%(refname) %(objectname)", `${prefix}refs/heads/`], n.project.replica, n.cfg);
  return new Map(out.split("\n").filter(Boolean).map((line) => {
    const [ref = "", commit = ""] = line.split(" ");
    return [ref.slice(prefix.length), commit];
  }));
}

test("advance moves the branch like a push", async () => {
  const { n, P, B, C, advance } = await started();
  const D = await commitOn(n, C, "d");
  await advance("main", B, C);
  // This node's row is at C, replacing its row at B, and the view shows it at once.
  expect(listBranchRows(n.db, P, "main")).toEqual([
    { project: P, branch: "main", node: n.id, seq: 2, commit: C, drops: [{ node: n.id, seq: 1 }] },
  ]);
  expect((await viewOf(n)).get("refs/heads/main")).toBe(C);
  // Its view is current, so the next advance is not refused as stale.
  await advance("main", C, D);
  expect(listBranchRows(n.db, P, "main").map((r) => [r.seq, r.commit])).toEqual([[3, D]]);
  expect((await viewOf(n)).get("refs/heads/main")).toBe(D);
});

test("advance refuses a branch not at old", async () => {
  const { n, P, B, C, advance } = await started();
  const D = await commitOn(n, C, "d");
  const before = rowsOf(n, P);
  expect(await refusal(advance("main", C, D))).toBe(`main is not at ${C}`);
  // Nor is a branch with no row at old.
  expect(await refusal(advance("other", B, C))).toBe(`other is not at ${B}`);
  expect(rowsOf(n, P)).toEqual(before);
  expect((await viewOf(n)).get("refs/heads/main")).toBe(B);
});

test("advance refuses a non-fast-forward", async () => {
  const { n, P, B, advance } = await started();
  const X = await rootLike(n, B, "x");
  const before = rowsOf(n, P);
  expect(await refusal(advance("main", B, X))).toBe(`main: ${X} is not a fast-forward from ${B}`);
  expect(rowsOf(n, P)).toEqual(before);
  expect((await viewOf(n)).get("refs/heads/main")).toBe(B);
});

test("advance refuses a conflicted branch", async () => {
  const { n, P, B, C, advance } = await started();
  const Y = await commitOn(n, B, "y");
  const Z = await commitOn(n, C, "z");
  await advance("main", B, C);
  // Another node's push of main, not having seen C: main is conflicted, between C and Y.
  mergeBranchRows(n.db, [{ project: P, branch: "main", node: "f".repeat(64), seq: 1, commit: Y, drops: [] }]);
  settleBranchRows(n.db, P, new Set([Y]));
  await applyProject(replicaDeps(n), P);
  const before = rowsOf(n, P);
  expect(await refusal(advance("main", C, Z))).toBe(conflictFix("main", [C, Y].sort()));
  expect(rowsOf(n, P)).toEqual(before);
});

test("advance refuses while the branch is still being fetched", async () => {
  const { n, P, C, advance } = await started();
  const D = await commitOn(n, C, "d");
  // A row for main at C, as a peer's would arrive: the view, not applied yet, still shows main at B.
  writeBranchRow(n.db, n.id, { project: P, branch: "main", commit: C, drops: [{ node: n.id, seq: 1 }] });
  const before = rowsOf(n, P);
  expect(await refusal(advance("main", C, D))).toBe("main: this node is still fetching it; push again shortly");
  expect(rowsOf(n, P)).toEqual(before);
  // Once the view catches up, the same advance goes through.
  await applyProject(replicaDeps(n), P);
  await advance("main", C, D);
  expect((await viewOf(n)).get("refs/heads/main")).toBe(D);
});

test("advance refuses while the node takes no input", async () => {
  const { n, P, B, C, advance } = await started(() => "an update awaits confirmation");
  const before = rowsOf(n, P);
  expect(await refusal(advance("main", B, C))).toBe("meddle: an update awaits confirmation");
  expect(rowsOf(n, P)).toEqual(before);
  expect((await viewOf(n)).get("refs/heads/main")).toBe(B);
});

test("advance refuses a project this node does not have", async () => {
  const { n, B, C } = await started();
  const missing = "e".repeat(64);
  expect(await refusal(advanceBranch({ ...replicaDeps(n), selfId: n.id }, missing, "main", B, C))).toBe(`no project ${shortId(missing)} on this node`);
});
