# Attachments on prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paste, drop or pick files in the dashboard's composer and New Task form; Claude gets images inline and every
file as a path, and the files travel the pool by their SHA-256.

**Architecture:** A content-addressed `BlobStore` (`<data>/blobs/<sha256>`) per node; the browser uploads to its own
node over `PUT /blobs`; a prompt carries `Attachment` refs, and a node fetches a blob it lacks over a pool stream
(`{ stream: "blob", kind: "file", hash }`). The runner turns a prompt's refs into image blocks plus files under
`<task>/.meddle/attachments/<hash>/<name>` when it hands the prompt to Claude Code; everywhere else only refs are kept.

**Tech Stack:** TypeScript on bun, TypeBox schemas, chord objects, iroh pool streams (`src/pool/frames.ts`), preact UI.

**Spec:** `docs/superpowers/specs/2026-11-17-attachments-design.md`

## Global Constraints

- Tooling: `export PATH=$HOME/.bun/bin:$PATH` first; one file `bun test test/<file>.test.ts`; types `bun run typecheck`;
  the whole suite `bun test` (~4 min). Version control is jj: commit with `jj commit -m "<message>"`.
- Hash: SHA-256, 64 lowercase hex characters; anything else is refused wherever a hash comes in.
- Blob files: `<data>/blobs/<hash>`, directory mode 700, files 600; never deleted.
- At most 64 MB (`64 * 1024 * 1024` bytes) a file.
- Inline image types: `image/png`, `image/jpeg`, `image/gif`, `image/webp`; at most 5 MiB (`5 * 1024 * 1024`) of base64
  each; in attach order until the prompt's inline images reach 10 MiB (`10 * 1024 * 1024`) of base64 together.
- Attachment name: a base name; no `/`, no `\`, no leading `.`, not empty, at most 200 characters. A pasted image with
  no name is `pasted-<yyyymmdd-hhmmss>.<ext>`.
- Never bytes in meddle's own records: events, `tasks.queued`, durable turn input, chord state cells.
- Blob responses always carry `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`; only the four
  inline image types are served inline.
- Error copy: `attachment <name> is not on any online node`; `attachment <name> could not be fetched from <short id>`;
  `<host> runs a meddle that takes no attachments`; `a prompt needs text or an attachment`; `bad attachment: <why>`.
- Old data keeps reading: a `queued` entry that is a string is `{ text, attachments: [] }`; a durable turn input
  without `attachments` has none; a move frame's string `queued` entries are text-only prompts.
- Contracts change at version 1 as earlier additions did: `TaskObject.queued` stays `string[]` (texts) so older
  dashboards still connect, and the prompts with their attachments come in a new cell `queuedPrompts`. (Clarifying the
  spec: a newer dashboard cannot open a task on an older node at all, as with every cell added before, so the Task
  page needs no per-node gate; the New Task form, placement and moves do.)

## Review Focus

1. A file named `../../x`, `.bashrc`, `a/b.png` or 300 characters long, or a pasted image with no name: the browser
   cleans the name, and the node refuses one that is still bad; nothing is ever written outside
   `.meddle/attachments/<hash>/`. Tests: Task 1 `cleanName`, Task 6 refused prompt.
2. The same image twice in one prompt, or in two prompts: one blob, and writing its file again is harmless. Tests:
   Task 2 same bytes twice, Task 4 `materialize` twice.
3. An upload over 64 MB, or one cut off halfway: 413 or an error, and no temporary file is left behind. Tests: Task 2,
   Task 9.
4. A steer with an image as the turn ends: it is never lost; it waits for the next turn with its attachments. Test:
   Task 6.
5. A prompt that is only an image, no text: accepted; Claude gets the image and the "Attached files" lines; a blank
   prompt with no attachment is refused. Tests: Task 4, Task 8.

---

### Task 1: The attachment model

**Files:**
- Create: `src/blobs/attachment.ts`
- Test: `test/attachment.test.ts`

**Interfaces:**
- Produces (pure; the dashboard imports it too, so typebox only, no node APIs):
  - `AttachmentSchema = Type.Object({ hash: Type.String(), name: Type.String(), type: Type.String(), size: Type.Number() })`, `type Attachment`
  - `PromptSchema = Type.Object({ text: Type.String(), attachments: Type.Array(AttachmentSchema) })`, `type Prompt`
  - `MAX_BLOB_BYTES`, `MAX_IMAGE_BASE64`, `IMAGE_BUDGET_BASE64`, `INLINE_IMAGE_TYPES: readonly string[]` (values above)
  - `isBlobHash(s: string): boolean`
  - `cleanName(name: string): string` — replaces `/` and `\` with `_`, drops leading dots, cuts to 200 characters
    keeping the extension, `file` when nothing is left
  - `pastedName(type: string, at: Date): string` — extension from the image type (`png`, `jpg`, `gif`, `webp`, else `bin`), local time
  - `attachmentProblem(a: unknown): string | null` — null for a valid `Attachment`, else why (`hash`, `name`, `size`)
  - `promptOf(entry: unknown): Prompt` — a string is `{ text, attachments: [] }`, a valid `Prompt` itself; throws `bad queued prompt` for anything else
  - `queueEntry(p: Prompt): string | Prompt` — the text alone when there are no attachments (an older meddle reads it)
  - `inlined(attachments: readonly Attachment[]): boolean[]` — per attachment, whether it goes as an image block
  - `base64Length(bytes: number): number` — `4 * Math.ceil(bytes / 3)`

- [ ] **Step 1: Write the failing tests**

```ts
const att = (over: Partial<Attachment> = {}): Attachment =>
  ({ hash: "a".repeat(64), name: "shot.png", type: "image/png", size: 1000, ...over });

