// test/ui.test.ts
import { test, expect } from "bun:test";
import { branchLines, headText, mergeProjects, moveTargets, projectChoices } from "../src/dashboard/ui/pool-model";
import { hashOf, viewOf } from "../src/dashboard/ui/routes";
import { ago, groupTasks, homeTask, moveChoices, nodeLineText, usageShort, type TaskEntry } from "../src/dashboard/ui/sidebar-model";
import { highlight, renderMarkdown } from "../src/dashboard/ui/markdown";
import { blinded, buildAlert, buildAlerts, draining, failureText, participantLines, timeLeft, waits } from "../src/dashboard/ui/update-model";
import { nodeDot } from "../src/dashboard/ui/common";
import type { NodeBuildView, RolloutSummary } from "../src/update/updater";

test("the dashboard bundle builds", async () => {
  const build = await Bun.build({ entrypoints: ["src/dashboard/ui/main.tsx"], target: "browser", format: "esm" });
  expect(build.success).toBe(true);
});

test("viewOf and hashOf round-trip every route", () => {
  const views = [
    { name: "home" },
    { name: "task", nodeId: "abc", id: "t1" },
    { name: "new", projectId: null },
    { name: "new", projectId: "p/1" },
    { name: "project", id: "p1" },
    { name: "add-project" },
    { name: "node", nodeId: "abc" },
    { name: "settings" },
  ] as const;
  for (const view of views) expect(viewOf(hashOf(view))).toEqual(view);
  expect(hashOf({ name: "task", nodeId: "abc", id: "t1" })).toBe("#/task/abc/t1");
  expect(viewOf("")).toEqual({ name: "home" });
  expect(viewOf("#/task/t1")).toEqual({ name: "home" });          // the Plan 1 shape no longer resolves
  expect(viewOf("#/pool")).toEqual({ name: "home" });             // the old pool and projects pages
  expect(viewOf("#/projects")).toEqual({ name: "home" });
});

test("viewOf falls back to home for a malformed escape instead of throwing", () => {
  expect(viewOf("#/task/%zz/x")).toEqual({ name: "home" });
  expect(viewOf("#/task/abc/%E0%A4%A")).toEqual({ name: "home" });
});

test("a task moves only to another online member that hosts tasks and runs the same known Claude Code version", () => {
  const [a, b, c, d, e, f] = ["a", "b", "c", "d", "e", "f"].map((x) => x.repeat(64)) as [string, string, string, string, string, string];
  const row = (nodeId: string, over: Partial<{ status: "member" | "removed"; online: boolean; hostsTasks: boolean; claudeCodeVersion: string }> = {}) =>
    ({ nodeId, status: "member" as const, online: true, hostsTasks: true, claudeCodeVersion: "2.1.0", ...over });
  const nodes = [
    row(a),
    row(b),
    row(c, { online: false }),
    row(d, { hostsTasks: false }),
    row(e, { claudeCodeVersion: "2.2.0" }),
    row(f, { status: "removed" }),
  ];
  expect(moveTargets(nodes, a, "2.1.0").map((n) => n.nodeId)).toEqual([b]);
  expect(moveTargets(nodes, b, "2.1.0").map((n) => n.nodeId)).toEqual([a]);
  // an unknown version on this node (a compiled binary) moves nowhere, nor to a node that reports unknown
  expect(moveTargets(nodes, a, "unknown")).toEqual([]);
  expect(moveTargets([row(a, { claudeCodeVersion: "unknown" }), row(b, { claudeCodeVersion: "unknown" })], a, "unknown")).toEqual([]);
});

test("the projects view merges each project's holders by id, home's name first, holders in pool order", () => {
  const [a, b, c] = ["a", "b", "c"].map((x) => x.repeat(64)) as [string, string, string];
  const heads = [{ name: "trunk", remote: null, changeId: "kkkkkkkkkkkk", conflicted: false }];
  const branches = [{ name: "main", state: "single" as const, commit: "1".repeat(40), siblings: [], waiting: [] }];
  const rows = mergeProjects([
    { nodeId: c, id: "p1", name: "one", home: a, defaultBranch: "main", heads: [], branches: [], contextLoaded: true },
    { nodeId: a, id: "p1", name: "one", home: a, defaultBranch: "main", heads, branches, contextLoaded: true },
    { nodeId: b, id: "p2", name: "two", home: b, defaultBranch: null, heads: [], branches: [], contextLoaded: false },
  ], [a, b, c]);
  expect(rows).toEqual([
    {
      id: "p1", name: "one", home: a, defaultBranch: "main", branches,
      holders: [{ nodeId: a, heads, contextLoaded: true }, { nodeId: c, heads: [], contextLoaded: true }],
    },
    { id: "p2", name: "two", home: b, defaultBranch: null, branches: [], holders: [{ nodeId: b, heads: [], contextLoaded: false }] },
  ]);
  expect(headText(heads[0]!)).toBe("trunk kkkkkkkk");
  expect(headText({ name: "meddle/task/t1/one", remote: "0123456789", changeId: "", conflicted: true })).toBe("meddle/task/t1/one@0123456789 (conflicted)");
});

