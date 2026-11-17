// A project's memory on the Project page: its entries (read, edited, added, deleted on the home) and the history of
// changes under `memory`, each opening to its diff. Read from the home while it is online, else read-only from a holder.
import type { Host, Ref } from "@earendil-works/chord";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ProjectObject } from "../../state/contracts";
import { isMemoryPath } from "../../projects/memory-names";
import type { MemoryChange, MemoryEntry } from "../../projects/memory-view";
import { DiffView } from "./diff";
import { type FilePatch, parseGitDiff } from "./git-diff";
import { errorText, type Hosts, useObject, useValue } from "./hooks";
import { canSaveNew, changeWho, type HistoryRows, mergeFirstPage, noMemoryRepo, stripFrontmatter, writeError } from "./memory-model";
import { hashOf } from "./routes";
import { ago } from "./sidebar-model";
import type { ListedTask } from "./sources";
import { Markdown } from "./Task";
import { textLines } from "./thread-model";

type ProjectRef = Ref<typeof ProjectObject>;
const INDEX = "MEMORY.md";
const HISTORY_PAGE = 50;

/** What the sections need beyond the project: the pool's tasks (for a change's task) and a node's name by short id. */
type Context = { tasks: readonly ListedTask[]; nodeName(short: string): string };

export function Memory({ hosts, nodeId, editable, id, tasks, nodeName }: {
  hosts: Hosts; nodeId: string; editable: boolean; id: string; tasks: readonly ListedTask[]; nodeName(short: string): string;
}) {
  const host = hosts.for(nodeId);
  return host === undefined ? null : <MemoryOn host={host} editable={editable} id={id} context={{ tasks, nodeName }} />;
}

function MemoryOn({ host, editable, id, context }: { host: Host; editable: boolean; id: string; context: Context }) {
  const project = useObject(host, ProjectObject, { id });
  if (project.error !== undefined) return <p class="error">{project.error}</p>;
  return project.ref === undefined ? null : <MemoryLoaded project={project.ref} editable={editable} context={context} />;
}

