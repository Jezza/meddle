// How a file of a synced scope (the profile, a project's memory) merges when two nodes changed it: a pure function of
// (base, ours, theirs, path), so every node that merges the same commits writes the same bytes and the nodes settle.
// Ours is the first parent (the lower node id's side), theirs the second. Nothing here depends on git, the locale or
// the time: a change to any rule is a change of `RULE_VERSION` (spec 6.6).
// - Markdown and text merge by line: each side's changes where the other left the base alone, both sides' lines (ours
//   first) where both changed the same stretch, then no non-blank line more often than the side that has it most, so a
//   line both sides already merged in by different routes is kept once.
// - JSON merges by key: never invalid JSON.
// - Anything else is taken whole: the second parent's when both changed it.

/** The version of the merge rules; a head of another version is never merged. */
export const RULE_VERSION = 1;

export type MergeKind = "lines" | "json" | "whole";

/** The rule a file merges by, from its name. */
export function mergeKind(path: string): MergeKind {
  if (/\.(md|txt)$/i.test(path)) return "lines";
  if (/\.json$/i.test(path)) return "json";
  return "whole";
}

/** `text` as lines, and whether it ended with a newline. */
function splitLines(text: string): { lines: string[]; newline: boolean } {
  if (text === "") return { lines: [], newline: false };
  const newline = text.endsWith("\n");
  return { lines: (newline ? text.slice(0, -1) : text).split("\n"), newline };
}

/** The longest cells a line diff takes before it gives up on matching the middle and treats it as one changed stretch. */
const MAX_CELLS = 16_000_000;

/**
 * For each line of `a` matched in a longest common subsequence with `b`, the index in `b` it matches (else -1). Ties
 * go the same way every time.
 */
function matches(a: readonly string[], b: readonly string[]): number[] {
  const out = new Array<number>(a.length).fill(-1);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    out[start] = start;
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
    out[endA] = endB;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_CELLS) return out;
  // lcs[i][j]: the LCS length of a[start+i..endA) and b[start+j..endB).
  const width = m + 1;
  const lcs = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[start + i] === b[start + j]
        ? lcs[(i + 1) * width + j + 1]! + 1
        : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      out[start + i] = start + j;
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}

function sameLines(x: readonly string[], y: readonly string[]): boolean {
  return x.length === y.length && x.every((l, i) => l === y[i]);
}

/** One stretch between lines both sides kept: the side that changed it, or both sides' lines, ours first. */
function mergeStretch(base: string[], ours: string[], theirs: string[]): string[] {
  if (sameLines(ours, base)) return theirs;
  if (sameLines(theirs, base)) return ours;
  if (sameLines(ours, theirs)) return ours;
  return [...ours, ...theirs];
}

/** A three-way merge of text by line (see the top of the file). */
export function mergeLines(base: string, ours: string, theirs: string): string {
  const b = splitLines(base).lines;
  const o = splitLines(ours);
  const t = splitLines(theirs);
  const toOurs = matches(b, o.lines);
  const toTheirs = matches(b, t.lines);
  const merged: string[] = [];
  let [ib, io, it] = [0, 0, 0];
  for (let k = 0; k < b.length; k++) {
    const mo = toOurs[k]!;
    const mt = toTheirs[k]!;
    if (mo < io || mt < it) continue;
    // A base line both sides kept: what lies before it on each side is one stretch.
    merged.push(...mergeStretch(b.slice(ib, k), o.lines.slice(io, mo), t.lines.slice(it, mt)), b[k]!);
    [ib, io, it] = [k + 1, mo + 1, mt + 1];
  }
  merged.push(...mergeStretch(b.slice(ib), o.lines.slice(io), t.lines.slice(it)));

  // No non-blank line more often than the side that has it most.
  const most = new Map<string, number>();
  for (const side of [o.lines, t.lines]) {
    const count = new Map<string, number>();
    for (const l of side) count.set(l, (count.get(l) ?? 0) + 1);
    for (const [l, n] of count) most.set(l, Math.max(most.get(l) ?? 0, n));
  }
  const seen = new Map<string, number>();
  const kept = merged.filter((l) => {
    if (l.trim() === "") return true;
    const n = (seen.get(l) ?? 0) + 1;
    seen.set(l, n);
    return n <= (most.get(l) ?? 0);
  });
  if (kept.length === 0) return "";
  return kept.join("\n") + (o.newline || t.newline ? "\n" : "");
}

