// What the composer's keys do. Pure: no Preact, no DOM.

/** The parts of a keydown the composer reads. */
export type ComposerKeyEvent = Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "isComposing" | "keyCode">;

/**
 * What a key pressed in the composer does, as in Claude Code: Enter sends (queued while a turn runs), Ctrl or Cmd+Enter
 * sends now, and null leaves the key to the box (Shift+Enter's new line). On a touch screen (`touch`) Enter makes a new
 * line, as a phone's keyboard has no Shift. The Enter that ends an input method's composition (keyCode 229 in Safari)
 * is the input method's.
 */
export function composerKey(e: ComposerKeyEvent, { running, touch }: { running: boolean; touch: boolean }): "send" | "send-now" | null {
  if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return null;
  if (e.ctrlKey || e.metaKey) return running ? "send-now" : "send";
  if (e.shiftKey || e.altKey || touch) return null;
  return "send";
}
