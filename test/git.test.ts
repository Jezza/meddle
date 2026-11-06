import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { loadConfig, paths } from "../src/config";
import { runRemoteHelper } from "../src/git/helper";
import { writeHelperWrapper, writeUpdateHook } from "../src/git/scripts";
import { GitSocket } from "../src/git/socket";
import { parseGitHeader, parseMeddleUrl, parseRepo, repoName } from "../src/git/wire";
import { bookmarkList, CLONE_TIMEOUT_FACTOR, cloneColocated, fetch, git, GitError, initColocated, jj, JjError, push, remoteAdd, remoteList, track, workspaceAdd } from "../src/jj";
import { shortId } from "../src/pool/identity";
import type { PeerStream, PoolNet } from "../src/pool/net";
import { homeLines, pushLines } from "../src/projects/lines";
import { addProjectFromUpstream } from "../src/projects/project";
import { pushBookmark } from "../src/projects/replicas";
import { sideBookmark } from "../src/tasks/manifest";
import { repoKey, serialised } from "../src/serial";
import { twoPoolNodes, type GitPoolNode } from "./pool-helpers";

const NODE = "0123456789abcdef".repeat(4);

test("repo names and meddle urls parse, and anything else is refused", () => {
  expect(parseRepo("project/a1b2c3")).toEqual({ kind: "project", id: "a1b2c3" });
  expect(parseRepo("memory/a1b2c3")).toEqual({ kind: "memory", id: "a1b2c3" });
  expect(repoName({ kind: "memory", id: "x9" })).toBe("memory/x9");
  for (const bad of ["", "project", "project/", "task/a1", "project/a/b", "project/..", "memory/a b", "/project/a1"]) {
    expect(() => parseRepo(bad)).toThrow("bad repo name");
  }
  expect(parseMeddleUrl(`meddle://${NODE}/project/a1b2c3`)).toEqual({ nodeId: NODE, repo: { kind: "project", id: "a1b2c3" } });
  expect(parseMeddleUrl(`meddle://${NODE}/memory/a1b2c3`)).toEqual({ nodeId: NODE, repo: { kind: "memory", id: "a1b2c3" } });
  for (const bad of [
    `meddle://${NODE}`, `meddle://${NODE}/`, `meddle://${NODE.slice(1)}/project/a1`, `meddle://${NODE.toUpperCase()}/project/a1`,
    `https://${NODE}/project/a1`, `meddle://${NODE}/other/a1`, `meddle://${NODE}/project/a1/b`, "",
  ]) {
    expect(() => parseMeddleUrl(bad)).toThrow("bad meddle url");
  }
  expect(parseGitHeader({ stream: "git", repo: "project/a1", service: "receive-pack" }))
    .toEqual({ repo: { kind: "project", id: "a1" }, service: "receive-pack" });
  for (const bad of [
    { stream: "git", repo: "project/a1", service: "foo" },
    { stream: "git", repo: "project/a1" },
    { stream: "git", repo: 7, service: "upload-pack" },
    { stream: "git", repo: "project/a/b", service: "upload-pack" },
  ]) {
    expect(() => parseGitHeader(bad)).toThrow("bad git header");
  }
});

/** Runs the helper with `input` on its stdin; its exit code and what it wrote. */
async function helper(input: string, socketPath = "/nonexistent/git.sock") {
  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();
  const sink = (append: (text: string) => void) => new WritableStream<Uint8Array>({ write(chunk) { append(decoder.decode(chunk)); } });
  const code = await runRemoteHelper({
    url: `meddle://${NODE}/project/a1`,
    socketPath,
    stdin: new Blob([input]).stream(),
    stdout: sink((t) => { stdout += t; }),
    stderr: sink((t) => { stderr += t; }),
  });
  return { code, stdout, stderr };
}

test("the helper answers capabilities, quits on an empty line, and refuses anything else", async () => {
  expect(await helper("capabilities\n\n")).toEqual({ code: 0, stdout: "connect\n\n", stderr: "" });
  expect(await helper("capabilities\n")).toEqual({ code: 0, stdout: "connect\n\n", stderr: "" });
  const unknown = await helper("capabilities\nlist\n");
  expect(unknown.code).toBe(1);
  expect(unknown.stdout).toBe("connect\n\n");
  expect(unknown.stderr).toContain("unknown command: list");
  const unreachable = await helper("connect git-upload-pack\n");
  expect(unreachable.code).toBe(1);
  expect(unreachable.stdout).toBe("");
  expect(unreachable.stderr).toContain("/nonexistent/git.sock");
});

