// Files on a prompt as the dashboard handles them: pure, so it is tested without a DOM.
import { type Attachment, cleanName, INLINE_IMAGE_TYPES, pastedName } from "../../blobs/attachment";

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

/** The name a picked, dropped or pasted file goes by: its own made safe, or, with none, `pasted-<time>.<ext>`. */
export function nameFor(file: { name: string; type: string }, at: Date): string {
  return file.name === "" ? pastedName(file.type, at) : cleanName(file.name);
}
