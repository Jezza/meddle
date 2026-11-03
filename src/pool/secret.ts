// The pool secret: what makes a node a member. A pool is a name and a secret. The secret is stretched with scrypt
// (salted with the versioned topic name) and both derive the lighthouse topic (`Topic.withSecret`, an ed25519
// keypair), whose public key is the pool id: safe to show and to log, and what a node proves it holds the secret
// behind by signing with the topic key. That is the same key the lighthouse requires on every announce and lookup, so
// a node the lighthouse lists and a node that proves itself to a peer are the same thing. The pool id is public (the
// lighthouse sees it, `status` prints it), so the stretching is what stands between it and a guessed secret: a
// generated secret (`generateSecret`) is what to use; a chosen one is accepted from 16 characters.
import { createPublicKey, randomBytes, scryptSync, verify as verifySignature } from "node:crypto";
import { Topic } from "iroh-lighthouse";

export const DEFAULT_POOL_NAME = "default";
/** The fewest characters a secret may have (after trimming); a generated one has 43. */
export const MIN_SECRET = 16;
/** The longest secret `meddle pool secret` takes, in characters (after trimming). */
export const MAX_SECRET = 4096;
/** The topic name's version: the derivation (scrypt parameters, then the topic key) changes only with it. */
const TOPIC_VERSION = "meddle/1";
/** scrypt: 128 MiB and about a quarter of a second per derivation on a laptop, once per process and secret. */
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
const POOL_ID = /^[0-9a-f]{64}$/;
/** A 64-byte ed25519 signature as base64url, no padding. */
const PROOF = /^[A-Za-z0-9_-]{86}$/;
/** What a proof signs: this domain, the prover's node id and the verifier's, so a proof is good for one pair, one way. */
const ADMIT_DOMAIN = "meddle/admit/1";
/** The DER prefix that makes a raw ed25519 public key an SPKI, the one form node's crypto imports. */
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

const encoder = new TextEncoder();
/** Keys derived in this process, by name and secret: the derivation is slow by design. */
const derived = new Map<string, PoolKey>();

/** A pool as derived from its name and secret: `id` is the topic's public key, `topic` what announces and proofs sign with. */
export type PoolKey = { name: string; id: string; topic: Topic };

/** Why `name` cannot name a pool, or null: 1 to 64 of letters, digits, `.`, `_` and `-`. */
export function poolNameProblem(name: string): string | null {
  return NAME.test(name) ? null : "a pool name is 1 to 64 letters, digits, '.', '_' or '-'";
}

/** Why `secret` (trimmed) cannot be a pool secret, or null: 16 to 4096 characters, no control characters. */
export function poolSecretProblem(secret: string): string | null {
  if (secret === "") return "the secret is empty";
  if (CONTROL.test(secret)) return "the secret holds a control character";
  if (secret.length < MIN_SECRET) return `the secret is shorter than ${MIN_SECRET} characters (use --generate)`;
  if (secret.length > MAX_SECRET) return `the secret is longer than ${MAX_SECRET} characters`;
  return null;
}

/** A fresh secret: 32 random bytes as base64url (43 characters). */
export function generateSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** The pool's key: the secret stretched with scrypt under the versioned topic name, then the topic derived from both. */
export function poolKey(name: string, secret: string): PoolKey {
  const memo = `${name}\n${secret}`;
  const known = derived.get(memo);
  if (known !== undefined) return known;
  const topicName = `${TOPIC_VERSION}/${name}`;
  const stretched = scryptSync(secret, topicName, 32, SCRYPT);
  const topic = Topic.withSecret(topicName, new Uint8Array(stretched));
  const key = { name, id: topic.id, topic };
  derived.set(memo, key);
  return key;
}

function admitMessage(from: string, to: string): Uint8Array {
  return encoder.encode(`${ADMIT_DOMAIN}.${from}.${to}`);
}

/** `from`'s proof to `to` that it holds the pool secret: the admit message signed with the topic key, as base64url. */
export function proofFor(key: PoolKey, from: string, to: string): string {
  return Buffer.from(key.topic.sign(admitMessage(from, to))).toString("base64url");
}

/** Whether `proof` is `from`'s proof to `to` under the pool whose id (topic public key) is `poolId`. Never throws. */
export function verifyProof(poolId: string, from: string, to: string, proof: string): boolean {
  if (!POOL_ID.test(poolId) || !PROOF.test(proof)) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(poolId, "hex")]), format: "der", type: "spki" });
    return verifySignature(null, admitMessage(from, to), key, Buffer.from(proof, "base64url"));
  } catch {
    return false;
  }
}
