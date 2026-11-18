// What the composer's keys do. Pure: no Preact, no DOM.

/** The parts of a keydown the composer reads. */
export type ComposerKeyEvent = Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "isComposing" | "keyCode">;

/**
 * What a key pressed in the composer does, as in Claude Code: Enter sends (queued while a turn runs), Ctrl or Cmd+Enter
 * sends now, and null leaves the key to the box (Shift+Enter's new line). On a touch screen (`touch`) Enter makes a new
 * line, as a phone's keyboard has no Shift. The Enter that ends an input method's composition (keyCode 229 in Safari)
 * is the input method's. With texts queued (`anyQueued`), ↑ with the caret on the box's first line, or Esc, takes
 * them back into the box; ↑ on a later line moves the caret. `caret` is where the caret is in `value`.
 */
export function composerKey(
  e: ComposerKeyEvent,
  { running, touch, anyQueued, value, caret }: { running: boolean; touch: boolean; anyQueued: boolean; value: string; caret: number },
): "send" | "send-now" | "take-back" | null {
  if (e.isComposing || e.keyCode === 229) return null;
  const plain = !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
  if (anyQueued && plain && e.key === "Escape") return "take-back";
  if (anyQueued && plain && e.key === "ArrowUp" && !value.slice(0, caret).includes("\n")) return "take-back";
  if (e.key !== "Enter") return null;
  if (e.ctrlKey || e.metaKey) return running ? "send-now" : "send";
  if (e.shiftKey || e.altKey || touch) return null;
  return "send";
}

/**
 * The box once `texts` are taken back into it, as Claude Code does: the texts, oldest first, a line each, above what
 * the box held (`draft`); the caret keeps its place in that, or goes to the end of the texts in an empty box.
 */
export function withTakenBack(texts: string[], draft: string, caret: number): { text: string; caret: number } {
  const back = texts.join("\n");
  if (back === "") return { text: draft, caret };
  if (draft === "") return { text: back, caret: back.length };
  return { text: `${back}\n${draft}`, caret: back.length + 1 + caret };
}
