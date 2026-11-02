# meddle Plan 4: Settings, Tokens, Placement, Archive, Bookmarks, Spawn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One jj identity and task environment for the whole pool, several login tokens with automatic fallback, a node chosen by meddle for every new task, idle tasks archived without a folder and restored anywhere, every bookmark in a task's namespace tracked, and tasks with zero projects started with one prompt from the CLI.

**Architecture:** Six additions on top of Plan 3, each reusing a mechanism that exists. (1) **Pool settings** are a replicated key/value map stored and merged exactly like the roster (last writer wins per key on `updatedAt`, tombstones for unsets), applied through one `poolEnv` field on `NodeConfig` that every jj call and every task child already reads their environment from. (2) **Tokens** become an ordered list with ids derived from the token value, replicated as metadata and pulled by id the way the single token is pulled today; a rate-limit event or a limit-class assistant error during a turn marks that token for the pool and the turn's `run` phase re-enters once with the next token through pi-durable's sleep-and-return. (3) **Placement** is a pure function over the roster summaries (which gain running-turn counts, the node's limit and the projects it holds with their homes) and a `createTask` on the peer surface, so the task is born on the chosen node. (4) **Archive** pushes the task's bookmarks to their homes, writes the move's archive format to a kept directory, forgets the folder and keeps the rows; restore on the same node re-provisions from the manifest, and restore elsewhere is the move procedure with the archive file as its source and the bookmarks staged from the home. (5) **The bookmark namespace** replaces every `exact:meddle/task/<id>/<project>` push, fetch, track and forget with `glob:meddle/task/<id>/*`, with side bookmarks named `meddle/task/<id>/<project>.<label>` because git refuses a ref that is both a file and a directory. (6) **Optional projects and `spawn`** make `projectIds` optional, add a first prompt to `createTask`, and list the pool's projects in the CLI from the roster.

**Tech Stack:** Plan 3's stack. No new dependencies. jj 0.45.1 on every node.

**Spec:** `docs/superpowers/specs/2026-10-30-meddle-design.md`, section 21 (the 2026-11-02 revision) and the sections it amends: 3 (goals), 8 (tasks), 11 (shared login), 12 (dashboard), 13 (state). Plans 1 to 3 are the base; their Global Constraints still apply. Current interfaces (file:line) are in the facts file the controller hands to each task. A Fable review of the first draft (2026-11-02, `plan-review.md` in the SDD workspace) produced decisions 1 to 12 and the verified behaviour below.

## Decisions this plan makes beyond the spec

1. **Side bookmarks are `meddle/task/<id>/<project>.<label>`**, not `<project>/<label>`: git refs are files under `refs/heads/`, so `…/p` and `…/p/spike` cannot coexist (verified: jj cannot export the second). jj's `glob:` `*` crosses `/`, so `glob:meddle/task/<id>/*` still selects every bookmark of the task. Spec 21.5 is corrected to this form.
2. **The token fault is an event and the rerun is a phase re-entry.** `runTurnPhase` returns `"done" | "rerun"`; the `run` phase of `meddle.turn` re-enters itself through `runtime.sleepUntil(runtime.now(), { phase: "run", tokenRetries: 1 }, context)` and returns, the same sleep-and-return pattern `meddle.move`'s `commit` uses. A `token_fault` meddle event (`rerun: true|false`) is what `lastTurnCutOff` and the notification read; no fake `turn_aborted`.
3. **The rerun prompt is `TOKEN_RETRY_PROMPT`** when the session resumes, the original prompt otherwise: "The previous attempt at this message failed because the login it used hit a usage limit; meddle switched to another login. If you had not started on it, start now; otherwise continue where you left off and do not redo finished work."
4. **Token ids are validated everywhere they name a file**: `TOKEN_ID = /^[0-9a-f]{16}$/`; `fetchToken` looks the id up in the table before touching the filesystem; replicated rows with a bad id, a label over 64 characters or an unknown status are dropped and logged once.
5. **The CLI's token commands write the database and the secrets directory directly** (the value never crosses the socket), in one transaction, value file first on add and last on remove, then `tokenChanged` when a node runs; `token list`/`status` read the database read-only and work without a node.
6. **Summaries carry `projects: { id, name, home }[]`, `running` and `limit`**, all optional in the schema and defaulted when absent, so older peers' rows still validate during an upgrade. Placement, the pool-wide project list and `--project <name>` read the roster, never a peer.
7. **Archiving on a non-home node first pushes the task's namespace to every project's home** and refuses the archive when a home is offline or the push fails. Without a target to fetch from, the home's copy is the only backup after the forget.
8. **A restore-move stages the bookmarks**: the archiving node fetches `glob:meddle/task/<id>/*` from each project's home into its replica and sets the fetched `<name>@<home>` as local bookmarks before the target's unchanged `receiveTask` fetches from it; `cleanup` forgets them again on a non-home node. A rolled-back restore-move puts the row back to `archived`, never `idle`.
9. **Replicated settings are filtered like local ones**: `merge` drops rows whose key fails `SETTING_KEY` or whose env name is reserved (logged once); `env()` filters again. The reserved list includes the loaders that could hijack a child: `PATH`, `HOME`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_PROJECT_DIR_NAME`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `JJ_USER`, `JJ_EMAIL`, `JJ_CONFIG`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_PARAMETERS`, `GIT_DIR`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `MEDDLE_GIT_SOCKET`, and every name starting `MEDDLE_`.
10. **`lighthouse.url` may not be set to the empty string**; turning discovery off stays a per-node `MEDDLE_LIGHTHOUSE_URL=`.
11. **The per-node `NodeObject.token` state stays** with the meaning "this node holds a usable token value now" (`pickToken` not null, that token's `expiresAt`); the pool-level single `token` state goes. The join `welcome` no longer carries token metadata; a joiner pulls tokens through `PoolSync` like every other member.
12. **The home never fetches the namespace; the push is the backup.** Spec 21.5's "the home's backup fetch" is read as the push to home at every turn end.

## Verified behaviour (2026-11-02, jj 0.45.1, git 2.47.3, scratch repo with a file remote; from the plan review)

- `jj git push --remote r --bookmark 'glob:meddle/task/t1/*' --allow-empty-description` pushes bookmarks new on the remote, reports "already matches" for unchanged ones, exits 0 with nothing to push, and when one bookmark is refused exits 1 while the accepted ones still land.
- `jj bookmark track 'glob:meddle/task/t1/*' --remote 'exact:r'` tracks every match; no match prints `Nothing changed.` and exits 0; the `pattern@remote` form with a `glob:` prefix is a parse error.
- `jj git fetch --remote r --branch 'glob:…'` with no match exits 0; after `forget --include-remotes`, a fetch re-creates the remote entries untracked and `track` tracks them.
- `jj bookmark forget --include-remotes 'glob:meddle/task/t1/*'` forgets every local and remote entry; no match prints `No bookmarks to forget.` and exits 0.
- `jj bookmark create 'meddle/task/t1/p/spike'` beside `meddle/task/t1/p` fails to export to git ("Git doesn't allow a branch/tag name that looks like a parent directory of another") and poisons every later command with the warning.
- SDK 0.3.314: `rate_limit_event.rate_limit_info.status` is `allowed | allowed_warning | rejected`, `resetsAt` is unix seconds in the recorded fixture; `SDKAssistantMessage.error` has the names Task 3 lists. hello.jsonl's event has `status: "allowed"` and `overageStatus: "rejected"`: the discriminator is `status`, never `overageStatus`.
- pi-durable 1.4.0: `sleepUntil(until, checkpoint, context)` commits the sleep and the phase returns; `commit` rejects once the invocation ended.

## Global Constraints

- Tests never reach the hosted lighthouse, iroh relays or a real node: `MEDDLE_IROH_PRESET=minimal`, the fake lighthouse, `childEnv`, closed ports. No test reads `~/.config/claude-shared-token`; token values in tests are strings like `tok-a`.
- Never print, log or put a token value in a file other than its mode-600 secrets file; never on a command line; never across the dashboard socket.
- `jj` runs only through `src/jj.ts`; every jj operation on a replica or memory repo goes under `serialised(repoKey(repo))`; listings use `--ignore-working-copy` after `gitImport`.
- Commit messages: plain, no AI attribution. Version control through jj (`jj describe`, `jj new`).
- Every new CLI subcommand appears in `USAGE` in `src/cli.ts` and in `README.md`; every new env var in the README Environment table.
- Every change to `src/state/contracts.ts` keeps the dashboard typechecking (`bun run typecheck`) and the bundle building (the existing bundle test).
- Keep `bun test` green at every commit; the suite is slow (about four minutes): run the files you touched during a task and the whole suite before reporting.

## Review Focus

- A setting key with an invalid name or a reserved env name (`env.PATH`, `env.CLAUDE_CODE_OAUTH_TOKEN`) must be refused at `config set` and dropped at `merge`, never applied. Tests in Task 1.
- Two nodes adding the same token value concurrently must end with one token in the list, not two; a replicated token row with a path-like id must be dropped. Tests in Task 2.
- A rate-limited turn with no second token must finish as a failed turn with a `token` notification, not loop. Test in Task 3.
- Placement with every candidate full, or with no online node that hosts tasks, must fail creation with a reason, never create locally by accident. Test in Task 4.
- Archiving a task whose turn is running, parked, moving or receiving must be refused; archiving on a non-home node whose home is offline must be refused; archiving must never delete event rows. Tests in Task 7.

---

### Task 1: Pool settings

**Files:**
- Create: `src/pool/settings.ts`, `test/settings.test.ts`
- Modify: `src/store/db.ts` (new table), `src/pool/store.ts`, `src/state/contracts.ts` (PoolObject state and methods), `src/pool/object.ts`, `src/pool/sync.ts`, `src/pool/runtime.ts` (`startPool` builds `PoolSettings` and calls `apply()` before `enforce()` and `sync.start()`), `src/config.ts`, `src/jj.ts`, `src/engine/options.ts`, `src/pool/discovery.ts` (deps only), `src/cli.ts` (`config`), `README.md`, `test/pool-helpers.ts` (`poolNode` builds `SyncDeps`/`PoolObjectDeps` by hand and must pass `settings`)
- Test: `test/settings.test.ts`, `test/cli.test.ts`, `test/config.test.ts`; keep green: `test/sync.test.ts`, `test/invite.test.ts`, `test/pool-state.test.ts`

**Interfaces:**
- Consumes: `PoolStore.merge` rule (store.ts:106), `PoolSync.attach` subscriptions (sync.ts:151), `jjEnv` (jj.ts:21), `buildEnv` (options.ts:39), `Discovery` deps `lighthouseUrl()` (discovery.ts:41, read at every request), `startPool` (runtime.ts:70).
- Produces:
  - `src/store/db.ts`: table `settings (key TEXT PRIMARY KEY, value TEXT NULL, updated_at TEXT NOT NULL, set_by TEXT NOT NULL)`; `value NULL` is a tombstone.
  - `src/pool/settings.ts`: `export const SETTING_KEY = /^(jj\.user|jj\.email|lighthouse\.url|limits\.running|env\.[A-Z_][A-Z0-9_]*)$/`; `export const RESERVED_ENV: Set<string>` (decision 9) and `export function reservedEnv(name: string): boolean` (the set, or a `MEDDLE_` prefix); `export type SettingRow = { key: string; value: string | null; updatedAt: string; setBy: string }`; `export class PoolSettings { constructor(db: Database, cfg: NodeConfig, selfId: string, log?: (line: string) => void); get(key: string): string | null; list(): { key: string; value: string }[]; rows(): SettingRow[]; set(key: string, value: string, now?: string): SettingRow; unset(key: string, now?: string): SettingRow; merge(rows: SettingRow[]): boolean; env(): Record<string, string>; runningLimit(): number; lighthouseUrl(): string | null; apply(): void }`. `set` throws `Error("invalid setting key: <key>")`, `Error("reserved environment name: <NAME>")`, `Error("limits.running must be a non-negative integer")`, `Error("lighthouse.url must not be empty")`. `merge` takes a row when `remote.updatedAt > local.updatedAt` (string compare, as the roster), drops rows whose key is invalid or reserved (counted, logged once per key as `meddle: settings: ignored replicated key <key>`), and returns whether anything changed; `set`/`unset` write `max(now, local.updatedAt + 1 ms)`. `env()` maps `jj.user→JJ_USER`, `jj.email→JJ_EMAIL`, `env.X→X`, skipping reserved names. `runningLimit()` = `cfg.maxRunning` when not null, else the non-negative integer parse of `limits.running`, else `0`. `lighthouseUrl()` returns the setting, or null when it is unset or empty (a replicated empty value must not reach `Discovery`). `apply()` sets `cfg.poolEnv = this.env()` (a new object each time).
  - `src/config.ts`: `NodeConfig.poolEnv: Record<string, string>` (loadConfig gives `{}`; owned by `PoolSettings.apply`), `NodeConfig.maxRunning: number | null` from `MEDDLE_MAX_RUNNING` (non-negative integer, else throw `"MEDDLE_MAX_RUNNING must be a non-negative integer"`), `NodeConfig.lighthouseUrlExplicit: boolean` (true when `MEDDLE_LIGHTHOUSE_URL` is set, even empty).
  - `jjEnv(cfg)` overlays `cfg.poolEnv` last; `buildEnv(i)` overlays `i.cfg.poolEnv` after the passthrough names and before `MEDDLE_GIT_SOCKET`, so the reserved names set afterwards stay authoritative.
  - contracts: `SettingRowSchema = {key, value: Nullable(String), updatedAt, setBy}`; PoolObject `peer` state gains `settings: SettingRow[]` (tombstones included); `default` state gains `settings: {key, value}[]` (no tombstones); methods `setSetting({key, value}) → {}` and `unsetSetting({key}) → {}` on the default variant (errors propagate as thrown messages).
  - `PoolSync`: subscribe to the peer's `settings`, `settings.merge` → `apply` → `onChange`. `PoolRuntime` exposes `settings: PoolSettings`; a local set/unset calls `apply`, `refreshSelf` and notify so peers re-read.
  - `Discovery` deps: `lighthouseUrl()` returns `cfg.lighthouseUrl` when `cfg.lighthouseUrlExplicit`, else `settings.lighthouseUrl() ?? cfg.lighthouseUrl`.
  - CLI: `meddle config set <key> <value>`, `meddle config unset <key>`, `meddle config list` (one `key = value` line per setting, sorted); set/unset talk to the running node (`withPool`) and fail with `NoNode` without one.

- [ ] **Step 1: Write the failing tests** in `test/settings.test.ts`:
  - `test("set, get, list, unset with tombstone")`: set `jj.user`=`Lab`, `env.FOO`=`bar`; `list()` sorted; `unset("env.FOO")` leaves a row with `value null` in `rows()` and no entry in `list()`.
  - `test("merge is last writer wins per key and reports changes")`: a remote row with a later `updatedAt` replaces, an earlier one does not; `merge` returns false when nothing changed; a remote tombstone removes a local value.
  - `test("invalid keys and reserved names are refused at set and dropped at merge")`: `set("foo", "x")` throws `invalid setting key: foo`; `set("env.PATH", "x")` throws `reserved environment name: PATH`; `set("env.MEDDLE_PORT", …)` and `set("env.ANTHROPIC_API_KEY", …)` reserved; `set("limits.running", "-1")` throws; `set("lighthouse.url", "")` throws; `merge([{ key: "env.PATH", … }])` returns false, `env()` lacks `PATH`, and the log function was called once with the ignored key.
  - `test("env maps jj identity and env.* and apply updates cfg.poolEnv")`: `env()` equals `{JJ_USER: "Lab", JJ_EMAIL: "lab@example.invalid", FOO: "bar"}`; after `apply()`, `jjEnv(cfg).JJ_USER === "Lab"` and `buildEnv(engineInput).FOO === "bar"`; `cfg.poolEnv` is a different object after a second `apply()`.
  - `test("runningLimit prefers MEDDLE_MAX_RUNNING, then limits.running, then 0")` including `limits.running` = `"abc"` → 0.
  - `test("settings replicate between two nodes and jj commits on the other node carry the identity")`: `twoPoolNodes()`; on A `settings.set("jj.user","Lab")`, `set("jj.email","lab@example.invalid")`, `refreshSelf`; wait until B's `settings.get("jj.user") === "Lab"` (≤ 10 s); then on B `initColocated(dir, B.cfg)` and `jj(["describe","-m","x"], dir, B.cfg)`; `jj(["log","-r","@","--no-graph","-T","author.email()"], dir, B.cfg)` equals `lab@example.invalid` (the test preload sets a different `JJ_EMAIL` in `process.env`, so this proves the overlay wins).
  - `test("lighthouse.url applies live unless the node's env is explicit")`: Discovery deps built from a cfg with `lighthouseUrlExplicit false` return the setting; with `true` return cfg's.
  - In `test/cli.test.ts`: `config set jj.user Lab` then `config list` prints `jj.user = Lab`; `config set bad x` exits 1 with the message; `config list` without a node fails with `NoNode`'s text.
  - In `test/config.test.ts`: `MEDDLE_MAX_RUNNING=2` → 2; `-1` throws; `lighthouseUrlExplicit` true/false.
- [ ] **Step 2: Run them**: `bun test test/settings.test.ts test/cli.test.ts test/config.test.ts` — FAIL (module and methods missing).
- [ ] **Step 3: Implement** the table, `PoolSettings`, config fields, the env overlays, contracts, `servePool` state and methods (default variant: `setSetting` → `settings.set` + `apply` + `refreshSelf` + notify; `peer` variant: state `settings` from `rows()`), the sync subscription, `startPool`, the Discovery deps, `test/pool-helpers.ts`'s `poolNode`, and the CLI.
- [ ] **Step 4: Run** the three files plus `test/sync.test.ts test/invite.test.ts test/pool-state.test.ts` — PASS. Then `bun run typecheck`.
- [ ] **Step 5: README**: a "Pool settings" subsection under Pool (keys table from spec 21.1, that values are visible to every member and are not for secrets, the reserved names, that `MEDDLE_LIGHTHOUSE_URL` and `MEDDLE_MAX_RUNNING` override per node); Environment table rows for `MEDDLE_MAX_RUNNING` and the five variables the table lacks (`MEDDLE_PORT`, `MEDDLE_DATA_DIR`, `MEDDLE_TASK_ROOT`, `MEDDLE_GIT_SOCKET`, `MEDDLE_ENV_PASSTHROUGH`); drop the "configure a jj identity on each node" prerequisite from Install and Known limits, replacing it with `meddle config set jj.user … jj.email …`.
- [ ] **Step 6: Commit**: `feat: pool settings replicate a jj identity, task environment and lighthouse for every node`.

### Task 2: Token list

**Files:**
- Create: `test/tokens.test.ts`
- Modify: `src/token.ts` (rewrite), `src/paths.ts` (`tokensDir` only; the one path builder is `token.ts`'s validating `tokenFile`), `src/store/db.ts` (table), `src/state/contracts.ts`, `src/pool/object.ts`, `src/pool/sync.ts`, `src/pool/runtime.ts`, `src/pool/invite.ts` (drop `token` from the welcome), `src/tasks/durable.ts` (`#engineInput`, `create`), `src/state/host.ts` (`NodeObject.token` meaning), `src/cli.ts` (`token`), `src/dashboard/ui/Settings.tsx` (list), `src/dashboard/ui/Pool.tsx` (`tokenText` if its shape changes), `README.md`
- Test: `test/tokens.test.ts` (replaces `test/token.test.ts`), `test/cli.test.ts`; update: `test/helpers.ts` (`setupNode` uses `addToken` and gains `options.token?: string | null`, default `"tok"`, `null` adds none; `test/pool-helpers.ts`'s `startPoolNode` threads the same option through), `test/invite.test.ts` (welcome without `token`), `test/durable.test.ts`, `test/sync.test.ts`, `test/state.test.ts`, `test/pool-state.test.ts`

**Interfaces:**
- Consumes: Task 1's replication shape; `PoolSync.pull` (sync.ts:170); `tokenSet` CLI path (cli.ts:208) and `status`'s read-only DB open (cli.ts:185-194); `#engineInput` (durable.ts:1010); `openDb` (db.ts:87, WAL and `busy_timeout` 5000).
- Produces:
  - `src/store/db.ts`: table `tokens (id TEXT PRIMARY KEY, label TEXT NOT NULL, set_at TEXT NOT NULL, set_by TEXT NULL, status TEXT NOT NULL, until TEXT NULL, detail TEXT NULL, updated_at TEXT NOT NULL, removed INTEGER NOT NULL DEFAULT 0)`.
  - `src/token.ts`: `export const TOKEN_ID = /^[0-9a-f]{16}$/`; `export type TokenStatus = "ok" | "exhausted" | "disabled"`; `export type TokenMeta = { id: string; label: string; setAt: string; setBy: string | null; status: TokenStatus; until: string | null; detail: string | null; updatedAt: string; removed: boolean; expiresAt: string }` (`expiresAt` is derived, `setAt` + 365 days, filled by `listTokens` and ignored by `mergeTokens`); `export function tokenId(value: string): string` (first 16 hex of SHA-256 of the trimmed value); `tokenFile(cfg, id)` throws `Error("invalid token id")` unless `TOKEN_ID.test(id)`; `addToken(cfg, db, value, opts: { label?: string; setBy: string | null; now?: string }): Promise<TokenMeta>` (idempotent on the same value: updates the label only when given; a removed token added again is un-removed; the value file is written before the row); `removeToken(cfg, db, idOrLabel, now?): Promise<TokenMeta>` (marks `removed`, deletes the value file last; throws `ambiguous token label: <l>` when two tokens share the label; id prefixes are not accepted); `enableToken(db, idOrLabel, now?)`; `markToken(db, id, status, until: string | null, detail: string | null, now?)`; `listTokens(db, { includeRemoved?: boolean }): TokenMeta[]` ordered by `setAt` then `id`; `tokenValue(cfg, id): Promise<string | null>`; `pickToken(cfg, db, now?: string): Promise<{ id: string; label: string; value: string } | null>` (first in order with `removed false`, a value file present, and (`status ok`, or `exhausted` with `until <= now`)); `mergeTokens(db, rows: TokenMeta[]): { changed: boolean; missingValues: string[]; removedValues: string[]; rejected: string[] }` (LWW per id on `updatedAt`; rows with an id failing `TOKEN_ID`, a label over 64 characters or an unknown status go to `rejected`; `missingValues` lists accepted ids that are not removed and whose value file is absent; `removedValues` lists accepted ids now `removed` whose value file still exists); `expiresAt(meta)` = `setAt` + 365 days; `migrateLegacyToken(cfg, db, selfId): Promise<boolean>` (if `<data>/secrets/claude-token` exists: `addToken` with label `default`, `setAt`/`setBy` from the legacy meta, then rename the two legacy files to `*.migrated`).
  - Value files: `<data>/secrets/tokens/<id>` mode 600, directory 700.
  - contracts: `TokenMetaSchema = {id, label, setAt, setBy, status, until, detail, updatedAt, removed, expiresAt}`; PoolObject `peer` state `tokens: TokenMeta[]` (removed ones included, for replication) and `fetchToken({id}) → {value}` (refuses non-members; `forbidden("unknown token")` when the id is not a non-removed row, checked before any filesystem access); `default` state `tokens: TokenMeta[]` (removed excluded) and `activeTokenId: string | null` (what `pickToken` would return now; re-read on `changes` and on the 15 s self refresh); method `tokenChanged({})` kept (re-read after any CLI change); the pool-level `token` state field is removed and every reader updated. `NodeObject.token: { present, expiresAt }` stays and now means `pickToken(...) !== null` with that token's `expiresAt`.
  - `src/pool/invite.ts`: the `welcome` no longer carries `token`; `test/invite.test.ts` updated.
  - `PoolSync`: subscribe to `tokens`, `mergeTokens`, log rejected ids once, pull each `missingValues` id with `fetchToken({id})` → write the value file; delete each `removedValues` file; pulls serialised as today.
  - `TaskRunner.#engineInput` uses `pickToken` and throws `Error("no usable token")`; `create` checks `pickToken` the same way. `getToken` is deleted at the end of the task (keep it as a wrapper over `pickToken` only while migrating callers inside this task).
  - CLI (all five open `meddle.sqlite` directly with `openDb`, write in one transaction, then call `tokenChanged({})` when a node runs, `NoNode` ignored): `token add [--file <path>] [--label <l>]` (stdin otherwise; prints `token <id> (<label>)`), `token set` = alias of `add`, `token list` (one line per token: id, label, status with `until`, expires; `active: <id|none>` last; prints only `active: none` without a database), `token remove <id|label>`, `token enable <id|label>`, `token status` = `list`.
  - `serve` runs `migrateLegacyToken` at start.

- [ ] **Step 1: Write the failing tests** in `test/tokens.test.ts`:
  - `test("tokenId is stable and addToken is idempotent on the value")`: same value twice → one row; different values → ordered by setAt.
  - `test("pickToken skips disabled and exhausted-until-later, takes exhausted-past, skips a row without a value file")`.
  - `test("remove deletes the value file and keeps a removed row; add again revives it; an ambiguous label is refused")`.
  - `test("mergeTokens is last writer wins per id, names missing values, and rejects path-like ids, long labels and unknown statuses")`: a row with `id: "../iroh.key"` is in `rejected` and no file is touched.
  - `test("tokenFile refuses an invalid id")`.
  - `test("migrateLegacyToken imports the single token once as default")`: legacy files present → one token labelled `default` with the legacy `setAt`; second call returns false.
  - `test("two nodes adding the same token value end with one token")`: `twoPoolNodes()`; `addToken` of `tok-a` on both with different labels; after replication both list one token id.
  - `test("a token added on A is pulled by B and B's pickToken returns its value; a removal on A deletes B's file")` (within 10 s).
  - `test("fetchToken refuses an unknown id before touching the filesystem")`: call with `id: "../../iroh.key"` → `forbidden`.
  - In `test/cli.test.ts`: `token add --file` then `token list` shows it; `token set` still works; `token remove <label>`; `token list` shows `active:`; `token list` with no node and no database prints `active: none`.
- [ ] **Step 2: Run** `bun test test/tokens.test.ts test/cli.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the touched and updated files — PASS; typecheck.
- [ ] **Step 5: Settings.tsx**: replace the Token section with a table of tokens (label, id prefix, status and until, expires) and the active one marked; keep the note that tokens are added with `meddle token add`. README "Login token" and "The token" rewritten for the list (spec 21.2 first paragraph), migration note.
- [ ] **Step 6: Commit**: `feat: several login tokens, replicated by id and picked in order`.

### Task 3: Token fallback in a turn

**Files:**
- Create: `test/fixtures/rate-limited.jsonl`, `test/token-fallback.test.ts`
- Modify: `src/engine/session.ts` (`runTurn` fault detection, `MeddleEvent` `token_fault`), `src/tasks/durable.ts` (`TurnCheckpoint`, `MeddleTurn.run`, `runTurnPhase`, `lastTurnCutOff`, `TOKEN_RETRY_PROMPT`), `src/state/contracts.ts` (notification kind `token`), `src/state/host.ts` (notification from `token_fault`), `src/dashboard/ui/thread-model.ts` (render `token_fault`), `src/cli.ts` (`runnerDeps` forwards `MEDDLE_FIXTURE_BY_TOKEN`), `test/helpers.ts` (`setupNode` forwards it), `test/fake-claude/replay.ts` (fixture by token), `README.md`
- Test: `test/token-fallback.test.ts`, the file that tests `runTurn`

**Interfaces:**
- Consumes: `runTurn` (session.ts:58) and `RunTurnArgs.onMessage`; `runTurnPhase` and its `rerun && resume` rule (durable.ts:396-433); `MeddleMove.commit`'s sleep-and-return with `attempt` (move.ts:138-142); `lastTurnCutOff` candidates (durable.ts:1103-1112); `markToken`/`pickToken` (Task 2); `pool.tokenChanged`; `NodeStore` notification raising (host.ts:190-208).
- Produces:
  - `src/engine/session.ts`: `export type TokenFault = { kind: "exhausted"; until: string | null; type: string | null } | { kind: "disabled"; reason: string }`; `export function tokenFaultOf(m: SDKMessage): TokenFault | null`: a `rate_limit_event` whose `rate_limit_info.status === "rejected"` → `exhausted` with `until` = ISO of `resetsAt` (seconds when `< 1e12`, else ms) or null, `type` = `rateLimitType ?? null` (`overageStatus` is ignored); an `assistant` message whose `error` is `rate_limit` → `exhausted` (until null, type null); `error` in `billing_error | account_on_hold | authentication_failed | oauth_org_not_allowed | verification_required` → `disabled` with that reason; else null. `RunTurnArgs` gains `onTokenFault?(fault: TokenFault): void`, called at most once per turn, before `done` resolves. `MeddleEvent` gains `{ type: "meddle"; subtype: "token_fault"; at: string; tokenId: string | null; label: string | null; fault: TokenFault | { kind: "none" }; rerun: boolean }` (`kind: "none"` is the "no usable token" case).
  - `TurnCheckpoint = { phase: "run"; tokenRetries?: number } | { phase: "finish" }`; `initial` gives `{ phase: "run", tokenRetries: 0 }`; a checkpoint stored by the previous build has no `tokenRetries`, so every reader uses `checkpoint.tokenRetries ?? 0`.
  - `export const TOKEN_RETRY_PROMPT` (decision 3) in durable.ts.
  - `runTurnPhase(input, tokenRetries: number, context): Promise<"done" | "rerun">` (the `run` phase passes `task.state.checkpoint.phase === "run" ? task.state.checkpoint.tokenRetries ?? 0 : 0`): `pickToken` on every entry (its id and label kept in locals); when the token fault fires, after `done` settles: `markToken(db, id, "exhausted", until ?? now + 1 h, type)` or `markToken(db, id, "disabled", null, reason)`, `pool?.tokenChanged()`; then if `tokenRetries === 0` and `pickToken` now yields a different id: append `token_fault` with `rerun: true`, call the runner hook `hooks.afterTokenFault?.(taskId)` (a test seam like `beforeRestore`), and return `"rerun"`; else append it with `rerun: false` and return `"done"`. The "no usable token" throw in `#engineInput` becomes: append `token_fault` with `fault: { kind: "none" }`, `rerun: false`, then throw (so the turn fails as today but the notification is of kind `token`).
  - `MeddleTurn.run`: `const outcome = await runner.runTurnPhase(task.input, tokenRetries, context); if (outcome === "rerun") { await runtime.sleepUntil(runtime.now(), { phase: "run", tokenRetries: 1 }, context); return; } await runtime.commit(…finish…)`.
  - `lastTurnCutOff` returns `"token" | "restart" | null`: it adds the latest `token_fault` event to its candidates; `"token"` when the newest candidate is a `token_fault` with `rerun: true`, `"restart"` when it is a `turn_started` or `turn_aborted` (today's true case), else null. The rerun's prompt, only when `resume` is true (the session has a transcript): `TOKEN_RETRY_PROMPT` for `"token"`, `CARRY_ON_PROMPT` for `"restart"`; with `resume` false the original prompt.
  - `NotificationSchema.kind` gains `"token"`. `NodeStore` runs `tokenFaultOf` over each task's events as they pass and remembers a fault per task until its next `turn_started`; an error `result` while a fault is remembered raises nothing, and a `turn_failed` directly after a `token_fault` with `fault.kind "none"` raises nothing, so a limit produces one notification, not `failed` plus `token`. `NodeStore` raises `{ kind: "token", text }` from a `token_fault` with `rerun: false` (nothing from `rerun: true`): `token <label> exhausted until <until>; no other token`, `token <label> disabled: <reason>; no other token`, or `no usable token`. The thread model renders `token_fault` as a status line (`Token <label> exhausted until …; switching login` / `…; no other token`).
  - `test/fake-claude/replay.ts`: when `MEDDLE_FIXTURE_BY_TOKEN` is set (`<token>=<path>,<token>=<path>`), the fixture is the entry whose token equals `CLAUDE_CODE_OAUTH_TOKEN`, else `MEDDLE_FIXTURE`. `runnerDeps` (cli.ts:150) and `setupNode` (helpers.ts:42) forward it.
  - `test/fixtures/rate-limited.jsonl`: `hello.jsonl` with line 6's `rate_limit_info.status` set to `"rejected"`, `resetsAt` to a unix-seconds value, `rateLimitType` `"five_hour"`, and the `result` line rewritten to `subtype "error_during_execution", is_error true, errors ["rate limited"]`.

- [ ] **Step 1: Write the failing tests**:
  - unit (`tokenFaultOf`): rejected event → exhausted with ISO until and type; `status allowed` with `overageStatus rejected` (hello.jsonl line 6) → null; assistant error `rate_limit` → exhausted; `billing_error` → disabled; `max_output_tokens` → null.
  - `test/token-fallback.test.ts` with `startPoolNode(fixture, { MEDDLE_FIXTURE_BY_TOKEN: "tok-a=<rate-limited>,tok-b=<hello>" }, { token: null })` (no default `tok`; `pool.activeTokenId` and `node.notifications` are read as `test/state.test.ts` does): add `tok-a` then `tok-b`; one `prompt`; wait for idle; expect: the turn completed with a `result` subtype `success`; the event log shows a `token_fault` with `rerun true` then a second `turn_started` with `resume true`, and the second prompt event's text is `TOKEN_RETRY_PROMPT`; `listTokens` shows `tok-a` `exhausted` with `until` equal to the fixture's `resetsAt`; `activeTokenId` is `tok-b`'s id; no `failed` notification, no `token` notification.
  - `test("with no other token the turn fails once and raises a token notification")`: only `tok-a`; the turn ends with the error result; one `token_fault` with `rerun false`; exactly one notification, of kind `token` (no `failed`); no second `turn_started`.
  - `test("a disabled-class error disables the token with until null")` using a fixture whose assistant message carries `error: "billing_error"` (written from hello.jsonl in the test's setup).
  - `test("with no usable token the only notification is of kind token")` (`token: null`, no token added).
  - `test("the mark replicates")`: `twoPoolNodes`, run on A, B lists the token exhausted within 10 s.
  - `test("a service restart after the fault reruns once with TOKEN_RETRY_PROMPT")`: the `afterTokenFault` hook closes the harness (the sleep is `now()`, so the hook is the only window); after reopening, exactly one more `turn_started`, whose prompt event is `TOKEN_RETRY_PROMPT`.
- [ ] **Step 2: Run** `bun test test/token-fallback.test.ts` — FAIL.
- [ ] **Step 3: Implement.** The rerun must go through the phase re-entry: do not spawn a second child inside one phase execution.
- [ ] **Step 4: Run** `test/token-fallback.test.ts`, `test/durable*.test.ts`, `test/move*.test.ts` — PASS; typecheck.
- [ ] **Step 5: README** "Login token": the fallback rule (spec 21.2 second paragraph), the `token` notification, the retry prompt, and that the failed message stays in the log.
- [ ] **Step 6: Commit**: `feat: a rate-limited or disabled token is marked for the pool and the turn reruns with the next one`.

### Task 4: Placement and remote creation

**Files:**
- Create: `src/pool/placement.ts`, `test/placement.test.ts`
- Modify: `src/pool/store.ts` + `src/pool/runtime.ts` (summary fields, `PoolSummaryDeps`), `src/pool/invite.ts` (:178 placeholder summary), `src/state/contracts.ts` (NodeSummary optional fields, PoolNode, PeerObject.createTask, NodeObject.createTask), `src/state/host.ts` (NodeStore create with placement; servePeer createTask with `isMember`; `pool.refresh()` on project changes), `src/tasks/durable.ts` (`running()` count), `src/cli.ts` (`task new --node|--here`; `PoolSummaryDeps` builder :108-113), `src/dashboard/ui/Pool.tsx` (NewTaskForm), `src/dashboard/ui/pool-model.ts`, `README.md`; tests that build summaries or call `createTask`: `test/pool-helpers.ts` (:101, :191-197), `test/invite.test.ts` (:29), `test/pool-state.test.ts` (:112, :242, :391, :470), `test/pool-store.test.ts` (:19), `test/state.test.ts`, `test/tunnel.test.ts` (:113), `test/move.test.ts` (if it builds `servePeer` deps)
- Test: `test/placement.test.ts`, a two-node test in `test/pool-state.test.ts` or a new `test/placement-pool.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: `NodeSummary`/`liveSummary` (runtime.ts:75), `PoolSummaryDeps` (runtime.ts:47); `servePeer` (host.ts:79) with `from` from the principal and `PeerObjectDeps.runner` `Pick` (host.ts:70); `NodeStore.createTask` (host.ts:260); `runner.create` (durable.ts:220, which runs `provisionTask` → `checkTaskRoot`, provision.ts:63); `listLiveTasks`; `listProjects(db)`; `PoolSettings.runningLimit()` (Task 1); `ProjectInfoSchema` (contracts.ts:81); `resolveNodeId` errors `no such node` / `ambiguous node` (ids.ts:16-21).
- Produces:
  - `NodeSummary` gains `running: number` (tasks in state `running` or `waiting`), `limit: number` (`runningLimit()`), `projects: { id: string; name: string; home: string }[]` (every project this node holds, from `listProjects`); in `NodeSummarySchema` the three are `Type.Optional` and `toRow`/`nodeOf` default them (`0`, `0`, `[]`); `PoolNodeSchema` carries them. The summary is refreshed on project changes as it is on task-state changes.
  - `src/pool/placement.ts`: `export type Candidate = { nodeId: string; online: boolean; hostsTasks: boolean; running: number; taskCount: number; projects: { id: string; home: string }[]; limit: number }`; `export type PlacementInput = { projectIds: string[]; nodes: Candidate[] }`; `export function placementCandidates(rows: RosterRow[], isOnline: (id: string) => boolean, self: { nodeId: string; hostsTasks: boolean; running: number; taskCount: number; projects: { id: string; home: string }[]; limit: number }): Candidate[]` (the roster rows other than self, defaulted as `nodeOf` does, plus self live; used by `NodeStore.createTask` and by Task 8's `TaskRunner.restore`); `export function place(input: PlacementInput): { nodeId: string } | { error: string }`: `homes` derived from any candidate's `projects` entry for the id; candidates = `online && hostsTasks && (limit === 0 || running < limit)`; prefer `homes[projectIds[0]]` when a candidate; else candidates whose `projects` include every id; else all candidates; order by `running`, then `taskCount`, then `nodeId`; errors: `"no online node hosts tasks"`, `"every node is at its running limit"`. With `projectIds: []` only the general order applies.
  - contracts: `PeerObject.createTask({ title, projectIds, prompt: Nullable(String) }) → { manifest: TaskManifestSchema }`; `servePeer` checks `deps.isMember(from)` first (`forbidden` otherwise; `PeerObjectDeps` gains `isMember(nodeId): boolean`, passed from `pool.store.isMember`), `PeerObjectDeps.runner` `Pick` gains `create` and `prompt`; `runner.create` is what refuses a node without a task root, and `prompt` runs only after `create` returned. `NodeObject.createTask({ title, projectIds, prompt?: string | null, node?: string | null }) → { manifest, nodeId }` where `node` `null`/absent is `auto`, `"here"` this node, else a node id; every caller updated to the new return shape.
  - `NodeStore.createTask`: builds candidates with `placementCandidates(store.roster(), net.isOnline, self)`; when the choice is self → `runner.create` then `runner.prompt` when given; otherwise a fresh `PeerObject` ref for the node and its `createTask`; the returned manifest and `nodeId` go back to the caller. Without a pool, `auto` is self.
  - CLI `task new --title <t> --project <id>… [--node <id|prefix> | --here]` prints `task <id> on <shortId>`; no `--node` is `auto`; `--project` stays required until Task 5; an unknown node exits 1 with `no such node: <x>`.
  - Dashboard `NewTaskForm`: a node select with `Automatic` (default) and each online node; after creation it navigates to the task on the node returned.

- [ ] **Step 1: Write the failing tests**:
  - `test/placement.test.ts`: unit tests for every rule above: home preferred; home offline → replica holder; no holder → fewest running, then fewest tasks, then id; full nodes skipped; limit 0 unlimited; error messages; projectless input ignores homes; `placementCandidates` of a roster row whose summary lacks `running`/`limit`/`projects` gives `0`/`0`/`[]` (older peer), and `nodeOf` does the same.
  - two-node test (`twoPoolNodes`): project homed on B; `createTask` on A with `node: null` → `nodeId === B.id` and the task row exists on B, not on A; `node: "here"` → A; with B started with `MEDDLE_MAX_RUNNING=1` and a stalled turn running on B (`MEDDLE_FIXTURE_STALL=1`) → A.
  - `prompt` given → the task's first turn runs on the chosen node (event log has the prompt).
  - `servePeer` `createTask` from a non-member principal → `forbidden`.
  - CLI: `task new --here` prints `on <self short>`; `--node zzz` exits 1 with `no such node`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** summary fields, `place`, the peer method, `NodeStore.createTask`, CLI and form, and the listed test fixtures.
- [ ] **Step 4: Run** the touched tests plus `test/move.test.ts test/invite.test.ts test/pool-store.test.ts test/state.test.ts test/tunnel.test.ts` — PASS; typecheck.
- [ ] **Step 5: README** "Projects and tasks": a "Where a new task runs" paragraph (spec 21.3), `--node`/`--here`, `limits.running`, mixed-version note (older nodes count as idle).
- [ ] **Step 6: Commit**: `feat: meddle picks the node for a new task and creates it there`.

### Task 5: Optional projects, first prompt, spawn, pool-wide project list

**Files:**
- Modify: `src/tasks/provision.ts` (`resolveProjects`, `cwdFor`, `generatedClaudeMd`, `checkReceivedManifest`), `src/tasks/manifest.ts` (`primaryProjectId` nullable, `transcriptPath` slot rule) + contracts, `src/memory.ts` (export `claudeSlot` if not exported), `src/engine/options.ts` (omit `CLAUDE_CODE_PROJECT_DIR_NAME` when null), `src/tasks/durable.ts` (skip memory sync, bookmarks and pushes without a primary; `#primaries` only with one), `src/tasks/move.ts` (projectless move), `src/cli.ts` (`spawn`, `project list`, `--project <name>`), `src/dashboard/ui/Pool.tsx` (form allows zero projects and a first prompt), `test/fake-claude/replay.ts` (`transcribe` without `CLAUDE_CODE_PROJECT_DIR_NAME`), `README.md`
- Test: `test/provision.test.ts` (the "a task needs at least one project" test changes meaning), `test/move.test.ts`, `test/cli.test.ts`, `test/projects.test.ts`

**Interfaces:**
- Consumes: Task 4's `createTask` with `prompt`/`node` and the roster summaries' `projects`; `claudeSlot(absPath)` (memory.ts:9, `absPath.replace(/[^A-Za-z0-9]/g, "-")`, Claude Code's own project-dir derivation from `cwd`); `transcriptPath` (manifest.ts:29-31); `transcribe()` in replay.ts:124-136.
- Produces:
  - `provisionTask` accepts `projectIds: []`: no workspace, `primaryProjectId: null`, no memory slot, CLAUDE.md reads `# Task: <title>` then `This task has no project attached. This folder is scratch space; it travels with the task.`; `cwdFor` with zero projects → `cwd = <task>`, `projectConfigRoot = null`, `settingSources = ["user"]`; `checkReceivedManifest` allows zero.
  - `transcriptPath(cfg, m)`: when `primaryProjectId` is null the slot is `claudeSlot(realpathSync(paths(cfg).task(m.id)))` (the child's `cwd` is the resolved path, so a symlinked task root must not break `resume`); `replay.ts` `transcribe()` derives the same slot from `process.cwd()` when `CLAUDE_CODE_PROJECT_DIR_NAME` is unset.
  - `buildEnv`: `CLAUDE_CODE_PROJECT_DIR_NAME` set only when `primaryProjectId` is a string.
  - `TaskRunner`: `syncMemoryBefore/After`, `setTaskBookmarks`, `#pushToHome` and `#primaries` are skipped when the manifest has no primary; `receiveTask` with no projects fetches nothing.
  - CLI: `meddle spawn <prompt> [--project <id|name>]… [--node <id|prefix> | --here] [--title <t>]` → `createTask({ title: title ?? first 60 chars of the prompt's first line, projectIds, prompt, node })`, prints `task <id> on <short>`; `meddle project list` prints one line per project in the pool: `<id>  <name>  home <short>  on <short,short,…>`, a pure function over `pool.nodes` (one row per id, named after the home's copy, holders = nodes whose summary lists it, this node included); `--project` resolves a name when exactly one project in the pool has it, else `ambiguous project name: <name>` / `unknown project: <x>`.
  - Dashboard form: zero projects allowed; an optional "First prompt" textarea.

- [ ] **Step 1: Write the failing tests**:
  - provision: `provisionTask(..., { title, projectIds: [] })` → manifest with `projects []`, `primaryProjectId null`, no `projects/` symlink, CLAUDE.md text as above; `cwdFor` returns the task folder and `["user"]`; `buildEnv` lacks `CLAUDE_CODE_PROJECT_DIR_NAME`; `transcriptPath` equals `<taskConfig>/projects/<claudeSlot(task folder)>/<sessionId>.jsonl`.
  - a projectless turn with `setupNode` runs to `success`, the transcript file exists at that exact path, and a second prompt starts with `resume true`.
  - a projectless task moves A→B and resumes (one `twoPoolNodes` test alongside the existing move tests).
  - CLI: `spawn "Say hello" --here` creates and prompts (event log has the prompt, title `Say hello`); `spawn` with `--project <name>` resolves; ambiguous name exits 1; `project list` on A lists a project homed on B with `on` naming both nodes once B's summary and A's own list both carry it.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `test/provision.test.ts test/cli.test.ts test/move.test.ts test/memory-sync.test.ts` — PASS; typecheck.
- [ ] **Step 5: README**: "Tasks without a project" (spec 21.6 first paragraph), `spawn`, `project list` output, `--project <name>`.
- [ ] **Step 6: Commit**: `feat: tasks without a project, a first prompt at creation, spawn, and the pool's project list`.

### Task 6: The task's bookmark namespace

**Files:**
- Modify: `src/jj.ts` (`push`, `track`, `bookmarkForget` take patterns), `src/projects/replicas.ts` (`fetchBookmarks` patterns, `pushNamespace`), `src/tasks/manifest.ts` (`taskNamespace`, `taskGlob`, `sideBookmark`), `src/tasks/durable.ts` (`setTaskBookmarks`, `#pushToHome`, `receiveTask` fetch, `#discard`), `src/tasks/move.ts` (`removeLocalCopy`), `src/tasks/provision.ts` (CLAUDE.md line), `src/state/contracts.ts` + `src/state/host.ts` (`TaskObject.bookmarks`), `src/dashboard/ui/Task.tsx` (list), `README.md`
- Test: `test/jj.test.ts`, `test/replicas.test.ts`, `test/git.test.ts`, `test/move.test.ts`

**Interfaces:**
- Consumes: jj helpers (jj.ts:129-174), `fetchBookmarks`/`pushBookmark` (replicas.ts:99,112), the hook (scripts.ts:42, already admits the namespace), `bookmarkList`; Task 5's rule that a task without a primary pushes nothing (keep that skip).
- Produces:
  - `src/tasks/manifest.ts`: `taskNamespace(taskId)` = `meddle/task/<taskId>/`; `taskGlob(taskId)` = `glob:meddle/task/<taskId>/*`; `sideBookmark(taskId, projectName, label)` = `meddle/task/<taskId>/<projectName>.<label>`.
  - `jj.ts`: `push(repo, remote, pattern, cfg?)`, `track(repo, pattern, remote, cfg?)` (`--remote exact:<remote>`) and `bookmarkForget(repo, pattern, cfg?)` take a jj string pattern verbatim (callers pass `exact:` or `glob:`); `fetch` unchanged.
  - `replicas.ts`: `fetchBookmarks(cfg, replica, nodeId, patterns: string[], opts?: { requireMatch?: boolean })` passes patterns verbatim and, for an `exact:` pattern, checks the bookmark arrived as `<b>@shortId`; for a `glob:` pattern, checks at least one match arrived when `requireMatch` (default true); `pushNamespace(cfg, replica, home, taskId, primary: { name: string; changeId: string } | null)`: under the repo lock: fetch `taskGlob` with `requireMatch: false` (a task's first push finds nothing on the home), `track(replica, taskGlob, shortId(home))`, `bookmarkSet` the primary when given, push `taskGlob`; it THROWS on a failed fetch or push (jj's error line as the message). The turn-end caller (`#pushToHome`'s replacement) catches, logs `meddle: push: …` and lets the next turn end retry, since the accepted bookmarks still landed; Task 7's `archive` lets it propagate.
  - `TaskObject` state gains `bookmarks: { project: string; name: string; changeId: string }[]` (every local bookmark under the namespace in each project's replica, refreshed when `heads` are).
  - `generatedClaudeMd` adds: `To keep a side branch, give it a bookmark named meddle/task/<id>/<project>.<label> (for example meddle/task/<id>/<project>.spike). Bookmarks outside that namespace are not backed up and do not travel, and git refuses a name with a slash after the project name.`

- [ ] **Step 1: Confirm in a scratch repo** (record the commands and output in the task report) the verified behaviour above for push, track, fetch and forget with `glob:`, and that `meddle/task/t1/p.spike` beside `meddle/task/t1/p` exports and pushes.
- [ ] **Step 2: Write the failing tests**:
  - `test/git.test.ts`: in the two-node git setup, a bookmark `meddle/task/<id>/p.spike` created in the task workspace on the non-home node is pushed to the home by `pushNamespace`; a bookmark `spike` outside the namespace is not.
  - `test/move.test.ts`: the extra bookmark arrives on the target and is listed in `TaskObject.bookmarks` there; after the move it is forgotten on the source (non-home).
  - `test/replicas.test.ts`: `fetchBookmarks` with a glob pattern; `pushNamespace` with `primary: null` pushes nothing for a task without bookmarks and does not throw.
- [ ] **Step 3: Run** — FAIL.
- [ ] **Step 4: Implement**, replacing every `exact:meddle/task/<id>/<name>` site listed in the facts file (provision.ts:87,194 keep setting the primary; durable.ts:488,544,733; move.ts:330).
- [ ] **Step 5: Run** `test/git.test.ts test/move.test.ts test/replicas.test.ts test/jj.test.ts` — PASS; typecheck.
- [ ] **Step 6: README** "Projects across the pool": the namespace rule (spec 21.5), the side-bookmark name, and that the push at turn end is the backup (the home never fetches).
- [ ] **Step 7: Commit**: `feat: every bookmark under a task's namespace is backed up, travels and is listed`.

### Task 7: Archive and restore on the same node

**Files:**
- Modify: `src/paths.ts` (`archives`, `archiveFile` → archives dir; `moved`, `movedFile`), `src/tasks/archive.ts` (`writeArchive(cfg, db, taskId, file)`, `readArchive`, `unpackArchiveFiles`, janitor over `moved/`), `src/tasks/move.ts` (`releaseFolder`, `removeLocalCopy` writes to `moved/`), `src/store/records.ts` (columns `archived_on`, `archived_at`; `listLiveTasks` excludes `archived`; `listArchivedTasks` = rows with `state = 'archived'`, so a `moved` row that still carries `archived_on` is not listed), `src/tasks/durable.ts` (`archive`, `restoreHere`, `deleteTask`), `src/state/contracts.ts` + `src/state/host.ts` (`TaskObject.archive/restore/delete`, `archivedOn`; `NodeObject.archivedIds`), `src/dashboard/ui/Task.tsx` (archived read-only + buttons), `src/dashboard/ui/Pool.tsx` (Archived section per node), `src/cli.ts` (`task archive|restore|delete`), `README.md`
- Test: `test/archive.test.ts` (new), `test/move.test.ts` (:16, :418-424, :464, :610, :948-983 use the archive path and `writeArchive`)

**Interfaces:**
- Consumes: `writeArchive`/`TaskArchive` (archive.ts:32), `removeLocalCopy` (move.ts:322-335: `writeArchive`, forget workspaces, forget bookmarks unless home, `clearTaskLog`), `provisionFromManifest` (provision.ts:156), `#fetchTaskChange`, `setTaskBookmarks`, `pushNamespace` (Task 6), `TaskState "archived"` (durable.ts:46).
- Produces:
  - paths: `archives` = `<data>/archives`, `archiveFile(id)` = `<data>/archives/<id>.json.gz`; `moved` = `<data>/moved`, `movedFile(id)`. `runJanitor` sweeps `moved/` with the seven-day rule; at its first run it applies the same rule once to the old `<data>/archive/` and removes that directory when empty.
  - `archive.ts`: `writeArchive(cfg, db, taskId, file: string): Promise<string>`; `readArchive(file): Promise<TaskArchive>`; `unpackArchiveFiles(cfg, taskId, archive): Promise<number>` (writes the `files` under `<taskConfig>/projects/`, mode 600).
  - `move.ts`: `releaseFolder(cfg, db, selfId, taskId)` = forget workspaces, `bookmarkForget(taskGlob)` on replicas whose home is not this node, remove the folder (no archive, no rows); `removeLocalCopy` = `writeArchive(…, movedFile(id))` + `releaseFolder` + `clearTaskLog` (behaviour unchanged).
  - `TaskRunner.archive(taskId): Promise<void>`: refuses unless the row is `idle`, no durable turn pending, not moving/receiving, `queued` empty (`Error("task is <state>")`); then `setTaskBookmarks(manifest)` and, for each project whose home is another node, `pool.net.isOnline(home)` (else `Error("cannot archive: home <short> of <project> is offline")`) and `pushNamespace` to the home, letting its error propagate (the task stays `idle`; a bookmark git refuses, such as one with a slash after the project name, blocks every non-home archive until it is deleted, and the README says so); then `writeArchive(…, archiveFile(id))`, `releaseFolder`, keep `events`/`transcript` rows, set state `archived`, `archived_on = self`, `archived_at = now`, refresh `taskIds`/`archivedIds`. On a project's home nothing is pushed and its bookmarks stay.
  - `TaskRunner.restoreHere(taskId): Promise<TaskManifest>`: row must be `archived` with `archived_on === self`; parents per project from the primary bookmark on the project's home via `#fetchTaskChange` (home itself: the local bookmark); `provisionFromManifest(..., "idle")`; `unpackArchiveFiles`; delete the archive; `archived_on = null`; state `idle`.
  - `TaskRunner.deleteTask(taskId)`: only `archived` or `moved` rows; deletes rows and the archive file; `archivedIds` refreshed.
  - contracts: `TaskObject` methods `archive({}) → {}`, `restore({ node: Nullable(String) }) → { nodeId }` (this task handles `null` and `"here"` as this node; Task 8 adds the rest), `delete({}) → {}`; `TaskObject.archivedOn: Nullable(String)`; `NodeObject.archivedIds: string[]`.
  - Dashboard: an archived task renders its transcript (the session window still reads the rows) with the composer and controls hidden and two buttons, Restore and Delete; the Pool card lists archived tasks under "Archived" with Restore/Delete links.
  - CLI: `task archive <id>`, `task restore <id>` (same node in this task), `task delete <id>`.

- [ ] **Step 1: Write the failing tests** in `test/archive.test.ts` (`setupNode` + `twoPoolNodes` where a home is needed):
  - archive an idle task on its home: the folder is gone, workspaces forgotten (`jj workspace list` lacks it), bookmarks still present, `events` rows unchanged (count equal), state `archived`, `archivedOn` self, the archive file exists mode 600 under `archives/`.
  - archive on a non-home node pushes first: the home's repo has the task's namespace bookmarks afterwards and the source's are forgotten; with the home offline (`close` B's net or stop B) the archive is refused with `cannot archive: home … is offline`, the folder is intact and the row `idle`.
  - archive is refused while a turn is running (stall fixture), while `queued` is non-empty, while moving.
  - `TaskObject` for an archived task serves its window (last event readable) and `moveTo`/`prompt` refuse with `task is archived`.
  - restore here: folder and workspace back, a turn resumes the session (`turn_started` with `resume true`, result success), the archive file deleted, state idle, `archivedOn` null.
  - delete: rows and file gone; `archivedIds` empty; delete of an idle task refused.
  - move leftovers now land in `moved/` and the janitor sweeps them; an old `archive/` directory is swept once and removed when empty (adapt the existing archive tests in `test/move.test.ts`).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `test/archive.test.ts test/move.test.ts test/move-e2e.test.ts` — PASS; typecheck.
- [ ] **Step 5: README**: "Archiving a task" section (spec 21.4 first two paragraphs, the push precondition, same-node restore), the `moved/` rename under "On the node a task left".
- [ ] **Step 6: Commit**: `feat: archive an idle task without its folder and restore it on the same node`.

### Task 8: Restore anywhere

**Files:**
- Modify: `src/tasks/transfer.ts` (`exportArchive`), `src/tasks/move.ts` (`MoveInput.fromArchive`, phases), `src/tasks/durable.ts` (`restore(taskId, node)` with placement; `moveTo` and `checkMove` with `fromArchive`; `#knownState`/`#restoreState` know `archived`; `failMove`/`#release`), `src/state/host.ts` (`TaskObject.restore` full), `src/dashboard/ui/Task.tsx` + `Pool.tsx` (Restore with a node select, pool-wide Archived list), `src/cli.ts` (`task restore <id> [--node|--here]`), `README.md`
- Test: `test/archive.test.ts`, `test/move.test.ts`

**Interfaces:**
- Consumes: `exportTask` frames (transfer.ts:18-78), `MeddleMove` phases (move.ts:77), `place`/`placementCandidates` (Task 4), `checkMove` (durable.ts:774), `failMove`/`#knownState`/`#restoreState` (durable.ts:886-923), `#release` (durable.ts:691-703), `readArchive`/`archiveFile` (Task 7), `fetchBookmarks`/`taskGlob`/`bookmarkSet` (Task 6).
- Produces:
  - `exportArchive(cfg, archive: TaskArchive, send: SendStream): Promise<Receipt>` emits the same frame sequence as `exportTask` from the archive's row, manifest, events, transcript and files.
  - `MoveInput` gains `fromArchive?: boolean` (moves stored by the previous build have none; every reader uses `?? false`); `moveTo(taskId, to, now, fromArchive = false)`; `checkMove(row, to, own, fromArchive)`: with `fromArchive` it accepts an `archived` row, or a `moving` row when `own` and `archived_on` is this node (a rerun of `prepare` after `enterMove`), and refuses anything else; without `fromArchive` an `archived` row is refused as today. `prepare` with `fromArchive` skips the live-turn wait and requires the row `archived` (or `moving` on rerun) on this node. `handoff` with `fromArchive`: `setTaskBookmarks` and `awaitTurnEnd` are skipped (there is no workspace); instead, for each project whose home is another node, `fetchBookmarks(taskGlob, { requireMatch: true })` from the home into the local replica (home offline → fail the move with the home's message) and `bookmarkSet` each fetched `<name>@<home>` as a local bookmark; on the home nothing is fetched; then `exportArchive` instead of `exportTask`; the target's `receiveTask` is unchanged. `commit` activates with `followUp null`. `cleanup` with `fromArchive`: rename `archiveFile(id)` to `movedFile(id)` (the seven-day leftover a normal move keeps), `releaseFolder` (forgets the staged `taskGlob` on a non-home node; the folder and workspaces are already gone) and `clearTaskLog`, leaving a `moved` row.
  - `#knownState` and `#restoreState` return `"archived"` when the row's `archived_on` is not null and no turn is live or pending; `failMove` and `#release` therefore put a failed restore-move back to `archived`.
  - `TaskRunner.restore(taskId, node: string | null): Promise<{ nodeId }>`: row `archived` here; `"here"` → self; an id → that id after `checkMove(..., fromArchive true)`; `null` → `place` over the roster candidates with the manifest's project ids; self → `restoreHere`; other → `moveTo(taskId, nodeId, false, true)`.
  - CLI `task restore <id> [--node <id|prefix> | --here]` prints `task <id> on <short>` for a local restore or `restoring to <short>` for a remote one and exits 0 (the move completes in the background; `status` shows it).
  - Dashboard: Restore opens a node select (Automatic default); the Pool view merges every online node's `archivedIds` into one Archived list with the holding node named.

- [ ] **Step 1: Write the failing tests**:
  - `exportArchive` of an archived task produces frames `importTask` accepts with a receipt whose `sha256` equals the one `exportTask` of the same task produced before archiving (captured in the test).
  - two nodes: archive on A (project homed on B); `restore(id, null)` → lands on B (home preferred), state idle there, a turn resumes; A staged the namespace from B during the handoff and forgot it at cleanup; A has a `moved` row and no file under `archives/`.
  - two nodes, project homed on A: archive on B (pushes to A), restore from B to A with `node: A` → the staged bookmarks on B exist during the handoff and are forgotten after cleanup.
  - a restore whose target refuses `receiveTask` (its task root removed) → the row is `archived` again on the source, the archive file intact; a restore to an offline node fails with the move's message and the row stays `archived`.
  - a service restart during a restore-move's handoff (harness closed and reopened) ends with the row `archived` or `moved`, never `idle`; a crash between `enterMove` and `prepare`'s commit (the `beforeRestore`-style hook) reruns `prepare` and the restore still completes.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `test/archive.test.ts test/move.test.ts` — PASS; typecheck.
- [ ] **Step 5: README** "Archiving a task": restore anywhere (spec 21.4 third paragraph), the staging, the Archived list.
- [ ] **Step 6: Commit**: `feat: restore an archived task on any node through the move procedure`.

### Task 9: Settings view, documentation sweep, end-to-end check

**Files:**
- Modify: `src/dashboard/ui/Settings.tsx` (settings editor, token Enable), `src/state/contracts.ts` + `src/pool/object.ts` (`enableToken({id})`), `README.md` (Dashboard, Known limits, Settings), `docs/superpowers/specs/2026-10-30-meddle-design.md` (section 13 state sketch: settings, tokens, placement, archive), `test/e2e-plan4.test.ts` (new)
- Test: `test/e2e-plan4.test.ts`, the dashboard bundle/route tests

**Interfaces:**
- Consumes: everything above; `startServe`, `meddle` helpers (the serve env is passed explicitly, since `childEnv` strips `MEDDLE_*` from the parent); `MEDDLE_FIXTURE_BY_TOKEN` (Task 3).
- Produces:
  - Settings.tsx: a "Pool settings" table (key, value, set by, Unset button) with a form to set a key (select from the allowed keys plus a free `env.` name), using `pool.setSetting`/`unsetSetting`; the tokens table from Task 2 with an Enable button for disabled/exhausted tokens (`pool.enableToken({id})`, default variant, added to contracts in this task); the note about visibility of values.
  - `test/e2e-plan4.test.ts`: two `serve` processes with the fake lighthouse and the replayer (the move-e2e shape): `config set jj.user/jj.email` on A → a turn on B commits with that author (`jj log` on B's replica); `token add` two tokens with `MEDDLE_FIXTURE_BY_TOKEN` making the first rate-limited → a turn on A succeeds on the second token and `token list` on B shows the first exhausted; `spawn --project <name>` on A for a project homed on B → `on <B>`; a second task for a project homed on A, `spawn --project <nameA> --node <B>`, gets a bookmark `meddle/task/<id>/<nameA>.spike` created in its workspace on B, and that bookmark is in A's repo after the turn; `task archive` on B, `task restore` on B with no `--node` → where placement says (assert the printed node matches `status` afterwards) and a turn resumes there. Bounded by a 15 s clock per wait, printing the last output on failure (the move-e2e pattern).

- [ ] **Step 1: Write the e2e test** and run it — it should PASS except for anything that needs `enableToken`; record which.
- [ ] **Step 2: Implement Settings.tsx and `enableToken`.**
- [ ] **Step 3: Run** `bun test` whole suite and `bun run typecheck` — all PASS; `bun run build` succeeds.
- [ ] **Step 4: README**: Dashboard section (Settings view contents, Archived list, placement select, first prompt); Known limits updated (jj identity prerequisite gone; `moved/` retention; archives kept until deleted; tokens from different orgs may differ in models; an archive needs the homes online). Spec section 13 rows updated.
- [ ] **Step 5: Commit**: `feat: settings and tokens in the dashboard; docs for settings, tokens, placement, archive and spawn`.

## Self-review notes

- Spec coverage: 21.1 → Task 1; 21.2 → Tasks 2, 3, 9; 21.3 → Task 4; 21.4 → Tasks 7, 8; 21.5 → Task 6 (naming corrected in the spec); 21.6 → Task 5; 21.7 deferred items untouched.
- Type consistency: `createTask` returns `{ manifest, nodeId }` from Task 4 on; Task 5 and Task 9 use that shape. `TokenMeta` is defined in Task 2 and read in Tasks 3 and 9. `place`/`Candidate` from Task 4 are reused in Task 8 (`restore`). `taskGlob`/`sideBookmark` from Task 6 are used by Task 7's `releaseFolder` and Task 8's staging. `TurnCheckpoint` is redefined in Task 3 only.
- Review Focus lines each name their task.
