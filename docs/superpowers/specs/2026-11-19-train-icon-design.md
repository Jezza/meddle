# The train's icon, and its place in the sidebar

## Why

The merge train shows as a colour 🚂 emoji: a 🚂 Train row under every project in the sidebar, a 🚂 on a queued task's
row and before a merge task's title, and 🚂 again on the train page, a task's header and the train's toasts. Nothing
else in the dashboard is a colour emoji; the rest is monochrome line icons (`icons.tsx`), state dots and grey chips.
The 🚂 looks odd and out of place, and the Train row stands between a project and its tasks even when nothing is queued.

## What changes

**One icon for the train: a merge, drawn as a jj log draws one.** One line at the top splitting into two going down
(the newest change on top, its two parents below), with no arrow. A new `merge` entry in `icons.tsx`'s `ICONS`, drawn
by `Glyph` like the agent icon: `<path d="M8 2.5v2.5c0 2.5-4 3-4 5.5v3M8 5c0 2.5 4 3 4 5.5v3" />`. It replaces every
🚂, so the train looks the same wherever it shows.

**Sidebar** (`Sidebar.tsx`, `index.html`):

- No Train row. The project's line carries a chip at its right: the icon and how many tasks are queued (`p.queued`),
  in the grey of the sidebar's chips. The chip opens the project's train page; the rest of the line opens the project
  page, as today.
- With nothing queued the chip says "Train" instead of a count and shows only while the line is hovered, so an idle
  project's line is just its name. While that project's train page is open the chip shows regardless, highlighted in
  the accent colour (the Train row's grey selected look would barely show on a grey chip).
- A queued task's 🚂 button becomes the icon, grey, and still opens the train with the task highlighted.
- A merge task's title starts with the icon in purple (the train's colour on its page) instead of `🚂 `.

**Elsewhere:** the train page's heading (`Train.tsx`, before the project's name) and its "Merge task" card; a task's
header (`Task.tsx`: "· queued" and the Accept button); the train's toasts (`main.tsx`'s `TOAST_ICONS`, whose values
become elements rather than strings). The README's dashboard section describes the sidebar as it now is.

## Approaches

Picked from mockups: of keeping the row with a new icon (A), the icon and count on the project's line (B), and a
status line under the project shown only while the train has work (C), B. It drops the row without hiding the train
when it is idle. For the icon, of a merge, a merge with an arrow, a train's front and a track: the merge, flipped the
way jj log draws one.

How the chip sits on the project's line: a `<button>` inside the line's `<a>` that sets `location.hash`, as the
queued task's 🚂 does today. Splitting the line into two sibling links would also work, but nothing else in the
sidebar does that.

## Calls left to the builder (marked as mine)

- The chip's title explains it, as the Train row's did ("meddle's merge train: the tasks accepted to land on its
  default branch").
- Icon sizes: 11px in sidebar rows, as the agent count's, and 1em elsewhere.

## Non-goals

- Renaming the train, or any change to the train page beyond its icons.
- A link to the train from the project page.
- Screens without hover (touch, the narrow-screen drawer), where an idle project's chip cannot be reached: later.
