# loom

> A local-first agent runtime where agents are Unix processes, all state lives in the filesystem, and everything is observable with standard Unix tools.

---

## The problem with agent frameworks

Most frameworks treat agents as function calls: input goes in, output comes out, nothing persists. They optimise for demos. When something goes wrong at 3am, there is no process table to inspect, no filesystem to read, no way to understand what happened.

loom does the opposite.

## Core idea

An agent is a Unix process. It has an identity, a status, an inbox, and an outbox. Agents communicate by writing files. The supervisor watches them and restarts on crash. You can observe everything with `cat`, `tail`, `grep`, and `ls`.

```
$LOOM_HOME/agents/{name}/
  pid            # OS process ID of the running runner
  status         # running | idle | stopped | pending | dead | error | restarting
  model          # model identifier in use
  started_at     # ISO 8601 timestamp
  stopped_at     # ISO 8601 timestamp (empty if still running)
  inbox/         # incoming messages as .msg files
    .in-progress/  # messages currently being processed (claimed)
    .processed/    # successfully processed messages
    .failed/       # messages that failed after all retries
    .unreadable/   # messages that could not be parsed
  outbox/        # outgoing messages as .msg files
  memory/        # persistent key-value state as .json files
  logs/          # append-only NDJSON log files, one per day
  crashes/       # crash records (if any)
$LOOM_HOME/supervisor.pid   # supervisor process ID
```

Messages are JSON files named `{timestamp_ms}-{id}.msg`. The timestamp prefix gives human-readable ordering in directory listings.

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

Two primary commands cover the full lifecycle:

```sh
# Single agent -- foreground (interactive, streams to terminal)
loom run --name my-agent --model qwen3.5:9b

# Single agent -- background (supervised, restarts on crash)
loom run --name my-agent --model qwen3.5:9b --detach

# Multi-agent weave from loom.yml
loom up
```

Supporting commands:

```sh
loom ps                    # list agents and their status
loom stop <name>           # stop a specific agent
loom logs <name>           # view agent logs
loom send <name> <msg>     # send a message to an agent's inbox
loom down                  # stop all agents started by loom up
```

| Mode | Supervisor | Restart on crash | Pipe engine |
|------|-----------|-----------------|-------------|
| `loom run` (foreground) | No | No | No |
| `loom run --detach` | Yes | Yes | Yes |
| `loom up` | Yes | Yes | Yes |

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

**Runner** -- one per agent. A self-sufficient OS process that polls its inbox, calls the LLM, executes tools, writes responses to the outbox, and maintains its own state files. Runners work standalone without a supervisor.

**Supervisor** -- a process manager. Spawns runners, detects crashes via child process exit events, restarts with exponential backoff, and runs the pipe engine for inter-agent communication. If the supervisor dies, runners keep running -- they just lose restart protection.

**Filesystem** -- the source of truth. All state is plain files. The CLI writes to the filesystem; the supervisor reads it. A SIGHUP signal nudges the supervisor to re-scan immediately.

```
Runner (one per agent)              Supervisor (process manager)
  ├── polls inbox/ (200ms)            ├── spawns runners
  ├── claims message → .in-progress/  ├── detects crashes (child exit)
  ├── calls LLM via provider          ├── restarts with backoff
  ├── writes response to outbox/      ├── runs pipe engine
  ├── acknowledges → .processed/      └── writes crash records
  └── updates status (running/idle)
```

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

### Drafts

| Proposal | Title |
|----------|-------|
| [loom-yml-weave-config](docs/adrs/drafts/loom-yml-weave-config.md) | loom.yml weave config format |
| [plugin-model](docs/adrs/drafts/plugin-model.md) | Plugin and extension model |
| [model-routing](docs/adrs/drafts/model-routing.md) | Model routing and provider abstraction |
| [filesystem-state-store](docs/adrs/drafts/filesystem-state-store.md) | Filesystem as state store |
| [plugin-protocol](docs/adrs/drafts/plugin-protocol.md) | Plugin protocol -- tools as executables |
| [pipe-engine](docs/adrs/drafts/pipe-engine.md) | Pipe engine -- outbox-to-inbox forwarding |

---

## License

MIT
