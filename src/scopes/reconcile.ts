// Reconciling heads: given this node's head of a scope and the heads of its peers (each commit already in the repo),
// where this node's head goes. Peers are taken in node-id order: a descendant is fast-forwarded to, one already contained
// is passed over, one holding the same files under another history settles on the lower commit id, and any other is
// merged (`mergeHeads`, parents in node-id order). Every node merging the same heads makes the same commits, so the pool
// settles. Nothing here moves a bookmark or the working copy: the caller does (`moveTo`).
// The profile adds seeds (spec 6.5): a line started from a node's own `~/.claude` yields to any line beyond a seed, of
// two seed-only lines the lower node id's wins, an edited seeded line replays its edits onto an unrelated line rather
// than merging the whole seed in (of two such lines only the higher node replays, onto the lower's), and a legacy line
// (a profile from before the pool synced it) takes only an imported line (`seed` null).
import type { NodeConfig } from "../config";
import { git, GitError } from "../jj";
import { isAncestor, mergeHeads, sameTree } from "./repo";

/** A peer's head of the scope: its node, the commit, and (for the profile) its seed and whether it is beyond it. */
export type Peer = { node: string; commit: string; seed: string | null; edited: boolean };

/** This node as reconciling sees it: its seed (profile only), whether its line is beyond it, whether it is legacy. */
export type Self = { node: string; seed: string | null; edited: boolean; legacy: boolean };

export type Reconciled = { head: string | null; self: Self; skipped: Array<{ node: string; why: "seed" }> };

/** What the profile's seed rules say to do with a peer's line. */
export type SeedStep = "adopt" | "skip" | "replay" | "merge";

/**
 * The seed rules (spec 6.5, plan amendment A9) for this node's line against `peer`'s: `related`, whether the two lines
 * share history (asked only when both are beyond a seed).
 */
export function seedStep(self: Self, head: string | null, peer: Peer, related: () => Promise<boolean>): Promise<SeedStep> | SeedStep {
  if (self.legacy) return peer.seed === null && peer.edited ? "adopt" : "skip";
  const seedOnly = head === null || (self.seed !== null && !self.edited);
  const peerSeedOnly = peer.seed !== null && !peer.edited;
  if (seedOnly && peerSeedOnly) return peer.node < self.node ? "adopt" : "skip";
  if (seedOnly) return "adopt";
  if (peerSeedOnly) return "skip";
  return related().then((yes) => {
    if (yes || (self.seed === null && peer.seed === null)) return "merge";
    if (self.seed !== null && peer.seed !== null) return self.node > peer.node ? "replay" : "skip";
    return self.seed !== null ? "replay" : "skip";
  });
}

/** Whether commits `a` and `b` share any history. */
async function related(cfg: NodeConfig, dir: string, a: string, b: string): Promise<boolean> {
  try {
    await git(["merge-base", a, b], dir, cfg);
    return true;
  } catch (err) {
    if (err instanceof GitError && err.code === 1) return false;
    throw err;
  }
}

/** Where this node's head of the scope in `dir` goes, from `own` and `peers` (see the top of the file). */
export async function reconcile(
  cfg: NodeConfig, dir: string, self: Self, own: string | null, peers: readonly Peer[], opts: { profile?: boolean } = {},
): Promise<Reconciled> {
  let head = own;
  let me = { ...self };
  const skipped: Reconciled["skipped"] = [];
  for (const p of [...peers].sort((x, y) => (x.node < y.node ? -1 : x.node > y.node ? 1 : 0))) {
    if (p.node === me.node) continue;
    if (opts.profile === true) {
      const step = await seedStep(me, head, p, () => related(cfg, dir, head!, p.commit));
      if (step === "skip") {
        skipped.push({ node: p.node, why: "seed" });
        continue;
      }
      if (step === "adopt") {
        head = p.commit;
        me = { ...me, legacy: false, seed: p.seed, edited: p.edited };
        continue;
      }
      if (step === "replay") {
        head = await mergeHeads(cfg, dir, head!, p.commit, { base: me.seed!, replay: true });
        me = { ...me, seed: p.seed, edited: true };
        continue;
      }
    }
    if (head === null) {
      head = p.commit;
      continue;
    }
    if (head === p.commit || (await isAncestor(cfg, dir, p.commit, head))) continue;
    if (await isAncestor(cfg, dir, head, p.commit)) {
      head = p.commit;
      continue;
    }
    if (await sameTree(cfg, dir, head, p.commit)) {
      head = head < p.commit ? head : p.commit;
      continue;
    }
    const [first, second] = me.node < p.node ? [head, p.commit] : [p.commit, head];
    head = await mergeHeads(cfg, dir, first, second);
  }
  return { head, self: me, skipped };
}
