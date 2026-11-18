# Attachments on prompts

## Why

You want to show Claude things, mostly pictures: a screenshot of what the dashboard or an app looks like, an image to
work from. In Claude Code's terminal that is Ctrl+V or dragging a file in; from meddle's dashboard there is no way to
do it, because a prompt is plain text end to end (the composer, `TaskObject.prompt`, the queue, the event log, a move's
frames, the thread).

Files go through a content-addressed blob store: an upload is hashed (SHA-256) and stored under its hash, and a prompt
carries only hashes. A file then travels the pool by its hash: any node that lacks it fetches it from one that has it,
and checks the bytes against the hash.

## What you see

- **Composer** (task page) and the **New Task** form: drop files on the composer, paste an image from the clipboard
  into it, or pick files with a paperclip button. Each attachment shows as a chip above the text: a thumbnail for an
  image, an icon, name and size for any other file, each with a × to remove it. A chip shows that it is uploading;
  Send (and Start) waits for every upload and is enabled with attachments and no text.
- **Thread**: your message shows its images as thumbnails (click opens the full image in a new tab) and other files
  as chips (click downloads it). Queued and failed messages show theirs too; Retry sends them again and Edit puts them
  back in the composer with the text.

```
 thread                                   ┌───────────────────────────────┐
                                          │ [img] [img]  ▤ server.log      │
                                          │ why does the sidebar overlap   │
                                          │ the bar at this width?         │
                                          └───────────────────────────────┘
 composer
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ [img ×] [img ⟳ ×] [▤ server.log 12 KB ×]                                 │
 │ Reply…                                                            📎  ➤  │
 └──────────────────────────────────────────────────────────────────────────┘
```

## What Claude gets

- Each image that is PNG, JPEG, GIF or WebP and at most 5 MiB once base64 (Claude Code's limit, `maxBase64Size`: a
  file of about 3.75 MiB) goes in the user message as an image block
  (`{ type: "image", source: { type: "base64", media_type, data } }`), as Ctrl+V does in Claude Code; in the order
  attached, until the prompt's images reach 10 MiB of base64 together **(my call)**. Claude Code keeps the message as
  one transcript row, and a move sends each row as one frame of at most 16 MiB: a row over that would make the task
  unmovable for good. Images past the budget go as files only.
- Every attachment, images included, is also a file at `<task>/.meddle/attachments/<hash>/<name>`, and the text sent
  to Claude ends with a line per attachment naming it and its path, so Claude can open, copy or compare it. That
  directory is outside every jj workspace (jj would commit a file put in one) and is passed to Claude Code as an
  additional directory so reading it needs no approval. It is a cache: written from the store when a prompt is sent
  to Claude, and again after a move or restore (below).
- An image of another type, over 5 MiB once base64, or past the budget goes as the file only (Claude Code's Read tool
  opens and resizes images).

## The blob store

- **Where:** `<data>/blobs/<sha256 hex>`, the directory mode 700, each blob 600. A hash is 64 lowercase hex characters;
  anything else is refused wherever a hash comes in (no path ever built from an unchecked one).
- **Writing:** bytes stream to a temporary file in that directory while they are hashed, then it is renamed to the
  hash (a blob already there: the temporary file is dropped). `serve` removes temporary files a crash left, as it does
  for archives.