test("a hash is 64 lowercase hex characters", () => {
  expect(isBlobHash("0f".repeat(32))).toBe(true);
  expect(isBlobHash("0F".repeat(32))).toBe(false);
  expect(isBlobHash("../" + "a".repeat(61))).toBe(false);
});
test("cleanName keeps a base name", () => {
  expect(cleanName("../../x")).toBe("_.._x");
  expect(cleanName(".bashrc")).toBe("bashrc");
  expect(cleanName("a/b.png")).toBe("a_b.png");
  expect(cleanName("...")).toBe("file");
  const long = cleanName("x".repeat(300) + ".png");
  expect(long.length).toBe(200);
  expect(long.endsWith(".png")).toBe(true);
});
test("pastedName names a clipboard image by its time", () => {
  expect(pastedName("image/png", new Date(2026, 10, 17, 9, 5, 3))).toBe("pasted-20261117-090503.png");
  expect(pastedName("image/jpeg", new Date(2026, 0, 2, 3, 4, 5))).toBe("pasted-20260102-030405.jpg");
});
test("attachmentProblem refuses what a node must not write", () => {
  expect(attachmentProblem(att())).toBeNull();
  expect(attachmentProblem(att({ hash: "zz" }))).not.toBeNull();
  for (const name of ["../x", ".bashrc", "a/b", "a\\b", "", "x".repeat(201)]) expect(attachmentProblem(att({ name }))).not.toBeNull();
  expect(attachmentProblem(att({ size: -1 }))).not.toBeNull();
  expect(attachmentProblem({ hash: "a".repeat(64) })).not.toBeNull();
});
test("a queue entry is a string for text alone, and either shape reads back", () => {
  expect(queueEntry({ text: "hi", attachments: [] })).toBe("hi");
  expect(promptOf("hi")).toEqual({ text: "hi", attachments: [] });
  const p = { text: "", attachments: [att()] };
  expect(promptOf(queueEntry(p))).toEqual(p);
  expect(() => promptOf({ text: 1 })).toThrow("bad queued prompt");
});
test("inlined takes supported images under 5 MiB of base64 until 10 MiB together", () => {
  const big = 3_500_000; // 4_666_668 base64
  expect(inlined([att({ size: big }), att({ size: big }), att({ size: big })])).toEqual([true, true, false]);
  expect(inlined([att({ size: 4_000_000 })])).toEqual([false]); // 5_333_336 base64
  expect(inlined([att({ type: "image/svg+xml" }), att({ type: "image/heic" }), att({ type: "text/plain" })])).toEqual([false, false, false]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/attachment.test.ts`
Expected: FAIL, `Cannot find module '../src/blobs/attachment'`.

- [ ] **Step 3: Implement `src/blobs/attachment.ts` with the interfaces above**

- [ ] **Step 4: Run them to see them pass**

Run: `bun test test/attachment.test.ts && bun run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit** — `jj commit -m "Model attachments: their refs, names and which go inline"`

### Task 2: The blob store

**Files:**
- Create: `src/blobs/store.ts`
- Modify: `src/paths.ts` (`blobs`, `taskAttachments`), `src/cli.ts:190` (sweep at serve start, beside `sweepArchiveTemps`)
- Test: `test/blob-store.test.ts`

**Interfaces:**
- Consumes: `isBlobHash` (Task 1), `ensurePrivateDir` (`src/paths.ts`).
- Produces:
  - `paths(cfg).blobs = join(data, "blobs")`; `paths(cfg).taskAttachments(taskId) = join(task(taskId), ".meddle", "attachments")`
  - `class BlobStore { constructor(dir: string); readonly dir: string; path(hash: string): string; has(hash: string): Promise<boolean>; write(chunks: AsyncIterable<Uint8Array>, options?: { maxBytes?: number; expect?: { hash: string; size: number } }): Promise<{ hash: string; size: number }>; sweepTemps(): Promise<number> }`
  - `path` throws `not a blob hash: <s>`; `write` rejects `blob exceeds <maxBytes> bytes` or `blob does not match <hash>`,
    removing its temporary file either way; temporary files are `.tmp-<uuid>` in `dir`.

- [ ] **Step 1: Write the failing tests**

```ts
async function* chunks(...parts: string[]) { for (const p of parts) yield new TextEncoder().encode(p); }
const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

test("a blob is stored under its hash, once", async () => {
  const store = new BlobStore(join(await mkdtemp("/tmp/blobs-"), "blobs"));
  const a = await store.write(chunks("hel", "lo"));
  expect(a).toEqual({ hash: sha("hello"), size: 5 });
  expect(await store.write(chunks("hello"))).toEqual(a);
  expect(await readFile(store.path(a.hash), "utf8")).toBe("hello");
  expect((await readdir(store.dir)).sort()).toEqual([a.hash]);
  expect((await stat(store.dir)).mode & 0o777).toBe(0o700);
  expect((await stat(store.path(a.hash))).mode & 0o777).toBe(0o600);
});
test("too large, or not what was expected: refused, nothing left", async () => {
  const store = new BlobStore(join(await mkdtemp("/tmp/blobs-"), "blobs"));
  await expect(store.write(chunks("12345", "6"), { maxBytes: 5 })).rejects.toThrow("blob exceeds 5 bytes");
  await expect(store.write(chunks("hello"), { expect: { hash: sha("other"), size: 5 } })).rejects.toThrow(`blob does not match ${sha("other")}`);
  expect(await readdir(store.dir)).toEqual([]);
});
test("a stream that fails halfway leaves no temporary file", async () => {
  const store = new BlobStore(join(await mkdtemp("/tmp/blobs-"), "blobs"));
  async function* broken() { yield new Uint8Array([1]); throw new Error("cut off"); }
  await expect(store.write(broken())).rejects.toThrow("cut off");
  expect(await readdir(store.dir)).toEqual([]);
});
test("path refuses what is not a hash; sweepTemps removes what a crash left", async () => {
  const store = new BlobStore(join(await mkdtemp("/tmp/blobs-"), "blobs"));
  expect(() => store.path("../etc")).toThrow("not a blob hash: ../etc");
  await mkdir(store.dir, { recursive: true });
  await writeFile(join(store.dir, ".tmp-x"), "partial");
  expect(await store.sweepTemps()).toBe(1);
  expect(await readdir(store.dir)).toEqual([]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/blob-store.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `BlobStore` and the two paths**

Hash with `Bun.CryptoHasher("sha256")` as bytes are written to the temporary file (`open(..., "wx", 0o600)`), then
`rename` into place; when the target exists already, drop the temporary file instead. `has` on a bad hash is `false`.
In `serve` (`src/cli.ts`), call `new BlobStore(paths(cfg).blobs).sweepTemps()` next to `sweepArchiveTemps(cfg)`.

- [ ] **Step 4: Run them to see them pass**

Run: `bun test test/blob-store.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit** — `jj commit -m "Store uploaded files by their hash"`

### Task 3: Blobs between nodes

**Files:**
- Create: `src/blobs/pool.ts`
- Modify: `src/tasks/blob.ts` (take `kind: "file"` too), `src/tasks/durable.ts` (constructor: own a `BlobFetcher`),
  `src/cli.ts:222` (`acceptBlobStreams(pool.net, runner, runner.blobs.store)`)
- Test: `test/blob-pool.test.ts`

**Interfaces:**
- Consumes: `BlobStore` (Task 2); `PoolNet.online()`, `PoolNet.openStream()`, `PeerStream`, `writeFrame`, `StreamReader.readFrame` (`src/pool/net.ts`, `src/pool/frames.ts`).
- Produces:
  - `serveBlob(s: PeerStream, store: BlobStore): Promise<void>` — answers one kind-0 JSON frame, `{ size }` or
    `{ missing: true }` (also for a bad hash), then the bytes as kind-1 frames of at most 1 MiB, then finishes.
  - `class BlobFetcher { constructor(store: BlobStore, net: Pick<PoolNet, "online" | "openStream"> | null); readonly store: BlobStore; ensure(hash: string, prefer?: string): Promise<boolean> }`
    — true when the blob is here or was fetched (from `prefer` first, if online, then each other online member in
    turn, checked with `store.write(..., { expect })`); false when none has it. A peer that resets, says missing, or
    sends bytes that do not match counts as not having it. Concurrent `ensure`s of one hash share one fetch.
  - `acceptBlobStreams(net: PoolNet, runner: Pick<TaskRunner, "importIncoming">, store: BlobStore): () => void`
  - `TaskRunner.blobs: BlobFetcher` (public, readonly), made in the constructor from `paths(cfg).blobs` and `deps.pool?.net ?? null`.

- [ ] **Step 1: Write the failing tests**

Use `twoNodes()` from `test/pool-helpers.ts` (two linked `PoolNet`s, as `test/net.test.ts` does), each with its own
`BlobStore` and `acceptBlobStreams(net, { importIncoming: async () => { throw new Error("no") } }, store)`.

```ts
test("a node fetches a blob another node has, and says false when none has it", async () => {
  const { a, b } = await twoNodes();           // PoolNodes `a`, `b`, each with `.net`
  const sa = new BlobStore(join(dirA, "blobs")), sb = new BlobStore(join(dirB, "blobs"));
  const { hash } = await sb.write(chunks("x".repeat(3 * 1024 * 1024)));   // three 1 MiB frames
  const fetcher = new BlobFetcher(sa, a.net);
  expect(await fetcher.ensure(hash)).toBe(true);
  expect((await stat(sa.path(hash))).size).toBe(3 * 1024 * 1024);
  expect(await fetcher.ensure("0".repeat(64))).toBe(false);
});
test("two ensures of one hash fetch it once", async () => {
  // count `blob`/`file` streams b accepts with a wrapping onStream listener registered first (it returns false)
  const [x, y] = await Promise.all([fetcher.ensure(hash), fetcher.ensure(hash)]);
  expect([x, y]).toEqual([true, true]);
  expect(opened).toBe(1);
});
test("bytes that do not match the hash are not kept", async () => {
  // b answers `{ size: 5 }` and "wrong" for any hash, from its own onStream listener in place of serveBlob
  expect(await new BlobFetcher(sa, a.net).ensure(sha("right"))).toBe(false);
  expect(await readdir(sa.dir).catch(() => [])).toEqual([]);
});
test("without a pool, ensure answers only from the store", async () => {
  expect(await new BlobFetcher(sa, null).ensure("0".repeat(64))).toBe(false);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/blob-pool.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/blobs/pool.ts`, extend `acceptBlobStreams`, give `TaskRunner` its `blobs`**

`acceptBlobStreams`: `kind === "file"` and a string `hash` → `void serveBlob(s, store).catch(() => reset(s))`; `kind`
`"task"` as today; anything else reset.

- [ ] **Step 4: Run them to see them pass**

Run: `bun test test/blob-pool.test.ts test/move.test.ts && bun run typecheck`
Expected: PASS (moves still take `kind: "task"`).

- [ ] **Step 5: Commit** — `jj commit -m "Fetch a missing file from the pool by its hash"`

### Task 4: What Claude Code is sent

**Files:**
- Create: `src/blobs/content.ts`
- Modify: `src/engine/options.ts` (`buildOptions`: `additionalDirectories`)
- Test: `test/blob-content.test.ts`, `test/options.test.ts`

**Interfaces:**
- Consumes: `BlobStore` (Task 2), `inlined`, `Prompt`, `Attachment` (Task 1), `paths(cfg).taskAttachments` (Task 2).
- Produces:
  - `type UserContent = SDKUserMessage["message"]["content"]` (from `@anthropic-ai/claude-agent-sdk`)
  - `materialize(store: BlobStore, dir: string, a: Attachment): Promise<string>` — the file's path,
    `<dir>/<hash>/<name>`: a hard link to the blob, a copy when linking fails (another filesystem); an existing file is
    kept. Throws `attachment <name> is not here` when the store lacks the blob.
  - `promptContent(store: BlobStore, dir: string, prompt: Prompt): Promise<UserContent>` — `prompt.text` itself when
    there are no attachments; else the inlined images as image blocks, in order, then one text block.
  - The text block, exactly: the prompt's text, a blank line, then `Attached files:` and one `- <name>: <path>` line
    per attachment; with blank text, the `Attached files:` lines alone.
  - `buildOptions` sets `additionalDirectories: [paths(i.cfg).taskAttachments(i.manifest.id)]`.

- [ ] **Step 1: Write the failing tests**

```ts
test("images go inline, every file goes as a path", async () => {
  const store = new BlobStore(join(home, "blobs"));
  const png = await store.write(chunks(PNG_BYTES));        // a few bytes are enough; nothing decodes them
  const log = await store.write(chunks("line\n"));
  const dir = join(home, "task", ".meddle", "attachments");
  const shot = { hash: png.hash, name: "shot.png", type: "image/png", size: png.size };
  const text = { hash: log.hash, name: "server.log", type: "text/plain", size: log.size };
  const content = await promptContent(store, dir, { text: "look", attachments: [shot, text] });
  expect(content).toEqual([
    { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(PNG_BYTES).toString("base64") } },
    { type: "text", text: `look\n\nAttached files:\n- shot.png: ${dir}/${png.hash}/shot.png\n- server.log: ${dir}/${log.hash}/server.log` },
  ]);
  expect(await readFile(`${dir}/${log.hash}/server.log`, "utf8")).toBe("line\n");
});
test("an image alone, no text, still says where its file is", async () => {
  const content = await promptContent(store, dir, { text: "  ", attachments: [shot] });
  expect((content as any[])[1]).toEqual({ type: "text", text: `Attached files:\n- shot.png: ${dir}/${png.hash}/shot.png` });
});
test("text alone stays a string; writing a file twice is harmless", async () => {
  expect(await promptContent(store, dir, { text: "hi", attachments: [] })).toBe("hi");
  const p = await materialize(store, dir, shot);
  expect(await materialize(store, dir, shot)).toBe(p);
});
test("a blob not in the store fails", async () => {
  await expect(materialize(store, dir, { ...shot, hash: "0".repeat(64) })).rejects.toThrow("attachment shot.png is not here");
});
```

In `test/options.test.ts`: `buildOptions(...)`'s `additionalDirectories` equals
`[paths(cfg).taskAttachments(manifest.id)]`.

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/blob-content.test.ts test/options.test.ts`
Expected: FAIL, module not found / `additionalDirectories` undefined.

- [ ] **Step 3: Implement `src/blobs/content.ts` and the option**

- [ ] **Step 4: Run them to see them pass**

Run: `bun test test/blob-content.test.ts test/options.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit** — `jj commit -m "Hand Claude Code a prompt's images inline and its files as paths"`

### Task 5: Turns carry prompts, not texts

**Files:**
- Modify: `src/engine/input.ts`, `src/engine/session.ts:104-106,125-160,261-266`
- Test: `test/engine.test.ts`

**Interfaces:**
- Consumes: `Prompt`, `Attachment` (Task 1), `UserContent` (Task 4).
- Produces:
  - `type Untaken = { uuid: string; prompt: Prompt }`
  - `InputQueue.push(prompt: Prompt, priority: "now" | "next" = "next", content: UserContent = prompt.text): string`
  - `InputQueue.take(uuid: string): Prompt | null`; `InputQueue.untaken(): Untaken[]`
  - `promptEvent(prompt: Prompt, uuid?: string): SDKUserMessage & { attachments?: Attachment[] }` — `message.content`
    stays the text (a string) as today; `attachments` only when there are some.
  - `RunTurnArgs.prompt: Prompt`; `RunTurnArgs.content?: UserContent` (what Claude Code is sent; default the text).

- [ ] **Step 1: Write the failing tests**

```ts
test("a pushed prompt is sent as its content and logged as its text and refs", async () => {
  const q = new InputQueue();
  const content = [{ type: "text" as const, text: "look\n\nAttached files:\n- a.png: /x" }];
  const uuid = q.push({ text: "look", attachments: [att] }, "next", content);
  const sent = (await q[Symbol.asyncIterator]().next()).value;
  expect(sent.message.content).toEqual(content);
  expect(q.untaken()).toEqual([{ uuid, prompt: { text: "look", attachments: [att] } }]);
  expect(q.take(uuid)).toEqual({ text: "look", attachments: [att] });
});
test("promptEvent keeps the text as content and adds the refs", () => {
  expect(promptEvent({ text: "look", attachments: [att] }, "u1")).toMatchObject({ message: { content: "look" }, attachments: [att], uuid: "u1" });
  expect("attachments" in promptEvent({ text: "hi", attachments: [] })).toBe(false);
});
```

Existing `runTurn` tests in `test/engine.test.ts` pass `prompt: { text: …, attachments: [] }` where they passed a string.

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/engine.test.ts`
Expected: FAIL (type and value mismatches).

- [ ] **Step 3: Change `input.ts` and `session.ts` to the interfaces above**

`runTurn` pushes `args.prompt` with `args.content`; a steer taken in `drive` is logged with `promptEvent(prompt, uuid)`.

- [ ] **Step 4: Run them to see them pass**

Run: `bun test test/engine.test.ts && bun run typecheck`
Expected: engine tests PASS; typecheck fails only in `src/tasks/durable.ts` (Task 6 fixes it).

- [ ] **Step 5: Commit** — `jj commit -m "Carry a prompt's attachments through a turn's input"`

### Task 6: The runner queues and runs prompts with attachments

**Files:**
- Modify: `src/store/records.ts:176-179` (`queuedOf`), `src/tasks/durable.ts` (`TurnInput` :63, `prompt` :462,
  `startQueued` :528, `queued` :553, `#enqueue`, `#enqueueNext`, `#requeueFront`, `#send` :574-600, `runTurnPhase`
  :765-835, `#engineInput` :2089)
- Test: `test/durable.test.ts`

**Interfaces:**
- Consumes: `BlobFetcher` as `this.blobs` (Task 3), `promptContent` (Task 4), `promptOf`, `queueEntry`,
  `attachmentProblem` (Task 1), `InputQueue`/`runTurn` (Task 5).
- Produces:
  - `queuedOf(row): Prompt[]`
  - `TurnInput = { taskId: string; prompt: string; attachments?: Attachment[]; freshAfter?: number }` (still `version: 1`)
  - `TaskRunner.prompt(taskId: string, text: string, attachments: Attachment[] = []): Promise<"turn" | "queued">` —
    first refuses `bad attachment: <why>` for an invalid one and `attachment <name> is not on any online node` when
    `this.blobs.ensure(hash)` is false; then as today, with the prompt in place of the text.
  - `TaskRunner.queued(taskId: string): Prompt[]`
  - `tasks.queued` entries are written with `queueEntry`; `startQueued` removes the first entry whose `promptOf` is
    deep-equal to the head it started.
  - `#send` builds the content first (`promptContent(this.blobs.store, paths(cfg).taskAttachments(taskId), p)`); if the
    live queue ended meanwhile, the prompt goes to `#enqueueNext` instead.
  - `runTurnPhase` sends `{ text: input.prompt, attachments: input.attachments ?? [] }` (the carry-on and token-retry
    texts have none) with its content, after making `taskAttachments(taskId)` (`mkdir -p`); untaken steers requeue with
    their attachments.

- [ ] **Step 1: Write the failing tests**

Helper: put a blob into `node.runner.blobs.store`, read the fake Claude Code's transcript first line from
`<taskConfig(id)>/projects/<primaryProjectId>/<sessionId>.jsonl` (`test/fake-claude/replay.ts` `transcribe`).

```ts
test("a prompt's image reaches Claude Code inline and its file as a path", async () => {
  const node = await setupNode();
  const m = await createTask(node, { title: "t", projectIds: [node.project.id] });
  const { hash, size } = await node.runner.blobs.store.write(chunks(PNG_BYTES));
  const shot = { hash, name: "shot.png", type: "image/png", size };
  expect(await node.runner.prompt(m.id, "look", [shot])).toBe("turn");
  await turnEnd(node.runner, m.id).idle;            // test/durable.test.ts's own helper (set up before prompting)
  const first = JSON.parse((await readFile(transcriptOf(node, m), "utf8")).split("\n")[0]!);
  const dir = paths(node.cfg).taskAttachments(m.id);
  expect(first.message.content[0]).toMatchObject({ type: "image", source: { media_type: "image/png" } });
  expect(first.message.content.at(-1).text).toBe(`look\n\nAttached files:\n- shot.png: ${dir}/${hash}/shot.png`);
  const logged = listEvents(node.db, m.id).map((e) => e.message).find((e: any) => e.type === "user");
  expect(logged).toMatchObject({ message: { content: "look" }, attachments: [shot] });
});
test("a prompt naming a blob no node has, or a bad name, is refused and nothing is queued", async () => {
  await expect(node.runner.prompt(m.id, "look", [{ ...shot, hash: "0".repeat(64) }])).rejects.toThrow("attachment shot.png is not on any online node");
  await expect(node.runner.prompt(m.id, "look", [{ ...shot, name: "../x" }])).rejects.toThrow("bad attachment:");
  expect(node.runner.queued(m.id)).toEqual([]);
});
test("a queue an older meddle wrote still reads, and attachments stay with their prompt", async () => {
  updateTask(node.db, m.id, { queued: JSON.stringify(["old", { text: "new", attachments: [shot] }]) });
  expect(node.runner.queued(m.id)).toEqual([{ text: "old", attachments: [] }, { text: "new", attachments: [shot] }]);
});
test("a steer with an image that the turn ends without keeps its image for the next turn", async () => {
  const node = await setupNode("hello.jsonl", { MEDDLE_FIXTURE_STALL: "1" });
  // start a turn, steer with [shot] while it runs, interrupt it: the steer is requeued with its attachments
  expect(node.runner.queued(m.id)).toEqual([{ text: "and this", attachments: [shot] }]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/durable.test.ts`
Expected: the new tests FAIL; typecheck errors from Task 5 remain.

- [ ] **Step 3: Implement the interfaces above in `records.ts` and `durable.ts`**

- [ ] **Step 4: Run the runner's tests to see them pass**

Run: `bun test test/durable.test.ts test/engine.test.ts test/update-input.test.ts test/token-fallback.test.ts && bun run typecheck`
Expected: PASS; no type errors (host callers still pass text only).

- [ ] **Step 5: Commit** — `jj commit -m "Queue and run prompts with their attachments"`

### Task 7: Moves and restores bring their files

**Files:**
- Modify: `src/tasks/transfer.ts:21,141-148,328` (`queued` entries), `src/tasks/durable.ts` (`importIncoming`
  :1058, `activateTask` :1084, `restoreHere` :1345, the move refusals :1772), `src/store/events.ts`
- Test: `test/events.test.ts`, `test/transfer.test.ts`, `test/move.test.ts`

**Interfaces:**
- Consumes: `this.blobs.ensure` (Task 3), `materialize` (Task 4), `promptOf` (Task 1), `TaskRunner.queued` (Task 6).
- Produces:
  - `TransferFrame` manifest `queued: (string | Prompt)[]`; `importTask` refuses `bad queued prompt in transfer` for an
    entry `promptOf` rejects.
  - `listPromptAttachments(db: Database, taskId: string): Attachment[]` in `src/store/events.ts` — every valid
    attachment of the task's `user` events, oldest first, by `json_extract(json, '$.attachments') IS NOT NULL`.
  - `importIncoming` ensures every queued prompt's blob from `from` (then any online member) before answering, else
    throws `attachment <name> could not be fetched from <shortId(from)>`.
  - `#rewriteAttachments(taskId: string, prefer?: string): Promise<void>` — best effort: each
    `listPromptAttachments` blob ensured and materialized; one missing is logged as
    `meddle: task <id>: attachment <name> is not on any online node` and skipped. Run without waiting at the end of
    `activateTask` (prefer the sender) and of `restoreHere`.
  - Move refusal: a task with any queued prompt that has attachments, to a node whose summary lacks
    `attachments: true`, is refused `<host> runs a meddle that takes no attachments` (`<host>`: the summary's hostname).

- [ ] **Step 1: Write the failing tests**

```ts
// test/events.test.ts
test("listPromptAttachments finds the refs of logged prompts", () => {
  appendEvent(db, "t", promptEvent({ text: "a", attachments: [shot] }));
  appendEvent(db, "t", promptEvent({ text: "b", attachments: [] }));
  appendEvent(db, "t", { type: "assistant", message: { content: [] } });
  expect(listPromptAttachments(db, "t")).toEqual([shot]);
});
// test/transfer.test.ts — next to the existing round trip
test("queued prompts with attachments travel, and a bad entry is refused", async () => {
  // as the round-trip test, with the row's queued = ["old", { text: "new", attachments: [shot] }]
  expect(got.queued).toEqual(["old", { text: "new", attachments: [shot] }]);
  // and a sender whose queued holds { text: 1 }: rejects "bad queued prompt in transfer"
});
// test/move.test.ts — with twoPoolNodes(), as the file's moves do
test("a task moved with an attachment queued brings its blob, and its earlier files", async () => {
  // A: a turn with [first] done, then [second] queued (turns held, as the file's queued-move test does); move to B
  expect(await B.runner.blobs.store.has(second.hash)).toBe(true);
  await waitFor(() => existsSync(join(paths(B.cfg).taskAttachments(id), first.hash, first.name)));
});
test("a task with an attachment queued does not move to a node that takes none", async () => {
  // B's roster row on A with summary.attachments removed
  await expect(A.runner.moveTo(id, B.id, false)).rejects.toThrow(`${bHostname} runs a meddle that takes no attachments`);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/events.test.ts test/transfer.test.ts test/move.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement the interfaces above**

The summary flag the refusal reads comes in Task 8; until then read it as `(summary as { attachments?: boolean }).attachments`.

- [ ] **Step 4: Run them to see them pass**

Run: `bun test test/events.test.ts test/transfer.test.ts test/move.test.ts test/archive.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit** — `jj commit -m "Bring a task's attached files along when it moves or is restored"`

### Task 8: Contracts, the node's handlers, its summary and placement

**Files:**
- Modify: `src/state/contracts.ts` (`createTask` :159-180, `NodeSummarySchema` :564, `TaskObject` :391,430,
  `createTaskAt` :716-728, `PoolNodeSchema`), `src/pool/store.ts:16-28`, `src/pool/runtime.ts:120-129`,
  `src/pool/object.ts:83-98`, `src/state/host.ts` (peer `createTaskAt` :177-185, `createTask` :428-480,
  `createOn` :979-994, `placeTask` :1015, the `TaskObject` cells :690-770 and `prompt` :827), `src/tasks/durable.ts`
  (drop Task 7's cast)
- Test: `test/state.test.ts`, `test/placement-pool.test.ts`, `test/pool-state.test.ts`

**Interfaces:**
- Consumes: `AttachmentSchema`, `PromptSchema` (Task 1); `TaskRunner.prompt`/`queued` (Task 6); `chooseNode(projectIds, accept)`.
- Produces:
  - `TaskObject.prompt` args `{ text: string; attachments?: Attachment[] }`; refused `a prompt needs text or an
    attachment` when the text is blank and there are none.
  - `TaskObject` state `queued: string[]` (texts, as today) and new `queuedPrompts: Prompt[]`, both refreshed wherever
    `queued` is today.
  - `NodeObject.createTask` and peer `createTaskAt` args gain `attachments?: Attachment[]`; the first prompt is sent
    when its text is not blank or it has attachments.
  - `NodeSummarySchema.attachments?: boolean`; `NodeSummary.attachments: boolean` (`withSummaryDefaults`: `false`);
    `liveSummary` says `true`; `PoolNodeSchema.attachments: boolean` (`nodeOf`: `summary?.attachments ?? false`).
  - `createTask` with attachments: placed by `runner.chooseNode(ids, (id) => takesAttachments(id))`; a named node
    whose summary lacks the flag is refused `<host> runs a meddle that takes no attachments`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/state.test.ts — through a linked client, as the file's TaskObject tests do
test("a prompt with only an attachment is taken; a blank one with none is refused", async () => {
  await expect(task.prompt({ text: "  " })).rejects.toThrow("a prompt needs text or an attachment");
  expect(await task.prompt({ text: "", attachments: [shot] })).toEqual({ queued: false });
});
test("queuedPrompts shows a queued prompt's attachments; queued its text", async () => {
  // turns held (runner.setHolds({ turns: "held", … })), prompt "look" with [shot]
  expect(task.queued.value).toEqual(["look"]);
  expect(task.queuedPrompts.value).toEqual([{ text: "look", attachments: [shot] }]);
});
// test/pool-state.test.ts
test("a node says it takes attachments; an older summary reads as not", () => {
  expect(nodeOf(rowWith({ attachments: true }), …).attachments).toBe(true);
  expect(nodeOf(rowWith({}), …).attachments).toBe(false);
});
// test/placement-pool.test.ts — as its createTask placement tests
test("a new task with attachments is not placed on a node that takes none", async () => {
  // B is the one placement would pick, its summary without `attachments`; createTask with [shot] lands on A
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/state.test.ts test/pool-state.test.ts test/placement-pool.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement the interfaces above**

- [ ] **Step 4: Run them to see them pass**

Run: `bun test test/state.test.ts test/pool-state.test.ts test/placement-pool.test.ts test/create-starts.test.ts test/cli.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit** — `jj commit -m "Take attachments with a prompt and place them only where they are understood"`

### Task 9: Upload and download over the dashboard

**Files:**
- Modify: `src/dashboard/server.ts`, `src/cli.ts:248` (`startDashboard(cfg, host, pool, runner.blobs)`)
- Test: `test/dashboard-blobs.test.ts`

**Interfaces:**
- Consumes: `BlobFetcher` (Task 3), `MAX_BLOB_BYTES`, `INLINE_IMAGE_TYPES`, `isBlobHash` (Task 1).
- Produces:
  - `startDashboard(cfg, host, pool?, blobs?: BlobFetcher)`; without `blobs`, `/blobs` is 404.
  - `PUT /blobs` (behind `trusted`, as every route): body into `blobs.store.write(request.body, { maxBytes: MAX_BLOB_BYTES })`;
    `200 { hash, size }`; a `Content-Length` over the cap, or a body that grows past it, `413 file exceeds 64 MB`.
  - `GET /blobs/<hash>?type=<mime>&name=<name>`: `blobs.ensure(hash)` false or a bad hash → 404. A type in
    `INLINE_IMAGE_TYPES`: served as that type, `Content-Disposition: inline`; else `application/octet-stream`,
    `Content-Disposition: attachment; filename*=UTF-8''<encodeURIComponent(name)>`. Always `X-Content-Type-Options:
    nosniff`, `Content-Security-Policy: sandbox`, `Cache-Control: private, max-age=31536000, immutable`.

- [ ] **Step 1: Write the failing tests**

Start it as `test/ws-shim.test.ts` does (`startDashboard({ ...cfg, port: 0 }, createHost(…), undefined, fetcher)`).

```ts
test("an upload answers its hash and downloads back", async () => {
  const up = await fetch(`${url}blobs`, { method: "PUT", body: "hello" });
  expect(await up.json()).toEqual({ hash: sha("hello"), size: 5 });
  const down = await fetch(`${url}blobs/${sha("hello")}?type=image/png&name=a.png`);
  expect(down.headers.get("content-type")).toBe("image/png");
  expect(down.headers.get("x-content-type-options")).toBe("nosniff");
  expect(down.headers.get("content-security-policy")).toBe("sandbox");
  expect(await down.text()).toBe("hello");
});
test("anything but the four image types downloads as a file", async () => {
  const svg = await fetch(`${url}blobs/${sha("hello")}?type=image/svg%2Bxml&name=x.svg`);
  expect(svg.headers.get("content-type")).toBe("application/octet-stream");
  expect(svg.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''x.svg");
});
test("too large is 413 and leaves nothing; unknown or bad hashes are 404", async () => {
  const big = await fetch(`${url}blobs`, { method: "PUT", body: new Uint8Array(64 * 1024 * 1024 + 1) });
  expect(big.status).toBe(413);
  expect((await readdir(store.dir)).filter((f) => f.startsWith(".tmp-"))).toEqual([]);
  expect((await fetch(`${url}blobs/${"0".repeat(64)}`)).status).toBe(404);
  expect((await fetch(`${url}blobs/..%2Fsecrets`)).status).toBe(404);
});
test("another site's page cannot upload", async () => {
  const r = await fetch(`${url}blobs`, { method: "PUT", body: "x", headers: { origin: "http://evil.example" } });
  expect(r.status).toBe(403);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/dashboard-blobs.test.ts`
Expected: FAIL (404s).

- [ ] **Step 3: Add the two routes and pass `runner.blobs` from `serve`**

- [ ] **Step 4: Run them to see them pass**

Run: `bun test test/dashboard-blobs.test.ts test/ws-shim.test.ts test/tunnel.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit** — `jj commit -m "Upload and download attached files over the dashboard"`

### Task 10: Attaching in the dashboard

**Files:**
- Create: `src/dashboard/ui/attach-model.ts`, `src/dashboard/ui/Attachments.tsx`
- Modify: `src/dashboard/ui/thread-model.ts:6,109-137`, `src/dashboard/ui/Task.tsx` (`TaskLoaded` :72-140, `ShownView`
  :402, `Queued` :678, `Failed`/`FailedMessage` :688-707, `Composer` :709-764), `src/dashboard/ui/NewTask.tsx`,
  `src/dashboard/ui/icons.tsx` (`attachment` from `iconoir/icons/attachment.svg`), `src/dashboard/ui/index.html`
  (styles), `README.md` and `docs/user-guide.md` (a short "Attachments" section)
- Test: `test/thread-model.test.ts`, `test/ui.test.ts`

**Interfaces:**
- Consumes: `Attachment`, `Prompt`, `cleanName`, `pastedName`, `attachmentProblem`, `INLINE_IMAGE_TYPES` (Task 1);
  `PUT`/`GET /blobs` (Task 9); `task.prompt({ text, attachments })`, `task.queuedPrompts`, `node.createTask({ …, attachments })`,
  `PoolNode.attachments` (Task 8).
- Produces:
  - `ThreadItem` `{ kind: "user"; text: string; attachments: Attachment[] }` — from a logged prompt's `attachments`,
    each kept only when `attachmentProblem` is null.
  - `attach-model.ts`: `type Draft = { id: number; name: string; type: string; size: number; preview: string | null; state: "uploading" | "done" | "failed"; attachment: Attachment | null; error: string | null }`;
    `blobUrl(a: Attachment): string` (`/blobs/<hash>?type=<enc>&name=<enc>`); `shownInline(type: string): boolean`;
    `sizeText(bytes: number): string`; `readyToSend(text: string, drafts: Draft[]): boolean`;
    `draftAttachments(drafts: Draft[]): Attachment[]`; `nameFor(file: { name: string; type: string }, at: Date): string`.
  - `Attachments.tsx`: `useDrafts(): { drafts: Draft[]; add(files: File[]): void; remove(id: number): void; clear(): void; restore(attachments: Attachment[]): void }`
    (uploads each file with `fetch("/blobs", { method: "PUT", body: file })`, previews images with an object URL,
    revoked on remove/clear); `<DraftChips drafts onRemove />`; `<AttachmentList attachments />` (images as
    thumbnails linking to `blobUrl` in a new tab, other files as chips that download); `<AttachButton onFiles />`
    (paperclip, hidden `<input type="file" multiple>`). A file with no type uploads as `application/octet-stream`.
  - Composer and New Task form: paste (only when the clipboard holds files; a text paste is untouched), drop onto
    the composer (class `drop` while dragging over), and the paperclip. Send/Start enabled by `readyToSend`. The
    drafts live in `TaskLoaded` beside the text draft, so a failed prompt's Edit restores both; `Failed` gains
    `attachments`, Retry resends them. Queued messages render `queuedPrompts`. The New Task form offers attaching
    when the picked node is Automatic or its `attachments` is true.

- [ ] **Step 1: Write the failing tests**

```ts
// test/thread-model.test.ts
test("a prompt meddle recorded keeps its attachments, and drops a bad one", () => {
  const items = buildThread([{ seq: 1, message: { type: "user", message: { role: "user", content: "look" }, parent_tool_use_id: null,
    attachments: [shot, { ...shot, name: "../x" }] } }]);
  expect(items).toEqual([{ kind: "user", text: "look", attachments: [shot] }]);
});
// test/ui.test.ts
test("readyToSend wants text or attachments, and every upload done", () => {
  expect(readyToSend(" ", [])).toBe(false);
  expect(readyToSend("", [draft({ state: "done" })])).toBe(true);
  expect(readyToSend("hi", [draft({ state: "uploading" })])).toBe(false);
  expect(readyToSend("hi", [draft({ state: "failed" })])).toBe(false);
});
test("blobUrl, sizeText, nameFor", () => {
  expect(blobUrl({ ...shot, name: "a b.png" })).toBe(`/blobs/${shot.hash}?type=image%2Fpng&name=a%20b.png`);
  expect([sizeText(512), sizeText(12_300), sizeText(3_400_000)]).toEqual(["512 B", "12 KB", "3.4 MB"]);
  expect(nameFor({ name: "", type: "image/png" }, new Date(2026, 10, 17, 9, 5, 3))).toBe("pasted-20261117-090503.png");
  expect(nameFor({ name: "../a.png", type: "image/png" }, new Date())).toBe("_.._a.png");
});
```

Existing user-item expectations in `test/thread-model.test.ts` gain `attachments: []`.

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/thread-model.test.ts test/ui.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement the model, the components, and wire the composer, New Task form, thread, queued and failed messages**

Layout as the spec's sketch: chips in a row above the textarea; the paperclip left of Send. Thread: a user message's
attachments above its text, the text left out when blank. Styles next to `.composer` and `.msg.you` in `index.html`.

- [ ] **Step 4: Run them to see them pass**

Run: `bun test test/thread-model.test.ts test/ui.test.ts test/embedded.test.ts && bun run typecheck`
Expected: PASS (`embedded.test.ts` builds the UI bundle).

- [ ] **Step 5: Check it in the browser**

Run `bun run src/cli.ts serve` with a test data dir, open the dashboard, and on a task: paste a screenshot, drop a
`.log` file, send; the thread shows the thumbnail and the file chip, the thumbnail opens full size, the chip
downloads, and Claude's reply shows it saw the image. Run the whole suite: `bun test`, expected all PASS.

- [ ] **Step 6: Commit** — `jj commit -m "Attach files in the dashboard: paste, drop or pick them"`
