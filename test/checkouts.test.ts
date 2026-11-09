// test/checkouts.test.ts — `project add` builds the project's service repo from your folder and attaches the folder as
// a checkout (a git remote `meddle` pointing at this node); `checkout` clones one. A checkout fetches the node's view
// and pushes branches to it, each push gated by the `pre-receive` hook and recorded as this node's branch rows.
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname } from "node:path";
import { paths } from "../src/config";
import { startDashboard } from "../src/dashboard/server";
import { acceptGitStreams } from "../src/git/serve";
import { bookmarkRefs, git, jj, JjError, type BookmarkRef } from "../src/jj";
import { listBranchRows, mergeBranchRows, writeBranchRow, type BranchRow } from "../src/pool/rows";
import { applyProject } from "../src/projects/applier";
import { attachCheckout, makeCheckout } from "../src/projects/checkouts";
import { addProjectFromFolder, getProject, listProjects } from "../src/projects/project";
import { meddle } from "./helpers";
import { peerReady, poolNodes, type GitPoolNode } from "./pool-helpers";

/** One pool node serving the CLI; `cli` runs `meddle` against it, with `<data>/bin` on PATH unless `path` is given. */
async function node() {
  const { nodes, close } = await poolNodes(1);
  const n = nodes[0]!;
  const dashboard = await startDashboard({ ...n.cfg, port: 0 }, n.host, n.pool);
  const port = new URL(dashboard.url).port;
  const cli = (args: string[], path = `${paths(n.cfg).bin}${delimiter}${process.env.PATH}`) =>
    meddle(args, { HOME: n.home, MEDDLE_DATA_DIR: n.cfg.dataDir, MEDDLE_PORT: port, PATH: path });
  return { n, cli, close: async () => { await dashboard.stop(); await close(); } };
}

/** `template` of `rev` in `repo`, read without a snapshot. */
const read = async (n: GitPoolNode, repo: string, rev: string, template = "commit_id") =>
  (await jj(["log", "--ignore-working-copy", "-r", rev, "--no-graph", "-T", template], repo, n.cfg)).trim();

/** A colocated folder with one commit, bookmarked `main`, and `wip` on top of it. Returns `main`'s commit. */
async function folderWithMainAndWip(n: GitPoolNode, folder: string): Promise<string> {
  await mkdir(folder, { recursive: true });
  await jj(["git", "init", "--colocate"], folder, n.cfg);
  await writeFile(`${folder}/README`, "main\n");
  await jj(["commit", "-m", "main"], folder, n.cfg);
  await jj(["bookmark", "set", "main", "-r", "@-"], folder, n.cfg);
  await writeFile(`${folder}/wip`, "wip\n");
  await jj(["commit", "-m", "wip"], folder, n.cfg);
  await jj(["bookmark", "set", "wip", "-r", "@-"], folder, n.cfg);
  return read(n, folder, "main");
}

/** A PATH with jj, git and bun on it, and nothing of meddle's. */
function pathWithoutHelper(): string {
  return [...new Set(["jj", "git"].map((tool) => dirname(Bun.which(tool)!)).concat(dirname(process.execPath)))].join(delimiter);
}

