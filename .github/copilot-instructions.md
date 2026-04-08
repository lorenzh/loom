# GitHub Copilot Instructions

loom is a local-first agent runtime where agents are Unix processes, all state lives in the filesystem, and everything is observable with standard Unix tools.

## Commands

```sh
bun install                   # install dependencies
bun run build                 # build all packages (Bun + Node.js targets)
bun test                      # run all tests
bun test --filter <pattern>   # run a single test file
bun run check                 # lint + format check (Biome)
bun run fix                   # auto-fix lint/format issues
bun run loom <command>        # run CLI from source (e.g. bun run loom ps)
```

Use Bun for all commands. A pre-commit hook runs `biome check --staged`, `bun run build`, and `bun test` automatically.

## Architecture

Four packages in a monorepo under `packages/`:

- **`@losoft/loom-runtime`** — Zero-dependency core: `AgentProcess`, `ProcessTable`, `InboxWatcher`, message utilities (`send`, `read`, `claim`, `acknowledge`, `consume`, `fail`, `recover`, `list`, `quarantine`). **No external runtime dependencies allowed.**
- **`@losoft/loom-runner`** — `AgentRunner` connects an agent's inbox to an LLM provider. `ProviderRegistry` + `resolveProvider()` handle model routing.
- **`@losoft/loom-supervisor`** — Spawns runners, detects crashes, restarts with exponential backoff. `Supervisor` writes its PID to `$LOOM_HOME/supervisor.pid`.
- **`@losoft/loom-cli`** — CLI entry point. Commands are currently stubs.

Each package builds to `dist/bun/` and `dist/node/` for dual-target support. `tools/build-publish-package.ts` handles the publish build (merges `package.json` + `package.pub.json`).

### Agent filesystem layout

```
$LOOM_HOME/agents/{name}/
  pid            # OS process ID
  status         # pending | running | idle | stopped | dead | error | restarting
  model          # model string (e.g. "ollama/llama3" or bare "llama3")
  started_at     # ISO 8601
  stopped_at     # ISO 8601
  inbox/         # pending .msg files
    .in-progress/  # claimed (being processed)
    .processed/    # successfully handled
    .failed/       # failed after retries (+ companion .error.json files)
    .unreadable/   # couldn't be parsed
  outbox/        # outgoing .msg files
  memory/        # persistent .json key-value state
  logs/          # daily NDJSON files: {date}.ndjson
  crashes/       # CrashRecord JSON files
```

### Message lifecycle

Messages are JSON files named `{timestamp_ms}-{id}.msg`. Three-phase lifecycle:
1. **Pending** — file sits in `inbox/`
2. **Claimed** — `claim()` atomically moves file to `inbox/.in-progress/`
3. **Done** — `acknowledge()` moves to `inbox/.processed/`; or `fail()` moves to `inbox/.failed/` with a companion `.error.json`

`recover(inboxDir, outboxDir)` handles crash recovery: re-queues in-progress messages unless the outbox already has a reply whose `origin` path's last segment matches the in-progress filename.

### `AgentRunner` message loop

Processes messages strictly FIFO, one at a time. Claims a message, calls the LLM via `resolveProvider()`, writes a reply to `outbox/` via `sendReply()` (builds `origin` path for pipeline tracing and crash recovery), then acknowledges.

### Model string format

`provider/modelname` or bare name (defaults to Ollama). Known prefixes: `ollama`, `anthropic`, `openai`, `openrouter`.

## Key conventions

### `home` parameter gotcha

`AgentProcess`, `ProcessTable`, and `InboxWatcher.forAgent()` take a `home` parameter that must be the **agents root** (`$LOOM_HOME/agents`), not `$LOOM_HOME` itself. `loomHome()` in `packages/runtime/src/env.ts` returns `$LOOM_HOME`.

### Zero-dependency rule

`@losoft/loom-runtime` must have no external runtime dependencies — only Bun built-ins and Node.js built-in modules. Any feature requiring an external package belongs in a separate `@losoft/loom-*` plugin package.

### TypeScript

Strict mode with `noUncheckedIndexedAccess` enabled — array and object index access returns `T | undefined`. Prefer explicit over clever.

Use `Bun.file(path).write(...)` for async file writes (not `fs.promises.writeFile`) in runtime code.

### JSDoc

Every module starts with:

```ts
/** @file One sentence describing this module. */
```

Every exported function, class, and interface gets a one-line JSDoc. Use `@param` / `@returns` only when types alone don't tell the full story. Inline interface field comments go above each field:

```ts
export interface CrashRecord {
  /** ISO 8601 timestamp of the crash. */
  ts: string;
}
```

### Tests

Tests live alongside source as `*.test.ts`. Use `bun:test` (`import { afterEach, beforeEach, expect, test } from "bun:test"`). Always verify filesystem state — check that files were written correctly, not just return values. Use `mkdtemp` in `beforeEach` and clean up in `afterEach`:

```ts
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "my-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
```

### Commits and PRs

Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `perf:`. PRs are squash-merged, so the PR title becomes the commit message.

### ADRs

Significant design decisions require an ADR. Draft in `docs/adrs/drafts/` (no number, status `Draft`). Once accepted, assign the next sequential number and move to `docs/adrs/ADR-{NNN}-{slug}.md`.
