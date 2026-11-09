import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { loadConfig, paths } from "../src/config";
import { runRemoteHelper } from "../src/git/helper";
import { writeHelperWrapper, writePreReceiveHook } from "../src/git/scripts";
import { GitSocket } from "../src/git/socket";
import { parseGitHeader, parseMeddleUrl, parseRepo, repoName } from "../src/git/wire";
import { bookmarkList, CLONE_TIMEOUT_FACTOR, cloneColocated, fetch, git, GitError, initColocated, jj, JjError, push, remoteAdd, remoteList, track } from "../src/jj";
import { shortId } from "../src/pool/identity";
import type { PeerStream, PoolNet } from "../src/pool/net";
import { pushBookmark } from "../src/projects/replicas";
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

test("the wrapper and the hooks are written with mode 755, the wrapper only when it changed", async () => {
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
    // The gate of every push, in a directory of its own: git runs every hook of a `core.hooksPath`.
    const gate = await writePreReceiveHook(cfg);
    expect(gate).toBe(paths(cfg).hookPreReceive);
    expect(gate.startsWith(`${paths(cfg).bin}/`)).toBe(false);
    expect((await stat(gate)).mode & 0o777).toBe(0o755);
    const script = await readFile(gate, "utf8");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain("git-pre-receive");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("meddle git-pre-receive reads git's lines: a memory repo takes only memory, never deleted, and a project nothing under meddle/", async () => {
  const zero = "0".repeat(40);
  const one = "1".repeat(40);
  const run = async (lines: string, env: Record<string, string>) => {
    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "git-pre-receive"], {
      cwd: `${import.meta.dir}/..`, env: { ...process.env, ...env }, stdin: new Blob([lines]), stdout: "pipe", stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { stderr, code };
  };
  expect(await run(`${zero} ${one} refs/heads/memory\n`, { MEDDLE_REPO_KIND: "memory" })).toEqual({ stderr: "", code: 0 });
  expect(await run(`${zero} ${one} refs/heads/memory\n${zero} ${one} refs/heads/main\n`, { MEDDLE_REPO_KIND: "memory" }))
    .toEqual({ stderr: "ref refs/heads/main is not accepted here\n", code: 1 });
  expect(await run(`${one} ${zero} refs/heads/memory\n`, { MEDDLE_REPO_KIND: "memory" }))
    .toEqual({ stderr: "deleting refs/heads/memory is not accepted here\n", code: 1 });
  // A project: new branches and a deletion need no graph; anything under meddle/ is refused.
  const dir = await mkdtemp("/tmp/meddle-git-");
  const rows = `${dir}/rows.json`;
  await writeFile(rows, JSON.stringify({ selfId: NODE, project: "p1", rows: [], stale: [] }));
  const project = { MEDDLE_REPO_KIND: "project", MEDDLE_HEADS: "[]", MEDDLE_ROWS: rows };
  expect(await run(`${zero} ${one} refs/heads/main\n${one} ${zero} refs/heads/old\n`, project)).toEqual({ stderr: "", code: 0 });
  expect(await run(`${zero} ${one} refs/heads/main\n${zero} ${one} refs/heads/meddle/task/t/p\n`, project))
    .toEqual({ stderr: "ref refs/heads/meddle/task/t/p is not accepted here\n", code: 1 });
  // A branch the view shows behind its rows is refused until the view catches up.
  const behind = `${dir}/behind.json`;
  await writeFile(behind, JSON.stringify({ selfId: NODE, project: "p1", rows: [], stale: ["main"] }));
  expect(await run(`${zero} ${one} refs/heads/main\n`, { ...project, MEDDLE_ROWS: behind }))
    .toEqual({ stderr: "main: this node is still fetching it; push again shortly\n", code: 1 });
  expect(await run(`${zero} ${one} refs/heads/other\n`, { ...project, MEDDLE_ROWS: behind })).toEqual({ stderr: "", code: 0 });
  // Without the heads and rows the node gives it, nothing is admitted.
  expect((await run(`${zero} ${one} refs/heads/main\n`, { MEDDLE_REPO_KIND: "project", MEDDLE_HEADS: "[]" })).code).toBe(1);
  expect((await run(`${zero} ${one} refs/heads/main\n`, { MEDDLE_REPO_KIND: "project", MEDDLE_ROWS: rows })).code).toBe(1);
  await rm(dir, { recursive: true, force: true });
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

/** Gives A's project a commit with a file on `main` and points `main` at it; returns its change id. */
async function makeMain(A: GitPoolNode): Promise<string> {
  const repo = A.project.replica;
  await jj(["new", "main"], repo, A.cfg);
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
 * B: a repo with A's project as remote `shortA`, `main` fetched, and a commit on it bookmarked `meddle/task/t1/p`.
 */
async function workOnB(A: GitPoolNode, B: GitPoolNode): Promise<{ repo: string; commit: string }> {
  const shortA = shortId(A.id);
  const repo = `${B.home}/r`;
  await initColocated(repo, B.cfg);
  await remoteAdd(repo, shortA, urlOf(A), B.cfg);
  await fetch(repo, shortA, ["main"], B.cfg);
  await jj(["new", `main@${shortA}`], repo, B.cfg);
  await writeFile(`${repo}/work`, "from b\n");
  await jj(["commit", "-m", "work"], repo, B.cfg);
  await jj(["bookmark", "set", "meddle/task/t1/p", "-r", "@-"], repo, B.cfg);
  return { repo, commit: await commitOf(B, repo, "@-") };
}

/** The refusal A logs for a peer's push to its project repo. */
const refusedPush = (A: GitPoolNode, B: GitPoolNode) => `meddle: git: ${shortId(B.id)} may not push to project/${A.project.id}`;

async function commitOf(node: GitPoolNode, repo: string, rev: string): Promise<string> {
  return (await jj(["log", "-r", rev, "--no-graph", "-T", "commit_id"], repo, node.cfg)).trim();
}

test("B fetches A's main through the helper; a push of any ref to A's project repo is refused before anything is spawned", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const mainChange = await makeMain(A);
    const shortA = shortId(A.id);
    const { repo, commit } = await workOnB(A, B);
    expect(await remoteList(repo, B.cfg)).toEqual([{ name: shortA, url: urlOf(A) }]);
    expect(await bookmarkList(repo, B.cfg)).toContainEqual({ name: "main", remote: shortA, changeId: mainChange, conflicted: false });

    const before = await bookmarkList(A.project.replica, A.cfg);
    // A task's line (lines are rows now), a branch, a deletion: every push to a project repo from a peer is refused.
    for (const spec of [`${commit}:refs/remotes/meddle/task/t1/p`, `${commit}:refs/heads/main`, ":refs/heads/main"]) {
      await expect(git(["push", urlOf(A), spec], repo, B.cfg)).rejects.toBeInstanceOf(GitError);
    }
    await track(repo, "exact:main", shortA, B.cfg);
    await jj(["bookmark", "set", "main", "-r", "@-", "--allow-backwards"], repo, B.cfg);
    await expect(push(repo, shortA, "exact:main", B.cfg)).rejects.toBeInstanceOf(JjError);
    expect(await bookmarkList(A.project.replica, A.cfg)).toEqual(before);
    expect(await git(["for-each-ref", "refs/remotes/meddle"], A.project.replica, A.cfg)).toBe("");
    expect([...new Set(A.logs)]).toEqual([refusedPush(A, B)]);
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

test("the pre-receive hook admits memory into a memory repo and refuses another ref and a deletion there; a project repo takes no push from a peer", async () => {
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
    expect(A.logs.filter((l) => l.startsWith("meddle: git:"))).toEqual([]);

    // Another ref, or a line, into the memory repo; and memory's deletion.
    const memUrl = `meddle://${A.id}/memory/${A.project.id}`;
    const commit = await commitOf(B, mem, "@-");
    const other = await git(["push", memUrl, `${commit}:refs/heads/other`], mem, B.cfg).catch((err: unknown) => err);
    expect((other as GitError).stderr).toContain("remote: ref refs/heads/other is not accepted here");
    const line = await git(["push", memUrl, `${commit}:refs/remotes/meddle/task/t/p`], mem, B.cfg).catch((err: unknown) => err);
    expect((line as GitError).stderr).toContain("remote: ref refs/remotes/meddle/task/t/p is not accepted here");
    const deletion = await git(["push", memUrl, ":refs/heads/memory"], mem, B.cfg).catch((err: unknown) => err);
    expect((deletion as GitError).stderr).toContain("remote: deleting refs/heads/memory is not accepted here");
    expect((await bookmarkList(memA, A.cfg)).find((b) => b.name === "memory" && b.remote === null)?.changeId).toBe(change);

    // The same ref into A's project repo is refused, before any hook.
    const { repo } = await workOnB(A, B);
    const before = await bookmarkList(A.project.replica, A.cfg);
    await track(repo, "exact:memory", shortA, B.cfg);
    await jj(["bookmark", "set", "memory", "-r", "@-"], repo, B.cfg);
    await expect(push(repo, shortA, "exact:memory", B.cfg)).rejects.toBeInstanceOf(JjError);
    expect(await bookmarkList(A.project.replica, A.cfg)).toEqual(before);
    expect([...new Set(A.logs.filter((l) => l.startsWith("meddle: git:")))]).toEqual([refusedPush(A, B)]);
  } finally {
    await close();
  }
}, 15_000);

test("without its pre-receive hook, the acceptor refuses every push to a memory repo and spawns nothing", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    await makeMain(A);
    const shortA = shortId(A.id);
    const memA = paths(A.cfg).memory(A.project.id);
    const mem = `${B.home}/m`;
    await initColocated(mem, B.cfg);
    await remoteAdd(mem, shortA, `meddle://${A.id}/memory/${A.project.id}`, B.cfg);
    await writeFile(`${mem}/MEMORY.md`, "- from b\n");
    await jj(["commit", "-m", "memory from b"], mem, B.cfg);
    const before = await bookmarkList(memA, A.cfg);

    for (const broken of ["not executable", "missing"]) {
      if (broken === "missing") await rm(paths(A.cfg).hookPreReceive);
      else await chmod(paths(A.cfg).hookPreReceive, 0o644);
      // Even a push the hook would admit (memory).
      await track(mem, "exact:memory", shortA, B.cfg);
      await jj(["bookmark", "set", "memory", "-r", "@-"], mem, B.cfg);
      await expect(push(mem, shortA, "exact:memory", B.cfg)).rejects.toBeInstanceOf(JjError);
    }
    expect(await bookmarkList(memA, A.cfg)).toEqual(before);
    expect([...new Set(A.logs)]).toEqual(["meddle: git: pre-receive hook missing; refusing receive-pack"]);
    // A fetch needs no hook.
    const repo = `${B.home}/r`;
    await initColocated(repo, B.cfg);
    await remoteAdd(repo, shortA, urlOf(A), B.cfg);
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
