// test/git-diff.test.ts
import { test, expect } from "bun:test";
import { parseGitDiff } from "../src/dashboard/ui/git-diff";

const lines = (...l: string[]) => l.join("\n") + "\n";

const modified = lines(
  "diff --git a/f.md b/f.md",
  "index 422c2b7ab3..7be73ce3c1 100644",
  "--- a/f.md",
  "+++ b/f.md",
  "@@ -1,2 +1,3 @@",
  " a",
  "-b",
  "+B",
  "+c",
);

const added = lines(
  "diff --git a/g.md b/g.md",
  "new file mode 100644",
  "index 0000000000..587be6b4c3",
  "--- /dev/null",
  "+++ b/g.md",
  "@@ -0,0 +1,1 @@",
  "+x",
);

test("parses a modified file", () => {
  expect(parseGitDiff(modified)).toEqual([{
    path: "f.md", status: "modified", binary: false,
    hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [" a", "-b", "+B", "+c"] }],
    added: 2, removed: 1,
  }]);
});

test("parses a new file with git's zero start", () => {
  expect(parseGitDiff(added)).toEqual([{
    path: "g.md", status: "added", binary: false,
    hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ["+x"] }],
    added: 1, removed: 0,
  }]);
});

test("parses a deleted file", () => {
  const text = lines(
    "diff --git a/h.md b/h.md",
    "deleted file mode 100644",
    "index 9f2a1b3c4d..0000000000",
    "--- a/h.md",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-p",
    "-q",
  );
  expect(parseGitDiff(text)).toEqual([{
    path: "h.md", status: "deleted", binary: false,
    hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 0, lines: ["-p", "-q"] }],
    added: 0, removed: 2,
  }]);
});

test("parses a rename and a binary file", () => {
  const text = lines(
    "diff --git a/a.md b/b.md",
    "rename from a.md",
    "rename to b.md",
    "diff --git a/p.png b/p.png",
    "index 1111111111..2222222222 100644",
    "Binary files a/p.png and b/p.png differ",
  );
  expect(parseGitDiff(text)).toEqual([
    { path: "b.md", oldPath: "a.md", status: "renamed", binary: false, hunks: [], added: 0, removed: 0 },
    { path: "p.png", status: "modified", binary: true, hunks: [], added: 0, removed: 0 },
  ]);
});

test("keeps the no-newline marker out of the counts", () => {
  const text = lines(
    "diff --git a/z.md b/z.md",
    "index 1111111111..2222222222 100644",
    "--- a/z.md",
    "+++ b/z.md",
    "@@ -1,1 +1,1 @@",
    "-z",
    "\\ No newline at end of file",
    "+z",
  );
  const [patch] = parseGitDiff(text);
  expect(patch!.hunks[0]!.lines).toEqual(["-z", "\\ No newline at end of file", "+z"]);
  expect(patch!.added).toBe(1);
  expect(patch!.removed).toBe(1);
});

test("parses several files in order", () => {
  const two = lines(
    "diff --git a/f.md b/f.md",
    "index 1111111111..2222222222 100644",
    "--- a/f.md",
    "+++ b/f.md",
    "@@ -1,1 +1,1 @@",
    "-a",
    "+b",
    "@@ -10,2 +10,1 @@",
    " c",
    "-d",
  );
  const patches = parseGitDiff(two + added);
  expect(patches.map((p) => p.path)).toEqual(["f.md", "g.md"]);
  expect(patches[0]!.hunks).toEqual([
    { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] },
    { oldStart: 10, oldLines: 2, newStart: 10, newLines: 1, lines: [" c", "-d"] },
  ]);
  expect(patches[0]!.added).toBe(1);
  expect(patches[0]!.removed).toBe(2);
  expect(patches[1]!.status).toBe("added");
});

test("parses empty text as no files", () => {
  expect(parseGitDiff("")).toEqual([]);
});

test("parseGitDiff unquotes git-quoted paths", () => {
  const quoted = (q: string) => lines(
    `diff --git "a/${q}" "b/${q}"`,
    "index 1111111111..2222222222 100644",
    `--- "a/${q}"`,
    `+++ "b/${q}"`,
    "@@ -1,1 +1,1 @@",
    "-a",
    "+b",
  );
  expect(parseGitDiff(quoted("na\\303\\257ve.md"))[0]!.path).toBe("naïve.md");
  expect(parseGitDiff(quoted("a\\tb.md"))[0]!.path).toBe("a\tb.md");
  expect(parseGitDiff(quoted('say \\"hi\\" \\\\ there.md'))[0]!.path).toBe('say "hi" \\ there.md');
  // The header alone names the file when there are no ---/+++ lines.
  expect(parseGitDiff(lines('diff --git "a/na\\303\\257ve.md" "b/na\\303\\257ve.md"', "old mode 100644", "new mode 100755"))[0]!.path)
    .toBe("naïve.md");
  // A quoted rename.
  const renamed = parseGitDiff(lines('diff --git "a/\\303\\251.md" b/e.md', 'rename from "\\303\\251.md"', "rename to e.md"))[0]!;
  expect(renamed.oldPath).toBe("é.md");
  expect(renamed.path).toBe("e.md");
});
