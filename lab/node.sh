#!/bin/sh
# Runs the meddle CLI as lab node $TPO_NODE (else the namespace's hostname) with a hermetic environment:
#   tpo exec a -- node.sh status        (the CLI must run inside the node that owns the service)
# The [run] entry of meddle-lab.toml starts `node.sh serve` in every meddle node.
S=$(cd "$(dirname "$0")" && pwd)
R=$(cd "$S/.." && pwd)
N=${TPO_NODE:-$(hostname)}
H=$S/nodes/$N
mkdir -p "$H/t"
BIND=${LAB_IROH_BIND:-${TPO_ADDR:+$TPO_ADDR:0}}
BIND=${BIND:-0.0.0.0:0}
cd "$R" || exit 1
exec env -i \
  PATH="$PATH" LANG=C.UTF-8 TPO_NODE="$N" \
  HOME="$H" \
  MEDDLE_DATA_DIR="$H/d" MEDDLE_TASK_ROOT="$H/t" \
  JJ_USER=lab JJ_EMAIL=lab@example.invalid \
  MEDDLE_PORT=7777 MEDDLE_IROH_BIND="$BIND" MEDDLE_IROH_PRESET=minimal \
  MEDDLE_LIGHTHOUSE_URL=http://lh:8080 MEDDLE_DISCOVERY_POLL_MS=1000 \
  MEDDLE_CLAUDE_PATH="$R/test/fake-claude/replay.ts" MEDDLE_CLAUDE_RUNTIME=bun \
  MEDDLE_FIXTURE="$R/test/fixtures/hello.jsonl" MEDDLE_FIXTURE_MEMORY=1 \
  bun run "$R/src/cli.ts" "$@"
