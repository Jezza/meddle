import Type from "typebox";
import Value from "typebox/value";
import type { BiStream, Connection, Endpoint } from "@number0/iroh";
import { RosterRowSchema, WireAddrSchema } from "../state/contracts";
import { ALPN_JOIN, StreamReader, writeLine } from "./frames";
import { hexOf, isNodeId, type Identity } from "./identity";
import { fromEndpoint, toEndpointAddr } from "./net";
import type { NodeSummary, PoolStore, RosterRow, WireAddr } from "./store";

/*
 * Invite tickets and the join handshake on ALPN_JOIN. The joiner opens one stream and sends one request line; the
 * inviter answers with one reply line and finishes its side. QUIC's close does not wait for stream data to be
 * delivered, so the joiner closes the connection once it has read the reply and the inviter waits for that close
 * (at most 5 s) before closing its end. Nothing in a request or a reply is ever logged: the reply carries the pool
 * secret.
 */

/** What an invite ticket holds: a single-use code and how to reach the inviter. Never the pool secret. */
export type Ticket = { v: 1; code: string; inviter: WireAddr };

export const TICKET_PREFIX = "meddle1";

export type JoinRequest = { t: "join"; code: string; addr: WireAddr; hostname: string; version: string; claudeCodeVersion: string };

export type JoinReply =
  | { t: "welcome"; pool: { id: string; secret: string }; roster: RosterRow[] }
  | { t: "refused"; reason: string };

export type JoinHostDeps = {
  store: PoolStore; selfId: string;
  /** This node's endpoint: its address goes into the welcome's self row. */
  endpoint: Endpoint;
  onAdmitted(nodeId: string, addr: WireAddr): void;
};

export type JoinDeps = {
  endpoint: Endpoint; store: PoolStore; identity: Identity; summary(): NodeSummary | Promise<NodeSummary>;
  /** How long the whole handshake may take; default 10000. */
  timeoutMs?: number;
};

const TicketSchema = Type.Object({ v: Type.Literal(1), code: Type.String({ minLength: 1 }), inviter: WireAddrSchema });

const JoinRequestSchema = Type.Object({
  t: Type.Literal("join"),
  code: Type.String(),
  addr: WireAddrSchema,
  hostname: Type.String({ minLength: 1 }),
  version: Type.String(),
  claudeCodeVersion: Type.String(),
});

const JoinReplySchema = Type.Union([
  Type.Object({
    t: Type.Literal("welcome"),
    pool: Type.Object({ id: Type.String({ minLength: 1 }), secret: Type.String({ minLength: 1 }) }),
    roster: Type.Array(RosterRowSchema),
  }),
  Type.Object({ t: Type.Literal("refused"), reason: Type.String() }),
]);

/** The longest join request line the inviter reads, in bytes. */
const MAX_REQUEST = 4096;
/** How long the inviter waits for the request line, and then for the joiner to close. */
const HANDSHAKE_MS = 5000;
const LINGER_MS = 5000;
const DEFAULT_TIMEOUT_MS = 10_000;
const BYE = Array.from(new TextEncoder().encode("bye"));
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const NOT_A_TICKET = "not a meddle invite ticket";
const BAD_REQUEST = "bad join request";
const BAD_INVITE = "unknown or expired invite";
const NOT_A_MEMBER = "inviter is not a member";

const wireAddr = (a: WireAddr): WireAddr => ({ id: a.id, relay: a.relay, direct: [...a.direct] });

export function encodeTicket(ticket: Ticket): string {
  return TICKET_PREFIX + Buffer.from(JSON.stringify(ticket)).toString("base64url");
}

/** Parses a ticket (surrounding whitespace allowed); throws "not a meddle invite ticket" for anything else. */
export function decodeTicket(text: string): Ticket {
  const trimmed = text.trim();
  const body = trimmed.slice(TICKET_PREFIX.length);
  if (!trimmed.startsWith(TICKET_PREFIX) || !BASE64URL.test(body)) throw new Error(NOT_A_TICKET);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new Error(NOT_A_TICKET);
  }
  if (!Value.Check(TicketSchema, value) || !isNodeId(value.inviter.id)) throw new Error(NOT_A_TICKET);
  return { v: 1, code: value.code, inviter: wireAddr(value.inviter) };
}

/** A new single-use invite as ticket text, naming this endpoint's current address. */
export function createInvite(store: PoolStore, endpoint: Endpoint): string {
  return encodeTicket({ v: 1, code: store.createInvite().code, inviter: fromEndpoint(endpoint) });
}

/** Settles as `promise` does, or rejects with `message` after `ms` (then `onTimeout` runs first). */
async function within<T>(promise: Promise<T>, ms: number, message: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(message));
    }, ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Accepts the joiner's stream and reads its request: null when it is malformed or names another node's address. */
async function readRequest(conn: Connection, remoteId: string): Promise<{ stream: BiStream; request: JoinRequest | null }> {
  const stream = await conn.acceptBi();
  let line: string | null;
  try {
    line = await new StreamReader(stream.recv).readLine(MAX_REQUEST);
  } catch {
    return { stream, request: null };
  }
  if (line === null) return { stream, request: null };
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { stream, request: null };
  }
  if (!Value.Check(JoinRequestSchema, value) || value.addr.id !== remoteId) return { stream, request: null };
  return { stream, request: value };
}

