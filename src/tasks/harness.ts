import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { defineExtension, Harness, hook, type Registry, type ReportInfo } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { NodeConfig } from "../config";
import { paths } from "../paths";
import { MeddleTurn } from "./durable";
import { MeddleMove } from "./move";

/**
 * Installs the meddle extension in `registry`, opens the durable store and starts scheduling, which
 * reruns any turn or move the last process left unfinished. The extension's `harness` hook is how a turn's or a
 * move's phase finds the Harness it runs in, and through it the TaskRunner. With `hold`, scheduling waits (nothing
 * reruns) until the caller resumes the Harness: a node on an unconfirmed build, or behind the pool's, holds its turns.
 */
export async function openHarness(
  cfg: NodeConfig,
  registry: Registry,
  options: { hold?: boolean } = {},
): Promise<{ harness: Harness; close(): Promise<void> }> {
  let opened: Harness | undefined;
  registry.install(defineExtension({
    name: "meddle",
    tasks: [MeddleTurn, MeddleMove],
    hooks: [hook(MeddleTurn, { harness: () => opened! }), hook(MeddleMove, { harness: () => opened! })],
  }));
  const harness = await Harness.open(
    await openNodeSqliteStorage(paths(cfg).durableDb),
    { models: createModels(), registry, onReport: report },
    BACKGROUND_CONTEXT,
  );
  opened = harness;
  if (options.hold !== true) harness.resume();
  return { harness, close: () => harness.close(BACKGROUND_CONTEXT) };
}

/** pi-durable's reports (a faulted or parked turn, a failed Session, a throwing listener) go to the service log. */
function report(error: unknown, info: ReportInfo): void {
  const task = "task" in info && info.task !== undefined ? ` (${info.task.kind} ${info.task.id})` : "";
  console.error(`meddle: durable ${info.type}${task}:`, error);
}
