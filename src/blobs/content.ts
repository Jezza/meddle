// What Claude Code is sent for a prompt: its images inline, and every file written under the task with its path in the text.
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { attachmentProblem, inlined, type Attachment, type Prompt } from "./attachment";
import type { BlobStore } from "./store";

/** What a user turn carries to Claude Code: a string, or content blocks. */
export type UserContent = SDKUserMessage["message"]["content"];

async function present(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Writes the attachment as `<dir>/<hash>/<name>` and says where. Always a copy of the blob, never a link: Claude Code may
 * edit the file, and that must not reach the blob store. The copy is made under a temporary name and renamed into place,
 * so a crash never leaves a part of a file under its own name. A file already there is kept as it is. Throws
 * `bad attachment: <why>` for a name or hash that is not safe to write, and `attachment <name> is not here` when the store
 * lacks the blob.
 */
export async function materialize(store: BlobStore, dir: string, a: Attachment): Promise<string> {
  const problem = attachmentProblem(a);
  if (problem !== null) throw new Error(`bad attachment: ${problem}`);
  if (!(await store.has(a.hash))) throw new Error(`attachment ${a.name} is not here`);
  const folder = join(dir, a.hash);
  const target = join(folder, a.name);
  if (await present(target)) return target;
  await mkdir(folder, { recursive: true });
  // A name never starts with a dot, so this can't be one.
  const temp = join(folder, `.tmp-${crypto.randomUUID()}`);
  try {
    await copyFile(store.path(a.hash), temp);
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
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
