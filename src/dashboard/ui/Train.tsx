// A project's merge train, to watch: its queue, and the round under way with its merge task and the batch under it,
// from the project's home, which runs the train. The user accepts on a task; here is only Unqueue (a task off), Retry
// (one that sits out), Pause and Resume. No history: what landed is on the branch, and its tasks are archived.
import type { Host } from "@earendil-works/chord";
import { useEffect, useRef } from "preact/hooks";
import { ProjectObject } from "../../state/contracts";
import { shortId } from "../../pool/ids";
import { type Hosts, useAction, useObject, useValue } from "./hooks";
import { PaneHead, type PoolRef, Unavailable } from "./common";
import { Glyph } from "./icons";
import { projectChoices } from "./pool-model";
import { hashOf } from "./routes";
import { type ListedTask, type PoolIndex, type ProjectRef, useOptionalTrain } from "./sources";
import { mergeStatus, pausedText, queuedChip, resumeLabel, trainColumns, trainError, type TrainView } from "./train-model";

/** The Queued column's state chips: what the train is doing to a task is blue, a task that waits on you or a node is amber. */
function tone(state: string): string {
  if (state === "describing" || state === "rebasing onto main") return " blue";
  if (state === "sitting out" || state.startsWith("waiting for ")) return " warn";
  return "";
}

export function TrainPage({ hosts, pool, index, projectId, highlight }: {
  hosts: Hosts; pool: PoolRef; index: PoolIndex; projectId: string; highlight: string | undefined;
}) {
  const nodes = useValue(pool.nodes);
  const listed = projectChoices(nodes).find((p) => p.id === projectId);
  if (listed === undefined) {
    return <><TrainHead name={projectId} projectId={projectId} /><p class="pane-note muted">No online node lists this project.</p></>;
  }
  const homeRow = nodes.find((n) => n.nodeId === listed.home);
  const homeName = homeRow?.hostname ?? shortId(listed.home);
  const homeOnline = listed.home === hosts.selfId || (homeRow?.status === "member" && homeRow.online);
  if (!homeOnline) {
    // The train waits for its home; the tasks that are queued are known from their own nodes.
    const state: TrainView = {
      paused: null,
      round: null,
      queued: index.tasks.filter((t) => t.queued && !t.archived && t.projects.length === 1 && t.projects[0]!.id === projectId)
        .map((t) => ({ taskId: t.id, state: "queued", reason: null })),
    };
    return (
      <div class="train">
        <TrainHead name={listed.name} projectId={projectId}><span class="flag train-wait">{homeName} offline</span></TrainHead>
        <Board state={state} index={index} highlight={highlight} project={null} />
      </div>
    );
  }
  const host = hosts.for(listed.home);
  if (host === undefined) {
    return <><TrainHead name={listed.name} projectId={projectId} /><div class="pane-note"><Unavailable status={hosts.status(listed.home)} /></div></>;
  }
  return <TrainOnHome host={host} name={listed.name} projectId={projectId} homeName={homeName} index={index} highlight={highlight} />;
}

/** The page's head: the project and where its train lands, then `children` (the train's state and Pause or Resume). */
function TrainHead({ name, projectId, branch, children }: { name: string; projectId: string; branch?: string | null; children?: preact.ComponentChildren }) {
  return (
    <PaneHead>
      <strong><Glyph name="merge" cls="train-ico" /> <a href={hashOf({ name: "project", id: projectId })}>{name}</a>{typeof branch === "string" && ` → ${branch}`}</strong>
      <span class="bar-gap" />
      {children}
    </PaneHead>
  );
}

function TrainOnHome({ host, name, projectId, homeName, index, highlight }: {
  host: Host; name: string; projectId: string; homeName: string; index: PoolIndex; highlight: string | undefined;
}) {
  const project = useObject(host, ProjectObject, { id: projectId });
  if (project.error !== undefined) {
    return <><TrainHead name={name} projectId={projectId} /><p class="pane-note error">{trainError(project.error, homeName)}</p></>;
  }
  if (project.ref === undefined) return <><TrainHead name={name} projectId={projectId} /><p class="pane-note muted">Loading…</p></>;
  return <TrainLive project={project.ref} name={name} projectId={projectId} homeName={homeName} index={index} highlight={highlight} />;
}

