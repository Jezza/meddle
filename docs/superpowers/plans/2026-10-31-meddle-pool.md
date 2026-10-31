# meddle Plan 2: Pool over iroh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Several meddle nodes form one closed pool over iroh: they find each other through the author's lighthouse, replicate the roster and the shared login token, and any node's dashboard shows every node's card and lets you open, steer and create tasks on any of them.

**Architecture:** Each node keeps the Plan 1 shape (one chord host named `node`, serving its own objects to browsers over WebSocket) and gains an iroh endpoint with one QUIC connection per peer. Two things ride on that connection. (1) **Node to node:** each node is a chord *client* of each peer: it opens a `chord` stream, wraps it as a chord `Link`, and holds the peer's `PoolObject` in its `peer` variant, from which it merges the roster and the token's metadata and, when the peer's token is newer, calls `fetchToken`. So chord frames travel between hosts over iroh, as the spec says, without a chord tree: no host is anyone's parent. (2) **Browser to remote node:** the dashboard opens `/ws/node/<nodeId>`; the serving node pipes that WebSocket over a `dashboard` stream to the target, which accepts it as one more browser-grade chord link. The browser holds one chord client host per node. Membership is by invitation ticket; connections on the member ALPN are accepted only from roster members, and a member that is removed is cut off by every other member.

**Tech Stack:** Plan 1's stack plus `@number0/iroh` 1.2.0 (iroh bindings: QUIC with hole punching and relays) and `iroh-lighthouse` 0.1.0 (the author's TypeScript lighthouse client, used for its `Lighthouse`, `NodeKey` and `Topic`).

**Spec:** `docs/superpowers/specs/2026-10-30-meddle-design.md`, sections 6 (the pool), 11 (shared login), 12 (Pool view), 13 (Pool object), 15 (security). Plan 1 (`docs/superpowers/plans/2026-10-30-meddle-single-node.md`) is the base this plan extends; its Global Constraints still apply.

## Decisions this plan makes beyond the spec

Stated so a reviewer can check them against the spec and the author can reject them. A Fable review of the first draft (2026-10-31) shaped items 1, 6, 7, 8 and 10.

1. **Nodes are chord clients of each other; there is no chord tree.** chord 1.4.0 gives a host one upstream and relays only from a parent to its accepted children, so a leaderless pool cannot be one chord topology. Instead every node holds, per connected peer, a client-kind chord host whose upstream is an iroh stream, and through it the peer's `PoolObject`. Replication is chord state (spec section 6 "state replication is chord's job"), the link is "the iroh link for chord frames" (section 18), and Plan 3 gets node-to-node method calls on this footing. Browsers cannot be relayed through client hosts, so a browser reaches a remote node through a tunnelled link of its own.
2. **Two ALPNs:** `meddle/0` for members (every bidirectional stream starts with one JSON header line naming its kind: `chord`, `dashboard`; Plan 3 adds `git` and `blob`) and `meddle/join/0` for the invitation handshake. The spec's three ALPNs were illustrative; one connection per peer carries every stream kind.
3. **Node id is the lowercase hex of the iroh public key** (64 characters), derived with `toBytes()` and parsed with `fromBytes()`. The bindings print hex today but document base32, so meddle never relies on `toString()`/`fromString()`.
4. **The smaller node id dials; the larger accepts.** A newer connection from the same peer replaces the older one, which is closed; everything attached to the old connection ends and is rebuilt on the new one.
5. **Roster rows merge last-writer-wins on `updatedAt`** (ISO 8601 with milliseconds) per node id; summaries, `lastSeenAt` and `lastAddr` merge by `lastSeenAt`. A removed row is only ever replaced by a strictly newer row, so a re-invite re-admits. Clocks are assumed NTP-synced; a wrong clock can lose a roster edit, accepted for a one-person pool.
6. **The token moves by pull, and only over iroh.** `meddle token set` writes the token file in the CLI process (as in Plan 1, now with `setBy`), then tells the running node `tokenChanged` with no payload. Peers see the new `{ setAt, setBy }` through chord state and call `fetchToken` on the `peer` variant, which answers only a current member. The value never crosses the loopback WebSocket, a ticket, a `state` frame or a log.
7. **An invite ticket is `meddle1` + base64url(JSON) of `{ v, code, inviter }`**: a 32-byte single-use code valid 24 hours and the inviter's iroh address. The pool id and secret travel in the `welcome` reply inside the encrypted join stream, never in the ticket or on a command line. Join is refused on a node that already shares a pool with other members.
8. **Removal is enforced by every member.** After any roster change, a node closes its connection to every node that is not a `member` (close code 1, reason `removed`; a never-admitted peer gets `not a member`). `fetchToken` and the `chord` and `dashboard` stream acceptors re-check membership. The remover sends the removal first and closes after the removed node has seen it (or after one second). A node that is refused with `removed`, or that merges a roster marking itself removed, marks itself removed, closes its connections, leaves the lighthouse topic and accepts a new `join`. The pool secret is not rotated on removal; rotation is a later addition.
9. **Principals:** a tunnelled browser link acts as `local`, like a local dashboard (one object instance per node for all dashboards). A peer's chord link acts as `peer:<nodeId>`, and `PoolObject` serves such principals its `peer` variant.
10. **Discovery is optional and gating is by roster alone.** Spec section 6 wants the lighthouse and the roster to agree before a stream is accepted; this plan accepts a member whether or not the lighthouse lists it, so `MEDDLE_LIGHTHOUSE_URL=` (empty) runs without discovery. Addresses are cached per node (`lastAddr`: from the join request, from each peer's self row, and from iroh's own cache after a connection) and offered to the dialer at start and on every change; with the `n0` preset iroh's discovery is the last resort. `Discovery` drives `announce`/`lookup` itself (re-announce at half the granted TTL, poll at `discoveryPollMs`) with a 10 s request timeout, so retries, logging and timeouts are meddle's.
11. **Notifications are pool-wide in the browser**, merged from every online node, since the browser holds every node anyway.
12. **The lighthouse client works from bun against the hosted lighthouse.** Verified 2026-10-31: `iroh-lighthouse` 0.1.0 under bun announced two throwaway keys on a random private topic at https://iroh.ichor.io (74 ms, TTL 10 s granted), each saw the other with its `Ip` and `Relay` addresses, `lookup` listed both, and a TTL-0 announce removed them. The lighthouse `EndpointAddr` is `{ id: hex, addrs: [{ Ip } | { Relay }] }` and the bindings' `EndpointAddr(id, relayUrl, directAddresses)` maps onto it one to one (spec section 18's check).
13. **Compiled binaries embed the iroh native module.** Verified 2026-10-31: `bun build --compile` of a script importing `@number0/iroh` produced a 143 MB binary that bound an endpoint when run from another directory. A compiled node reports `claudeCodeVersion` as `unknown` (Plan 1), which the pool's mixed-version flag will show.
14. **The card shows `shortId`; the full endpoint id is in the card's `title` attribute and in the Settings members table.**

## Verified behaviour of the pinned bindings (2026-10-31, loopback probes)

- `Endpoint.builder()` + `presetMinimal` + `bindAddr("127.0.0.1:0")` binds in about 14 ms; connect over loopback in 1 ms; a 300 KiB stream round-trips in 29 ms; two endpoints in one bun process add about 35 MB RSS.
- `RecvStream.read(n)` resolves an **empty array** at the end of a finished stream; `readExact` past the end rejects with `FinishedEarly(0)`; a stream the peer `reset` delivers its buffered bytes first and a later read rejects; after the peer closed the connection, reads still return buffered data and `writeAll` **succeeds silently**. Only `Connection.closed()` reports the close, resolving to a string `closed by peer: <reason> (code N)`.
- An id-only `connect` with no prior contact and no discovery rejects with `No addressing information available`; after any contact the endpoint remembers the path and `endpoint.remoteAddr(id)` returns it.

## Global Constraints

