// test/lines.test.ts — a task's line on the project's home: `refs/remotes/meddle/task/<id>/<name>`, which jj shows as
// the read-only `task/<id>/<name>@meddle`, written, pushed, fetched and released.
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { loadConfig, paths, type NodeConfig } from "../src/config";
import { cloneColocated, git, initColocated, jj, JjError } from "../src/jj";
import { shortId } from "../src/pool/identity";
import { fetchLines, homeLines, pushLines, releaseGoneLines, releaseLines, whereIs, writeLine } from "../src/projects/lines";
import { PeerObject } from "../src/state/contracts";
import { getTask } from "../src/store/records";
import { TaskRunner } from "../src/tasks/durable";
import { openHarness } from "../src/tasks/harness";
import { readManifest } from "../src/tasks/manifest";
import { createTask, replay, setupNode } from "./helpers";
import { peerReady, twoPoolNodes, type GitPoolNode } from "./pool-helpers";

type Fixture = {
  cfg: NodeConfig;
  /** The user's own colocated checkout: P → W, with `@` on W. */
  home: string;
  P: string;
  W: string;
  close(): Promise<void>;
};

const log = (cfg: NodeConfig, repo: string, rev: string, template: string) =>
  jj(["log", "--ignore-working-copy", "-r", rev, "--no-graph", "-T", template], repo, cfg).then((s) => s.trim());

async function fixture(): Promise<Fixture> {
  const dir = await mkdtemp("/tmp/meddle-lines-");
  const cfg = loadConfig({ HOME: dir, MEDDLE_DATA_DIR: `${dir}/d` });
  const home = `${dir}/home`;
  await initColocated(home, cfg);
  await writeFile(`${home}/p`, "p\n");
  await jj(["commit", "-m", "P"], home, cfg);
  await writeFile(`${home}/w`, "w\n");
  await jj(["describe", "-m", "W"], home, cfg);
  const W = (await jj(["log", "-r", "@", "--no-graph", "-T", "commit_id"], home, cfg)).trim();
  const P = await log(cfg, home, "@-", "commit_id");
  return { cfg, home, P, W, close: () => rm(dir, { recursive: true, force: true }) };
}

/** The commit git's ref `ref` names in `repo`, or null when there is none. */
async function refOf(cfg: NodeConfig, repo: string, ref: string): Promise<string | null> {
  const out = await git(["for-each-ref", "--format=%(objectname)", ref], repo, cfg);
  return out.trim() === "" ? null : out.trim();
}

test("writeLine shows task/<id>/<name>@meddle and makes W and P immutable", async () => {
  const f = await fixture();
  try {
    await writeLine(f.cfg, f.home, "t1", "app", f.W);
    expect(await jj(["bookmark", "list", "--ignore-working-copy", "--all-remotes", "-T", 'name ++ "@" ++ remote ++ "\\n"', "glob:task/*"], f.home, f.cfg)).toBe("task/t1/app@meddle\n");
    expect(await log(f.cfg, f.home, f.W, "immutable")).toBe("true");
    expect(await log(f.cfg, f.home, f.P, "immutable")).toBe("true");
    expect(await log(f.cfg, f.home, "immutable()", 'commit_id ++ "\\n"')).toContain(f.W);
  } finally {
    await f.close();
  }
});

test("homeLines lists the lines by name, of one task or of every task", async () => {
  const f = await fixture();
  try {
    await writeLine(f.cfg, f.home, "t1", "app", f.W);
    await writeLine(f.cfg, f.home, "t1", "app.b", f.P);
    await writeLine(f.cfg, f.home, "t2", "app", f.P);
    expect(await homeLines(f.cfg, f.home, "t1")).toEqual([
      { taskId: "t1", name: "app", commitId: f.W },
      { taskId: "t1", name: "app.b", commitId: f.P },
    ]);
    expect((await homeLines(f.cfg, f.home)).map((l) => `${l.taskId}/${l.name}`)).toEqual(["t1/app", "t1/app.b", "t2/app"]);
    expect(await homeLines(f.cfg, f.home, "t3")).toEqual([]);
  } finally {
    await f.close();
  }
});

