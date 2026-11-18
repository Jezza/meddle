// The icons the dashboard draws: iconoir's, each SVG's text inlined into the bundle when the dashboard is built, and a
// chevron of its own.
import attachment from "iconoir/icons/attachment.svg" with { type: "text" };
import check from "iconoir/icons/check.svg" with { type: "text" };
import copy from "iconoir/icons/copy.svg" with { type: "text" };
import send from "iconoir/icons/send-diagonal.svg" with { type: "text" };
import warning from "iconoir/icons/warning-circle.svg" with { type: "text" };

const ICONS = { attachment, check, copy, send, warning };

/** An iconoir icon, one em square and drawn in the text colour (`.ico` in index.html). */
export function Iconoir({ name }: { name: keyof typeof ICONS }) {
  return <span class="ico" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[name] }} />;
}

/** A chevron pointing right, turned down by its row's CSS while what it heads is open. */
export function Chevron() {
  return <svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>;
}
