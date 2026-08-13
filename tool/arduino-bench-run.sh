#!/usr/bin/env bash
# Drive the Arduino benchmark: one ayin headless run per project, in its own empty directory.
#
# This is the half `arduino-bench.mjs` deliberately does not do — it spends GPU time, so it is a
# separate, explicit command. `grade` is pure measurement and safe to rerun; this is not.
#
#   tool/arduino-bench-run.sh <workdir> [project-id ...]     (default: every project)
#
# AYIN_PLAN=1 / AYIN_QA=1 force the session toggles on from the environment — headless has no TUI to
# type `/plan` into, so without them the benchmark would measure ayin with its gates off, which is not
# the thing under test. Presenter stays off: it is a TUI feature (`doPresenter … && !HEADLESS`), and
# the artifact regeneration it would do is already done by the QA executor's prepare().
set -uo pipefail

AYIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPEC="$AYIN_ROOT/bench/arduino/projects.json"
WORK="${1:?usage: arduino-bench-run.sh <workdir> [project-id ...]}"
shift || true

TIMEOUT="${BENCH_TIMEOUT:-900}"
mkdir -p "$WORK"

# `--ladder N` runs exactly that ladder; otherwise every project in the spec.
LADDER_ARG=""
if [ "${1:-}" = "--ladder" ]; then LADDER_ARG="$2"; shift 2; fi
if [ -n "$LADDER_ARG" ]; then
  key="ladder$LADDER_ARG"; [ "$key" = "ladder1" ] && key="ladder"
  mapfile -t ALL < <(node -e "const l=JSON.parse(require('fs').readFileSync('$AYIN_ROOT/bench/arduino/ladder.json','utf8'))['$key']||[];l.forEach(x=>console.log(x.id))")
else
  mapfile -t ALL < <(node -e "JSON.parse(require('fs').readFileSync('$SPEC','utf8')).projects.forEach(p=>console.log(p.id))")
fi
TARGETS=("$@")
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=("${ALL[@]}")

for id in "${TARGETS[@]}"; do
  prompt="$(node -e "
    const p=JSON.parse(require('fs').readFileSync('$SPEC','utf8')).projects.find(x=>x.id==='$id');
    if(!p){console.error('no such project: $id');process.exit(1);}
    process.stdout.write(p.prompt);
  ")" || { echo "!! unknown project $id"; continue; }

  dir="$WORK/$id"
  # A rerun must start from an empty directory or it grades the previous attempt's leftovers.
  rm -rf "$dir"; mkdir -p "$dir"

  echo "════════ $id ════════"
  echo "  $prompt"
  start=$(date +%s)
  (
    cd "$dir" || exit 1
    AYIN_PLAN=1 AYIN_QA=1 AYIN_ACQUIRE_LLM=1 \
      timeout "$TIMEOUT" node "$AYIN_ROOT/dist/index.js" -p "$prompt"
  ) >"$WORK/$id.log" 2>&1
  rc=$?
  echo "  → exit $rc in $(( $(date +%s) - start ))s   (log: $WORK/$id.log)"
  ls -1 "$dir" 2>/dev/null | sed 's/^/     /'
done

echo
echo "Now grade:  node $AYIN_ROOT/tool/arduino-bench.mjs grade $WORK"