test("releaseLines keeps the user's commits and @", async () => {
  const f = await fixture();
  try {
    await writeLine(f.cfg, f.home, "t1", "app", f.W);
    await jj(["new", f.W], f.home, f.cfg);
    expect(await releaseLines(f.cfg, f.home, "t1", [])).toEqual(["app"]);
    expect(await refOf(f.cfg, f.home, "refs/remotes/meddle/task/t1/app")).toBeNull();
    expect(await homeLines(f.cfg, f.home, "t1")).toEqual([]);
    expect(await log(f.cfg, f.home, `${f.W} | ${f.P}`, 'commit_id ++ " " ++ immutable ++ "\\n"')).toBe(`${f.W} false\n${f.P} false`);
    expect(await log(f.cfg, f.home, `visible_heads() & (${f.W} | ${f.P})::`, "commit_id")).not.toBe("");
    expect(await log(f.cfg, f.home, "@-", "commit_id")).toBe(f.W);
  } finally {
    await f.close();
  }
});

test("releaseLines with keep releases the other names and leaves the other tasks alone", async () => {
  const f = await fixture();
  try {
    await writeLine(f.cfg, f.home, "t1", "p", f.W);
    await writeLine(f.cfg, f.home, "t1", "p.x", f.P);
    await writeLine(f.cfg, f.home, "t2", "p", f.P);
    expect(await releaseLines(f.cfg, f.home, "t1", ["p"])).toEqual(["p.x"]);
    expect(await homeLines(f.cfg, f.home)).toEqual([
      { taskId: "t1", name: "p", commitId: f.W },
      { taskId: "t2", name: "p", commitId: f.P },
    ]);
    // The line held P, which t2's line still holds; W stays held by t1's line.
    expect(await log(f.cfg, f.home, f.W, "immutable")).toBe("true");
  } finally {
    await f.close();
  }
});

test("pushLines puts a task's bookmarks on the home as its line and fetchLines brings them back, pruning", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const home = A.project.replica;
    await writeFile(`${home}/w`, "w\n");
    await jj(["commit", "-m", "W"], home, A.cfg);
    const W = (await jj(["log", "-r", "@-", "--no-graph", "-T", "commit_id"], home, A.cfg)).trim();
    await writeLine(A.cfg, home, "t1", "a", W);
    await peerReady(B, A);
    await peerReady(A, B);

    const project = { ...A.project, home: A.id };
    const repo = `${B.home}/r`;
    await cloneColocated(`meddle://${A.id}/project/${A.project.id}`, repo, B.cfg, shortId(A.id));
    // Nothing under the namespace is nothing to push.
    await pushLines(B.cfg, repo, project, "t2");
    expect((await homeLines(A.cfg, home)).map((l) => l.taskId)).toEqual(["t1"]);

    // The line comes down as mutable local bookmarks; the holder rewrites it and pushes it back, forced.
    expect(await fetchLines(B.cfg, repo, project, A.id, "t1", "home")).toEqual([{ name: "a", commitId: W }]);
    expect(await log(B.cfg, repo, "meddle/task/t1/a", "immutable")).toBe("false");
    await jj(["describe", "-r", "meddle/task/t1/a", "-m", "W, reworded"], repo, B.cfg);
    const W2 = await log(B.cfg, repo, "meddle/task/t1/a", "commit_id");
    expect(W2).not.toBe(W);
    await pushLines(B.cfg, repo, project, "t1");
    expect(await homeLines(A.cfg, home, "t1")).toEqual([{ taskId: "t1", name: "a", commitId: W2 }]);

    // A stale local side bookmark goes when the home does not have it.
    await jj(["bookmark", "create", "meddle/task/t1/a.old", "-r", "@-"], repo, B.cfg);
    expect(await fetchLines(B.cfg, repo, project, A.id, "t1", "home")).toEqual([{ name: "a", commitId: W2 }]);
  } finally {
    await close();
  }
}, 60_000);

