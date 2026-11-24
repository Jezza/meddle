import { expect, test } from "bun:test";
import { paths } from "../src/config";
import { git, GitError, initColocated } from "../src/jj";
import { waitingHeadRows, writeHeadRow } from "../src/pool/heads";
import { fetchCommit } from "../src/projects/applier";
import { prepareScopeRepo } from "../src/scopes/repo";
import { peerReady, twoNodes, twoPoolNodes } from "./pool-helpers";
import { commitOn, PROFILE, show } from "./scope-helpers";

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

test("a head row written on one node waits on the other", async () => {
  const { a, b, close } = await twoNodes();
  try {
    writeHeadRow(a.db, a.id, { scope: "profile", commit: "a".repeat(40), rule: 1, seed: null, edited: true });
    await until(() => waitingHeadRows(b.db, "profile").length === 1);
    expect(waitingHeadRows(b.db, "profile")[0]!.node).toBe(a.id);
    expect(b.sync.headsSupport(a.id)).toBe("held");
  } finally {
    await close();
  }
}, 20_000);

test("a peer serving no ScopeHeadsObject reads as older, and its PoolObject is held all the same", async () => {
  const { a, b, close } = await twoNodes({ older: "b" });
  try {
    await until(() => a.sync.headsSupport(b.id) === "older");
    expect(a.sync.removedSupport(b.id)).toBe("older");
  } finally {
    await close();
  }
}, 20_000);

test("a commit of a node's profile is fetched by id, and a peer's push to it is refused", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    await peerReady(B, A);
    const profile = paths(A.cfg).profile;
    await prepareScopeRepo(A.cfg, profile, PROFILE);
    const commit = await commitOn(A.cfg, profile, null, { "CLAUDE.md": "a\n" });
    const repo = `${B.home}/p`;
    await initColocated(repo, B.cfg);
    const got = await fetchCommit({ cfg: B.cfg, db: B.db, pool: B.pool }, repo, { kind: "profile", id: "pool" }, commit, [A.id], Date.now() + 30_000);
    expect(got).toBe(true);
    expect(await show(B.cfg, repo, commit, "CLAUDE.md")).toBe("a\n");
    const pushed = await git(["push", `meddle://${A.id}/profile/pool`, `${commit}:refs/heads/profile`], repo, B.cfg).catch((err: unknown) => err);
    expect(pushed).toBeInstanceOf(GitError);
  } finally {
    await close();
  }
}, 30_000);