- **Upload:** `PUT /blobs` on the dashboard server, under the same `trusted` check as every other route (loopback
  `Host`, the server's own `Origin`). The body is the file's bytes; the answer is `{ hash, size }`. At most 64 MB a
  file **(my call)**.
- **Download:** `GET /blobs/<hash>?type=<mime>&name=<name>` answers the blob from this node's store, fetching it from
  the pool first when it is not here (404 when no online node has it). An image of the four types above is served
  inline with that type; anything else as `application/octet-stream` with `Content-Disposition: attachment`. Every
  blob response carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`: the dashboard's
  origin drives the node, and an uploaded file (an SVG, an HTML page) must never run script in it.
- **Between nodes:** a pool stream `{ stream: "blob", kind: "file", hash }`, taken by `acceptBlobStreams` alongside
  `kind: "task"`. The node asked answers with a JSON header frame, `{ size }` or `{ missing: true }`, then the bytes as
  kind-1 frames, and finishes. The asker checks size and hash before renaming the blob into place. `fetchBlob(hash)`
  asks the online members one at a time until one has it; two fetches of one hash at once share one. A node of an
  older meddle resets the stream, which counts as not having it.
- **Never deleted** in this version **(my call)**.

## The prompt

- `Attachment = { hash, name, type, size }`, `Prompt = { text, attachments }`. `name` is a base name only (no `/`,
  `\` or leading `.`, at most 200 characters); a pasted image with no name gets `pasted-<yyyymmdd-hhmmss>.<ext>`.
  `type` is the browser's MIME type (empty: `application/octet-stream`).
- **Contracts:** `TaskObject.prompt` takes `{ text, attachments? }`; the `createTask` node method and the
  `createTaskAt` peer method take `attachments?` beside `prompt`; the task's state carries each queued prompt's
  attachments beside its text (see Constraints for the shape). A prompt needs text or at least one attachment.
  `activateTask`'s `followUp` stays text.
- **Accepted means here:** the node a prompt is sent to (`prompt`, a local `createTask`, `createTaskAt`) fetches every
  blob of it that it lacks before it answers, and refuses the prompt when one cannot be found
  (`attachment <name> is not on any online node`). From then on the task's node has every blob its prompts name.
- **Stored as refs** wherever a prompt's text is stored today, never as bytes: `tasks.queued` entries, the durable
  `MeddleTurn` input, `InputQueue` items and `untaken`, the move's manifest frame. Old data keeps reading: a `queued`
  entry that is a string is `{ text, attachments: [] }`, a `MeddleTurn` input without `attachments` has none. A
  queued prompt is removed by identity, not by text equality (`startQueued` uses `indexOf` today).
- **Event log:** `promptEvent` logs the text as today plus `attachments` (the refs) on the event; the thread reads
  those. The bytes are not in meddle's log, its state cells or anything streamed to a dashboard. Claude Code's own
  transcript does hold them, base64, since it records what it was sent; that is accepted.
- **Moves:** importing a task fetches, from the sender, every blob its queued prompts name (a move carries no turn input),
  before the receipt; a blob that cannot be fetched fails the import like any other import error. Then, best effort
  **(my call)**, it fetches the blobs of the earlier prompts in its log and writes `.meddle/attachments` again, so the
  paths Claude was given in earlier turns still work; one no online node has is left out, and the move goes on.
- **Archives** carry no blobs: they stay in the store of the node that had them. Restoring a task fetches its log's
  blobs and writes `.meddle/attachments` again, best effort, as a move does; archiving already refuses a task with
  prompts queued. Thumbnails of a blob no online node has show as a broken image.
- **Title:** a task named from its prompt is named from the text only; an attachment-only prompt keeps its generated
  name.
- **CLI:** `task prompt` recognises its own turn by comparing the logged content to its text (`cli.ts`, `promptOn`);
  that keeps working with the new event shape. The CLI attaches nothing in this version.

## Non-goals

- Deleting blobs no task refers to any more.
- Attaching from the CLI (`--attach`).
- Resizing or converting images in meddle.
- PDFs as document blocks: a PDF goes as a file, which Read opens.
- Attachments on answers to approvals and questions.

## Anti-goals

- An attachment's bytes in meddle's record of a prompt: its event, its `queued` entry, its durable turn input, the
  dashboard's state. (A Read of an image already logs base64 in its tool result today; that is unchanged and out of
  scope.)
- An attachment written inside a jj workspace.
- An uploaded file served so that it can run script in the dashboard's origin.

## Approaches

1. **Upload to the node your browser is on and fetch by hash where needed (picked).** The browser uploads over plain
   HTTP to its own dashboard server; the task's node fetches what it lacks over a pool stream. No base64 on the way
   in, no 16 MB frame limit on a file, and the same fetch serves prompts, moves and thumbnails. Costs one new kind of
   pool stream.
2. **Upload straight to the task's node through the dashboard's chord link,** base64 in a method call through the
   tunnel. Simpler routing, but a third larger, each file well under 16 MB, and moves and thumbnails still need a way
   to carry blobs.
3. **The image's bytes inline in the prompt, no store.** Ruled out: every queue, log and move carries the bytes.

## Constraints

- Nodes of the pool run different meddle versions for a while during an update, and checkouts of different
  revisions can move tasks to each other. Rows, durable inputs and move frames written by an older meddle must still
  read (above). The other way **(my call; drop it if every node always runs one build)**: an older node silently drops
  fields it does not know (chord's `Value.Clean`), so attachments must never be sent to it.
  - Each node says in its summary that it takes attachments (an optional field, as `running` and `projects` were
    added); an older node says nothing.
  - The New Task form offers no paperclip, drop or paste when the node it names does not say so. (A task page
    needs no such gate: a newer dashboard cannot open a task on an older node at all, as with every cell added to
    `TaskObject` before.)
  - `createTask` with attachments places only on nodes that say so; a move of a task with attachments in its queue
    is refused to a node that does not.
  - An older dashboard or CLI must still connect to an updated node's tasks: chord refuses a link whose contract
    changed a cell's type at the same version (`contract_mismatch`), so `queued` stays an array of texts and the
    queue's prompts, attachments included, come in a cell of their own, `queuedPrompts`.
- The dashboard serves on `127.0.0.1` only; the browser always uploads to its own node.
- Pool streams carry frames of at most 16 MiB (`MAX_FRAME`), so a blob goes in several.

## Left to the builder

- Chip, thumbnail and drop-target styling within the existing stylesheet; the paperclip from Iconoir.
- Chunk size on the pool stream; whether images precede the text in the message (Anthropic recommends images first).
- Hard-linking a blob into `.meddle/attachments` or copying it (the data dir and task root may be on different
  filesystems: copy then).
- How an upload's progress shows on its chip, and what a failed upload looks like (the chip marked, removable).
