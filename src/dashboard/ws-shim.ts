// Bun's server-side WebSockets as chord expects them: chord's `acceptWebSockets` wants a server emitting
// `connection` with sockets that have `addEventListener`, and Bun's `ServerWebSocket` is fed by handlers instead.
import type { ServerWebSocket } from "bun";
import type { WebSocketLike, WebSocketServerLike } from "@earendil-works/chord";

type Listener = (event: { readonly data: unknown }) => void;
type EventType = "open" | "message" | "close" | "error";

/** A Bun `ServerWebSocket` with `addEventListener`, fed by `Bun.serve`'s `websocket` handlers. */
export class BunSocketShim implements WebSocketLike {
  #listeners: Record<EventType, Set<Listener>> = { open: new Set(), message: new Set(), close: new Set(), error: new Set() };

  constructor(private readonly socket: ServerWebSocket<unknown>) {}

  get readyState(): number {
    return this.socket.readyState;
  }

  send(data: string | Uint8Array): void {
    this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: EventType, listener: Listener): void {
    this.#listeners[type].add(listener);
  }

  dispatchMessage(data: string | Buffer): void {
    for (const listener of this.#listeners.message) listener({ data });
  }

  dispatchClose(): void {
    for (const listener of this.#listeners.close) listener({ data: undefined });
  }

  dispatchError(): void {
    for (const listener of this.#listeners.error) listener({ data: undefined });
  }
}

/** The `connection`-emitting server `acceptWebSockets` takes; `Bun.serve`'s `open` handler emits. */
export class ShimServer<Request> implements WebSocketServerLike<Request> {
  #listeners = new Set<(socket: WebSocketLike, request: Request) => void>();

  on(_event: "connection", listener: (socket: WebSocketLike, request: Request) => void): void {
    this.#listeners.add(listener);
  }

  emitConnection(socket: BunSocketShim, request: Request): void {
    for (const listener of this.#listeners) listener(socket, request);
  }
}
