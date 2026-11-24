import type { PeerFrom } from "../blobs/attachment";
import { remoteReason } from "../projects/memory-names";
import { shortId } from "../pool/ids";
import type { PoolRuntime } from "../pool/runtime";
import { PeerObject } from "../state/contracts";

/** A task an agent can message: its id (the address), title and state, and the node holding it. */
export type TaskEntry = { id: string; title: string; state: string; nodeId: string; nodeName: string };

/** How a message to a task went: handed to it (as `TaskRunner.message` answers), or why not. */
export type SendOutcome = { ok: true; how: "delivered" | "waking" | "queued"; title: string } | { ok: false; reason: string };

/** The most text one message may be (UTF-8): Claude Code takes at most 1 MiB a line, its JSON escaping included. */
export const MAX_MESSAGE_BYTES = 256 * 1024;

type Runner = {
  listLive(): Array<{ id: string; title: string; state: string }>;
  message(taskId: string, from: PeerFrom, text: string): Promise<"delivered" | "waking" | "queued">;
};

/**
 * Carries messages from this node's tasks' agents to any task in the pool: finds the node holding the task (this
 * node's runner, or a member's `PeerObject.tasks`) and hands the message to it (`TaskRunner.message`, or the member's
 * `PeerObject.message`). One per node.
 */
export class Messenger {
  readonly #selfId: string;
  readonly #runner: Runner;
  readonly #pool: PoolRuntime | undefined;
  readonly #holderOf: (taskId: string) => string | null;
  readonly #cacheMs: number;
  readonly #memberMs: number;
  readonly #sendMs: number;
  #cached: { at: number; entries: Promise<TaskEntry[]> } | undefined;

  constructor(deps: {
    selfId: string;
    runner: Runner;
    pool?: PoolRuntime;
    /** The node the pool's line rows say holds a task, or null: how a task of an offline member is told apart. */
    holderOf?: (taskId: string) => string | null;
    /** How long a directory is reused (5 s). */
    cacheMs?: number;
    /** How long a member may take to list its tasks before it is left out (3 s). */
    memberMs?: number;
    /** How long a holder may take to answer a send before it fails (30 s). */
    sendMs?: number;
  }) {
    this.#selfId = deps.selfId;
    this.#runner = deps.runner;
    this.#pool = deps.pool;
    this.#holderOf = deps.holderOf ?? (() => null);
    this.#cacheMs = deps.cacheMs ?? 5_000;
    this.#memberMs = deps.memberMs ?? 3_000;
    this.#sendMs = deps.sendMs ?? 30_000;
  }

  /**
   * The tasks an agent here can message: this node's live tasks and each online member's (`PeerObject.tasks`), the
   * members asked together; one that fails, takes longer than `memberMs` or is too old to say is left out.
   */
  directory(): Promise<TaskEntry[]> {
    const now = Date.now();
    if (this.#cached !== undefined && now - this.#cached.at < this.#cacheMs) return this.#cached.entries;
    const entries = this.#read();
    this.#cached = { at: now, entries };
    return entries;
  }

  async #read(): Promise<TaskEntry[]> {
    const own = this.#runner.listLive().map((t) => ({ ...t, nodeId: this.#selfId, nodeName: this.#nodeName(this.#selfId) }));
    const pool = this.#pool;
    if (pool === undefined) return own;
    const members = pool.store.members().map((r) => r.nodeId).filter((id) => id !== this.#selfId && pool.net.isOnline(id));
    const theirs = await Promise.all(members.map(async (nodeId) => {
      const listed = await this.#withPeer(nodeId, (peer) => peer.tasks({}), this.#memberMs).catch(() => []);
      return listed.map((t) => ({ id: t.id, title: t.title, state: t.state, nodeId, nodeName: this.#nodeName(nodeId) }));
    }));
    return [...own, ...theirs.flat()];
  }

  /** Hands `text` from task `from` to task `to`, wherever in the pool it is held; never rejects. */
  async send(from: PeerFrom, to: string, text: string): Promise<SendOutcome> {
    if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) return { ok: false, reason: "message is over 256 KiB" };
    if (to === from.taskId) return { ok: false, reason: "that is this task" };
    let entry = (await this.directory()).find((e) => e.id === to);
    if (entry === undefined) {
      this.#cached = undefined; // it may be new since
      entry = (await this.directory()).find((e) => e.id === to);
    }
    if (entry === undefined) {
      const holder = this.#holderOf(to);
      if (holder !== null && holder !== this.#selfId && !this.#pool?.net.isOnline(holder)) {
        return { ok: false, reason: `node ${this.#nodeName(holder)} is offline` };
      }
      return { ok: false, reason: `no task ${to}` };
    }
    const target = entry;
    try {
      const how = target.nodeId === this.#selfId
        ? await this.#runner.message(to, from, text)
        : await this.#withPeer(target.nodeId, (peer) => peer.message({ to, from, text }), this.#sendMs);
      return { ok: true, how, title: target.title };
    } catch (err) {
      if (err instanceof NodeOffline) return { ok: false, reason: `node ${target.nodeName} is offline` };
      if (err instanceof NoAnswer) return { ok: false, reason: `node ${target.nodeName} did not answer` };
      return { ok: false, reason: remoteReason(err) };
    }
  }

  /**
   * Calls node `nodeId`'s `PeerObject`, as the train does: `NodeOffline` when it is offline or goes offline during the
   * call. `NoAnswer` when getting its `PeerObject` and the call together take longer than `ms`; a `PeerObject` that
   * comes after that is released.
   */
  async #withPeer<T>(nodeId: string, call: (peer: PeerCalls) => Promise<T>, ms: number): Promise<T> {
    const pool = this.#pool;
    if (pool === undefined || !pool.net.isOnline(nodeId)) throw new NodeOffline();
    let late = false;
    const attempt = (async () => {
      const ref = await pool.peerRef(nodeId, PeerObject).catch((err: unknown) => {
        throw pool.net.isOnline(nodeId) ? err : new NodeOffline();
      });
      if (late) {
        ref.release();
        throw new NoAnswer();
      }
      try {
        if (ref.variant !== "peer") throw new Error(`${this.#nodeName(nodeId)} did not serve the peer variant of PeerObject`);
        return await call(ref as unknown as PeerCalls);
      } catch (err) {
        if (!pool.net.isOnline(nodeId)) throw new NodeOffline();
        throw err;
      } finally {
        ref.release();
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { late = true; reject(new NoAnswer()); }, ms);
    });
    attempt.catch(() => {}); // a late failure has no one to tell
    try {
      return await Promise.race([attempt, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  #nodeName(nodeId: string): string {
    const row = this.#pool?.store.row(nodeId);
    return row?.summary?.hostname ?? row?.hostname ?? (nodeId === this.#selfId && this.#pool === undefined ? "this node" : shortId(nodeId));
  }
}

/** The `PeerObject` methods a messenger calls. */
type PeerCalls = {
  tasks(input: Record<string, never>): Promise<Array<{ id: string; title: string; state: string }>>;
  message(input: { to: string; from: PeerFrom; text: string }): Promise<"delivered" | "waking" | "queued">;
};

class NodeOffline extends Error {}
class NoAnswer extends Error {}
