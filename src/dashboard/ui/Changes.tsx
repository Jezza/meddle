// A task's changes in one of its projects: the changes since its start as a small graph on the left, `All changes`
// first; the selection's files as a tree beside it; and their diffs on the right, whose hidden lines load from the
// node on a click.
import type { Ref } from "@earendil-works/chord";
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { TaskObject } from "../../state/contracts";
import { remoteReason } from "../../projects/memory-names";
import type { ProjectChanges, TaskChange } from "../../tasks/changes";
import { changeLabel, type FileNode, fileTree, patchHash, summary, totals, treeFiles } from "./changes-model";
import { DiffView } from "./diff";
import { type FilePatch, parseGitDiff } from "./git-diff";
import { useValue } from "./hooks";
import { Chevron } from "./icons";
import { textLines } from "./thread-model";

type TaskRef = Ref<typeof TaskObject>;

/** Changed lines, at most, for a file's diff to start shown. */
const OPEN_LINES = 200;

/** The task's changes: one project at a time, picked above the list when it has several. */
export function Changes({ task }: { task: TaskRef }) {
  const changes = useValue(task.changes);
  const [chosen, setChosen] = useState<string | null>(null);
  // Only projects whose changes were read; one whose read failed since keeps its last.
  const p = changes.find((c) => c.project === chosen) ?? changes[0];
  if (p === undefined) return null;
  const picker = changes.length > 1 && (
    <select class="pill chg-project" value={p.project} onChange={(e) => setChosen(e.currentTarget.value)}>
      {changes.map((c) => <option key={c.project} value={c.project}>{c.name}</option>)}
    </select>
  );
  return <ProjectView key={p.project} task={task} p={p} picker={picker} />;
}

/** What is selected: the whole line, or one change (its commit, and its change id to follow it once rewritten). */
type Selection = "all" | { change: string; commit: string };

/**
 * A file of the selection's diff and its key: the selection, its path and its patch's hash, so that a file whose patch
 * is unchanged by a read again keeps what was opened in it.
 */
type Shown = { patch: FilePatch; key: string };

function ProjectView({ task, p, picker }: { task: TaskRef; p: ProjectChanges; picker: ComponentChildren }) {
  const [selected, setSelected] = useState<Selection>("all");
  // The selected change as listed now: the same commit, else the one change with its change id; else the whole line.
  const current = selected === "all" ? undefined
    : p.changes.find((c) => c.commit === selected.commit)
      ?? (p.changes.filter((c) => c.change === selected.change).length === 1 ? p.changes.find((c) => c.change === selected.change) : undefined);
  // The whole line: from where it leaves its start to its newest change; nothing when it has none.
  const newest = p.changes[0]?.commit;
  const all = useDiff(task, p.project, p.from === null || newest === undefined ? null : { change: newest, from: p.from });
  const one = useDiff(task, p.project, current === undefined ? null : { change: current.commit });
  const shown = current === undefined ? all : one;
  const sum = all.patches === null ? null : totals(all.patches);
  const tree = useMemo(() => shown.patches === null ? null : fileTree(shown.patches), [shown.patches]);
  const at = current?.commit ?? `all ${p.from}`;
  const diffs = useMemo((): Shown[] => tree === null ? [] : treeFiles(tree).map((patch) => ({ patch, key: `${at}\0${patch.path}\0${patchHash(patch)}` })), [tree, at]);
  // The files shown or hidden by hand, by key; the rest are hidden when they are long.
  const [shut, setShut] = useState<ReadonlyMap<string, boolean>>(new Map());
  const closed = (d: Shown) => shut.get(d.key) ?? d.patch.added + d.patch.removed > OPEN_LINES;
  const boxes = useRef(new Map<string, HTMLElement>());
  // A file picked in the tree: its diff shown, at the top of the view.
  const reveal = (patch: FilePatch) => {
    const d = diffs.find((d) => d.patch === patch);
    if (d === undefined) return;
    if (closed(d)) setShut((m) => new Map(m).set(d.key, false));
    boxes.current.get(d.key)?.scrollIntoView({ block: "start" });
  };
  return (
    <div class="changes">
      <nav class="chg-list" aria-label="Changes">
        {picker}
        {!p.conflicted && <>
          <button type="button" class={current === undefined ? "chg sel" : "chg"} aria-pressed={current === undefined} onClick={() => setSelected("all")}>
            <span />
            <span class="chg-text">
              <span class="chg-label">All changes</span>
              {sum !== null && <span class="meta">{files(sum.files)}<Lines added={sum.added} removed={sum.removed} /></span>}
            </span>
          </button>
          <div class="chg-space" />
          {p.changes.map((c, i) => (
            <ChangeRow key={c.commit} c={c} first={i === 0} selected={current?.commit === c.commit}
              onSelect={() => setSelected({ change: c.change, commit: c.commit })} />
          ))}
          <div class="chg start">
            <Graph first={p.changes.length === 0} start />
            <span class="chg-text"><span class="chg-start">{p.start}</span></span>
          </div>
        </>}
      </nav>
      {!p.conflicted && <FileTree nodes={tree ?? []} onReveal={reveal} />}
      <div class="chg-main">
        <div class="chg-sum">
          {p.conflicted ? <span class="flag">conflicted</span> : <>
            <span>{summary(p)} on <span class="chg-start">{p.start}</span></span>
            {sum !== null && <>
              <span class="muted">·</span><span>{files(sum.files)}</span>
              <span class="muted">·</span><span><span class="add">+{sum.added}</span> <span class="del">−{sum.removed}</span></span>
            </>}
            {current !== undefined && all.error !== null && <span class="error">{all.error}</span>}
          </>}
        </div>
        {!p.conflicted && <>
          {shown.error !== null && <p class="error">{shown.error}</p>}
          {diffs.map((d) => {
            // The old side: the change's parent, or for the whole line where it leaves its start.
            const rev = current === undefined ? p.from ?? undefined : `${current.commit}-`;
            return (
              <FileDiff key={d.key} task={task} project={p.project} patch={d.patch} rev={d.patch.status === "added" ? undefined : rev}
                closed={closed(d)} onToggle={() => setShut((m) => new Map(m).set(d.key, !closed(d)))}
                box={(el) => { if (el === null) boxes.current.delete(d.key); else boxes.current.set(d.key, el); }} />
            );
          })}
        </>}
      </div>
    </div>
  );
}

