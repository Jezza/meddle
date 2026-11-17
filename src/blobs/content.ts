// What Claude Code is sent for a prompt: its images inline, and every file written under the task with its path in the text.
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { constants } from "node:fs";
import { copyFile, link, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { inlined, type Attachment, type Prompt } from "./attachment";
import type { BlobStore } from "./store";

/** What a user turn carries to Claude Code: a string, or content blocks. */
export type UserContent = SDKUserMessage["message"]["content"];

const exists = (err: unknown) => (err as NodeJS.ErrnoException).code === "EEXIST";

/**
 * Writes the attachment as `<dir>/<hash>/<name>` and says where: a hard link to its blob, or a copy where linking fails
 * (another filesystem). A file already there is kept. Throws `attachment <name> is not here` when the store lacks the blob.
 */
export async function materialize(store: BlobStore, dir: string, a: Attachment): Promise<string> {
  if (!(await store.has(a.hash))) throw new Error(`attachment ${a.name} is not here`);
  const folder = join(dir, a.hash);
  await mkdir(folder, { recursive: true });
  const target = join(folder, a.name);
  try {
    await link(store.path(a.hash), target);
  } catch (err) {
    if (exists(err)) return target;
    try {
      await copyFile(store.path(a.hash), target, constants.COPYFILE_EXCL);
    } catch (copyErr) {
      if (!exists(copyErr)) throw copyErr;
    }
  }
  return target;
}

/**
 * The content of the user turn for `prompt`: its text itself when it has no attachments; else its inlined images as
 * image blocks, in order, then one text block of the text and an `Attached files:` list of every file's path.
 */
export async function promptContent(store: BlobStore, dir: string, prompt: Prompt): Promise<UserContent> {
  if (prompt.attachments.length === 0) return prompt.text;
  const inline = inlined(prompt.attachments);
  const images: Exclude<UserContent, string> = [];
  const lines: string[] = [];
  for (const [i, a] of prompt.attachments.entries()) {
    lines.push(`- ${a.name}: ${await materialize(store, dir, a)}`);
    if (!inline[i]) continue;
    const data = (await readFile(store.path(a.hash))).toString("base64");
    // The type is one of the four inline types, since `inlined` said so.
    images.push({ type: "image", source: { type: "base64", media_type: a.type as "image/png", data } });
  }
  const files = `Attached files:\n${lines.join("\n")}`;
  return [...images, { type: "text", text: prompt.text.trim() === "" ? files : `${prompt.text}\n\n${files}` }];
}
