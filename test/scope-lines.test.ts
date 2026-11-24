import { expect, test } from "bun:test";
import type { HeadRow } from "../src/pool/heads";
import { scopeLines } from "../src/scopes/lines";

const ME = "1".repeat(64);
const B = "2".repeat(64);
const C = "3".repeat(64);
const row = (scope: string, node: string, commit: string, extra: Partial<HeadRow> = {}): HeadRow =>
  ({ scope, node, seq: 1, commit, rule: 1, seed: null, edited: true, ...extra });
const names = { node: (id: string) => id.slice(0, 4), project: (id: string) => (id === "p1" ? "meddle" : null) };

test("in step: the profile says so, memory says nothing", () => {
  const rows = [row("profile", ME, "a".repeat(40)), row("profile", B, "a".repeat(40)), row("memory/p1", ME, "b".repeat(40)), row("memory/p1", B, "b".repeat(40))];
  expect(scopeLines(rows, [], ME, "pool", names)).toEqual(["profile in step"]);
});

test("a scope whose peers hold other heads, or rows waiting for their commits, is behind them", () => {
  const rows = [row("profile", ME, "a".repeat(40)), row("profile", B, "c".repeat(40)), row("memory/p1", ME, "b".repeat(40))];
  const waiting = [row("memory/p1", C, "d".repeat(40))];
  expect(scopeLines(rows, waiting, ME, "pool", names)).toEqual(["profile behind 2222", "memory meddle behind 3333"]);
});

test("a legacy profile and a node without one say so", () => {
  expect(scopeLines([], [], ME, "legacy", names)).toEqual(["profile legacy (meddle profile import makes one the pool's)"]);
  expect(scopeLines([], [], ME, "none", names)).toEqual(["profile none"]);
});

test("a head of other merge rules counts as behind", () => {
  const rows = [row("profile", ME, "a".repeat(40)), row("profile", B, "a".repeat(40), { rule: 2 })];
  expect(scopeLines(rows, [], ME, "pool", names)).toEqual(["profile behind 2222 (other merge rules)"]);
});
