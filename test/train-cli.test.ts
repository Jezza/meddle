// test/train-cli.test.ts — what the CLI says and takes of a train: `trainText`, the arguments of `train`, the project it
// names, and telling a holder of an older meddle by what chord answers.
import { expect, test } from "bun:test";
import { ChordError, createHost, hostNamed, memoryLinkPair, method, remote } from "@earendil-works/chord";
import { Type } from "typebox";
import type { PoolProject } from "../src/pool/projects";
import { olderHolder, trainArgs, trainProjectChoice, trainText } from "../src/train/surface";
import type { TrainState } from "../src/train/train";

const titles = new Map([
  ["t1", "Add a.txt"], ["t2", "Add b.txt"], ["t3", "Add c.txt"], ["m1", "Merge Add a.txt, Add b.txt"],
]);
const empty: TrainState = { paused: null, round: null, queued: [] };

test("trainText: an empty train says so; a paused one gives its reason first", () => {
  expect(trainText(empty, titles)).toBe("nothing queued");
  expect(trainText({ ...empty, paused: "you paused it" }, titles)).toBe("paused: you paused it\nnothing queued");
});

test("trainText: the queue in order, each task with its title, id and state, and the reason when there is one", () => {
  const state: TrainState = {
    paused: null,
    round: null,
    queued: [
      { taskId: "t1", state: "turn running", reason: null },
      { taskId: "t2", state: "sitting out", reason: "its describe turn failed" },
      { taskId: "t3", state: "queued", reason: "Add c.txt includes work from Add x.txt, which isn't queued" },
    ],
  };
  expect(trainText(state, titles)).toBe([
    "queued:",
    "  Add a.txt (t1)  turn running",
    "  Add b.txt (t2)  sitting out: its describe turn failed",
    "  Add c.txt (t3)  queued: Add c.txt includes work from Add x.txt, which isn't queued",
  ].join("\n"));
});

test("trainText: the round's step, its batch and its merge task, after the queue", () => {
  const state: TrainState = {
    paused: null,
    round: { step: "checking", batch: ["t1", "t2"], mergeTask: "m1" },
    queued: [
      { taskId: "t1", state: "in the batch", reason: null },
      { taskId: "t2", state: "in the batch", reason: null },
      { taskId: "t3", state: "queued", reason: null },
    ],
  };
  expect(trainText(state, titles)).toBe([
    "queued:",
    "  Add a.txt (t1)  in the batch",
    "  Add b.txt (t2)  in the batch",
    "  Add c.txt (t3)  queued",
    "round: checking",
    "  batch: Add a.txt (t1), Add b.txt (t2)",
    "  merge task: Merge Add a.txt, Add b.txt (m1)",
  ].join("\n"));
  // A round with no batch yet, and none made merge task, prints its step alone; paused comes first.
  expect(trainText({ paused: "the merge task got stuck", round: { step: "picking", batch: [], mergeTask: null }, queued: [] }, titles)).toBe(
    "paused: the merge task got stuck\nnothing queued\nround: picking",
  );
});

test("trainText: a task whose title is not known is shown by its id alone, in the queue, the batch and as the merge task", () => {
  const state: TrainState = {
    paused: null,
    round: { step: "landing", batch: ["x1"], mergeTask: "x2" },
    queued: [{ taskId: "x1", state: "waiting for 1a2b3c4d (host)", reason: null }],
  };
  expect(trainText(state, new Map())).toBe([
    "queued:",
    "  x1  waiting for 1a2b3c4d (host)",
    "round: landing",
    "  batch: x1",
    "  merge task: x2",
  ].join("\n"));
});

test("train's arguments: a project, --follow, and pause or resume with a project", () => {
  expect(trainArgs([])).toEqual({ action: "show", project: undefined, follow: false });
  expect(trainArgs(["site"])).toEqual({ action: "show", project: "site", follow: false });
  expect(trainArgs(["--follow"])).toEqual({ action: "show", project: undefined, follow: true });
  expect(trainArgs(["site", "--follow"])).toEqual({ action: "show", project: "site", follow: true });
  expect(trainArgs(["--follow", "site"])).toEqual({ action: "show", project: "site", follow: true });
  expect(trainArgs(["pause"])).toEqual({ action: "pause", project: undefined, follow: false });
  expect(trainArgs(["resume", "site"])).toEqual({ action: "resume", project: "site", follow: false });
  // Not a command: two projects, an unknown flag, --follow twice or with pause or resume.
  for (const bad of [["a", "b"], ["--frob"], ["--follow", "--follow"], ["pause", "--follow"], ["resume", "a", "b"], ["pause", "resume"]]) {
    expect(trainArgs(bad)).toBeNull();
  }
});

