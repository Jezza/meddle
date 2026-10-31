// The receiving end of a move's `blob` stream: the sender's task frames in, one receipt line back.
import { writeLine } from "../pool/frames";
import type { PeerStream, PoolNet } from "../pool/net";
import type { TaskRunner } from "./durable";

/** Resets a stream both ways: the sender's writes and its wait for a receipt fail. */
async function reset(s: PeerStream): Promise<void> {
  await s.stream.send.reset(0n).catch(() => {});
  await s.stream.recv.stop(0n).catch(() => {});
}

async function receive(s: PeerStream, runner: Pick<TaskRunner, "importIncoming">, taskId: string): Promise<void> {
  const receipt = await runner.importIncoming(taskId, s.peerId, s.reader);
  await writeLine(s.stream.send, JSON.stringify(receipt));
  await s.stream.send.finish();
}

/**
 * Takes the `{ stream: "blob", kind: "task", taskId }` streams members open to this node: imports the task into the
 * row `receiveTask` made for it (only from the node it is being received from), answers with the receipt as one JSON
 * line and finishes. A refusal or a failed import resets the stream, with no receipt. Returns the unsubscribe.
 */
export function acceptBlobStreams(net: PoolNet, runner: Pick<TaskRunner, "importIncoming">): () => void {
  return net.onStream((s) => {
    if (s.header.stream !== "blob") return false;
    const { kind, taskId } = s.header;
    if (kind !== "task" || typeof taskId !== "string") {
      void reset(s);
      return true;
    }
    void receive(s, runner, taskId).catch(() => reset(s));
    return true;
  });
}
