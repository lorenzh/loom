# Contributing to loom

loom is an early-stage project. Contributions are welcome — but read this first.

## Philosophy

loom has a strong opinion: **agents are processes, state is files, everything is observable**. Before proposing a feature, ask: does this make the system simpler or more complex? Does it respect the Unix philosophy? If a feature requires a database, a cloud service, or a daemon that can't be understood by reading files — it probably doesn't belong in core.

## What we want

- Bug fixes
- Performance improvements to the core runtime
- New ADRs for design decisions not yet documented
- Documentation improvements
- Example `loom.yml` configurations for real use cases
- Plugins published as separate `@losoft/loom-*` packages

## What goes in core vs plugins

**Core** (`packages/runtime`, `packages/cli`):
- Process table
- Inbox watcher
- Supervisor
- CLI (`loom ps`, `loom spawn`, `loom send`, etc.)
- Message format
- `loom.yml` parsing

**Plugin** (separate packages):
- Model providers beyond Ollama/Anthropic
- Transport plugins (Telegram, Slack, webhooks)
- MCP server integrations
- Custom triggers

When in doubt: if it requires an external service or adds a new dependency to core, it's a plugin.

## Getting started

```sh
git clone https://github.com/lorenzh/loom
cd loom
bun install
bun run build
bun test
```

## Development workflow

We follow [GitHub Flow](https://docs.github.com/en/get-started/using-github/github-flow):

1. Create a branch: `git checkout -b feat/your-feature`
2. Make your changes, committing each logical change separately
3. Run tests: `bun test`
4. Run lint/format check: `bun run check`
5. Open a PR against `main`
6. Once merged, the branch is automatically deleted

## Commits

We use [Conventional Commits](https://www.conventionalcommits.org/) with [gitmoji](https://gitmoji.dev/):

```
✨ feat: add inbox watcher polling interval config
🐛 fix: supervisor restart backoff not resetting after stable run
📝 docs: add ADR-012 for message deduplication
♻️ refactor: extract frame parsing into separate module
🧪 test: add process-table register/deregister cases
```

Common prefixes: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`

## Pull requests

PRs are squash-merged into `main`, so the **PR title becomes the commit message**. Use the same gitmoji + Conventional Commits format for PR titles:

```
✨ feat: add inbox watcher polling interval config
🐛 fix: resolve biome lint errors
```

Use the PR body for details — keep the title short (under 70 characters).

## ADRs

Significant design decisions need an ADR in `docs/adrs/`. Use this template:

```md
# ADR-XXX: Title

**Status:** Draft | Accepted | Superseded
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

ADR numbers are sequential. Check existing ADRs before numbering yours.

## Code style

- TypeScript, strict mode
- Bun runtime — no Node-specific APIs unless there's no Bun equivalent
- No external runtime dependencies in `@losoft/loom-runtime` — it must run with zero installs beyond Bun
- Prefer explicit over clever
- Every public function needs a one-line JSDoc comment

## Tests

- Tests live alongside source in `*.test.ts` files
- Test the filesystem — loom's core promise is filesystem observability, so tests should verify files are written correctly, not just return values
- Use `tmp` directories in tests, clean up after

## Opening issues

Use the issue templates. For bugs, include:
- loom version (`loom --version`)
- OS and architecture
- Minimal reproduction steps
- Contents of relevant agent directories (redact secrets)

## License

By contributing you agree your code will be licensed under MIT.
