// test/messaging-hooks.test.ts
import { test, expect } from "bun:test";
import { listingWith, messagingHooks, ROUTED, type Messaging } from "../src/engine/messaging-hooks";
import { taskTarget } from "../src/engine/task-target";
import type { SendOutcome, TaskEntry } from "../src/tasks/messenger";

const SELF = "111111111111";
const entry = (id: string, title: string, state = "idle", nodeName = "bravo"): TaskEntry => ({ id, title, state, nodeId: "n", nodeName });
const NO_AGENTS = "This session is aaaaaaaaaaaa [3fa9c1] — the name other sessions use to message it (it is not listed below; a message to it would be a message to yourself).\n\nNo reachable agents — no other Claude session is running on this machine right now (peer messaging itself is available; a session appears here once it is started).";

function messaging(outcome: SendOutcome = { ok: true, how: "delivered", title: "There" }, entries: TaskEntry[] = [entry("222222222222", "There")]) {
  const sent: Array<[string, string]> = [];
  const m: Messaging = {
    selfId: SELF,
    directory: async () => entries,
    send: async (to, text) => { sent.push([to, text]); return outcome; },
  };
  return { m, sent };
}

/** Runs one call through the hooks as Claude Code would: PreToolUse, then (with its input) PostToolUse. */
async function call(m: Messaging, tool: string, input: Record<string, unknown>, response: unknown) {
  const hooks = messagingHooks(m);
  const signal = new AbortController().signal;
  const id = crypto.randomUUID();
  const matches = (matcher: string | undefined) => matcher === undefined || new RegExp(`^(?:${matcher})$`).test(tool);
  let toolInput = input;
  let pre: any = null;
  for (const h of hooks.PreToolUse.filter((x) => matches(x.matcher))) {
    for (const cb of h.hooks) {
      pre = await cb({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: toolInput, tool_use_id: id } as any, id, { signal });
      const updated = pre?.hookSpecificOutput?.updatedInput;
      if (updated !== undefined) toolInput = updated;
    }
  }
  let post: any = null;
  for (const h of hooks.PostToolUse.filter((x) => matches(x.matcher))) {
    for (const cb of h.hooks) post = await cb({ hook_event_name: "PostToolUse", tool_name: tool, tool_input: toolInput, tool_response: response, tool_use_id: id } as any, id, { signal });
  }
  return { toolInput, pre, post };
}

const notFound = { success: false, message: "No agent named 'meddle-routed-message' is reachable.", display: "Not sent" };

test("taskTarget names a task id, with or without a ref", () => {
  expect(taskTarget("222222222222")).toBe("222222222222");
  expect(taskTarget("222222222222 [3fa9c1]")).toBe("222222222222");
  expect(taskTarget("researcher")).toBeNull();
  expect(taskTarget("a4c8b7bfb2ddb27fa")).toBeNull();
  expect(taskTarget(7)).toBeNull();
});

test("a SendMessage to a task id is routed through meddle", async () => {
  const { m, sent } = messaging();
  const { toolInput, pre, post } = await call(m, "SendMessage", { to: "222222222222", message: "hi", summary: "s" }, notFound);
  expect(toolInput.to).toBe(ROUTED);
  // Allowed by the hook itself: auto mode refuses a call a hook changed after its review.
  expect(pre.hookSpecificOutput).toMatchObject({ permissionDecision: "allow" });
  expect(sent).toEqual([["222222222222", "hi"]]);
  expect(post.hookSpecificOutput).toEqual({
    hookEventName: "PostToolUse",
    updatedToolOutput: { success: true, message: "Sent to There (222222222222).", display: "Sent to There (222222222222)." },
  });
});

test("waking and queued say what happens next", async () => {
  const woke = await call(messaging({ ok: true, how: "waking", title: "There" }).m, "SendMessage", { to: "222222222222", message: "hi" }, notFound);
  expect(woke.post.hookSpecificOutput.updatedToolOutput.message).toBe("Sent to There (222222222222); it was idle and starts a turn for it.");
  const queued = await call(messaging({ ok: true, how: "queued", title: "There" }).m, "SendMessage", { to: "222222222222", message: "hi" }, notFound);
  expect(queued.post.hookSpecificOutput.updatedToolOutput.message).toBe("Queued for There (222222222222); it gets it on its next turn.");
});

test("a SendMessage to a subagent name is left alone", async () => {
  const { m, sent } = messaging();
  const { toolInput, pre, post } = await call(m, "SendMessage", { to: "researcher", message: "hi" }, { success: true, message: "ok" });
  expect(toolInput.to).toBe("researcher");
  expect(pre?.hookSpecificOutput).toBeUndefined();
  expect(post?.hookSpecificOutput).toBeUndefined();
  expect(sent).toEqual([]);
});

test("a task the directory does not list is still routed", async () => {
  const { m, sent } = messaging({ ok: false, reason: "no task 333333333333" }, []);
  const { post } = await call(m, "SendMessage", { to: "333333333333 [3fa9c1]", message: "hi" }, notFound);
  expect(sent).toEqual([["333333333333", "hi"]]);
  expect(post.hookSpecificOutput.updatedToolOutput).toEqual({ success: false, message: "Not sent: no task 333333333333.", display: "Not sent: no task 333333333333." });
});

test("notify_when_idle to a task is refused without sending", async () => {
  const { m, sent } = messaging();
  const { post } = await call(m, "SendMessage", { to: "222222222222", notify_when_idle: true }, notFound);
  expect(sent).toEqual([]);
  expect(post.hookSpecificOutput.updatedToolOutput.message).toBe("Not sent: notify_when_idle is not available for tasks.");
});

test("ListAgents lists the pool's tasks", async () => {
  const { m } = messaging(undefined, [entry("222222222222", "There", "running"), entry("333333333333", "Elsewhere", "idle", "charlie")]);
  const { post } = await call(m, "ListAgents", {}, { listing: NO_AGENTS, sections: [], notes: [] });
  const out = post.hookSpecificOutput.updatedToolOutput;
  expect(out.sections).toEqual([]);
  expect(out.listing).toContain("- 222222222222 — There · bravo · busy");
  expect(out.listing).toContain("- 333333333333 — Elsewhere · charlie · idle");
});

test("listingWith adds the pool's tasks and drops the no-agents line", () => {
  const out = listingWith(NO_AGENTS, [entry("222222222222", "There")], SELF);
  expect(out).toStartWith("This session is aaaaaaaaaaaa [3fa9c1]");
  expect(out).not.toContain("No reachable agents");
  expect(out).toEndWith("- 222222222222 — There · bravo · idle");
});

test("listingWith leaves out the task itself and ones already listed", () => {
  const listing = "This session is 111111111111 [3fa9c1] — …\n\nOther sessions:\n- 222222222222 [ab12cd] — busy";
  expect(listingWith(listing, [entry(SELF, "Me"), entry("222222222222", "There")], SELF)).toBe(listing);
  expect(listingWith(NO_AGENTS, [], SELF)).toBe(NO_AGENTS);
});
