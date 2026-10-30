import { test, expect } from "bun:test";
import { openDb } from "../src/store/db";
import { appendEvent, listEvents } from "../src/store/events";
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