test("the wrapper and the hook are written with mode 755, the wrapper only when it changed", async () => {
  const home = await mkdtemp("/tmp/meddle-git-");
  try {
    const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d` });
    const wrapper = await writeHelperWrapper(cfg);
    expect(wrapper).toBe(paths(cfg).binHelper);
    const text = await readFile(wrapper, "utf8");
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(text).toContain(process.execPath);
    expect(text).toContain(`git-remote "$@"`);
    expect((await stat(wrapper)).mode & 0o777).toBe(0o755);
    const before = (await stat(wrapper)).mtimeMs;
    await Bun.sleep(20);
    await writeHelperWrapper(cfg);
    expect((await stat(wrapper)).mtimeMs).toBe(before);
    const hook = await writeUpdateHook(cfg);
    expect(hook).toBe(paths(cfg).hookUpdate);
    expect((await stat(hook)).mode & 0o777).toBe(0o755);
    expect(await readFile(hook, "utf8")).toContain("is not accepted here");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the git socket replaces a stale socket file", async () => {
  const home = await mkdtemp("/tmp/meddle-git-");
  try {
    const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d` });
    await Bun.$`mkdir -p ${home}/d`;
    await writeFile(paths(cfg).gitSocket, "stale");
    const socket = new GitSocket(cfg, {} as PoolNet);
    await socket.start();
    try {
      expect((await stat(socket.path)).isSocket()).toBe(true);
      // A live socket is not replaced.
      await expect(new GitSocket(cfg, {} as PoolNet).start()).rejects.toThrow();
    } finally {
      await socket.stop();
    }
    await expect(stat(socket.path)).rejects.toThrow();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

/** Gives A's project a commit with a file and points `main` at it; returns its change id. */
async function makeMain(A: GitPoolNode): Promise<string> {
  const repo = A.project.replica;
  await writeFile(`${repo}/README`, "hello\n");
  await jj(["commit", "-m", "init"], repo, A.cfg);
  await jj(["bookmark", "set", "main", "-r", "@-"], repo, A.cfg);
  return changeOf(A, repo, "main");
}

async function changeOf(node: GitPoolNode, repo: string, rev: string): Promise<string> {
  return (await jj(["log", "-r", rev, "--no-graph", "-T", "change_id"], repo, node.cfg)).trim();
}

const urlOf = (A: GitPoolNode) => `meddle://${A.id}/project/${A.project.id}`;

/**
 * B: a repo with A's project as remote `shortA`, `main` fetched, and a commit on it under `meddle/task/t1/p` pushed to
 * A as task t1's line (`pushLines`).
 */
async function pushTask(A: GitPoolNode, B: GitPoolNode): Promise<{ repo: string; commit: string }> {
  const shortA = shortId(A.id);
  const repo = `${B.home}/r`;
  await initColocated(repo, B.cfg);
  await remoteAdd(repo, shortA, urlOf(A), B.cfg);
  await fetch(repo, shortA, ["main"], B.cfg);
  await jj(["new", `main@${shortA}`], repo, B.cfg);
  await writeFile(`${repo}/work`, "from b\n");
  await jj(["commit", "-m", "work"], repo, B.cfg);
  await jj(["bookmark", "set", "meddle/task/t1/p", "-r", "@-"], repo, B.cfg);
  await pushLines(B.cfg, repo, { ...A.project, home: A.id }, "t1");
  return { repo, commit: await commitOf(B, repo, "@-") };
}

async function commitOf(node: GitPoolNode, repo: string, rev: string): Promise<string> {
  return (await jj(["log", "-r", rev, "--no-graph", "-T", "commit_id"], repo, node.cfg)).trim();
}

test("B fetches A's main through the helper and pushes a task's line back", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const mainChange = await makeMain(A);
    const shortA = shortId(A.id);
    const repo = `${B.home}/r`;
    await initColocated(repo, B.cfg);
    await remoteAdd(repo, shortA, urlOf(A), B.cfg);
    expect(await remoteList(repo, B.cfg)).toEqual([{ name: shortA, url: urlOf(A) }]);
    await fetch(repo, shortA, ["main"], B.cfg);
    expect(await bookmarkList(repo, B.cfg)).toContainEqual({ name: "main", remote: shortA, changeId: mainChange, conflicted: false });

    await jj(["new", `main@${shortA}`], repo, B.cfg);
    await writeFile(`${repo}/work`, "from b\n");
    await jj(["commit", "-m", "work"], repo, B.cfg);
    const commit = await commitOf(B, repo, "@-");
    await jj(["bookmark", "set", "meddle/task/t1/p", "-r", "@-"], repo, B.cfg);
    await pushLines(B.cfg, repo, { ...A.project, home: A.id }, "t1");
    // The home imported the push: jj there shows the line.
    expect(await bookmarkList(A.project.replica, A.cfg)).toContainEqual({ name: "task/t1/p", remote: "meddle", changeId: await changeOf(B, repo, "@-"), conflicted: false });
    expect(await homeLines(A.cfg, A.project.replica, "t1")).toEqual([{ taskId: "t1", name: "p", commitId: commit }]);
    expect(A.logs.filter((l) => l.startsWith("meddle: git:"))).toEqual([]);
  } finally {
    await close();
  }
}, 15_000);

