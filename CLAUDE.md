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
```

Default to using Bun instead of Node.js for all commands.

## Monorepo structure

- **`packages/runtime`** (`@losoft/loom-runtime`) — Zero-dependency core primitives: `AgentProcess` (filesystem-backed agent state), `ProcessTable`, `InboxWatcher` (polling-based), `InboxRouter`, and message utilities (`send`, `read`, `consume`, `list`, `quarantine`). No external runtime dependencies allowed.
- **`packages/runner`** (`@losoft/loom-runner`) — Connects an agent's inbox to an LLM via the provider abstraction. Depends on `@losoft/loom-runtime`. Contains `AgentRunner` and the `Provider`/`ProviderRegistry` interfaces with `resolveProvider()` for model routing by prefix (ollama, anthropic, openai, openrouter).
- **`tools/`** — Build scripts (e.g. `build-publish-package.ts`).

Each package builds for both Bun and Node.js targets (`dist/bun/` and `dist/node/`).

## Key architecture concepts

- **Agents are processes** — each agent has a directory under `$LOOM_HOME/agents/{name}/` with plain-text files for `pid`, `status`, `model`, and subdirectories for `inbox/`, `outbox/`, `memory/`, `logs/`, `crashes/`.
- **Messages are files** — `.msg` JSON files named `{timestamp}-{id}.msg`. Consumed messages move to `.processed/`; unreadable ones go to `.unreadable/`.
- **Model routing** — model strings use prefix-based routing: no prefix = Ollama (default), `ollama/`, `anthropic/`, `openai/`, `openrouter/`. See `resolveProvider()` in `packages/runner/src/provider.ts`.
- **ADRs** — Architecture decision records live in `docs/adrs/`. New design decisions require an ADR.

## Code conventions

- TypeScript strict mode. Biome for linting/formatting (spaces, double quotes, semicolons, trailing commas).
- Tests live alongside source as `*.test.ts` files. Tests should verify filesystem state, not just return values.
- Commits use Conventional Commits with gitmoji (e.g. `✨ feat:`, `🐛 fix:`, `📝 docs:`, `♻️ refactor:`, `🧪 test:`).
- Every public function needs a one-line JSDoc comment.
- Core vs plugin boundary: if it requires an external service or adds a dependency to core, it's a plugin (separate `@losoft/loom-*` package).
