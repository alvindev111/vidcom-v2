#!/usr/bin/env bash
#
# Runs the Linux gates from .github/workflows/ci.yml, plus the Linux-runnable
# half of process-supervision.yml, inside the container built by ./Dockerfile.
#
# The step list is duplicated from the workflows on purpose: the workflows keep
# one step per gate so GitHub's UI names the failure, and collapsing both onto a
# single script would trade that away. The cost is that this file has to be
# updated alongside them — the `toolchain` gate prints the versions so a drift in
# the image is at least visible in the log.
#
# Usage (from the repo root, through docker-compose.ci.yml):
#   docker compose -f docker-compose.ci.yml run --rm ci            # every gate
#   docker compose -f docker-compose.ci.yml run --rm ci list       # gate names
#   docker compose -f docker-compose.ci.yml run --rm ci typecheck lint
set -euo pipefail

# The checkout is bind-mounted from the host, so its ownership does not match
# the container's root and git refuses to read it without this. `test:agent-kit`
# and `test:schema-drift` both shell out to git.
git config --global --add safe.directory /work

# The CLI end-to-end tests stage a packed artifact under packages/cli and remove
# it themselves, but a killed run leaves the directory behind — and because the
# checkout is bind-mounted, that leftover outlives the container. `npm pack` then
# packs the leftover into the next one, nesting until it fails on a path that no
# longer resolves, which reads as a CLI defect rather than as debris. Only the
# gitignored staging directories are touched.
leftovers=(/work/packages/cli/.artifact-*/)
if [[ -d "${leftovers[0]:-}" ]]; then
  echo "==> removing ${#leftovers[@]} leftover CLI artifact staging directories from an interrupted run"
  rm -rf "${leftovers[@]}"
fi

# Vitest sizes its worker pool from the host's core count even inside a
# container, and a workstation has several times what a hosted runner does. The
# suites that spawn an MCP server or a render subprocess then compete for cores
# with sixteen sibling workers doing the same, and lose against the 5s Linux
# timeout — seven files failed that way while each passed in under a second on
# its own. Capping the pool reproduces the runner's SHAPE; the alternative,
# raising the timeouts, would only hide the hang signal the config exists to
# keep. Override with VITEST_WORKERS if this machine wants a different number.
VITEST_WORKERS=${VITEST_WORKERS:-4}

# name:::command — order matches the workflow steps.
GATES=(
  "install:::bun install --frozen-lockfile"
  "toolchain:::node --version && npm --version && bun --version && python3 --version && ffmpeg -version | head -1 && ffprobe -version | head -1 && google-chrome-stable --version"
  "typecheck:::npm run typecheck"
  "agent-kit:::npm run test:agent-kit"
  "lint:::npm run lint"
  "boundaries:::npm run test:boundaries"
  # VIDCOM_REQUIRE_FFMPEG turns a missing FFmpeg into a failure instead of a
  # skip, so this cannot report green while the narration audio pipeline goes
  # unrun. Set here rather than in compose so a bare `docker run` keeps it.
  "test:::VIDCOM_REQUIRE_FFMPEG=1 npm run test -- --maxWorkers=$VITEST_WORKERS"
  "vieneu-sidecar:::npm run test:vieneu-sidecar"
  "mcp-contract:::npm run test:mcp-contract -- --maxWorkers=$VITEST_WORKERS"
  "golden:::npm run test:golden -- --maxWorkers=$VITEST_WORKERS"
  "schema-drift:::npm run test:schema-drift"
  "spec-paths:::npm run test:spec-paths"
  "build:::npm run build"
  "runtime-smoke:::npm run test:runtime-smoke"
  # From process-supervision.yml. Its Vitest list is already a subset of the
  # `test` gate above, so only the spike is left — run twice, because process
  # lifecycle bugs are frequently intermittent and one green run on an idle
  # machine is weak evidence for a concurrency contract. The workflow's
  # Windows-only degraded-enumerator steps have no Linux counterpart and are
  # not represented here.
  "supervision:::npm run spike:process-supervision && npm run spike:process-supervision"
)

gate_name() { printf '%s' "${1%%:::*}"; }
gate_command() { printf '%s' "${1#*:::}"; }

if [[ "${1:-all}" == "list" ]]; then
  for gate in "${GATES[@]}"; do gate_name "$gate"; echo; done
  exit 0
fi

selected=("$@")
if [[ ${#selected[@]} -eq 0 || "${selected[0]}" == "all" ]]; then
  selected=()
  for gate in "${GATES[@]}"; do selected+=("$(gate_name "$gate")"); done
fi

# Reject an unknown name up front instead of running twelve minutes of gates and
# then reporting that the thirteenth was a typo.
for want in "${selected[@]}"; do
  found=""
  for gate in "${GATES[@]}"; do
    [[ "$(gate_name "$gate")" == "$want" ]] && found=1 && break
  done
  if [[ -z "$found" ]]; then
    echo "unknown gate: $want (run \`list\` for the names)" >&2
    exit 2
  fi
done

# `install` is what puts node_modules in place; running a later gate on its own
# against an empty volume would fail for a reason that has nothing to do with
# that gate. Prepend it unless it was already asked for.
if [[ ! -d /work/node_modules/typescript ]]; then
  case " ${selected[*]} " in
    *" install "*) ;;
    *) echo "==> node_modules is empty; adding the install gate first"; selected=("install" "${selected[@]}") ;;
  esac
fi

started_all=$SECONDS
for want in "${selected[@]}"; do
  for gate in "${GATES[@]}"; do
    [[ "$(gate_name "$gate")" == "$want" ]] || continue
    command=$(gate_command "$gate")
    echo ""
    echo "==> $want"
    started=$SECONDS
    if ! bash -o pipefail -c "$command"; then
      status=$?
      echo "==> FAILED: $want (after $((SECONDS - started))s)" >&2
      exit "$status"
    fi
    echo "==> ok: $want ($((SECONDS - started))s)"
  done
done

echo ""
echo "==> all requested gates passed ($((SECONDS - started_all))s): ${selected[*]}"
