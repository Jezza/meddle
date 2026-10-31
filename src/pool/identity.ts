import { chmod, readFile, writeFile } from "node:fs/promises";
import { EndpointId, SecretKey } from "@number0/iroh";
import { paths, type NodeConfig } from "../config";
import { isNodeId } from "./ids";

export { isNodeId, shortId } from "./ids";

/** This node's iroh identity: `id` is the lowercase hex of its public key, `secret` its 32-byte secret key. */
export type Identity = { id: string; secret: Uint8Array };

/** 32 bytes as lowercase hex: the form of both a node id and the secret key file. */
const HEX_32 = /^[0-9a-f]{64}$/;

export function hexOf(id: EndpointId): string {
  return Buffer.from(id.toBytes()).toString("hex");
}

export function endpointIdOf(hex: string): EndpointId {
  if (!isNodeId(hex)) throw new Error("not a node id");
  return EndpointId.fromBytes(Array.from(Buffer.from(hex, "hex")));
}

async function readSecret(file: string): Promise<Uint8Array | null> {
  let text: string;
  try {
    text = (await readFile(file, "utf8")).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (!HEX_32.test(text)) throw new Error(`${file} is not a 64-character hex iroh secret key`);
  return new Uint8Array(Buffer.from(text, "hex"));
}

/** Reads the node's iroh secret key, generating it (mode 600) on first use. */
export async function loadOrCreateIdentity(cfg: NodeConfig): Promise<Identity> {
  const file = paths(cfg).irohKey;
  let secret = await readSecret(file);
  if (secret === null) {
    secret = new Uint8Array(SecretKey.generate().toBytes());
    await writeFile(file, Buffer.from(secret).toString("hex"), { mode: 0o600 });
    await chmod(file, 0o600);
  }
  return { id: hexOf(SecretKey.fromBytes(Array.from(secret)).public()), secret };
}