test("PeerObject.releaseLines releases a line on the home and is refused on another node", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const repo = A.project.replica;
    await writeFile(`${repo}/w`, "w\n");
    await jj(["commit", "-m", "W"], repo, A.cfg);
    const W = (await jj(["log", "-r", "@-", "--no-graph", "-T", "commit_id"], repo, A.cfg)).trim();
    await writeLine(A.cfg, repo, "t1", "a", W);
    await writeLine(A.cfg, repo, "t1", "a.b", W);
    await peerReady(B, A);
    await peerReady(A, B);

    const onA = await B.pool.peerRef(A.id, PeerObject);
    try {
      if (onA.variant !== "peer") throw new Error("expected the peer variant");
      // A task id goes into a jj pattern: one safe segment only, never a glob that would name another task's lines.
      await expect(onA.releaseLines({ projectId: A.project.id, taskId: "*", keep: [] })).rejects.toThrow("invalid task id: *");
      expect((await homeLines(A.cfg, repo, "t1")).length).toBe(2);
      expect(await onA.releaseLines({ projectId: A.project.id, taskId: "t1", keep: ["a"] })).toEqual({ released: ["a.b"] });
    } finally {
      onA.release();
    }
    expect(await homeLines(A.cfg, repo, "t1")).toEqual([{ taskId: "t1", name: "a", commitId: W }]);

    const onB = await A.pool.peerRef(B.id, PeerObject);
    try {
      if (onB.variant !== "peer") throw new Error("expected the peer variant");
      await expect(onB.releaseLines({ projectId: A.project.id, taskId: "t1", keep: [] })).rejects.toThrow(`not the home of ${shortId(A.project.id)}`);
    } finally {
      onB.release();
    }
    expect(await homeLines(A.cfg, repo, "t1")).toEqual([{ taskId: "t1", name: "a", commitId: W }]);
  } finally {
    await close();
  }
}, 15_000);

test("PeerObject.taskHeld and whereIs say where a task is", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    await peerReady(B, A);
    await peerReady(A, B);
    const m = await createTask(B, { title: "t", projectIds: [A.project.id] });
    const onB = await A.pool.peerRef(B.id, PeerObject);
    try {
      if (onB.variant !== "peer") throw new Error("expected the peer variant");
      expect(await onB.taskHeld({ id: m.id })).toBe(true);
      expect(await onB.taskHeld({ id: "nope" })).toBe(false);
    } finally {
      onB.release();
    }
    const deps = { cfg: A.cfg, db: A.db, pool: A.pool };
    expect(await whereIs(deps, m.id)).toBe("held");
    expect(await whereIs(deps, "nope")).toBe("gone");
  } finally {
    await close();
  }
}, 30_000);

/** Sends `text` to the task on `node` and waits for the turn to end. */
async function promptAndWait(node: GitPoolNode, taskId: string, text: string): Promise<void> {
  const idle = new Promise<void>((res) => {
    let ran = false;
    const off = node.runner.onState((id, s) => {
      if (id !== taskId) return;
      if (s === "running") ran = true;
      else if (s === "idle" && ran) { off(); res(); }
    });
  });
  await node.runner.prompt(taskId, text);
  await idle;
}

/** Gives the home repo of `node`'s project a commit of the user's, `main`; returns its commit id. */
async function userCommit(node: GitPoolNode): Promise<string> {
  const home = node.project.replica;
  await writeFile(`${home}/mine`, "mine\n");
  await jj(["commit", "-m", "mine"], home, node.cfg);
  await jj(["bookmark", "set", "main", "-r", "@-"], home, node.cfg);
  return log(node.cfg, home, "main", "commit_id");
}

/** The git refs under `prefix` in `repo`, one `<ref> <commit>` each. */
async function refsIn(cfg: NodeConfig, repo: string, prefix: string): Promise<string[]> {
  return (await git(["for-each-ref", "--format=%(refname) %(objectname)", prefix], repo, cfg)).split("\n").filter(Boolean);
}

