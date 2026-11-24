// test/names.test.ts — the title a task gets when it is given none.
import { test, expect } from "bun:test";
import type { Prompt } from "../src/blobs/attachment";
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

test("a new task's title is the one given, else a generated name", async () => {
  const { initialTitle } = await import("../src/tasks/names");
  expect(initialTitle("Mine")).toBe("Mine");
  for (const none of [undefined, null, "", "   "]) expect(initialTitle(none)).toMatch(/^[a-z]+ [a-z]+ [a-z]+$/);
});

test("a prompt's title: the model's name for it, else its text's first line; none for a blank prompt", async () => {
  const { promptTitle } = await import("../src/tasks/names");
  const asked: Prompt[] = [];
  const ask = (reply: string | null) => async (prompt: Prompt) => { asked.push(prompt); return reply; };
  const text = (t: string): Prompt => ({ text: t, attachments: [] });
  // The model's title, cleaned; it is shown the prompt with its text trimmed.
  expect(await promptTitle(text("  Do the thing\nand more "), ask('"Doing the thing."'))).toBe("Doing the thing");
  expect(asked).toEqual([text("Do the thing\nand more")]);
  // The model says nothing usable, fails or is not there: the text's first line, 60 characters at most.
  expect(await promptTitle(text("  Do the thing\nand more"), ask("  \n"))).toBe("Do the thing");
  expect(await promptTitle(text("Do the thing"), async () => { throw new Error("no"); })).toBe("Do the thing");
  expect(await promptTitle(text(`${"x".repeat(70)}`))).toBe("x".repeat(60));
  // A blank prompt: no title, and no model asked.
  asked.length = 0;
  expect(await promptTitle(text("   "), ask("x"))).toBeNull();
  expect(asked).toEqual([]);
  // A blank text with files: the model is asked, and without its title there is none.
  const shot = { hash: "a".repeat(64), name: "shot.png", type: "image/png", size: 3 };
  expect(await promptTitle({ text: " ", attachments: [shot] }, ask("A login form"))).toBe("A login form");
  expect(asked).toEqual([{ text: "", attachments: [shot] }]);
  expect(await promptTitle({ text: " ", attachments: [shot] }, ask(null))).toBeNull();
  expect(await promptTitle({ text: " ", attachments: [shot] })).toBeNull();
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
