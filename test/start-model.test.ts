// test/start-model.test.ts
import { expect, test } from "bun:test";
import type { GraphBookmark, GraphCommit } from "../src/projects/graph";
import { defaultBranchOf, hintOf, marked, startHints, startSource, type StartLister } from "../src/dashboard/ui/start-model";

/** A commit `id` (its commit id `id` padded, its change id `ch<id>`) at `time`. */
function commit(id: string, time: number, description: string, bookmarks: GraphBookmark[] = []): GraphCommit {
  return { commit: id.padEnd(40, "0"), change: `ch${id}`.padEnd(32, "k"), parents: [], description, immutable: false, time, bookmarks };
}
const branch = (name: string): GraphBookmark => ({ kind: "branch", name });
const line = (task: string): GraphBookmark => ({ kind: "task", task });

const main = commit("aa1", 50, "Show working copy's description in changes", [branch("main")]);
const fix = commit("bb2", 40, "Place on hosts that take attachments", [branch("fix-placement")]);
const spike = commit("cc3", 60, "Try relay-only paths", [branch("spike")]);
const older = commit("dd4", 70, "Design project remotes", [line("t1")]);
const newer = commit("ee5", 80, "Divergent task line write", [line("t2")]);
const plain = commit("ff6", 30, "Skip offline nodes in placement");
const plainOld = commit("aa7", 10, "Name placeTask's refusal");
const graph = [newer, older, spike, main, fix, plain, plainOld];
const titles: Record<string, string> = { t1: "Placement picks idle nodes", t2: "Divergent line" };
const title = (t: string) => titles[t] ?? null;
const commits = (hints: { commit: GraphCommit }[]) => hints.map((h) => h.commit);

test("a blank query offers the default branch, then branches by name, then lines newest first", () => {
  expect(commits(startHints(graph, "  ", "main", title))).toEqual([main, fix, spike, newer, older]);
  const [first, second, , line] = startHints(graph, "", "main", title);
  expect(first).toMatchObject({ rev: null, isDefault: true });
  expect(second).toMatchObject({ rev: "fix-placement", isDefault: false });
  expect(line!.rev).toBe(newer.commit);
});

test("words match branch names, task titles and descriptions, ignoring case", () => {
  expect(commits(startHints(graph, "PLACE", "main", title))).toEqual([fix, older, plain, plainOld]);
});

test("an id matches at the start of a change or commit id only", () => {
  expect(commits(startHints(graph, "aa", "main", title))).toEqual([main, plainOld]);
  expect(commits(startHints(graph, "chbb", "main", title))).toEqual([fix]);
  expect(startHints(graph, "a1", "main", title)).toEqual([]);
});

test("a commit both the default branch and another branch are on is the default", () => {
  const both = commit("ab1", 5, "both", [branch("zeta"), branch("main")]);
  expect(hintOf(both, "main")).toEqual({ commit: both, rev: null, isDefault: true });
  expect(hintOf(both, null).rev).toBe("main");
  expect(hintOf(plain, "main").rev).toBe(plain.commit);
});

test("at most eight hints", () => {
  const many = Array.from({ length: 12 }, (_, i) => commit(`9${i}`, i, `step ${i}`));
  expect(startHints(many, "step", null, title)).toHaveLength(8);
  expect(startHints(many, "step", null, title, 3)).toHaveLength(3);
});

test("marked cuts the match out, at the start only for a prefix", () => {
  expect(marked("fix-placement", "PLACE", false)).toEqual([{ text: "fix-", hit: false }, { text: "place", hit: true }, { text: "ment", hit: false }]);
  expect(marked("qrspyvvu", "qrs", true)).toEqual([{ text: "qrs", hit: true }, { text: "pyvvu", hit: false }]);
  expect(marked("xqrs", "qrs", true)).toEqual([{ text: "xqrs", hit: false }]);
  expect(marked("text", " ", false)).toEqual([{ text: "text", hit: false }]);
});

test("starts are read from the home while it is online, else another online holder", () => {
  const [a, b, c] = ["a", "b", "c"].map((x) => x.repeat(64)) as [string, string, string];
  const nodes: StartLister[] = [
    { nodeId: a, status: "member", online: true, projects: [{ id: "p", home: b, defaultBranch: "main" }] },
    { nodeId: b, status: "member", online: true, projects: [{ id: "p", home: b, defaultBranch: "trunk" }] },
    { nodeId: c, status: "member", online: true, projects: [] },
  ];
  expect(startSource(nodes, c, "p")).toBe(b);
  expect(startSource([nodes[0]!, { ...nodes[1]!, online: false }], c, "p")).toBe(a);
  expect(startSource(nodes, c, "q")).toBeNull();
  // The home's listing names the default branch; an older node's (none) names nothing.
  expect(defaultBranchOf(nodes, "p")).toBe("trunk");
  expect(defaultBranchOf([nodes[0]!, { ...nodes[1]!, projects: [{ id: "p", home: b }] }], "p")).toBe("main");
  expect(defaultBranchOf(nodes, "q")).toBeNull();
});
