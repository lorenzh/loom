# loom

> An agent runtime built for transparency. All state lives in the filesystem. Everything is observable with standard Unix tools. Nothing is hidden.

![Status](https://img.shields.io/badge/status-early%20development-orange)
[![CI](https://github.com/lorenzh/loom/actions/workflows/ci.yml/badge.svg)](https://github.com/lorenzh/loom/actions/workflows/ci.yml)
![License](https://img.shields.io/github/license/lorenzh/loom)

**Early development.** Most features described here are not yet implemented. Expect frequent breaking changes.

---

## Why loom

Agent frameworks today are opaque. State is buried in memory, hidden behind abstractions, and impossible to inspect without framework-specific tooling. When an agent fails, you get a stack trace at best. You rarely get the full picture of what it was doing, what it knew, and where it went wrong.

They are also heavy. Hundreds of transitive dependencies ship with every install. Each one is an attack surface. For software that has access to your tools, your files, and your APIs, that is a problem.

loom takes a different approach: agents should be transparent, secure, and easy to understand. State is plain files on disk. You can inspect everything with `cat`, `tail`, `grep`, and `ls` — no special tooling, no dashboards, no SDKs. The dependency tree is kept as small as possible because every package you don't ship is a vulnerability you don't have.

Nothing fancy. Just processes and files.

---

## Core idea

Every agent has an identity, a status, an inbox, and an outbox — all stored as plain files. Agents communicate by writing files. The supervisor watches them and restarts on crash. You can observe, debug, and understand the entire system with `cat`, `tail`, `grep`, and `ls`.

---

## Principles

- **Observable.** `tail -f logs/my-agent` works. `ls inbox/` works. `cat status` works. No proprietary dashboards required.
- **Minimal dependencies.** A small dependency tree means a small attack surface. Every package you don't ship is a vulnerability you don't have.
- **Language-agnostic.** The filesystem is the interface. Runners, plugins, and tools can be written in any language — Go, Python, Rust, shell scripts — they all just read and write files.
- **Crash-resilient.** State lives on disk, not in memory. Inbox messages are not lost when a process dies.
- **Composable.** Works with the Unix tools you already know: `watch`, `grep`, `jq`, `cron`. No SDK required.

---

## Platform support

loom relies on Unix process semantics (POSIX signals, PID-based supervision, file descriptor inheritance). It runs on:

- **Linux** -- x64, arm64
- **macOS** -- x64, arm64
- **Windows** -- via [WSL](https://learn.microsoft.com/en-us/windows/wsl/) (use the Linux binary inside WSL)

Native Windows is not supported.

---

## Getting started

### Prerequisites

- [Bun](https://bun.sh) 1.3+

### Build from source

```sh
git clone https://github.com/lorenzh/loom
cd loom
bun install
bun run build
```

---

## CLI

> **Local development:** use `bun run loom <command>` instead of `loom <command>` when running from the source repo. The `loom` binary is only available after installing the published npm package.

Agents are Unix filters in foreground mode — stdin in, stdout out:

```sh
# Foreground (interactive, stdin/stdout/stderr)
loom agent start my-agent --model qwen3.5:9b

# Background (supervised, restarts on crash)
loom agent start my-agent --model qwen3.5:9b --detach

# Multi-agent weave from loom.yml
loom up
```

Compose agents with standard Unix pipes:

```sh
# Chain models together
echo "extract action items" | loom agent start my-agent --model qwen3:8b --stdin

cat report.md | loom agent start summarizer --model qwen3:8b --stdin \
  | loom agent start prioritizer --model qwen3:32b --stdin --system "prioritize by urgency"
```

Supporting commands:

```sh
loom agent ps                    # list agents and their status
loom agent stop <name>           # stop a specific agent
loom agent logs <name>           # view agent logs
loom agent send <name> <msg>     # send a message to an agent's inbox
loom down                        # stop all agents started by loom up
```

| Mode | Supervisor | Restart on crash | Routing | I/O |
|------|-----------|-----------------|---------|-----|
| `loom agent start` (foreground) | No | No | No | stdin/stdout/stderr |
| `loom agent start --detach` | Yes | Yes | Yes | Filesystem only |
| `loom up` | Yes | Yes | Yes | Filesystem only |

---

## Why filesystem

- Any language can read a file. No SDK required to observe an agent.
- `tail -f logs/my-agent` works. `ls inbox/` works. `cat status` works.
- State survives process crashes. Inbox messages are not lost.
- Works offline. No cloud dependency. No API key required to run locally.
- Composable with Unix tools: `watch`, `grep`, `jq`, `cron`.

---

## Architecture

The system has three main components:

**Runner** — one per agent. A self-sufficient OS process that polls its inbox, calls the LLM, executes tools, writes responses to the outbox, and maintains its own state files. Runners work standalone without a supervisor.

**Pipes** — named, reusable message processors. Each pipe is an array of operators — shell commands (`operator: command`) for stateless work (filter, transform, split) and built-in operators for stateful work (window, dedupe, throttle, accumulate). Pipes have the same filesystem layout as agents (inbox, outbox, steps, state). Every operator step writes its output as a `.msg` file to `steps/N/`, making the entire chain observable.

**Supervisor** — a process manager and message router. Spawns runners and pipes, detects crashes, restarts with exponential backoff. Routes messages between agents and pipes by watching outbox directories and copying `.msg` files to inbox directories per a routes table. If the supervisor dies, runners and pipes keep running — they just lose restart protection and routing.

**Filesystem** — the source of truth. All state is plain files. The CLI writes to the filesystem; the supervisor reads it. A SIGHUP signal nudges the supervisor to re-scan immediately.

Messages flow **agent → (optional pipe) → agent**. Agents declare their inputs with `from`:

```yaml
agents:
  - name: writer
    from:
      - agent: researcher
        pipe: finding-filter
      - agent: editor
```

```
agent outbox ──→ [supervisor routes] ──→ pipe inbox ──→ pipe outbox ──→ agent inbox
                       │                                                    ▲
                       └──────────── direct (no pipe) ──────────────────────┘
```

---

### Restart policy

Each agent has a restart policy: `always` (default), `on-failure`, or `never`. Exponential backoff with jitter prevents runaway restart loops:

```
delay = min(1s * 2^restartCount, 5m) + jitter(0..500ms)
```

After 10 failures within one hour, the agent is marked `dead` and the supervisor stops restarting it.

---

## Design decisions

Architecture decision records live in [`docs/adrs/`](docs/adrs/).

### Accepted

| ADR | Title |
|-----|-------|
| [ADR-001](docs/adrs/ADR-001-unix-process-model.md) | Unix process model for agents |
| [ADR-002](docs/adrs/ADR-002-filesystem-as-process-table.md) | Filesystem as process table |
| [ADR-003](docs/adrs/ADR-003-inbox-watcher-polling.md) | Inbox watcher via polling |
| [ADR-004](docs/adrs/ADR-004-supervisor-and-restart-policy.md) | Supervisor and restart policy |
| [ADR-005](docs/adrs/ADR-005-runner-architecture.md) | Runner architecture |
| [ADR-006](docs/adrs/ADR-006-cli-and-lifecycle.md) | CLI and agent lifecycle |
| [ADR-007](docs/adrs/ADR-007-garbage-collection.md) | Garbage collection and archival |
| [ADR-008](docs/adrs/ADR-008-ollama-model-availability.md) | Ollama model availability |
| [ADR-009](docs/adrs/ADR-009-message-origin-tracking.md) | Message origin tracking |
| [ADR-010](docs/adrs/ADR-010-pipe-runner.md) | Pipe runner — named reusable message processors |
| [ADR-011](docs/adrs/ADR-011-loom-yml-weave-config.md) | loom.yml — declarative weave configuration |
| [ADR-012](docs/adrs/ADR-012-filesystem-state-store.md) | Filesystem as state store |
| [ADR-013](docs/adrs/ADR-013-model-routing.md) | Model routing and provider abstraction |

### Drafts

| Proposal | Title |
|----------|-------|
| [plugin-model](docs/adrs/drafts/plugin-model.md) | Plugin and extension model |
| [plugin-protocol](docs/adrs/drafts/plugin-protocol.md) | Plugin protocol -- tools as executables |

---

## License

MIT
