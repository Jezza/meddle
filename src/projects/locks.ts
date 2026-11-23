// A project's lock: what `meddle project remove`'s cleanup of a project and every path that checks the removed list and
// then writes something of the project (a task created, received or restored here) hold, so that a removal landing
// midway either waits for such a path (and cleanup then undoes what it made) or makes it refuse.
import { serialised } from "../serial";

/** The key that serialises the work on project `projectId` that a removal must not overlap. */
function projectKey(projectId: string): string {
  return `project\0${projectId}`;
}

/**
 * Runs `fn` holding the lock of each distinct project of `projectIds`, taken one by one in sorted order, so that two
 * callers of the same projects never wait on each other; resolves or rejects as `fn` does. Not re-entrant: nothing
 * `fn` runs may take a project's lock again, or it waits for itself.
 */
export function withProjectLocks<T>(projectIds: readonly string[], fn: () => Promise<T>): Promise<T> {
  const ids = [...new Set(projectIds)].sort();
  const take = (i: number): Promise<T> => (i === ids.length ? fn() : serialised(projectKey(ids[i]!), () => take(i + 1)));
  return take(0);
}
