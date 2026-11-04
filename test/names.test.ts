// test/names.test.ts — the name a task gets with neither a title nor a prompt.
import { test, expect } from "bun:test";
import { taskName } from "../src/tasks/names";

test("a task name is two different adjectives and a noun", () => {
  for (let i = 0; i < 200; i++) {
    const words = taskName().split(" ");
    expect(words).toHaveLength(3);
    expect(words[0]).not.toBe(words[1]);
    for (const w of words) expect(w).toMatch(/^[a-z]+$/);
  }
  // A repeated adjective is drawn again: picks 0, 0, 1 give the first two adjectives, then the second noun.
  const picks = [0, 0, 1, 1];
  expect(taskName(() => picks.shift()!)).toBe("amber ancient beacon");
});

test("a task's title: the one given, else the prompt's first line (60 characters at most), else a generated name", async () => {
  const { taskTitle } = await import("../src/tasks/names");
  expect(taskTitle("Mine", "Do the thing")).toBe("Mine");
  expect(taskTitle(undefined, "  Do the thing\nand more")).toBe("Do the thing");
  expect(taskTitle("  ", `${"x".repeat(70)}`)).toBe("x".repeat(60));
  expect(taskTitle(null, null)).toMatch(/^[a-z]+ [a-z]+ [a-z]+$/);
  expect(taskTitle("", "   ")).toMatch(/^[a-z]+ [a-z]+ [a-z]+$/);
});