test("the project page marks a conflicted branch, names its siblings as a checkout fetches them, and says what it is still fetching", () => {
  const [x, y, base, top, far] = ["a", "b", "c", "d", "e"].map((h) => h.repeat(40)) as [string, string, string, string, string];
  const lines = branchLines([
    { name: "feature", state: "conflicted", commit: base, siblings: [x, y], waiting: [] },
    { name: "loose", state: "conflicted", commit: null, siblings: [x, y], waiting: [] },
    { name: "main", state: "single", commit: top, siblings: [], waiting: [far] },
    { name: "next", state: "fetching", commit: null, siblings: [], waiting: [far, x] },
  ], "main");
  expect(lines).toEqual([
    { name: "main", isDefault: true, conflicted: false, text: "dddddddddddd; still fetching eeeeeeeeeeee, pushed elsewhere", siblings: [] },
    {
      name: "feature", isDefault: false, conflicted: true, text: "conflicted, at its siblings' merge base cccccccccccc",
      siblings: ["meddle/conflict/feature/aaaaaaaaaaaa@meddle", "meddle/conflict/feature/bbbbbbbbbbbb@meddle"],
    },
    {
      name: "loose", isDefault: false, conflicted: true, text: "conflicted, not served: its siblings share no history",
      siblings: ["meddle/conflict/loose/aaaaaaaaaaaa@meddle", "meddle/conflict/loose/bbbbbbbbbbbb@meddle"],
    },
    {
      name: "next", isDefault: false, conflicted: false, text: "still fetching eeeeeeeeeeee, aaaaaaaaaaaa, pushed elsewhere", siblings: [],
    },
  ]);
});

test("projectChoices: every project an online member lists, once, named as its home lists it", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  const c = "c".repeat(64);
  const nodes = [
    { nodeId: a, status: "member" as const, online: true, projects: [{ id: "p", name: "old-name", home: b }, { id: "q", name: "zeta", home: a }] },
    { nodeId: b, status: "member" as const, online: true, projects: [{ id: "p", name: "alpha", home: b }] },
    { nodeId: c, status: "member" as const, online: false, projects: [{ id: "r", name: "offline", home: c }] },
    { nodeId: "d".repeat(64), status: "removed" as const, online: true, projects: [{ id: "s", name: "gone", home: c }] },
  ];
  expect(projectChoices(nodes)).toEqual([{ id: "p", name: "alpha", home: b }, { id: "q", name: "zeta", home: a }]);
  // With the home not listing it, another holder's entry stands.
  expect(projectChoices([nodes[0]!])).toEqual([{ id: "p", name: "old-name", home: b }, { id: "q", name: "zeta", home: a }]);
});

/** A task entry with defaults for what a test does not care about. */
function entry(id: string, over: Partial<TaskEntry> = {}): TaskEntry {
  return {
    nodeId: "n1", id, title: id, projects: [], state: "idle", pending: 0,
    activityAt: "2026-11-01T00:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z", moveTo: null, archived: false, ...over,
  };
}

test("groupTasks: one-project tasks under their project, the rest shared, archived apart, newest activity first", () => {
  const one = { id: "p1", name: "one" };
  const tasks = [
    entry("a", { projects: [one], activityAt: "2026-11-01T10:00:00.000Z" }),
    entry("b", { projects: [one], activityAt: "2026-11-02T10:00:00.000Z" }),
    entry("c", { projects: [] }),
    entry("d", { projects: [one, { id: "p2", name: "two" }] }),
    entry("e", { projects: [{ id: "px", name: "unlisted" }] }),
    entry("f", { projects: [one], archived: true }),
    // listed archived on one node and live on another: shows once, live
    entry("g", { nodeId: "n1", projects: [one], archived: true, activityAt: "2026-10-01T00:00:00.000Z" }),
    entry("g", { nodeId: "n2", projects: [one], activityAt: "2026-10-01T00:00:00.000Z" }),
  ];
  const groups = groupTasks([{ id: "p2", name: "two", home: "n1" }, { id: "p1", name: "one", home: "n1" }], tasks);
  expect(groups.projects.map((p) => [p.name, p.tasks.map((t) => t.id)])).toEqual([
    ["one", ["b", "a", "g"]],
    ["two", []],
    ["unlisted", ["e"]],
  ]);
  expect(groups.projects[0]!.tasks.find((t) => t.id === "g")!.nodeId).toBe("n2");
  expect(groups.shared.map((t) => t.id).sort()).toEqual(["c", "d"]);
  expect(groups.archived.map((t) => t.id)).toEqual(["f"]);
});