/**
 * Serves one connection on ALPN_JOIN: reads one request line (≤ 4 KiB) from its first stream, answers, waits for the
 * joiner to close (≤ 5 s), then closes. A node that is not itself a member refuses with `inviter is not a member`.
 */
export async function handleJoin(conn: Connection, deps: JoinHostDeps): Promise<void> {
  const nodeId = hexOf(conn.remoteId());
  try {
    let received: { stream: BiStream; request: JoinRequest | null };
    try {
      received = await within(readRequest(conn, nodeId), HANDSHAKE_MS, "no join request");
    } catch {
      // No stream or no line in time, or the joiner went away: nothing to answer.
      return;
    }
    const { stream, request } = received;
    let reply: JoinReply;
    let admitted: WireAddr | null = null;
    if (request === null) {
      reply = { t: "refused", reason: BAD_REQUEST };
    } else if (!deps.store.isMember(deps.selfId)) {
      // A node removed from its pool admits nobody into it; the invite stays unused.
      reply = { t: "refused", reason: NOT_A_MEMBER };
    } else {
      if (!deps.store.consumeInvite(request.code)) {
        reply = { t: "refused", reason: BAD_INVITE };
      } else {
        const now = new Date().toISOString();
        admitted = wireAddr(request.addr);
        const { hostname, version, claudeCodeVersion } = request;
        deps.store.upsert({
          nodeId, hostname, status: "member", updatedAt: now, addedBy: deps.selfId,
          summary: { hostname, version, claudeCodeVersion, hostsTasks: false, taskCount: 0 },
          lastSeenAt: now, lastAddr: admitted,
        });
        const selfAddr = fromEndpoint(deps.endpoint);
        const pool = deps.store.pool();
        reply = {
          t: "welcome",
          pool: { id: pool.poolId, secret: pool.poolSecret },
          roster: deps.store.roster().map((row) => (row.nodeId === deps.selfId ? { ...row, lastAddr: selfAddr } : row)),
        };
      }
    }
    try {
      await writeLine(stream.send, JSON.stringify(reply));
      await stream.send.finish();
    } finally {
      if (admitted !== null) deps.onAdmitted(nodeId, admitted);
    }
    await within(conn.closed(), LINGER_MS, "joiner did not close").catch(() => {});
  } finally {
    conn.close(0n, BYE);
  }
}

function alreadyPooled(others: number): Error {
  return new Error(others === 1
    ? "already in a pool with 1 other node; remove it first"
    : `already in a pool with ${others} other nodes; remove them first`);
}

/** Validates the inviter's reply line; a refusal throws `refused: <reason>`. */
function welcomeOf(line: string | null, selfId: string): Extract<JoinReply, { t: "welcome" }> {
  if (line === null) throw new Error("the inviter closed without answering");
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("bad reply from the inviter");
  }
  if (!Value.Check(JoinReplySchema, value)) throw new Error("bad reply from the inviter");
  if (value.t === "refused") throw new Error(`refused: ${value.reason}`);
  const roster = value.roster as RosterRow[];
  const listed = roster.every((row) => isNodeId(row.nodeId)) && roster.some((row) => row.nodeId === selfId && row.status === "member");
  if (!listed) throw new Error("bad reply from the inviter");
  return { ...value, roster };
}

/**
 * Joins the pool a ticket names. Rejects when this node is a member of a pool with other members, or the inviter
 * refuses; a node removed from its pool is in no pool with anyone and may join.
 */
export async function joinPool(ticket: Ticket, deps: JoinDeps): Promise<{ poolId: string; members: number; addrs: WireAddr[] }> {
  const selfId = deps.identity.id;
  if (ticket.inviter.id === selfId) throw new Error("this is this node's own invite");
  const others = deps.store.isMember(selfId) ? deps.store.members().filter((row) => row.nodeId !== selfId).length : 0;
  if (others > 0) throw alreadyPooled(others);
  const summary = await deps.summary();
  const request: JoinRequest = {
    t: "join", code: ticket.code, addr: fromEndpoint(deps.endpoint),
    hostname: summary.hostname, version: summary.version, claudeCodeVersion: summary.claudeCodeVersion,
  };
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let conn: Connection | null = null;
  let expired = false;
  const exchange = async (): Promise<string | null> => {
    const c = await deps.endpoint.connect(toEndpointAddr(ticket.inviter), ALPN_JOIN);
    conn = c;
    try {
      if (expired) return null;
      const { send, recv } = await c.openBi();
      await writeLine(send, JSON.stringify(request));
      await send.finish();
      return await new StreamReader(recv).readLine();
    } finally {
      c.close(0n, BYE);
    }
  };
  const line = await within(exchange(), timeoutMs, `no answer from the inviter within ${timeoutMs} ms`, () => {
    expired = true;
    (conn as Connection | null)?.close(0n, BYE);
  });
  const welcome = welcomeOf(line, selfId);
  deps.store.replacePool({ poolId: welcome.pool.id, poolSecret: welcome.pool.secret, createdAt: new Date().toISOString() }, welcome.roster);

  const members = welcome.roster.filter((row) => row.status === "member");
  const addrs = new Map<string, WireAddr>();
  for (const row of members) if (row.lastAddr !== null && row.nodeId !== selfId) addrs.set(row.nodeId, row.lastAddr);
  if (!addrs.has(ticket.inviter.id)) addrs.set(ticket.inviter.id, ticket.inviter);
  return { poolId: welcome.pool.id, members: members.length, addrs: [...addrs.values()] };
}