/** Polls `get` until it returns `want`; fails with the last value after 15 s. */
async function untilValue<T>(what: string, get: () => Promise<T>, want: T): Promise<void> {
  const end = Date.now() + 15_000;
  for (;;) {
    const got = await get();
    if (JSON.stringify(got) === JSON.stringify(want)) return;
    if (Date.now() > end) throw new Error(`${what} is still ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
    await Bun.sleep(50);
  }
}

/** Takes `a` and `b` off each other's network, and waits until each sees the other offline. */
async function partition(a: GitPoolNode, b: GitPoolNode): Promise<void> {
  a.net.unwatch(b.id, "bye");
  b.net.unwatch(a.id, "bye");
  await untilValue("the nodes offline to each other", async () => !a.net.isOnline(b.id) && !b.net.isOnline(a.id), true);
}

/** Puts `a` and `b` back on each other's network. */
function rejoin(a: GitPoolNode, b: GitPoolNode): void {
  a.net.watch(b.id);
  b.net.watch(a.id);
  a.net.offerAddress(a.pool.store.row(b.id)!.lastAddr!);
  b.net.offerAddress(b.pool.store.row(a.id)!.lastAddr!);
}

test("a home task's turn end writes task/<id>/<project>@meddle at its bookmark, and the user's repo then refuses to describe it", async () => {
  const { A, close } = await twoPoolNodes();
  try {
    const home = A.project.replica;
    const m = await createTask(A, { title: "t", projectIds: [A.project.id] });
    await writeFile(join(paths(A.cfg).task(m.id), "a", "work"), "work\n");
    await promptAndWait(A, m.id, "Reply with the single word ok.");
    const head = await log(A.cfg, home, `meddle/task/${m.id}/a`, "commit_id");
    expect(await homeLines(A.cfg, home, m.id)).toEqual([{ taskId: m.id, name: "a", commitId: head }]);
    expect(await log(A.cfg, home, `task/${m.id}/a@meddle`, "commit_id")).toBe(head);
    const refused = await jj(["--ignore-working-copy", "describe", "-r", head, "-m", "mine"], home, A.cfg).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(JjError);
    expect((refused as JjError).stderr).toContain(`Commit ${head.slice(0, 12)} is immutable`);
    expect(A.logs.filter((l) => l.startsWith("meddle: push:") || l.startsWith("meddle: give back:"))).toEqual([]);
  } finally {
    await close();
  }
}, 30_000);

test("a remote task's turn end pushes the same ref to the home, and the home's refs/heads/meddle/task/* stay untouched", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const home = A.project.replica;
    // A bookmark under the namespace in the home repo itself: no line write touches it.
    await jj(["bookmark", "create", "meddle/task/old/a", "-r", await userCommit(A)], home, A.cfg);
    const bookmarksBefore = await refsIn(A.cfg, home, "refs/heads/meddle/task");
    expect(bookmarksBefore).toHaveLength(1);
    await peerReady(B, A);
    const m = await createTask(B, { title: "t", projectIds: [A.project.id] });
    await writeFile(join(paths(B.cfg).task(m.id), "a", "work"), "work\n");
    await promptAndWait(B, m.id, "Reply with the single word ok.");
    const head = await log(B.cfg, paths(B.cfg).replica(A.project.id), `meddle/task/${m.id}/a`, "commit_id");
    expect(await homeLines(A.cfg, home, m.id)).toEqual([{ taskId: m.id, name: "a", commitId: head }]);
    expect(await refsIn(A.cfg, home, `refs/remotes/meddle/task/${m.id}`)).toEqual([`refs/remotes/meddle/task/${m.id}/a ${head}`]);
    expect(await log(A.cfg, home, head, "immutable")).toBe("true");
    expect(await refsIn(A.cfg, home, "refs/heads/meddle/task")).toEqual(bookmarksBefore);
    expect(B.logs.filter((l) => l.startsWith("meddle: push:") || l.startsWith("meddle: give back:"))).toEqual([]);
  } finally {
    await close();
  }
}, 30_000);

test("the agent's workspace can describe its line's head but not its base", async () => {
  const { A, close } = await twoPoolNodes();
  try {
    const home = A.project.replica;
    const mine = await userCommit(A);
    const m = await createTask(A, { title: "t", projectIds: [A.project.id] });
    expect((await readManifest(A.cfg, m.id)).projects[0]!.base).toBe(mine);
    const workspace = join(paths(A.cfg).task(m.id), "a");
    await writeFile(join(workspace, "work"), "work\n");
    await promptAndWait(A, m.id, "Reply with the single word ok.");
    const head = await log(A.cfg, home, `task/${m.id}/a@meddle`, "commit_id");
    expect(await log(A.cfg, workspace, "@", "commit_id")).toBe(head);
    expect(await log(A.cfg, workspace, "@-", "commit_id")).toBe(mine);

    await jj(["describe", "-r", head, "-m", "by the agent"], workspace, A.cfg);
    expect(await log(A.cfg, workspace, "@", "description")).toBe("by the agent");
    const refused = await jj(["describe", "-r", mine, "-m", "not the agent's"], workspace, A.cfg).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(JjError);
    expect((refused as JjError).stderr).toContain(`Commit ${mine.slice(0, 12)} is immutable`);
    expect(await log(A.cfg, home, mine, "description")).toBe("mine");
  } finally {
    await close();
  }
}, 30_000);

test("a side bookmark the agent deleted is released on the home at the next turn end, and the project's line is kept", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const home = A.project.replica;
    await peerReady(B, A);
    // Held on the home itself, and on another node.
    for (const holder of [A, B]) {
      const m = await createTask(holder, { title: "t", projectIds: [A.project.id] });
      const workspace = join(paths(holder.cfg).task(m.id), "a");
      await writeFile(join(workspace, "spike"), "spike\n");
      await jj(["commit", "-m", "spike"], workspace, holder.cfg);
      await jj(["bookmark", "create", `meddle/task/${m.id}/a.spike`, "-r", "@-"], workspace, holder.cfg);
      await promptAndWait(holder, m.id, "Reply with the single word ok.");
      expect((await homeLines(A.cfg, home, m.id)).map((l) => l.name)).toEqual(["a", "a.spike"]);

      await jj(["bookmark", "delete", `exact:meddle/task/${m.id}/a.spike`], workspace, holder.cfg);
      await promptAndWait(holder, m.id, "Again.");
      const head = await log(holder.cfg, workspace, "@", "commit_id");
      expect(await homeLines(A.cfg, home, m.id)).toEqual([{ taskId: m.id, name: "a", commitId: head }]);
      expect(holder.logs.filter((l) => l.startsWith("meddle: push:") || l.startsWith("meddle: give back:"))).toEqual([]);
    }
  } finally {
    await close();
  }
}, 60_000);

test("a push that failed while the home was offline is made again when the home comes back, with no turn", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const home = A.project.replica;
    await peerReady(B, A);
    const m = await createTask(B, { title: "t", projectIds: [A.project.id] });
    const workspace = join(paths(B.cfg).task(m.id), "a");
    await promptAndWait(B, m.id, "Reply with the single word ok.");
    const first = (await homeLines(A.cfg, home, m.id))[0]?.commitId;
    expect(first).toBeDefined();

    await partition(A, B);
    await writeFile(join(workspace, "work"), "work\n");
    await promptAndWait(B, m.id, "Again.");
    const line = await log(B.cfg, paths(B.cfg).replica(A.project.id), `meddle/task/${m.id}/a`, "commit_id");
    expect(line).not.toBe(first);
    expect(B.logs).toContain(`meddle: push: meddle/task/${m.id}/* to ${shortId(A.id)} failed: home ${shortId(A.id)} is offline`);
    expect((await homeLines(A.cfg, home, m.id))[0]?.commitId).toBe(first);

    rejoin(A, B);
    await untilValue("the line on the home", async () => (await homeLines(A.cfg, home, m.id))[0]?.commitId, line);
    expect(getTask(B.db, m.id)!.turns).toBe(2);
  } finally {
    await close();
  }
}, 60_000);

test("a runner started while a task's home is offline writes the task's line once the home is back, with no turn", async () => {
  const { A, B, close } = await twoPoolNodes();
  let reopened: { close(): Promise<void> } | undefined;
  try {
    const home = A.project.replica;
    await peerReady(B, A);
    const m = await createTask(B, { title: "t", projectIds: [A.project.id] });
    await promptAndWait(B, m.id, "Reply with the single word ok.");
    const first = (await homeLines(A.cfg, home, m.id))[0]?.commitId;
    await partition(A, B);
    // The task's bookmark moved, and the node stopped before any push of it: the runner that starts knows nothing of it.
    await writeFile(join(paths(B.cfg).task(m.id), "a", "work"), "work\n");
    await B.runner.setTaskBookmarks(await readManifest(B.cfg, m.id));
    const line = await log(B.cfg, paths(B.cfg).replica(A.project.id), `meddle/task/${m.id}/a`, "commit_id");
    expect(line).not.toBe(first);
    await B.harness.close();
    const harness = await openHarness(B.cfg, createRegistry());
    reopened = harness;
    new TaskRunner(B.cfg, B.db, harness.harness, {
      claudePath: replay, claudeRuntime: "bun", extraEnv: { MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/hello.jsonl` },
      pool: B.pool, log: (l) => B.logs.push(l),
    });

    rejoin(A, B);
    await untilValue("the line on the home", async () => (await homeLines(A.cfg, home, m.id))[0]?.commitId, line);
    expect(getTask(B.db, m.id)!.turns).toBe(1);
  } finally {
    await reopened?.close();
    await close();
  }
}, 60_000);

test("the janitor releases the line of a task gone from every node, and keeps one an offline node may hold", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const home = A.project.replica;
    const deps = { cfg: A.cfg, db: A.db, pool: A.pool };
    const W = await userCommit(A);
    // A task gone from every node, and one held here.
    await writeLine(A.cfg, home, "gone", "a", W);
    await writeLine(A.cfg, home, "gone", "a.b", W);
    const held = await createTask(A, { title: "held", projectIds: [A.project.id] });
    await writeLine(A.cfg, home, held.id, "a", W);
    await peerReady(A, B);

    expect(await releaseGoneLines(deps)).toBe(1);
    expect(await homeLines(A.cfg, home, "gone")).toEqual([]);
    expect((await homeLines(A.cfg, home)).map((l) => l.taskId)).toEqual([held.id]);

    // With B offline, a task no online node holds may be on B: its line stays.
    await writeLine(A.cfg, home, "maybe", "a", W);
    await partition(A, B);
    expect(await releaseGoneLines(deps)).toBe(0);
    expect((await homeLines(A.cfg, home)).map((l) => l.taskId).sort()).toEqual([held.id, "maybe"].sort());
  } finally {
    await close();
  }
}, 60_000);

test("the janitor releases the line of a task that moved away and was then deleted where it went: a moved row holds nothing", async () => {
  const { insertTask, updateTask } = await import("../src/store/records");
  const { A, B, close } = await twoPoolNodes();
  try {
    const home = A.project.replica;
    const deps = { cfg: A.cfg, db: A.db, pool: A.pool };
    const W = await userCommit(A);
    const moved = (db: typeof A.db, id: string, to: string) => {
      insertTask(db, { id, title: id, state: "moved", session_id: `s-${id}`, manifest: "{}", started: 1, turns: 1 });
      updateTask(db, id, { moved_to: to });
    };
    // One moved from A to B, one from B to A, each deleted there while A was offline: only the moved rows are left.
    moved(A.db, "fromhome", B.id);
    moved(B.db, "fromb", A.id);
    await writeLine(A.cfg, home, "fromhome", "a", W);
    await writeLine(A.cfg, home, "fromb", "a", W);
    await peerReady(A, B);
    expect(await whereIs(deps, "fromhome")).toBe("gone");
    expect(await whereIs(deps, "fromb")).toBe("gone");
    expect(await releaseGoneLines(deps)).toBe(2);
    expect(await homeLines(A.cfg, home)).toEqual([]);
  } finally {
    await close();
  }
}, 60_000);

test("setting a task's bookmarks on the home never snapshots the user's checkout", async () => {
  const node = await setupNode();
  try {
    const { cfg, project, runner } = node;
    const home = project.replica;
    const m = await createTask(node, { title: "t", projectIds: [project.id] });
    // An edit in the user's checkout that no jj command has seen yet.
    await writeFile(`${home}/edited.txt`, "mine\n");
    await writeFile(join(paths(cfg).task(m.id), "a", "work"), "work\n");
    await runner.setTaskBookmarks(await readManifest(cfg, m.id));
    // The task's own working copy was snapshotted into its bookmark; the user's was not.
    expect(await jj(["diff", "--ignore-working-copy", "-r", `meddle/task/${m.id}/a`, "--name-only"], home, cfg)).toContain("work");
    expect(await jj(["diff", "--ignore-working-copy", "-r", "default@", "--name-only"], home, cfg)).not.toContain("edited.txt");
  } finally {
    await node.harness.close();
    await rm(node.home, { recursive: true, force: true });
  }
}, 30_000);

test("the janitor leaves a line startAt wrote alone for an hour, though no node holds its task yet; then releases it", async () => {
  const { startPoolNode } = await import("./pool-helpers");
  const { startAt } = await import("../src/projects/starts");
  const { STARTING_MS } = await import("../src/projects/lines");
  const A = await startPoolNode();
  try {
    const home = A.project.replica;
    const deps = { cfg: A.cfg, db: A.db, pool: A.pool };
    const log: string[] = [];
    // A task being created: its start wrote the line, and no node has the task yet.
    await startAt({ cfg: A.cfg, db: A.db, selfId: A.id }, A.project.id, "creating", null, "child");
    expect((await homeLines(A.cfg, home)).map((l) => l.taskId)).toEqual(["creating"]);
    expect(await releaseGoneLines(deps, (line) => log.push(line))).toBe(0);
    expect((await homeLines(A.cfg, home)).map((l) => l.taskId)).toEqual(["creating"]);
    // An hour on, its creation is long over: no node holds it, so its line goes.
    expect(await releaseGoneLines(deps, (line) => log.push(line), Date.now() + STARTING_MS)).toBe(1);
    expect(await homeLines(A.cfg, home)).toEqual([]);
    expect(log).toEqual([]);
  } finally {
    await A.close();
  }
}, 30_000);