test("homeTask: the most recently active task waiting on you, none when nothing waits", () => {
  expect(homeTask([entry("a")])).toBeNull();
  const picked = homeTask([
    entry("a", { pending: 1, activityAt: "2026-11-01T00:00:00.000Z" }),
    entry("b", { state: "waiting", activityAt: "2026-11-03T00:00:00.000Z" }),
    entry("c", { pending: 1, archived: true, activityAt: "2026-11-04T00:00:00.000Z" }),
  ]);
  expect(picked?.id).toBe("b");
});

test("moveChoices lists every other member, takers first, the rest with why they cannot take the task", () => {
  const row = (nodeId: string, over: Partial<{ status: "member" | "removed"; online: boolean; hostsTasks: boolean; claudeCodeVersion: string }> = {}) =>
    ({ nodeId, hostname: nodeId, status: "member" as const, online: true, hostsTasks: true, claudeCodeVersion: "2.1.0", ...over });
  const nodes = [row("a"), row("off", { online: false }), row("b"), row("none", { hostsTasks: false }), row("old", { claudeCodeVersion: "2.0.0" }), row("gone", { status: "removed" })];
  expect(moveChoices(nodes, "a", "2.1.0").map((c) => [c.node.nodeId, c.reason])).toEqual([
    ["b", null],
    ["off", "offline"],
    ["none", "hosts no tasks"],
    ["old", "Claude Code 2.0.0 ≠ 2.1.0"],
  ]);
  expect(moveChoices(nodes, "a", "unknown").every((c) => c.reason !== null)).toBe(true);
});

test("nodeLineText sums a node up for the footer", () => {
  const now = Date.parse("2026-11-04T12:00:00.000Z");
  const n = { nodeId: "a", online: true, running: 2, lastSeenAt: null, gone: false };
  expect(nodeLineText(n, 1.234, now)).toBe("2 running · load 1.2");
  expect(nodeLineText({ ...n, running: 0 }, null, now)).toBe("idle");
  expect(nodeLineText({ ...n, online: false, lastSeenAt: "2026-11-04T09:00:00.000Z" }, null, now)).toBe("offline 3h");
  expect(nodeLineText({ ...n, online: false, gone: true }, null, now)).toBe("gone");
  expect(ago(90_000)).toBe("1m");
  expect(ago(3 * 86_400_000)).toBe("3d");
});

test("usageShort: the latest turn's tokens in short", () => {
  expect(usageShort(null)).toBeNull();
  expect(usageShort({ usage: { input_tokens: 10, cache_read_input_tokens: 40_000, output_tokens: 2100 } })).toBe("40k in · 2.1k out");
});

test("renderMarkdown highlights code blocks and shows raw HTML as text", () => {
  const html = renderMarkdown("**Not directly.** See `tap.rs`.\n\n```rust\nfn init() {}\n```\n\n<script>alert(1)</script>");
  expect(html).toContain("<strong>Not directly.</strong>");
  expect(html).toContain("<code>tap.rs</code>");
  expect(html).toContain('<span class="hljs-keyword">fn</span>');
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
  expect(highlight("<b>", "nope")).toBe("&lt;b&gt;");
});

/** A rollout of build `n3w` to a and b, started at 10:00 with 30m to confirm and 2m for each node's health. */
function rollout(over: Partial<RolloutSummary> = {}, participants: Array<Partial<RolloutSummary["participants"][number]>> = [{}, {}]): RolloutSummary {
  return {
    id: "r1", build: "n3w", mode: "queued", startedBy: "a", startedAt: "2026-11-13T10:00:00.000Z", deadline: "2026-11-13T10:30:00.000Z",
    healthMs: 120_000, platforms: ["linux-x64"], outcome: null, waiting: [],
    participants: participants.map((p, i) => ({
      node: i === 0 ? "a" : "b", state: "idle", step: null, reason: null, drained: false, waitingOn: [], online: true, at: null, ...p,
    })),
    ...over,
  };
}

