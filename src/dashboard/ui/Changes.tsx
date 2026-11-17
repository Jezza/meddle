// A task's changes in one of its projects: the changes since its start as a small graph on the left, `All changes`
// first, and the selection's files as diffs on the right, whose hidden lines load from the node on a click.
import type { Ref } from "@earendil-works/chord";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { TaskObject } from "../../state/contracts";
import { remoteReason } from "../../projects/memory-names";
import type { ProjectChanges, TaskChange } from "../../tasks/changes";
import { changeLabel, diffVersion, patchHash, summary, totals } from "./changes-model";
import { DiffView } from "./diff";
import { type FilePatch, parseGitDiff } from "./git-diff";
import { useValue } from "./hooks";
import { textLines } from "./thread-model";

type TaskRef = Ref<typeof TaskObject>;

/** Changed lines, at most, for a file's diff to start open. */
const OPEN_LINES = 200;

/** The task's changes: one project at a time, picked above the list when it has several. */
export function Changes({ task }: { task: TaskRef }) {
  const changes = useValue(task.changes);
  const manifest = useValue(task.manifest);
  const [chosen, setChosen] = useState<string | null>(null);
  // Only projects whose changes were read; one whose read failed since keeps its last.
  const p = changes.find((c) => c.project === chosen) ?? changes[0];
  if (p === undefined) return null;
  const picker = changes.length > 1 && (
    <select class="pill chg-project" value={p.project} onChange={(e) => setChosen(e.currentTarget.value)}>
      {changes.map((c) => <option key={c.project} value={c.project}>{c.name}</option>)}
    </select>
  );
  const base = manifest.projects.find((m) => m.id === p.project)?.base[0];
  return <ProjectView key={p.project} task={task} p={p} base={base} picker={picker} />;
}

/** What is selected: the whole line, or one change (its commit, and its change id to follow it once rewritten). */
type Selection = "all" | { change: string; commit: string };

function ProjectView({ task, p, base, picker }: { task: TaskRef; p: ProjectChanges; base: string | undefined; picker: ComponentChildren }) {
  const [selected, setSelected] = useState<Selection>("all");
  // The selected change as listed now: the same commit, else the one change with its change id; else the whole line.
  const current = selected === "all" ? undefined
    : p.changes.find((c) => c.commit === selected.commit)
      ?? (p.changes.filter((c) => c.change === selected.change).length === 1 ? p.changes.find((c) => c.change === selected.change) : undefined);
  const all = useDiff(task, p.project, p.conflicted ? null : "all", diffVersion(p, "all"));
  const one = useDiff(task, p.project, current?.commit ?? null, diffVersion(p, current?.commit ?? "all"));
  const shown = current === undefined ? all : one;
  const sum = all.patches === null ? null : totals(all.patches);
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
          {shown.patches?.map((patch) => {
            // The old side: the change's parent, or for the whole line its start.
            const rev = current === undefined ? base : `${current.commit}-`;
            // A file whose patch is unchanged by a read again keeps what was opened in it.
            return (
              <FileDiff key={`${current?.commit ?? "all"}\0${patch.path}\0${patchHash(patch)}`} task={task} project={p.project} patch={patch}
                rev={patch.status === "added" ? undefined : rev} />
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
 * One file's diff, open when it has at most `OPEN_LINES` changed lines; its hidden lines read from `rev` (none for an
 * added file) on the first click, a read's refusal shown beneath.
 */
function FileDiff({ task, project, patch, rev }: { task: TaskRef; project: string; patch: FilePatch; rev: string | undefined }) {
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
    <div class="chg-file">
      <DiffView hunks={patch.hunks} file={null} load={load} closed={patch.added + patch.removed > OPEN_LINES}
        head={{ path: patch.path, status: patch.status, added: patch.added, removed: patch.removed, binary: patch.binary }} />
      {error !== null && <p class="error">{error}</p>}
    </div>
  );
}

/** A diff as read: its files (null until the first read lands) and the read's refusal. */
type Read = { patches: FilePatch[] | null; error: string | null };

/**
 * `change`'s diff in `project` (`"all"` for the whole line, null for none), read again whenever `version` changes. A
 * new `change` drops what was shown; a read again keeps it until the new one lands, and a failed one keeps it beside
 * its refusal.
 */
function useDiff(task: TaskRef, project: string, change: string | null, version: string): Read {
  const [read, setRead] = useState<Read & { change: string | null }>({ patches: null, error: null, change });
  const latest = useRef(0);
  useEffect(() => {
    const n = ++latest.current;
    if (change === null) {
      setRead((r) => r.change === null && r.patches === null && r.error === null ? r : { patches: null, error: null, change });
      return;
    }
    setRead((r) => r.change === change ? r : { patches: null, error: null, change });
    task.changeDiff({ project, change }).then(
      (text) => { if (n === latest.current) setRead({ patches: parseGitDiff(text), error: null, change }); },
      (err: unknown) => {
        if (n === latest.current) setRead((r) => ({ patches: r.change === change ? r.patches : null, error: remoteReason(err), change }));
      },
    );
  }, [task, project, change, version]);
  // Until the effect has run for a new change, what is held is another change's.
  return read.change === change ? read : { patches: null, error: null };
}