function ChangeRow({ c, first, selected, onSelect }: { c: TaskChange; first: boolean; selected: boolean; onSelect(): void }) {
  const quiet = c.workingCopy && c.empty;
  return (
    <button type="button" class={`chg${selected ? " sel" : ""}${quiet ? " quiet" : ""}`} aria-pressed={selected} title={c.change} onClick={onSelect}>
      <Graph first={first} change={c} />
      <span class="chg-text">
        <span class="chg-label">{changeLabel(c)}</span>
        <span class="meta">
          {!c.workingCopy && <><span class="id">{c.change.slice(0, 8)}</span> · </>}
          {c.empty ? "empty" : <>{files(c.files)}<Lines added={c.added} removed={c.removed} /></>}
          {c.conflicted && <> · <span class="flag">conflicted</span></>}
        </span>
      </span>
    </button>
  );
}

/**
 * The selection's files as a tree, in the order of their diffs: a file's row brings its diff to the top of the view,
 * shown; a folder's folds it.
 */
function FileTree({ nodes, onReveal }: { nodes: readonly FileNode[]; onReveal(patch: FilePatch): void }) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const fold = (path: string) => setFolded((f) => {
    const next = new Set(f);
    if (!next.delete(path)) next.add(path);
    return next;
  });
  const rows: JSX.Element[] = [];
  const walk = (list: readonly FileNode[], depth: number) => {
    for (const n of list) {
      const indent = { paddingLeft: `${4 + depth * 12}px` };
      if (n.kind === "dir") {
        const open = !folded.has(n.path);
        rows.push(
          <button key={`d${n.path}`} type="button" class="tree-row" style={indent} aria-expanded={open} title={n.path} onClick={() => fold(n.path)}>
            <Chevron /><span class="tree-name">{n.name}</span>
          </button>,
        );
        if (open) walk(n.children, depth + 1);
        continue;
      }
      const { patch } = n;
      rows.push(
        <button key={`f${patch.path}`} type="button" class={`tree-row ${patch.status}`} style={indent}
          title={patch.oldPath === undefined ? patch.path : `${patch.oldPath} → ${patch.path}`} onClick={() => onReveal(patch)}>
          <span class="chev" /><span class="tree-name">{n.name}</span>
        </button>,
      );
    }
  };
  walk(nodes, 0);
  return <nav class="chg-tree" aria-label="Files">{rows}</nav>;
}