test("the blind covers the dashboard once a rollout swaps, and while this node awaits confirmation; the bar shows it before", () => {
  const before = { awaitingConfirmation: false, rollout: rollout({}, [{ state: "draining", drained: true }, { state: "draining", waitingOn: ["0012"] }]) };
  expect(blinded(before)).toBe(false);
  expect(draining(before)?.id).toBe("r1");
  const swapping = { awaitingConfirmation: false, rollout: rollout({}, [{ state: "swapped" }, { state: "draining", drained: true }]) };
  expect(blinded(swapping)).toBe(true);
  expect(draining(swapping)).toBeNull();
  // This node's own wait counts, rollout or not.
  expect(blinded({ awaitingConfirmation: true, rollout: null })).toBe(true);
  // Once it is over, neither.
  const done = { awaitingConfirmation: false, rollout: rollout({ outcome: { status: "confirmed", at: "2026-11-13T10:05:00.000Z" } }, [{ state: "healthy" }, { state: "healthy" }]) };
  expect(blinded(done)).toBe(false);
  expect(draining(done)).toBeNull();
});

test("a rollout's participants: one word for where each is, what else is known, and its health deadline once swapped", () => {
  const r = rollout({}, [
    { state: "swapped", at: "2026-11-13T10:10:00.000Z" },
    { state: "draining", waitingOn: ["0012", "0013"], online: false },
  ]);
  expect(participantLines(r)).toEqual([
    { node: "a", state: "swapped", detail: null, healthBy: "2026-11-13T10:12:00.000Z", failed: false },
    { node: "b", state: "draining", detail: "2 turns, offline", healthBy: null, failed: false },
  ]);
  expect(participantLines(rollout({ mode: "forced" }, [{ state: "draining", waitingOn: ["0012"] }, { state: "idle", step: "preflight" }]))
    .map((p) => [p.state, p.detail])).toEqual([["drained", null], ["preflight", null]]);
  expect(participantLines(rollout({}, [{ state: "failed", reason: "serve failed: no database" }, { online: false }]))
    .map((p) => [p.state, p.detail, p.failed])).toEqual([["failed", "serve failed: no database", true], ["idle", "offline", false]]);
  const w = rollout({ waiting: [{ node: "b", state: "draining", step: null, turns: ["0012"] }, { node: "a", state: "idle", step: "fetching", turns: [] }] });
  expect(waits(w)).toEqual([{ node: "b", turns: ["0012"], step: "draining" }, { node: "a", turns: [], step: "fetching" }]);
  expect(timeLeft("2026-11-13T10:30:00.000Z", Date.parse("2026-11-13T10:18:00.000Z"))).toBe("12m");
  expect(timeLeft("2026-11-13T10:30:00.000Z", Date.parse("2026-11-13T10:31:00.000Z"))).toBe("0s");
});

test("the last failure names its build, node and reason; a node behind the pool's build gets the red dot, with why", () => {
  const name = (id: string) => (id === "b" ? "pi" : id);
  expect(failureText({ lastFailure: null }, name)).toBeNull();
  expect(failureText({ lastFailure: { rollout: "r1", build: "n3w", node: "b", reason: "not healthy within 2m", at: "x" } }, name))
    .toEqual({ rollout: "r1", text: "Update to n3w failed on pi: not healthy within 2m" });
  const node = (over: Partial<NodeBuildView>): NodeBuildView => ({
    node: "b", build: "0ld", platform: "linux-arm64", state: "idle", reason: null, step: null, late: false, blocked: null, mismatched: true, binary: null, at: "x", ...over,
  });
  expect(buildAlert(undefined, "n3w")).toBeNull();
  expect(buildAlert(node({ mismatched: false }), "n3w")).toBeNull();
  expect(buildAlert(node({ state: "failed", reason: "preflight failed: exited 1", late: true }), "n3w")).toBe("Update failed: preflight failed: exited 1");
  expect(buildAlert(node({ blocked: "its service unit has no update guard" }), "n3w"))
    .toBe("On build 0ld, not the pool's n3w; cannot be updated: its service unit has no update guard");
  expect(buildAlert(node({ state: "draining", late: true }), "n3w")).toBe("On build 0ld, not the pool's n3w; catching up (draining)");
  expect(buildAlert(node({ build: "n3w", mismatched: false, binary: "binary on disk changed since start" }), "n3w")).toBe("Binary on disk changed since start");
  expect([...buildAlerts({ poolBuild: "n3w", nodes: [node({}), node({ node: "a", build: "n3w", mismatched: false })] }).keys()]).toEqual(["b"]);
  expect(nodeDot({ online: true, running: 2 }, "Update failed: x")).toBe("dot bad");
  expect(nodeDot({ online: true, running: 2 })).toBe("dot busy");
});
