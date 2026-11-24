# Pool-wide profile and memory sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the home-based memory sync and the never-synced per-node profile with one mechanism: every node's
copy of a synced directory (a *scope*) is a jj repo whose head is published as a row, fetched by id from any member,
and merged deterministically by git with meddle's own merge drivers.

**Architecture:** `src/scopes/` holds the scope repo plumbing (local commits, deterministic merges, working-copy
moves), the merge drivers and the per-node sync loop. Head rows (`src/pool/heads.ts`) ride pool sync on a new peer
object (`ScopeHeadsObject`) so older peers still bind. Memory and the profile become two kinds of scope; the turn-time
memory sync, the home's role for memory, and the profile's per-node seeding are removed or reworked around it.

**Tech Stack:** Bun + TypeScript, bun:sqlite, chord objects, jj 0.45, git ≥ 2.43 (`merge-tree --write-tree -X`).

**Spec:** `docs/superpowers/specs/2026-11-24-pool-profile-memory-sync-design.md` (read it first; section numbers
below refer to it). Spike: `/tmp/meddle-spike/spike.ts` and `memunion.sh` (may be gone; the algorithm is restated
here).

## Global Constraints

- Run tests with `~/.bun/bin/bun test <files>` and typecheck with `~/.bun/bin/bun run typecheck`; run only the
  affected test files, never the whole suite.
- Commit with jj (`jj commit -m "<4-7 word description>"`), no AI attribution in messages.
- No conflict marker may ever be written into a scope's working copy; nothing may wait for a home, an idle project, or
  a human.
- Merge results must be a pure function of (base, ours, theirs, path): no git `merge-file`, no locale, no time.
- Merge commits: author and committer `meddle <meddle@localhost>`, both dates the later of the parents' committer
  dates, message `merge\n\nmeddle-merge: 1\n`, parents ordered by the id of the node each came from.
- `RULE_VERSION = 1`. A head row of another rule version is never merged (logged once per node and version).
- `git merge-tree` always runs with `-X no-renames` and `--allow-unrelated-histories`.
- Merge commit trees and published heads never contain a `.jjconflict-*` entry.
- `skills/synced/` is never part of the profile (excluded from snapshots, skipped by seeding and import).
- User-facing text (log lines, CLI output, dashboard labels): terse, one term per concept; the scope is called
  "profile" or "memory", never "scope", outside code.

## Review Focus

1. A Claude writes a memory file in the instant between the syncer's local commit and its working-copy move: the write
   must survive (Task 3 test `a write landing during a move is kept`).
2. Two nodes both edit `settings.json` while apart: the merged file must parse as JSON on every node (Task 1 driver
   tests, Task 4 test `concurrent settings edits stay valid JSON`).
3. A node upgraded with seven hours of uncommitted memory and a never-synced profile: memory is committed and published
   on first start; the profile is untouched until `meddle profile import` (Task 7 and Task 8 upgrade tests).
4. A peer's head row names a commit no reachable member can serve: that row waits; every other peer's head still merges
   (Task 6 test `an unreachable head does not hold up the others`).
5. Five nodes editing and syncing in random orders: every node ends on the identical commit, no line lost or
   duplicated (Task 4 randomized test).

## Review amendments (override the tasks below where they differ)

From the Opus plan review; several confirmed by experiment with jj 0.45.1 / git 2.47.3.

- **A1 (Task 2, `prepareScopeRepo`)** also sets, with `jj config set --repo`: `git.abandon-unreachable-commits false`
  and `snapshot.max-new-file-size "50MiB"`.
