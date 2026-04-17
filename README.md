# loom

> An agent runtime built for transparency. All state lives in the filesystem. Everything is observable with standard Unix tools. Nothing is hidden.

![Status](https://img.shields.io/badge/status-early%20development-orange)
[![CI](https://github.com/lorenzh/loom/actions/workflows/ci.yml/badge.svg)](https://github.com/lorenzh/loom/actions/workflows/ci.yml)
![License](https://img.shields.io/github/license/lorenzh/loom)

---

## Why loom

Agent frameworks today are opaque. State is buried in memory, hidden behind abstractions, and impossible to inspect without framework-specific tooling. When an agent fails, you get a stack trace at best. You rarely get the full picture of what it was doing, what it knew, and where it went wrong.

They are also heavy. Hundreds of transitive dependencies ship with every install. Each one is an attack surface. For software that has access to your tools, your files, and your APIs, that is a problem.

loom takes a different approach: agents should be transparent, secure, and easy to understand. State is plain files on disk. You can inspect everything with `cat`, `tail`, `grep`, and `ls` — no special tooling, no dashboards, no SDKs. The dependency tree is kept as small as possible because every package you don't ship is a vulnerability you don't have.

Nothing fancy. Just processes and files.

---

## Core idea

Every agent has an identity, a status, an inbox, and an outbox — all stored as plain files. You can observe, debug, and understand the entire system with `cat`, `tail`, `grep`, and `ls`.

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

- **Linux** — x64, arm64
- **macOS** — x64, arm64
- **Windows** — via [WSL](https://learn.microsoft.com/en-us/windows/wsl/) (use the Linux binary inside WSL)

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

> **Local development:** use `bun run loom <command>` instead of `loom <command>` when running from the source repo. The `loom` binary is only available after installing the published npm package.

---

## CLI

### Agent commands

```sh
loom agent start <name> --model <model>            # start agent in foreground (stdin/stdout)
loom agent start <name> --model <model> --detach   # start agent in background (supervised)
loom agent ps                                      # list all agents and their status
loom agent stop <name>                             # stop a running agent
loom agent logs <name>                             # view agent logs
loom agent logs <name> --follow                    # stream logs in real time
loom agent logs <name> --lines 50                  # show last N log entries
loom send <name> <message>                         # send a message to an agent's inbox
loom send <name> --stdin                           # read message body from stdin
```

### Foreground mode (Unix filter)

Agents in foreground mode are Unix filters — stdin in, stdout out. This makes them composable with standard Unix tools:

```sh
# Interactive session
loom agent start my-agent --model ollama/qwen3:8b

# One-shot with piped input
echo "summarise this" | loom agent start summarizer --model ollama/qwen3:8b --stdin

# Chain models together
cat report.md | loom agent start summarizer --model ollama/qwen3:8b --stdin \
  | loom agent start prioritizer --model ollama/qwen3:32b --stdin --system "prioritize by urgency"
```

### System prompts

```sh
loom agent start my-agent --model ollama/qwen3:8b --system "You are a helpful assistant."
loom agent start my-agent --model ollama/qwen3:8b --system-file ./prompts/researcher.md
```

---

## Filesystem layout

loom stores all state under `$LOOM_HOME` (default: `~/.loom`):

```
~/.loom/
  agents/
    my-agent/
      status          # idle | running | stopped | dead
      pid             # current PID (if running)
      model           # model identifier
      inbox/          # incoming .msg files
        *.msg         # pending messages
        .in-progress/ # message being processed
        .processed/   # completed messages
        .failed/      # messages that errored
      outbox/         # outgoing .msg files
      logs/           # NDJSON log files (rotated daily)
      conversations/  # full conversation history
      memory/         # persistent memory files
      crashes/        # crash records
```

Every field is a plain file. Inspect anything with `cat`:

```sh
cat ~/.loom/agents/my-agent/status
ls ~/.loom/agents/my-agent/inbox/
tail -f ~/.loom/agents/my-agent/logs/$(date +%Y-%m-%d).ndjson
```

---

## Model providers

loom routes models by prefix:

| Prefix | Provider |
|--------|----------|
| `anthropic/` | Anthropic API |
| `openai/` | OpenAI API |
| `openrouter/` | OpenRouter |
| `ollama/` | Local Ollama instance |
| *(bare name)* | Ollama (default) |

Providers are auto-discovered from environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`). For Ollama, no key is needed.

---

## Architecture

The system has three main components:

**Runner** — one per agent. A self-sufficient OS process that polls its inbox, calls the LLM, writes responses to the outbox, and maintains its own state files. Runners work standalone without a supervisor.

**Supervisor** — a process manager. Spawns runners in background mode, detects crashes, and restarts with exponential backoff. If the supervisor dies, runners keep running — they lose restart protection but continue processing messages.

**Filesystem** — the source of truth. All state is plain files. The CLI writes to the filesystem; the supervisor reads it. A SIGHUP signal nudges the supervisor to re-scan immediately.

### Restart policy

Each agent has a restart policy: `always` (default), `on-failure`, or `never`. Exponential backoff with jitter prevents runaway restart loops:

```
delay = min(1s * 2^restartCount, 5m) + jitter(0..500ms)
```

After 10 failures within one hour, the agent is marked `dead` and the supervisor stops restarting it.

---

## Current status

loom is in active development. Here is what works today and what is still in progress:

| Feature | Status |
|---------|--------|
| `loom agent start` (foreground) | ✅ Working |
| `loom agent start --detach` (background) | ✅ Working |
| `loom agent ps` | ✅ Working |
| `loom agent stop` | ✅ Working |
| `loom agent logs` / `--follow` | ✅ Working |
| `loom send` | ✅ Working |
| Anthropic, OpenAI, OpenRouter, Ollama providers | ✅ Working |
| Conversation history | ✅ Working |
| Crash recovery (orphaned message restore) | ✅ Working |
| Supervisor PID management and signal handling | ✅ Working |
| Supervisor `scan()` — agent spawn and crash detection | 🚧 In progress (v0.2) |
| Message routing between agents | 🚧 In progress (v0.2) |
| `loom.yml` parser and weave configuration | 🚧 In progress (v0.2) |
| `loom up` / `loom down` | 🚧 In progress (v0.2) |
| Pipes and operator chains | 📋 Planned |

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
| [plugin-protocol](docs/adrs/drafts/plugin-protocol.md) | Plugin protocol — tools as executables |

---

## License

MIT
