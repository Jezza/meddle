// The serving side of git over iroh: a peer's `git` stream runs `git upload-pack` or `git receive-pack` on a repo
// this node holds, the stream's bytes piped to the process and its output piped back.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import type { NodeConfig } from "../config";
import { jj } from "../jj";
import { paths } from "../paths";
import type { PeerStream, PoolNet } from "../pool/net";
import { getProject } from "../projects/project";
import { parseGitHeader, repoName, type GitService, type Repo } from "./wire";

export type GitServeDeps = {
  db: Database;
  cfg: NodeConfig;
  isMember(id: string): boolean;
  /** Where a refused stream is logged (`meddle: git: …`); the runtime passes a deduplicating sink. */
  log?(line: string): void;
};

/** The git directory of the jj repo at `repo` (`.git` when colocated), or null when it has none. */
function gitDirOf(repo: string): string | null {
  const store = join(repo, ".jj", "repo", "store");
  try {
    const dir = resolve(store, readFileSync(join(store, "git_target"), "utf8").trim());
    if (existsSync(dir)) return dir;
  } catch {
    // Not a jj repo with a git backend; a plain colocated `.git` still serves.
  }
  const dotGit = join(repo, ".git");
  return existsSync(dotGit) ? dotGit : null;
}

/**
 * The working copy of a repo this node holds: a project's replica (a project row) or a memory replica
 * (`<data>/memory/<id>`), when it is a git-backed repo; otherwise null.
 */
export function repoPath(db: Database, cfg: NodeConfig, repo: Repo): string | null {
  const path = repo.kind === "project" ? getProject(db, repo.id)?.replica ?? null : paths(cfg).memory(repo.id);
  return path !== null && gitDirOf(path) !== null ? path : null;
}

/** Ends a refused stream with no data: the opener reads its end at once. */
async function refuse(s: PeerStream): Promise<void> {
  await s.stream.send.finish().catch(() => {});
  await s.stream.recv.stop(0n).catch(() => {});
}

/** The git command serving `service` on `gitDir`; a push goes through meddle's `update` hook. */
function command(cfg: NodeConfig, service: GitService, gitDir: string): string[] {
  return service === "upload-pack"
    ? ["git", "upload-pack", gitDir]
    : ["git", "-c", `core.hooksPath=${paths(cfg).hooks}`, "receive-pack", gitDir];
}

async function serve(s: PeerStream, deps: GitServeDeps): Promise<void> {
  if (!deps.isMember(s.peerId)) return refuse(s);
  let request: { repo: Repo; service: GitService };
  try {
    request = parseGitHeader(s.header);
  } catch {
    deps.log?.("meddle: git: bad git header");
    return refuse(s);
  }
  const repo = repoPath(deps.db, deps.cfg, request.repo);
  const gitDir = repo === null ? null : gitDirOf(repo);
  if (repo === null || gitDir === null) {
    deps.log?.(`meddle: git: unknown repo ${repoName(request.repo)}`);
    return refuse(s);
  }

  const proc = Bun.spawn(command(deps.cfg, request.service, gitDir), {
    cwd: repo,
    env: { ...process.env, MEDDLE_REPO_KIND: request.repo.kind },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  // The peer's bytes into the process; once it cannot take them (it exited), the rest is read and dropped.
  const input = (async () => {
    let open = true;
    for (;;) {
      const chunk = await s.reader.readChunk();
      if (chunk === null) break;
      if (!open) continue;
      try {
        proc.stdin.write(chunk);
        await proc.stdin.flush();
      } catch {
        open = false;
      }
    }
    if (open) await Promise.resolve(proc.stdin.end()).catch(() => {});
  })();
  let delivered = true;
  try {
    for await (const chunk of proc.stdout) await s.stream.send.writeAll(Array.from(chunk));
  } catch {
    delivered = false;
    proc.kill();
  }
  const code = await proc.exited;
  // A push landed in the git repo: jj imports it now, so the bookmarks are there when the pusher's push returns.
  if (code === 0 && request.service === "receive-pack") await jj(["git", "import"], repo, deps.cfg).catch(() => {});
  if (delivered) await s.stream.send.finish().catch(() => {});
  else await s.stream.send.reset(0n).catch(() => {});
  // The process is gone: nothing more the peer sends has anywhere to go.
  await s.stream.recv.stop(0n).catch(() => {});
  await input;
}

/**
 * Serves the `git` streams members open to this node: only repos it holds (`repoPath`) and only `upload-pack` and
 * `receive-pack`, refused (logged, the stream ended with no data) before anything is spawned. A push runs under
 * `core.hooksPath=<data>/git-hooks` with `MEDDLE_REPO_KIND`, so the `update` hook decides which refs it may change.
 * Returns the unsubscribe.
 */
export function acceptGitStreams(net: PoolNet, deps: GitServeDeps): () => void {
  return net.onStream((s) => {
    if (s.header.stream !== "git") return false;
    void serve(s, deps).catch(() => refuse(s));
    return true;
  });
}