test("serving an upload-pack of a url project homed here fetches every sync branch from the upstream first", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const up = `${A.home}/up`;
    const g = (...args: string[]) => git(["-c", "user.name=t", "-c", "user.email=t@t", ...args], up);
    const commit = async (branch: string, file: string): Promise<string> => {
      await writeFile(`${up}/${file}`, `${file}\n`);
      await g("add", ".");
      await g("commit", "-m", file);
      expect(await g("rev-parse", "--abbrev-ref", "HEAD")).toBe(`${branch}\n`);
      return (await g("rev-parse", "HEAD")).trim();
    };
    await mkdir(up);
    await g("init", "-b", "master");
    await commit("master", "one");
    await g("checkout", "-b", "dev");
    const first = await commit("dev", "dev1");
    await g("checkout", "master");
    const project = await addProjectFromUpstream(A.cfg, A.db, up, A.id, "up", ["dev"]);
    expect(project.sync).toEqual(["master", "dev"]);

    // The upstream moves both branches on after the project was added.
    await g("checkout", "dev");
    const dev = await commit("dev", "dev2");
    await g("checkout", "master");
    const master = await commit("master", "two");
    expect(dev).not.toBe(first);

    const shortA = shortId(A.id);
    const repo = `${B.home}/r`;
    await initColocated(repo, B.cfg);
    await remoteAdd(repo, shortA, `meddle://${A.id}/project/${project.id}`, B.cfg);
    await fetch(repo, shortA, ["dev", "master"], B.cfg);
    const heads = await bookmarkList(repo, B.cfg);
    const commitOf = async (rev: string) => (await jj(["log", "-r", rev, "--no-graph", "-T", "commit_id"], repo, B.cfg)).trim();
    expect(await commitOf(`dev@${shortA}`)).toBe(dev);
    expect(await commitOf(`master@${shortA}`)).toBe(master);
    expect(heads.filter((b) => b.remote === shortA).map((b) => b.name)).toContain("dev");
    expect(A.logs.filter((l) => l.startsWith("meddle: git:"))).toEqual([]);

    // An upstream that has gone is logged and never refuses the fetch.
    await rm(up, { recursive: true, force: true });
    await fetch(repo, shortA, ["dev"], B.cfg);
    expect(A.logs.filter((l) => l.startsWith("meddle: git:"))).toEqual([
      expect.stringContaining(`meddle: git: sync branches of ${shortId(project.id)} were not fetched`),
    ]);
  } finally {
    await close();
  }
}, 30_000);