test("project add of a folder builds a service repo of its default branch, and attaches the folder as a checkout", async () => {
  const { n, cli, close } = await node();
  try {
    const folder = `${n.home}/mine`;
    const main = await folderWithMainAndWip(n, folder);
    const added = await cli(["project", "add", folder, "--name", "mine", "--no-fetch"]);
    expect(added.stderr).toBe("");
    expect(added.code).toBe(0);
    const project = getProject(n.db, added.stdout.trim())!;
    expect(project.replica).toBe(paths(n.cfg).replica(project.id));
    expect(project.replica).not.toBe(folder);
    expect(project.defaultBranch).toBe("main");

    // The folder: no workspace of meddle's, and a remote `meddle` naming this node's project.
    expect(await jj(["workspace", "list", "--ignore-working-copy", "-T", 'name ++ "\\n"'], folder, n.cfg)).toBe("default\n");
    expect((await git(["remote", "get-url", "meddle"], folder, n.cfg)).trim()).toBe(`meddle://${n.id}/project/${project.id}`);

    // The service repo: `main` from the folder and nothing else, its own `@` still on the root commit.
    const bookmarks = await jj(["bookmark", "list", "--ignore-working-copy", "-T", 'name ++ "\\n"'], project.replica, n.cfg);
    expect(bookmarks).toBe("main\n");
    expect(await read(n, project.replica, "main")).toBe(main);
    expect(await read(n, project.replica, "@-")).toBe(await read(n, project.replica, "root()"));
    expect((await git(["symbolic-ref", "HEAD"], project.replica, n.cfg)).trim()).toBe("refs/jj/root");

    // This node's row for the default branch.
    expect(listBranchRows(n.db, project.id)).toEqual([{ project: project.id, branch: "main", node: n.id, seq: 1, commit: main, drops: [] }]);
  } finally {
    await close();
  }
}, 60_000);

test("project add of a folder fetches the node's view into it, tracking main@meddle", async () => {
  const { n, cli, close } = await node();
  try {
    const folder = `${n.home}/mine`;
    const main = await folderWithMainAndWip(n, folder);
    const added = await cli(["project", "add", folder, "--name", "mine"]);
    expect(added.stderr).toBe("");
    expect(added.code).toBe(0);
    expect(await remoteMain(n, folder)).toMatchObject({ commitId: main, tracked: true });
    expect(n.logs.filter((l) => l.startsWith("meddle: git:"))).toEqual([]);
  } finally {
    await close();
  }
}, 60_000);

test("project add makes a plain folder a colocated jj repo, and refuses a jj repo without a colocated git repo", async () => {
  const { n, cli, close } = await node();
  try {
    const plain = `${n.home}/plain`;
    await mkdir(plain);
    const added = await cli(["project", "add", plain, "--no-fetch"]);
    expect(added.stderr).toBe("");
    expect(added.code).toBe(0);
    expect(await Bun.file(`${plain}/.jj/repo/store/git_target`).exists()).toBe(true);
    // Nothing to start from: the folder has neither `main` nor `master`.
    expect(getProject(n.db, added.stdout.trim())!.defaultBranch).toBeNull();

    const bare = `${n.home}/bare`;
    await mkdir(bare);
    await jj(["git", "init", "--no-colocate"], bare, n.cfg);
    const refused = await cli(["project", "add", bare, "--no-fetch"]);
    expect(refused).toEqual({ stdout: "", stderr: `meddle: ${bare} is a jj repo without a colocated git repo\n`, code: 1 });
    // The node refuses it too, reading only.
    await expect(addProjectFromFolder(n.cfg, n.db, bare, n.id)).rejects.toThrow(`${bare} is a jj repo without a colocated git repo`);
    expect(listProjects(n.db)).toHaveLength(2);
  } finally {
    await close();
  }
}, 60_000);

test("without git-remote-meddle on PATH, project add and attaching a checkout are refused", async () => {
  const { n, cli, close } = await node();
  try {
    const folder = `${n.home}/mine`;
    await folderWithMainAndWip(n, folder);
    const refusal = `git-remote-meddle is not on your PATH; add ${paths(n.cfg).bin} to it`;
    const before = listProjects(n.db).length;
    const refused = await cli(["project", "add", folder, "--no-fetch"], pathWithoutHelper());
    expect(refused).toEqual({ stdout: "", stderr: `meddle: ${refusal}\n`, code: 1 });
    // Refused before the node was asked: no project was added.
    expect(listProjects(n.db)).toHaveLength(before);

    const env = { PATH: pathWithoutHelper() };
    await expect(attachCheckout(n.cfg, n.id, folder, n.project, env)).rejects.toThrow(refusal);
    expect(await git(["remote"], folder, n.cfg)).toBe("");
    await expect(makeCheckout(n.cfg, n.id, n.project, `${n.home}/co`, env)).rejects.toThrow(refusal);
  } finally {
    await close();
  }
}, 60_000);

