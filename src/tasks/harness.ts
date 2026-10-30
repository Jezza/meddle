import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { defineExtension, Harness, hook, type Registry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { NodeConfig } from "../config";
import { paths } from "../paths";
import { MeddleTurn } from "./durable";

/**
 * Installs the meddle extension in `registry`, opens the durable store and starts scheduling, which
 * reruns any turn the last process left unfinished. The extension's `harness` hook is how a turn's
 * phase finds the Harness it runs in, and through it the TaskRunner.
 */
export async function openHarness(
  cfg: NodeConfig,
  registry: Registry,
): Promise<{ harness: Harness; close(): Promise<void> }> {
  let opened: Harness | undefined;
  registry.install(defineExtension({
    name: "meddle",
    tasks: [MeddleTurn],
    hooks: [hook(MeddleTurn, { harness: () => opened! })],
  }));
  const harness = await Harness.open(
    await openNodeSqliteStorage(paths(cfg).durableDb),
    { models: createModels(), registry },
    BACKGROUND_CONTEXT,
  );
  opened = harness;
  harness.resume();
  return { harness, close: () => harness.close(BACKGROUND_CONTEXT) };
}
