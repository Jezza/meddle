// Node ids as text, with no dependencies: the browser bundle imports this (never `identity.ts`, which loads iroh).

/** A node id: the lowercase hex of its iroh public key. */
const NODE_ID = /^[0-9a-f]{64}$/;

export function isNodeId(text: string): boolean {
  return NODE_ID.test(text);
}

/** The prefix of a node id that the CLI and the UI print. */
export function shortId(id: string): string {
  return id.slice(0, 10);
}

/**
 * The one id of `ids` that is `text` or starts with it; throws `no such <what>`, or `ambiguous <what>` naming the ids
 * it could be, otherwise.
 */
export function resolveId(ids: readonly string[], text: string, what: string): string {
  if (ids.includes(text)) return text;
  const matches = text === "" ? [] : [...new Set(ids.filter((id) => id.startsWith(text)))];
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`no such ${what}: ${text}`);
  throw new Error(`ambiguous ${what}: ${text} (${matches.sort().join(", ")})`);
}

/** The one node id of `ids` that is `text` or starts with it; throws `no such node` or `ambiguous node` otherwise. */
export function resolveNodeId(ids: readonly string[], text: string): string {
  return resolveId(ids, text, "node");
}

/**
 * How many leading characters of each of `ids` tell it apart from all the others (at least 1): the prefix
 * `resolveId` takes for it, which the CLI highlights, as jj does.
 */
export function uniquePrefixLengths(ids: Iterable<string>): Map<string, number> {
  const sorted = [...new Set(ids)].sort();
  const common = (a: string, b: string) => {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  };
  const out = new Map<string, number>();
  sorted.forEach((id, i) => {
    const before = i > 0 ? common(id, sorted[i - 1]!) : 0;
    const after = i + 1 < sorted.length ? common(id, sorted[i + 1]!) : 0;
    out.set(id, Math.min(id.length, Math.max(before, after) + 1));
  });
  return out;
}