- Plan 1's Global Constraints apply unchanged (bun, TypeScript, jj commits without AI attribution, `MEDDLE_*` test overrides, token never on a command line or in logs).
- Pinned exactly: `@number0/iroh@1.2.0`, `iroh-lighthouse@0.1.0` (`bunfig.toml` already sets exact installs).
- A node id is the lowercase hex of its iroh public key, 64 characters, validated with `/^[0-9a-f]{64}$/` wherever it is parsed. `shortId(id)` is its first 10 characters and is what the CLI and the UI print.
- The iroh secret key lives at `<data>/secrets/iroh.key` as 64 hex characters, mode 600, created on first use.
- ALPNs: `meddle/0` (accepted only from roster rows with status `member`) and `meddle/join/0` (accepted from anyone, one request line, code-gated). Every bidirectional stream begins with one `\n`-terminated JSON header line (at most 64 KiB) `{ "stream": "<kind>", ... }`. Kinds in this plan: `chord` and `dashboard`.
- Connection close reasons: code 1 `not a member` (never admitted), code 1 `removed` (was a member), code 0 `bye` (orderly), code 0 `duplicate` (replaced by a newer connection).
- Dial rule: of two members, the one with the lexicographically smaller node id dials; the other only accepts.
- Principals: `local` for every dashboard link (local or tunnelled), `peer:<nodeId>` for a peer's chord link.
- Pool state is in `meddle.sqlite`: tables `pool` (one row), `roster`, `invites`.
- The token value crosses the network only as the result of `fetchToken` on a `peer`-variant `PoolObject`, over a `chord` stream, to a current member. It never appears in roster state, tickets, logs or test output. Tests use the tokens `tok` (what `setupNode` writes), `tok2` and `tok3`, and assert that no link frame other than a `result` frame contains them.
- Default lighthouse URL `https://iroh.ichor.io` (`MEDDLE_LIGHTHOUSE_URL`; empty disables discovery). Topic: `Topic.withSecret("meddle/<poolId>", poolSecret)`. Announce TTL 300 s; re-announce at half the granted TTL; poll every `MEDDLE_DISCOVERY_POLL_MS` (default 10000, minimum 500); every lighthouse request has a 10 s timeout. Discovery logs each distinct error message at most once a minute.
- iroh preset `MEDDLE_IROH_PRESET`: `n0` (default) or `minimal`; bind address `MEDDLE_IROH_BIND` (default unset: iroh's default). Tests always set `MEDDLE_IROH_PRESET=minimal` and `MEDDLE_IROH_BIND=127.0.0.1:0`, and never reach the hosted lighthouse or relays.
- Dashboard tunnel path: `/ws/node/<nodeId>`; `<nodeId>` equal to this node's id behaves like `/ws`. Tunnel frames: 1 byte kind (0 text, 1 binary) + 4 bytes big-endian length + payload; a frame is at most 16 MiB.
- The browser holds one chord client host per node it looks at, each over its own `/ws/node/<nodeId>` socket.
- Invite tickets: prefix `meddle1`, valid 24 hours, single use.
- Test timeouts: tests that start two pool nodes state `15_000`; the two-process end-to-end test states `60_000`; everything else fits bun's default 5 s.
- Nothing in this plan changes the engine (`src/engine/*`), provisioning or the durable turn.

## Review Focus

1. A roster row arriving from a peer with an older `updatedAt` than the local row must not change the local row, and a `removed` row must never be resurrected by an older `member` row. Test in Task 1.
2. A connection on `meddle/0` from an endpoint that is not a `member` is closed before any stream is read (`not a member`), and a connection that was accepted while the peer was a member is closed by every member once a merge marks that peer `removed`, including members that did not do the removing. Tests in Tasks 2 and 6 (three nodes).
3. The token value never appears in a chord state frame, a ticket or anything a node logs; it travels only as a `fetchToken` result, and `fetchToken` refuses a principal that is not a current member. Tests in Task 3.
4. The lighthouse unreachable or black-holed when `serve` starts: the node still starts, discovery keeps retrying with backoff, requests time out at 10 s, and each distinct error is logged at most once a minute. Tests in Task 4.
5. `/ws/node/<id>` for a node that is not a member answers 404 and for an offline member answers 503 at once; neither hangs the browser. Test in Task 7.

---

## File structure

```
src/
  config.ts                  + lighthouseUrl, irohPreset, irohBind, discoveryPollMs
  paths.ts                   + irohKey
  token.ts                   setToken takes { setAt?, setBy? }; tokenStatus returns setBy
  store/db.ts                + pool, roster, invites tables
  pool/
    identity.ts              the iroh secret key file; Identity; shortId; hex <-> EndpointId
    store.ts                 PoolStore: pool identity, roster (LWW), invites
    frames.ts                ALPN constants, StreamReader, writeLine, writeFrame
    net.ts                   openEndpoint, PoolNet: accept loop, dial loops, streams, closing non-members
    link.ts                  IrohLink: a chord Link over a PeerStream
    object.ts                servePool: the PoolObject factory (default and peer variants)
    sync.ts                  PoolSync: a client host per peer, roster merge, token pull; acceptPeerLinks
    discovery.ts             Discovery over the lighthouse's announce/lookup; address conversions
    invite.ts                tickets, join handshake, invite creation
    runtime.ts               startPool: wires identity, endpoint, store, net, sync, discovery, invites, enforcement
  state/contracts.ts         + PoolObject (variants default, peer), RosterRowSchema, TokenMetaSchema, NodeObject.nodeId
  state/host.ts              NodeHostDeps.pool; calls servePool; NodeObject.nodeId; token refresh on pool changes
  dashboard/tunnel.ts        IrohSocketShim; acceptDashboardStreams; bridgeSocket
  dashboard/server.ts        + /ws/node/<id>
  dashboard/ui/routes.ts     viewOf, hashOf
  dashboard/ui/hooks.ts      + Hosts
  dashboard/ui/main.tsx      hosts per node; routes #/task/<nodeId>/<taskId>
  dashboard/ui/Pool.tsx      a card per pool node; tasks per node; node picker in New task
  dashboard/ui/Settings.tsx  pool section: invite, join, remove; token meta
  dashboard/ui/Task.tsx      unchanged internals, given the owning node's host
  cli.ts                     + invite, join, pool; token set tells the node; status shows node and pool; serve wiring
test/
  fake-lighthouse.ts         in-process lighthouse HTTP server (no signature checks)
  pool-helpers.ts            endpoint pairs and two in-process pool nodes
  identity.test.ts  pool-store.test.ts  frames.test.ts  net.test.ts  sync.test.ts  discovery.test.ts
  invite.test.ts  pool-state.test.ts  tunnel.test.ts  pool-e2e.test.ts  ui.test.ts
```

---

### Task 1: Dependencies, config, identity, token metadata and the pool store

**Files:**
- Modify: `package.json`, `src/config.ts`, `src/paths.ts`, `src/token.ts`, `src/store/db.ts`
- Create: `src/pool/identity.ts`, `src/pool/store.ts`
- Test: `test/config.test.ts` (extend), `test/identity.test.ts`, `test/pool-store.test.ts`, `test/token.test.ts` (extend)

**Interfaces:**
- Consumes: `NodeConfig`, `paths()`, `openDb()`, `setToken`/`tokenStatus` from Plan 1.
- Produces:
  ```ts
  // config.ts additions
  lighthouseUrl: string;            // MEDDLE_LIGHTHOUSE_URL, default "https://iroh.ichor.io"; "" disables discovery
  irohPreset: "n0" | "minimal";     // MEDDLE_IROH_PRESET, default "n0"; anything else throws "MEDDLE_IROH_PRESET must be n0 or minimal"
  irohBind: string | null;          // MEDDLE_IROH_BIND, default null
  discoveryPollMs: number;          // MEDDLE_DISCOVERY_POLL_MS, default 10000; not an integer >= 500 throws "MEDDLE_DISCOVERY_POLL_MS must be an integer of at least 500"
  // paths.ts addition
  irohKey: join(secrets, "iroh.key")
  // token.ts
  export async function setToken(cfg: NodeConfig, token: string, meta?: { setAt?: string; setBy?: string }): Promise<void>;
  export async function tokenStatus(cfg: NodeConfig): Promise<{ present: boolean; setAt?: string; setBy?: string; expiresAt?: string }>;
  // identity.ts
  export type Identity = { id: string; secret: Uint8Array };
  export async function loadOrCreateIdentity(cfg: NodeConfig): Promise<Identity>;
  export function shortId(id: string): string;
  export function isNodeId(text: string): boolean;                 // /^[0-9a-f]{64}$/
  export function hexOf(id: EndpointId): string;                   // Buffer.from(id.toBytes()).toString("hex")
  export function endpointIdOf(hex: string): EndpointId;           // validates with isNodeId, then EndpointId.fromBytes
  // store.ts
  export type NodeSummary = { hostname: string; version: string; claudeCodeVersion: string; hostsTasks: boolean; taskCount: number };
  export type WireAddr = { id: string; relay: string | null; direct: string[] };
  export type RosterRow = {
    nodeId: string; hostname: string; status: "member" | "removed"; updatedAt: string; addedBy: string;
    summary: NodeSummary | null; lastSeenAt: string | null; lastAddr: WireAddr | null;
  };
  export type PoolIdentity = { poolId: string; poolSecret: string; createdAt: string };
  export class PoolStore {
    constructor(db: Database);
    ensurePool(self: { nodeId: string; hostname: string }, now?: string): PoolIdentity;
    pool(): PoolIdentity;
    roster(): RosterRow[];                 // ordered by nodeId
    members(): RosterRow[];                // status member
    row(nodeId: string): RosterRow | null;
    isMember(nodeId: string): boolean;
    upsert(row: RosterRow): void;
    merge(rows: RosterRow[]): boolean;     // true when any row changed
    remove(nodeId: string, now?: string): void;
    seen(nodeId: string, at: string, summary: NodeSummary | null, addr: WireAddr | null): void;
    replacePool(pool: PoolIdentity, roster: RosterRow[]): void;
    createInvite(now?: Date): { code: string; expiresAt: string };
    consumeInvite(code: string, now?: Date): boolean;
  }
  ```

- [ ] **Step 0: Add the dependencies**

Run: `bun add @number0/iroh@1.2.0 iroh-lighthouse@0.1.0`. Check `package.json` pins both exactly (no `^`). Run `bun test` once: everything still passes.

- [ ] **Step 1: Write the failing tests**

`test/config.test.ts`, add:
```ts
test("pool settings default and parse", () => {
  const cfg = loadConfig({ HOME: "/h" });
  expect(cfg.lighthouseUrl).toBe("https://iroh.ichor.io");
  expect(cfg.irohPreset).toBe("n0");
  expect(cfg.irohBind).toBeNull();
  expect(cfg.discoveryPollMs).toBe(10000);
  const t = loadConfig({ HOME: "/h", MEDDLE_LIGHTHOUSE_URL: "", MEDDLE_IROH_PRESET: "minimal", MEDDLE_IROH_BIND: "127.0.0.1:0", MEDDLE_DISCOVERY_POLL_MS: "1500" });
  expect(t.lighthouseUrl).toBe("");
  expect(t.irohPreset).toBe("minimal");
  expect(t.irohBind).toBe("127.0.0.1:0");
  expect(t.discoveryPollMs).toBe(1500);
  expect(() => loadConfig({ HOME: "/h", MEDDLE_IROH_PRESET: "fast" })).toThrow("MEDDLE_IROH_PRESET must be n0 or minimal");
  expect(() => loadConfig({ HOME: "/h", MEDDLE_DISCOVERY_POLL_MS: "100" })).toThrow("MEDDLE_DISCOVERY_POLL_MS must be an integer of at least 500");
});
```

`test/identity.test.ts` (write a local `cfg()` helper like `test/token.test.ts`'s: a temp HOME and `MEDDLE_DATA_DIR`, after `ensureDataDirs`):
```ts
test("the identity is created once, hex, mode 600, and its id is the iroh public key", async () => {
  const a = await loadOrCreateIdentity(cfg);
  const b = await loadOrCreateIdentity(cfg);
  expect(isNodeId(a.id)).toBe(true);
  expect(b.id).toBe(a.id);
  expect(a.secret.length).toBe(32);
  expect((await stat(paths(cfg).irohKey)).mode & 0o777).toBe(0o600);
  expect((await readFile(paths(cfg).irohKey, "utf8")).trim()).toMatch(/^[0-9a-f]{64}$/);
  expect(hexOf(SecretKey.fromBytes(Array.from(a.secret)).public())).toBe(a.id);
  expect(endpointIdOf(a.id).equals(SecretKey.fromBytes(Array.from(a.secret)).public())).toBe(true);
  expect(() => endpointIdOf("zz")).toThrow("not a node id");
  expect(shortId(a.id)).toBe(a.id.slice(0, 10));
});
```

`test/pool-store.test.ts` (ids `A`, `B`, `C`, `D` are distinct 64-hex strings; `t1 < t2 < t3 < t4` ISO strings):
```ts
test("ensurePool makes a pool of one and is idempotent", () => {
  const store = new PoolStore(openDb(":memory:"));
  const pool = store.ensurePool({ nodeId: A, hostname: "alpha" });
  expect(pool.poolId).toMatch(/^[0-9a-f]{32}$/);
  expect(pool.poolSecret).toMatch(/^[0-9a-f]{64}$/);
  expect(store.ensurePool({ nodeId: A, hostname: "alpha" })).toEqual(pool);
  expect(store.members().map((r) => r.nodeId)).toEqual([A]);
  expect(store.row(A)).toMatchObject({ hostname: "alpha", status: "member", addedBy: A });
});

test("merge is last-writer-wins per node and never resurrects a removed node", () => {
  // local: B member at t2, C removed at t3
  // remote: B removed at t1 (older: ignored), C member at t2 (older: ignored), D member at t1 (new: added)
  expect(store.merge(remote)).toBe(true);
  expect(store.row(B)!.status).toBe("member");
  expect(store.row(C)!.status).toBe("removed");
  expect(store.row(D)!.status).toBe("member");
  expect(store.merge(remote)).toBe(false);           // nothing newer the second time
  expect(store.merge([{ ...store.row(B)!, status: "removed", updatedAt: t4 }])).toBe(true);
  expect(store.isMember(B)).toBe(false);
  expect(store.merge([{ ...store.row(B)!, status: "member", updatedAt: t4 }])).toBe(false);   // equal is not newer
});

test("seen updates summary, lastSeenAt and lastAddr without touching updatedAt; merge takes the newer lastSeenAt", () => {
  // store.seen(B, t3, summary, addr) → row(B).updatedAt unchanged, summary/lastSeenAt/lastAddr set
  // merge a B row with the same updatedAt, lastSeenAt t2 and another summary → false, unchanged
  // merge a B row with the same updatedAt, lastSeenAt t4 and another summary → true, summary replaced
});

test("replacePool swaps the identity and the roster wholesale", () => { ... expect(store.pool().poolId).toBe("p2"); expect(store.roster()).toHaveLength(2); });

test("invites are single use and expire after 24 hours", () => {
  const { code, expiresAt } = store.createInvite(new Date("2026-10-31T00:00:00Z"));
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(expiresAt).toBe("2026-11-01T00:00:00.000Z");
  expect(store.consumeInvite(code, new Date("2026-10-31T01:00:00Z"))).toBe(true);
  expect(store.consumeInvite(code, new Date("2026-10-31T01:00:00Z"))).toBe(false);
  const late = store.createInvite(new Date("2026-10-31T00:00:00Z"));
  expect(store.consumeInvite(late.code, new Date("2026-11-01T00:00:01Z"))).toBe(false);
  expect(store.consumeInvite("nope")).toBe(false);
});
```

`test/token.test.ts`, add:
```ts
test("setToken records setBy and a given setAt; tokenStatus returns both", async () => {
  await setToken(cfg, "tok", { setAt: "2026-10-31T10:00:00.000Z", setBy: A });
  expect(await tokenStatus(cfg)).toEqual({ present: true, setAt: "2026-10-31T10:00:00.000Z", setBy: A, expiresAt: "2027-10-31T10:00:00.000Z" });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/config.test.ts test/identity.test.ts test/pool-store.test.ts test/token.test.ts`
Expected: FAIL (missing exports, missing modules).

- [ ] **Step 3: Implement**

- `config.ts`: the four fields; `irohPreset` validated; `discoveryPollMs` parsed like `port` with the minimum.
- `paths.ts`: `irohKey`.
- `token.ts`: `setToken(cfg, token, meta)` writes `{ setAt: meta?.setAt ?? now, setBy: meta?.setBy ?? null }` to the meta file; `tokenStatus` returns `setBy` when present.
- `db.ts` migrations: `pool (pool_id TEXT PRIMARY KEY, pool_secret TEXT, created_at TEXT)`; `roster (node_id TEXT PRIMARY KEY, hostname TEXT, status TEXT, updated_at TEXT, added_by TEXT, summary TEXT, last_seen_at TEXT, last_addr TEXT)`; `invites (code TEXT PRIMARY KEY, created_at TEXT, expires_at TEXT, used_at TEXT)`.
- `identity.ts`: read the hex file; if missing, `SecretKey.generate()`, write hex with mode 600 (`writeFile` with `mode: 0o600` then `chmod`). `id = hexOf(secret.public())`. `endpointIdOf` throws `not a node id` on anything `isNodeId` rejects.
- `store.ts`: `ensurePool` inserts the `pool` row when the table is empty (`poolId` = 16 random bytes hex, `poolSecret` = 32 random bytes hex) and upserts the self row as `member` if absent. `merge`: per row, replace membership fields when `remote.updatedAt > local.updatedAt` (string compare) or no local row; separately take `summary`/`lastSeenAt`/`lastAddr` when `remote.lastSeenAt` is a string greater than the local one (or the local is null). `remove` sets status and `updatedAt = now`. `createInvite`: 32 random bytes base64url (no padding).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/config.test.ts test/identity.test.ts test/pool-store.test.ts test/token.test.ts` then `bun test` and `bun run typecheck`.
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat: pool identity, roster store and token metadata"
```

---

### Task 2: Endpoint, stream framing and the connection manager

**Files:**
- Create: `src/pool/frames.ts`, `src/pool/net.ts`, `test/pool-helpers.ts` (the `endpointPair` helper only; later tasks extend it)
- Test: `test/frames.test.ts`, `test/net.test.ts`

**Interfaces:**
- Consumes: `Identity`, `endpointIdOf`, `hexOf`, `NodeConfig`, `WireAddr`.
- Produces:
  ```ts
  // frames.ts
  export const ALPN_POOL: number[];   // bytes of "meddle/0"
  export const ALPN_JOIN: number[];   // bytes of "meddle/join/0"
  export const MAX_LINE = 65_536;
  export const MAX_FRAME = 16 * 1024 * 1024;
  export type StreamHeader = { stream: string } & Record<string, unknown>;
  export class StreamReader {
    constructor(recv: RecvStream);
    /** The next `\n`-terminated line without its terminator; null at end of stream. Rejects "line exceeds <max> bytes". */
    readLine(max?: number): Promise<string | null>;
    /** Exactly `n` bytes, or null when the stream ends first. */
    readExact(n: number): Promise<Uint8Array | null>;
    /** The next frame, or null at end of stream. Rejects "frame exceeds 16777216 bytes". */
    readFrame(): Promise<{ kind: number; data: Uint8Array } | null>;
  }
  export function writeLine(send: SendStream, text: string): Promise<void>;
  export function writeFrame(send: SendStream, kind: number, data: Uint8Array): Promise<void>;
  export function parseHeader(line: string): StreamHeader;   // throws "bad stream header" unless an object with a string `stream`
  // net.ts
  export async function openEndpoint(cfg: Pick<NodeConfig, "irohPreset" | "irohBind">, identity: Identity): Promise<Endpoint>;
  export function toEndpointAddr(addr: WireAddr): EndpointAddr;      // the bindings' class, via endpointIdOf
  export function fromEndpoint(endpoint: Endpoint): WireAddr;        // this endpoint's own address, id via hexOf
  export async function remoteAddrOf(endpoint: Endpoint, id: string): Promise<WireAddr | null>;   // endpoint.remoteAddr
  export type PeerStream = {
    peerId: string; header: StreamHeader; stream: BiStream; reader: StreamReader;
    /** Settles when the connection the stream rides on is closed (with iroh's reason string). */
    closed: Promise<string>;
  };
  export type NetDeps = {
    endpoint: Endpoint;
    selfId: string;
    isMember(id: string): boolean;
    onJoin(conn: Connection): Promise<void>;          // a connection on ALPN_JOIN
    onError?(err: unknown): void;
    backoff?: { initialMs: number; maxMs: number };   // default 1000 / 30000
  };
  export class PoolNet {
    constructor(deps: NetDeps);
    readonly endpoint: Endpoint;
    start(): void;
    stop(): Promise<void>;
    /** Keeps a connection to a member: dials (when selfId < peerId) with backoff, accepts otherwise. */
    watch(peerId: string): void;
    /** Closes any connection with the peer (inbound or outbound) with code 1 and `reason`, and stops dialing it. */
    unwatch(peerId: string, reason: "removed" | "not a member"): void;
    /** Remembers an address and, when watching and offline, dials at once. */
    offerAddress(addr: WireAddr): void;
    isOnline(peerId: string): boolean;
    online(): string[];
    onPeer(cb: (peerId: string, online: boolean) => void): () => void;
    onStream(cb: (s: PeerStream) => void): () => void;
    openStream(peerId: string, header: StreamHeader): Promise<PeerStream>;   // rejects "not connected to <shortId>"
  }
  // test/pool-helpers.ts
  /** Two endpoints with presetMinimal on 127.0.0.1:0 and fresh identities; `connect(alpn)` dials b from a. */
  export async function endpointPair(): Promise<{ a: { endpoint; identity }; b: { endpoint; identity }; close(): Promise<void> }>;
  ```

- [ ] **Step 1: Write the failing tests**

`test/frames.test.ts` (over `endpointPair`, a dialled connection on `ALPN_POOL` and streams opened on it):
```ts
test("lines and frames round-trip, EOF is null, oversize is refused", async () => {
  // a writes: a header line, a 5-byte frame of kind 1, a frame of 300 KiB of kind 0, then finishes
  // b reads: readLine() === the header, readFrame() → {kind:1, 5 bytes}, readFrame() → 300 KiB equal, readFrame() → null, readLine() → null
  // a second stream: a writes 70 000 bytes without a newline; b.readLine() rejects "line exceeds 65536 bytes"; b.readLine(100) on a fresh stream of 200 bytes rejects "line exceeds 100 bytes"
  // a third stream: a writes a frame header claiming 17 MiB; b.readFrame() rejects "frame exceeds 16777216 bytes"
});
test("parseHeader accepts {stream} objects and refuses the rest", () => { ... });
```

`test/net.test.ts`:
```ts
test("a member connects, the smaller id dials, streams carry headers both ways", async () => {
  // two PoolNets whose isMember accepts both ids; both watch each other; the smaller id is offered the larger's address
  // until(onPeer online) on both; each side saw exactly one onPeer(online) event
  // dialer.openStream(peer, {stream:"x", n:1}) → acceptor's onStream gets header {stream:"x", n:1}; the acceptor writes a line back, the dialer reads it
  // the acceptor opens a stream too (streams go both ways on one connection)
  // s.closed is pending while connected
});
test("a non-member is refused before any stream is read", async () => {
  // b.isMember returns false for a; a dials b: a's connection's closed() resolves to a string containing "not a member" and "(code 1)";
  // b never reports onPeer(online) and never gets a stream
});
test("unwatch closes the connection with the reason and the other side sees it", async () => {
  // both online; acceptor.unwatch(dialer, "removed") → the dialer's onPeer(id, false) fires and every open PeerStream's `closed` resolves containing "removed" and "(code 1)";
  // the dialer, still watching, redials with backoff {initialMs: 50, maxMs: 200} and is refused (acceptor's isMember now false for it) — onPeer(online) does not fire again within 500 ms
});
test("a dropped connection is noticed and redialled", async () => {
  // after both online: the acceptor closes the connection with code 0 (test hook or unwatch+watch); both sides report offline; the dialer redials; both online again within 2 s
});
test("openStream on an offline peer rejects", async () => { await expect(net.openStream(unknown, {stream:"x"})).rejects.toThrow("not connected to"); });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/frames.test.ts test/net.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `frames.ts`: `StreamReader` buffers `recv.read(65536)` chunks (`Array<number>` → `Uint8Array`); an empty array is EOF; a rejection is also the end (deliver nothing partial, return null from then on). Put the verified behaviours (see "Verified behaviour") in a comment. `writeLine` appends `\n` and uses `send.writeAll`.
- `net.ts`:
  - `openEndpoint`: `Endpoint.builder()`, `presetN0` or `presetMinimal` by `cfg.irohPreset`, `secretKey(Array.from(identity.secret))`, `alpns([ALPN_POOL, ALPN_JOIN])`, `bindAddr(cfg.irohBind)` when set, `bind()`.
  - Accept loop: `for (;;) { const incoming = await endpoint.acceptNext(); if (!incoming) break; ... }`; each connection handled without blocking the loop: `incoming.accept()` → `accepting.connect()` → `conn.alpn()`; `ALPN_JOIN` → `deps.onJoin(conn)`; `ALPN_POOL` → `hexOf(conn.remoteId())`; not a member → `conn.close(1n, bytes("not a member"))`; else register as the peer's connection: an existing connection with that peer is closed first with code 0 `duplicate` (its streams' `closed` settle, `onPeer(id, false)` then `onPeer(id, true)` for the new one); run a stream-accept loop (`conn.acceptBi()` → read header line → `onStream` with `closed: conn.closed()`); on `conn.closed()` emit `onPeer(id, false)` and, on the dialing side, schedule a redial.
  - Dial loop per watched peer where `selfId < peerId`: `endpoint.connect(toEndpointAddr(addr ?? { id, relay: null, direct: [] }), ALPN_POOL)`; on failure wait `backoff` (double up to max); `offerAddress` stores the address and wakes the loop at once; a connection refused with `not a member` or `removed` is reported through `onError` with the reason and redialled on the backoff schedule like any failure (the runtime decides what a `removed` refusal means).
  - `openStream`: `conn.openBi()`, `writeLine(header)`, return the stream with a reader and the connection's `closed`.
  - `stop()`: close every connection (code 0, `bye`), stop loops, `endpoint.close()`.
- `test/pool-helpers.ts`: `endpointPair()`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/frames.test.ts test/net.test.ts`, then `bun test`, `bun run typecheck`.
Expected: all pass; no test takes more than 5 s.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat: iroh endpoint, stream framing and the peer connection manager"
```

---

### Task 3: The pool object, the chord link over iroh, and sync

**Files:**
- Create: `src/pool/link.ts`, `src/pool/object.ts`, `src/pool/sync.ts`
- Modify: `src/state/contracts.ts`
- Test: `test/sync.test.ts`, `test/pool-helpers.ts` (extend)

**Interfaces:**
- Consumes: `PoolStore`, `PoolNet`, `PeerStream`, `setToken`/`tokenStatus`/`getToken`, `NodeSummary`, chord `Link`, `Frame`, `createHost`, `Host`.
- Produces:
  ```ts
  // contracts.ts additions
  export const WireAddrSchema, NodeSummarySchema, RosterRowSchema, TokenMetaSchema;   // TypeBox mirrors of the store types
  export const PoolNodeSchema = Type.Object({
    nodeId: Type.String(), hostname: Type.String(), status: Type.Union([Type.Literal("member"), Type.Literal("removed")]), online: Type.Boolean(),
    version: Type.String(), claudeCodeVersion: Type.String(), hostsTasks: Type.Boolean(), taskCount: Type.Number(), lastSeenAt: Nullable(Type.String()),
  });
  export const PoolObject = remote("meddle.pool", {
    version: 1, input: Type.Object({}), host: hostNamed("node"),
    variants: {
      /** Dashboards and the CLI (principal `local`, `cli`, …). */
      default: {
        state: {
          poolId: Type.String(), self: Type.String(), nodes: Type.Array(PoolNodeSchema),
          token: Type.Object({ present: Type.Boolean(), setAt: Nullable(Type.String()), setBy: Nullable(Type.String()), expiresAt: Nullable(Type.String()) }),
          /** Members report more than one meddle or Claude Code version. */
          mixedVersions: Type.Boolean(),
        },
        methods: {
          invite: method(Type.Object({}), Type.Object({ ticket: Type.String() })),
          join: method(Type.Object({ ticket: Type.String() }), Type.Object({ poolId: Type.String(), members: Type.Number() })),
          remove: method(Type.Object({ nodeId: Type.String() })),
          /** The token file changed on this node (written by the CLI); re-read it and tell the pool. */
          tokenChanged: method(Type.Object({})),
        },
      },
      /** Other nodes (principal `peer:<nodeId>`). */
      peer: {
        state: { roster: Type.Array(RosterRowSchema), token: Nullable(TokenMetaSchema) },
        methods: { fetchToken: method(Type.Object({}), Type.Object({ value: Type.String(), setAt: Type.String(), setBy: Nullable(Type.String()) })) },
      },
    },
  });
  // link.ts
  export type LinkTap = (direction: "in" | "out", text: string) => void;
  /** A chord Link over a PeerStream: one JSON frame per line. Mirrors chord's BaseLink (dist/link.js): queue before `receive`, `bye` on close, close handlers once. */
  export class IrohLink implements Link {
    constructor(stream: PeerStream, options?: { tap?: LinkTap });
    readonly closed: boolean;
    send(frame: Frame): number | undefined;    // the line's length; writes are serialised through one promise chain
    receive(handler: (frame: Frame) => void): void;
    onClose(handler: (reason: string) => void): void;
    close(reason?: string): void;
  }
  // object.ts
  export type PoolObjectDeps = {
    store: PoolStore; cfg: NodeConfig; selfId: string;
    isOnline(nodeId: string): boolean;
    liveSummary(): NodeSummary | Promise<NodeSummary>;     // this node's current summary, for its own row
    invite(): string; join(ticket: string): Promise<{ poolId: string; members: number }>; remove(nodeId: string): Promise<void>;
    tokenChanged(): Promise<void>;
    /** Fires whenever the roster, a peer's online state or the token changed. */
    changes: Subscribable<null>;
  };
  export const PEER_PRINCIPAL_PREFIX = "peer:";
  export function peerOf(principal: unknown): string | null;      // the node id of a `peer:<id>` principal, else null
  /** Serves PoolObject on `host`: the `peer` variant to `peer:` principals, `default` to everyone else. */
  export function servePool(host: Host, deps: PoolObjectDeps): void;
  // sync.ts
  export type SyncDeps = {
    cfg: NodeConfig; store: PoolStore; net: PoolNet; selfId: string;
    summary(): NodeSummary | Promise<NodeSummary>;
    onChange(): void;                 // the roster or the token changed because of a peer, or the self row was refreshed
    onError?(err: unknown): void;
    tap?: LinkTap;                    // tests: every frame sent or received on every peer link
    refreshMs?: number;               // self-row refresh period, default 15000
  };
  export class PoolSync {
    constructor(deps: SyncDeps);
    start(): void;    // per online peer: open a `chord` stream, a client host over IrohLink, hold the peer's PoolObject (peer variant), merge; refresh the self row periodically
    stop(): Promise<void>;
    refreshSelf(): Promise<void>;     // store.seen(selfId, now, await summary(), fromEndpoint(net.endpoint)) then onChange()
  }
  /** Accepts every `chord` stream a member opens as a client link on `host` acting as `peer:<peerId>`. Returns the unsubscribe. */
  export function acceptPeerLinks(net: PoolNet, host: Host, isMember: (id: string) => boolean): () => void;
  ```

- [ ] **Step 1: Write the failing tests**

`test/pool-helpers.ts`, add `twoNodes(options?)`: two temp homes with `openDb`, `PoolStore` (`ensurePool`), identities, endpoints (`presetMinimal`, `127.0.0.1:0`), `PoolNet`s whose `isMember` reads the store, a chord host per node (`createHost({ name: "node", self: "node" })`) with `servePool` (deps backed by the store and the net; `invite`/`join`/`remove` may throw "not in this test"), `acceptPeerLinks`, `PoolSync`s with `tap` collecting frames per node; each store has the other as a `member` row; the smaller id offered the other's address; `close()` stops everything. Returns `{ a, b, framesOf(node) }`.

`test/sync.test.ts` (each test `15_000`):
```ts
test("summaries, roster edits and the token replicate through chord over iroh", async () => {
  // both online → until each store.row(other).summary.hostname equals the other's summary hostname, lastSeenAt set, lastAddr non-null
  // A: setToken(A.cfg, "tok2", { setBy: A.id }); A's PoolObjectDeps.tokenChanged() (or sync.refreshSelf() after the token write)
  // → until tokenStatus(B.cfg) has setBy A.id and the same setAt; getToken(B.cfg) === "tok2"; B's token file mode 600
  // B later: setToken(B.cfg, "tok3", { setBy: B.id }) → A gets "tok3"
  // A: store.remove(C) for a third member row both knew; A onChange → until B.store.row(C).status === "removed"
});
test("the token never appears in a frame other than a fetchToken result", async () => {
  // after the test above: every tapped frame text containing "tok2" or "tok3" parses to a frame with t === "result"
  // and no frame with t === "state" contains either
});
test("fetchToken refuses a principal that is not a current member", async () => {
  // B.store.remove(A); through B's own host, a client host accepted with principal `peer:<A.id>` calls fetchToken → rejects (chord `forbidden`: "not a member")
});
test("a peer with an older token does not overwrite a newer local one", async () => { ... });
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/sync.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

- `IrohLink`: `send` serialises `JSON.stringify(frame) + "\n"` through a promise chain on `stream.send`; a write failure ends the link. A read loop (`reader.readLine()`) parses each line and delivers (queue until `receive`); `bye` ends the link with its reason; EOF or `stream.closed` settling ends it with `"closed"`/the connection's reason. `close(reason)` sends `bye`, finishes the send stream, notifies close handlers once. `tap` sees every line both ways.
- `servePool`: cells `roster` (from `store.roster()`, with the self row's `summary` replaced by `liveSummary()` and `lastSeenAt` now), `token` (from `tokenStatus(cfg)`), refreshed on `deps.changes`; `default` variant derives `nodes` (`online` from `isOnline`, self always online; fields from the row's summary, or the live summary for self, or `""`/`false`/`0` when null), `poolId`, `self`, `token`, `mixedVersions` (members only, more than one distinct `version` or `claudeCodeVersion`), methods delegating to deps. `peer` variant: `roster`, `token` (meta or null), `fetchToken` → `peerOf(principal)` must be a member (`store.isMember`), else throw a chord `forbidden` error "not a member"; returns `getToken(cfg)` with the meta.
- `PoolSync`: on `net.onPeer(id, true)`: `net.openStream(id, { stream: "chord" })`, `createHost({ name: \`peer-view:${shortId(id)}\`, self: "node", kind: "client", upstream: { link: new IrohLink(s, { tap }), principal: \`peer:${id}\` } })`, `host.get(PoolObject, {})`; subscribe `ref.roster` → `if (store.merge(rows)) onChange()`; subscribe `ref.token` → when newer than `tokenStatus(cfg).setAt` (or local absent) `await ref.fetchToken({})` → re-check it is still newer → `setToken(cfg, value, { setAt, setBy })` → `onChange()`. On `onPeer(id, false)`: close that client host, drop the reference. `refreshSelf` on a timer and in `start`. A failing hold (peer not serving, link closed) is reported through `onError` and retried on the next `onPeer(online)`.
- `acceptPeerLinks`: `net.onStream` → `header.stream === "chord"` → `isMember(s.peerId)` or close the stream → `host.accept(new IrohLink(s), { principal: \`peer:${s.peerId}\`, kind: "client" })`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/sync.test.ts`, `bun test`, `bun run typecheck`. Expected: pass.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat: PoolObject, a chord link over iroh, and pool sync between nodes"
```

---

### Task 4: Discovery through the lighthouse

**Files:**
- Create: `src/pool/discovery.ts`, `test/fake-lighthouse.ts`
- Test: `test/discovery.test.ts`

**Interfaces:**
- Consumes: `iroh-lighthouse` (`Lighthouse`, `NodeKey`, `Topic`, protocol `EndpointAddr`, `Peer`), `Endpoint`, `WireAddr`, `PoolIdentity`, `Identity`, `fromEndpoint`.
- Produces:
  ```ts
  export const ANNOUNCE_TTL_SECS = 300;
  export const REQUEST_TIMEOUT_MS = 10_000;
  export function topicFor(pool: Pick<PoolIdentity, "poolId" | "poolSecret">): Topic;
  export function toLighthouseAddr(addr: WireAddr): LighthouseEndpointAddr;   // { id, addrs: [...direct.map(Ip), relay ? {Relay} : none] }
  export function fromLighthouseAddr(addr: LighthouseEndpointAddr): WireAddr;
  export type DiscoveryDeps = {
    endpoint: Endpoint; identity: Identity; pool: PoolIdentity;
    lighthouseUrl(): string;               // read at every request, so a test can swap it
    pollMs: number;
    onPeers(peers: WireAddr[]): void;      // only when the set of ids or an address changed
    onError?(message: string): void;       // each distinct message at most once a minute
    backoff?: { initialMs: number; maxMs: number };   // default 1000 / 60000
    requestTimeoutMs?: number;             // default REQUEST_TIMEOUT_MS
  };
  export class Discovery {
    constructor(deps: DiscoveryDeps);
    start(): void;                         // announce (retrying with backoff), re-announce at half the granted TTL and on address change, poll with lookup
    restart(pool: PoolIdentity): Promise<void>;   // leave the old topic (TTL 0, best effort), then start on the new one
    stop(): Promise<void>;                 // stop timers; TTL-0 announce, best effort, capped at 2 s
    readonly joined: boolean;              // the last announce succeeded
  }
  // test/fake-lighthouse.ts
  export async function startFakeLighthouse(options?: { hang?: boolean }): Promise<{ url: string; stop(): void; topics(): Map<string, Map<string, Peer>> }>;
  ```

- [ ] **Step 1: Write the fake lighthouse**

`Bun.serve` on `127.0.0.1:0`: `POST /v1/announce` decodes `payload` (base64url JSON), stores `{ addr, expiresAt }` under `(topic, addr.id)` (removes when `ttl_secs === 0`), answers `{ type: "announced", ttl_secs, peers }` where `peers` are the other unexpired entries as `{ addr, expires_in_secs }`; `POST /v1/lookup` answers `{ type: "peers", peers }` (all entries); `GET /v1/info` answers `{ type: "info", version: "fake", lighthouse: null, min_ttl_secs: 10, max_ttl_secs: 604800, max_peers_per_topic: 256 }`; `GET /v1/health` 200. No signature checks. With `hang: true`, every request is accepted and never answered. When run as a script (`import.meta.main`), it prints its URL and stays up.

- [ ] **Step 2: Write the failing tests**

```ts
test("address conversions round-trip", () => {
  const w = { id: A, relay: "https://r.example/", direct: ["127.0.0.1:1", "[::1]:2"] };
  expect(fromLighthouseAddr(toLighthouseAddr(w))).toEqual(w);
  expect(toLighthouseAddr(w).addrs).toEqual([{ Ip: "127.0.0.1:1" }, { Ip: "[::1]:2" }, { Relay: "https://r.example/" }]);
});
test("two nodes find each other through the lighthouse and connect without being given addresses", async () => {   // 15_000
  // fake lighthouse; two pool nodes (twoNodes with offerAddress disabled) sharing a PoolIdentity, pollMs 1000
  // Discovery.onPeers → net.offerAddress for each; until both nets report the other online
  // topics() has exactly topicFor(pool).id with both ids; stop both discoveries → that topic is empty
});
test("an unreachable lighthouse does not stop the node and is retried; a hanging one times out", async () => {
  // lighthouseUrl "http://127.0.0.1:1", backoff {initialMs: 50, maxMs: 100}: start() returns at once; after 300 ms joined is false and onError was called exactly once (one distinct message)
  // swap lighthouseUrl to a fresh fake; until joined
  // a second Discovery against startFakeLighthouse({ hang: true }) with requestTimeoutMs 200: after 600 ms joined is false and onError was called once with a message containing "timed out"
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `bun test test/discovery.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement**

- `topicFor`: `Topic.withSecret(\`meddle/${poolId}\`, poolSecret)`.
- A `Lighthouse` is built per request from `deps.lighthouseUrl()` with `{ fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) }) }`; a timeout surfaces as an error whose message contains `timed out`.
- `start`: an announce loop: `lighthouse.announce(NodeKey.fromBytes(identity.secret), topicFor(pool), toLighthouseAddr(fromEndpoint(endpoint)), ANNOUNCE_TTL_SECS)`; success → `joined = true`, publish peers (filter self, `fromLighthouseAddr`, notify only on change), schedule the next announce at half the granted TTL (at least 1 s), reset backoff; failure → `joined = false`, `onError` (deduplicated per message, once a minute), retry after backoff. A poll loop (`lookup`) every `pollMs` while joined; failures are silent. `endpoint.watchAddr(...)` → when the address differs, announce now. Do not wait for `endpoint.online()`.
- `restart(pool)`: TTL-0 announce on the old topic (best effort), swap the pool, start again.
- `stop()`: stop timers and the watcher; TTL-0 announce capped at 2 s.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/discovery.test.ts`, `bun test`, `bun run typecheck`. Expected: pass.

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat: lighthouse discovery announces the pool topic and feeds peer addresses"
```

---

### Task 5: Invite and join

**Files:**
- Create: `src/pool/invite.ts`
- Test: `test/invite.test.ts`

**Interfaces:**
- Consumes: `PoolStore`, `Endpoint`, `Identity`, `frames.ts`, `fromEndpoint`, `toEndpointAddr`, `NodeSummary`, `TokenMeta`.
- Produces:
  ```ts
  export type Ticket = { v: 1; code: string; inviter: WireAddr };
  export const TICKET_PREFIX = "meddle1";
  export function encodeTicket(ticket: Ticket): string;
  export function decodeTicket(text: string): Ticket;      // throws "not a meddle invite ticket"
  export function createInvite(store: PoolStore, endpoint: Endpoint): string;
  export type JoinRequest = { t: "join"; code: string; addr: WireAddr; hostname: string; version: string; claudeCodeVersion: string };
  export type JoinReply =
    | { t: "welcome"; pool: { id: string; secret: string }; roster: RosterRow[]; token: TokenMeta | null }
    | { t: "refused"; reason: string };
  export type JoinHostDeps = { store: PoolStore; selfId: string; cfg: NodeConfig; onAdmitted(nodeId: string, addr: WireAddr): void };
  /** Serves one connection on ALPN_JOIN: reads one request line (≤ 4 KiB) from its first stream, answers, waits for the joiner to close (≤ 5 s), then closes. */
  export async function handleJoin(conn: Connection, deps: JoinHostDeps): Promise<void>;
  export type JoinDeps = { endpoint: Endpoint; store: PoolStore; identity: Identity; summary(): NodeSummary | Promise<NodeSummary>; timeoutMs?: number };
  /** Joins the pool a ticket names. Rejects when this node already has other members, or the inviter refuses. */
  export async function joinPool(ticket: Ticket, deps: JoinDeps): Promise<{ poolId: string; members: number; addrs: WireAddr[] }>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test("tickets encode and decode; junk is refused", () => {
  const t = { v: 1, code: "c", inviter: { id: A, relay: null, direct: ["127.0.0.1:1"] } };
  const text = encodeTicket(t);
  expect(text.startsWith("meddle1")).toBe(true);
  expect(decodeTicket(text)).toEqual(t);
  expect(text).not.toContain("secret");
  expect(() => decodeTicket("meddle1!!!")).toThrow("not a meddle invite ticket");
  expect(() => decodeTicket("hello")).toThrow("not a meddle invite ticket");
});
test("a node joins with a ticket and both rosters agree", async () => {
  // A (pool of one) and B (pool of one, another pool); A's net serves ALPN_JOIN with handleJoin
  // run the handshake 5 times with fresh B stores to shake out a lost welcome: each time
  // ticket = createInvite(A.store, A.endpoint); const joined = await joinPool(decodeTicket(ticket), B deps)
  // → B.store.pool() has A's poolId and poolSecret; both rosters list A and B as members with hostnames; B's row addedBy A, lastAddr === B's fromEndpoint
  // → A's onAdmitted was called with (B.id, B's addr); joined.addrs contains A's addr
});
test("a wrong code is refused and a used ticket is refused for the next node", async () => {
  // bad code → rejects "refused: unknown or expired invite"
  // C (a third fresh node) joining with B's used ticket → rejects with the same reason
});
test("a node already in a pool with others refuses to join", async () => {
  // B's roster has a member C → joinPool rejects "already in a pool with 1 other node; remove it first"; A's handler never runs
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/invite.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

- `createInvite`: `store.createInvite()` → ticket with `fromEndpoint(endpoint)`.
- `handleJoin`: `conn.acceptBi()` with a 5 s timeout; `readLine(4096)`; parse `JoinRequest`; `store.consumeInvite(code)` false → `refused` with reason `unknown or expired invite`; else upsert `{ nodeId: hexOf(conn.remoteId()), hostname, status: "member", updatedAt: now, addedBy: selfId, summary: { hostname, version, claudeCodeVersion, hostsTasks: false, taskCount: 0 }, lastSeenAt: now, lastAddr: request.addr }`, reply `welcome` with the pool id and secret, the full roster (the self row refreshed with `lastAddr: fromEndpoint`) and `tokenStatus` metadata; `send.finish()`; `onAdmitted(id, addr)`; then `await Promise.race([conn.closed(), 5 s])` and `conn.close(0n, "bye")`. Nothing in the request or reply is logged.
- `joinPool`: precondition on `store.members()` (others besides self → throw as specified); `endpoint.connect(toEndpointAddr(ticket.inviter), ALPN_JOIN)`; `openBi`; `writeLine(JoinRequest with addr: fromEndpoint(endpoint))`; `readLine` → `welcome` → `store.replacePool({ poolId, poolSecret, createdAt: now }, roster)`; `refused` → throw `refused: <reason>`; the joiner closes the connection (code 0) after reading; overall `timeoutMs` default 10 000. Returns the member count and every `lastAddr` in the roster plus `ticket.inviter`, for the caller to offer to its net.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/invite.test.ts`, `bun test`, `bun run typecheck`. Expected: pass.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat: invite tickets and the join handshake"
```

---

### Task 6: The pool runtime and the node host

**Files:**
- Create: `src/pool/runtime.ts`
- Modify: `src/state/host.ts`, `src/state/contracts.ts` (`NodeObject`/`NodeStore` gain `nodeId`), `test/helpers.ts` (`setupNode(fixture?, extraEnv?)`), `test/state.test.ts`, `test/ws-shim.test.ts` (both construct the host with a pool runtime)
- Test: `test/pool-state.test.ts`, `test/pool-helpers.ts` (extend)

**Interfaces:**
- Consumes: everything from Tasks 1 to 5; `createNodeHost`.
- Produces:
  ```ts
  // runtime.ts
  export type PoolRuntime = {
    readonly identity: Identity; readonly store: PoolStore; readonly net: PoolNet; readonly endpoint: Endpoint;
    readonly objectDeps: PoolObjectDeps;     // what servePool needs; createNodeHost passes it on
    invite(): string;
    join(ticket: string): Promise<{ poolId: string; members: number }>;
    remove(nodeId: string): Promise<void>;   // rejects "a node cannot remove itself"
    tokenChanged(): Promise<void>;
    onChange(cb: () => void): () => void;
    stop(): Promise<void>;
  };
  export type PoolSummaryDeps = { version: string; claudeCodeVersion: string; hostsTasks(): Promise<boolean>; taskCount(): number };
  export async function startPool(cfg: NodeConfig, db: Database, summary: PoolSummaryDeps): Promise<PoolRuntime>;
  // host.ts: NodeHostDeps gains `pool: PoolRuntime`; createNodeHost calls servePool(host, pool.objectDeps) and
  // acceptPeerLinks(pool.net, host, (id) => pool.store.isMember(id)); NodeObject.token refreshes on pool changes too.
  ```

- [ ] **Step 1: Write the failing tests**

`test/helpers.ts`: `setupNode(fixture = "hello.jsonl", extraEnv: Record<string, string> = {})` merges `extraEnv` into the env `loadConfig` reads. `test/pool-helpers.ts`, add `startPoolNode(fixture?)`: `setupNode(fixture, { MEDDLE_IROH_PRESET: "minimal", MEDDLE_IROH_BIND: "127.0.0.1:0", MEDDLE_LIGHTHOUSE_URL: "" })` plus `startPool` and `createNodeHost({ ..., pool })`, and `linkClient(host)` (memory link pair with a client host, as `test/state.test.ts`'s `connect` does).

`test/pool-state.test.ts` (each test `15_000`):
```ts
test("PoolObject shows a pool of one, invites, and a joined node appears online on both", async () => {
  // A, B pool nodes with hosts and clients
  // poolA.self === A.identity.id; poolA.nodes has one row (A, online, hostname, version VERSION, claudeCodeVersion "2.1.314", hostsTasks true, taskCount 0)
  // nodeA.nodeId.value === A.identity.id
  // { ticket } = await poolA.invite({}); await poolB.join({ ticket }) → { poolId: poolA.poolId.value, members: 2 }
  // until(poolA.nodes, n => n.some(r => r.nodeId === B.id && r.online)); same on B for A
  // A.store.pool().poolSecret === B.store.pool().poolSecret; poolA.mixedVersions.value === false
});
test("tokenChanged replicates the token; remove propagates and the removed node is cut off", async () => {
  // after joining: await setToken(A.cfg, "tok2", { setBy: A.id }); await poolA.tokenChanged({})
  // → until(poolB.token, t => t.setBy === A.id); getToken(B.cfg) === "tok2"; setAt equal on both; nodeB.token.value.expiresAt equals poolB.token.value.expiresAt
  // await poolA.remove({ nodeId: B.id }) → until(poolA.nodes, row B removed && !online); until(poolB.nodes, row B status removed) (B learnt it); B.net.online() is empty
  // poolA.remove({ nodeId: A.id }) rejects "a node cannot remove itself"
});
test("a member that did not do the removing also cuts the removed node off", async () => {
  // A, B, C: B and C join A; until all three see three online members
  // A removes C → until B.store.row(C).status === "removed" and !B.net.isOnline(C) and !C.net.isOnline(B)
  // C's PoolObject shows itself removed; a new invite from A lets C join again (C's precondition passes because it is removed)
});
```

`test/state.test.ts` and `test/ws-shim.test.ts`: construct the host through `startPoolNode`/with a pool; the existing assertions keep passing.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/pool-state.test.ts test/state.test.ts test/ws-shim.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

- `startPool`: identity → endpoint → store (`ensurePool` with `hostname()`; `seen(self, now, liveSummary, fromEndpoint(endpoint))`) → `PoolNet` (`isMember` from the store; `onJoin` → `handleJoin` with `onAdmitted(id, addr)` → `net.watch(id)`, `net.offerAddress(addr)`, notify) → `PoolSync` (`onChange` → `enforce()` + notify) → `Discovery` when `cfg.lighthouseUrl !== ""` (`onPeers` → `offerAddress` for members only; `onError` → `console.error(\`meddle: discovery: ${message}\`)`) → for every member but self: `watch` and `offerAddress(row.lastAddr)` when present → `start` all. `enforce()`: for every roster row that is not `member`, `net.unwatch(id, "removed")`; if the self row is not `member`: unwatch everyone, `discovery?.stop()`, notify. `net.onError` with a `removed` refusal from a node the store lists as `member` → `store.remove(selfId)` + `enforce()`.
- `invite` → `createInvite`. `join` → `joinPool` → `discovery?.restart(store.pool())` → `watch` + `offerAddress` for the new members and the returned addrs → notify. `remove(id)`: `store.remove(id)`; notify (the roster cell updates and chord sends the removal to the removed node's held reference); `await Promise.race([peer's connection closed, 1 s])`; `enforce()`. `tokenChanged`: `sync.refreshSelf()` (the `token` cell re-reads `tokenStatus`) and notify.
- `host.ts`: `servePool(host, pool.objectDeps)`; `acceptPeerLinks`; `NodeStore`/`NodeObject` `nodeId`; the token cell also refreshes on `pool.onChange`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/pool-state.test.ts test/state.test.ts test/ws-shim.test.ts`, `bun test`, `bun run typecheck`. Expected: pass.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat: pool runtime with enforced membership, served by the node host"
```

---

### Task 7: The dashboard tunnel

**Files:**
- Create: `src/dashboard/tunnel.ts`
- Modify: `src/dashboard/server.ts`
- Test: `test/tunnel.test.ts`

**Interfaces:**
- Consumes: `PoolNet`, `PoolRuntime`, `PeerStream`, `frames.ts`, chord `webSocketLink`, `WebSocketLike`, `BunSocketShim`.
- Produces:
  ```ts
  // tunnel.ts
  /** A `WebSocketLike` over a PeerStream: frames in are messages, `send` writes frames (serialised), `close` finishes the stream. */
  export class IrohSocketShim implements WebSocketLike {
    constructor(stream: PeerStream);
    start(): void;        // the read loop; dispatches "message" per frame and "close" once at EOF, error or `stream.closed`
  }
  /** Accepts every `dashboard` stream a member opens as a browser-grade link on `host`. Returns the unsubscribe. */
  export function acceptDashboardStreams(net: PoolNet, host: Host, isMember: (id: string) => boolean): () => void;
  /** Pipes a browser's socket to a `dashboard` stream on `peerId` until either side closes. */
  export async function bridgeSocket(socket: BunSocketShim, net: PoolNet, peerId: string): Promise<void>;
  // server.ts
  export async function startDashboard(cfg: Pick<NodeConfig, "port">, host: Host, pool?: PoolRuntime): Promise<Dashboard>;
  ```
  Route `/ws/node/<id>`: `id === pool.identity.id` → as `/ws`; `pool.store.row(id)?.status !== "member"` → 404 `unknown node`; `!pool.net.isOnline(id)` → 503 `node offline`; else upgrade and `bridgeSocket`. `trusted()` applies as to `/ws`. Without `pool`, the route answers 404.

- [ ] **Step 1: Write the failing tests**

`test/tunnel.test.ts` (each test `15_000`):
```ts
test("a browser reaches a remote node's objects through the tunnel", async () => {
  // A and B pool nodes (joined, online), hosts; startDashboard(A.cfg port 0, A.host, A.pool); acceptDashboardStreams on both
  // new WebSocket(`ws://127.0.0.1:${port}/ws/node/${B.id}`) → chord client host → get(NodeObject, {}) → nodeId.value === B.id
  // PoolObject.self over the same socket === B.id; createTask over it creates a task on B (B.runner.state(id) === "idle")
  // close the browser socket → B's shim dispatched close once (expose a counter through a test tap or spy); a fresh socket to the same path gets NodeObject again
});
test("unknown, removed and offline nodes fail fast; the tunnel path is gated like /ws", async () => {
  // GET `${url}ws/node/${"0".repeat(64)}` with WebSocket upgrade headers → 404 "unknown node"
  // after A.pool.remove(B): → 404 "unknown node"
  // with a third node C joined and then its net stopped: `/ws/node/${C.id}` → 503 "node offline" within 1 s
  // an upgrade to `/ws/node/<B>` with Origin http://evil.example → 403; with Host other.example:<port> → 403 (as test/ws-shim.test.ts does for /ws)
});
test("the tunnel carries binary frames both ways", async () => {
  // through bridgeSocket + IrohSocketShim directly: a 1 MiB binary message from each side arrives intact with the right kind
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/tunnel.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

- `IrohSocketShim`: `readyState` 1 while open, 3 after close; `send(string)` → `writeFrame(0, utf8)`, `send(Uint8Array)` → `writeFrame(1, bytes)`, serialised through one promise chain; `close()` → finish the send stream and dispatch close once; listeners as `BunSocketShim`'s; the read loop races `readFrame()` against `stream.closed` and dispatches `{ data: string }` for kind 0 and `{ data: Uint8Array }` for kind 1.
- `acceptDashboardStreams`: `net.onStream` → `header.stream === "dashboard"` and `isMember(s.peerId)` → `const shim = new IrohSocketShim(s); host.accept(webSocketLink(shim, { compress: true, acceptPacked: false }), { principal: "local", kind: "client" }); shim.start();`; otherwise close the stream.
- `bridgeSocket`: `net.openStream(peerId, { stream: "dashboard" })`; browser `message` → `writeFrame(kind by type, bytes)` (serialised); stream frames → `socket.send(string | Uint8Array)`; browser close → finish the send stream; stream EOF, error or `closed` settling → `socket.close(1011, "tunnel closed")`.
- `server.ts`: the route; the socket data gains `peerId?: string`; `open` for a tunnelled socket calls `bridgeSocket` instead of `sockets.emitConnection`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/tunnel.test.ts`, `bun test`, `bun run typecheck`. Expected: pass.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat: tunnel dashboard links to other nodes over iroh"
```

---

### Task 8: Serve wiring and the CLI

**Files:**
- Modify: `src/cli.ts`, `README.md` (usage block only), `test/helpers.ts` (`startServe` parses the `node` line)
- Test: `test/pool-e2e.test.ts`, `test/cli.test.ts` (usage)

**Interfaces:**
- Consumes: `startPool`, `PoolObject`, `acceptDashboardStreams`, `startDashboard(cfg, host, pool)`, `shortId`, `loadOrCreateIdentity`.
- Produces: subcommands
  ```
  meddle invite                      prints one ticket line
  meddle join <ticket>               prints "joined pool <shortId(poolId)> with <n> nodes"
  meddle pool                        one line per roster node: "<shortId> <hostname> <online|offline|removed> meddle <v> claude <v> tasks <n>", self suffixed " (this node)"
  meddle token set [--file <path>]   writes the token file in the CLI process with setBy = this node's identity (loadOrCreateIdentity), then calls PoolObject.tokenChanged on the running node; prints "token set" either way (no node running is fine)
  meddle status                      adds "node <id>" (or "node (none yet)" when the key file is absent; status stays read-only) and "pool <poolId> members <n>" lines (read from the database)
  ```
  `serve` order: config, dirs, profile, plugins, task root check, db, harness, runner, metrics, **pool** (`startPool` with `hostsTasks` from `checkTaskRoot` and `taskCount` from `listTasks`), host (`createNodeHost({ ..., pool })`), `host.ready()`, `acceptDashboardStreams(pool.net, host, isMember)`, `startDashboard(cfg, host, pool)`; prints `node <id>` then `dashboard at <url>`. Shutdown: dashboard, tunnel acceptor, pool, metrics, harness, host, db.

- [ ] **Step 1: Write the failing tests**

`test/cli.test.ts`: the usage text lists `invite`, `join <ticket>` and `pool`.

`test/pool-e2e.test.ts` (`60_000`):
```ts
test("two nodes form a pool: invite, join, replicate the token, and tunnel a dashboard link", async () => {
  // fake lighthouse; two homes with env { MEDDLE_IROH_PRESET: "minimal", MEDDLE_IROH_BIND: "127.0.0.1:0", MEDDLE_LIGHTHOUSE_URL: url, MEDDLE_DISCOVERY_POLL_MS: "1000", MEDDLE_PORT: "0" } plus the Plan 1 replayer env
  // startServe both (startServe also captures the "node <id>" line → node.id)
  // A: meddle invite → ticket; B: meddle join <ticket> → stdout "joined pool … with 2 nodes"
  // poll `meddle pool` on A until a line for shortId(B) says online; the self line ends with "(this node)"
  // A: token set --file → B: poll `token status` until present; setAt equal on both
  // WebSocket to A `/ws/node/<B>`: chord client NodeObject.nodeId === B
  // stop both: exit 0, stderr empty
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/cli.test.ts test/pool-e2e.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

As specified. `token set`: `ensureDataDirs`, `loadOrCreateIdentity`, `setToken(cfg, input, { setBy: identity.id })`, then `withNode(pool.tokenChanged)` and swallow `NoNode`. `startServe` in `test/helpers.ts` additionally parses `^node ([0-9a-f]{64})$`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/cli.test.ts test/pool-e2e.test.ts`, `bun test`, `bun run typecheck`. Expected: pass.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat: serve joins the pool; invite, join and pool subcommands"
```

---

### Task 9: The dashboard shows the pool

**Files:**
- Create: `src/dashboard/ui/routes.ts`
- Modify: `src/dashboard/ui/main.tsx`, `src/dashboard/ui/Pool.tsx`, `src/dashboard/ui/Settings.tsx`, `src/dashboard/ui/Task.tsx`, `src/dashboard/ui/hooks.ts`, `src/dashboard/ui/index.html` (styles for cards and badges)
- Test: `test/ui.test.ts`

**Interfaces:**
- Consumes: `PoolObject` (default variant), `NodeObject.nodeId`, `/ws/node/<id>`.
- Produces:
  ```ts
  // routes.ts
  export type View = { name: "pool" } | { name: "task"; nodeId: string; id: string } | { name: "projects" } | { name: "settings" };
  export function viewOf(hash: string): View;    // #/task/<nodeId>/<taskId>; anything else it does not recognise is the pool
  export function hashOf(view: View): string;
  // hooks.ts
  /** One client host per node, created on first use over `/ws/node/<nodeId>` and dropped when its socket closes. */
  export class Hosts { constructor(selfId: string, selfHost: Host); for(nodeId: string): Host; onClose(cb: (nodeId: string) => void): () => void; }
  // Pool.tsx
  export function Pool({ hosts, pool, open }): a card per `pool.nodes` row (members; removed ones greyed, no controls): hostname, shortId with the full id in `title`,
    online badge, versions (flagged when they differ from this node's), token, resources and tasks from the live NodeObject when online, from the summary otherwise;
    a "New task" form with a node picker over online members with hostsTasks, creating through that node's host
  // Settings.tsx
  pool section: this node (shortId, hostname), pool id, members table (full ids) with Remove buttons, Invite (shows the ticket in a read-only textarea),
    Join (textarea + button; disabled when the pool has other members); token metadata (setBy's hostname, set at, expires). No token input: the CLI sets it.
  // Task.tsx
  export function Task({ host, node, taskId }) unchanged; main.tsx passes `hosts.for(nodeId)` and that node's NodeObject
  // Notifications: merged from every online node's NodeObject, newest first; `open` carries the node id
  ```

- [ ] **Step 1: Write the failing tests**

`test/ui.test.ts`:
```ts
test("the dashboard bundle builds", async () => {
  const build = await Bun.build({ entrypoints: ["src/dashboard/ui/main.tsx"], target: "browser", format: "esm" });
  expect(build.success).toBe(true);
});
test("viewOf and hashOf round-trip the pool routes", () => {
  expect(viewOf("#/task/abc/t1")).toEqual({ name: "task", nodeId: "abc", id: "t1" });
  expect(hashOf({ name: "task", nodeId: "abc", id: "t1" })).toBe("#/task/abc/t1");
  expect(viewOf("#/task/t1")).toEqual({ name: "pool" });          // the Plan 1 shape no longer resolves
  expect(viewOf("#/settings")).toEqual({ name: "settings" });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/ui.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

As specified. Keep the Plan 1 component internals; thread `hosts` and `pool` down. The connected node's id comes from `PoolObject.self` on the `/ws` host. Offline cards show the summary with a "last seen" time and no controls.

- [ ] **Step 4: Verify in a browser-less way and in a browser**

Run: `bun test test/ui.test.ts`, `bun test`, `bun run typecheck`. Then start two nodes by hand with the fake lighthouse (`bun run test/fake-lighthouse.ts` prints its URL when run as a script) and open the first's dashboard: both cards show, the second's task can be opened from the first's dashboard, Settings shows the roster. Record what was seen in the task report.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat: the dashboard shows every node and opens tasks across the pool"
```

---

### Task 10: README, build and the service unit

**Files:**
- Modify: `README.md`, `install/meddle.service` (a comment on the iroh UDP socket, if anything)
- Test: `test/service.test.ts` (unchanged), manual build check

- [ ] **Step 1: Document**

README gains a "Pool" section: identity and node ids, `meddle invite` / `meddle join`, the lighthouse (default URL, `MEDDLE_LIGHTHOUSE_URL=` to disable), that connections are only accepted from roster members and a removed node is cut off by every member, that the dashboard of any node shows every node and opens their tasks through the pool, `meddle pool`, `token set` replicating (pull over iroh, never over the loopback socket), removal semantics (decision 8), and the environment variables (`MEDDLE_IROH_PRESET`, `MEDDLE_IROH_BIND`, `MEDDLE_DISCOVERY_POLL_MS`). Note that the compiled binary embeds the iroh module (about 40 MB larger) and reports its Claude Code version as `unknown`, which the pool's mixed-version flag shows.

- [ ] **Step 2: Verify the build**

Run: `bun run build` and `dist/meddle --version` from another directory; expected the version line. Run `dist/meddle status` with a temp `MEDDLE_DATA_DIR` and expect the `node (none yet)` line.

- [ ] **Step 3: Full verification**

Run: `bun test` and `bun run typecheck`. Expected: all pass, typecheck clean.

- [ ] **Step 4: Commit**

```bash
jj commit -m "docs: pool, discovery and invite in the README"
```

---

## Self-review notes

- Spec coverage: section 6 identity (Task 1), closed roster and invitation (Tasks 1, 5, 6), lighthouse discovery with the pool topic and secret (Task 4), transport over iroh with a member-only ALPN (Task 2), chord frames between hosts over an iroh link (Task 3), state replication (Tasks 3, 6), browsers seeing the whole pool (Tasks 7, 9); section 11 token as pool state set from any node, pulled inside encrypted streams, never on a command line or a loopback socket (Tasks 3, 6, 8); section 12 Pool view with one card per node, online, versions, token, resources, tasks, new task on a node (Task 9), notifications in every dashboard (Task 9); section 13 Pool object (Tasks 3, 6); section 15 closed roster with enforced removal, iroh encryption, localhost dashboard (Tasks 2, 6, 7). Moves, repo sync, budgets, `meddle update`, the mixed-version move refusal and `prewarm` are Plans 3 and 4.
- Names used across tasks: `PoolStore`, `RosterRow`, `WireAddr`, `NodeSummary`, `PoolIdentity`, `Identity`, `shortId`, `isNodeId`, `hexOf`, `endpointIdOf`, `PoolNet` (with `endpoint`, `unwatch(id, reason)`), `PeerStream` (with `closed`), `StreamReader` (`readLine(max)`), `writeLine`, `writeFrame`, `ALPN_POOL`, `ALPN_JOIN`, `IrohLink`, `LinkTap`, `servePool`, `PoolObjectDeps`, `peerOf`, `PoolSync`, `acceptPeerLinks`, `TokenMeta`, `Discovery`, `topicFor`, `fromEndpoint`, `toEndpointAddr`, `remoteAddrOf`, `createInvite`, `handleJoin`, `joinPool`, `decodeTicket`, `startPool`, `PoolRuntime`, `PoolObject`, `IrohSocketShim`, `acceptDashboardStreams`, `bridgeSocket`, `Hosts`, `viewOf`, `hashOf`.
- Review Focus items 1 to 5 are pinned in Tasks 1, 2 and 6, 3, 4 and 7.