/** A key a side lacks. */
const MISSING = Symbol("missing");
type Value = unknown;

function isObject(v: Value): v is Record<string, Value> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function equal(x: Value, y: Value): boolean {
  if (x === y) return true;
  if (Array.isArray(x) && Array.isArray(y)) return x.length === y.length && x.every((v, i) => equal(v, y[i]));
  if (isObject(x) && isObject(y)) {
    const kx = Object.keys(x);
    const ky = Object.keys(y);
    return kx.length === ky.length && kx.every((k) => Object.hasOwn(y, k) && equal(x[k], y[k]));
  }
  return false;
}

/** A three-way merge of two JSON values (`MISSING` for a key a side lacks). */
function mergeValue(base: Value, ours: Value, theirs: Value): Value {
  if (equal(ours, theirs)) return ours;
  if (equal(ours, base)) return theirs;
  if (equal(theirs, base)) return ours;
  // Changed on one side, deleted on the other: the change stays (as an edit beats a delete for files).
  if (ours === MISSING) return theirs;
  if (theirs === MISSING) return ours;
  if (isObject(ours) && isObject(theirs)) {
    const b = isObject(base) ? base : {};
    const out: Record<string, Value> = {};
    for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
      const value = mergeValue(
        Object.hasOwn(b, key) ? b[key] : MISSING,
        Object.hasOwn(ours, key) ? ours[key] : MISSING,
        Object.hasOwn(theirs, key) ? theirs[key] : MISSING,
      );
      if (value !== MISSING) out[key] = value;
    }
    return out;
  }
  if (Array.isArray(ours) && Array.isArray(theirs)) return [...ours, ...theirs.filter((v) => !ours.some((o) => equal(o, v)))];
  return theirs;
}

function parse(text: string): { ok: true; value: Value } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as Value };
  } catch {
    return { ok: false };
  }
}

const format = (value: Value) => `${JSON.stringify(value, null, 2)}\n`;

/** A three-way merge of JSON text by key (see the top of the file); always valid JSON unless neither side is. */
export function mergeJson(base: string, ours: string, theirs: string): string {
  const b = parse(base);
  const o = parse(ours);
  const t = parse(theirs);
  if (!o.ok && !t.ok) return wholeOf(base, ours, theirs);
  if (!o.ok) return format((t as { value: Value }).value);
  if (!t.ok) return format(o.value);
  return format(mergeValue(b.ok ? b.value : {}, o.value, t.value));
}

function wholeOf<T extends string | Uint8Array>(base: T, ours: T, theirs: T): T {
  const same = (x: T, y: T) => (typeof x === "string" ? x === y : equalBytes(x as Uint8Array, y as Uint8Array));
  if (same(theirs, base)) return ours;
  return theirs;
}

function equalBytes(x: Uint8Array, y: Uint8Array): boolean {
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** A file taken whole: the side that changed it, the second parent's when both did. */
export function mergeWhole(base: Uint8Array, ours: Uint8Array, theirs: Uint8Array): Uint8Array {
  return wholeOf(base, ours, theirs);
}

/** The merge of file `path` by the rule its name gives; bytes that are not UTF-8 are taken whole. */
export function mergeFile(path: string, base: Uint8Array, ours: Uint8Array, theirs: Uint8Array): Uint8Array {
  const kind = mergeKind(path);
  if (kind === "whole") return mergeWhole(base, ours, theirs);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let texts: [string, string, string];
  try {
    texts = [decoder.decode(base), decoder.decode(ours), decoder.decode(theirs)];
  } catch {
    return mergeWhole(base, ours, theirs);
  }
  const merged = kind === "lines" ? mergeLines(...texts) : mergeJson(...texts);
  return new TextEncoder().encode(merged);
}
