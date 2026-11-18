// The icons the dashboard draws: iconoir's, each SVG's text inlined into the bundle when the dashboard is built, a
// chevron of its own, and the thread's call icons (also the agent list's and the sidebar's).
import attachment from "iconoir/icons/attachment.svg" with { type: "text" };
import check from "iconoir/icons/check.svg" with { type: "text" };
import copy from "iconoir/icons/copy.svg" with { type: "text" };
import send from "iconoir/icons/send-diagonal.svg" with { type: "text" };
import warning from "iconoir/icons/warning-circle.svg" with { type: "text" };

const ICONOIR = { attachment, check, copy, send, warning };

/** An iconoir icon, one em square and drawn in the text colour (`.ico` in index.html). */
export function Iconoir({ name }: { name: keyof typeof ICONOIR }) {
  return <span class="ico" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONOIR[name] }} />;
}

/** A chevron pointing right, turned down by its row's CSS while what it heads is open. */
export function Chevron() {
  return <svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>;
}

/** The call icons' strokes, on a 16-unit square. */
const ICONS = {
  search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></>,
  edit: <path d="M10.5 2.5l3 3L6 13H3v-3z" />,
  write: <><path d="M4 1.5h5l3 3v10H4z" /><path d="M8 7.5v4.5M5.75 9.75h4.5" /></>,
  bash: <><path d="M2.5 4l4 4-4 4" /><path d="M8 12.5h5.5" /></>,
  agent: <><circle cx="4" cy="3.5" r="1.5" /><circle cx="4" cy="12.5" r="1.5" /><circle cx="12" cy="6" r="1.5" /><path d="M4 5v6M12 7.5c0 2.5-3 3-6.5 4" /></>,
  tool: <><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M5.5 8h5" /></>,
  raw: <path d="M5 3.5 1.5 8 5 12.5M11 3.5 14.5 8 11 12.5" />,
  thought: <path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" />,
  failed: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  done: <path d="M3.5 8.5l3 3 6-7" />,
  running: <path d="M8 2a6 6 0 1 1-6 6" />,
} as const;

export type IconName = keyof typeof ICONS;

/** A call icon on its own, sized by `cls` (the sidebar's agent count, the agent list's head). */
export function Glyph({ name, cls }: { name: IconName; cls?: string }) {
  return (
    <svg class={cls} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true">{ICONS[name]}</svg>
  );
}

/** A call's icon in its small square, tinted by `name` (index.html's `.chip`); `running` spins. */
export function Icon({ name }: { name: IconName }) {
  return <span class={`chip ${name}`}><Glyph name={name} cls={name === "running" ? "ic spin" : "ic"} /></span>;
}