test("pushLines pushes a side bookmark made in the task workspace to the home's line, never one outside the namespace", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    await makeMain(A);
    const shortA = shortId(A.id);
    const repo = `${B.home}/r`;
    await initColocated(repo, B.cfg);
    await remoteAdd(repo, shortA, urlOf(A), B.cfg);
    await fetch(repo, shortA, ["exact:main"], B.cfg);
    // The task's workspace on B, as provisioning makes it; the agent works and bookmarks there.
    const workspace = `${B.home}/task/p`;
    await mkdir(`${B.home}/task`, { recursive: true });
    await workspaceAdd(repo, "meddle-t1", workspace, `main@${shortA}`, B.cfg);
    await writeFile(`${workspace}/work`, "from b\n");
    await jj(["commit", "-m", "work"], workspace, B.cfg);
    const spike = await commitOf(B, workspace, "@-");
    await jj(["bookmark", "create", sideBookmark("t1", "p", "spike"), "-r", "@-"], workspace, B.cfg);
    await jj(["bookmark", "create", "spike", "-r", "@-"], workspace, B.cfg);
    await jj(["bookmark", "set", "meddle/task/t1/p", "-r", "@"], workspace, B.cfg);
    const primary = await commitOf(B, workspace, "@");

    await pushLines(B.cfg, repo, { ...A.project, home: A.id }, "t1");
    expect(await homeLines(A.cfg, A.project.replica)).toEqual([
      { taskId: "t1", name: "p", commitId: primary },
      { taskId: "t1", name: "p.spike", commitId: spike },
    ]);
    expect((await bookmarkList(A.project.replica, A.cfg)).map((b) => b.name)).not.toContain("spike");
    expect(A.logs.filter((l) => l.startsWith("meddle: git:"))).toEqual([]);
  } finally {
    await close();
  }
}, 15_000);

test("the acceptor refuses a repo it does not hold and a bad header before serving anything", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const absentMemory = "0a0b0c0d0e0f";
    for (const header of [
      { stream: "git", repo: "project/nope", service: "upload-pack" },
      { stream: "git", repo: `memory/${absentMemory}`, service: "receive-pack" },
      { stream: "git", repo: `project/${A.project.id}`, service: "foo" },
    ]) {
      const s = await B.net.openStream(A.id, header);
      expect(await s.reader.readChunk()).toBeNull();
    }
    expect(A.logs).toEqual([
      "meddle: git: unknown repo project/nope",
      `meddle: git: unknown repo memory/${absentMemory}`,
      "meddle: git: bad git header",
    ]);
    // A live socket is not replaced by a second one.
    await expect(new GitSocket(A.cfg, A.net).start()).rejects.toThrow();
  } finally {
    await close();
  }
}, 15_000);

test("the update hook refuses a push to main, a task bookmark and a deletion, and A's bookmarks stay as they were", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const mainChange = await makeMain(A);
    const shortA = shortId(A.id);
    const { repo, commit } = await pushTask(A, B);
    const before = await bookmarkList(A.project.replica, A.cfg);
    expect(before).toContainEqual({ name: "main", remote: null, changeId: mainChange, conflicted: false });
    expect(await homeLines(A.cfg, A.project.replica, "t1")).toEqual([{ taskId: "t1", name: "p", commitId: commit }]);

    await track(repo, "exact:main", shortA, B.cfg);
    await jj(["bookmark", "set", "main", "-r", "@-", "--allow-backwards"], repo, B.cfg);
    const toMain = await push(repo, shortA, "exact:main", B.cfg).catch((err: unknown) => err);
    expect(toMain).toBeInstanceOf(JjError);
    expect((toMain as JjError).stderr).toContain("meddle: ref refs/heads/main is not accepted here");

    // Only the holder's line is admitted: a task bookmark of the home repo itself is not.
    await track(repo, "exact:meddle/task/t1/p", shortA, B.cfg);
    const toBookmark = await push(repo, shortA, "exact:meddle/task/t1/p", B.cfg).catch((err: unknown) => err);
    expect(toBookmark).toBeInstanceOf(JjError);
    expect((toBookmark as JjError).stderr).toContain("meddle: ref refs/heads/meddle/task/t1/p is not accepted here");

    const deletion = await git(["push", urlOf(A), ":refs/remotes/meddle/task/t1/p"], repo, B.cfg).catch((err: unknown) => err);
    expect(deletion).toBeInstanceOf(GitError);
    expect((deletion as GitError).stderr).toContain("meddle: deleting refs/remotes/meddle/task/t1/p is not accepted here");

    expect(await bookmarkList(A.project.replica, A.cfg)).toEqual(before);
  } finally {
    await close();
  }
}, 15_000);

