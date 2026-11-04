import { test, expect } from "bun:test";
import { openDb } from "../src/store/db";
import { appendEvent, latestEventOfType, latestEventWithField, listEvents, listEventsTail } from "../src/store/events";
test("unknown message shapes are stored verbatim with sequence numbers", () => {
  const db = openDb(":memory:");
  expect(appendEvent(db, "t", { type: "assistant", uuid: "u1" })).toBe(1);
  expect(appendEvent(db, "t", { type: "something_new", payload: { x: 1 } })).toBe(2);
  expect(listEvents(db, "t").map(e => e.message)).toEqual([{ type: "assistant", uuid: "u1" }, { type: "something_new", payload: { x: 1 } }]);
  expect(listEvents(db, "t", { fromSeq: 2 }).length).toBe(1);
});

test("a message without a type is stored, and seq numbering is per task", () => {
  const db = openDb(":memory:");
  expect(appendEvent(db, "a", { foo: 1 })).toBe(1);
  expect(appendEvent(db, "b", { type: "system", subtype: "init" })).toBe(1);
  expect(appendEvent(db, "a", { type: "result" })).toBe(2);
  expect(listEvents(db, "a")).toEqual([
    { seq: 1, message: { foo: 1 } },
    { seq: 2, message: { type: "result" } },
  ]);
  expect(listEvents(db, "b")).toEqual([{ seq: 1, message: { type: "system", subtype: "init" } }]);
  expect(listEvents(db, "a", { limit: 1 })).toEqual([{ seq: 1, message: { foo: 1 } }]);
});

test("listEventsTail returns the newest events oldest first, before beforeSeq, without the excluded types", () => {
  const db = openDb(":memory:");
  for (const m of [{ type: "user" }, { type: "stream_event" }, { type: "assistant" }, { foo: 1 }, { type: "stream_event" }, { type: "result" }]) appendEvent(db, "t", m);
  appendEvent(db, "u", { type: "assistant" });
  expect(listEventsTail(db, "t", { limit: 2 }).map(e => e.seq)).toEqual([5, 6]);
  expect(listEventsTail(db, "t", { limit: 3, excludeTypes: ["stream_event"] })).toEqual([
    { seq: 3, message: { type: "assistant" } },
    { seq: 4, message: { foo: 1 } },
    { seq: 6, message: { type: "result" } },
  ]);
  expect(listEventsTail(db, "t", { beforeSeq: 4, limit: 10, excludeTypes: ["stream_event"] }).map(e => e.seq)).toEqual([1, 3]);
  expect(listEventsTail(db, "t", { beforeSeq: 4, limit: 1, excludeTypes: ["stream_event", "assistant"] }).map(e => e.seq)).toEqual([1]);
  expect(listEventsTail(db, "t", { beforeSeq: 1, limit: 10 })).toEqual([]);
  expect(listEventsTail(db, "none", { limit: 10 })).toEqual([]);
});

test("latestEventOfType finds the task's newest event of a type, and of a subtype", () => {
  const db = openDb(":memory:");
  appendEvent(db, "t", { type: "system", subtype: "init", model: "a" });
  appendEvent(db, "t", { type: "system", subtype: "status", status: "compacting" });
  appendEvent(db, "t", { type: "system", subtype: "init", model: "b" });
  appendEvent(db, "t", { type: "system", subtype: "status", status: null });
  appendEvent(db, "u", { type: "system", subtype: "init", model: "c" });
  expect(latestEventOfType(db, "t", "system", "init")).toEqual({ seq: 3, message: { type: "system", subtype: "init", model: "b" } });
  expect(latestEventOfType(db, "t", "system")?.seq).toBe(4);
  expect(latestEventOfType(db, "t", "result")).toBeNull();
});

test("latestEventWithField finds the newest event of a subtype whose JSON carries the field", () => {
  const db = openDb(":memory:");
  appendEvent(db, "t", { type: "system", subtype: "status", permissionMode: "plan" });
  appendEvent(db, "t", { type: "system", subtype: "status", status: "compacting" });
  appendEvent(db, "t", { type: "system", subtype: "status", permissionMode: null });
  appendEvent(db, "u", { type: "system", subtype: "status", permissionMode: "auto" });
  expect(latestEventWithField(db, "t", "system", "status", "permissionMode")?.seq).toBe(1);
  expect(latestEventWithField(db, "t", "system", "init", "permissionMode")).toBeNull();
});

test("openDb adds the tasks settings column to an older database, once", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { Database } = await import("bun:sqlite");
  const file = `${await mkdtemp("/tmp/meddle-db-")}/old.sqlite`;
  const old = new Database(file, { create: true });
  old.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, state TEXT, session_id TEXT, manifest TEXT, started INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT)");
  old.exec("INSERT INTO tasks (id, title, state) VALUES ('t', 'old', 'idle')");
  old.close();
  openDb(file).close();
  const db = openDb(file);
  expect(db.query<{ name: string }, []>("PRAGMA table_info(tasks)").all().filter(c => c.name === "settings")).toHaveLength(1);
  expect(db.query("SELECT title, settings FROM tasks").get()).toEqual({ title: "old", settings: null });
  db.close();
});

test("listEventsTail leaves out a type:subtype entry without dropping messages missing either", () => {
  const db = openDb(":memory:");
  for (const m of [{ type: "system", subtype: "thinking_tokens" }, { type: "system", subtype: "init" }, { type: "system" }, { foo: 1 }, { type: "tool_progress" }]) appendEvent(db, "t", m);
  expect(listEventsTail(db, "t", { limit: 10, excludeTypes: ["system:thinking_tokens", "tool_progress"] }).map(e => e.seq)).toEqual([2, 3, 4]);
});
