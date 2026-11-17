// What a prompt carries besides its text: refs to files in a node's blob store. Pure (typebox only), as the
// dashboard bundle imports it too.
import Type from "typebox";

/** A file on a prompt: the SHA-256 of its bytes, which are kept in a blob store and never in a record. */
export const AttachmentSchema = Type.Object({
  hash: Type.String(), name: Type.String(), type: Type.String(), size: Type.Number(),
});
export type Attachment = Type.Static<typeof AttachmentSchema>;

export const PromptSchema = Type.Object({ text: Type.String(), attachments: Type.Array(AttachmentSchema) });
export type Prompt = Type.Static<typeof PromptSchema>;

/** The largest file a blob store takes, in bytes. */
export const MAX_BLOB_BYTES = 64 * 1024 * 1024;
/** The most base64 one image may be to go to Claude inline. */
export const MAX_IMAGE_BASE64 = 5 * 1024 * 1024;
/** The most base64 all of a prompt's inline images may be together. */
export const IMAGE_BUDGET_BASE64 = 10 * 1024 * 1024;
/** The image types Claude takes inline; any other attachment goes as a file only. */
export const INLINE_IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

const MAX_NAME = 200;

/** Whether `s` is a SHA-256 digest as 64 lowercase hex characters. */
export function isBlobHash(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

/** The length of `bytes` bytes once base64-encoded. */
export function base64Length(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

/** A name safe to write: no separators, no leading dot, at most 200 characters keeping the extension, else `file`. */
export function cleanName(name: string): string {
  const flat = name.replace(/[/\\]/g, "_").replace(/^\.+/, "");
  if (flat.length <= MAX_NAME) return flat || "file";
  const dot = flat.lastIndexOf(".");
  // An extension longer than half the name is not worth keeping, and keeping it could cut the stem to nothing.
  const ext = dot > 0 && flat.length - dot <= MAX_NAME / 2 ? flat.slice(dot) : "";
  let stem = flat.slice(0, MAX_NAME - ext.length);
  // Never end the stem on half of a surrogate pair.
  if (/[\ud800-\udbff]$/.test(stem)) stem = stem.slice(0, -1);
  return stem + ext;
}

const PASTED_EXTENSIONS: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
};

/** The name of a pasted image that has none: `pasted-<yyyymmdd-hhmmss>.<ext>` in local time. */
export function pastedName(type: string, at: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const day = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}`;
  const time = `${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
  return `pasted-${day}-${time}.${PASTED_EXTENSIONS[type] ?? "bin"}`;
}

/** Null when `a` is a valid Attachment, else which part of it is wrong. */
export function attachmentProblem(a: unknown): string | null {
  if (typeof a !== "object" || a === null) return "not an object";
  const { hash, name, type, size } = a as Record<string, unknown>;
  if (typeof hash !== "string" || !isBlobHash(hash)) return "hash is not 64 lowercase hex characters";
  if (typeof name !== "string" || name === "" || name.length > MAX_NAME || /[/\\]/.test(name) || name.startsWith(".")) {
    return `name is not a base name of 1 to ${MAX_NAME} characters without a leading dot`;
  }
  if (typeof type !== "string") return "type is not a string";
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) return "size is not a count of bytes";
  return null;
}

/** The prompt a queue entry holds; a string is text alone. Throws `bad queued prompt` for anything else. */
export function promptOf(entry: unknown): Prompt {
  if (typeof entry === "string") return { text: entry, attachments: [] };
  if (typeof entry === "object" && entry !== null) {
    const { text, attachments } = entry as Record<string, unknown>;
    const valid = Array.isArray(attachments) && attachments.every((a) => attachmentProblem(a) === null);
    if (typeof text === "string" && valid) return entry as Prompt;
  }
  throw new Error("bad queued prompt");
}

/** The entry to queue `p` as: its text alone when it has no attachments, so an older meddle reads it. */
export function queueEntry(p: Prompt): string | Prompt {
  return p.attachments.length === 0 ? p.text : p;
}

/**
 * Per attachment, whether it goes to Claude as an image block. In order, a supported image within the per-image limit
 * and what is left of the budget goes inline and uses that much up; one that does not fit goes as a file, and a later,
 * smaller one may still go inline. An empty image never does: an empty image block would likely fail the turn.
 */
export function inlined(attachments: readonly Attachment[]): boolean[] {
  let left = IMAGE_BUDGET_BASE64;
  return attachments.map((a) => {
    if (!INLINE_IMAGE_TYPES.includes(a.type) || a.size <= 0) return false;
    const base64 = base64Length(a.size);
    if (base64 > MAX_IMAGE_BASE64 || base64 > left) return false;
    left -= base64;
    return true;
  });
}