- **A2 (Task 2, `moveTo`)** never uses `gitImport` (`--ignore-working-copy`): a sideways bookmark move then leaves the
  working copy stale and every later jj call fails. Sequence: record `@`'s change id; `git update-ref
  refs/heads/<bm> <commit>`; plain `jj git import` (snapshots first); `jj new <bm>`; the stray is the recorded change
  id when it is non-empty (`jj log -r <changeid> -T empty`), merged as in the task. Note in the code: a write landing
  inside jj's own snapshot-to-checkout window (milliseconds) can still be overwritten; inherent.
- **A3 (Task 2, `headOf`)** reads `git rev-parse --verify -q refs/heads/<bm>` (sees a pushed move).
- **A4 (Task 2, `commitLocal`)** moves the bookmark onto `@-` only when the bookmark is an ancestor of `@-` (or absent).
  Otherwise the bookmark is a second local head (an old node's push, a dashboard write): fast-forward when `@-` is an
  ancestor of it, else `mergeHeads`; return that head; the caller `moveTo`s whenever the returned head differs from
  `@-`. A conflicted jj bookmark (several targets, possible in an upgraded repo) counts each target as a local head,
  folded in commit-id order. Task 6 step b is dropped. `writeMemory` (Task 7) uses the same rule.
- **A5 (Task 2, `mergeHeads`)**:
  - runs `git -c core.commitGraph=false merge-tree --write-tree --name-only -z --messages -X no-renames
    --allow-unrelated-histories --merge-base <B> first second` and reads the output from `GitError.stdout` on exit 1;
  - `<B>` is computed by meddle, not git: `git merge-base --all first second` sorted by id; none → the empty tree's
    commit (a parentless commit of the empty tree, fixed metadata); one → it; several → folded left in id order, each
    step `mergeHeads(acc, next)` (recursing for its own bases) producing an unreferenced virtual commit;
  - exit 1 is accepted only when every conflict message is `CONFLICT (modify/delete)` (the edited side stays);
    other non-content conflicts (file/directory, mode, symlink, add/add of different types) are resolved by taking the
    second parent's entry for that path, rebuilding the tree in a temporary index (`GIT_INDEX_FILE`, `read-tree`,
    `update-index --index-info`, `write-tree`); a `CONFLICT (content)` means a driver failed: throw;
  - the seed replay (Task 4/8) passes its own base and gets one parent, as before.
- **A6 (Task 2, `resolveConflicts`)** folds whole side trees: wrap each `.jjconflict-base-<i>`/`.jjconflict-side-<i>`
  subtree in a parentless commit and fold with `mergeHeads`-style `merge-tree --merge-base` (side0+side1 over base0,
  then + side2 over base1, …); `JJ-CONFLICT-README` and the `.jjconflict-*` entries are dropped. Its caller moves the
  working copy (A4's "head differs from `@-`").
- **A7 (Task 2, `checkGit`)**: floor is **2.43** (`merge-tree -X`), not 2.38.
- **A8 (Task 1, `mergeFile`)** decodes with `new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })`.
- **A9 (Task 4/8, seeds)**:
  - A seed commit carries the trailer `meddle-seed: 1` (today's `seed profile from …` commits do not, so existing
    profiles are never mistaken for seeds). A node's `seed` is a row field carried forward in git config
    `meddle.seed` (set at seeding, replaced at adoption/replay), never recomputed from history.
  - `seedStep`: seed-only vs seed-only → lower node id wins; seed+edits vs unrelated edited: **the lower node id's line
    wins and only the higher node replays** (both replaying would ping-pong forever); after a replay `self.seed =
    p.seed`; a `legacy` line adopts only a peer line with `seed === null && edited` (an imported pool line), never a
    fresh node's seed+edits.
  - A fresh node's first `plugins.json` write must not count as an edit: seeding writes `plugins.json` and
    `plugins-applied.json` together (Task 9 `recordPlugins` then finds no change).
- **A10 (Task 8, `importProfile`)** commits **parentless** (`git commit-tree` without `-p`, then `moveTo`), so legacy
  history (and its `skills/synced` blobs) is never published; `seed = null`, `edited = true`. `seedProfile` sets
  `meddle.profile=seed` in the staging repo before the rename.
- **A11 (Task 6)**:
  - fetches happen **outside** `repoKey` (as `applyProject` does); only repo steps take the lock;
  - `syncNow` is never awaited while holding `repoKey` (`serialised` is not re-entrant);
  - `moveTo` runs when the reconciled head differs from `@-`, not from the bookmark;
  - `forget(scope)` stops a scope's watcher and waits for its pass; a pass checks `isRemoved` under the lock before
    `ensureMemoryReplica`; `removal.ts` calls `forget` and does its `rm` of the memory dir under `repoKey(dir)`;
  - Task 6 tests drive `startScopeSync` directly; wiring it into `serve` moves to Task 7, together with removing
    `syncMemoryAfter`/`followHome`;
  - the turn-end attribution test uses a large `quietMs`.
- **A12 (Task 6/7, attribution)**: messages are `memory from <short>: task <a>[, <b>…]`; update the parser in
  `src/projects/memory-view.ts:203` to accept the list. `#primaries` in `durable.ts` stays (it is the record of live
  tasks per project); expose `TaskRunner.liveTasks(projectId): string[]` from it.
- **A13 (Task 7, upgrade)**: before the first publish, files containing jj's materialised markers as text
  (`<<<<<<< conflict`/`>>>>>>> conflict … ends`, diff or snapshot style) are parsed back into base and sides and
  replaced with `mergeFile` of them; a file whose markers can't be parsed is left as is and logged.
- **A14 (Task 7, moves and new tasks)**: provisioning (`src/tasks/provision.ts:270, 418`) runs `prepareScopeRepo` on
  the memory replica, and the runner calls `scopeSync.syncNow(memory scope)` before a task's first turn on a node
  (outside any lock); a failure is logged and the turn goes ahead.
- **A15 (Task 9, `ownPluginsDir`)** removes the symlink before renaming the copy into place.
- **A16 (accepted, documented)**: adopting the lower commit when trees match can drop a node's intermediate versions
  from the dashboard's history (the objects stay in git). Say so in the README's Memory section.

---

### Task 1: Merge drivers

Pure functions, no I/O: the bytes a merge produces on every node.

**Files:**
- Create: `src/scopes/merge-file.ts`
- Create: `src/scopes/merge-driver-main.ts`
- Modify: `src/git/scripts.ts` (add `writeMergeDriver`), `src/paths.ts` (add `binMergeDriver: join(bin, "meddle-merge-driver")`), `src/cli.ts:177-178` (write it at start next to the others; dispatch `merge-driver` as a no-node command at `:1744` and `:1850`)
- Test: `test/merge-file.test.ts`