function MemoryLoaded({ project, editable, context }: { project: ProjectRef; editable: boolean; context: Context }) {
  const head = useValue(project.memoryHead);
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noRepo, setNoRepo] = useState(false);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [creating, setCreating] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const loads = useRef(0);

  /** Reads the entries again; answers them (null when the read failed or a newer one started). */
  const load = useCallback(async (): Promise<MemoryEntry[] | null> => {
    const n = ++loads.current;
    try {
      const list = await project.memoryEntries({});
      if (n !== loads.current) return null;
      setEntries(list);
      setError(null);
      setNoRepo(false);
      return list;
    } catch (err) {
      if (n !== loads.current) return null;
      setNoRepo(noMemoryRepo(err));
      setError(errorText(err));
      return null;
    }
  }, [project]);
  useEffect(() => { void load(); }, [load, head]);

  const toggle = (path: string, open?: boolean) => setOpened((current) => {
    const next = new Set(current);
    if (open ?? !next.has(path)) next.add(path);
    else next.delete(path);
    return next;
  });
  const showHistory = (path: string) => {
    setFilter(path);
    setHistoryOpen(true);
    requestAnimationFrame(() => historyRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
  // A link in an entry to another entry (`[x](x.md)`) opens that entry here.
  const follow = (e: MouseEvent) => {
    const link = (e.target as Element | null)?.closest?.("a");
    const href = link?.getAttribute("href") ?? "";
    if (isMemoryPath(href) && entries?.some((x) => x.path === href)) {
      e.preventDefault();
      toggle(href, true);
    }
  };

  if (noRepo) return null;
  return (
    <>
      <div class="sec">
        <h3>Memory</h3>
        {entries !== null && <span class="muted">{entries.length}</span>}
        {!editable && <span class="flag">offline</span>}
        <span class="bar-gap" />
        {editable && !creating && <button type="button" onClick={() => setCreating(true)}>New</button>}
      </div>
      {error !== null && <p class="error">{error}</p>}
      {creating && (
        <div class="mem-entry">
          <Editor project={project} path={null} initial="" base={null} listed={entries?.map((e) => e.path) ?? []} reload={load}
            onSaved={(path) => { setCreating(false); toggle(path, true); }} onCancel={() => setCreating(false)} />
        </div>
      )}
      {entries !== null && (
        <div class="mem-list" onClick={follow}>
          {entries.map((entry) => (
            <Entry key={entry.path} project={project} entry={entry} editable={editable} open={opened.has(entry.path)}
              onToggle={() => toggle(entry.path)} onHistory={() => showHistory(entry.path)} reload={load} context={context} />
          ))}
        </div>
      )}
      <div class="sec" ref={historyRef}>
        <h3><button type="button" class="sec-toggle" onClick={() => setHistoryOpen(!historyOpen)}>
          <span class="caret">{historyOpen ? "▾" : "▸"}</span> History
        </button></h3>
        {historyOpen && filter !== null && (
          <>
            <code>{filter}</code>
            <button type="button" class="icon" onClick={() => setFilter(null)}>×</button>
          </>
        )}
      </div>
      {historyOpen && <History project={project} head={head} path={filter} context={context} />}
    </>
  );
}

/** One entry: its name, description and type; opened, its text and its last change, or the editor. */
function Entry({ project, entry, editable, open, onToggle, onHistory, reload, context }: {
  project: ProjectRef; entry: MemoryEntry; editable: boolean; open: boolean;
  onToggle(): void; onHistory(): void; reload(): Promise<MemoryEntry[] | null>; context: Context;
}) {
  // The file as last read, with the hash the entry had when that read was asked for: if the file moved on before the
  // read, the text is newer than the hash and a save from it is refused `Changed`, never saved over unseen text.
  const [read, setRead] = useState<{ text: string | null; hash: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ text: string; base: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const hash = entry.hash;
    project.memoryFile({ path: entry.path }).then(
      (text) => { if (live) { setRead({ text, hash }); setError(null); } },
      (err: unknown) => { if (live) setError(errorText(err)); },
    );
    return () => { live = false; };
  }, [project, entry.path, entry.hash, open]);
  const text = read?.text ?? null;
  // Edit and Delete only from a read of the entry as it is listed now, against the hash that read was asked for under.
  const current = read !== null && read.text !== null && read.hash === entry.hash ? { text: read.text, base: read.hash } : null;
  const remove = async () => {
    if (current === null || !confirm(`Delete ${entry.path}?`)) return;
    setDeleting(true);
    setError(null);
    try {
      await project.deleteMemory({ path: entry.path, base: current.base });
      await reload();
    } catch (err) {
      const word = writeError(err);
      setError(word ?? errorText(err));
      if (word === "Changed") await reload();
    } finally {
      setDeleting(false);
    }
  };
  const isIndex = entry.path === INDEX;
  return (
    <div class="mem-entry">
      <button type="button" class="mem-row" onClick={onToggle}>
        <span class="caret">{open ? "▾" : "▸"}</span>
        <span class="mem-name">{isIndex ? "Index" : entry.name ?? entry.path}</span>
        <span class="mem-hook">{entry.description ?? ""}</span>
        {isIndex ? <span class="id muted">{entry.path}</span> : entry.type !== null && <span class="tag">{entry.type}</span>}
      </button>
      {open && (editing !== null
        ? (
          <Editor project={project} path={entry.path} initial={editing.text} base={editing.base} listed={[]} reload={reload}
            onSaved={() => setEditing(null)} onCancel={() => setEditing(null)} />
        )
        : (
          <div class="mem-body">
            <div class="mem-card">
              {text !== null && <div class="mem-text-view"><Markdown text={stripFrontmatter(text)} /></div>}
              <div class="mem-foot">
                {entry.last !== null && <span>{ago(Date.now() - Date.parse(entry.last.at))} ago<Who change={entry.last} context={context} sep /></span>}
                <span class="bar-gap" />
                {editable && <button type="button" disabled={current === null} onClick={() => current !== null && setEditing(current)}>Edit</button>}
                <button type="button" class="quiet" onClick={onHistory}>History</button>
                {editable && <button type="button" class="quiet danger" disabled={deleting || current === null} onClick={() => void remove()}>Delete</button>}
              </div>
            </div>
            {error !== null && <p class="error">{error}</p>}
          </div>
        ))}
    </div>
  );
}

/**
 * The raw file in a box, `Save` and `Cancel`; with `path` null, a name for a new file first (one not `listed`). A
 * refused save keeps the text and says `Changed` or `Busy`. `Changed` reloads the entries, but the editor keeps the
 * `base` it opened with: Save answers `Changed` until the user cancels and edits the reloaded entry, so it never saves
 * over text the user has not seen.
 */