test("checkout refuses a directory that exists and is not empty", async () => {
  const { n, close } = await node();
  try {
    const dir = await mkdtemp(`${n.home}/co-`);
    await writeFile(`${dir}/x`, "x\n");
    const env = { PATH: `${paths(n.cfg).bin}${delimiter}${process.env.PATH}` };
    await expect(makeCheckout(n.cfg, n.id, n.project, dir, env)).rejects.toThrow(`${dir} exists and is not empty`);
  } finally {
    await close();
  }
}, 60_000);

test("project set-default sets the branch a task starts from without a revision", async () => {
  const { n, cli, close } = await node();
  try {
    expect(n.project.defaultBranch).toBe("main");
    expect(await cli(["project", "set-default", n.project.id, "dev"])).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(getProject(n.db, n.project.id)!.defaultBranch).toBe("dev");
    const unknown = await cli(["project", "set-default", "nope", "dev"]);
    expect(unknown).toEqual({ stdout: "", stderr: "meddle: unknown project: nope\n", code: 1 });
  } finally {
    await close();
  }
}, 60_000);

/** `PATH` with this node's `<data>/bin` first: what `makeCheckout` checks for the helper. */
const helperEnv = (n: GitPoolNode) => ({ PATH: `${paths(n.cfg).bin}${delimiter}${process.env.PATH}` });

/** `main@meddle` in checkout `co`, or undefined when it has none. */
async function remoteMain(n: GitPoolNode, co: string): Promise<BookmarkRef | undefined> {
  return (await bookmarkRefs(co, "exact:main", n.cfg)).find((r) => r.remote === "meddle");
}

/** The `meddle/conflict/main/<id>` bookmarks of `meddle` in checkout `co`, by name. */
async function conflictRefs(n: GitPoolNode, co: string): Promise<string[]> {
  return (await bookmarkRefs(co, "glob:meddle/conflict/*", n.cfg)).filter((r) => r.remote === "meddle").map((r) => r.name).sort();
}

/** A new commit in checkout `co` on top of `rev`, adding `file`; returns its commit id. */
async function commitIn(n: GitPoolNode, co: string, rev: string, file: string): Promise<string> {
  await jj(["new", rev], co, n.cfg);
  await writeFile(`${co}/${file}`, `${file}\n`);
  await jj(["commit", "-m", file], co, n.cfg);
  return read(n, co, "@-");
}

/** Points `main` at `commit` in checkout `co` (backwards or sideways too) and pushes it to `meddle`. */
async function pushMain(n: GitPoolNode, co: string, commit: string): Promise<void> {
  await jj(["bookmark", "set", "main", "-r", commit, "--allow-backwards"], co, n.cfg);
  await jj(["git", "push", "--remote", "meddle", "-b", "main"], co, n.cfg);
}

const fetchIn = (n: GitPoolNode, co: string) => jj(["git", "fetch", "--remote", "meddle"], co, n.cfg);

/** `n`'s own row for `main` of project `P`. */
const ownMainRow = (n: GitPoolNode, P: string): BranchRow | undefined => listBranchRows(n.db, P, "main").find((r) => r.node === n.id);

/** Drops sort as `listBranchRows` lists them: by node. */
const sortedDrops = (row: BranchRow | undefined) => [...(row?.drops ?? [])].sort((a, b) => a.node.localeCompare(b.node) || a.seq - b.seq);

