# Contributing to loom

loom is an early-stage project. Contributions are welcome — but read this first.

## Philosophy

loom has a strong opinion: **agents are processes, state is files, everything is observable**. Before proposing a feature, ask: does this make the system simpler or more complex? Does it respect the Unix philosophy? If a feature requires a database, a cloud service, or a daemon that can't be understood by reading files — it probably doesn't belong in core.

## Monorepo structure

```
packages/
  runtime/    → @losoft/loom-runtime     (zero-dependency core primitives)
  runner/     → @losoft/loom-runner      (LLM provider abstraction, depends on runtime)
  supervisor/ → @losoft/loom-supervisor  (process manager: spawns runners, handles restarts)
  cli/        → @losoft/loom-cli         (CLI entry point: loom run, loom up, loom ps, …)
tools/        → build and publish scripts
docs/adrs/          → accepted architecture decision records (numbered)
docs/adrs/drafts/   → draft ADR proposals (unnumbered)
.githooks/    → shared git hooks
```

Each package builds for both **Bun** (`dist/bun/`) and **Node.js** (`dist/node/`). The `package.pub.json` in each package defines the dual-target exports. The `tools/build-publish-package.ts` script handles the publish build — it merges `package.json` + `package.pub.json`, strips dev fields, and writes the final package to `dist/`.

## What we want

- Bug fixes
- Performance improvements to the core runtime
- New ADRs for design decisions not yet documented
- Documentation improvements
- Example `loom.yml` configurations for real use cases
- Plugins published as separate `@losoft/loom-*` packages

## What goes in core vs plugins

**Core — `@losoft/loom-runtime`** (`packages/runtime`):
- `AgentProcess` (filesystem-backed agent state)
- `ProcessTable`
- `InboxWatcher` (polling-based)
- Message utilities (`send`, `read`, `consume`, `list`, `quarantine`)
- `loom.yml` parsing
- **Zero external runtime dependencies** — must run with nothing beyond Bun installed

**Core — `@losoft/loom-runner`** (`packages/runner`):
- `AgentRunner` (connects inbox to LLM)
- `Provider` / `ProviderRegistry` interfaces
- `resolveProvider()` for model routing by prefix (`ollama/`, `anthropic/`, `openai/`, `openrouter/`)
- May depend on `@losoft/loom-runtime` (workspace dependency)

**Plugin** (separate `@losoft/loom-*` packages):
- Model providers beyond the built-in set
- Transport plugins (Telegram, Slack, webhooks)
- MCP server integrations
- Custom triggers

When in doubt: if it requires an external service or adds a new dependency to runtime, it's a plugin.

## Getting started

Since you don't have direct push access, you'll need to fork the repo first:

