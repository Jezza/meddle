// A project's graph on its page: one row per commit, its lanes drawn on the left, its bookmarks (each with the nodes
// that have it there), short change id and description on the right; `Older` at the bottom while there is more.
import { Fragment } from "preact";
import { atTail, hasOlder, type Label, laneX, layoutLanes, type Laid, type Row, segPath } from "./graph-model";
import { useAction } from "./hooks";

export type GraphProps = {
  rows: readonly Row[];
  defaultBranch: string | null;
  nodeName(nodeId: string): string;
  /** The nodes whose context failed to load. */
  contextFailed: ReadonlySet<string>;
  /** A live task's title and page, or null. */
  taskOf(id: string): { title: string; href: string } | null;
  /** Reads more of the graph; null when it cannot. */
  older: (() => Promise<void>) | null;
};

export function Graph({ rows, defaultBranch, nodeName, contextFailed, taskOf, older }: GraphProps) {
  const laid = layoutLanes(rows, defaultBranch);
  const more = useAction();
  if (rows.length === 0) return null;
  const width = laid.lanes * 18 + 10;
  const columns = `grid-template-columns: ${width}px minmax(0, 1fr)`;
  // The Older row continues the last row's stubs.
  const stubs = laid.rows.at(-1)!.segs.filter((s) => s.kind === "stub").map((s) => s.lane);
  return (
    <div class="graph">
      {rows.map((row, i) => (
        <div key={row.commit.commit} class="g" style={columns}>
          <Rail width={width} row={row} laid={laid.rows[i]!} />
          <div class="g-row" title={row.commit.commit}>
            {row.labels.map((l) => (
              <Fragment key={JSON.stringify(l.bookmark)}>
                <Pill label={l} taskOf={taskOf} />
                <At label={l} nodeName={nodeName} contextFailed={contextFailed} />
              </Fragment>
            ))}
            <span class="cid">{row.commit.change.slice(0, 8)}</span>
            <span class="desc">{row.commit.description}</span>
          </div>
        </div>
      ))}
      {older !== null && hasOlder(rows) && (
        <div class="g" style={columns}>
          <span class="g-rail">
            <svg width={width} aria-hidden="true">
              {stubs.map((lane) => <path key={lane} class="stub" d={`M${laneX(lane)} 0 V14`} />)}
              <text class="tilde" x={laneX(stubs[0] ?? 0) - 4} y="26">~</text>
            </svg>
          </span>
          <div class="g-row">
            <button type="button" class="older" disabled={more.busy} onClick={() => void more.run(older)}>Older</button>
            {more.error !== null && <span class="error">{more.error}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A row's lines and node. The lines are drawn for a 30px row; a taller row (its text wrapped) carries on each line that
 * reaches the bottom.
 */
function Rail({ width, row, laid }: { width: number; row: Row; laid: Laid }) {
  const x = laneX(laid.lane);
  const alone = row.labels.length > 0 && row.labels.every((l) => l.notPushed);
  return (
    <span class="g-rail">
      <svg width={width} aria-hidden="true">
        {laid.segs.map((s) => (
          <Fragment key={`${s.kind} ${s.lane}`}>
            <path class={s.kind === "stub" ? "stub" : undefined} d={segPath(s, laid.lane)} />
            {(s.kind === "through" || s.kind === "down" || s.kind === "out") && (
              <line x1={laneX(s.lane)} x2={laneX(s.lane)} y1="30" y2="100%" />
            )}
          </Fragment>
        ))}
        {row.commit.immutable
          ? <polygon class="diamond" points={`${x},9.5 ${x + 5.5},15 ${x},20.5 ${x - 5.5},15`} />
          : row.labels.length > 0 && !alone
            ? <circle class="pt head" cx={x} cy="15" r="4.5" />
            : <circle class={alone ? "pt alone" : "pt"} cx={x} cy="15" r="4" />}
      </svg>
    </span>
  );
}

/** A bookmark: a task's line (its title, linked) or a branch; dashed when behind, warned when not pushed. */
function Pill({ label, taskOf }: { label: Label; taskOf: GraphProps["taskOf"] }) {
  const b = label.bookmark;
  const behind = label.behind !== null ? " behind" : "";
  if (b.kind === "branch") return <span class={`bm branch${behind}${label.notPushed ? " flag" : ""}`}>{b.name}</span>;
  const task = taskOf(b.task);
  return task === null
    ? <span class={`bm line${behind}`}>task {b.task.slice(0, 8)}</span>
    : <a class={`bm line${behind}`} href={task.href}>{task.title}</a>;
}

/** `⌂ a · b` and its tail (as `atText`), a failed node's name followed by its note; it wraps between names. */
function At({ label, nodeName, contextFailed }: { label: Label; nodeName: GraphProps["nodeName"]; contextFailed: ReadonlySet<string> }) {
  return (
    <span class="at">
      ⌂ {label.nodes.map((n, i) => (
        <Fragment key={n}>
          {i > 0 && " · "}
          <span class="at-node">{nodeName(n)}{contextFailed.has(n) && <> <span class="error">context failed to load</span></>}</span>
        </Fragment>
      ))}{atTail(label)}
    </span>
  );
}
