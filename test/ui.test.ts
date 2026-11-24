// test/ui.test.ts
import { test, expect } from "bun:test";
import { branchLines, listedOnline, mergeProjects, projectChoices, unknownVersion } from "../src/dashboard/ui/pool-model";
import { hashOf, viewOf } from "../src/dashboard/ui/routes";
import { agentCounts, foldedLine, panelRows, rootOf, toolCount } from "../src/dashboard/ui/agents-model";
import type { AgentEntry } from "../src/state/contracts";
import { ago, groupTasks, homeTask, moveChoices, nodeLineText, projectLines, restoreBlocked, uniqueTasks, usageShort, type TaskEntry } from "../src/dashboard/ui/sidebar-model";
import { mergeStatus, pausedText, queuedChip, resumeLabel, trainColumns, trainError, trainOffer, type TrainView } from "../src/dashboard/ui/train-model";
import { highlight, renderMarkdown, renderPrompt } from "../src/dashboard/ui/markdown";
import { blinded, buildAlert, buildAlerts, draining, failureText, participantLines, timeLeft, waits } from "../src/dashboard/ui/update-model";
import { nodeDot } from "../src/dashboard/ui/common";
import { canSaveNew, changeWho, memorySource, mergeFirstPage, stripFrontmatter, writeError } from "../src/dashboard/ui/memory-model";
import { syncRows } from "../src/dashboard/ui/sync-model";
import type { MemoryChange } from "../src/projects/memory-view";
import type { NodeBuildView, RolloutSummary } from "../src/update/updater";
import { changeCount, changeLabel, type FileNode, fileTree, patchHash, summary, totals, treeFiles } from "../src/dashboard/ui/changes-model";
import { composerKey, composing, enters, withTakenBack } from "../src/dashboard/ui/composer-model";
import { contextMeter, levelOf, readAgo, windowMeter } from "../src/dashboard/ui/usage-model";
import type { FilePatch } from "../src/dashboard/ui/git-diff";
import type { ProjectChanges, TaskChange } from "../src/tasks/changes";
import { blobUrl, ComposerFiles, type Draft, draftAttachments, guardDrops, nameFor, pastedFiles, readyToSend, shownInline, sizeText } from "../src/dashboard/ui/attach-model";
import type { Attachment } from "../src/blobs/attachment";

test("the dashboard bundle builds", async () => {
  const build = await Bun.build({ entrypoints: ["src/dashboard/ui/main.tsx"], target: "browser", format: "esm" });
  expect(build.success).toBe(true);
});

test("restoreBlocked says Project removed when any of the task's projects is removed", () => {
  expect(restoreBlocked(["a", "b"], new Set(["b", "z"]))).toBe("Project removed");
  expect(restoreBlocked(["a", "b"], new Set(["z"]))).toBeNull();
  expect(restoreBlocked([], new Set(["a"]))).toBeNull();
});

test("viewOf and hashOf round-trip every route", () => {
  const views = [
    { name: "home" },
    { name: "task", nodeId: "abc", id: "t1" },
    { name: "task", nodeId: "abc", id: "t1", tab: "changes" },
    { name: "new", projectId: null },
    { name: "new", projectId: "p/1" },
    { name: "project", id: "p1" },
    { name: "project", id: "p1", tab: "memory" },
    { name: "project", id: "p1", tab: "tasks" },
    { name: "add-project" },
    { name: "node", nodeId: "abc" },
    { name: "settings" },
    { name: "train", projectId: "p1" },
    { name: "train", projectId: "p/1", task: "t1" },
  ] as const;
  for (const view of views) expect(viewOf(hashOf(view))).toEqual(view);
  expect(hashOf({ name: "train", projectId: "p/1" })).toBe("#/train/p%2F1");
  expect(hashOf({ name: "train", projectId: "p1", task: "t1" })).toBe("#/train/p1/t1");
  expect(viewOf("#/train/p1")).not.toHaveProperty("task");
  expect(viewOf("#/train")).toEqual({ name: "home" });
  expect(viewOf("#/train//t1")).toEqual({ name: "home" });
  expect(viewOf("#/train/p1/t1/x")).toEqual({ name: "home" });
  expect(hashOf({ name: "task", nodeId: "abc", id: "t1" })).toBe("#/task/abc/t1");
  expect(hashOf({ name: "task", nodeId: "abc", id: "t1", tab: "changes" })).toBe("#/task/abc/t1/changes");
  expect(viewOf("#/task/abc/t1")).not.toHaveProperty("tab");
  expect(viewOf("#/task/abc/t1/other")).toEqual({ name: "home" });
  expect(hashOf({ name: "project", id: "p/1", tab: "memory" })).toBe("#/project/p%2F1/memory");
  expect(viewOf("#/project/p1")).not.toHaveProperty("tab");
  expect(viewOf("#/project/p1/graph")).toEqual({ name: "home" });
  expect(viewOf("#/project/p1/other")).toEqual({ name: "home" });
  expect(viewOf("")).toEqual({ name: "home" });
  expect(viewOf("#/task/t1")).toEqual({ name: "home" });          // the Plan 1 shape no longer resolves
  expect(viewOf("#/pool")).toEqual({ name: "home" });             // the old pool and projects pages
  expect(viewOf("#/projects")).toEqual({ name: "home" });
});

test("viewOf falls back to home for a malformed escape instead of throwing", () => {
  expect(viewOf("#/task/%zz/x")).toEqual({ name: "home" });
  expect(viewOf("#/task/abc/%E0%A4%A")).toEqual({ name: "home" });
});

test("a version that says nothing is unknown: a compiled binary's, or one not reported yet", () => {
  expect(unknownVersion("unknown")).toBe(true);
  expect(unknownVersion("")).toBe(true);
  expect(unknownVersion("2.1.0")).toBe(false);
});

