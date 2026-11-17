// src/projects/memory-names.ts — what the node and the dashboard both need to say about memory: which names are memory
// files, a file as a jj fileset, and a refusal's reason as a peer gave it. Pure (no `node:` imports): the dashboard's
// bundle takes it as it is.

/** A memory file's name: a `*.md` file in the repo's top folder, named as the dashboard can write it. */
export function isMemoryPath(path: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(path);
}

/** Exactly the file `path` at the repo's root, as a jj fileset. */
export function memoryFileset(path: string): string {
  return `root-file:${JSON.stringify(path)}`;
}

/** A peer's error as it said it: without the `<code>: ` (or `<code>/<reason>: `) a chord error's message starts with. */
export function remoteReason(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && err.message.startsWith(code)) return err.message.replace(/^[^:]*: /, "");
  return err.message;
}