test("the update hook admits a task's line under refs/remotes/meddle/task/ and refuses other remote refs and a deletion", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    await makeMain(A);
    const repo = `${B.home}/r`;
    await initColocated(repo, B.cfg);
    await writeFile(`${repo}/work`, "from b\n");
    await jj(["commit", "-m", "work"], repo, B.cfg);
    const url = urlOf(A);
    const commit = (await jj(["log", "-r", "@-", "--no-graph", "-T", "commit_id"], repo, B.cfg)).trim();
    const refOnA = async (ref: string) => (await git(["for-each-ref", "--format=%(objectname)", ref], A.project.replica, A.cfg)).trim();

    await git(["push", url, `${commit}:refs/remotes/meddle/task/t/p`], repo, B.cfg);
    expect(await refOnA("refs/remotes/meddle/task/t/p")).toBe(commit);

    const other = await git(["push", url, `${commit}:refs/remotes/meddle/other`], repo, B.cfg).catch((err: unknown) => err);
    expect((other as GitError).stderr).toContain("meddle: ref refs/remotes/meddle/other is not accepted here");
    expect(await refOnA("refs/remotes/meddle/other")).toBe("");

    const deletion = await git(["push", url, ":refs/remotes/meddle/task/t/p"], repo, B.cfg).catch((err: unknown) => err);
    expect((deletion as GitError).stderr).toContain("meddle: deleting refs/remotes/meddle/task/t/p is not accepted here");
    expect(await refOnA("refs/remotes/meddle/task/t/p")).toBe(commit);
  } finally {
    await close();
  }
}, 15_000);

test("the update hook admits memory into a memory repo and refuses it into a project repo", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    await makeMain(A);
    const shortA = shortId(A.id);
    const memA = paths(A.cfg).memory(A.project.id);
    // B's own repo with A's memory replica as its remote: a commit pushed as `memory`.
    const mem = `${B.home}/m`;
    await initColocated(mem, B.cfg);
    await remoteAdd(mem, shortA, `meddle://${A.id}/memory/${A.project.id}`, B.cfg);
    await writeFile(`${mem}/MEMORY.md`, "- from b\n");
    await jj(["commit", "-m", "memory from b"], mem, B.cfg);
    const change = await changeOf(B, mem, "@-");
    await track(mem, "exact:memory", shortA, B.cfg);
    await jj(["bookmark", "set", "memory", "-r", "@-"], mem, B.cfg);
    await push(mem, shortA, "exact:memory", B.cfg);
    expect((await bookmarkList(memA, A.cfg)).find((b) => b.name === "memory" && b.remote === null)?.changeId).toBe(change);

    // The same ref into A's project repo is refused.
    const { repo } = await pushTask(A, B);
    const before = await bookmarkList(A.project.replica, A.cfg);
    await track(repo, "exact:memory", shortA, B.cfg);
    await jj(["bookmark", "set", "memory", "-r", "@-"], repo, B.cfg);
    const refused = await push(repo, shortA, "exact:memory", B.cfg).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(JjError);
    expect((refused as JjError).stderr).toContain("meddle: ref refs/heads/memory is not accepted here");
    expect(await bookmarkList(A.project.replica, A.cfg)).toEqual(before);
    expect(A.logs.filter((l) => l.startsWith("meddle: git:"))).toEqual([]);
  } finally {
    await close();
  }
}, 15_000);

