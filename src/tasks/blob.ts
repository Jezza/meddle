// The accepting end of `blob` streams: a move's task frames in with one receipt line back, or a file served by its hash.
import { reset, serveBlob } from "../blobs/pool";
import type { BlobStore } from "../blobs/store";
import { writeLine } from "../pool/frames";
import { shortId } from "../pool/ids";
import type { PeerStream, PoolNet } from "../pool/net";
import type { TaskRunner } from "./durable";

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
}

async function receive(s: PeerStream, runner: Pick<TaskRunner, "importIncoming">, taskId: string): Promise<void> {
  const receipt = await runner.importIncoming(taskId, s.peerId, s.reader);
  await writeLine(s.stream.send, JSON.stringify(receipt));
  await s.stream.send.finish();
}

/**
 * Takes the `blob` streams members open to this node. A `{ kind: "task", taskId }` one imports the task into the row
 * `receiveTask` made for it (only from the node it is being received from), answers with the receipt as one JSON line
 * and finishes. A `{ kind: "file", hash }` one is answered from `store` (`serveBlob`). A refusal, a failed import or a
 * failed read resets the stream, with no answer; why an import was refused or failed goes to `log` (by default
 * `console.error`), as the sender learns nothing of it. Returns the unsubscribe.
 */
export function acceptBlobStreams(
  net: PoolNet,
  runner: Pick<TaskRunner, "importIncoming">,
  store: BlobStore,
  log: (line: string) => void = (line) => console.error(line),
): () => void {
  return net.onStream((s) => {
    if (s.header.stream !== "blob") return false;
    const { kind, taskId, hash } = s.header;
    if (kind === "file" && typeof hash === "string") {
      void serveBlob(s, store).catch(() => reset(s));
    } else if (kind === "task" && typeof taskId === "string") {
      void receive(s, runner, taskId).catch((err: unknown) => {
        log(`meddle: move: could not import ${taskId} from ${shortId(s.peerId)}: ${messageOf(err)}`);
        return reset(s);
      });
    } else {
      void reset(s);
    }
    return true;
  });
}
