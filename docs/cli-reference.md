# loom CLI Reference

## Agent commands

### `loom agent start`

Start a single agent.

```sh
loom agent start <name> --model <model> [options]
```

| Flag | Description | Default |
|---|---|---|
| `--model` | Model string (see [Model routing](#model-routing)) | required |
| `--system` | System prompt (inline string) | none |
| `--system-file` | System prompt from file | none |
| `--stdin` | Read message body from stdin | `false` |
| `--prompt` | Send an initial message to the agent's inbox | none |
| `--tools` | Comma-separated list of tools to enable | all global tools |
| `--detach`, `-d` | Run in background under supervisor | `false` |
| `--restart` | Restart policy: `always`, `on-failure`, `never` | `always` |
| `--env` | Environment variable (`KEY=VALUE`), repeatable | none |

#### Foreground mode (default)

In foreground mode the agent operates as a **Unix filter**: it reads from
stdin, wraps the input as a message, sends it through the LLM, and writes
the response to stdout. Logs and errors go to stderr. This makes agents
composable with standard Unix tools.

```sh
# Interactive — type a prompt, get a response
loom agent start my-agent --model qwen3.5:9b

# Pipe a prompt through a model
echo "extract action items" | loom agent start my-agent --model qwen3:8b --stdin

# Chain models together
cat report.md | loom agent start summarizer --model qwen3:8b --stdin \
  | loom agent start prioritizer --model qwen3:32b --stdin --system "prioritize by urgency"

# Filter output with standard tools
loom agent start extractor --model qwen3:8b --stdin < prompt.txt | grep "TODO" | tee results.txt

# With an initial prompt (no stdin needed)
loom agent start my-agent --model qwen3.5:9b --prompt "Research Unix history"
```

No supervisor, no restart on crash, no message routing. The agent process
runs in the current shell and exits when done.

#### Detached mode (`--detach`)

Runs under the supervisor with crash recovery. Starts the supervisor
on-demand if not already running.

```sh
loom agent start researcher --model qwen3.5:9b --detach
```

---

### `loom agent ps`

List agents and their status.

```sh
loom agent ps [options]
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

### `loom agent stop`

Stop a running agent.

```sh
loom agent stop <name>
```

Writes `status: stopped` and sends `SIGTERM` to the runner process. The
supervisor will not restart agents with `stopped` status.

---

### `loom agent send`

Send a message to an agent's inbox.

```sh
loom agent send <name> <message>
loom agent send <name> --stdin        # read message body from stdin
loom agent send <name> --file <path>  # read message body from file
```

Creates a `.msg` file in `$LOOM_HOME/agents/<name>/inbox/` using the
standard message format (ADR-002).

In foreground mode, `loom agent start --stdin` is equivalent to wrapping
the stdin content in a message and processing it — same as `agent send`
followed by reading the response.

---

### `loom agent logs`

View agent logs.

```sh
loom agent logs <name> [options]
```

| Flag | Description | Default |
|---|---|---|
| `--follow`, `-f` | Stream new log entries (like `tail -f`) | `false` |
| `--lines`, `-n` | Number of lines to show | `50` |

Reads from `$LOOM_HOME/agents/<name>/logs/*.ndjson`.

---

## Weave commands

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
and wires message routing for inter-agent communication.

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

Stop all agents and pipes started by `loom up` and the supervisor.

```sh
loom down
```

State directories are preserved — inbox messages, memory, and logs
remain on disk.

---

## Pipe and route commands

### `loom pipe create`

Create a named pipe at runtime (not persisted to `loom.yml`).

```sh
loom pipe create <name> --filter '<expr>'
```

---

### `loom route` / `loom unroute`

Wire or disconnect message routes.

```sh
loom route <source> --to <dest>                     # direct route
loom route <source> --pipe <name> --to <dest>       # route through a pipe
loom unroute <source> --to <dest>                   # disconnect
```

Both `loom route` and `loom up` validate for circular routes before
writing to `routes.json`. If a cycle would be created, the command fails.

---

### `loom pipes`

List pipe definitions and instances.

```sh
loom pipes
```

```
NAME              OPERATORS                      STATUS
finding-filter    filter → dedupe → window → …   active
urgency-gate      filter → throttle              active
```

---

### `loom routes`

List active routes with forwarding stats.

```sh
loom routes
```

```
SOURCE              PIPE              DEST              FORWARDED   LAST
researcher          finding-filter    writer            142         5s ago
researcher          —                 editor            89          1m ago
```

---

## Foreground vs detached

| Mode | Supervisor? | Restart on crash? | Message routing? | I/O |
|---|---|---|---|---|
| `loom agent start` (foreground) | No | No | No | stdin/stdout/stderr |
| `loom agent start --detach` | Yes | Yes | Yes | Filesystem only |
| `loom up` | Yes | Yes | Yes | Filesystem only |

Foreground mode is for development, scripting, and Unix pipe composition.
Detached mode and `loom up` are for persistent multi-agent weaves.

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
├── routes.json                      # supervisor routing table
├── agents/
│   └── {name}/
│       ├── pid                      # OS process ID
│       ├── status                   # current status (plain text)
│       ├── model                    # model string (plain text)
│       ├── started_at               # ISO 8601 timestamp
│       ├── stopped_at               # ISO 8601 timestamp
│       ├── inbox/                   # incoming .msg files
│       │   ├── .in-progress/        # messages being processed
│       │   ├── .processed/          # successfully processed
│       │   ├── .failed/             # failed after retries
│       │   └── .unreadable/         # could not be parsed
│       ├── outbox/                  # response .msg files
│       ├── memory/                  # persistent memory files
│       ├── logs/                    # NDJSON log files (one per day)
│       ├── crashes/                 # crash records (JSON)
│       └── conversations/           # conversation history (NDJSON)
├── pipes/
│   ├── {name}/                      # pipe definition (template)
│   │   └── config.json
│   └── {name}~{source}→{dest}/     # pipe instance (one per connection)
│       ├── pid
│       ├── status
│       ├── inbox/
│       ├── outbox/
│       ├── logs/
│       ├── crashes/
│       ├── steps/                   # intermediate .msg files per operator step
│       │   ├── 0/
│       │   ├── 1/
│       │   └── N/
│       └── state/                   # stateful operator internal state
```

---

## Message format

Messages are JSON files with `.msg` extension, named `{timestamp_ms}-{id}.msg`.

```json
{
  "v": 1,
  "id": "a3f9c1d2e5b87041",
  "from": "cli",
  "ts": 1742860000000,
  "body": "hello world",
  "origin": "1742859000000-parent.msg",
  "error": false
}
```

- `origin` — slash-delimited path of message filenames tracing a pipeline run
  (see ADR-009). Optional; omitted for trigger messages.
- `error` — `true` when this message signals a processing failure. Optional.

---

## See also

- [ADR-001: Unix process model](adrs/ADR-001-unix-process-model.md)
- [ADR-002: Filesystem as process table](adrs/ADR-002-filesystem-as-process-table.md)
- [ADR-005: Runner architecture](adrs/ADR-005-runner-architecture.md)
- [ADR-006: CLI and lifecycle](adrs/ADR-006-cli-and-lifecycle.md)
- [ADR-009: Message origin tracking](adrs/ADR-009-message-origin-tracking.md)
- [ADR-010: Pipe runner](adrs/ADR-010-pipe-runner.md)
- [ADR-011: loom.yml weave config](adrs/ADR-011-loom-yml-weave-config.md)
- [ADR-013: Model routing](adrs/ADR-013-model-routing.md)
