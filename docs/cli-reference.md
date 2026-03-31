# loom CLI Reference

## Commands

### `loom run`

Start a single agent.

```sh
loom run --name <name> --model <model> [options]
```

| Flag | Description | Default |
|---|---|---|
| `--name` | Agent name (must match `[a-z][a-z0-9-]*`) | required |
| `--model` | Model string (see [Model routing](#model-routing)) | required |
| `--system` | System prompt (inline string) | none |
| `--system-file` | System prompt from file | none |
| `--prompt` | Send an initial message to the agent's inbox | none |
| `--tools` | Comma-separated list of tools to enable | all global tools |
| `--detach`, `-d` | Run in background under supervisor | `false` |
| `--restart` | Restart policy: `always`, `on-failure`, `never` | `always` |
| `--env` | Environment variable (`KEY=VALUE`), repeatable | none |

**Foreground (default):** Streams agent output to the terminal. Ctrl+C stops
the agent. No supervisor, no restart on crash.

```sh
# Interactive
loom run --name researcher --model qwen3.5:9b

# With initial message
loom run --name researcher --model qwen3.5:9b --prompt "Research Unix history"

# Pipe input as first message
echo "summarize this" | loom run --name researcher --model qwen3.5:9b
```

**Detached (`--detach`):** Runs under the supervisor with crash recovery.
Starts the supervisor on-demand if not already running.

```sh
loom run --name researcher --model qwen3.5:9b --detach
```

---

### `loom up`

Start a weave of agents from `loom.yml`.

```sh
loom up [options]
```

| Flag | Description | Default |
|---|---|---|
| `--config`, `-c` | Path to config file | `./loom.yml` |
| `--detach`, `-d` | Run in background | `false` |

Starts the supervisor, spawns a runner for each agent defined in `loom.yml`,
and wires the pipe engine for inter-agent communication.

`loom up` is idempotent:
- Agents already running with the same config are left untouched
- Agents with changed config are restarted
- Agents removed from `loom.yml` are stopped
- New agents are started

```sh
loom up                     # reads ./loom.yml, foreground
loom up -d                  # detached
loom up --config prod.yml   # explicit config file
```

---

### `loom down`

Stop all agents started by `loom up` and the supervisor.

```sh
loom down
```

Agent state directories are preserved — inbox messages, memory, and logs
remain on disk.

---

### `loom ps`

List agents and their status.

```sh
loom ps [options]
```

| Flag | Description | Default |
|---|---|---|
| `--all`, `-a` | Include stopped agents | `false` |

Reads `$LOOM_HOME/agents/*/status` directly. Works even if no supervisor
or agent is running.

```
NAME            STATUS      MODEL           RESTARTS  UPTIME
researcher      running     qwen3.5:9b      0         5m
writer          idle        qwen3.5:9b      0         5m
news-monitor    dead        qwen2.5:3b      11        —
```

---

### `loom stop`

Stop a running agent.

```sh
loom stop <name>
```

Writes `status: stopped` and sends `SIGTERM` to the runner process. The
supervisor will not restart agents with `stopped` status.

---

### `loom send`

Send a message to an agent's inbox.

```sh
loom send <name> <message>
loom send <name> --stdin       # read message body from stdin
loom send <name> --file <path> # read message body from file
```

Creates a `.msg` file in `$LOOM_HOME/agents/<name>/inbox/` using the
standard message format (ADR-002).

---

### `loom logs`

View agent logs.

```sh
loom logs <name> [options]
```

| Flag | Description | Default |
|---|---|---|
| `--follow`, `-f` | Stream new log entries (like `tail -f`) | `false` |
| `--lines`, `-n` | Number of lines to show | `50` |

Reads from `$LOOM_HOME/agents/<name>/logs/*.ndjson`.

---

## Model routing

Models use prefix-based routing. No prefix defaults to Ollama.

| Prefix | Provider | Example |
|---|---|---|
| _(none)_ | Ollama (local) | `qwen3.5:9b` |
| `ollama/` | Ollama (explicit) | `ollama/qwen3.5:9b` |
| `anthropic/` | Anthropic | `anthropic/claude-sonnet-4-6` |
| `openai/` | OpenAI | `openai/gpt-4o` |
| `openrouter/` | OpenRouter | `openrouter/qwen/qwen-2.5-72b-instruct` |

### Environment variables

| Provider | Variables |
|---|---|
| Ollama | `OLLAMA_BASE_URL` (default: `http://localhost:11434`) |
| Anthropic | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` |
| OpenAI | `OPENAI_API_KEY`, `OPENAI_BASE_URL` |
| OpenRouter | `OPENROUTER_API_KEY` |

---

## Agent status values

| Status | Meaning | Set by |
|---|---|---|
| `pending` | Agent dir created, waiting for supervisor to spawn | CLI |
| `running` | Runner is actively processing | Runner |
| `idle` | Runner is waiting for inbox messages | Runner |
| `stopped` | Explicitly stopped by operator | CLI |
| `restarting` | Supervisor is restarting after crash | Supervisor |
| `dead` | Hit max restarts, gave up | Supervisor |
| `error` | Runner encountered a fatal error | Runner |

---

## Directory layout

All agent state lives under `$LOOM_HOME` (default: `~/.loom`).

```
$LOOM_HOME/
├── supervisor.pid
├── pipes/                           # pipe tracking logs
│   └── {from}-{to}.jsonl
└── agents/
    └── {name}/
        ├── pid                      # OS process ID
        ├── status                   # current status (plain text)
        ├── model                    # model string (plain text)
        ├── started_at               # ISO 8601 timestamp
        ├── stopped_at               # ISO 8601 timestamp
        ├── inbox/                   # incoming .msg files
        │   ├── .in-progress/        # messages being processed
        │   ├── .processed/          # successfully processed
        │   ├── .failed/             # failed after retries
        │   └── .unreadable/         # could not be parsed
        ├── outbox/                  # response .msg files
        ├── memory/                  # persistent memory files
        ├── logs/                    # NDJSON log files (one per day)
        ├── crashes/                 # crash records (JSON)
        └── conversations/           # conversation history (NDJSON)
```

---

## Message format

Messages are JSON files with `.msg` extension, named `{timestamp_ms}-{ulid}.msg`.

```json
{
  "v": 1,
  "id": "a3f9c1d2e5b8...",
  "from": "cli",
  "ts": "2026-03-25T00:00:00.000Z",
  "body": "hello world",
  "metadata": {}
}
```

Outbox messages include `in_reply_to` referencing the inbox filename that
triggered the response.

---

## See also

- [ADR-001: Unix process model](adrs/ADR-001-unix-process-model.md)
- [ADR-002: Filesystem as process table](adrs/ADR-002-filesystem-as-process-table.md)
- [ADR-005: Runner architecture](adrs/ADR-005-runner-architecture.md)
- [ADR-006: CLI and lifecycle](adrs/ADR-006-cli-and-lifecycle.md)