function TrainLive({ project, name, projectId, homeName, index, highlight }: {
  project: ProjectRef; name: string; projectId: string; homeName: string; index: PoolIndex; highlight: string | undefined;
}) {
  const state = useOptionalTrain(project);
  const branch = useValue(project.defaultBranch);
  const action = useAction();
  if (state === undefined) return <><TrainHead name={name} projectId={projectId} /><p class="pane-note error">{trainError("not_in_variant", homeName)}</p></>;
  return (
    <div class="train">
      <TrainHead name={name} projectId={projectId} branch={branch}>
        {action.error !== null && <span class="error train-error" title={action.error}>{action.error}</span>}
        {state.paused === null ? (
          <button disabled={action.busy} onClick={() => action.run(() => project.pause({}))}>Pause</button>
        ) : (
          <>
            <span class="flag train-wait" title={pausedText(state.paused) === "Stuck" ? state.paused : undefined}>{pausedText(state.paused)}</span>
            <button class="primary" disabled={action.busy} onClick={() => action.run(() => project.resume({}))}>{resumeLabel(state.paused)}</button>
          </>
        )}
      </TrainHead>
      <Board state={state} index={index} highlight={highlight} project={project} />
    </div>
  );
}

/** The two columns: Queued, and This round (its steps, its merge task, the batch under it). */
function Board({ state, index, highlight, project }: { state: TrainView; index: PoolIndex; highlight: string | undefined; project: ProjectRef | null }) {
  const action = useAction();
  const live = new Map<string, ListedTask>(index.tasks.filter((t) => !t.archived).map((t) => [t.id, t]));
  const columns = trainColumns(state, live);
  const reason = new Map(state.queued.map((t) => [t.taskId, t.reason]));
  const unqueue = (taskId: string) => live.get(taskId)?.ref.unqueue({});
  const mergeTask = columns.round?.mergeTask ?? null;
  const merge = mergeTask === null ? undefined : live.get(mergeTask);
  const row = (taskId: string, title: string, tree: string | null, tail: preact.ComponentChildren) => (
    <Row key={taskId} highlighted={taskId === highlight} tree={tree}>
      {live.has(taskId)
        ? <a class="tt" title={title} href={hashOf({ name: "task", nodeId: live.get(taskId)!.nodeId, id: taskId })}>{title}</a>
        : <span class="tt" title={title}>{title}</span>}
      {tail}
    </Row>
  );
  const off = (taskId: string) => live.has(taskId) && (
    <button class="link" disabled={action.busy} onClick={() => action.run(async () => { await unqueue(taskId); })}>Unqueue</button>
  );
  return (
    <>
      {action.error !== null && <p class="error train-error">{action.error}</p>}
      <div class="train-board">
        <section class="train-col">
          <div class="train-colhead">Queued</div>
          {columns.queued.length === 0 && <p class="train-empty">Nothing queued</p>}
          {columns.queued.map((t) => row(t.taskId, t.title, null, (
            <>
              <span class={`train-chip${tone(t.state)}`} title={reason.get(t.taskId) ?? undefined}>{queuedChip(t.state)}</span>
              {t.state === "sitting out" && project !== null && (
                <button class="link" disabled={action.busy} title={reason.get(t.taskId) ?? undefined}
                  onClick={() => action.run(() => project.retry({ taskId: t.taskId }))}>Retry</button>
              )}
              {off(t.taskId)}
            </>
          )))}
        </section>
        <section class="train-col round">
          <div class="train-colhead">This round</div>
          {columns.round === null ? <p class="train-empty">No round</p> : (
            <>
              <div class="train-steps">
                {columns.round.steps.map((s) => <span key={s.name} class={s.now ? "current" : s.done ? "finished" : ""}>{s.done ? "✓ " : ""}{s.name}</span>)}
              </div>
              {mergeTask !== null && (
                <div class="train-merge">
                  <div class="mt">
                    <Glyph name="merge" cls="train-ico" />Merge task
                    <span class="train-chip purple">{mergeStatus(state.round!.step, merge?.state ?? null)}</span>
                    <span class="grow" />
                    {merge !== undefined && <a href={hashOf({ name: "task", nodeId: merge.nodeId, id: merge.id })}>Open</a>}
                  </div>
                  {merge !== undefined && <div class="ms" title={merge.title}>{merge.title}</div>}
                </div>
              )}
              {columns.round.batch.map((t, i, all) => row(t.taskId, t.title, mergeTask === null ? null : i === all.length - 1 ? "└" : "├", off(t.taskId)))}
            </>
          )}
        </section>
      </div>
    </>
  );
}

/** A task's row on the page; the one the page was opened for is highlighted, and scrolled into view. */
function Row({ highlighted, tree, children }: { highlighted: boolean; tree: string | null; children: preact.ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (highlighted) ref.current?.scrollIntoView({ block: "nearest" }); }, [highlighted]);
  return (
    <div ref={ref} class={`train-row${highlighted ? " hl" : ""}`}>
      {tree !== null && <span class="tree">{tree}</span>}
      {children}
    </div>
  );
}
