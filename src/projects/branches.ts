// Branches: a shared branch (`main`) is never stored. Each node writes its own row for it, with where it put the branch
// and the rows its pushes replaced (`drops`), and every node computes the branch from all of them the same way: the
// heads of the commits of the rows nothing dropped. Concurrent pushes leave several heads, the siblings; a push of a
// merge of them, or a drop of one (deleting its `meddle/conflict/<b>/<id>`), resolves the branch.
import type { BranchRow, RowRef } from "../pool/rows";

/** A project's commit graph: whether `a` is `b` or an ancestor of it, and the heads of `commits`' common ancestry. */
export type Graph = {
  isAncestor(a: string, b: string): Promise<boolean>;
  mergeBases(commits: string[]): Promise<string[]>;
};

/**
 * A branch as computed from its rows. `live` are the rows neither deleted nor dropped. A conflicted branch is
 * `served` at the merge base of its siblings, or not at all (`null`) when they share no history.
 */
export type BranchState =
  | { kind: "absent" }
  | { kind: "single"; commit: string; live: RowRef[] }
  | { kind: "conflicted"; siblings: string[]; served: string | null; live: RowRef[] };

/**
 * A branch as `meddle project status` and the dashboard show it: `single` at `commit`; `conflicted`, with its
 * `siblings` and served at `commit`, their merge base (null when they share no history); `fetching` while a commit its
 * rows name is not here yet, so its position can't be computed. A branch every row deleted or dropped isn't one.
 */
export type ProjectBranch = { name: string; state: "single" | "conflicted" | "fetching"; commit: string | null; siblings: string[] };

/**
 * Where `branch` is, in a few words: its commit's first 12 characters; for a conflicted one, where it is served; or
 * that its commits are still being fetched.
 */
export function branchText(branch: ProjectBranch): string {
  if (branch.state === "fetching") return "still fetching its commits";
  if (branch.state === "single") return (branch.commit ?? "").slice(0, 12);
  return branch.commit === null
    ? "conflicted, not served: its siblings share no history"
    : `conflicted, at its siblings' merge base ${branch.commit.slice(0, 12)}`;
}

/** One ref of a push: `old` null is a creation, `new` null a deletion. */
export type PushedRef = { ref: string; old: string | null; new: string | null };

/** Each branch's commits: one commit if single, the siblings if conflicted. */
export type BranchHeads = Array<{ branch: string; commits: string[] }>;

const HEADS = "refs/heads/";
const RESERVED = "refs/heads/meddle";
const CONFLICT = "refs/heads/meddle/conflict/";
const INCOMING = "refs/meddle/incoming/";

/** `refs/heads/meddle` and everything under it: git can't hold a branch `meddle` beside `meddle/task/*`. */
const isReserved = (ref: string): boolean => ref === RESERVED || ref.startsWith(`${RESERVED}/`);

const refOf = (r: { node: string; seq: number }): RowRef => ({ node: r.node, seq: r.seq });
const keyOf = (r: RowRef): string => JSON.stringify([r.node, r.seq]);

/** A sibling's name in the view: its commit's first 12 characters. */
const siblingId = (commit: string): string => commit.slice(0, 12);

/** The branch and sibling id that `refs/heads/meddle/conflict/<b>/<id>` names, or null for any other ref. */
function conflictRef(ref: string): { branch: string; id: string } | null {
  if (!ref.startsWith(CONFLICT)) return null;
  const rest = ref.slice(CONFLICT.length);
  const slash = rest.lastIndexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { branch: rest.slice(0, slash), id: rest.slice(slash + 1) };
}

async function descendsFromAll(commit: string, siblings: string[], g: Graph): Promise<boolean> {
  for (const s of siblings) if (!(await g.isAncestor(s, commit))) return false;
  return true;
}

/** Steps 2 and 3: the rows left once the deleted and dropped ones are removed, and the branch they give. */
async function resolve(rows: readonly BranchRow[], g: Graph): Promise<{ state: BranchState; live: BranchRow[] }> {
  // A row's drops apply whatever its own state, even if it is deleted or dropped itself.
  const dropped = new Set(rows.flatMap((r) => r.drops.map(keyOf)));
  const live = rows.filter((r) => r.commit !== null && !dropped.has(keyOf(r)));
  const commits = [...new Set(live.map((r) => r.commit!))];
  const heads: string[] = [];
  for (const c of commits) {
    let covered = false;
    for (const d of commits) {
      if (d !== c && await g.isAncestor(c, d)) {
        covered = true;
        break;
      }
    }
    if (!covered) heads.push(c);
  }
  const refs = live.map(refOf);
  if (heads.length === 0) return { state: { kind: "absent" }, live };
  if (heads.length === 1) return { state: { kind: "single", commit: heads[0]!, live: refs }, live };
  const siblings = heads.sort();
  const served = (await g.mergeBases(siblings)).sort()[0] ?? null;
  return { state: { kind: "conflicted", siblings, served, live: refs }, live };
}

