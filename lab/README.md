# Network lab

A hermetic three-node pool under real partitions, latency, loss and crashes, built with
[tpo](https://github.com/Jezza/tpo) (virtual network topologies from Linux namespaces and `tc`,
rootless). Nothing here reaches the internet: no `internet` node, the lab's own
[iroh-lighthouse](https://github.com/Jezza/iroh-lighthouse) on node `lh`, `MEDDLE_IROH_PRESET=minimal`,
the fake token `tok-lab`, and the test suite's replayer instead of Claude Code.

Prerequisites: `tpo` (`cargo install tpo`; `tpo doctor` must say "ready to run labs"), the lighthouse
server binary (`cargo build --release -p iroh-lighthouse` in its repo; set `LIGHTHOUSE_BIN` if it is
not at `~/projects/iroh-lighthouse/target/release/lighthouse`), bun, jj and git.

Run everything (about 12 minutes; wipes `lab/nodes` and `lab/logs`):

```sh
bun run lab/run-lab.ts
```

It brings the lab up, runs the scenarios below, prints one line per check, takes the lab down and
checks that no lab and no stray process remain. By hand:

```sh
cd lab && tpo up -d meddle-lab.toml
tpo exec a -- ./node.sh status          # the CLI must run inside the node that owns the service
tpo set a b delay=80ms loss=2%          # degrade, cut, heal: see tpo --help
tpo cut b c --for 30s
tpo logs b
tpo down
```

`node.sh` runs the meddle CLI as lab node `$TPO_NODE` with its own HOME, data dir and task root under
`lab/nodes/<node>`, port 7777 inside the node's own network namespace, and the iroh socket bound to the
node's lab address.

Scenarios: up; join through discovery; token replication; project and task; a move over a degraded
link; a partition before a move; a partition during a move (several phases); a crash mid-receive; a
lighthouse outage; node isolation; restarts; memory across three nodes; resources. The results of the
first run are in `REPORT-2026-11-02.md`.
