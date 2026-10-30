import { test, expect } from "bun:test";
import { openDb } from "../src/store/db";
import { SqliteSessionStore } from "../src/store/session-store";
test("append dedupes on uuid; load, subkeys, delete", async () => {
  const s = new SqliteSessionStore(openDb(":memory:"));
  const key = { projectKey: "p", sessionId: "s" };
  await s.append(key, [{ type: "user", uuid: "a" }, { type: "assistant", uuid: "b" }]);
  await s.append(key, [{ type: "assistant", uuid: "b" }, { type: "result", uuid: "c", timestamp: "2026-10-30T10:00:00.000Z" }]);
  expect((await s.loadStored(key))!.map(e => e.uuid)).toEqual(["a", "b", "c"]);
  expect(await s.load(key)).toBeNull(); // always: the SDK must resume from the task's own config dir
  await s.append({ ...key, subpath: "subagents/agent-1" }, [{ type: "user", uuid: "d" }]);
  expect(await s.listSubkeys!(key)).toEqual(["subagents/agent-1"]);
  const [listed] = await s.listSessions!("p");
  expect(listed.sessionId).toBe("s"); expect(Number.isInteger(listed.mtime)).toBe(true);
  await s.delete!(key);
  expect(await s.loadStored(key)).toBeNull();
  expect(await s.listSubkeys!(key)).toEqual([]);
});

test("entries without uuid always insert; deleting a subpath key leaves the rest", async () => {
  const s = new SqliteSessionStore(openDb(":memory:"));
  const key = { projectKey: "p", sessionId: "s" };
  await s.append(key, [{ type: "custom-title", title: "x" }, { type: "custom-title", title: "x" }]);
  expect(await s.loadStored(key)).toEqual([{ type: "custom-title", title: "x" }, { type: "custom-title", title: "x" }]);
  const sub1 = { ...key, subpath: "subagents/agent-1" };
  const sub2 = { ...key, subpath: "subagents/agent-2" };
  await s.append(sub1, [{ type: "user", uuid: "d" }]);
  await s.append(sub2, [{ type: "user", uuid: "e" }]);
  await s.delete!(sub1);
  expect(await s.loadStored(sub1)).toBeNull();
  expect((await s.loadStored(sub2))!.map(e => e.uuid)).toEqual(["e"]);
  expect((await s.loadStored(key))!.length).toBe(2);
  expect(await s.listSubkeys!(key)).toEqual(["subagents/agent-2"]);
});