test("without its update hook, the acceptor refuses every push and spawns nothing", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const mainChange = await makeMain(A);
    const shortA = shortId(A.id);
    const repo = `${B.home}/r`;
    await initColocated(repo, B.cfg);
    await remoteAdd(repo, shortA, urlOf(A), B.cfg);
    await fetch(repo, shortA, ["main"], B.cfg);
    await jj(["new", `main@${shortA}`], repo, B.cfg);
    await writeFile(`${repo}/work`, "from b\n");
    await jj(["commit", "-m", "work"], repo, B.cfg);
    const work = await commitOf(B, repo, "@-");
    const before = await bookmarkList(A.project.replica, A.cfg);

    for (const broken of ["not executable", "missing"]) {
      if (broken === "missing") await rm(paths(A.cfg).hookUpdate);
      else await chmod(paths(A.cfg).hookUpdate, 0o644);
      // Even a push the hook would admit (a task's line), and one it would not.
      await expect(git(["push", urlOf(A), `${work}:refs/remotes/meddle/task/t1/p`], repo, B.cfg)).rejects.toBeInstanceOf(GitError);
      await track(repo, "exact:main", shortA, B.cfg);
      await jj(["bookmark", "set", "main", "-r", "@-", "--allow-backwards"], repo, B.cfg);
      await expect(push(repo, shortA, "exact:main", B.cfg)).rejects.toBeInstanceOf(JjError);
    }
    expect(await bookmarkList(A.project.replica, A.cfg)).toEqual(before);
    expect(before).toContainEqual({ name: "main", remote: null, changeId: mainChange, conflicted: false });
    expect([...new Set(A.logs)]).toEqual(["meddle: git: update hook missing; refusing receive-pack"]);
    // A fetch needs no hook.
    await fetch(repo, shortA, ["main"], B.cfg);
  } finally {
    await close();
  }
}, 15_000);

test("a clone over the helper names its remote after the home, and main@<home> resolves", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const mainChange = await makeMain(A);
    const shortA = shortId(A.id);
    const dir = `${B.home}/clone`;
    await cloneColocated(urlOf(A), dir, B.cfg, shortA);
    expect(await remoteList(dir, B.cfg)).toEqual([{ name: shortA, url: urlOf(A) }]);
    expect(await changeOf(B, dir, `main@${shortA}`)).toBe(mainChange);
    expect(await bookmarkList(dir, B.cfg)).toContainEqual({ name: "main", remote: shortA, changeId: mainChange, conflicted: false });
  } finally {
    await close();
  }
}, 15_000);

test("a fetch or push whose peer never answers times out, takes its git processes with it and frees the repo's lock", async () => {
  // A claims B's git streams and never serves them.
  const { A, B, close } = await twoPoolNodes({ nodes: [{ serveGit: false }, {}] });
  const claimed: PeerStream[] = [];
  const off = A.net.onStream((s) => {
    if (s.header.stream !== "git") return false;
    claimed.push(s);
    return true;
  });
  try {
    const shortA = shortId(A.id);
    const repo = `${B.home}/r`;
    await initColocated(repo, B.cfg);
    await remoteAdd(repo, shortA, urlOf(A), B.cfg);
    const cfg = { ...B.cfg, jjNetworkTimeoutMs: 1000 };
    const bookmark = "meddle/task/t1/p";

    let started = Date.now();
    await expect(pushBookmark(cfg, repo, A.id, bookmark, "@"))
      .rejects.toThrow(`jj git fetch --remote ${shortA} --branch exact:${bookmark} timed out after 1000 ms`);
    expect(Date.now() - started).toBeLessThan(5_000);
    // The lock pushBookmark held is free again.
    expect(await serialised(repoKey(repo), async () => "free")).toBe("free");
    // The remote helper went with jj: its stream to A ends.
    const ended = await Promise.race([
      claimed[0]!.reader.readChunk().then(() => "ended", () => "ended"),
      Bun.sleep(5_000).then(() => "still open"),
    ]);
    expect(ended).toBe("ended");

    await track(repo, `exact:${bookmark}`, shortA, B.cfg);
    await jj(["bookmark", "set", bookmark, "-r", "@"], repo, B.cfg);
    started = Date.now();
    await expect(push(repo, shortA, `exact:${bookmark}`, cfg)).rejects.toThrow("timed out after 1000 ms");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(claimed).toHaveLength(2);

    // A clone moves a whole repo once: it gets CLONE_TIMEOUT_FACTOR times the fetch/push limit.
    const quick = { ...B.cfg, jjNetworkTimeoutMs: 100 };
    started = Date.now();
    await expect(cloneColocated(urlOf(A), `${B.home}/stalled-clone`, quick, shortA))
      .rejects.toThrow(`timed out after ${100 * CLONE_TIMEOUT_FACTOR} ms`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(claimed).toHaveLength(3);
  } finally {
    off();
    await close();
  }
}, 15_000);
