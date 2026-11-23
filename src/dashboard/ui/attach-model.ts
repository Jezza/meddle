// Files on a prompt as the dashboard handles them: pure, so it is tested without a DOM.
import { type Attachment, attachmentProblem, cleanName, INLINE_IMAGE_TYPES, pastedName } from "../../blobs/attachment";

/**
 * A file in the composer, from when it is picked until the prompt is sent: uploading, then done with its `attachment`,
 * or failed with its `error`. `preview` is the URL a thumbnail shows, for an image the thread can show.
 */
export type Draft = {
  id: number;
  name: string;
  type: string;
  size: number;
  preview: string | null;
  state: "uploading" | "done" | "failed";
  attachment: Attachment | null;
  error: string | null;
};

/** Where this node gives `a` back: inline for an image it shows, else as a download named `a.name`. */
export function blobUrl(a: Attachment): string {
  return `/blobs/${a.hash}?type=${encodeURIComponent(a.type)}&name=${encodeURIComponent(a.name)}`;
}

/** Whether a file of this type shows as a thumbnail: only the image types a node serves inline. */
export function shownInline(type: string): boolean {
  return INLINE_IMAGE_TYPES.includes(type);
}

/** A file's size in bytes, KB or MB (of 1000): one decimal under ten, else whole. */
export function sizeText(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const mega = bytes >= 999_500;
  const n = bytes / (mega ? 1e6 : 1e3);
  return `${n < 9.95 ? n.toFixed(1) : Math.round(n)} ${mega ? "MB" : "KB"}`;
}

/** Whether a prompt can go: it has text or a file, and every file is uploaded. */
export function readyToSend(text: string, drafts: Draft[]): boolean {
  return (text.trim() !== "" || drafts.length > 0) && drafts.every((d) => d.state === "done");
}

/** The uploaded drafts' attachments, in the order they were added. */
export function draftAttachments(drafts: Draft[]): Attachment[] {
  return drafts.flatMap((d) => (d.state === "done" && d.attachment !== null ? [d.attachment] : []));
}

/** Where composers' files are kept across reloads: the page's localStorage. */
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Each composer's files by its draft key (`new.<project>`, `task.<id>`), kept as `useDraft` keeps its text: they outlive
 * the view they were added in (another view opened meanwhile), and an upload still going when that view goes settles
 * here all the same. The uploaded files' attachments are also kept in `storage` under `meddle.draft.<key>.files`, so a
 * reload puts them back, previewed from the node; a file still uploading (or failed) when the page goes goes with it.
 */
export class ComposerFiles {
  readonly #drafts = new Map<string, Draft[]>();
  readonly #listeners = new Map<string, Set<() => void>>();
  #lastId = 0;

  constructor(readonly storage: DraftStorage | null) {}

  /** The files the composer under `key` holds, the same array until they change. */
  get(key: string): Draft[] {
    let drafts = this.#drafts.get(key);
    if (drafts === undefined) {
      drafts = this.#read(key).map((a) => this.restored(a));
      this.#drafts.set(key, drafts);
    }
    return drafts;
  }

  /** A new draft, its id unique among every composer's. */
  draft(over: Pick<Draft, "name" | "type" | "size" | "preview" | "state" | "attachment">): Draft {
    return { id: ++this.#lastId, error: null, ...over };
  }

  /** An attachment back in a composer, already uploaded, its thumbnail the file on the node. */
  restored(a: Attachment): Draft {
    return this.draft({ name: a.name, type: a.type, size: a.size, preview: shownInline(a.type) ? blobUrl(a) : null, state: "done", attachment: a });
  }

  /** Changes the files under `key`, keeping the uploaded ones in storage, and tells its subscribers. */
  update(key: string, change: (all: Draft[]) => Draft[]) {
    const next = change(this.get(key));
    this.#drafts.set(key, next);
    this.#write(key, draftAttachments(next));
    this.#listeners.get(key)?.forEach((cb) => cb());
  }

  /** `cb` runs whenever the files under `key` change. Returns the unsubscribe. */
  subscribe(key: string, cb: () => void): () => void {
    let set = this.#listeners.get(key);
    if (set === undefined) this.#listeners.set(key, (set = new Set()));
    set.add(cb);
    return () => { set.delete(cb); };
  }

  /** The attachments kept under `key`; none for anything this cannot read, and a bad one is left out. */
  #read(key: string): Attachment[] {
    try {
      const kept: unknown = JSON.parse(this.storage?.getItem(`meddle.draft.${key}.files`) ?? "[]");
      if (!Array.isArray(kept)) return [];
      return kept.filter((a) => attachmentProblem(a) === null).map(({ hash, name, type, size }: Attachment) => ({ hash, name, type, size }));
    } catch {
      return [];
    }
  }

  #write(key: string, attachments: Attachment[]) {
    const name = `meddle.draft.${key}.files`;
    try {
      if (attachments.length === 0) this.storage?.removeItem(name);
      else this.storage?.setItem(name, JSON.stringify(attachments));
    } catch {
      // a private window, or storage full: the files last as long as the page
    }
  }
}

/**
 * The files a paste attaches: the clipboard's files, when its plain text is nothing but them, each non-empty line one
 * file's name or a path (or `file://` URL) ending in one, as a file manager copies files. Any other text wins: Excel,
 * Word and Docs put a picture of the selection beside its text, and that paste is text, left to the browser.
 */
export function pastedFiles<F extends { name: string }>(clipboard: { text: string; files: readonly F[] }): F[] {
  const names = clipboard.files.map((f) => f.name).filter((name) => name !== "");
  const lines = clipboard.text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  return lines.every((line) => names.some((name) => namesFile(line, name))) ? [...clipboard.files] : [];
}

/** Whether a line of pasted text is the file `name`: the name itself, or a path or `file://` URL that ends in it. */
function namesFile(line: string, name: string): boolean {
  if (line === name) return true;
  let path = line;
  if (/^file:\/\//i.test(line)) {
    try {
      path = decodeURIComponent(new URL(line).pathname);
    } catch {
      return false;
    }
  }
  return path.endsWith(`/${name}`) || path.endsWith(`\\${name}`);
}

/** Whether a drag carries files (from outside the page), not text or a link. */
export function carriesFiles(e: { dataTransfer: DataTransfer | null }): boolean {
  return e.dataTransfer?.types.includes("Files") === true;
}

/**
 * Keeps files dropped anywhere on `page` but on a composer that takes them from replacing the dashboard, as the browser
 * would open them in its tab: elsewhere a drag of files shows it cannot drop, and a drop does nothing. A composer's own
 * handlers come first and are left as they are; a drag of text is the browser's. Returns the removal.
 */
export function guardDrops(page: EventTarget): () => void {
  const over = (e: Event) => {
    const drag = e as DragEvent;
    if (drag.defaultPrevented || !carriesFiles(drag)) return;
    drag.preventDefault();
    drag.dataTransfer!.dropEffect = "none";
  };
  const drop = (e: Event) => {
    if (carriesFiles(e as DragEvent)) e.preventDefault();
  };
  page.addEventListener("dragover", over);
  page.addEventListener("drop", drop);
  return () => {
    page.removeEventListener("dragover", over);
    page.removeEventListener("drop", drop);
  };
}

/** The name a picked, dropped or pasted file goes by: its own made safe, or, with none, `pasted-<time>.<ext>`. */
export function nameFor(file: { name: string; type: string }, at: Date): string {
  return file.name === "" ? pastedName(file.type, at) : cleanName(file.name);
}
