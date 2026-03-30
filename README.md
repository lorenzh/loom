# loom

> Weave agents into systems. A local-first runtime where agents are processes, state is files, and everything is observable.

A local-first agent runtime. Agents are processes. All state lives in the filesystem. Nothing is hidden.

---

## The problem with agent frameworks

Most frameworks treat agents as function calls: input goes in, output comes out, nothing persists. They optimise for demos. When something goes wrong at 3am, there is no process table to inspect, no filesystem to read, no way to understand what happened.

loom does the opposite.

## Core idea

An agent is a long-running process. It has an identity, a working directory, an inbox, and an outbox. Agents communicate by writing files. The supervisor watches them and restarts on crash. You can observe everything with standard Unix tools.

```
$LOOM_HOME/
  agents/
    my-agent/
      pid          # current process id
      status       # running | idle | dead
      model        # model in use
      inbox/       # drop a .msg file here to send a message
      outbox/      # agent writes responses here
      memory/      # persistent key-value state
      logs/        # append-only structured log, one file per day
      crashes/     # crash records (if any)
  supervisor.pid   # supervisor process id
  pipes/           # active agent-to-agent wiring
```

---

## Platform support

loom relies on Unix process semantics (POSIX signals, pid-based supervision, file descriptor inheritance). It runs on:

- **Linux** — x64, arm64
- **macOS** — x64, arm64
- **Windows** — via [WSL](https://learn.microsoft.com/en-us/windows/wsl/) (use the Linux binary inside WSL)

Native Windows is not supported.

---

## Getting started

### Prerequisites

- [Bun](https://bun.sh) 1.3+
- [Ollama](https://ollama.com) running locally (or any OpenAI-compatible endpoint)

### Build from source

```sh
git clone https://github.com/lorenzh/loom
cd loom
bun install
bun run build
```

### Start a single agent

```sh
# Pull a model (if using Ollama)
ollama pull qwen2.5:3b

# Scaffold a starter loom.yml
loom init

# Edit loom.yml — set the model and system prompt:
# version: 1
# agents:
#   - name: my-agent
#     model: qwen2.5:3b
#     system: "You are a helpful assistant."

# Start the agent
loom spawn my-agent

# Send it a message
loom send my-agent "What is the capital of France?"

# Read the response
loom read my-agent
```

### Validate a config

```sh
# Check your loom.yml is valid before using it
loom validate

# Point at a specific file
loom validate --file ./config/agents.yml

# Machine-readable output
loom validate --json
```

---

## CLI

```sh
# Weave
loom up [--follow, -f]                            # start supervisor and all agents from loom.yml
loom down                                         # stop supervisor and all agents
loom ps                                           # list agents and their status

# Agents
loom spawn <name>                                 # start an agent from loom.yml
loom kill <name>                                  # kill an agent process
loom log <name> [--follow, -f]                    # stream agent logs

# Messaging
loom send <name> "<message>"                      # send a message to an agent's inbox
loom read <name>                                  # read latest outbox message(s)
loom inbox <name> [--follow, -f]                  # show pending inbox messages
loom outbox <name> [--follow, -f]                 # show outbox messages

# Config
loom validate [--file <path>]                     # validate loom.yml against schema and pipe rules
loom init                                         # scaffold a starter loom.yml
```

---

## Why filesystem

- Any language can read a file. No SDK required to observe an agent.
- `tail -f logs/my-agent` works. `ls inbox/` works. `cat status` works.
- State survives process crashes. Inbox messages are not lost.
- Works offline. No cloud dependency. No API key required to run.
- Composable with Unix tools: `watch`, `grep`, `jq`, `cron`.

---

## Pluggable models

loom routes models by prefix — Ollama (default), Anthropic, OpenAI, and OpenRouter are all supported. Any OpenAI-compatible endpoint also works:

```sh
# Local via Ollama (default — no prefix needed)
loom spawn my-agent --model qwen2.5:3b

# Explicit Ollama prefix
loom spawn my-agent --model ollama/qwen3.5:9b

# Anthropic (set ANTHROPIC_API_KEY)
ANTHROPIC_API_KEY=sk-ant-... \
loom spawn my-agent --model anthropic/claude-sonnet-4-6

# OpenAI (set OPENAI_API_KEY)
OPENAI_API_KEY=sk-... \
loom spawn my-agent --model openai/gpt-4o

# OpenRouter (set OPENROUTER_API_KEY)
OPENROUTER_API_KEY=sk-or-... \
loom spawn my-agent --model openrouter/anthropic/claude-3.5-sonnet
```

| Prefix | Provider | Env vars |
|--------|----------|----------|
| _(none)_ | Ollama | `OLLAMA_BASE_URL` (default: `http://localhost:11434/v1`) |
| `ollama/` | Ollama | `OLLAMA_BASE_URL` |
| `anthropic/` | Anthropic | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` |
| `openai/` | OpenAI | `OPENAI_API_KEY`, `OPENAI_BASE_URL` |
| `openrouter/` | OpenRouter | `OPENROUTER_API_KEY` |

See [`docs/adrs/ADR-007-model-routing.md`](docs/adrs/ADR-007-model-routing.md) for the full model routing spec.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  loom supervisor (single long-running process)      │
│                                                      │
│  ┌────────────┐   ┌────────────┐   ┌─────────────┐  │
│  │ inbox      │   │ agent A    │   │ pipe engine │  │
│  │ watcher    │──▶│ (spawned)  │──▶│ (outbox →   │  │
│  │ (polling)  │   │            │   │  inbox)     │  │
│  └────────────┘   └────────────┘   └─────────────┘  │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │ health monitor (heartbeat every 5s)            │  │
│  │  → detects dead agents                         │  │
│  │  → applies restart policy with backoff         │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
                        │
                        │ reads/writes
                        ▼
┌──────────────────────────────────────────────────────┐
│  $LOOM_HOME/agents/{name}/                          │
│    pid  status  inbox/  outbox/  memory/  logs/      │
└──────────────────────────────────────────────────────┘
                        │
                        │ any process can read/write
                        ▼
              standard Unix tools
              cat, tail, grep, jq, watch
```

Each agent is a spawned child process. The supervisor watches for crashes and
restarts with exponential backoff. If the supervisor dies, agents keep running —
they just won't be restarted until the supervisor comes back.

---

## Design decisions

Architecture decision records live in [`docs/adrs/`](docs/adrs/):

| ADR | Title |
|-----|-------|
| [ADR-001](docs/adrs/ADR-001-unix-process-model.md) | Unix process model for agents |
| [ADR-002](docs/adrs/ADR-002-filesystem-as-process-table.md) | Filesystem as process table |
| [ADR-003](docs/adrs/ADR-003-inbox-watcher-polling.md) | Inbox watcher via polling |
| [ADR-004](docs/adrs/ADR-004-supervisor-and-restart-policy.md) | Supervisor and restart policy |
| [ADR-005](docs/adrs/ADR-005-loom-yml-weave-config.md) | loom.yml weave config format |
| [ADR-006](docs/adrs/ADR-006-plugin-model.md) | Plugin and extension model |
| [ADR-007](docs/adrs/ADR-007-model-routing.md) | Model routing and provider abstraction |
| [ADR-008](docs/adrs/ADR-008-filesystem-state-store.md) | Filesystem as state store |
| [ADR-009](docs/adrs/ADR-009-plugin-protocol.md) | Plugin protocol — tools as executables |
| [ADR-010](docs/adrs/ADR-010-pipe-engine.md) | Pipe engine — outbox-to-inbox forwarding |

---

## License

MIT