function Editor({ project, path, initial, base, listed, reload, onSaved, onCancel }: {
  project: ProjectRef; path: string | null; initial: string; base: string | null; listed: readonly string[];
  reload(): Promise<MemoryEntry[] | null>; onSaved(path: string): void; onCancel(): void;
}) {
  const [name, setName] = useState("");
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<"Changed" | "Busy" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nameBox = useRef<HTMLInputElement>(null);
  useEffect(() => { nameBox.current?.focus(); }, []);
  const target = path ?? name.trim();
  const savable = path !== null || canSaveNew(target, listed);
  const save = async () => {
    if (!savable) return;
    setBusy(true);
    setRefused(null);
    setError(null);
    try {
      await project.writeMemory({ path: target, text, base });
      await reload();
      onSaved(target);
    } catch (err) {
      const word = writeError(err);
      if (word === null) setError(errorText(err));
      else setRefused(word);
      if (word === "Changed") await reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="mem-body">
      {path === null
        ? <input ref={nameBox} class="mem-file" value={name} onInput={(e) => setName(e.currentTarget.value)} />
        : <label class="mem-file" for={`mem-${path}`}>{path}</label>}
      <textarea id={path === null ? undefined : `mem-${path}`} class="mem-text" value={text} onInput={(e) => setText(e.currentTarget.value)} />
      <div class="mem-foot">
        <button type="button" class="primary" disabled={busy || !savable} onClick={() => void save()}>Save</button>
        <button type="button" onClick={onCancel}>Cancel</button>
        {refused !== null && <span class="flag">{refused}</span>}
      </div>
      {error !== null && <p class="error">{error}</p>}
    </div>
  );
}

/** Who made `change`: a link to its task when the pool knows it, else its name as `changeWho` gives it. */
function Who({ change, context, sep = false }: { change: MemoryChange; context: Context; sep?: boolean }) {
  const title = (id: string) => context.tasks.find((t) => t.id === id)?.title ?? null;
  const who = changeWho(change, title);
  if (who.label === "") return null;
  const task = who.taskId === null ? undefined : context.tasks.find((t) => t.id === who.taskId);
  return (
    <>
      {sep && " · "}
      {task !== undefined
        ? <a href={hashOf({ name: "task", nodeId: task.nodeId, id: task.id })} onClick={(e) => e.stopPropagation()}>{who.label}</a>
        : <span>{who.label}</span>}
    </>
  );
}

/** The history under `memory`, newest first, 50 at a time; only changes touching `path` when it is set. */
function History({ project, head, path, context }: { project: ProjectRef; head: string | null; path: string | null; context: Context }) {
  const [rows, setRows] = useState<HistoryRows | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reads = useRef(0);
  const page = async (before: string | undefined) => {
    const n = ++reads.current;
    setLoading(true);
    try {
      const list = await project.memoryHistory({ limit: HISTORY_PAGE, ...(before === undefined ? {} : { before }), ...(path === null ? {} : { path }) });
      if (n !== reads.current) return;
      setRows((current) => before === undefined
        ? mergeFirstPage(current, list, HISTORY_PAGE)
        : { list: [...(current?.list ?? []), ...list], more: list.length === HISTORY_PAGE });
      setError(null);
    } catch (err) {
      if (n === reads.current) setError(errorText(err));
    } finally {
      if (n === reads.current) setLoading(false);
    }
  };
  // Another project or path starts over; a new head only reads the first page again, keeping open rows and pages below.
  const shown = useRef<{ project: ProjectRef; path: string | null } | null>(null);
  useEffect(() => {
    if (shown.current?.project !== project || shown.current.path !== path) {
      shown.current = { project, path };
      setRows(null);
    }
    void page(undefined);
  }, [project, head, path]);
  return (
    <div class="mem-list">
      {error !== null && <p class="error">{error}</p>}
      {rows?.list.map((c) => <Change key={c.change} project={project} change={c} context={context} />)}
      {rows?.more === true && (
        <div class="mem-older"><button type="button" class="quiet" disabled={loading} onClick={() => void page(rows.list.at(-1)!.change)}>Older</button></div>
      )}
    </div>
  );
}

/** One change of the history; opened, each file it touched as a diff against its parent's version. */
function Change({ project, change: c, context }: { project: ProjectRef; change: MemoryChange; context: Context }) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<{ patch: FilePatch; file: string[] | null }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || files !== null) return;
    let live = true;
    (async () => {
      const patches = parseGitDiff(await project.memoryDiff({ change: c.change }));
      return Promise.all(patches.map(async (patch) => {
        if (patch.status === "added") return { patch, file: null };
        const old = await project.memoryFile({ path: patch.oldPath ?? patch.path, change: `${c.change}-` }).catch(() => null);
        return { patch, file: old === null ? null : textLines(old) };
      }));
    })().then(
      (list) => { if (live) setFiles(list); },
      (err: unknown) => { if (live) setError(errorText(err)); },
    );
    return () => { live = false; };
  }, [project, c.change, open, files]);
  const node = c.node === null ? null : context.nodeName(c.node);
  return (
    <div class="mem-entry">
      {/* The row opens on a click anywhere but its task link; the button's own click (a key on it too) bubbles here. */}
      <div class="mem-row hist" onClick={() => setOpen(!open)}>
        <button type="button" class="hist-toggle" aria-expanded={open}>
          <span class="caret">{open ? "▾" : "▸"}</span>
          <span class="id muted">{c.change.slice(0, 8)}</span>
          <span>{ago(Date.now() - Date.parse(c.at))} ago</span>
        </button>
        <Who change={c} context={context} />
        {node !== null && <span class="muted" title={c.node ?? undefined}>{node}</span>}
        <span class="bar-gap" />
        <span class="muted">{c.files.length} {c.files.length === 1 ? "file" : "files"}</span>
        {c.added > 0 && <span class="id add">+{c.added}</span>}
        {c.removed > 0 && <span class="id del">−{c.removed}</span>}
      </div>
      {open && (
        <div class="mem-body">
          {error !== null && <p class="error">{error}</p>}
          {files?.map(({ patch, file }) => (
            <DiffView key={patch.path} hunks={patch.hunks} file={file}
              head={{ path: patch.path, status: patch.status, added: patch.added, removed: patch.removed }} />
          ))}
        </div>
      )}
    </div>
  );
}