1. **Fork** — click "Fork" on [lorenzh/loom](https://github.com/lorenzh/loom) to create a copy under your own account
2. **Clone your fork** — `git clone https://github.com/YOUR_USERNAME/loom`
3. **Install and build:**

```sh
cd loom
bun install
bun run build
bun test
```

4. **Add the upstream remote** (so you can pull in future changes):

```sh
git remote add upstream https://github.com/lorenzh/loom
```

When you're ready to open a PR, push to your fork and open it against `lorenzh/loom:main`.

## Development workflow

We follow [GitHub Flow](https://docs.github.com/en/get-started/using-github/github-flow):

1. Create a branch: `git checkout -b feat/your-feature`
2. Make your changes, committing each logical change separately
3. Run tests: `bun test`
4. Run lint/format check: `bun run check`
5. Open a PR against `main`
6. Once merged, the branch is automatically deleted

### Pre-commit hook

A shared pre-commit hook at `.githooks/pre-commit` is automatically configured after `bun install` (via the `prepare` script). It runs:

1. `bun biome check --staged` — lint and format staged files
2. `bun run build` — build all packages
3. `bun test` — run all tests

If any step fails, the commit is rejected. This means commits may take a moment — that's expected.

### CI

PRs and pushes to `main` trigger three parallel CI jobs:

- **Lint & Format** — `bun run check`
- **Build** — `bun run build`
- **Test** — `bun test` (runs after build)

All three must pass before merging. PRs also receive automated code review.

## Commits

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add inbox watcher polling interval config
fix: supervisor restart backoff not resetting after stable run
docs: add ADR-012 for message deduplication
refactor: extract frame parsing into separate module
test: add process-table register/deregister cases
```

Common prefixes: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`

## Pull requests

PRs are squash-merged into `main`, so the **PR title becomes the commit message**. Use the same Conventional Commits format for PR titles:

```
feat: add inbox watcher polling interval config
fix: resolve biome lint errors
```

Use the PR body for details — keep the title short (under 70 characters).

A PR template is provided automatically. Before requesting review, ensure the checklist passes:

- [ ] `bun run check` passes
- [ ] `bun run build` passes
- [ ] `bun test` passes

## ADRs

Significant design decisions are tracked as architecture decision records (ADRs).

### Workflow

1. **Propose** — create a new file in `docs/adrs/drafts/` with a descriptive slug (no number). Set its status to `Draft`.
2. **Review** — the draft is discussed in a PR. Iterate until accepted.
3. **Accept** — once approved, the file is assigned the next sequential ADR number, renamed to `docs/adrs/ADR-{NNN}-{slug}.md`, and its status is set to `Accepted`.

### Template

```md
# Title

**Status:** Draft
**Date:** YYYY-MM-DD

## Context
Why does this decision need to be made?

## Decision
What did we decide?

## Consequences
What are the tradeoffs?

## Alternatives considered
What did we reject and why?
```

Accepted ADRs (ADR-001 through ADR-004) live in `docs/adrs/`. Draft proposals live in `docs/adrs/drafts/`.

## Code style

- TypeScript, strict mode (`noUncheckedIndexedAccess` is enabled — index access returns `T | undefined`)
- Bun runtime — no Node-specific APIs unless there's no Bun equivalent
- No external runtime dependencies in `@losoft/loom-runtime` — it must run with zero installs beyond Bun
- Prefer explicit over clever
### JSDoc

Every module starts with a header comment:

```ts
/**
 * @file One sentence describing what this module does.
 * @module @losoft/loom-runtime/module-name
 */
```

Every exported function, class, and interface gets a one-line JSDoc:

```ts
/** Write a crash record to the agent's crashes/ directory. */
export function writeCrashRecord(agentDir: string, record: CrashRecord): void { … }

/** Returns true when `obj` conforms to the {@link Message} shape. */
export function isMessage(obj: unknown): obj is Message { … }
```

Use `@param` / `@returns` only when the types alone don't tell the full story:

```ts
/**
 * Poll the inbox directory and emit a `message` event for each new file.
 * @param interval Polling interval in milliseconds (default: 500).
 */
```

Inline field comments on interfaces go above each field, not at end-of-line:

```ts
export interface CrashRecord {
  /** ISO 8601 timestamp of the crash. */
  ts: string;
  /** Process exit code, or null if killed by signal. */
  exitCode: number | null;
}
```

Don't add JSDoc to private helpers, internal-only types, or anything where the name and types are already self-explanatory.

### Formatting (Biome)

Biome enforces formatting — run `bun run fix` to auto-fix. Key settings:

- 2-space indentation, 100-char line width
- Double quotes, always semicolons, trailing commas
- Arrow function parentheses always required

See `biome.json` for the full config.

## Tests

- Tests live alongside source in `*.test.ts` files
- Test the filesystem — loom's core promise is filesystem observability, so tests should verify files are written correctly, not just return values
- Use `tmp` directories in tests, clean up after

Example test pattern:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "my-test-"));
  // set up directory structure as needed
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("writes expected file to disk", async () => {
  // call your function
  // assert on filesystem state, not just return values
});
```

Run tests:

```sh
bun test                       # all tests
bun test --filter <pattern>    # single test file matching pattern
```

## Opening issues

Use the issue templates (bug report or feature request). For bugs, include:
- Description and expected behavior
- Steps to reproduce
- loom version (`loom --version`)
- OS (Linux, macOS, or Windows)
- Relevant logs, agent directory contents, or screenshots (redact secrets)

## License

By contributing you agree your code will be licensed under MIT.
