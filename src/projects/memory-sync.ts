// A project's memory on this node: its repo is a synced scope (`src/scopes/`), kept in step with every other node's
// continuously by the scope sync. Here: the topic that says the memory of a project changed here, where its bookmark and
// working copy are, and the dashboard's write of one memory file (on any node), which commits just that file and asks the
// scope sync for a pass.
import type { Subscribable } from "@earendil-works/chord";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { NodeConfig } from "../config";
import { isJjRepo, jj } from "../jj";
import { MEMORY_BOOKMARK } from "../memory";
import { paths } from "../paths";
import { isRemoved } from "../pool/removed";
import { headOf, isAncestor, prepareScopeRepo } from "../scopes/repo";
import type { Scope } from "../scopes/scope";
import type { ScopeSync } from "../scopes/sync";
import { repoKey, serialised } from "../serial";
import { isMemoryPath, memoryFileset } from "./memory-names";
import { readRegular } from "./memory-view";
import { getProject } from "./project";
import type { ReplicaDeps } from "./replicas";

const listeners = new Set<(projectId: string) => void>();

/**
 * Fires with a project's id after the scope sync or a dashboard write here moved its `memory` bookmark or its memory
 * working copy, and after a peer's push into its memory repo here (`git/serve.ts`).
 */
export const memoryChanges: Subscribable<string> = {
  subscribe(cb) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },
};

/** Tells `memoryChanges` that the memory of `projectId` changed. */
export function memoryChanged(projectId: string): void {
  for (const cb of [...listeners]) {
    try {
      cb(projectId);
    } catch {
      // A listener's failure is its own; the others still hear of the change.
    }
  }
}

/**
 * Where `memory` and the working copy's parents are (a line per commit: its id, whether `memory` is on it, whether it
 * is a parent of `@`), read without a snapshot: what a sync moved when it differs after it.
 */
export async function memoryPlacing(cfg: NodeConfig, repo: string): Promise<string> {
  const template = `commit_id ++ " " ++ self.contained_in('bookmarks(exact:"${MEMORY_BOOKMARK}")') ++ " " ++ self.contained_in("@-") ++ "\\n"`;
  return jj(["--ignore-working-copy", "log", "-r", `bookmarks(exact:"${MEMORY_BOOKMARK}") | @-`, "--no-graph", "-T", template], repo, cfg);
}

export type MemoryWriteCode = "changed" | "path" | "no-repo";

/** Why `writeMemory` refused. */
export class MemoryWriteError extends Error {
  constructor(readonly code: MemoryWriteCode, message: string) {
    super(message);
    this.name = "MemoryWriteError";
  }
}

/**
 * Writes the memory file `path` of `projectId` here (deletes it when `text` is null), commits just that file
 * (`memory: dashboard`) and moves `memory` onto it; then asks `sync` for a pass, which publishes it (and commits what
 * else was written). When that leaves the file as it was, nothing is committed. `base` is the sha256
 * hex of the file as it was read (null: there was none); when the file on disk is not that any more nothing is written.
 * Rejects with a `MemoryWriteError`; resolves with the change `memory` is on after it.
 */
export async function writeMemory(
  deps: ReplicaDeps & { sync: ScopeSync | null }, projectId: string, path: string, text: string | null, base: string | null,
): Promise<{ change: string }> {
  const repo = paths(deps.cfg).memory(projectId);
  const scope: Scope = { kind: "memory", projectId };
  const { change, moved } = await serialised(repoKey(repo), () => write(deps, scope, repo, path, text, base));
  if (moved) {
    memoryChanged(projectId);
    deps.sync?.touched(scope);
  }
  return { change };
}

async function write(
  deps: ReplicaDeps, scope: Scope & { kind: "memory" }, repo: string, path: string, text: string | null, base: string | null,
): Promise<{ change: string; moved: boolean }> {
  const { cfg } = deps;
  if (getProject(deps.db, scope.projectId) === null || isRemoved(deps.db, scope.projectId)) throw new MemoryWriteError("no-repo", "unknown project");
  if (!isMemoryPath(path)) throw new MemoryWriteError("path", `not a memory file: ${JSON.stringify(path)}`);
  if (!(await isJjRepo(repo))) throw new MemoryWriteError("no-repo", "no memory replica");
  await prepareScopeRepo(cfg, repo, scope);

  const file = join(repo, path);
  const kind = await lstat(file).then((s) => (s.isFile() ? "file" : "other"), () => "absent");
  if (kind === "other") throw new MemoryWriteError("path", `${path} is not a regular file`);
  const bytes = await readRegular(repo, path);
  const now = bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
  if (now !== base) throw new MemoryWriteError("changed", `${path} changed since it was read`);

  if (text === null) await rm(file, { force: true });
  else await replaceFile(repo, file, text);
  const fileset = memoryFileset(path);
  const changeOf = async (rev: string) => (await jj(["log", "-r", rev, "--no-graph", "-T", "change_id"], repo, cfg)).trim();
  if ((await jj(["diff", "--name-only", fileset], repo, cfg)).trim() === "") {
    // The file is as `@-` has it: nothing to commit, and `memory` stays where it is (`@-` before there is one).
    return { change: await changeOf((await headOf(cfg, repo, scope)) ?? "@-"), moved: false };
  }
  await jj(["commit", "-m", "memory: dashboard", fileset], repo, cfg);
  const parent = (await jj(["log", "-r", "@-", "--no-graph", "-T", "commit_id"], repo, cfg)).trim();
  // `memory` onto it when it is behind it; one someone else moved (an old node's push) the scope sync's pass folds in.
  const head = await headOf(cfg, repo, scope);
  if (head === null || (await isAncestor(cfg, repo, head, parent))) {
    await jj(["bookmark", "set", MEMORY_BOOKMARK, "-r", parent, "--allow-backwards"], repo, cfg);
  }
  return { change: await changeOf("@-"), moved: true };
}

/**
 * Puts `text` at `file` in `repo` whole: written to a file under `.jj` (on the same filesystem, never snapshotted), then
 * renamed over it, so a reader never sees half of it and a symlink put at `file` is replaced, never followed.
 */
async function replaceFile(repo: string, file: string, text: string): Promise<void> {
  const temp = join(repo, ".jj", `meddle-write-${randomUUID()}`);
  try {
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try {
      await handle.writeFile(text);
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}
