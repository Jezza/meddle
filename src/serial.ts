// Runs async work one at a time per key: jj merges concurrent operations on a repo instead of refusing them, so two
// syncs or pushes that overlap in one repo leave stray commits behind; callers chain them here instead.

/** The settled tail of each key's chain; a key whose chain has drained is gone. */
const chains = new Map<string, Promise<void>>();

/**
 * Runs `fn` once every earlier `serialised` call with the same `key` has settled (fulfilled or rejected), and resolves
 * or rejects as `fn` does.
 */
export function serialised<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.then(() => {}, () => {});
  chains.set(key, tail);
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}

/** The key that serialises jj operations on the repo at `path` that must not overlap (bookmark moves, pushes). */
export function repoKey(path: string): string {
  return `repo\0${path}`;
}
