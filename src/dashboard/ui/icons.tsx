// The iconoir icons the dashboard draws: each SVG's text, inlined into the bundle when the dashboard is built.
import send from "iconoir/icons/send-diagonal.svg" with { type: "text" };
import warning from "iconoir/icons/warning-circle.svg" with { type: "text" };

const ICONS = { send, warning };

/** An iconoir icon, one em square and drawn in the text colour (`.ico` in index.html). */
export function Iconoir({ name }: { name: keyof typeof ICONS }) {
  return <span class="ico" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[name] }} />;
}
