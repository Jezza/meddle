// Node ids as text, with no dependencies: the browser bundle imports this (never `identity.ts`, which loads iroh).

/** A node id: the lowercase hex of its iroh public key. */
const NODE_ID = /^[0-9a-f]{64}$/;

export function isNodeId(text: string): boolean {
  return NODE_ID.test(text);
}

/** The prefix of a node id that the CLI and the UI print. */
export function shortId(id: string): string {
  return id.slice(0, 10);
}
