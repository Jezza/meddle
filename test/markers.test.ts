import { expect, test } from "bun:test";
import { unmarkConflicts } from "../src/scopes/markers";

const THREE = `a
b
<<<<<<< conflict 1 of 1
%%%%%%% diff from: lvzwumzs c88af257 "base"
\\\\\\\\\\\\\\        to: mtzopwwt 32eba7b6 "z"
+z
%%%%%%% diff from: lvzwumzs c88af257 "base"
\\\\\\\\\\\\\\        to: lrtnslpl 4f331288 "y"
+y
+++++++ osxrxmwl 0a4b1166 "x"
x
>>>>>>> conflict 1 of 1 ends
tail
`;

const TWO = `a
<<<<<<< conflict 1 of 1
%%%%%%% diff from: lvzwumzs c88af257 "base"
\\\\\\\\\\\\\\        to: mtzopwwt 32eba7b6 "z"
-b
+B1
 c
+++++++ lrtnslpl 4f331288 "y"
b
c
y
>>>>>>> conflict 1 of 1 ends
`;

test("a three-sided jj conflict becomes every side's lines, once", () => {
  expect(unmarkConflicts(THREE)).toBe("a\nb\nz\ny\nx\ntail\n");
});

test("a diff section's edits merge with the other side's", () => {
  expect(unmarkConflicts(TWO)).toBe("a\nB1\nc\ny\n");
});

test("snapshot-style sections are read too", () => {
  const text = "<<<<<<< conflict 1 of 1\n+++++++ side 1\nx\n------- base\n\n+++++++ side 2\ny\n>>>>>>> conflict 1 of 1 ends\n";
  expect(unmarkConflicts(text)).toBe("x\ny\n");
});

test("text without markers, or with a block that never ends, is left alone", () => {
  expect(unmarkConflicts("plain\n")).toBeNull();
  expect(unmarkConflicts("<<<<<<< conflict 1 of 1\n+++++++ s\nx\n")).toBeNull();
});