**Interfaces:**
- Produces:
  - `export const RULE_VERSION = 1;`
  - `export type MergeKind = "lines" | "json" | "whole";`
  - `export function mergeKind(path: string): MergeKind` — `*.md`, `*.txt` → lines; `*.json` → json; else whole.
  - `export function mergeLines(base: string, ours: string, theirs: string): string`
  - `export function mergeJson(base: string, ours: string, theirs: string): string`
  - `export function mergeWhole(base: Uint8Array, ours: Uint8Array, theirs: Uint8Array): Uint8Array`
  - `export function mergeFile(path: string, base: Uint8Array, ours: Uint8Array, theirs: Uint8Array): Uint8Array`
  - `writeMergeDriver(cfg): Promise<string>` writes `<data>/bin/meddle-merge-driver`: `exec <meddle> merge-driver "$@"` (as `writePreReceiveHook`, entry `../scopes/merge-driver-main.ts` resolved like `meddleCommand`; `meddleCommand` takes the entry relative to `src/git/`, so pass `"../scopes/merge-driver-main.ts"`).
  - CLI `meddle merge-driver <base> <ours> <theirs> <path>`: reads the three files, writes `mergeFile(path, …)` over `<ours>`, exit 0 (git's `%O %A %B %P`). Any exception: exit 1.

- [ ] **Step 1: Write the failing tests** in `test/merge-file.test.ts`:

```ts
test("both sides' appended lines are kept, the first parent's first", () => {
  expect(mergeLines("a\nb\n", "a\nb\nx\n", "a\nb\ny\n")).toBe("a\nb\nx\ny\n");
});
test("a line both sides already hold is kept once", () => {
  // Both merged "p" in by different routes at different places: no duplicate.
  expect(mergeLines("a\n", "a\np\nx\n", "p\na\ny\n").split("\n").filter((l) => l === "p")).toHaveLength(1);
});
test("blank lines are not capped", () => {
  expect(mergeLines("a\n", "a\n\nx\n", "a\n\ny\n")).toBe("a\n\nx\n\ny\n");
});
test("one-sided edits merge cleanly", () => {
  expect(mergeLines("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n")).toBe("A\nb\nC\n");
});
test("the same line edited on both sides keeps both versions", () => {
  expect(mergeLines("a\nb\n", "a\nB1\n", "a\nB2\n")).toBe("a\nB1\nB2\n");
});
test("a file without a final newline merges", () => {
  expect(mergeLines("a", "a\nx", "a\ny")).toBe("a\nx\ny");
});
test("json: keys changed on one side each, both kept", () => {
  expect(JSON.parse(mergeJson('{"a":1}', '{"a":1,"b":2}', '{"a":1,"c":3}'))).toEqual({ a: 1, b: 2, c: 3 });
});
test("json: a key changed to different values on both sides takes the second parent's", () => {
  expect(JSON.parse(mergeJson('{"m":"x"}', '{"m":"y"}', '{"m":"z"}'))).toEqual({ m: "z" });
});
test("json: arrays changed on both sides are the first's items then the second's new ones", () => {
  expect(JSON.parse(mergeJson('{"l":["a"]}', '{"l":["a","b"]}', '{"l":["a","c"]}'))).toEqual({ l: ["a", "b", "c"] });
});
test("json: nested objects merge per key; a key deleted on one side and untouched on the other goes", () => {
  expect(JSON.parse(mergeJson('{"p":{"x":1,"y":2}}', '{"p":{"x":1}}', '{"p":{"x":1,"y":2,"z":3}}'))).toEqual({ p: { x: 1, z: 3 } });
});
test("json: an unparseable side loses to the parseable one", () => {
  expect(mergeJson('{"a":1}', '{"a":', '{"a":2}')).toBe('{\n  "a": 2\n}\n');
});
test("json: output is two-space indented with a final newline", () => {
  expect(mergeJson("{}", '{"a":1}', "{}")).toBe('{\n  "a": 1\n}\n');
});
test("whole: changed on both sides, the second parent's wins", () => {
  expect(mergeWhole(enc("a"), enc("b"), enc("c"))).toEqual(enc("c"));
});
test("whole: changed on one side only, that side's", () => {
  expect(mergeWhole(enc("a"), enc("b"), enc("a"))).toEqual(enc("b"));
});
test("mergeFile picks the rule by name", () => {
  expect(mergeKind("MEMORY.md")).toBe("lines");
  expect(mergeKind("settings.json")).toBe("json");
  expect(mergeKind("hooks/run.sh")).toBe("whole");
});
test("every rule is deterministic", () => { /* 200 random (base, ours, theirs) triples: two calls give equal output */ });
test("the driver command merges a file in place", async () => {
  // spawn `bun src/cli.ts merge-driver <o> <a> <b> MEMORY.md` on temp files; <a> then holds mergeLines' output, exit 0
});
```

- [ ] **Step 2: Run** `~/.bun/bin/bun test test/merge-file.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/scopes/merge-file.ts`.** `mergeLines` is a diff3 merge over lines (split keeping a
  final-newline flag; the result ends with a newline iff ours or theirs did), using a Myers/LCS diff of base→ours and
  base→theirs written here (no dependency). Stable regions are copied; a region changed on one side takes that side;
  a region changed on both sides identically takes it once; otherwise ours' lines then theirs'. Then the cap:

```ts
// After the union: no non-blank line more often than the side that has it most.
const most = new Map<string, number>();
for (const side of [oursLines, theirsLines]) {
  const count = new Map<string, number>();
  for (const l of side) count.set(l, (count.get(l) ?? 0) + 1);
  for (const [l, n] of count) most.set(l, Math.max(most.get(l) ?? 0, n));
}
const seen = new Map<string, number>();
const out = merged.filter((l) => {
  if (l.trim() === "") return true;
  const n = (seen.get(l) ?? 0) + 1;
  seen.set(l, n);
  return n <= (most.get(l) ?? 0);
});
```

  `mergeJson`: parse all three (a base that does not parse counts as `{}`); recursive per-key three-way merge as the
  tests state (equal values on both sides: that value; a key absent from a side counts as deleted only if base had it);
  non-object values are compared with deep equality; output `JSON.stringify(v, null, 2) + "\n"`. Both sides
  unparseable: fall back to `mergeWhole` on the bytes. `mergeWhole`: ours if theirs equals base, theirs if ours equals
  base, else theirs. `mergeFile`: decode UTF-8 for lines/json; bytes that are not valid UTF-8 go to `mergeWhole`.

- [ ] **Step 4: Implement the driver entry and script** (`merge-driver-main.ts` with `import.meta.main` like
  `src/git/pre-receive.ts`), `writeMergeDriver`, the `paths` entry and the CLI dispatch.

- [ ] **Step 5: Run** `~/.bun/bin/bun test test/merge-file.test.ts` and `~/.bun/bin/bun run typecheck` — Expected: PASS.

- [ ] **Step 6: Commit** `jj commit -m "Add deterministic merge drivers for synced files"`.

---

### Task 2: Scopes and their repos

**Files:**
- Create: `src/scopes/scope.ts`
- Create: `src/scopes/repo.ts`
- Test: `test/scope-repo.test.ts`

**Interfaces:**
- Consumes: Task 1 `RULE_VERSION`; `paths(cfg).binMergeDriver`; `jj`, `git`, `gitImport`, `bookmarkSet` from `src/jj.ts`.
- Produces (`scope.ts`, no `node:` imports beyond `path`):
  - `export type Scope = { kind: "profile" } | { kind: "memory"; projectId: string };`
  - `export function scopeKey(s: Scope): string` — `"profile"` or `"memory/<projectId>"`.
  - `export function parseScopeKey(key: string): Scope | null` — project ids as `SAFE_ID` (`src/tasks/provision.ts`).
  - `export function scopeBookmark(s: Scope): "profile" | "memory"`
  - `export function scopeDir(cfg: NodeConfig, s: Scope): string` — `paths(cfg).profile` / `paths(cfg).memory(id)`.
- Produces (`repo.ts`; every function expects the caller to hold `serialised(repoKey(dir), …)`):
  - `export async function prepareScopeRepo(cfg, dir: string, s: Scope): Promise<void>` — idempotent: `.git/info/attributes` = `* merge=meddle\n`; `git config merge.meddle.driver "<binMergeDriver> %O %A %B %P"`, `merge.meddle.name meddle`; for the profile, `.git/info/exclude` contains `/skills/synced/`.
  - `export async function commitLocal(cfg, dir, s: Scope, message: string): Promise<string | null>` — snapshots; when `@` is non-empty, `jj commit -m message`; when `@-` then has conflicts, resolves them first (`resolveConflicts`); moves the scope bookmark onto `@-` when it is not already; returns the bookmark's commit id (null when the repo has no commit but root).
  - `export async function headOf(cfg, dir, s): Promise<string | null>` — the bookmark's commit id, read with `--ignore-working-copy`.
  - `export async function isAncestor(cfg, dir, a: string, b: string): Promise<boolean>` — `git merge-base --is-ancestor`.
  - `export async function sameTree(cfg, dir, a: string, b: string): Promise<boolean>` — `git rev-parse a^{tree}` equal.
  - `export async function mergeHeads(cfg, dir, first: string, second: string, base?: string): Promise<string>` — `git -c merge.meddle.driver=… merge-tree --write-tree -X no-renames --allow-unrelated-histories [--merge-base base] first second`, then `git commit-tree <tree> -p first -p second` with the fixed metadata of Global Constraints (env `GIT_AUTHOR_*`, `GIT_COMMITTER_*`). When the merge has a base given (seed replay, Task 8) the commit has one parent, `second`. Throws when the tree has a `.jjconflict-*` entry. Returns the new commit id (not yet referenced).
  - `export async function moveTo(cfg, dir, s, commit: string): Promise<void>` — points the bookmark at `commit` (`git update-ref refs/heads/<bm>` then `gitImport`) and brings the working copy onto it: `jj new <bm>`; then, if the working-copy commit that was replaced is non-empty (a write landed after the caller's `commitLocal`), commits it as a local commit, merges it with the bookmark (`mergeHeads(bookmark, stray)`), and repeats the move. Never leaves the working copy conflicted.
  - `export async function checkGit(): Promise<void>` — throws `meddle needs git 2.43 or later (found <v>)` below 2.43; called by `serve` at start (`src/cli.ts`, next to the script writes), which then refuses to start.
  - `export async function resolveConflicts(cfg, dir, rev: string): Promise<string>` — for a commit whose git tree holds jj's conflict entries (`.jjconflict-base-<i>/`, `.jjconflict-side-<i>/`), builds the resolved tree by folding the sides pairwise with `mergeFile` (side 0 with side 1 over base 0, that result with side 2 over base 1, …), writes it with `git mktree`/`commit-tree` (parents and message of `rev`), and points the scope bookmark at it. Returns the new commit id.

- [ ] **Step 1: Write failing tests** in `test/scope-repo.test.ts` (temp dirs; `setupNode` from `test/helpers.ts` for a `cfg`):
  - `prepareScopeRepo is idempotent and sets the driver` — run twice; `git config merge.meddle.driver` ends with `%O %A %B %P`; attributes file is exactly `* merge=meddle\n`.
  - `commitLocal commits what changed and moves the bookmark` — write `MEMORY.md`; returns a commit; `headOf` equals it; a second call with nothing written returns the same id.
  - `skills/synced is never committed in the profile` — write `skills/synced/x/SKILL.md` and `skills/babysit/SKILL.md`; after `commitLocal`, `git ls-tree -r` lists only the babysit file.
  - `mergeHeads makes the identical commit on two repos` — two repos with the same two commits (fetched between them by path); `mergeHeads(a, b)` in each returns the same id; the merged `MEMORY.md` has both appended lines.
  - `mergeHeads of a modify/delete keeps the edit`.
  - `mergeHeads of unrelated histories unions both` — two repos each `jj git init`ed with their own first commit.
  - `moveTo brings the files onto the commit`.
  - `a write landing during a move is kept` — call `moveTo` with a hook (test-only option `beforeNew?: () => Promise<void>` on `moveTo`) that writes `late.md`; afterwards `late.md` is on disk, committed under the bookmark, and the working copy has no conflicts.
  - `resolveConflicts folds a three-sided conflict` — build a conflicted commit with jj (`jj new A B C`, as the spike's failure); after `resolveConflicts`, `jj log -r <bm> -T conflict` is `false` and `MEMORY.md` has all three sides' lines once.

- [ ] **Step 2: Run** `~/.bun/bin/bun test test/scope-repo.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement `scope.ts` and `repo.ts`.**
- [ ] **Step 4: Run** the test file and typecheck — Expected: PASS.
- [ ] **Step 5: Commit** `jj commit -m "Add scope repos with deterministic merges"`.

---

### Task 3: Head rows

**Files:**
- Modify: `src/store/db.ts` (two tables in `MIGRATIONS`)
- Create: `src/pool/heads.ts`
- Test: `test/heads.test.ts`

**Interfaces:**
- Consumes: `parseScopeKey` (Task 2), `isRemoved`/`removedIds` (`src/pool/removed.ts`), `topic` (`src/pool/rows.ts`), `COMMIT_ID`.
- Produces:
  - `export type HeadRow = { scope: string; node: string; seq: number; commit: string | null; rule: number; seed: string | null; edited: boolean };` — `seed`: the seed commit the line starts from (profile only, else null); `edited`: the line holds more than its seed (always true for memory).
  - Tables `scope_heads` and `scope_heads_waiting`, both `(scope TEXT, node TEXT, seq INTEGER, commit_id TEXT NULL, rule INTEGER, seed TEXT NULL, edited INTEGER, PRIMARY KEY (scope, node))`.
  - `export const headChanges: Subscribable<string>` — fires with a scope key when an admitted row changed or a row started waiting.
  - `export function writeHeadRow(db, selfId: string, row: Omit<HeadRow, "node" | "seq">): HeadRow` — seq one above the highest seen for (scope, self) in either table; refuses a removed project's memory scope.
  - `export function mergeHeadRows(db, rows: readonly HeadRow[]): { changed: string[]; rejected: number }` — validates (scope parses, commit is `COMMIT_ID` or null, seed is `COMMIT_ID` or null, integers, booleans); greater seq wins, then greater `JSON.stringify([commit, rule, seed, edited])`; a winner goes to the waiting table; removed projects' scopes skipped.
  - `export function settleHeadRows(db, scope: string, present: ReadonlySet<string>): boolean` — admits waiting rows whose commit is present (or null), as `settleBranchRows`.
  - `export function waitingHeadRows(db, scope: string): HeadRow[]`, `export function listHeadRows(db, scope?: string): HeadRow[]`, `export function allHeadRows(db): HeadRow[]` (admitted only: what pool sync carries).
  - `export function deleteScopeRows(db, scope: string): void`; `deleteProjectRows` (`rows.ts`) also deletes `memory/<id>` head rows.

- [ ] **Step 1: Write failing tests** mirroring `test/rows.test.ts`'s branch-row cases: write seq increments; merge keeps the greater seq; ties settle on content; a peer row waits until `settleHeadRows` sees its commit; a malformed row is rejected and counted; a removed project's memory row is skipped and `writeHeadRow` refuses it; `deleteProjectRows` drops its memory head rows.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/heads.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the tables and `heads.ts`, modelled on the branch-row code in `src/pool/rows.ts`.
- [ ] **Step 4: Run** `test/heads.test.ts test/rows.test.ts` and typecheck — Expected: PASS.
- [ ] **Step 5: Commit** `jj commit -m "Add head rows for synced scopes"`.

---

### Task 4: Reconciling heads

The merge loop, network-free: given the heads a repo holds, move this node's head. This is where convergence lives.

**Files:**
- Create: `src/scopes/reconcile.ts`
- Test: `test/reconcile.test.ts`

**Interfaces:**
- Consumes: Task 2 (`headOf`, `isAncestor`, `sameTree`, `mergeHeads`), Task 3 `HeadRow`, `RULE_VERSION`.
- Produces:
  - `export type Peer = { node: string; commit: string; seed: string | null; edited: boolean };`
  - `export type Reconciled = { head: string | null; skipped: Array<{ node: string; why: "rule" | "seed" }> };`
  - `export async function reconcile(cfg, dir: string, self: { node: string; seed: string | null; edited: boolean; legacy: boolean }, own: string | null, peers: Peer[], opts?: { profile?: boolean }): Promise<Reconciled>` — every peer commit must already be in the repo. Does not move bookmarks or the working copy: returns the head the caller then `moveTo`s.

- [ ] **Step 1: Write failing tests:**
  - `fast-forwards to a descendant`, `keeps a head that already contains the peer's`, `adopts the peer's head when it has none`.
  - `merges a diverged peer with parents in node-id order` — same result whichever side calls it.
  - `adopts the lower commit when files match but histories differ` (the spike's adopt rule: same tree, neither an ancestor → the lexically lower commit id).
  - `concurrent settings edits stay valid JSON`.
  - `converges across five nodes` — the spike as a test: N repos in a temp dir; a deterministic PRNG (seed from `MEDDLE_RECONCILE_SEED`, default 1) chooses edits (new memory file plus pointer line in `MEMORY.md`, a line edit, a delete) and partial syncs; a sync of node n fetches the chosen peers' heads into n's repo (`git fetch <peerdir> <commit>:refs/meddle/fetched/<commit>`), `commitLocal`s, `reconcile`s, `moveTo`s; then full rounds until no head moves. Assert: identical head commit on every node within 3 full rounds, every pointer line present exactly once, no `<<<<<<<`, `>>>>>>>`, `%%%%%%%` or `+++++++` line in any file. Steps default to 40 with 3 nodes; `MEDDLE_RECONCILE_STEPS`, `MEDDLE_RECONCILE_NODES` raise them.
  - Profile cases (`opts.profile`), each from the spec 6.5: `a seed-only line takes a peer's edited line`; `of two seed-only lines the lower node id's wins` (the higher node adopts it; the lower skips the peer, `why: "seed"`); `an edited line skips a seed-only peer`; `a legacy line takes the first edited peer line and skips seed-only ones`; `seed plus edits meeting an unrelated edited line replays only the edits` (result has one parent, the peer's head, and contains the peer's files plus this line's edits, not the seed's other files); `an edited line waits for a peer whose seed line is unrelated and edited` (skipped with `why: "seed"`: the seeded node replays, Task 8); `two unrelated edited lines without seeds merge with an empty base`.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/reconcile.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement `reconcile`:**

```ts
let head = own;
for (const p of [...peers].sort((a, b) => (a.node < b.node ? -1 : 1))) {
  if (opts?.profile) {
    const step = seedStep(self, head, p);         // spec 6.5, the rules the tests list
    if (step === "skip") { skipped.push({ node: p.node, why: "seed" }); continue; }
    if (step === "adopt") { head = p.commit; self = { ...self, legacy: false, seed: p.seed, edited: p.edited }; continue; }
    if (step === "replay") { head = await mergeHeads(cfg, dir, head!, p.commit, self.seed!); continue; }
  }
  if (head === null) { head = p.commit; continue; }
  if (head === p.commit || (await isAncestor(cfg, dir, p.commit, head))) continue;
  if (await isAncestor(cfg, dir, head, p.commit)) { head = p.commit; continue; }
  if (await sameTree(cfg, dir, head, p.commit)) { head = head < p.commit ? head : p.commit; continue; }
  const [first, second] = self.node < p.node ? [head, p.commit] : [p.commit, head];
  head = await mergeHeads(cfg, dir, first, second);
}
```

  `seedStep` lives in this file and is exported for Task 8. "Unrelated" is `git merge-base` finding none.
- [ ] **Step 4: Run** the test file (default size, then once with `MEDDLE_RECONCILE_NODES=5 MEDDLE_RECONCILE_STEPS=160`) and typecheck — Expected: PASS.
- [ ] **Step 5: Commit** `jj commit -m "Reconcile scope heads deterministically"`.

---

### Task 5: Heads over pool sync and git

**Files:**
- Modify: `src/state/contracts.ts` (add `HeadRowSchema`, `ScopeHeadsObject` = `remote("meddle.scope-heads", …)` with a `peer` variant whose state is `heads: Type.Array(HeadRowSchema)`, and a `default` variant whose state is `scopes` — see Task 10)
- Create: `src/pool/heads-object.ts` (`serveScopeHeads(host, { db })`, as `src/pool/removed-object.ts`)
- Modify: `src/pool/sync.ts` (hold each peer's `ScopeHeadsObject` like `holdRemoved`: `held | older | pending`, `mergeHeadRows` on every `heads` update, `onChange` when changed)
- Modify: `src/state/host.ts:339` (serve it next to `serveRemovedProjects`)
- Modify: `src/git/wire.ts` (repo kind `"profile"`, name `profile/pool`), `src/git/serve.ts` (`repoPath` for `profile`; a peer's `receive-pack` to `profile/…` is refused like one to a project)
- Modify: `src/projects/applier.ts` (`fetchCommit` takes the remote `Repo` instead of a project id; export it and `sourcesFor`)
- Test: `test/heads-sync.test.ts`, `test/git.test.ts` (extend)

**Interfaces:**
- Consumes: Task 3.
- Produces:
  - `export function fetchCommit(deps: ReplicaDeps, dir: string, remote: Repo, commit: string, sources: string[], deadline: number): Promise<boolean>`
  - `export function sourcesFor(deps: ReplicaDeps, writers: Set<string>): string[]`
  - `PoolSync.headsSupport(peerId): "held" | "older" | "pending"`

- [ ] **Step 1: Write failing tests:** two pool nodes (`twoNodes` from `test/pool-helpers.ts`): a head row written on A appears in B's waiting table; a peer serving no `ScopeHeadsObject` reads as `older` and its `PoolObject` is still held; `git fetch meddle://<A>/profile/pool <commit>` from B fetches a commit of A's profile repo by id; a peer's push to `profile/pool` is refused.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/heads-sync.test.ts test/git.test.ts test/applier.test.ts` — Expected: FAIL on the new cases.
- [ ] **Step 3: Implement** the contract, server, hold, transport kind and the `fetchCommit` generalisation (the applier's own call passes `{ kind: "project", id }`).
- [ ] **Step 4: Run** the same files and typecheck — Expected: PASS.
- [ ] **Step 5: Commit** `jj commit -m "Carry scope heads over pool sync"`.

---

### Task 6: The scope syncer

**Files:**
- Create: `src/scopes/sync.ts`
- Modify: `src/cli.ts:263` (start it after the applier; stop it with the node), `src/projects/removal.ts` (remove the project's memory head rows via `deleteProjectRows`)
- Test: `test/scope-sync.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5; `memoryChanged` (`src/projects/memory-sync.ts`, kept); `listProjects`.
- Produces:
  - `export type ScopeSyncDeps = ReplicaDeps & { liveTasks?(projectId: string): string[]; quietMs?: number; scanMs?: number };`
  - `export function startScopeSync(deps: ScopeSyncDeps): ScopeSync`
  - `export type ScopeSync = { touched(s: Scope, taskId?: string): void; syncNow(s: Scope): Promise<void>; stop(): void; state(): ScopeState[] };`
  - `export type ScopeState = { scope: string; head: string | null; behind: number; waiting: Array<{ node: string; why: "fetch" | "rule" | "seed" }> };`

Behaviour (one pass per scope at a time; a trigger during a pass runs one more after it; a pass never throws, it logs `meddle: memory of <short id>: …` or `meddle: profile: …`, at most once a minute per message):

1. The scopes held: `profile` (once Task 8 says the profile takes part) and `memory/<id>` for every project in `listProjects` not removed (memory repo created with `ensureMemoryReplica` when missing, then `prepareScopeRepo`).
2. Triggers: start; `headChanges(scope)`; a peer coming online; `touched(scope)` (turn ends; dashboard writes); an `fs.watch(dir, { recursive: true })` event outside `.jj/` and `.git/`, debounced `quietMs` (default 1000); a scan every `scanMs` (default 30000).
3. A pass, under `serialised(repoKey(dir))` for each repo step:
   a. `commitLocal` with `memory from <shortId(self)>` plus `: task <id>[, <id>…]` from `liveTasks` (the turn-end trigger's task id first); for the profile `profile from <shortId(self)>`.
   b. Legacy push (spec 6.7): when this node's own admitted row names a commit that the bookmark no longer descends from (an old node pushed `memory`), merge them as two local heads (`mergeHeads(ownRowCommit, bookmark)`).
   c. Fetch: for each waiting row of the scope whose commit is absent, `fetchCommit` (writer first) into the repo as `refs/meddle/fetched/<commit>`; then `settleHeadRows(scope, present)`.
   d. Peers: admitted rows of other nodes with a commit; a row whose `rule !== RULE_VERSION` is skipped (`waiting … why: "rule"`, logged once per node and version).
   e. `reconcile`; when the head differs from the bookmark, `moveTo` it; `memoryChanged(projectId)` for a memory scope.
   f. Publish: when the bookmark's commit differs from this node's row (or there is none), `writeHeadRow`.
   g. Drop `refs/meddle/fetched/*` refs whose commits are now reachable from the bookmark.

- [ ] **Step 1: Write failing tests** with `twoPoolNodes` / `poolNodes` (3 nodes) from `test/pool-helpers.ts`, small `quietMs`:
  - `a memory written on one node reaches the other within seconds` — write `A/memory/<id>/x.md`; poll B's file (≤ 10 s).
  - `both nodes' concurrent appends to MEMORY.md are kept on both`.
  - `a node that was offline catches up and publishes what it wrote meanwhile`.
  - `an unreachable head does not hold up the others` — insert a waiting row from a fake node naming an absent commit; a real peer's change still arrives.
  - `a turn end commit names the task` — `touched(scope, "t1")` after a write: B's log has `memory from <short A>: task t1`.
  - `a head of another rule version is not merged` — write a peer row with `rule: 2`; `state()` lists it waiting `why: "rule"`.
  - `a removed project's memory stops syncing and its rows go`.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/scope-sync.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement `startScopeSync`** and wire it in `serve`.
- [ ] **Step 4: Run** the file and typecheck — Expected: PASS.
- [ ] **Step 5: Commit** `jj commit -m "Sync scopes continuously across the pool"`.

---

### Task 7: Memory on the new sync

**Files:**
- Modify: `src/projects/memory-sync.ts` (delete `syncMemoryBefore`, `syncMemoryAfter`, `settleMemory`, `followMemory`, `fetchMemory`; keep `memoryChanges`, `memoryChanged`, `memoryPlacing`, `MemoryWriteError`; rework `writeMemory`)
- Modify: `src/tasks/durable.ts:1386-1393` (drop the before-turn sync), `:1527-1534` (replace the after-turn sync with `scopeSync?.touched({ kind: "memory", projectId: primary }, taskId)`; the runner gets the `ScopeSync` through its deps, null without a pool); `#projectLiveElsewhere`/`#primaries` go if nothing else uses them
- Modify: `src/state/host.ts:777-796` (delete `followHome`; keep `memoryHead` refresh on `memoryChanges`), `:807-815` (write on any node)
- Modify: `src/projects/replicas.ts` (`ensureServiceRepo` creates the memory replica locally with `ensureMemoryReplica` instead of `cloneMemory`; delete `cloneMemory`, `cloning`; `settled` waits on `making` only; `pushBookmark` stays only if something else uses it, else goes), `src/memory.ts` (delete `cloneMemoryReplica`)
- Modify: `src/state/contracts.ts:417-424` (doc comment: refusals `changed:`, `path:`, `no-repo:`; `not-home:` and `busy:` gone)
- Modify: `src/dashboard/ui/memory-model.ts` (`memorySource(self, holders, online)`: this node when it holds the project, else the first online holder; always editable), `src/dashboard/ui/Memory.tsx` (callers; a **Restore** action on a history entry of a file: reads `memoryFile({ path, change })`, writes it with `writeMemory` and the current hash as `base`; label "Restore")
- Modify: `src/cli.ts` startup (first start on this build: for every memory repo, `prepareScopeRepo` then the syncer's first pass commits and publishes — no extra code if Task 6's start pass covers it; add a test)
- Test: `test/memory-sync.test.ts` (rewrite), `test/memory.test.ts`, `test/replicas.test.ts`, `test/durable.test.ts`, `test/memory-model.test.ts` if present (update)

**Interfaces:**
- Consumes: Task 6 `ScopeSync`.
- Produces: `writeMemory(deps: ReplicaDeps & { sync: ScopeSync | null }, projectId, path, text: string | null, base: string | null): Promise<{ change: string }>` — under the repo lock: base-hash check, write (`replaceFile` as today), `jj commit -m "memory: dashboard" <fileset>`, bookmark onto it, `sync?.touched(scope)`. Codes: `changed`, `path`, `no-repo`.

- [ ] **Step 1: Rewrite `test/memory-sync.test.ts`** for the new behaviour: `the dashboard writes memory on any node and it spreads`; `a write over text the reader did not see is refused with changed`; `a turn end commits what the turn wrote`; `memory keeps syncing while another task of the project is live` (the bug from spec 1); `a node's first start commits and publishes uncommitted memory`; `an old node's push to memory is folded in` (push a commit to B's `memory` with `git push` over `meddle://`, then B's head contains it and A gets it). Update the other listed tests where they assert home-based behaviour.
- [ ] **Step 2: Run** the listed test files — Expected: FAIL on the new cases.
- [ ] **Step 3: Implement** the removals and rewiring.
- [ ] **Step 4: Run** the listed test files plus `test/move.test.ts test/removal.test.ts test/projects.test.ts` and typecheck — Expected: PASS.
- [ ] **Step 5: Commit** `jj commit -m "Move memory onto continuous scope sync"`.

---

### Task 8: The profile on the new sync

**Files:**
- Modify: `src/profile.ts` (seeding marks the line; legacy state; import)
- Create: `src/scopes/profile-state.ts`
- Modify: `src/scopes/sync.ts` (profile scope: legacy handling, replay), `src/state/contracts.ts` + `src/state/host.ts` (`ProfileObject` = `remote("meddle.profile", …)`, `default` variant only: state `{ state: "legacy" | "seed" | "pool" }`, method `import({ dir }) → { commit }`), `src/cli.ts` (`meddle profile import [<dir>]`), `src/help.ts`
- Test: `test/profile.test.ts` (extend), `test/scope-sync.test.ts` (profile cases)

**Interfaces:**
- Consumes: Tasks 2, 4 (`seedStep`), 6.
- Produces:
  - `export type ProfileState = "legacy" | "seed" | "pool";` stored as `git config meddle.profile` in the profile repo.
  - `export async function profileState(cfg): Promise<ProfileState>` — no key on an existing repo: `legacy` (and set so).
  - `seedProfile(cfg)` — unchanged for a fresh node except: skips `skills/synced`, commits `seed profile from <path>`, sets the bookmark `profile` and state `seed`.
  - `export async function upgradeLegacyProfile(cfg): Promise<void>` — on an existing repo without the key: removes `skills/synced` from the working copy, `prepareScopeRepo`, state `legacy`. Never published.
  - `export async function importProfile(cfg, dir: string, sync: ScopeSync): Promise<string>` — under the lock: replaces every `PROFILE_ENTRIES` entry (and `plugins.json` when the source has one) in the working copy with `dir`'s (default `paths(cfg).profile`, i.e. adopt the legacy content as is), skipping `skills/synced`; commits `profile import from <dir>`; bookmark; state `pool`; `sync.touched(profile)`. Returns the commit.
- Head rows for the profile: `seed` = the seed commit when the line's root is a `seed profile from` commit, else null; `edited` = the line has commits beyond the seed. A `legacy` node publishes nothing and takes the first peer line with `edited` (state → `pool`). A `seed` node becomes `pool` once its line is edited or it adopted an edited one. Replay (`seedStep` → `replay`): only the seeded node acts, rebasing its edits onto the peer's head with its seed as merge base.

- [ ] **Step 1: Write failing tests:** `a fresh node seeds and marks its line a seed`; `an existing profile becomes legacy and is not published`; `legacy nodes keep their own profile until an import`; `an import on one node becomes every node's profile` (3 nodes: A imports; B and C switch; B's `CLAUDE.md` equals A's); `skills/synced is left out of seeding and import`; `a fresh node joining a pool takes the pool's profile`; `a seeded node with edits replays them onto the pool's profile`; `meddle profile import prints the commit` (CLI against a running node, as other CLI tests do).
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/profile.test.ts test/scope-sync.test.ts` — Expected: FAIL on the new cases.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** those files plus `test/provision.test.ts test/cli.test.ts test/help.test.ts` and typecheck — Expected: PASS.
- [ ] **Step 5: Commit** `jj commit -m "Sync the profile across the pool"`.

---

### Task 9: Plugins

**Files:**
- Create: `src/plugins.ts`
- Modify: `src/profile.ts` (`ensurePlugins` makes `<data>/plugins` meddle's own), `src/scopes/sync.ts` (after a profile pass that changed `plugins.json`, and after each local commit that changed `installed_plugins.json`, run the plugin steps)
- Test: `test/plugins.test.ts`

**Interfaces:**
- Produces:
  - `export type PluginList = { plugins: Record<string, { version: string }>; marketplaces: Record<string, { source: unknown }> };` (file `plugins.json` in the profile, two-space JSON).
  - `export async function ownPluginsDir(cfg): Promise<void>` — `<data>/plugins` a symlink, or missing while `~/.claude/plugins` exists: copies the target to `<data>/plugins.copying`, rewrites every string in `installed_plugins.json` and `known_marketplaces.json` that starts with the old directory + `/` to start with `<data>/plugins/`, renames it into place (removing the symlink). Else an empty directory as today.
  - `export function listChanges(applied: PluginList, installed: PluginList): { add: string[]; remove: string[]; upgrade: string[] }`
  - `export async function recordPlugins(cfg): Promise<boolean>` — reads `<data>/plugins/installed_plugins.json` (+ marketplaces) as a `PluginList`, compares with `<data>/plugins-applied.json` (what was last applied), applies only those changes to the profile's `plugins.json`; writes the applied file; true when `plugins.json` changed.
  - `export async function applyPlugins(cfg, run?: (args: string[]) => Promise<void>): Promise<void>` — brings `<data>/plugins` to `plugins.json` with Claude Code's CLI (the binary meddle runs tasks with; env `CLAUDE_CONFIG_DIR=<data>/plugin-admin` whose `plugins` is a symlink to `<data>/plugins`): `plugin marketplace add <source>` for an unknown marketplace, `plugin install <name>@<mkt>` for a missing plugin, `plugin update <name>@<mkt>` when the listed version is newer (compare with a semver-ish split on `.`; never downgrade), `plugin uninstall <name>@<mkt>` for one in the applied file but no longer listed. Then writes the applied file. Each failure logged `meddle: plugin <name>: …`, retried at the next pass.

- [ ] **Step 1: Write failing tests:** `ownPluginsDir replaces the symlink with a copy and rewrites its paths`; `ownPluginsDir leaves an own directory alone`; `listChanges` cases (add, remove, upgrade, a downgrade ignored); `recordPlugins writes only this node's changes` (a plugin another node removed is not put back); `applyPlugins runs install, update and uninstall` (with a fake `run` recording argv).
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/plugins.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; before relying on the CLI, verify by hand once that `claude plugin install superpowers@claude-plugins-official` with `CLAUDE_CONFIG_DIR` set installs into `<that dir>/plugins` (note the outcome in the commit message; if it does not, keep `run` injectable and report).
- [ ] **Step 4: Run** the file plus `test/profile.test.ts` and typecheck — Expected: PASS.
- [ ] **Step 5: Commit** `jj commit -m "Sync the plugin list across the pool"`.

---

### Task 10: Sync state, docs

**Files:**
- Modify: `src/pool/heads-object.ts` (`default` variant state `scopes: ScopeState[]` from `ScopeSync.state()`, refreshed on `headChanges` and each pass)
- Modify: `src/dashboard/ui/NodePage.tsx` (one line per scope that is not in step: `Profile: 2 behind`, `Memory of <project>: waiting for <node>`; nothing when all are in step), `src/cli.ts` `status` (the same lines)
- Modify: `README.md` (section "Memory" rewritten for the new sync; known limits about the home and memory removed; profile, `meddle profile import`, plugins), `docs/user-guide.md` ("Profile: the user layer" rewritten; the troubleshooting row for `meddle: git: memory of …` replaced)
- Test: `test/cli.test.ts` (status lines), dashboard model test if NodePage has one

- [ ] **Step 1: Write failing tests** for the status lines (`meddle status` prints `profile: in step` … per the wording above; nothing extra when all in step if that is how status reports other healthy things — follow the existing style).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**; rewrite the docs.
- [ ] **Step 4: Run** `test/cli.test.ts` and typecheck — Expected: PASS.
- [ ] **Step 5: Commit** `jj commit -m "Show sync state and document pool sync"`.

---

## Final verification

- [ ] Run every test file touched by the plan together, then typecheck.
- [ ] Run `test/e2e.test.ts test/move-e2e.test.ts test/pool-e2e.test.ts` (memory and profile are exercised by moves).
- [ ] `/code-review` of the whole change.