/**
 * A row's piece of the graph, as tall as the row: the line through it (from its dot down, on the first row) and its
 * dot, or the start's diamond.
 */
function Graph({ first, change, start }: { first: boolean; change?: TaskChange; start?: boolean }) {
  const dot = change === undefined ? "" : change.workingCopy ? (change.empty ? "pt empty" : "pt wc") : change.conflicted ? "pt bad" : "pt";
  return (
    <span class="chg-rail">
      <svg class="chg-graph" aria-hidden="true">
        {!(first && start) && <line x1="14" y1={first ? "50%" : "0"} x2="14" y2={start ? "50%" : "100%"} />}
        {start
          ? <svg x="0" y="50%" overflow="visible"><polygon class="diamond" points="14,-5.5 19.5,0 14,5.5 8.5,0" /></svg>
          : <circle class={dot} cx="14" cy="50%" r="4" />}
      </svg>
    </span>
  );
}

/** ` · +a −r`, each count only when it is not 0. */
function Lines({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null;
  return <> · {added > 0 && <span class="add">+{added}</span>}{added > 0 && removed > 0 && " "}{removed > 0 && <span class="del">−{removed}</span>}</>;
}

const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

/**
 * One file's diff, its rows hidden while `closed`; its hidden lines read from `rev` (none for an added file) on the
 * first click, a read's refusal shown beneath. `box` is given the file's element.
 */
function FileDiff({ task, project, patch, rev, closed, onToggle, box }: {
  task: TaskRef;
  project: string;
  patch: FilePatch;
  rev: string | undefined;
  closed: boolean;
  onToggle(): void;
  box(el: HTMLElement | null): void;
}) {
  const [error, setError] = useState<string | null>(null);
  const load = rev === undefined ? undefined : async () => {
    try {
      const text = await task.changeFile({ project, rev, path: patch.oldPath ?? patch.path });
      setError(null);
      return text === null ? null : textLines(text);
    } catch (err) {
      setError(remoteReason(err));
      throw err;
    }
  };
  return (
    <div ref={box} class="chg-file">
      <DiffView hunks={patch.hunks} file={null} load={load} closed={closed} onToggle={onToggle}
        head={{ path: patch.path, status: patch.status, added: patch.added, removed: patch.removed, binary: patch.binary }} />
      {error !== null && <p class="error">{error}</p>}
    </div>
  );
}

/** A diff as read: its files (null until the first read lands) and the read's refusal. */
type Read = { patches: FilePatch[] | null; error: string | null };

/**
 * A diff in `project`: `request.change`'s against its parent, or from `request.from` (null for none). Its slot is the
 * change, or the whole line's (`"all"`) while it has a `from`: a new slot drops what was shown; a new request in the
 * same slot (the line moved) is a read again, which keeps it until the new one lands, and a failed read keeps it beside
 * its refusal. A newer request's read supersedes an older one's late answer.
 */
function useDiff(task: TaskRef, project: string, request: { change: string; from?: string } | null): Read {
  const slot = request === null ? null : request.from !== undefined ? "all" : request.change;
  const key = request === null ? null : `${request.from ?? ""}..${request.change}`;
  const [read, setRead] = useState<Read & { slot: string | null }>({ patches: null, error: null, slot });
  const latest = useRef(0);
  useEffect(() => {
    const n = ++latest.current;
    if (request === null) {
      setRead((r) => r.slot === null && r.patches === null && r.error === null ? r : { patches: null, error: null, slot });
      return;
    }
    setRead((r) => r.slot === slot ? r : { patches: null, error: null, slot });
    task.changeDiff({ project, ...request }).then(
      (text) => { if (n === latest.current) setRead({ patches: parseGitDiff(text), error: null, slot }); },
      (err: unknown) => {
        if (n === latest.current) setRead((r) => ({ patches: r.slot === slot ? r.patches : null, error: remoteReason(err), slot }));
      },
    );
  }, [task, project, key]);
  // Until the effect has run for a new slot, what is held is another's.
  return read.slot === slot ? read : { patches: null, error: null };
}
