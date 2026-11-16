# Idempotent `project add`

## Why

`meddle project add <folder>` always mints a new project. Re-running it on a folder that is already a project (to
repair a checkout whose `meddle` remote went missing, as `~/projects/meddle` and `~/projects/faff` had) makes a
duplicate instead. Both of those projects also held no branches in meddle, so tasks had nothing to start from and
nothing to be judged accepted against. Re-running `project add` should be the one way to put that right.

## Goals

- Re-running `project add` on a folder that is already a project repairs it and prints the existing id:
  - the folder's `meddle` remote added or corrected, fetched, and the default branch tracked (what a first add does);
  - when meddle holds no default branch for the project, the folder's `main` (else `master`) pushed to it, and made the
    project's default branch if it has none.
- Re-running it on an upstream URL already added prints the existing id and changes nothing.

## Non-goals

- Renaming a project. A re-run whose `--name` differs from the project's is refused:
  `<folder> is already project <id> (<name>)`.
- Merging duplicates that already exist.

## Anti-goals

- A second way for branches to get into meddle. Recording the default branch goes through an ordinary push, so it
  gets the push path's commit transfer, rows, drops and conflict refusal.

## Approaches

- **A, picked: the re-run pushes the branch like a user would.** The node only learns to find an existing project; the
  CLI, the only part that touches the folder, repairs the remote, fetches, and pushes the default branch when it did
  not come back. One path for branches, little new code.
- **B: the node records the branch itself,** fetching it from the folder into the service repo and writing its row,
  as a first add does. Keeps "record the default branch" in one place, but adds a second, node-side way for branches
  to enter meddle that duplicates what a push does.

## Design

**Finding the project.**

1. The CLI passes the project the folder's `meddle` remote names (`checkoutAt`), if any. The node answers it when it
   holds it. This covers clones made by `meddle checkout`, whose path the node never saw. When the pool lists that
   project but this node does not hold it yet, the CLI refuses rather than mint a second one.
2. Otherwise, on the node: `addProjectFromFolder` returns the project of this node whose folder source is the same
   resolved path, instead of minting one; `addProjectFromUpstream` does the same for an equal URL. Either refuses a
   differing `name` as above. An existing project with no default branch takes the folder's `main`, else `master`.

**Repairing the checkout.** `attachCheckout` as today. Then, unless `--no-fetch`: if `<default>@meddle` did not
arrive and the node lists no such branch in any state (`ProjectObject.branches`: not single, conflicted, or still
fetching another node's push), the CLI pushes the folder's default branch to `meddle` (tracking it first, as jj needs).
Holding off while a branch is fetching or conflicted keeps a repair from turning into a pool-wide conflict.

This step is the same for a first add and a re-run: after a first add the branch arrives on the fetch, so nothing is
pushed. No "was it new?" flag is needed.

**Left to the builder:** where the path lookup lives (`records.ts` or `project.ts`), the exact wording of messages,
and tests at the level of the existing `checkouts` and `projects` tests.
