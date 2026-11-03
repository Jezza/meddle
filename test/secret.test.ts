// test/secret.test.ts — the pool secret: derivation, proofs, and what a secret or a name may be.
import { test, expect } from "bun:test";
import { Topic } from "iroh-lighthouse";
import { MIN_SECRET, generateSecret, poolKey, poolNameProblem, poolSecretProblem, proofFor, verifyProof } from "../src/pool/secret";

const A = "a".repeat(64);
const B = "b".repeat(64);
const SECRET = "correct-horse-battery-staple";

test("the pool id follows from the name and the secret, stretched: not the raw topic of either", () => {
  const key = poolKey("default", SECRET);
  expect(key.id).toMatch(/^[0-9a-f]{64}$/);
  expect(poolKey("default", SECRET)).toBe(key);
  expect(poolKey("default", SECRET).id).toBe(key.id);
  expect(poolKey("lab", SECRET).id).not.toBe(key.id);
  expect(poolKey("default", `${SECRET}!`).id).not.toBe(key.id);
  // Not the client's own fast derivation of the name and secret: the secret is run through scrypt first.
  expect(Topic.withSecret("meddle/default", SECRET).id).not.toBe(key.id);
  expect(Topic.withSecret("meddle/1/default", SECRET).id).not.toBe(key.id);
});

test("a proof is good for one pair, one way, under one pool, and junk never verifies", () => {
  const key = poolKey("default", SECRET);
  const proof = proofFor(key, A, B);
  expect(proof).toMatch(/^[A-Za-z0-9_-]{86}$/);
  expect(verifyProof(key.id, A, B, proof)).toBe(true);
  expect(verifyProof(key.id, B, A, proof)).toBe(false);
  expect(verifyProof(poolKey("default", "another-secret-of-16").id, A, B, proof)).toBe(false);
  expect(verifyProof(key.id, A, B, "x")).toBe(false);
  expect(verifyProof(key.id, A, B, `${proof.slice(0, 85)}!`)).toBe(false);
  expect(verifyProof("zz", A, B, proof)).toBe(false);
  expect(verifyProof("", A, B, proof)).toBe(false);
});

test("a secret is 16 to 4096 printable characters; a name is 1 to 64 of letters, digits, '.', '_' and '-'", () => {
  expect(poolSecretProblem("")).toBe("the secret is empty");
  expect(poolSecretProblem("hunter2")).toBe(`the secret is shorter than ${MIN_SECRET} characters (use --generate)`);
  expect(poolSecretProblem("a".repeat(15))).toContain("shorter");
  expect(poolSecretProblem("a".repeat(16))).toBeNull();
  expect(poolSecretProblem("a".repeat(4096))).toBeNull();
  expect(poolSecretProblem("a".repeat(4097))).toBe("the secret is longer than 4096 characters");
  expect(poolSecretProblem("sixteen chars ok\tx")).toBe("the secret holds a control character");
  expect(poolSecretProblem("pässwörd with ünicode is fine")).toBeNull();
  expect(poolNameProblem("default")).toBeNull();
  expect(poolNameProblem("lab.west_2-a")).toBeNull();
  expect(poolNameProblem("")).not.toBeNull();
  expect(poolNameProblem("a/b")).not.toBeNull();
  expect(poolNameProblem("x".repeat(65))).not.toBeNull();
});

test("a generated secret is 32 random bytes as base64url", () => {
  const one = generateSecret();
  expect(one).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(generateSecret()).not.toBe(one);
  expect(poolSecretProblem(one)).toBeNull();
});
