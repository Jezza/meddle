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

test("a task's title: the one given, else the model's name for its prompt, else the prompt's first line, else a generated name", async () => {
  const { taskTitle } = await import("../src/tasks/names");
  const asked: string[] = [];
  const ask = (reply: string | null) => async (prompt: string) => { asked.push(prompt); return reply; };
  // A title given: no model is asked.
  expect(await taskTitle("Mine", "Do the thing", ask("Other"))).toBe("Mine");
  expect(asked).toEqual([]);
  // A prompt: the model's title, cleaned; it is shown the trimmed prompt.
  expect(await taskTitle(undefined, "  Do the thing\nand more ", ask('"Doing the thing."'))).toBe("Doing the thing");
  expect(asked).toEqual(["Do the thing\nand more"]);
  // The model says nothing usable, fails or is not there: the prompt's first line, 60 characters at most.
  expect(await taskTitle(undefined, "  Do the thing\nand more", ask("  \n"))).toBe("Do the thing");
  expect(await taskTitle(null, "Do the thing", async () => { throw new Error("no"); })).toBe("Do the thing");
  expect(await taskTitle("  ", `${"x".repeat(70)}`)).toBe("x".repeat(60));
  // No prompt: a generated name, and no model asked.
  asked.length = 0;
  expect(await taskTitle(null, null, ask("x"))).toMatch(/^[a-z]+ [a-z]+ [a-z]+$/);
  expect(await taskTitle("", "   ", ask("x"))).toMatch(/^[a-z]+ [a-z]+ [a-z]+$/);
  expect(asked).toEqual([]);
});

test("a model's title is cleaned: its first line, without quotes, markdown, a label or a full stop, 60 characters at most", async () => {
  const { cleanTitle } = await import("../src/tasks/names");
  expect(cleanTitle("Fix the flaky build")).toBe("Fix the flaky build");
  expect(cleanTitle("\n  Fix the build.  \nBecause it fails")).toBe("Fix the build");
  expect(cleanTitle("**Fix the build**")).toBe("Fix the build");
  expect(cleanTitle("“Fix the build”")).toBe("Fix the build");
  expect(cleanTitle("# Title: 'Fix the build'")).toBe("Fix the build");
  expect(cleanTitle("Bump to v1.2")).toBe("Bump to v1.2");
  expect(cleanTitle("y".repeat(80))).toBe("y".repeat(60));
  expect(cleanTitle('""')).toBeNull();
  expect(cleanTitle("  ")).toBeNull();
  expect(cleanTitle(null)).toBeNull();
});