async function waitFor(what: string, cond: () => Promise<boolean> | boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** Two nodes whose project (n1's) each holds a checkout of, made by `makeCheckout`: `co1` on n1, `co2` on n2. */
async function twoCheckouts() {
  const { nodes, close } = await poolNodes(2);
  const [n1, n2] = nodes as [GitPoolNode, GitPoolNode];
  try {
    await peerReady(n1, n2);
    await peerReady(n2, n1);
    const P = n1.project.id;
    await waitFor("n1's project in n2's roster", () => n2.store.row(n1.id)?.summary?.projects.some((p) => p.id === P) === true);
    const co1 = await makeCheckout(n1.cfg, n1.id, n1.project, `${n1.home}/co1`, helperEnv(n1));
    const co2 = await makeCheckout(n2.cfg, n2.id, n1.project, `${n2.home}/co2`, helperEnv(n2));
    return { n1, n2, P, co1, co2, m: ownMainRow(n1, P)!.commit!, close };
  } catch (err) {
    await close();
    throw err;
  }
}

test("a checkout tracks main@meddle, and a fast-forward it pushes is a row that a checkout on another node fetches", async () => {
  const { n1, n2, P, co1, co2, m, close } = await twoCheckouts();
  try {
    // Both clones track the default branch, at the project's main.
    expect(await remoteMain(n1, co1)).toMatchObject({ commitId: m, tracked: true });
    expect(await remoteMain(n2, co2)).toMatchObject({ commitId: m, tracked: true });
    expect(await read(n1, co1, "main")).toBe(m);

    const x = await commitIn(n1, co1, "main", "x");
    await pushMain(n1, co1, x);
    expect(listBranchRows(n1.db, P, "main")).toEqual([{ project: P, branch: "main", node: n1.id, seq: 2, commit: x, drops: [] }]);
    // The view on n1 followed at once: a fetch there changes nothing.
    await fetchIn(n1, co1);
    expect(await remoteMain(n1, co1)).toMatchObject({ commitId: x, tracked: true });

    // A fetch on n2 catches n2 up first.
    await fetchIn(n2, co2);
    expect(await remoteMain(n2, co2)).toMatchObject({ commitId: x, tracked: true });
    expect(await read(n2, co2, "main")).toBe(x);
    for (const n of [n1, n2]) expect(n.logs.filter((l) => l.startsWith("meddle: git:"))).toEqual([]);
  } finally {
    await close();
  }
}, 90_000);

test("a rewind pushed from a checkout drops every current row, and the branch is at the rewind everywhere", async () => {
  const { n1, n2, P, co1, co2, m, close } = await twoCheckouts();
  try {
    const x = await commitIn(n1, co1, "main", "x");
    await pushMain(n1, co1, x);
    await fetchIn(n2, co2);
    const y = await commitIn(n2, co2, "main", "y");
    await pushMain(n2, co2, y);
    // n2 saw n1's row: y is a fast-forward of x.
    expect(ownMainRow(n2, P)).toEqual({ project: P, branch: "main", node: n2.id, seq: 1, commit: y, drops: [] });

    await fetchIn(n1, co1);
    expect(await remoteMain(n1, co1)).toMatchObject({ commitId: y });
    await pushMain(n1, co1, m);
    const row = ownMainRow(n1, P);
    expect(row).toMatchObject({ seq: 3, commit: m });
    expect(sortedDrops(row)).toEqual([{ node: n1.id, seq: 2 }, { node: n2.id, seq: 1 }].sort((a, b) => a.node.localeCompare(b.node)));

    await fetchIn(n2, co2);
    expect(await remoteMain(n2, co2)).toMatchObject({ commitId: m });
    await fetchIn(n1, co1);
    expect(await remoteMain(n1, co1)).toMatchObject({ commitId: m });
    for (const n of [n1, n2]) {
      expect((await bookmarkRefs(getProject(n.db, P)!.replica, "exact:main", n.cfg)).find((r) => r.remote === null)?.commitId).toBe(m);
    }
  } finally {
    await close();
  }
}, 90_000);

test("a push of main together with a ref under meddle/ is rejected whole, and main's row stays as it was", async () => {
  const { n1, P, co1, m, close } = await twoCheckouts();
  try {
    const before = listBranchRows(n1.db, P);
    const x = await commitIn(n1, co1, "main", "x");
    await jj(["bookmark", "set", "main", "-r", x], co1, n1.cfg);
    await jj(["bookmark", "create", "meddle/task/x/p", "-r", x], co1, n1.cfg);
    const refused = await jj(["git", "push", "--remote", "meddle", "-b", "main", "-b", "meddle/task/x/p"], co1, n1.cfg).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(JjError);
    const stderr = (refused as JjError).stderr;
    expect(stderr).toContain("remote: ref refs/heads/meddle/task/x/p is not accepted here");
    expect(stderr).toContain("refs/heads/main (reason: pre-receive hook declined)");
    expect(stderr).toContain("Failed to push some bookmarks");
    expect(listBranchRows(n1.db, P)).toEqual(before);
    await fetchIn(n1, co1);
    expect(await remoteMain(n1, co1)).toMatchObject({ commitId: m });
    expect(n1.logs.filter((l) => l.startsWith("meddle: git:"))).toEqual([]);
  } finally {
    await close();
  }
}, 90_000);

test("a conflicted branch refuses a push not descending from every sibling, and deleting a sibling resolves it everywhere", async () => {
  const { n1, n2, P, co1, co2, m, close } = await twoCheckouts();
  try {
    // n2 has b, a child of m, from a push of another branch; its own row for main names b, never having seen a.
    const b = await commitIn(n2, co2, "main", "b");
    await jj(["bookmark", "create", "side", "-r", b], co2, n2.cfg);
    await jj(["git", "push", "--remote", "meddle", "-b", "side"], co2, n2.cfg);
    const a = await commitIn(n1, co1, "main", "a");
    await pushMain(n1, co1, a);
    writeBranchRow(n2.db, n2.id, { project: P, branch: "main", commit: b, drops: [] });
    await waitFor("n2's main row on n1", () => listBranchRows(n1.db, P, "main").some((r) => r.node === n2.id && r.commit === b));

    // The view: main at the merge base, each sibling under meddle/conflict/main/.
    await fetchIn(n1, co1);
    const siblings = [a, b].sort();
    const ids = siblings.map((s) => s.slice(0, 12));
    expect(await remoteMain(n1, co1)).toMatchObject({ commitId: m });
    expect(await conflictRefs(n1, co1)).toEqual(ids.map((id) => `meddle/conflict/main/${id}`));

    const c = await commitIn(n1, co1, a, "c");
    const rowBefore = ownMainRow(n1, P);
    const refused = await pushMain(n1, co1, c).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(JjError);
    const refusal = [
      "main is conflicted; push a merge of its siblings, or delete the ones you don't want",
      ...ids.map((id) => `  meddle/conflict/main/${id}@meddle`),
      "  to keep your own work: jj bookmark set main -r <your commit>",
    ];
    const remote = (refused as JjError).stderr.split("\n").filter((l) => l.startsWith("remote: ")).map((l) => l.slice("remote: ".length).trimEnd());
    expect(remote).toEqual(refusal);
    expect(ownMainRow(n1, P)).toEqual(rowBefore);

    // Dropping b: git, since the conflict ref arrived untracked and jj deletes only tracked bookmarks.
    await git(["push", "meddle", `:refs/heads/meddle/conflict/main/${b.slice(0, 12)}`], co1, n1.cfg);
    const row = ownMainRow(n1, P);
    expect(row).toMatchObject({ seq: 3, commit: a, drops: [{ node: n2.id, seq: 1 }] });
    await waitFor("n1's dropping row on n2", () => ownMainRow(n1, P)!.seq === listBranchRows(n2.db, P, "main").find((r) => r.node === n1.id)?.seq);
    for (const [n, co] of [[n1, co1], [n2, co2]] as const) {
      await fetchIn(n, co);
      expect(await remoteMain(n, co)).toMatchObject({ commitId: a });
      expect(await conflictRefs(n, co)).toEqual([]);
      expect((await bookmarkRefs(getProject(n.db, P)!.replica, "exact:main", n.cfg)).find((r) => r.remote === null)?.commitId).toBe(a);
    }
  } finally {
    await close();
  }
}, 90_000);

test("a push to a branch whose rows name a commit this node lacks is refused, never landed and undone", async () => {
  const { nodes, close } = await poolNodes(1);
  try {
    const [n] = nodes as [GitPoolNode];
    const P = n.project.id;
    const m = ownMainRow(n, P)!.commit!;
    const co = await makeCheckout(n.cfg, n.id, n.project, `${n.home}/co`, helperEnv(n));
    // Another node's row for main, at a commit that never reached this one.
    const other = "f".repeat(64);
    mergeBranchRows(n.db, [{ project: P, branch: "main", node: other, seq: 1, commit: "e".repeat(40), drops: [] }]);
    const rows = listBranchRows(n.db, P);
    const view = () => git(["for-each-ref", "refs/namespaces/view/"], n.project.replica, n.cfg);
    const before = await view();

    const x = await commitIn(n, co, "main", "x");
    const refused = await pushMain(n, co, x).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(JjError);
    expect((refused as JjError).stderr).toContain("remote: main: this node is still fetching it; push again shortly");
    expect((refused as JjError).stderr).toContain("refs/heads/main (reason: pre-receive hook declined)");
    expect(await view()).toBe(before);
    expect(listBranchRows(n.db, P)).toEqual(rows);
    expect(await read(n, n.project.replica, "main")).toBe(m);

    // Another branch, whose rows are all here, is pushed as ever.
    await jj(["bookmark", "create", "feature", "-r", x], co, n.cfg);
    await jj(["git", "push", "--remote", "meddle", "-b", "feature"], co, n.cfg);
    expect(listBranchRows(n.db, P, "feature")).toEqual([{ project: P, branch: "feature", node: n.id, seq: 1, commit: x, drops: [] }]);
    expect(n.logs.filter((l) => l.startsWith("meddle: git:"))).toEqual([]);
  } finally {
    await close();
  }
}, 60_000);

test("without its pre-receive hook, a checkout's push is refused and nothing is recorded", async () => {
  const { nodes, close } = await poolNodes(1);
  try {
    const [n] = nodes as [GitPoolNode];
    const P = n.project.id;
    const co = await makeCheckout(n.cfg, n.id, n.project, `${n.home}/co`, helperEnv(n));
    const x = await commitIn(n, co, "main", "x");
    const rows = listBranchRows(n.db, P);
    for (const broken of ["not executable", "missing"]) {
      if (broken === "missing") await rm(paths(n.cfg).hookPreReceive);
      else await chmod(paths(n.cfg).hookPreReceive, 0o644);
      await expect(pushMain(n, co, x)).rejects.toBeInstanceOf(JjError);
    }
    expect(listBranchRows(n.db, P)).toEqual(rows);
    expect([...new Set(n.logs.filter((l) => l.startsWith("meddle: git:")))]).toEqual(["meddle: git: pre-receive hook missing; refusing receive-pack"]);
  } finally {
    await close();
  }
}, 60_000);

test("a push to a branch whose view is behind its rows is refused, and the row it would have dropped stays", async () => {
  const { nodes, close } = await poolNodes(1);
  try {
    const [n] = nodes as [GitPoolNode];
    const P = n.project.id;
    const co = await makeCheckout(n.cfg, n.id, n.project, `${n.home}/co`, helperEnv(n));
    const x = await commitIn(n, co, "main", "x");
    await pushMain(n, co, x);
    // A peer's row for main at y, a child of x whose commit is here, merged but not applied yet: the view still shows x.
    const repo = n.project.replica;
    const y = (await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", `${x}^{tree}`, "-p", x, "-m", "y"], repo, n.cfg)).trim();
    const peer = "f".repeat(64);
    mergeBranchRows(n.db, [{ project: P, branch: "main", node: peer, seq: 1, commit: y, drops: [] }]);
    const rows = listBranchRows(n.db, P);
    expect(await git(["rev-parse", "refs/namespaces/view/refs/heads/main"], repo, n.cfg)).toBe(`${x}\n`);

    // z, a child of x: a fast-forward of what the checkout sees; judged against the rows it would drop y's row.
    const z = await commitIn(n, co, x, "z");
    const refused = await pushMain(n, co, z).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(JjError);
    expect((refused as JjError).stderr).toContain("remote: main: this node is still fetching it; push again shortly");
    expect((refused as JjError).stderr).toContain("refs/heads/main (reason: pre-receive hook declined)");
    expect(listBranchRows(n.db, P)).toEqual(rows);
    expect(await git(["rev-parse", "refs/namespaces/view/refs/heads/main"], repo, n.cfg)).toBe(`${x}\n`);

    // Once a fetch has caught the view up, a push on top of y is a fast-forward that keeps y's row.
    await fetchIn(n, co);
    expect(await remoteMain(n, co)).toMatchObject({ commitId: y });
    const w = await commitIn(n, co, y, "w");
    await pushMain(n, co, w);
    expect(ownMainRow(n, P)).toMatchObject({ commit: w, drops: [] });
    expect(listBranchRows(n.db, P, "main").find((r) => r.node === peer)).toMatchObject({ seq: 1, commit: y });
    expect(n.logs.filter((l) => l.startsWith("meddle: git:"))).toEqual([]);
  } finally {
    await close();
  }
}, 60_000);

test("a push whose recording fails once stays in the view, through an applier pass, and its row is written on the retry", async () => {
  const { nodes, close } = await poolNodes(1, { nodes: [{ serveGit: false }] });
  const [n] = nodes as [GitPoolNode];
  const deps = { cfg: n.cfg, db: n.db, pool: n.pool, log: (line: string) => n.logs.push(line) };
  let calls = 0;
  /** What the view and the rows showed as the retry began, after an applier pass. */
  let atRetry = null as { view: string; row: string | null } | null;
  const stopServing = acceptGitStreams(n.net, {
    ...deps, selfId: n.id, isMember: (id) => n.store.isMember(id),
    async beforeRecord() {
      calls += 1;
      if (calls === 1) throw new Error("the database is busy");
      if (calls === 2) {
        await applyProject(deps, n.project.id);
        atRetry = {
          view: (await git(["rev-parse", "refs/namespaces/view/refs/heads/main"], n.project.replica, n.cfg)).trim(),
          row: ownMainRow(n, n.project.id)?.commit ?? null,
        };
      }
    },
  });
  try {
    const P = n.project.id;
    const co = await makeCheckout(n.cfg, n.id, n.project, `${n.home}/co`, helperEnv(n));
    const m = ownMainRow(n, P)!.commit!;
    const x = await commitIn(n, co, "main", "x");
    // The push is reported done: it landed, though its first recording failed.
    await pushMain(n, co, x);
    await applyProject(deps, P);
    expect((await git(["rev-parse", "refs/namespaces/view/refs/heads/main"], n.project.replica, n.cfg)).trim()).toBe(x);
    await waitFor("the retried recording", () => ownMainRow(n, P)?.commit === x);
    expect(atRetry).toEqual({ view: x, row: m });
    expect(calls).toBe(2);
    await fetchIn(n, co);
    expect(await remoteMain(n, co)).toMatchObject({ commitId: x });
    expect(n.logs.filter((l) => l.startsWith("meddle: git:"))).toEqual([
      `meddle: git: the push to project/${P} was not recorded yet: the database is busy; trying again`,
    ]);
  } finally {
    stopServing();
    await close();
  }
}, 60_000);
