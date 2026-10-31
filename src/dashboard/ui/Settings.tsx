// Settings: the shared login's token status.
import type { Ref } from "@earendil-works/chord";
import { NodeObject } from "../../state/contracts";
import { useValue } from "./hooks";
import { tokenText } from "./Pool";

export function Settings({ node }: { node: Ref<typeof NodeObject> }) {
  const token = useValue(node.token);
  return (
    <section>
      <h2>Settings</h2>
      <h3>Token</h3>
      <p class={token.present ? "" : "error"}>{tokenText(token)}</p>
      <p class="muted">The Claude Code OAuth token is set on the node with <code>meddle token set</code>; it never passes through the dashboard.</p>
    </section>
  );
}
