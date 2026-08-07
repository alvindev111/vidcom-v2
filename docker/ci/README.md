# Containerised CI gates

Runs the gates from `.github/workflows/ci.yml` on the local machine, in an image
that matches the hosted Linux runner. It exists so hosted-runner quota is not the
only way to get a verdict; it is not a replacement for the workflows.

## Running

From the repository root:

```bash
docker compose -f docker-compose.ci.yml build          # once, and after a pin changes
docker compose -f docker-compose.ci.yml run --rm ci    # every gate, in workflow order
```

Individual gates, by name:

```bash
docker compose -f docker-compose.ci.yml run --rm ci list
docker compose -f docker-compose.ci.yml run --rm ci typecheck lint
docker compose -f docker-compose.ci.yml run --rm ci test
```

The first run installs the dependency graph into a named volume, which takes a
few minutes. Later runs reuse it; pass `install` explicitly after changing
`bun.lock`. For a shell inside the same environment:

```bash
docker compose -f docker-compose.ci.yml run --rm --entrypoint bash ci
```

To discard the installed dependencies and build output and start clean:

```bash
docker compose -f docker-compose.ci.yml down -v
```

## What it covers

Everything the Linux job in `ci.yml` runs — typecheck, the embedded agent-kit
bundle check, lint, import boundaries, the full Vitest suite with
`VIDCOM_REQUIRE_FFMPEG=1`, the VieNeu sidecar contract, MCP contracts, goldens,
schema drift, Verification Matrix paths, the production build, and the real Next
runtime and SSE smoke — plus the process-supervision spike from
`process-supervision.yml`, run twice.

The toolchain is pinned to the same versions the workflows pin: Node 24.9.0, Bun
1.3.14, Python 3.12, and FFmpeg. Google Chrome is installed because the two
Puppeteer suites skip themselves when no browser is present and the hosted runner
ships one, so leaving it out would turn a covered path into a silent skip.

## What it does not cover

- **Windows.** Covered separately by [`windows-sandbox`](../../windows-sandbox/README.md),
  which runs the same gate names in a throwaway Windows, along with the
  Windows-only steps from `process-supervision.yml` that have no counterpart
  here — the degraded PowerShell-CIM enumerator path and the real-render
  process-tree observation.
- **macOS arm64.** A container cannot provide it at all. That leg stays with the
  workflow, or with a real machine.
- **`vieneu-real.yml`.** The speech engine is a multi-hundred-megabyte download
  and is deliberately not installed, exactly as in `ci.yml`.

A green run here therefore says "Linux is clean", not "CI is green".

## One deliberate difference from the workflow

The Vitest gates pass `--maxWorkers=4`, which the workflow does not. Vitest sizes
its pool from the host's core count even inside a container, so on a workstation
it starts several times as many workers as a hosted runner does; the suites that
spawn an MCP server or a render subprocess then lose the race against the 5s
Linux timeout. Seven files failed that way on the first run here and every one of
them passed in under a second when run alone. The cap reproduces the runner's
shape. Raising the timeouts instead would have hidden the hang signal that
`vitest.config.ts` deliberately keeps tight on Linux. Set `VITEST_WORKERS` to
override.

## Keeping it honest

The gate list in `run-gates.sh` is a copy of the workflow steps, so the two drift
independently. When a step is added to `ci.yml`, add it here as well. The
`toolchain` gate prints every pinned version on each run so an image that has
fallen behind the workflow shows up in the log rather than in a wrong verdict.
