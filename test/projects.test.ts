// test/projects.test.ts — the pool's projects as the roster lists them, and `--project <id|name>`.
import { expect, test } from "bun:test";
import { shortId } from "../src/pool/ids";
import { poolProjects, projectLine, resolveProject } from "../src/pool/projects";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const node = (nodeId: string, projects: Array<{ id: string; name: string; home: string; sync?: string[] }>, status: "member" | "removed" = "member") =>
  ({ nodeId, status, projects: projects.map((p) => ({ sync: [], ...p })) });

test("one row per project, named as its home lists it, held by every node whose summary lists it", () => {
  const rows = poolProjects([
    node(A, [{ id: "p2", name: "copy", home: B }, { id: "p1", name: "alpha", home: A }]),
    node(B, [{ id: "p2", name: "beta", home: B, sync: ["main", "dev"] }]),
    node(C, [{ id: "p3", name: "gamma", home: A }]),
  ]);
  expect(rows).toEqual([
    { id: "p1", name: "alpha", home: A, sync: [], holders: [A] },
    // The home's name and sync branches.
    { id: "p2", name: "beta", home: B, sync: ["main", "dev"], holders: [A, B] },
    // The home does not list it: the first holder's name.
    { id: "p3", name: "gamma", home: A, sync: [], holders: [C] },
  ]);
  expect(projectLine(rows[1]!)).toBe(`p2  beta  home ${shortId(B)}  on ${shortId(A)},${shortId(B)}  sync main,dev`);
  expect(projectLine(rows[0]!)).toBe(`p1  alpha  home ${shortId(A)}  on ${shortId(A)}`);
});

test("a removed node's projects are left out", () => {
  expect(poolProjects([node(A, []), node(B, [{ id: "p1", name: "x", home: B }], "removed")])).toEqual([]);
});

test("--project takes an id, or a name exactly one project in the pool has", () => {
  const rows = poolProjects([
    node(A, [{ id: "p1", name: "a", home: A }, { id: "p3", name: "solo", home: A }]),
    node(B, [{ id: "p2", name: "a", home: B }]),
  ]);
  expect(resolveProject(rows, "p2")).toBe("p2");
  expect(resolveProject(rows, "solo")).toBe("p3");
  expect(() => resolveProject(rows, "a")).toThrow("ambiguous project name: a");
  expect(() => resolveProject(rows, "nope")).toThrow("unknown project: nope");
});

test("--project with an id the roster does not list yet passes it through for the node to ask the members", () => {
  const rows = poolProjects([node(A, [{ id: "p1", name: "a", home: A }])]);
  expect(resolveProject(rows, "0123456789ab")).toBe("0123456789ab");
  // Not id-shaped: unknown.
  expect(() => resolveProject(rows, "0123456789AB")).toThrow("unknown project: 0123456789AB");
  expect(() => resolveProject(rows, "0123456789a")).toThrow("unknown project: 0123456789a");
});

test("a roster entry without sync (an older peer's) reads as no sync branches, and a projectInfo answer without it is valid", async () => {
  const { Value } = await import("typebox/value");
  const { ProjectInfoSchema } = await import("../src/state/contracts");
  const rows = poolProjects([{ nodeId: A, status: "member", projects: [{ id: "p1", name: "old", home: A }] }]);
  expect(rows).toEqual([{ id: "p1", name: "old", home: A, sync: [], holders: [A] }]);
  expect(projectLine(rows[0]!)).toBe(`p1  old  home ${shortId(A)}  on ${shortId(A)}`);
  expect(Value.Check(ProjectInfoSchema, { id: "p1", name: "old", home: A })).toBe(true);
  expect(Value.Check(ProjectInfoSchema, { id: "p1", name: "old", home: A, sync: ["main"] })).toBe(true);
});
