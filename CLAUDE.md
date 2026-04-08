# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is loom

loom is a local-first agent runtime where agents are Unix processes, all state lives in the filesystem, and everything is observable with standard Unix tools (`cat`, `tail`, `grep`, `ls`). The project is published under the `@losoft/loom-*` npm scope.

## Commands

```sh
bun install              # install dependencies (workspaces)
bun run build            # build all packages (dual-target: Bun + Node.js)
bun test                 # run all tests
bun test --filter <pat>  # run a single test file matching pattern
bun run check            # biome check (lint + format)
bun run fix              # biome auto-fix
bun run lint             # lint only
bun run format           # format only
bun run loom <command>   # run the CLI from source (e.g. bun run loom agent ps)
```

Default to using Bun instead of Node.js for all commands.

A pre-commit hook runs `biome check --staged`, `bun run build`, and `bun test` on every commit. It is activated automatically by `bun install` (via the `prepare` script).

## Monorepo structure

- **`packages/runtime`** (`@losoft/loom-runtime`) — Zero-dependency core primitives: `AgentProcess` (filesystem-backed agent state), `ProcessTable`, `InboxWatcher` (polling-based), and message utilities (`send`, `read`, `claim`, `acknowledge`, `consume`, `list`, `quarantine`). No external runtime dependencies allowed.
- **`packages/runner`** (`@losoft/loom-runner`) — Will connect an agent's inbox to an LLM via the provider abstraction. Depends on `@losoft/loom-runtime`. See ADR-005 for the architecture. Currently scaffolded only.
- **`packages/supervisor`** (`@losoft/loom-supervisor`) — Process manager and message router: spawns runners and pipe processes, detects crashes, restarts with backoff, and copies messages between outbox and inbox directories according to a routes table. Contains `Supervisor` class and restart policy logic (`RestartPolicy`, `CrashRecord`, `computeBackoff`). See ADR-004.
- **`packages/cli`** (`@losoft/loom-cli`) — CLI entry point (`loom agent start`, `loom agent ps`, `loom up`, etc). Depends on all other packages. See ADR-006. Commands are currently stubs.
- **`tools/`** — Build scripts (e.g. `build-publish-package.ts`).

Each package builds for both Bun and Node.js targets (`dist/bun/` and `dist/node/`).

## Key architecture concepts

- **Agents are processes** — each agent has a directory under `$LOOM_HOME/agents/{name}/` with plain-text files for `pid`, `status`, `model`, and subdirectories for `inbox/`, `outbox/`, `memory/`, `logs/`, `crashes/`. `$LOOM_HOME` defaults to `~/.loom` (see `loomHome()` in `packages/runtime/src/env.ts`). **Gotcha:** APIs like `AgentProcess`, `ProcessTable`, and `InboxWatcher.forAgent()` take a `home` parameter that must be the agents root (`$LOOM_HOME/agents`), not `$LOOM_HOME` itself.
- **Messages are files** — `.msg` JSON files named `{timestamp_ms}-{id}.msg`. Three-phase lifecycle: pending (`inbox/`) → claimed (`inbox/.in-progress/`) → processed (`inbox/.processed/`). Unreadable messages go to `inbox/.unreadable/`.
- **Runners are self-sufficient** — each runner is an OS process that owns its agent's full lifecycle (inbox polling, LLM calls, tool execution, outbox writes, status updates). The supervisor spawns runners and pipe processes, handles restarts, and routes messages between them by watching outbox directories and copying to inbox directories — it does not mediate message processing.
- **Pipes are processes** — each pipe instance has the same directory structure as an agent (`pid`, `status`, `inbox/`, `outbox/`, `logs/`, `crashes/`, `state/`) plus `steps/` for intermediate operator output, under `$LOOM_HOME/pipes/{name}~{source-agent}→{dest-agent}/`. Pipes are arrays of operators: `operator: command` (runs any shell command — stdin/stdout, exit 0 = forward, non-zero = drop) for stateless work, and built-in operators (`window`, `dedupe`, `throttle`, `accumulate`, `tap`, `buffer`) for stateful work. See ADR-010.
- **Wiring** — messages flow **agent → (optional pipe) → agent**. Agents declare inputs with `from:` entries: `- agent: <name>` for direct, `- agent: <name>` + `pipe: <name>` for piped. No pipe-to-pipe chaining. See ADR-010, ADR-011.
- **Origin tracking** — the `origin` field on messages is a slash-delimited path of filenames tracing a pipeline run. Used for fan-in grouping and restart recovery. See ADR-009.
- **ADRs** — Architecture decision records live in `docs/adrs/`. New design decisions require an ADR.

## Code conventions

- TypeScript strict mode. Biome for linting/formatting (spaces, double quotes, semicolons, trailing commas, 100-char line width).
- Tests live alongside source as `*.test.ts` files. Tests should verify filesystem state, not just return values.
- Commits use Conventional Commits (e.g. `feat:`, `fix:`, `docs:`, `refactor:`, `test:`).
- Every public function needs a one-line JSDoc comment.
- Core vs plugin boundary: if it requires an external service or adds a dependency to core, it's a plugin (separate `@losoft/loom-*` package).