const rows: PoolProject[] = [
  { id: "aaaaaaaaaaaa", name: "site", home: "n1", holders: ["n1"] },
  { id: "bbbbbbbbbbbb", name: "tools", home: "n2", holders: ["n1", "n2"] },
];

test("the project a train command acts on: the one named, else the checkout's, else the pool's only one", () => {
  expect(trainProjectChoice(rows, "tools", null).id).toBe("bbbbbbbbbbbb");
  expect(trainProjectChoice(rows, "aaaa", "bbbbbbbbbbbb").id).toBe("aaaaaaaaaaaa");
  expect(trainProjectChoice(rows, undefined, "bbbbbbbbbbbb").name).toBe("tools");
  expect(trainProjectChoice([rows[0]!], undefined, null).name).toBe("site");
  // A checkout of a project the pool does not list is no help: the choice falls to the one project, or is asked for.
  expect(trainProjectChoice([rows[0]!], undefined, "cccccccccccc").name).toBe("site");
  expect(() => trainProjectChoice(rows, undefined, null)).toThrow("name a project: site (aaaaaaaaaaaa), tools (bbbbbbbbbbbb)");
  expect(() => trainProjectChoice([], undefined, null)).toThrow("the pool has no projects");
  expect(() => trainProjectChoice(rows, "nope", null)).toThrow("unknown project: nope");
  // An id the roster does not list yet passes `resolveProject` but names no home to run the train on.
  expect(() => trainProjectChoice(rows, "cccccccccccc", null)).toThrow("unknown project: cccccccccccc");
});

/** The task contract of a node of an older meddle, and of this one with a member more (as the train added `accept`). */
const contract = (members: { accept: boolean }) =>
  remote("meddle.task", {
    version: 1,
    input: Type.Object({ id: Type.String() }),
    host: hostNamed("node"),
    variants: {
      default: {
        state: { title: Type.String(), ...(members.accept ? { queue: Type.Optional(Type.String()) } : {}) },
        methods: { archive: method(Type.Object({})), ...(members.accept ? { accept: method(Type.Object({})) } : {}) },
      },
    },
  });

test("a holder of an older meddle is told by what chord answers: it binds a member it lacks to nothing", async () => {
  const Old = contract({ accept: false });
  const New = contract({ accept: true });
  const server = createHost({ name: "node", self: "node" });
  server.serve(Old, (_input, _principal, self) => ({
    variant: "default",
    title: self.state("title", Type.String(), { init: () => "t" }),
    archive: () => {},
  }) as never);
  const [down, up] = memoryLinkPair();
  server.accept(down, { principal: "x", kind: "client" });
  const client = createHost({ name: "cli", self: "cli", kind: "client", upstream: { link: up, principal: "node" } });
  try {
    // A client built with `accept` cannot even bind the older holder's task: chord refuses it as a contract it does not cover.
    const refused = await client.get(New, { id: "a" }).then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(ChordError);
    expect(olderHolder(refused)).toBe(true);
  } finally {
    await client.close();
    await server.close();
  }
  // A method the holder lacks, said by the holder itself.
  expect(olderHolder(new ChordError("not_in_variant", "meddle.task: accept is not a method of variant default"))).toBe(true);
  // Anything else is the command's own failure: a refusal, another chord error, a contract that changed some other way.
  expect(olderHolder(new Error("send or clear the waiting prompts first"))).toBe(false);
  expect(olderHolder(new ChordError("forbidden", "not yours"))).toBe(false);
  expect(olderHolder(new ChordError("contract_mismatch", "meddle.task: provider version 2, consumer version 1, no accepts adapter"))).toBe(false);
  expect(olderHolder(null)).toBe(false);
});