test("the projects view merges each project's holders by id, home's name first, holders in pool order", () => {
  const [a, b, c] = ["a", "b", "c"].map((x) => x.repeat(64)) as [string, string, string];
  const branches = [{ name: "main", state: "single" as const, commit: "1".repeat(40), siblings: [], waiting: [] }];
  const graph = [{ commit: "1".repeat(40), change: "k".repeat(32), parents: [], description: "", immutable: true, time: 1, bookmarks: [] }];
  const rows = mergeProjects([
    { nodeId: c, id: "p1", name: "one", home: a, defaultBranch: "main", branches: [], contextLoaded: true, graph: [] },
    { nodeId: a, id: "p1", name: "one", home: a, defaultBranch: "main", branches, contextLoaded: true, graph },
    { nodeId: b, id: "p2", name: "two", home: b, defaultBranch: null, branches: [], contextLoaded: false, graph: [] },
  ], [a, b, c]);
  expect(rows).toEqual([
    {
      id: "p1", name: "one", home: a, defaultBranch: "main", branches,
      holders: [{ nodeId: a, contextLoaded: true, graph }, { nodeId: c, contextLoaded: true, graph: [] }],
    },
    { id: "p2", name: "two", home: b, defaultBranch: null, branches: [], holders: [{ nodeId: b, contextLoaded: false, graph: [] }] },
  ]);
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

test("listedOnline: a project an offline node last listed is not listed online", () => {
  const nodes = [
    { nodeId: "a", projects: [{ id: "p", name: "faff", home: "a" }] },
    { nodeId: "b", projects: [{ id: "q", name: "swarm", home: "b" }] },
  ];
  expect(listedOnline(nodes, ["a"], "p")).toBe(true);
  expect(listedOnline(nodes, ["a"], "q")).toBe(false); // b is offline: its summary is its last
  expect(listedOnline(nodes, ["a", "b"], "q")).toBe(true);
  expect(listedOnline(nodes, ["a", "b"], "r")).toBe(false);
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
    nodeId: "n1", id, title: id, projects: [], state: "idle", pending: 0, agents: 0,
    activityAt: "2026-11-01T00:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z", moveTo: null, archived: false, queued: false, merge: false, ...over,
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

test("groupTasks counts each project's queued tasks, not those archived or shared", () => {
  const one = { id: "p1", name: "one" };
  const two = { id: "p2", name: "two" };
  const groups = groupTasks([{ id: "p1", name: "one", home: "n1" }, { id: "p2", name: "two", home: "n1" }], [
    entry("a", { projects: [one], queued: true }),
    entry("b", { projects: [one], queued: true }),
    entry("c", { projects: [one] }),
    entry("m", { projects: [one], merge: true }),
    entry("d", { projects: [one], queued: true, archived: true }),
    entry("e", { projects: [one, two], queued: true }),
    entry("f", { projects: [two], queued: true }),
  ]);
  expect(groups.projects.map((p) => [p.name, p.queued])).toEqual([["one", 2], ["two", 1]]);
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
  // nor to a node that reports unknown, even from one that reports the same
  expect(moveChoices([row("a", { claudeCodeVersion: "unknown" }), row("b", { claudeCodeVersion: "unknown" })], "a", "unknown").map((c) => c.reason))
    .toEqual(["Claude Code version unknown"]);
});

test("uniqueTasks lists a task held by two nodes once, its live entry over its archived one", () => {
  const live = { id: "t", archived: false, nodeId: "b" };
  const gone = { id: "t", archived: true, nodeId: "a" };
  const other = { id: "u", archived: false, nodeId: "a" };
  expect(uniqueTasks([gone, other, live])).toEqual([live, other]);
  expect(uniqueTasks([live, gone])).toEqual([live]);
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

test("levelOf: warn from 80%, bad from 95%", () => {
  expect(levelOf(0.79)).toBe("ok");
  expect(levelOf(0.8)).toBe("warn");
  expect(levelOf(0.949)).toBe("warn");
  expect(levelOf(0.95)).toBe("bad");
});

test("contextMeter: the latest call's tokens over its model's window", () => {
  const usage = { modelUsage: { m: { contextWindow: 1_000_000 } }, usage: { input_tokens: 10, output_tokens: 2100 } };
  const meter = contextMeter({ tokens: 375_000, model: "m" }, usage)!;
  expect(meter).toMatchObject({ label: "ctx", text: "375k / 1M", fraction: 0.375, level: "ok", faded: false });
  expect(meter.title).toContain("375,000");
  expect(meter.title).toContain("latest turn: 10 in · 2.1k out");
  expect(contextMeter({ tokens: 860_000, model: "m" }, usage)!.level).toBe("warn");
  // A window not known yet (before the first result, or another model's): the count alone, no bar.
  const unknown = contextMeter({ tokens: 375_000, model: "other" }, usage)!;
  expect(unknown.text).toBe("375k");
  expect(unknown.fraction).toBeNaN();
  expect(contextMeter(null, usage)).toBeNull();
  expect(contextMeter(undefined, usage)).toBeNull();
});

test("windowMeter: a limit's share used, its reset, faded when stale or reset", () => {
  const now = Date.parse("2026-11-18T12:00:00.000Z");
  const at = (ms: number) => new Date(now + ms).toISOString();
  const fresh = windowMeter("5h", { utilization: 0.27, resetsAt: at(3600_000) }, at(-120_000), now)!;
  expect(fresh).toMatchObject({ label: "5h", text: "27%", fraction: 0.27, level: "ok", faded: false });
  expect(fresh.note).toStartWith("resets ");
  expect(fresh.title).toStartWith("5-hour limit: 27% used, resets ");
  expect(windowMeter("7d", { utilization: 0.27, resetsAt: at(3600_000) }, at(-120_000), now)!.title).toStartWith("7-day limit: ");
  expect(windowMeter("5h", { utilization: 1.4, resetsAt: at(3600_000) }, at(0), now)).toMatchObject({ text: "100%", fraction: 1, level: "bad" });
  expect(windowMeter("5h", { utilization: 0.9, resetsAt: at(-1) }, at(-120_000), now))
    .toMatchObject({ text: "0%", fraction: 0, level: "ok", faded: true, note: "reset" });
  expect(windowMeter("5h", { utilization: 0.27, resetsAt: at(3600_000) }, at(-31 * 60_000), now)!.faded).toBe(true);
  expect(windowMeter("5h", { utilization: 0.27, resetsAt: null }, at(0), now)).toMatchObject({ text: "27%", note: null });
  expect(windowMeter("5h", null, at(0), now)).toBeNull();
});

test("readAgo: how old a reading is", () => {
  const now = Date.parse("2026-11-18T12:00:00.000Z");
  expect(readAgo(new Date(now - 120_000).toISOString(), now)).toBe("read 2m ago");
});

test("projectLines: each project with its own line's change id, in manifest order", () => {
  const t = "t1";
  const bm = [
    { name: "meddle/task/t1/swarm", changeId: "tplnrwsvqkxm0000" },
    { name: "meddle/task/t1/meddle.before-1", changeId: "zzzzzzzz" },
    { name: "meddle/task/t1/meddle", changeId: "kqxyzmwnrstl0000" },
    { name: "meddle/task/t1/broken", changeId: "" },
  ];
  expect(projectLines(t, [{ name: "meddle", workspace: "meddle" }, { name: "swarm", workspace: "swarm" }], bm)).toEqual([
    { name: "meddle", workspace: "meddle", changeId: "kqxyzmwnrstl0000", conflicted: false },
    { name: "swarm", workspace: "swarm", changeId: "tplnrwsvqkxm0000", conflicted: false },
  ]);
  expect(projectLines(t, [{ name: "broken", workspace: "broken" }], bm)).toEqual([{ name: "broken", workspace: "broken", changeId: null, conflicted: true }]);
  expect(projectLines(t, [{ name: "fresh", workspace: "fresh" }], bm)).toEqual([{ name: "fresh", workspace: "fresh", changeId: null, conflicted: false }]);
  expect(projectLines(t, [], bm)).toEqual([]);
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

test("renderPrompt formats inline Markdown and fenced code, and keeps the rest as typed", () => {
  expect(renderPrompt("I sometimes do stuff _like_ this.\nOr `main`, or **this**.")).toBe(
    "I sometimes do stuff <em>like</em> this.\nOr <code>main</code>, or <strong>this</strong>.");
  // Lines that would be blocks in Markdown stay as typed, and words with underscores stay whole.
  expect(renderPrompt("# not a heading\n- not a list\nsnake_case_name")).toBe("# not a heading\n- not a list\nsnake_case_name");
  expect(renderPrompt("<b>hi</b> & <script>")).toBe("&lt;b&gt;hi&lt;/b&gt; &amp; &lt;script&gt;");
  const fenced = renderPrompt("Look:\n```rust\nfn init() {}\n```\nThen _this_.");
  expect(fenced).toStartWith('Look:<pre class="code"><code class="hljs"><span class="hljs-keyword">fn</span>');
  expect(fenced).toEndWith("</code></pre>Then <em>this</em>.");
  // An unclosed fence is only text.
  expect(renderPrompt("```\nhalf")).not.toContain("<pre");
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

test("memorySource picks this node when it holds the project, else an online holder, and both can write", () => {
  expect(memorySource("s", ["h", "s", "b"], ["b", "h", "s"])).toEqual({ nodeId: "s", editable: true });
  expect(memorySource("s", ["h", "a", "b"], ["b", "a"])).toEqual({ nodeId: "a", editable: true });
  expect(memorySource("s", ["h", "a"], ["c"])).toBeNull();
  expect(memorySource("s", [], [])).toBeNull();
});

test("changeWho names the task, the dashboard or the import", () => {
  const change = (kind: MemoryChange["kind"], task: string | null = null): MemoryChange =>
    ({ change: "c", at: "2026-11-17T00:00:00.000Z", node: null, task, kind, description: "", files: [], added: 0, removed: 0 });
  const title = (id: string) => (id === "t1" ? "Render patches" : null);
  expect(changeWho(change("task", "t1"), title)).toEqual({ label: "Render patches", taskId: "t1" });
  expect(changeWho(change("task", "t9"), title)).toEqual({ label: "t9", taskId: "t9" });
  expect(changeWho(change("dashboard"), title)).toEqual({ label: "Dashboard", taskId: null });
  expect(changeWho(change("import"), title)).toEqual({ label: "Imported", taskId: null });
  expect(changeWho(change("node"), title)).toEqual({ label: "", taskId: null });
  expect(changeWho(change("other"), title)).toEqual({ label: "", taskId: null });
});

test("writeError reads changed", () => {
  const refused = (message: string) => Object.assign(new Error(message), { code: "unavailable" });
  expect(writeError(refused("unavailable: changed: x"))).toBe("Changed");
  expect(writeError(refused("unavailable: busy: y"))).toBeNull();
  expect(writeError(refused("unavailable: path: z"))).toBeNull();
  expect(writeError(refused("unavailable: other"))).toBeNull();
  expect(writeError(new Error("network down"))).toBeNull();
});

test("stripFrontmatter leaves the body", () => {
  expect(stripFrontmatter("---\nname: a\ntype: b\n---\n\nBody\n")).toBe("\nBody\n");
  expect(stripFrontmatter("---\r\nname: a\r\n---\r\nBody")).toBe("Body");
  expect(stripFrontmatter("# No frontmatter\n")).toBe("# No frontmatter\n");
  expect(stripFrontmatter("---\nunclosed\n")).toBe("---\nunclosed\n");
});

test("canSaveNew wants a memory name not listed yet", () => {
  expect(canSaveNew("a.md", ["MEMORY.md"])).toBe(true);
  expect(canSaveNew("MEMORY.md", ["MEMORY.md"])).toBe(false);
  expect(canSaveNew("a/b.md", [])).toBe(false);
  expect(canSaveNew("", [])).toBe(false);
});

test("mergeFirstPage puts new changes on top and keeps the pages loaded below", () => {
  const c = (change: string): MemoryChange =>
    ({ change, at: "2026-11-17T00:00:00.000Z", node: null, task: null, kind: "other", description: "", files: [], added: 0, removed: 0 });
  const ids = (r: { list: MemoryChange[] }) => r.list.map((x) => x.change);
  const loaded = { list: ["d", "c", "b", "a"].map(c), more: true };
  // Two new changes; the fresh page of 3 ends on `d`, so everything loaded below `d` stays.
  const merged = mergeFirstPage(loaded, ["f", "e", "d"].map(c), 3);
  expect(ids(merged)).toEqual(["f", "e", "d", "c", "b", "a"]);
  expect(merged.more).toBe(true);
  // The fresh page ends on something not loaded: only it, with more to load.
  expect(mergeFirstPage(loaded, ["h", "g", "f"].map(c), 3)).toEqual({ list: ["h", "g", "f"].map(c), more: true });
  // A short page is the whole history.
  expect(mergeFirstPage(loaded, ["e", "d"].map(c), 3)).toEqual({ list: ["e", "d"].map(c), more: false });
  // Nothing loaded yet: the page as it is.
  expect(mergeFirstPage(null, ["b", "a"].map(c), 2)).toEqual({ list: ["b", "a"].map(c), more: true });
});

const change = (over: Partial<TaskChange>): TaskChange => ({
  change: "kpmxqwrtzzzzzzzz", commit: "c".repeat(40), description: "", files: 1, added: 1, removed: 0,
  empty: false, conflicted: false, workingCopy: false, ...over,
});
const project = (over: Partial<ProjectChanges>): ProjectChanges => ({ project: "p1", name: "meddle", start: "main", conflicted: false, from: null, changes: [], ...over });

test("changeCount counts the non-empty changes of every project", () => {
  expect(changeCount([])).toBe(0);
  expect(changeCount([
    project({ changes: [change({ workingCopy: true, empty: true, files: 0, added: 0 }), change({}), change({})] }),
    project({ project: "p2", changes: [change({ empty: true, files: 0, added: 0 }), change({})] }),
  ])).toBe(3);
});

test("summary counts the non-empty changes", () => {
  expect(summary(project({ changes: [change({ workingCopy: true, empty: true }), change({}), change({})] }))).toBe("2 changes");
  expect(summary(project({ start: "xqttoluq", changes: [change({})] }))).toBe("1 change");
  expect(summary(project({}))).toBe("0 changes");
});

test("patchHash is the same for the same patch and moves with its hunks", () => {
  const patch = (lines: string[], over: Partial<FilePatch> = {}): FilePatch => ({
    path: "a", status: "modified", binary: false, added: 1, removed: 1,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines }], ...over,
  });
  const hash = patchHash(patch(["-a", "+b"]));
  expect(hash).toMatch(/^[0-9a-z]{1,7}$/);
  expect(patchHash(patch(["-a", "+b"]))).toBe(hash);
  expect(patchHash(patch(["-a", "+c"]))).not.toBe(hash);
  expect(patchHash(patch(["-a", "+b"], { hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ["-a", "+b"] }] }))).not.toBe(hash);
  expect(patchHash(patch(["-a", "+b"], { status: "renamed", oldPath: "z" }))).not.toBe(hash);
});

test("totals sums a diff's files and lines", () => {
  const patch = (added: number, removed: number): FilePatch => ({ path: "a", status: "modified", binary: false, hunks: [], added, removed });
  expect(totals([patch(5, 2), patch(8, 0), patch(48, 0)])).toEqual({ files: 3, added: 61, removed: 2 });
  expect(totals([])).toEqual({ files: 0, added: 0, removed: 0 });
});

test("fileTree puts folders before files, each by name, and runs on through lone folders", () => {
  const patch = (path: string): FilePatch => ({ path, status: "modified", binary: false, hunks: [], added: 1, removed: 0 });
  const patches = ["README.md", "src/dashboard/ui/Changes.tsx", "src/dashboard/ui/changes-model.ts", "bun.lock", "src/cli.ts", "test/ui.test.ts", "Zeta/a.ts", "docs/plans/x.md"].map(patch);
  const shape = (nodes: readonly FileNode[]): unknown[] => nodes.map((n) => n.kind === "dir" ? { [n.path]: shape(n.children) } : n.name);
  const tree = fileTree(patches);
  expect(shape(tree)).toEqual([
    { "docs/plans": ["x.md"] },
    { src: [{ "src/dashboard/ui": ["changes-model.ts", "Changes.tsx"] }, "cli.ts"] },
    { test: ["ui.test.ts"] },
    { Zeta: ["a.ts"] },
    "bun.lock",
    "README.md",
  ]);
  // A folder that runs on is named for all it runs through, below it only its own part.
  expect(tree[0]).toMatchObject({ kind: "dir", name: "docs/plans", path: "docs/plans" });
  expect((tree[1] as Extract<FileNode, { kind: "dir" }>).children[0]).toMatchObject({ name: "dashboard/ui", path: "src/dashboard/ui" });
  // The diffs are drawn in the tree's order.
  expect(treeFiles(tree).map((p) => p.path)).toEqual([
    "docs/plans/x.md", "src/dashboard/ui/changes-model.ts", "src/dashboard/ui/Changes.tsx", "src/cli.ts", "test/ui.test.ts", "Zeta/a.ts", "bun.lock", "README.md",
  ]);
  expect(treeFiles(tree)[0]).toBe(patches[7]!);
  // A file and a folder of the same name (a file replaced by a folder) are both kept.
  expect(shape(fileTree(["a", "a/b"].map(patch)))).toEqual([{ a: ["b"] }, "a"]);
  expect(fileTree([])).toEqual([]);
});

test("changeLabel names the description, else the working copy, else the short id", () => {
  expect(changeLabel(change({ workingCopy: true, description: "Wip" }))).toBe("Wip");
  expect(changeLabel(change({ workingCopy: true, description: "" }))).toBe("Working copy");
  expect(changeLabel(change({ description: "Add DiffView" }))).toBe("Add DiffView");
  expect(changeLabel(change({ description: "" }))).toBe("kpmxqwrt");
});

test("an input method's keys are its own: a one-line box submits on a plain Enter only", () => {
  const key = (k: Partial<Parameters<typeof enters>[0]>) => ({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 13, ...k });
  expect(enters(key({}))).toBe(true);
  expect(enters(key({ isComposing: true }))).toBe(false);
  expect(enters(key({ keyCode: 229 }))).toBe(false);
  expect(enters(key({ shiftKey: true }))).toBe(false);
  expect(enters(key({ key: "a" }))).toBe(false);
  expect(composing(key({ key: "Escape", isComposing: true }))).toBe(true);
  expect(composing(key({ key: "Escape" }))).toBe(false);
});

test("composerKey: Enter sends (queued while a turn runs), Ctrl or Cmd+Enter sends now, Shift+Enter and touch keyboards make a new line", () => {
  const key = (k: Partial<Parameters<typeof composerKey>[0]>) => ({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 13, ...k });
  const desk = { running: true, touch: false, anyQueued: false, value: "", caret: 0 };
  expect(composerKey(key({}), desk)).toBe("send");
  expect(composerKey(key({}), { ...desk, running: false })).toBe("send");
  expect(composerKey(key({ ctrlKey: true }), desk)).toBe("send-now");
  expect(composerKey(key({ metaKey: true }), desk)).toBe("send-now");
  // with no turn running there is nothing to cut: it sends
  expect(composerKey(key({ ctrlKey: true }), { ...desk, running: false })).toBe("send");
  expect(composerKey(key({ shiftKey: true }), desk)).toBeNull();
  expect(composerKey(key({ altKey: true }), desk)).toBeNull();
  // the Enter that ends an input method's composition is the input method's
  expect(composerKey(key({ isComposing: true }), desk)).toBeNull();
  expect(composerKey(key({ keyCode: 229 }), desk)).toBeNull();
  // a phone's Enter makes a new line; a keyboard attached to it still sends now
  expect(composerKey(key({}), { ...desk, touch: true })).toBeNull();
  expect(composerKey(key({ ctrlKey: true }), { ...desk, touch: true })).toBe("send-now");
  expect(composerKey(key({ key: "a" }), desk)).toBeNull();
});

const shot: Attachment = { hash: "a".repeat(64), name: "shot.png", type: "image/png", size: 1000 };
const draft = (over: Partial<Draft> = {}): Draft => ({
  id: 1, name: shot.name, type: shot.type, size: shot.size, preview: null, state: "done", attachment: shot, error: null, ...over,
});

test("readyToSend wants text or attachments, and every upload done", () => {
  expect(readyToSend(" ", [])).toBe(false);
  expect(readyToSend("", [draft({ state: "done" })])).toBe(true);
  expect(readyToSend("hi", [draft({ state: "uploading" })])).toBe(false);
  expect(readyToSend("hi", [draft({ state: "failed" })])).toBe(false);
});

test("blobUrl, sizeText, nameFor", () => {
  expect(blobUrl({ ...shot, name: "a b.png" })).toBe(`/blobs/${shot.hash}?type=image%2Fpng&name=a%20b.png`);
  expect([sizeText(512), sizeText(12_300), sizeText(3_400_000)]).toEqual(["512 B", "12 KB", "3.4 MB"]);
  expect(nameFor({ name: "", type: "image/png" }, new Date(2026, 10, 17, 9, 5, 3))).toBe("pasted-20261117-090503.png");
  expect(nameFor({ name: "../../a.png", type: "image/png" }, new Date())).toBe("_.._a.png");
});

test("draftAttachments takes the uploaded drafts' attachments; only the four image types show inline", () => {
  const log: Attachment = { ...shot, name: "server.log", type: "application/octet-stream" };
  expect(draftAttachments([draft(), draft({ id: 2, state: "uploading", attachment: null }), draft({ id: 3, attachment: log })])).toEqual([shot, log]);
  expect(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", ""].map(shownInline)).toEqual([true, true, true, true, false, false]);
});

test("ComposerFiles keeps a composer's uploaded files across views and in storage", () => {
  const kept = new Map<string, string>();
  const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) };
  const files = new ComposerFiles(storage);
  let told = 0;
  const off = files.subscribe("new.p", () => told++);
  const pasted = files.draft({ name: shot.name, type: shot.type, size: shot.size, preview: "blob:x", state: "uploading", attachment: null });
  files.update("new.p", (all) => [...all, pasted]);
  // uploading: held for the next view, not kept
  expect(files.get("new.p")).toEqual([pasted]);
  expect(kept.has("meddle.draft.new.p.files")).toBe(false);
  // the upload settles with no view open: kept all the same
  off();
  files.update("new.p", (all) => all.map((d) => ({ ...d, state: "done" as const, attachment: shot })));
  expect(told).toBe(1);
  expect(JSON.parse(kept.get("meddle.draft.new.p.files")!)).toEqual([shot]);
  expect(files.get("task.t")).toEqual([]);

  // a reload: back from storage, previewed from the node; a bad entry is left out
  kept.set("meddle.draft.new.p.files", JSON.stringify([{ ...shot, extra: 1 }, { hash: "nope" }]));
  const back = new ComposerFiles(storage).get("new.p");
  expect(back.map((d) => [d.attachment, d.preview, d.state])).toEqual([[shot, blobUrl(shot), "done"]]);
  expect(new ComposerFiles(storage).get("new.p")).toHaveLength(1);
  kept.set("meddle.draft.task.t.files", "not json");
  expect(new ComposerFiles(storage).get("task.t")).toEqual([]);

  // sent: no longer kept
  files.update("new.p", () => []);
  expect(kept.has("meddle.draft.new.p.files")).toBe(false);
  // no storage at all: the files last as long as the page
  const bare = new ComposerFiles(null);
  bare.update("k", () => [bare.restored(shot)]);
  expect(draftAttachments(bare.get("k"))).toEqual([shot]);
});

test("pastedFiles takes a clipboard's files when its text is nothing but their names or paths", () => {
  const files = (...names: string[]) => names.map((name) => ({ name }));
  // a picture alone, as a screenshot is
  expect(pastedFiles({ text: "", files: files("image.png", "b.log") })).toEqual(files("image.png", "b.log"));
  // Excel, Word and Docs put a picture of the selection beside its text: that paste is text
  expect(pastedFiles({ text: "a\tb", files: files("image.png") })).toEqual([]);
  expect(pastedFiles({ text: "Quarterly figures\n", files: files("image.png") })).toEqual([]);
  expect(pastedFiles({ text: "hello", files: [] })).toEqual([]);
  // Finder: the file's name as its text
  expect(pastedFiles({ text: "report.pdf", files: files("report.pdf") })).toEqual(files("report.pdf"));
  // a file manager's paths, one a line, or file:// URLs; Windows paths too
  expect(pastedFiles({ text: "/home/me/a.png\n/home/me/b c.log\n", files: files("a.png", "b c.log") })).toEqual(files("a.png", "b c.log"));
  expect(pastedFiles({ text: "file:///home/me/b%20c.log\r\nfile:///home/me/a.png", files: files("a.png", "b c.log") })).toEqual(files("a.png", "b c.log"));
  expect(pastedFiles({ text: "C:\\Users\\me\\a.png", files: files("a.png") })).toEqual(files("a.png"));
  // a line that is not one of them, or a name only part of a line, is text
  expect(pastedFiles({ text: "/home/me/a.png\nsee above", files: files("a.png") })).toEqual([]);
  expect(pastedFiles({ text: "/home/me/xa.png", files: files("a.png") })).toEqual([]);
  expect(pastedFiles({ text: "file:///home/me/bad%zz.png", files: files("bad%zz.png") })).toEqual([]);
});

/** A drag event as the page gets it, carrying `types`. */
function dragEvent(type: "dragover" | "drop", types: string[]): Event & { dataTransfer: { types: string[]; dropEffect: string } } {
  const e = new Event(type, { cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: { types, dropEffect: "copy" } });
  return e as Event & { dataTransfer: { types: string[]; dropEffect: string } };
}

test("a file dragged or dropped off a composer never replaces the dashboard; text and a composer's own drop are left alone", () => {
  const page = new EventTarget();
  const stop = guardDrops(page);
  const over = dragEvent("dragover", ["Files"]);
  const drop = dragEvent("drop", ["Files"]);
  page.dispatchEvent(over);
  page.dispatchEvent(drop);
  expect([over.defaultPrevented, over.dataTransfer.dropEffect, drop.defaultPrevented]).toEqual([true, "none", true]);
  // a drag of text is the browser's
  const text = dragEvent("drop", ["text/plain"]);
  page.dispatchEvent(text);
  expect(text.defaultPrevented).toBe(false);
  stop();
  const after = dragEvent("drop", ["Files"]);
  page.dispatchEvent(after);
  expect(after.defaultPrevented).toBe(false);

  // a composer that takes files had the drag first: it stays a place to drop them
  const withComposer = new EventTarget();
  withComposer.addEventListener("dragover", (e) => e.preventDefault());
  guardDrops(withComposer);
  const onComposer = dragEvent("dragover", ["Files"]);
  withComposer.dispatchEvent(onComposer);
  expect([onComposer.defaultPrevented, onComposer.dataTransfer.dropEffect]).toEqual([true, "copy"]);
});

const NOW = Date.parse("2026-11-17T19:40:00.000Z");
const agentEntry = (description: string, over: Partial<AgentEntry> = {}): AgentEntry => ({
  id: description, toolUseId: `t-${description}`, seq: 1, description, agentType: "general-purpose", background: true, parent: null,
  state: "running", orphaned: false, doing: null, commands: 0, tools: 0, tokens: 0, ms: 0,
  startedAt: "2026-11-17T19:36:35.000Z", endedAt: null, ...over,
});

test("agentCounts says how many run, are done, stopped and failed, leaving out the noughts", () => {
  expect(agentCounts([agentEntry("a"), agentEntry("b"), agentEntry("c", { state: "completed" }), agentEntry("d", { state: "stopped" })]))
    .toBe("2 running · 1 done · 1 stopped");
  expect(agentCounts([agentEntry("a", { state: "failed" })])).toBe("1 failed");
  expect(agentCounts([])).toBe("");
});

test("panelRows: running agents with their step and numbers, then the newest finished, the rest counted", () => {
  const finished = (n: number, over: Partial<AgentEntry> = {}) =>
    agentEntry(`f${n}`, { state: "completed", endedAt: "2026-11-17T19:36:00.000Z", tools: 14, tokens: 37314, ms: 82000, ...over });
  const list = [
    agentEntry("Implement Task 3: blobs between nodes", { doing: "Running bun test", tools: 31, tokens: 79502 }),
    agentEntry("Review Task 2"),
    finished(1), finished(2, { state: "stopped", orphaned: true }), finished(3, { state: "failed", tools: 1 }), finished(4, { state: "stopped" }), finished(5),
  ];
  const { rows, earlier } = panelRows(list, NOW, false);
  expect(rows.map((r) => [r.agent.description, r.doing, r.nums])).toEqual([
    ["Implement Task 3: blobs between nodes", "Running bun test", "31 tools · 80k · 3m 25s"],
    ["Review Task 2", "Working", "0 tools · 0 · 3m 25s"],
    ["f1", "done 4m ago", "14 tools · 37k · 1m 22s"],
    ["f2", "stopped with the session", "14 tools · 37k · 1m 22s"],
    ["f3", "failed", "1 tool · 37k · 1m 22s"],
  ]);
  expect(earlier).toBe("2 earlier: 1 stopped, 1 done");
  expect(panelRows(list, NOW, true)).toMatchObject({ earlier: null });
  expect(panelRows(list, NOW, true).rows).toHaveLength(7);
  const many = Array.from({ length: 30 }, (_, i) => finished(i));
  expect(panelRows(many, NOW, false)).toMatchObject({ earlier: "27 earlier: 27 done" });
  expect(panelRows(many, NOW, false).rows).toHaveLength(3);
  expect(panelRows([], NOW, false)).toEqual({ rows: [], earlier: null });
});

test("toolCount says how many tools, one tool in the singular", () => {
  expect([0, 1, 2, 44].map(toolCount)).toEqual(["0 tools", "1 tool", "2 tools", "44 tools"]);
});

test("rootOf follows an agent's parents up to the outermost listed one", () => {
  const outer = agentEntry("outer", { seq: 10 });
  const middle = agentEntry("middle", { seq: 40, parent: "outer" });
  const inner = agentEntry("inner", { seq: 90, parent: "middle" });
  const list = [inner, middle, outer];
  expect(rootOf(inner, list)).toBe(outer);
  expect(rootOf(outer, list)).toBe(outer);
  // A parent the list does not hold (a background command's id, say) ends the climb.
  expect(rootOf(agentEntry("lost", { parent: "gone" }), list).description).toBe("lost");
  // Parents in a loop end too.
  const a = agentEntry("a", { parent: "b" });
  const b = agentEntry("b", { parent: "a" });
  expect([a, b]).toContain(rootOf(a, [a, b]));
});

test("foldedLine: the running agents with their times, then the rest; or that all are finished", () => {
  const list = [
    agentEntry("Implement Task 3"), agentEntry("Review Task 2", { startedAt: "2026-11-17T19:39:19.000Z" }),
    agentEntry("x", { state: "completed" }), agentEntry("y", { state: "stopped" }),
  ];
  expect(foldedLine(list, NOW)).toBe("2 agents running: Implement Task 3 (3m 25s), Review Task 2 (41s) · 1 done · 1 stopped");
  expect(foldedLine([agentEntry("a")], NOW)).toBe("1 agent running: a (3m 25s)");
  expect(foldedLine([agentEntry("x", { state: "completed" }), agentEntry("y", { state: "completed" })], NOW)).toBe("2 agents, all finished");
});
test("composerKey: ↑ on the box's first line, or Esc, takes queued messages back; otherwise they are the box's", () => {
  const key = (k: Partial<Parameters<typeof composerKey>[0]>) => ({ key: "ArrowUp", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 38, ...k });
  const q = { running: true, touch: false, anyQueued: true, value: "one\ntwo", caret: 2 };
  expect(composerKey(key({}), q)).toBe("take-back");
  expect(composerKey(key({ key: "Escape", keyCode: 27 }), { ...q, caret: 6 })).toBe("take-back");
  expect(composerKey(key({}), { ...q, caret: 6 })).toBeNull(); // second line
  expect(composerKey(key({}), { ...q, caret: 3 })).toBe("take-back"); // end of the first line
  expect(composerKey(key({}), { ...q, anyQueued: false })).toBeNull();
  expect(composerKey(key({ key: "Escape", keyCode: 27 }), { ...q, anyQueued: false })).toBeNull();
  expect(composerKey(key({ shiftKey: true }), q)).toBeNull();
  expect(composerKey(key({ isComposing: true }), q)).toBeNull();
});
test("withTakenBack: the texts, oldest first, above what the box held; the caret keeps its place in it", () => {
  expect(withTakenBack(["a", "b"], "", 0)).toEqual({ text: "a\nb", caret: 3 });
  expect(withTakenBack(["a", "b"], "xyz", 1)).toEqual({ text: "a\nb\nxyz", caret: 5 });
  expect(withTakenBack([], "xyz", 1)).toEqual({ text: "xyz", caret: 1 });
});

// ─── the train page ───

const titled = (...pairs: Array<[string, string]>) => new Map(pairs.map(([id, title]) => [id, { title }]));

test("trainColumns hangs the batch under its merge task and marks the current step", () => {
  const titles = titled(["a", "Small Changes view"], ["b", "Drag and drop"], ["c", "Forcing a queued message"], ["m", "Merge Small Changes view, Drag and drop"]);
  const state: TrainView = {
    paused: null,
    round: { step: "checking", batch: ["a", "b"], mergeTask: "m" },
    queued: [
      { taskId: "c", state: "rebasing onto main", reason: null },
      { taskId: "a", state: "in the batch", reason: null },
      { taskId: "b", state: "in the batch", reason: null },
      { taskId: "z", state: "queued", reason: null },
    ],
  };
  expect(trainColumns(state, titles)).toEqual({
    // the batch is in the round's column, not the queue's; a task the pool does not list is shown by its id
    queued: [{ taskId: "c", title: "Forcing a queued message", state: "rebasing onto main" }, { taskId: "z", title: "z", state: "queued" }],
    round: {
      steps: [
        { name: "describing", done: true, now: false },
        { name: "picking", done: true, now: false },
        { name: "checking", done: false, now: true },
        { name: "landing", done: false, now: false },
      ],
      mergeTask: "m",
      batch: [{ taskId: "a", title: "Small Changes view" }, { taskId: "b", title: "Drag and drop" }],
    },
    paused: null,
  });
});

test("trainColumns: each step is the current one in turn, and rebasing follows landing", () => {
  const at = (step: "describing" | "picking" | "checking" | "landing" | "rebasing") =>
    trainColumns({ paused: null, round: { step, batch: [], mergeTask: null }, queued: [] }, new Map()).round!.steps.map((s) => (s.now ? `[${s.name}]` : s.done ? `${s.name}✓` : s.name));
  expect(at("describing")).toEqual(["[describing]", "picking", "checking", "landing"]);
  expect(at("picking")).toEqual(["describing✓", "[picking]", "checking", "landing"]);
  expect(at("landing")).toEqual(["describing✓", "picking✓", "checking✓", "[landing]"]);
  expect(at("rebasing")).toEqual(["describing✓", "picking✓", "checking✓", "landing✓", "[rebasing]"]);
});

test("trainColumns: before the batch is checked its tasks stay in the queue, with what the train is doing to them", () => {
  const titles = titled(["a", "A"], ["b", "B"]);
  const describing = trainColumns({
    paused: null,
    round: { step: "describing", batch: ["a"], mergeTask: null },
    queued: [{ taskId: "a", state: "describing", reason: null }, { taskId: "b", state: "sitting out", reason: "its turn failed" }],
  }, titles);
  expect(describing.queued).toEqual([{ taskId: "a", title: "A", state: "describing" }, { taskId: "b", title: "B", state: "sitting out" }]);
  expect(describing.round).toMatchObject({ mergeTask: null, batch: [] });
  // a single head lands without a merge task: the batch still shows
  const landing = trainColumns({
    paused: null,
    round: { step: "landing", batch: ["a"], mergeTask: null },
    queued: [{ taskId: "a", state: "in the batch", reason: null }],
  }, titles);
  expect(landing.queued).toEqual([]);
  expect(landing.round).toMatchObject({ mergeTask: null, batch: [{ taskId: "a", title: "A" }] });
});

test("trainColumns: no round, a paused train, an empty one", () => {
  expect(trainColumns({ paused: null, round: null, queued: [] }, new Map())).toEqual({ queued: [], round: null, paused: null });
  const paused = trainColumns({ paused: "you paused it", round: null, queued: [{ taskId: "a", state: "queued", reason: "x includes work from y, which isn't queued" }] }, titled(["a", "A"]));
  expect(paused).toEqual({ queued: [{ taskId: "a", title: "A", state: "queued" }], round: null, paused: "you paused it" });
});

test("resumeLabel, pausedText and queuedChip: Resume and Paused after the user's pause, Retry and Stuck after the train's own; chips in the page's words", () => {
  expect(resumeLabel("you paused it")).toBe("Resume");
  expect(pausedText("you paused it")).toBe("Paused");
  expect(pausedText("the merge agent got stuck")).toBe("Stuck");
  expect(queuedChip("sitting out")).toBe("blocked");
  expect(queuedChip("waiting for gem")).toBe("gem offline");
  expect(queuedChip("describing")).toBe("describing");
  expect(resumeLabel("the merge agent gave no verdict after 3 follow-ups")).toBe("Retry");
});

test("trainOffer: Accept for an idle or running task, Unqueue for a queued one, nothing for a merge task or one that cannot", () => {
  const t = (over: Partial<Parameters<typeof trainOffer>[0]> = {}) => trainOffer({ state: "idle", queued: false, merge: false, moving: false, projects: 1, ...over });
  expect(t()).toBe("accept");
  expect(t({ state: "running" })).toBe("accept");
  expect(t({ state: "waiting" })).toBeNull();
  expect(t({ state: "archived" })).toBeNull();
  expect(t({ state: "moved" })).toBeNull();
  expect(t({ moving: true })).toBeNull();
  expect(t({ merge: true })).toBeNull();
  expect(t({ queued: true })).toBe("unqueue");
  expect(t({ queued: true, state: "running" })).toBe("unqueue");
  expect(t({ queued: true, state: "waiting" })).toBe("unqueue");
  expect(t({ queued: true, moving: true })).toBeNull();
  expect(t({ queued: true, state: "archived" })).toBeNull();
  // a node of an older meddle says nothing of a queue: neither is offered
  expect(t({ queued: null })).toBeNull();
  expect(t({ queued: null, state: "running" })).toBeNull();
  // a task with no project has no train; one with several is offered Accept, which the node refuses saying why
  expect(t({ projects: 0 })).toBeNull();
  expect(t({ projects: 0, state: "running" })).toBeNull();
  expect(t({ projects: 2 })).toBe("accept");
});

test("mergeStatus: what the merge task's card says it is doing", () => {
  expect(mergeStatus("checking", null)).toBe("starting");
  expect(mergeStatus("checking", "running")).toBe("running");
  expect(mergeStatus("checking", "waiting")).toBe("waiting on you");
  expect(mergeStatus("checking", "idle")).toBe("verifying");
  expect(mergeStatus("landing", "idle")).toBe("landing");
});

test("trainError: a home older than the train is said to run an older meddle, any other error shows as it came", () => {
  const older = "upgrade_required: contract_mismatch: meddle.project@1 does not cover the consumer's description (default.train missing or of another kind)";
  expect(trainError(older, "gem")).toBe("gem runs an older meddle");
  expect(trainError("not_in_variant: train", "gem")).toBe("gem runs an older meddle");
  expect(trainError("connection reset", "gem")).toBe("connection reset");
});

test("syncRows lists only the scopes not in step, by what they wait on", () => {
  const name = (id: string) => (id === "n2" ? "gem" : id);
  const project = (id: string) => (id === "p1" ? "meddle" : null);
  expect(syncRows([{ scope: "profile", head: "a", behind: 0, waiting: [] }], name, project)).toEqual([]);
  expect(syncRows([
    { scope: "profile", head: "a", behind: 2, waiting: [] },
    { scope: "memory/p1", head: "b", behind: 0, waiting: [{ node: "n2", why: "fetch" }] },
    { scope: "memory/p9", head: "c", behind: 0, waiting: [{ node: "n2", why: "rule" }, { node: "n3", why: "seed" }] },
  ], name, project)).toEqual([
    { label: "Profile", text: "2 behind" },
    { label: "Memory of meddle", text: "waiting for gem" },
    { label: "Memory of p9", text: "other merge rules: gem" },
  ]);
});