/** Branch `b` from every node's row for it (`rows` are all of one branch). */
export async function computeBranch(rows: readonly BranchRow[], g: Graph): Promise<BranchState> {
  return (await resolve(rows, g)).state;
}

/**
 * What to do about conflicted branch `branch`, whose siblings are `siblings`: each sibling as a checkout fetches it, and
 * how to keep work of your own that your local bookmark had. A refused push says it, and so does `meddle project status`.
 */
export function conflictFix(branch: string, siblings: readonly string[]): string {
  return [
    `${branch} is conflicted; push a merge of its siblings, or delete the ones you don't want`,
    ...siblings.map((s) => `  ${siblingRef(branch, s)}`),
    `  to keep your own work: jj bookmark set ${branch} -r <your commit>`,
  ].join("\n");
}

/** Sibling `commit` of conflicted branch `branch` as a checkout fetches it: `meddle/conflict/<b>/<id>@meddle`. */
export function siblingRef(branch: string, commit: string): string {
  return `meddle/conflict/${branch}/${siblingId(commit)}@meddle`;
}

/** Why a push is refused (the first refusal among its refs), or null when it's accepted. */
export async function refusePush(pushed: PushedRef[], heads: BranchHeads, g: Graph): Promise<string | null> {
  for (const { ref, new: next } of pushed) {
    if (ref.startsWith(INCOMING)) continue;
    const reserved = isReserved(ref);
    if (!ref.startsWith(HEADS) || (reserved && !(next === null && conflictRef(ref)))) {
      return `ref ${ref} is not accepted here`;
    }
    if (reserved || next === null) continue;
    const branch = ref.slice(HEADS.length);
    const siblings = heads.find((h) => h.branch === branch)?.commits ?? [];
    if (siblings.length < 2 || await descendsFromAll(next, siblings, g)) continue;
    return conflictFix(branch, siblings);
  }
  return null;
}

/**
 * The branch rows node `selfId` writes for a push that `refusePush` accepted, one per branch it touched, each to be
 * written with its seq + 1. `rows` are the project's rows as this node has them before the push.
 */
export async function planPush(
  selfId: string, project: string, pushed: PushedRef[], rows: readonly BranchRow[], g: Graph,
): Promise<Array<Omit<BranchRow, "seq" | "node">>> {
  const seen = rows.filter((r) => r.project === project);
  // The rows as they stand after the refs handled so far, so that a later ref of the push sees what an earlier one did.
  let working = seen;
  const planned = new Map<string, Omit<BranchRow, "seq" | "node">>();
  const ofBranch = (rs: readonly BranchRow[], branch: string) => rs.filter((r) => r.branch === branch);

  /** Writes this node's row for `branch`: `commit`, with the drops its row carried plus `added`. */
  function record(branch: string, commit: string | null, added: RowRef[]): void {
    const mine = working.find((r) => r.branch === branch && r.node === selfId);
    // A drop of (n, s) is pruned once a row from n with a seq above s has been seen: that row supersedes it anyway.
    const superseded = (d: RowRef) => seen.some((r) => r.branch === branch && r.node === d.node && r.seq > d.seq);
    const drops = new Map<string, RowRef>();
    for (const d of [...(mine?.drops ?? []), ...added]) if (!superseded(d)) drops.set(keyOf(d), refOf(d));
    const row = { project, branch, commit, drops: [...drops.values()] };
    working = [...working.filter((r) => r !== mine), { ...row, node: selfId, seq: (mine?.seq ?? 0) + 1 }];
    planned.set(branch, row);
  }

  for (const { ref, new: next } of pushed) {
    const conflict = conflictRef(ref);
    if (conflict && next === null) {
      // A drop of a sibling: of the siblings this push saw, the one its conflict ref names.
      const { branch, id } = conflict;
      const before = (await resolve(ofBranch(seen, branch), g)).state;
      const sibling = before.kind === "conflicted" ? before.siblings.find((s) => siblingId(s) === id) : undefined;
      if (sibling === undefined) continue;
      const { live } = await resolve(ofBranch(working, branch), g);
      const mine = live.find((r) => r.node === selfId);
      // Your row keeps its commit unless it's at the sibling; no row (or none live) is written deleted.
      const commit = mine && mine.commit !== sibling ? mine.commit : null;
      record(branch, commit, live.filter((r) => r.commit === sibling).map(refOf));
    } else if (ref.startsWith(HEADS) && !isReserved(ref)) {
      const branch = ref.slice(HEADS.length);
      const { state, live } = await resolve(ofBranch(working, branch), g);
      const fastForward = next !== null && (
        (state.kind === "single" && await g.isAncestor(state.commit, next))
        || (state.kind === "conflicted" && await descendsFromAll(next, state.siblings, g))
      );
      // A forced push (a rewind, a sideways move or a deletion) drops every current row, not only the heads.
      record(branch, next, fastForward ? [] : live.map(refOf));
    }
    // `refs/meddle/incoming/*` records nothing.
  }
  return [...planned.values()];
}
