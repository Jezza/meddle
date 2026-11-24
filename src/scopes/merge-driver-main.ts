// `meddle merge-driver <base> <ours> <theirs> <path>`: git's merge driver for the repos of synced scopes (`%O %A %B
// %P`). Writes the merge of the three files (`mergeFile`, by `<path>`'s rule) over `<ours>` and exits 0; any failure
// exits 1, which git reports as a conflict and meddle refuses to commit. Loads only what it needs.
import { readFile, writeFile } from "node:fs/promises";
import { mergeFile } from "./merge-file";

/** Merges `ours` in place; resolves to the exit code. */
export async function mergeDriver(args: readonly string[]): Promise<number> {
  if (args.length !== 4) {
    console.error("usage: merge-driver <base> <ours> <theirs> <path>");
    return 2;
  }
  const [base, ours, theirs, path] = args as [string, string, string, string];
  const [b, o, t] = await Promise.all([readFile(base), readFile(ours), readFile(theirs)]);
  await writeFile(ours, mergeFile(path, b, o, t));
  return 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] !== "merge-driver") {
    console.error("usage: merge-driver <base> <ours> <theirs> <path>");
    process.exit(2);
  }
  try {
    process.exit(await mergeDriver(args.slice(1)));
  } catch (err) {
    console.error(`meddle: ${(err as Error).message}`);
    process.exit(1);
  }
}
